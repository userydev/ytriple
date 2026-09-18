import { directCallSchema } from "./model-contract";
import { toolRequestSchema, toolKey } from "./tool-contract";
import { createHash, randomUUID } from "node:crypto";
import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  lstat,
  rename,
  rm,
  mkdtemp,
  link,
} from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { z } from "zod";
import { Store } from "./store";
import {
  workspaceData,
  type WorkspaceData,
  type BackupPreview,
  type SpaceEntry,
  type SpaceInfo,
} from "./backup-contract";
import { teamSchema, workflowSchema } from "./configuration";
import { layoutSchema, viewSchema } from "./view";
import { insightSchema, topicInputSchema } from "./radar-contract";
import { skillDefinition } from "./skill-contract";
import { workspaceActionProposalSchema } from "./workspace-action-contract";

const limit = 64 * 1024 * 1024;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const spaceId = z.union([z.literal("primary"), z.string().uuid()]);
const entrySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    createdAt: z.string().datetime(),
    backupHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const backupSchema = z
  .object({
    format: z.literal("ytriple.workspace"),
    schema: z.literal(1),
    createdAt: z.string().datetime(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    payload: workspaceData,
  })
  .strict();
const reference = z.object({
  materialId: z.string(),
  version: z.number().int().positive(),
  label: z.string(),
  excerpt: z.string().optional(),
});
const rootsSchema = z.object({
  aiPath: z.string().nullable(),
  codePath: z.string().nullable(),
});
const statuses = z.enum([
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
]);
const fields: Record<string, z.ZodType> = {
  "workspace-action": workspaceActionProposalSchema,
  "tool-call": z
    .object({
      id: z.string(),
      runId: z.string(),
      contributionId: z.string(),
      memberId: z.string(),
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      request: toolRequestSchema,
      status: z.enum(["succeeded", "failed"]),
      output: z.string().max(16000),
      createdAt: z.string().datetime(),
    })
    .strict(),
  "direct-call": directCallSchema,
  work: z.object({
    id: z.string(),
    title: z.string(),
    projectId: z.string().nullable(),
    deliveryId: z.string().nullable(),
    archived: z.boolean(),
    queuePaused: z.boolean(),
  }),
  project: z.object({
    id: z.string(),
    name: z.string(),
    goal: z.string(),
    kind: z.enum(["software", "media"]),
  }),
  delivery: z.object({
    id: z.string(),
    projectId: z.string(),
    title: z.string(),
    adoptedVersionId: z.string().nullable(),
  }),
  material: z.object({
    id: z.string(),
    version: z.number().int().positive(),
    title: z.string(),
    body: z.string(),
    coverage: z.string(),
    createdAt: z.string(),
  }),
  draft: z.object({
    id: z.string(),
    text: z.string(),
    refs: z.array(reference),
    recipient: z.string().nullable(),
    projectId: z.string().nullable(),
  }),
  message: z.object({
    id: z.string(),
    workId: z.string(),
    runId: z.string(),
    body: z.string(),
    refs: z.array(reference),
    role: z.enum(["user", "assistant"]),
  }),
  run: z.object({
    tools: z
      .object({
        keys: z.array(toolKey).max(3),
        maxCalls: z.number().int().min(1).max(8),
      })
      .strict()
      .optional(),
    id: z.string(),
    workId: z.string(),
    text: z.string(),
    refs: z.array(reference),
    status: statuses,
    team: teamSchema,
    workflow: workflowSchema,
    submissionKey: z.string(),
  }),
  contribution: z.object({
    id: z.string(),
    workId: z.string(),
    runId: z.string(),
    memberId: z.string(),
    memberName: z.string(),
    objective: z.string(),
    body: z.string(),
    status: statuses,
    toolFormatError: z
      .object({
        message: z.string().min(1).max(1000),
        createdAt: z.string().datetime(),
      })
      .strict()
      .optional(),
  }),
  version: z.object({
    id: z.string(),
    artifactId: z.string(),
    workId: z.string(),
    runId: z.string().nullable(),
    number: z.number().int().positive(),
    parentId: z.string().nullable(),
    body: z.string(),
  }),
  asset: z.object({ id: z.string(), label: z.string(), reference }),
  team: teamSchema,
  workflow: workflowSchema,
  view: viewSchema,
  "radar-topic": topicInputSchema.safeExtend({
    id: z.string(),
    updatedAt: z.string(),
  }),
  "radar-edition": z.object({
    id: z.string(),
    topicId: z.string(),
    jobId: z.string(),
    number: z.number().int().positive(),
    insight: insightSchema,
    sources: z.array(
      z.object({
        key: z.string(),
        reference,
        title: z.string(),
        body: z.string(),
        coverage: z.string(),
      }),
    ),
  }),
  "radar-job": z.object({
    id: z.string(),
    topic: z.object({ id: z.string() }),
    status: statuses,
    body: z.string(),
    sources: z.array(
      z.object({ key: z.string(), reference, body: z.string() }),
    ),
  }),
  "radar-reading": z.object({
    id: z.string(),
    saved: z.boolean(),
    read: z.boolean(),
    scroll: z.number(),
  }),
  feed: z.object({
    id: z.string(),
    name: z.string(),
    url: z.string(),
    revision: z.number().int().positive(),
    enabled: z.boolean(),
    archived: z.boolean(),
  }),
  "radar-watch": z.object({
    id: z.string(),
    revision: z.number().int().positive(),
    topicRevision: z.number().int().positive(),
    enabled: z.boolean(),
  }),
  schedule: z.object({
    id: z.string(),
    revision: z.number().int().positive(),
    workId: z.string(),
    name: z.string(),
    refs: z.array(reference),
    enabled: z.boolean(),
    team: teamSchema,
    workflow: workflowSchema,
    skills: z.array(z.unknown()),
  }),
  skill: skillDefinition.extend({
    id: z.string(),
    version: z.number().int().positive(),
    createdAt: z.string(),
    source: z.object({
      kind: z.enum(["builtin", "local", "copy", "proposal"]),
    }),
    proposal: z.unknown().optional(),
    importedProposal: z.unknown().optional(),
  }),
};
const kinds = new Set(
  "tool-call workspace-action direct-call asset candidate contribution decision decision-answer delivery draft feed feed-check feed-preview initialization initialization-form local-source local-system-plan material message meta model-call model-input outcome outcome-input project project-brief project-inspection project-reading-work project-standard radar-auto-check radar-edition radar-job radar-reading radar-topic radar-watch run schedule schedule-occurrence schedule-version skill skill-adoption skill-state suggestion-document suggestion-preview suggestion-receipt team version view work work-event workflow".split(
    " ",
  ),
);

export function validateWorkspace(data: WorkspaceData) {
  const indexed = new Map<string, Map<string, any>>();
  for (const row of data.entities) {
    if (!kinds.has(row.kind))
      throw Error(`备份含当前版本不支持的记录类型：${row.kind}`);
    let values = indexed.get(row.kind);
    if (!values) {
      values = new Map();
      indexed.set(row.kind, values);
    }
    if (values.has(row.id)) throw Error("备份包含重复记录");
    let value: any;
    try {
      value = JSON.parse(row.data);
    } catch {
      throw Error("备份记录不是有效 JSON");
    }
    if (
      row.kind !== "meta" &&
      (!value || typeof value !== "object" || Array.isArray(value))
    )
      throw Error(`备份记录格式不符：${row.kind}`);
    const schema = fields[row.kind];
    if (schema && !schema.safeParse(value).success)
      throw Error(`备份记录格式不符：${row.kind}`);
    if (row.kind === "meta") {
      const schema =
        row.id === "layout"
          ? layoutSchema
          : row.id === "team"
            ? teamSchema
            : row.id === "workflow"
              ? workflowSchema
              : row.id === "local-roots"
                ? rootsSchema
                : row.id === "workspace-policy"
                  ? z.object({ direct: z.boolean() }).strict()
                : null;
      if (schema && !schema.safeParse(value).success)
        throw Error(`备份设置格式不符：${row.id}`);
    }
    if (row.kind === "material" && row.id !== `${value.id}@${value.version}`)
      throw Error("材料版本标识不一致");
    if (
      ["team", "workflow", "skill"].includes(row.kind) &&
      row.id !== `${value.id}@${value.version}`
    )
      throw Error("配置版本标识不一致");
    if (
      [
        "work",
        "project",
        "delivery",
        "run",
        "message",
        "version",
        "asset",
        "contribution",
        "radar-topic",
        "radar-job",
        "radar-edition",
        "feed",
        "schedule",
        "radar-watch",
        "tool-call",
        "workspace-action",
      ].includes(row.kind) &&
      value.id !== row.id
    )
      throw Error("备份记录身份不一致");
    values.set(row.id, value);
  }
  const required = (kind: string, id: unknown) => {
    if (id != null && !indexed.get(kind)?.has(String(id)))
      throw Error(`备份缺少关联记录：${kind}`);
  };
  const refs = (list: any) => {
    if (!Array.isArray(list)) throw Error("备份引用格式不符");
    for (const ref of list) {
      if (!reference.safeParse(ref).success) throw Error("备份引用格式不符");
      required("material", `${ref.materialId}@${ref.version}`);
    }
  };
  const materialIds = new Set(
    [...(indexed.get("material")?.values() ?? [])].map((m) => m.id),
  );
  for (const [kind, values] of indexed)
    for (const [id, value] of values) {
      if (kind === "tool-call") {
        required("run", value.runId);
        required("contribution", value.contributionId);
        const owner = indexed.get("contribution")!.get(value.contributionId);
        if (
          owner.runId !== value.runId ||
          owner.memberId !== value.memberId ||
          id !== `tool:${value.contributionId}`
        )
          throw Error("工具记录与成员归属不一致");
        if (owner.tool && JSON.stringify(owner.tool) !== JSON.stringify(value))
          throw Error("过程中的工具返回与执行记录不一致");
      }
      if (kind === "workspace-action") {
        required("run", value.runId);
        required("work", value.workId);
        required("contribution", value.contributionId);
        const owner = indexed.get("contribution")!.get(value.contributionId);
        if (
          owner.runId !== value.runId ||
          owner.workId !== value.workId ||
          owner.memberId !== value.memberId ||
          id !== `workspace-action:${value.contributionId}`
        )
          throw Error("工作台操作与成员归属不一致");
        if (value.result) {
          const kind =
            value.result.kind === "radar-topic"
              ? "radar-topic"
              : value.result.kind === "schedule"
                ? "schedule"
                : "radar-watch";
          required(kind, value.result.id);
        }
      }
      if (kind === "contribution" && value.tool)
        required("tool-call", value.tool.id);
      if (
        [
          "run",
          "message",
          "contribution",
          "version",
          "candidate",
          "decision",
        ].includes(kind)
      )
        required("work", value.workId);
      if (
        [
          "message",
          "contribution",
          "version",
          "candidate",
          "decision",
        ].includes(kind)
      )
        required("run", value.runId);
      if (
        ["work", "delivery", "project-brief", "project-standard"].includes(kind)
      )
        required("project", value.projectId);
      if (kind === "work") {
        required("delivery", value.deliveryId);
        required("team", value.teamKey);
        required("workflow", value.workflowKey);
      }
      if (kind === "delivery") required("version", value.adoptedVersionId);
      if (kind === "version") required("version", value.parentId);
      if (
        ["run", "draft", "message", "project-brief", "schedule"].includes(kind)
      )
        refs(value.refs);
      if (kind === "asset") refs([value.reference]);
      if (kind === "radar-watch") required("radar-topic", id);
      if (kind === "radar-edition") {
        required("radar-topic", value.topicId);
        required("radar-job", value.jobId);
        refs(value.sources.map((s: any) => s.reference));
      }
      if (kind === "radar-job") {
        required("radar-topic", value.topic.id);
        refs(value.sources.map((s: any) => s.reference));
      }
      if (kind === "radar-reading") required("radar-edition", id);
      if (kind === "radar-topic") {
        for (const s of value.sources) {
          if (!materialIds.has(s.materialId)) throw Error("议题引用的材料缺失");
        }
        for (const id of value.feedIds ?? []) required("feed", id);
      }
    }
  const keys = new Set<string>();
  for (const row of data.submissions) {
    if (keys.has(row.key)) throw Error("备份包含重复提交身份");
    keys.add(row.key);
    required("run", row.run_id);
  }
  return indexed;
}

async function boundedRead(path: string) {
  const st = await lstat(path);
  if (!st.isFile() || st.size > limit)
    throw Error("请选择 64 MiB 以内的工作空间备份文件");
  const bytes = await readFile(path);
  if (bytes.length > limit) throw Error("备份超过 64 MiB 读取上限");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
function parseBackup(text: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw Error("不是有效的工作空间备份文件");
  }
  const parsed = backupSchema.safeParse(raw);
  if (!parsed.success) throw Error("备份格式或版本不受支持；当前空间未变");
  const value = parsed.data;
  if (hash(JSON.stringify(value.payload)) !== value.sha256)
    throw Error("备份校验失败，文件可能不完整或已被改动");
  validateWorkspace(value.payload);
  return value;
}

export class WorkspaceBackups {
  private previews = new Map<
    string,
    { path: string; hash: string; expires: number; preview: BackupPreview }
  >();
  private startupError: string | undefined;
  constructor(readonly root: string) {}
  private folder(id: string) {
    spaceId.parse(id);
    return id === "primary" ? this.root : join(this.root, "spaces", id);
  }
  private async managedFolder(id: string) {
    if (
      id !== "primary" &&
      (await lstat(join(this.root, "spaces"))).isSymbolicLink()
    )
      throw Error("空间目录不能是符号链接");
    const path = this.folder(id);
    const st = await lstat(path);
    if (!st.isDirectory() || st.isSymbolicLink())
      throw Error("工作空间目录不可用");
    return path;
  }
  async currentId() {
    try {
      const value = JSON.parse(
        await readFile(join(this.root, "active-space.json"), "utf8"),
      );
      const id = spaceId.parse(value.id);
      await this.managedFolder(id);
      if (id !== "primary") {
        const entry = entrySchema.parse(
          JSON.parse(
            await readFile(join(this.folder(id), "space.json"), "utf8"),
          ),
        );
        if (
          entry.id !== id ||
          !(await lstat(join(this.folder(id), "workbench.sqlite"))).isFile()
        )
          throw Error("空间文件不完整");
      }
      return id;
    } catch (e) {
      // A missing selector is normal. A broken selected space opens the original without deleting evidence.
      if (
        (e as NodeJS.ErrnoException).code !== "ENOENT" ||
        (await lstat(join(this.root, "active-space.json")).then(
          () => true,
          () => false,
        ))
      )
        this.startupError =
          "所选空间不可用，已打开原工作空间；原配置文件保留，请重新选择空间。";
      return "primary";
    }
  }
  async currentDirectory() {
    return this.folder(await this.currentId());
  }
  async info(): Promise<SpaceInfo> {
    const currentId = await this.currentId();
    const spaces: SpaceEntry[] = [
      { id: "primary", name: "原工作空间", createdAt: "" },
    ];
    try {
      for (const dir of await readdir(join(this.root, "spaces"), {
        withFileTypes: true,
      })) {
        if (
          !dir.isDirectory() ||
          !z.string().uuid().safeParse(dir.name).success
        )
          continue;
        try {
          const entry = entrySchema.parse(
            JSON.parse(
              await readFile(join(this.folder(dir.name), "space.json"), "utf8"),
            ),
          );
          if (entry.id === dir.name) spaces.push(entry);
        } catch {
          /* Incomplete staging is never offered as a workspace. */
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    return {
      currentId,
      currentName: spaces.find((s) => s.id === currentId)?.name ?? "未知空间",
      spaces,
      restored: currentId !== "primary",
      startupError: this.startupError,
    };
  }
  async select(id: string) {
    const info = await this.info();
    if (!info.spaces.some((s) => s.id === id)) throw Error("工作空间不存在");
    await this.managedFolder(id);
    if (!(await lstat(join(this.folder(id), "workbench.sqlite"))).isFile())
      throw Error("工作空间数据库不存在");
    const path = join(this.root, `.active-space-${randomUUID()}.tmp`);
    await writeFile(path, JSON.stringify({ id }), { mode: 0o600, flag: "wx" });
    try {
      await rename(path, join(this.root, "active-space.json"));
      this.startupError = undefined;
    } finally {
      await rm(path, { force: true });
    }
  }
  async export(store: Store, path: string) {
    const payload = workspaceData.parse(store.exportState());
    validateWorkspace(payload);
    const backup = {
      format: "ytriple.workspace",
      schema: 1,
      createdAt: new Date().toISOString(),
      sha256: hash(JSON.stringify(payload)),
      payload,
    };
    const text = JSON.stringify(backup);
    if (Buffer.byteLength(text) > limit)
      throw Error("当前空间超过 64 MiB 备份范围；没有输出截断文件");
    const temp = join(dirname(path), `.ytriple-backup-${randomUUID()}.tmp`);
    try {
      await writeFile(temp, text, { flag: "wx", mode: 0o600 });
      await link(temp, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw Error("此位置已有文件，请使用新的备份文件名");
      throw error;
    } finally {
      await rm(temp, { force: true });
    }
    return {
      path,
      sha256: backup.sha256,
      bytes: Buffer.byteLength(text),
      createdAt: backup.createdAt,
    };
  }
  async inspect(path: string): Promise<BackupPreview> {
    const text = await boundedRead(path),
      backup = parseBackup(text),
      counts: Record<string, number> = {};
    for (const row of backup.payload.entities)
      counts[row.kind] = (counts[row.kind] ?? 0) + 1;
    const roots = backup.payload.entities.find(
      (r) => r.kind === "meta" && r.id === "local-roots",
    );
    const preview: BackupPreview = {
      id: randomUUID(),
      name: basename(path),
      createdAt: backup.createdAt,
      sha256: backup.sha256,
      bytes: Buffer.byteLength(text),
      counts,
      roots: roots
        ? rootsSchema.parse(JSON.parse(roots.data))
        : { aiPath: null, codePath: null },
    };
    for (const [id, p] of this.previews)
      if (p.expires < Date.now()) this.previews.delete(id);
    if (this.previews.size >= 3)
      this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(preview.id, {
      path,
      hash: hash(text),
      expires: Date.now() + 600000,
      preview,
    });
    return preview;
  }
  async restore(
    previewId: string,
    name: string,
    approvedRoots: { aiPath: string | null; codePath: string | null },
  ): Promise<SpaceEntry> {
    const preview = this.previews.get(previewId);
    if (!preview || preview.expires < Date.now())
      throw Error("恢复预览已过期，请重新选择备份");
    const entry = entrySchema.parse({
      id: previewId,
      name,
      createdAt: new Date().toISOString(),
      backupHash: preview.preview.sha256,
    });
    const text = await boundedRead(preview.path);
    if (hash(text) !== preview.hash)
      throw Error("备份在预览后发生变化，请重新检查");
    const backup = parseBackup(text);
    const parent = join(this.root, "spaces");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    if ((await lstat(parent)).isSymbolicLink())
      throw Error("空间目录不能是符号链接");
    const destination = this.folder(entry.id);
    try {
      await this.managedFolder(entry.id);
      const existing = entrySchema.parse(
        JSON.parse(await readFile(join(destination, "space.json"), "utf8")),
      );
      if (existing.backupHash === entry.backupHash) return existing;
      throw Error("恢复目录已存在");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const stage = await mkdtemp(join(parent, ".restore-"));
    let store: Store | undefined;
    try {
      store = new Store(join(stage, "workbench.sqlite"));
      store.restoreState(backup.payload);
      store.transaction(() => {
        for (const kind of ["schedule", "feed", "radar-watch"]) {
          for (const item of store!.all<any>(kind))
            store!.put(kind, item.id, {
              ...item,
              enabled: false,
              nextAt: null,
              ...(kind === "schedule"
                ? { pauseReason: "从备份恢复，请检查范围后重新启用" }
                : { error: "从备份恢复，请检查范围后重新启用" }),
            });
        }
        for (const work of store!.all<any>("work"))
          store!.put("work", work.id, { ...work, queuePaused: true });
        store!.put("meta", "workspace-policy", { direct: false });
        for (const action of store!.all<any>("workspace-action"))
          if (action.status === "pending")
            store!.put("workspace-action", action.id, {
              ...action,
              status: "dismissed",
              dismissedAt: entry.createdAt,
            });
        for (const row of backup.payload.entities) {
          if (row.kind === "local-source")
            store!.put(row.kind, row.id, {
              ...JSON.parse(row.data),
              needsRelink: true,
            });
          if (
            [
              "initialization",
              "local-system-plan",
              "suggestion-preview",
            ].includes(row.kind)
          )
            store!.put(row.kind, row.id, {
              ...JSON.parse(row.data),
              restored: true,
            });
          if (row.kind === "feed-preview")
            store!.put(row.kind, row.id, {
              ...JSON.parse(row.data),
              expiresAt: "2000-01-01T00:00:00.000Z",
            });
        }
        const oldRoots = store!.get<any>("meta", "local-roots") ?? {
          aiPath: null,
          codePath: null,
        };
        store!.put("meta", "local-roots", {
          aiPath:
            oldRoots.aiPath === approvedRoots.aiPath ? oldRoots.aiPath : null,
          codePath:
            oldRoots.codePath === approvedRoots.codePath
              ? oldRoots.codePath
              : null,
        });
        store!.remove("meta", "local-inventory");
        store!.put("meta", "backup-origin", {
          sha256: backup.sha256,
          createdAt: backup.createdAt,
          restoredAt: entry.createdAt,
          originalRoots: oldRoots,
        });
      });
      store.recover();
      store.snapshot();
      store.close();
      store = undefined;
      await writeFile(join(stage, "space.json"), JSON.stringify(entry), {
        mode: 0o600,
        flag: "wx",
      });
      await rename(stage, destination);
      return entry;
    } finally {
      store?.close();
      await rm(stage, { recursive: true, force: true });
    }
  }
}
