import { createHash, randomUUID } from "node:crypto";
import { open, readFile, stat, lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import type { Store } from "./store";
import type { Team } from "./types";
import { LocalDirectories } from "./local-directories";
import {
  builtInSkills,
  skillDefinition,
  skillAvailability,
  skillKey,
  isTrialMethod,
  type SkillAdoption,
  type SkillDefinition,
  type SkillVersion,
  type SkillState,
} from "./skill-contract";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const provenanceSchema = z
  .object({
    workId: z.string().min(1).max(300),
    workTitle: z.string().max(1000),
    runId: z.string().min(1).max(300),
    versionId: z.string().min(1).max(300),
    versionHash: z.string().regex(/^[a-f0-9]{64}$/),
    refs: z
      .array(
        z
          .object({
            materialId: z.string().min(1).max(300),
            version: z.number().int().positive(),
            label: z.string().max(500),
            excerpt: z.string().max(32000).optional(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
const fileSchema = z
  .object({
    format: z.literal("ytriple.method"),
    schema: z.literal(1),
    definition: skillDefinition,
    origin: z
      .object({ key: z.string().max(300), source: z.string().max(30) })
      .strict(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    provenance: provenanceSchema.optional(),
  })
  .strict();
export class Skills {
  constructor(readonly store: Store) {}
  initialize() {
    for (const skill of builtInSkills)
      if (!this.store.get("skill", skillKey(skill)))
        this.store.put("skill", skillKey(skill), skill);
  }
  state(id: string, enabled: boolean) {
    if (!this.store.all<SkillVersion>("skill").some((s) => s.id === id))
      throw Error("方法不存在");
    return this.store.put<SkillState>("skill-state", id, { id, enabled });
  }
  capture(keys: string[], team: Team) {
    if (keys.length > 4 || new Set(keys).size !== keys.length)
      throw Error("每轮最多指定四个不同方法");
    const versions = this.store.all<SkillVersion>("skill"),
      states = this.store.all<SkillState>("skill-state");
    for (const key of keys) {
      const s = versions.find((s) => skillKey(s) === key);
      if (!s || skillAvailability(s, states) !== "ready")
        throw Error(`方法不可加载，请检查版本、启停与依赖：${s?.name ?? key}`);
    }
    const selected = versions.filter(
      (s) =>
        skillAvailability(s, states) === "ready" &&
        (keys.includes(skillKey(s)) ||
          (!isTrialMethod(s, this.store.all<SkillAdoption>("skill-adoption")) &&
            team.members.some((m) => m.skillKeys?.includes(skillKey(s)))) ||
          s.source.kind === "builtin"),
    );
    if (
      Buffer.byteLength(
        selected
          .filter((s) => keys.includes(skillKey(s)))
          .map((s) => s.body)
          .join("\n"),
      ) > 24000
    )
      throw Error("指定方法正文过长，请减少本轮方法");
    return structuredClone(selected);
  }
  save(input: SkillDefinition, key?: string) {
    const definition = skillDefinition.parse(input);
    if (Buffer.byteLength(definition.body) > 16000)
      throw Error("方法正文超过 16000 字节，请精简或拆分");
    return this.store.transaction(() => {
      const old = key
        ? this.store.require<SkillVersion>("skill", key)
        : undefined;
      if (old && old.source.kind !== "copy")
        throw Error("内置与导入版本保持原样，请编辑副本");
      const versions = old
        ? this.store.all<SkillVersion>("skill").filter((s) => s.id === old.id)
        : [];
      if (old && versions.at(-1)?.version !== old.version)
        throw Error("方法已有新版本，请重新打开");
      const s: SkillVersion = {
        ...definition,
        id: old?.id ?? randomUUID(),
        version: (old?.version ?? 0) + 1,
        createdAt: new Date().toISOString(),
        source: old?.source ?? { kind: "copy" },
        ...(old?.proposal ? { proposal: old.proposal } : {}),
        ...(old?.importedProposal
          ? { importedProposal: old.importedProposal }
          : {}),
      };
      return this.store.put("skill", skillKey(s), s);
    });
  }
  copy(key: string) {
    const old = this.store.require<SkillVersion>("skill", key);
    const s: SkillVersion = {
      ...old,
      id: randomUUID(),
      version: 1,
      name: `${old.name.slice(0, 195)} · 副本`,
      createdAt: new Date().toISOString(),
      source: { kind: "copy", fromKey: key },
    };
    return this.store.put("skill", skillKey(s), s);
  }
  private async file(path: string) {
    const dirs = new LocalDirectories(this.store),
      root = dirs.roots().aiPath;
    if (!root) throw Error("请先配置 AI 资产目录");
    const actual = await dirs.validatedPath("ai", path);
    let current = root;
    for (const part of relative(root, path).split("/")) {
      if (part === ".." || part === "." || !part)
        throw Error("请选择 AI 内的文件");
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink())
        throw Error("方法路径不能通过符号链接");
    }
    if (actual !== path) throw Error("请选择 AI 内的真实文件路径");
    const st = await stat(actual);
    if (!st.isFile() || st.size > 32000 || st.nlink !== 1)
      throw Error("方法文件需为 32 KB 以内的普通文本文件");
    const bytes = await readFile(actual),
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0") || /-----BEGIN .*PRIVATE KEY-----/.test(text))
      throw Error("文件不是可导入的方法正文");
    return text;
  }
  private async definition(path: string, raw: string) {
    let definition: SkillDefinition;
    if (path.endsWith(".json")) {
      const file = fileSchema.parse(JSON.parse(raw));
      if (sha(file.definition.body) !== file.sha256)
        throw Error("方法文件内容校验不一致");
      definition = file.definition;
    } else {
      if (!path.toLowerCase().endsWith(".md"))
        throw Error("请选择 Markdown 方法或导出的方法 JSON");
      const dependencies: string[] = [];
      const front = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      if (/^---\r?\n/.test(raw) && !front)
        throw Error("方法元数据未闭合，请检查开头的 YAML 区块");
      const metadata = front
        ? z
            .object({
              name: z.string().optional(),
              description: z.string().optional(),
            })
            .passthrough()
            .parse(parseYaml(front[1], { maxAliasCount: 0, uniqueKeys: true }))
        : {};
      const body = front ? raw.slice(front[0].length).trim() : raw;
      if (
        await stat(join(dirname(path), "scripts"))
          .then((s) => s.isDirectory())
          .catch(() => false)
      )
        dependencies.push("包内脚本执行尚未接入");
      for (const match of raw.matchAll(/\]\((?!https?:|#)([^)]+)\)/g))
        dependencies.push(`尚未加载包内资源：${match[1]}`);
      if (/^allowed-tools\s*:/m.test(raw))
        dependencies.push("声明的工具权限尚未接入");
      definition = {
        name:
          metadata.name ??
          body.match(/^#\s+(.+)$/m)?.[1] ??
          basename(dirname(path)),
        description:
          metadata.description ??
          "本地导入的方法正文；未执行脚本，未验证效果。",
        body,
        dependencies: [...new Set(dependencies)].slice(0, 20),
      };
    }
    definition = skillDefinition.parse(definition);
    if (Buffer.byteLength(definition.body) > 16000)
      throw Error("方法正文超过 16000 字节，未导入");
    return definition;
  }
  async importFile(path: string) {
    const raw = await this.file(path),
      definition = await this.definition(path, raw);
    const definitionHash = sha(JSON.stringify(definition));
    const id = `local.${sha(path).slice(0, 24)}`,
      versions = this.store
        .all<SkillVersion>("skill")
        .filter((s) => s.id === id);
    const last = versions.at(-1),
      digest = sha(raw);
    if (
      last?.source.sha256 === digest &&
      last.source.definitionHash === definitionHash
    )
      return last;
    const s: SkillVersion = {
      ...definition,
      id,
      version: (last?.version ?? 0) + 1,
      createdAt: new Date().toISOString(),
      source: { kind: "local", path, sha256: digest, definitionHash },
      ...(path.endsWith(".json") && fileSchema.parse(JSON.parse(raw)).provenance
        ? { importedProposal: fileSchema.parse(JSON.parse(raw)).provenance }
        : {}),
    };
    return this.store.put("skill", skillKey(s), s);
  }
  async inspect(key: string) {
    const s = this.store.require<SkillVersion>("skill", key);
    if (!s.source.path)
      return { state: "snapshot", message: "内置或独立副本，无外部源文件" };
    try {
      const raw = await this.file(s.source.path);
      const definition = await this.definition(s.source.path, raw);
      return {
        state:
          sha(raw) === s.source.sha256 &&
          (!s.source.definitionHash ||
            sha(JSON.stringify(definition)) === s.source.definitionHash)
            ? "unchanged"
            : "changed",
        message: "源文件变化不改写已保存版本；重新导入才产生新版本。",
      };
    } catch (e) {
      return {
        state: "unavailable",
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }
  async exportFile(key: string, path: string) {
    const s = this.store.require<SkillVersion>("skill", key),
      dirs = new LocalDirectories(this.store);
    const parent = await dirs.validatedDirectory("ai", dirname(path));
    if (parent !== dirname(path) || (await realpath(parent)) !== parent)
      throw Error("请选择真实 AI 资产目录");
    const root = dirs.roots().aiPath!;
    if (relative(root, parent).split("/")[0] === "system")
      throw Error("方法资产不能写入系统规则目录");
    if (!path.endsWith(".method.json"))
      throw Error("请使用 .method.json 扩展名");
    const definition = {
      name: s.name,
      description: s.description,
      body: s.body,
      dependencies: s.dependencies,
    };
    const content =
      JSON.stringify(
        {
          format: "ytriple.method",
          schema: 1,
          definition,
          origin: { key, source: s.source.kind },
          sha256: sha(s.body),
          provenance: s.proposal ?? s.importedProposal,
        },
        null,
        2,
      ) + "\n";
    if (Buffer.byteLength(content) > 32000)
      throw Error("方法及来源信息超过导入文件上限，请精简后再导出");
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { path, key };
  }
}
