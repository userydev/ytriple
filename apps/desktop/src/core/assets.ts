import { createHash, randomUUID } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { Store } from "./store";
import type {
  Asset,
  ArtifactVersion,
  Draft,
  Material,
  Project,
  Reference,
  Work,
} from "./types";
import { LocalDirectories, isWithin } from "./local-directories";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const limit = 1_000_000;
const originSchema = z
  .object({
    materialId: z.string().max(300),
    version: z.number().int().positive(),
    coverage: z.string().max(100),
    url: z.string().max(4000).optional(),
    workTitle: z.string().max(500).optional(),
    projectName: z.string().max(500).optional(),
    versionId: z.string().max(300).optional(),
    selected: z.boolean(),
  })
  .strict();
const headerSchema = z
  .object({
    format: z.literal("ytriple.asset"),
    schema: z.literal(1),
    label: z.string().min(1).max(500),
    createdAt: z.string().datetime(),
    origin: originSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const marker = "<!-- ytriple-asset-v1 ";
export type AssetFileStatus = {
  path: string;
  state: "unchanged" | "changed" | "missing" | "unavailable";
  checkedAt: string;
};
export class Assets {
  constructor(readonly store: Store) {}
  save(reference: Reference, label: string): Asset {
    const material = this.store.material(reference);
    if (material.readError) throw Error("材料尚未读取，不能加入资产");
    if (
      reference.excerpt !== undefined &&
      (!reference.excerpt.trim() || !material.body.includes(reference.excerpt))
    )
      throw Error("选段不属于这个材料版本");
    if (!label.trim() || label.length > 500)
      throw Error("请为资产填写有效名称");
    const previous = this.store
      .all<Asset>("asset")
      .find(
        (a) =>
          a.reference.materialId === reference.materialId &&
          a.reference.version === reference.version &&
          a.reference.excerpt === reference.excerpt,
      );
    if (previous) return previous;
    const id = randomUUID();
    return this.store.put("asset", id, {
      id,
      label: label.trim(),
      reference,
      createdAt: new Date().toISOString(),
    });
  }
  origin(asset: Asset) {
    if (asset.importedOrigin) return asset.importedOrigin;
    const material = this.store.material(asset.reference);
    const version = this.store
      .all<ArtifactVersion>("version")
      .find(
        (v) => v.artifactId === material.id && v.number === material.version,
      );
    const work = version ? this.store.get<Work>("work", version.workId) : null;
    const project = work?.projectId
      ? this.store.get<Project>("project", work.projectId)
      : null;
    return {
      materialId: material.id,
      version: material.version,
      coverage: material.coverage,
      ...(material.url ? { url: material.url } : {}),
      ...(work ? { workTitle: work.title } : {}),
      ...(project ? { projectName: project.name } : {}),
      ...(version ? { versionId: version.id } : {}),
      selected: asset.reference.excerpt !== undefined,
    };
  }
  serialize(assetId: string) {
    const asset = this.store.require<Asset>("asset", assetId),
      material = this.store.material(asset.reference);
    if (material.readError) throw Error("材料尚未读取");
    const body = asset.reference.excerpt ?? material.body;
    if (asset.reference.excerpt !== undefined && !material.body.includes(body))
      throw Error("资产选段与保存版本不一致");
    const header = headerSchema.parse({
      format: "ytriple.asset",
      schema: 1,
      label: asset.label,
      createdAt: asset.createdAt,
      origin: this.origin(asset),
      sha256: hash(body),
    });
    // Metadata is encoded so arbitrary titles cannot end the Markdown comment.
    const text =
      marker +
      Buffer.from(JSON.stringify(header)).toString("base64") +
      " -->\n\n" +
      body;
    if (Buffer.byteLength(text) > limit)
      throw Error("资产超过 1 MB，暂不支持保存为便携文件");
    return text;
  }
  async exportFile(assetId: string, path: string) {
    const directories = new LocalDirectories(this.store),
      parent = await directories.validatedDirectory("ai", dirname(path));
    const root = directories.roots().aiPath!;
    if (
      isWithin(join(root, "system"), parent) ||
      isWithin(join(root, "cache"), parent)
    )
      throw Error("请选择 AI 的知识或资源目录，不能写入规则或缓存目录");
    if (!basename(path).toLowerCase().endsWith(".md"))
      throw Error("资产文件需要使用 .md 扩展名");
    const target = join(parent, basename(path)),
      text = this.serialize(assetId);
    // Exclusive creation also rejects an existing symlink; never overwrite user files.
    const file = await open(target, "wx", 0o600).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST")
          throw Error("文件已存在，请换一个名称；已有文件保持不变");
        throw error;
      },
    );
    try {
      await file.writeFile(text, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    const asset = this.store.require<Asset>("asset", assetId);
    const exported = {
      path: target,
      sha256: hash(text),
      savedAt: new Date().toISOString(),
    };
    return this.store.put("asset", assetId, {
      ...asset,
      files: [...(asset.files ?? []), exported],
    });
  }
  async inspectFiles(assetId: string): Promise<AssetFileStatus[]> {
    const asset = this.store.require<Asset>("asset", assetId),
      dirs = new LocalDirectories(this.store);
    return Promise.all(
      (asset.files ?? []).map(async (file) => {
        let state: AssetFileStatus["state"];
        try {
          const path = await dirs.validatedPath("ai", file.path);
          const info = await stat(path);
          state =
            !info.isFile() || info.size > limit
              ? "changed"
              : hash(await readFile(path, "utf8")) === file.sha256
                ? "unchanged"
                : "changed";
        } catch (error) {
          state =
            (error as NodeJS.ErrnoException).code === "ENOENT"
              ? "missing"
              : "unavailable";
        }
        return { path: file.path, state, checkedAt: new Date().toISOString() };
      }),
    );
  }
  restore(text: string): Asset {
    if (Buffer.byteLength(text) > limit) throw Error("资产文件超过 1 MB");
    if (!text.startsWith(marker))
      throw Error("这不是 ytriple 保存的资产文件；普通材料请通过对话附件添加");
    const end = text.indexOf(" -->\n\n", marker.length);
    if (end < 0 || end > 40000) throw Error("资产来源信息无效");
    let header: z.infer<typeof headerSchema>;
    try {
      header = headerSchema.parse(
        JSON.parse(
          Buffer.from(text.slice(marker.length, end), "base64").toString(
            "utf8",
          ),
        ),
      );
    } catch {
      throw Error("资产来源信息无效");
    }
    const body = text.slice(end + 6);
    if (hash(body) !== header.sha256)
      throw Error("文件正文已在外部修改，无法按原资产恢复；请作为新材料添加");
    const fingerprint = hash(text);
    const existing = this.store
      .all<Asset>("asset")
      .find(
        (a) =>
          a.importFingerprint === fingerprint ||
          a.files?.some((f) => f.sha256 === fingerprint),
      );
    if (existing) return existing;
    return this.store.transaction(() => {
      // Foreign IDs are provenance only, never identities or project/rule authority.
      const material: Material = {
        id: `asset-import:${fingerprint}`,
        version: 1,
        title: header.label,
        body,
        coverage: header.origin.coverage,
        createdAt: header.createdAt,
        ...(header.origin.url ? { url: header.origin.url } : {}),
      };
      this.store.put("material", `${material.id}@1`, material);
      const id = randomUUID();
      return this.store.put("asset", id, {
        id,
        label: header.label,
        reference: { materialId: material.id, version: 1, label: header.label },
        createdAt: header.createdAt,
        importedOrigin: header.origin,
        importFingerprint: fingerprint,
      });
    });
  }
  async restoreFile(path: string) {
    const file = await open(path, "r");
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > limit)
        throw Error("请选择不超过 1 MB 的资产文件");
      const bytes = Buffer.alloc(limit + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > limit) throw Error("资产文件超过 1 MB");
      return this.restore(
        new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, bytesRead),
        ),
      );
    } finally {
      await file.close();
    }
  }
  prepareUse(assetId: string) {
    const asset = this.store.require<Asset>("asset", assetId),
      material = this.store.material(asset.reference);
    if (material.readError) throw Error("材料尚未读取");
    const id = `new:asset:${asset.id}`,
      draft = this.store.get<Draft>("draft", id),
      refs = [...(draft?.refs ?? [])];
    if (
      !refs.some(
        (r) =>
          r.materialId === asset.reference.materialId &&
          r.version === asset.reference.version &&
          r.excerpt === asset.reference.excerpt,
      )
    )
      refs.push(asset.reference);
    if (refs.length > 20) throw Error("草稿引用已达上限，请先精简");
    return this.store.saveDraft({
      id,
      outputMode: draft?.outputMode,
      text: draft?.text ?? "",
      refs,
      recipient: draft?.recipient ?? null,
      projectId: draft?.projectId ?? null,
    });
  }
}
