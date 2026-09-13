import path from "node:path";
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  lstatSync,
  realpathSync,
  readdirSync,
} from "node:fs";
import { promises as fs } from "node:fs";
import { z } from "zod";
import { parseHTML } from "linkedom";
import type { Artifact, LibraryEntry, Source, Task } from "../shared/types.js";
import {
  portableCommandSchema,
  portableInternalCommandSchema,
  type PortableCommand,
  type PortableInternalCommand,
  type PortableSnapshot,
} from "../shared/portable.js";
import {
  mediaChannelInputSchema,
  mediaWorkInputSchema,
  type MediaChannel,
  type MediaWork,
} from "../shared/media.js";
import {
  routineScheduleSchema,
  routineLimitsSchema,
  type Routine,
} from "../shared/routines.js";
import {
  deliveryRecordSchema,
  type DeliveryRecord,
} from "../shared/delivery.js";
import {
  ensureOwnedDirectory,
  hash,
  readOwnedArtifactSync,
  textSource,
  within,
} from "./files.js";
import {
  readLibraryBytes,
  libraryRoot,
  listLibrary,
  librarySource,
} from "./library.js";
import { rankLibrary } from "./library-recall.js";
import { mediaSnapshot } from "./media.js";
import { routineSnapshot } from "./routines.js";
import { deliverySnapshot } from "./delivery.js";
import { validateSkillBindings } from "./skills.js";
import { skillCatalog } from "./skill-policy.js";
import {
  assertNoSkillCredentials,
  exportManagedSkills,
  importManagedSkills,
  validateManagedSkills,
} from "./skill-library.js";
import type { FeatureHost } from "./feature-host.js";
import { now, uid, type Store } from "./store.js";

const KEY = "portable.v1";
const MAX_PACKAGE = 64 * 1024 * 1024;
type Journal = PortableSnapshot & { receipts: Record<string, string> };
const state = (store: Store): Journal =>
  structuredClone(
    store.config<Journal>(KEY, () => ({
      backups: [],
      restores: [],
      imports: [],
      receipts: {},
    })),
  );
export function portableSnapshot(store: Store): PortableSnapshot {
  const { receipts: _receipts, ...snapshot } = state(store);
  return snapshot;
}
const locks = new WeakMap<Store, Promise<void>>();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9_:-]+$/);
const jsonObject = z.record(z.string(), z.unknown());
const versionSchema = z
  .object({
    version: z.number().int().positive(),
    hash: digest,
    createdAt: z.string(),
    summary: z.string(),
  })
  .strict();
const artifactSchema = z
  .object({
    id,
    title: z.string(),
    format: z.enum(["md", "html", "png", "pptx"]),
    hash: digest,
    version: z.number().int().positive(),
    goalVersion: z.number().int().positive(),
    updatedAt: z.string(),
    versions: z.array(versionSchema).max(10000),
  })
  .strict();
const sourceSchema = z
  .object({
    id,
    title: z.string(),
    type: z.enum(["text", "file", "url"]),
    location: z.string(),
    text: z.string().max(2_000_000),
    addedAt: z.string(),
    coverage: z.string(),
    remote: jsonObject.optional(),
    library: jsonObject.optional(),
  })
  .strict();
const taskSchema = z
  .object({
    id,
    title: z.string(),
    goal: z.string(),
    goalVersion: z.number().int().positive(),
    kind: z.enum(["research", "project", "learning", "brainstorm"]),
    member: z.enum(["coordinator", "researcher", "cto", "editor"]),
    teamMode: z.enum(["software", "media"]).optional(),
    surface: z.enum(["workspace", "background"]).optional(),
    projectId: z.string().optional(),
    archivedAt: z.string().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    messages: z.array(jsonObject).max(100000),
    events: z.array(jsonObject).max(100000),
    sources: z.array(sourceSchema).max(10000),
    artifacts: z.array(artifactSchema).max(10000),
    skillPins: z.array(jsonObject).max(256),
  })
  .strict();
const librarySchema = z
  .object({
    id,
    title: z.string(),
    format: z.enum(["md", "html", "png", "pptx"]),
    hash: digest,
    version: z.number().int().positive(),
    savedAt: z.string(),
    updatedAt: z.string(),
    tags: z.array(z.string()).max(30),
    note: z.string(),
    source: jsonObject,
    versions: z.array(versionSchema).max(10000),
    feedback: z.array(jsonObject).max(10000),
    feedbackResolutions: z.array(jsonObject).optional(),
  })
  .strict();
const bundleSchema = z
  .object({
    schema: z.literal("ytriple-portable"),
    version: z.literal(1),
    createdAt: z.string(),
    tasks: z.array(taskSchema).max(10000),
    library: z.array(librarySchema).max(10000),
    skills: z.array(z.object({ id, enabled: z.boolean() }).strict()).max(2048),
    managedSkills: z.array(jsonObject).max(1000).default([]),
    media: z
      .object({
        channels: z.array(jsonObject).max(10000),
        works: z.array(jsonObject).max(10000),
        documents: z
          .array(
            z
              .object({
                entityId: id,
                version: z.number().int().positive(),
                hash: digest,
              })
              .strict(),
          )
          .max(20000),
      })
      .strict(),
    deliveries: z.array(jsonObject).max(10000),
    routines: z.array(jsonObject).max(10000),
    blobs: z.record(digest, z.string().max(MAX_PACKAGE)),
  })
  .strict();
type Bundle = z.infer<typeof bundleSchema>;

/** Only explicit app content is portable; account, connection and credential stores never enter this function. */
function safeMetadata(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(safeMetadata);
  if (input && typeof input === "object")
    return Object.fromEntries(
      Object.entries(input)
        .filter(
          ([key]) =>
            !/(?:api.?key|password|authorization|cookie|access.?token|refresh.?token|device.?token|bootstrap.?token|credential|secret|profileId)/i.test(
              key,
            ),
        )
        .map(([key, value]) => [key, safeMetadata(value)]),
    );
  return input;
}
function rejectCredentials(value: string): void {
  if (
    /(?:sk-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{25,}|Bearer\s+[A-Za-z0-9._~-]{20,}|(?:api[_-]?key|access[_-]?token|password)\s*[=:]\s*["']?[A-Za-z0-9_./+~-]{20,})/i.test(
      value,
    )
  )
    throw new Error(
      "待导出内容中发现疑似凭据。备份未生成，请先从资料或记录中移除凭据后重试；连接与密钥本身不参与备份。",
    );
}
function bytesFor(file: string, limit: number): Buffer {
  if (!path.isAbsolute(file)) throw new Error("请选择有效的本地文件。");
  // Checking the parent chain rejects substituted directories as well as final symlinks.
  const parent = path.dirname(file);
  const checkParents = () => {
    for (let current = parent; ; current = path.dirname(current)) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        if (!(
          process.platform === "darwin" &&
          ["/tmp", "/var", "/etc"].includes(current) &&
          realpathSync(current) === "/private" + current
        ))
          throw new Error("所选文件路径经过符号链接，请选择真实文件。");
      } else if (!stat.isDirectory()) throw new Error("所选文件的目录无效。");
      if (current === path.dirname(current)) break;
    }
  };
  checkParents();
  const originalParent = lstatSync(parent);
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const initial = fstatSync(descriptor);
    if (!initial.isFile() || initial.size > limit)
      throw new Error("文件不可读或超过允许大小。");
    const bytes = readFileSync(descriptor);
    const final = lstatSync(file),
      after = fstatSync(descriptor);
    checkParents();
    const finalParent = lstatSync(parent);
    if (
      originalParent.ino !== finalParent.ino ||
      originalParent.dev !== finalParent.dev
    )
      throw new Error("所选文件目录在读取期间改变。");
    if (
      final.isSymbolicLink() ||
      initial.ino !== final.ino ||
      initial.dev !== final.dev ||
      initial.mtimeMs !== after.mtimeMs ||
      initial.size !== after.size ||
      bytes.byteLength > limit
    )
      throw new Error("读取期间文件改变，请重试。");
    // Reuse the owned reader for bounded files to validate every directory component.
    if (
      bytes.byteLength <= 20 * 1024 * 1024 &&
      hash(readOwnedArtifactSync({ path: file } as Artifact, parent)) !==
        hash(bytes)
    )
      throw new Error("文件在读取期间改变。");
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

export async function handlePortableCommand(
  host: FeatureHost,
  raw: PortableCommand | PortableInternalCommand,
): Promise<void> {
  const command = raw.type.endsWith(".path")
    ? portableInternalCommandSchema.parse(raw)
    : portableCommandSchema.parse(raw);
  const next = (locks.get(host.store) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      if (
        command.type === "portable.restore" ||
        command.type === "portable.importBookmarksFile"
      )
        throw new Error("请通过桌面文件选择器选择文件。");
      const log = state(host.store);
      const fingerprint = hash(JSON.stringify(command));
      if (log.receipts[command.requestId]) {
        if (log.receipts[command.requestId] !== fingerprint)
          throw new Error("请求编号已用于其他操作，请重新选择。");
        return;
      }
      if (command.type === "portable.backup") {
        const bundle = buildBundle(host.store);
        const serialized = JSON.stringify(bundle);
        rejectCredentials(serialized);
        if (Buffer.byteLength(serialized) > MAX_PACKAGE)
          throw new Error(
            "本地备份超过 64 MB，本次未写入；请先分批导出大附件。",
          );
        const directory = await ensureOwnedDirectory(
          path.join(host.store.settings().workspaceRoot, "portable-exports"),
        );
        const destination = path.join(
          directory,
          `${command.requestId}.ytriple.json`,
        );
        await fs.writeFile(destination, serialized, {
          flag: "wx",
          mode: 0o600,
        });
        log.backups.push({
          id: command.requestId,
          path: destination,
          createdAt: bundle.createdAt,
          tasks: bundle.tasks.length,
          assets: bundle.library.length,
          bytes: Buffer.byteLength(serialized),
        });
      } else if (command.type === "portable.restore.path") {
        const bytes = bytesFor(command.path, MAX_PACKAGE);
        const bundle = bundleSchema.parse(JSON.parse(bytes.toString("utf8")));
        validateBundle(bundle);
        log.restores.push(
          await restoreBundle(host.store, bundle, command.requestId),
        );
      } else {
        const content =
          command.type === "portable.importBookmarks.path"
            ? bytesFor(command.path, 2_000_000).toString("utf8")
            : command.content;
        const format =
          command.type === "portable.importBookmarks.path"
            ? /\.html?$/i.test(command.path)
              ? "html"
              : /\.json$/i.test(command.path)
                ? "json"
                : "text"
            : command.format;
        const parsed = parseBookmarks(content, format);
        if (!parsed.sources.length)
          throw new Error("没有找到可导入的正文或 http/https 书签。");
        let task: Task;
        if (command.taskId) {
          task = host.store.task(command.taskId);
          if (task.archivedAt)
            throw new Error("请先恢复目标工作，再导入收藏。");
        } else
          task = await host.createWork({
            requestId: command.requestId,
            title: command.title,
            goal: `${command.goal}\n\n若附带了本次匹配的 Lib 候选，请实际读取后区分新增、重复、补充与冲突，说明保留或过滤的依据；未取得的资料和未对照的资产不得声称已检查。`,
            isolatedContext: true,
            skillPolicy: { mode: "explicit", skillIds: ["material-digest"] },
            sources: [],
          });
        const existing = new Map(
          task.sources.map((source) => [
            `${source.type}:${source.type === "url" ? source.location : hash(source.text)}`,
            source,
          ]),
        );
        const failures: { url: string; message: string }[] = [];
        const fetchedSources = new Map<string, Source>();
        if (command.fetchURLs) {
          const candidates = parsed.sources
            .filter((source) => {
              if (source.type !== "url") return false;
              const previous = existing.get(`url:${source.location}`);
              return !previous || previous.coverage.includes("仅书签");
            })
            .slice(0, 50);
          let next = 0;
          await Promise.all(
            Array.from({ length: Math.min(4, candidates.length) }, async () => {
              while (next < candidates.length) {
                const source = candidates[next++]!;
                try {
                  if (!host.readURL)
                    throw new Error("公开网页读取通路尚不可用，已保留书签。");
                  const read = await host.readURL(source.location);
                  if (!read.text.trim())
                    throw new Error("未取得可读正文，已保留书签。");
                  fetchedSources.set(source.location, read);
                } catch (error) {
                  const message =
                    error instanceof Error
                      ? error.message
                          .replace(
                            /(?:sk-|AIza)[A-Za-z0-9_-]{12,}|Bearer\s+\S+/gi,
                            "[已隐藏]",
                          )
                          .slice(0, 300)
                      : "网页读取失败，已保留书签。";
                  failures.push({ url: source.location, message });
                }
              }
            }),
          );
        }
        let added = 0,
          duplicates = parsed.duplicates;
        for (const original of parsed.sources) {
          const source = fetchedSources.get(original.location) ?? original;
          const key = `${original.type}:${original.type === "url" ? original.location : hash(original.text)}`;
          if (
            existing.has(key) &&
            !(
              fetchedSources.has(original.location) &&
              existing.get(key)!.coverage.includes("仅书签")
            )
          ) {
            duplicates++;
            continue;
          }
          await host.addSource(task.id, source);
          existing.set(key, source);
          added++;
        }
        let libraryContext = "沿用原工作的资料与 Lib 查找范围。";
        if (task.isolatedContext) {
          libraryContext = "Lib 查找已关闭，本次未新增 Lib 对照材料。";
          if (host.store.settings().libraryRecall !== false) {
            const query = [
              command.goal,
              ...parsed.sources.map((original) => {
                const source =
                  fetchedSources.get(original.location) ?? original;
                return `${source.title}\n${source.text.slice(0, 600)}`;
              }),
            ]
              .join("\n")
              .slice(0, 30000);
            const matches = rankLibrary(
              listLibrary(host.store, host.store.settings().aiRoot),
              query,
              3,
            );
            let retained = 0;
            for (const match of matches) {
              const source = librarySource(
                host.store,
                host.store.settings().aiRoot,
                match.entry.id,
              );
              source.library!.selection = "recalled";
              source.library!.reason = `收藏导入边界匹配：${match.reason}`;
              const previous = host.store
                .task(task.id)
                .sources.find(
                  (item) =>
                    item.library?.entryId === source.library!.entryId &&
                    item.library.hash === source.library!.hash,
                );
              if (!previous) await host.addSource(task.id, source);
              retained++;
            }
            libraryContext = `按已启用的 Lib 查找设置，为本批实际材料匹配并携带 ${retained} 份本地候选的准确版本（最多 3 份）；属于有界关键词匹配，是否新增、补充或冲突由团队实际阅读后判断，不代表全库已比较。`;
          }
        }
        log.imports.push({
          id: command.requestId,
          taskId: task.id,
          createdAt: now(),
          added,
          duplicates,
          skipped: parsed.skipped,
          fetched: fetchedSources.size,
          failures,
          coverage:
            (command.fetchURLs
              ? `${parsed.coverage} 本次另尝试读取最多 50 个公开网页：成功返回 ${fetchedSources.size} 项、失败 ${failures.length} 项；每份资料以实际返回的覆盖说明为准，失败及未尝试的链接保持未读。`
              : parsed.coverage) + ` ${libraryContext}`,
        });
        if (command.run && added)
          void host.runWork(task.id).catch(() => undefined);
      }
      log.receipts[command.requestId] = fingerprint;
      host.store.setConfig(KEY, log);
    });
  locks.set(host.store, next);
  try {
    await next;
  } finally {
    if (locks.get(host.store) === next) locks.delete(host.store);
  }
}

function buildBundle(store: Store): Bundle {
  const blobs: Record<string, string> = {};
  const add = (
    file: string,
    expected: string,
    expectedDirectory = path.dirname(file),
  ) => {
    const bytes = readOwnedArtifactSync(
      { path: file } as Artifact,
      expectedDirectory,
    );
    if (hash(bytes) !== expected)
      throw new Error(
        "某份成果或历史版本在外部改变，备份已停止，请先核对文件。",
      );
    rejectCredentials(bytes.toString("utf8"));
    blobs[expected] = bytes.toString("base64");
  };
  const versions = (items: Artifact["versions"], root: string) =>
    items.map(({ path: file, ...version }) => {
      if (!within(root, file))
        throw new Error("历史版本不属于登记的成果目录。");
      add(file, version.hash, path.dirname(file));
      return version;
    });
  const tasks = store.tasks().map((task) => {
    assertNoSkillCredentials(
      validateSkillBindings(task.skillPins ?? task.skillBindings),
    );
    return {
      id: task.id,
      title: task.title,
      goal: task.goal,
      goalVersion: task.goalVersion,
      kind: task.kind,
      member: task.member,
      teamMode: task.teamMode,
      surface: task.surface,
      projectId: task.projectId,
      archivedAt: task.archivedAt,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      messages: safeMetadata(task.messages) as Record<string, unknown>[],
      events: safeMetadata(task.events) as Record<string, unknown>[],
      sources: safeMetadata(task.sources) as z.infer<typeof sourceSchema>[],
      skillPins: validateSkillBindings(
        task.skillPins ?? task.skillBindings,
      ) as unknown as Record<string, unknown>[],
      artifacts: task.artifacts.map((artifact) => {
        add(artifact.path, artifact.hash, task.workspace);
        return {
          id: artifact.id,
          title: artifact.title,
          format: artifact.format,
          hash: artifact.hash,
          version: artifact.version,
          goalVersion: artifact.goalVersion,
          updatedAt: artifact.updatedAt,
          versions: versions(
            artifact.versions,
            path.join(task.workspace, ".versions", artifact.id),
          ),
        };
      }),
    };
  });
  const library = store.library(store.settings().aiRoot).map((entry) => {
    const bytes = readLibraryBytes(store, store.settings().aiRoot, entry.id);
    if (hash(bytes) !== entry.hash)
      throw new Error("Lib 正文已在外部改变，请核对后再备份。");
    rejectCredentials(bytes.toString("utf8"));
    blobs[entry.hash] = bytes.toString("base64");
    return {
      id: entry.id,
      title: entry.title,
      format: entry.format,
      hash: entry.hash,
      version: entry.version,
      savedAt: entry.savedAt,
      updatedAt: entry.updatedAt,
      tags: entry.tags,
      note: entry.note,
      source: { ...entry.source },
      versions: versions(
        entry.versions,
        path.join(libraryRoot(store.settings().aiRoot), ".versions", entry.id),
      ),
      feedback: store
        .libraryFeedback(store.settings().aiRoot, entry.id)
        .map((feedback) => ({ ...feedback })),
      feedbackResolutions: entry.feedbackResolutions,
    };
  });
  const media = mediaSnapshot(store);
  const documents: Bundle["media"]["documents"] = [];
  for (const entity of [...media.channels, ...media.works]) {
    const directory =
      "channelId" in entity
        ? path.join(media.root, entity.channelId, "works", entity.id)
        : path.join(media.root, entity.id);
    const prefix = "channelId" in entity ? "work" : "channel";
    add(entity.documentPath, entity.documentHash, directory);
    for (const name of readdirSync(directory)) {
      const match = name.match(new RegExp(`^${prefix}-v([1-9][0-9]*)\\.md$`));
      if (!match) continue;
      const bytes = readOwnedArtifactSync(
        { path: path.join(directory, name) } as Artifact,
        directory,
      );
      const digest = hash(bytes);
      rejectCredentials(bytes.toString("utf8"));
      blobs[digest] = bytes.toString("base64");
      documents.push({
        entityId: entity.id,
        version: Number(match[1]),
        hash: digest,
      });
    }
  }
  const stripDocument = (entity: MediaChannel | MediaWork) => {
    const { documentPath: _path, ...record } = entity;
    return record;
  };
  const deliveries = deliverySnapshot(store).records.map(
    ({ sourceChanged: _changed, sourceMissing: _missing, ...record }) => record,
  );
  const routines = routineSnapshot(store).items;
  for (const routine of routines) assertNoSkillCredentials(routine.skills);
  return bundleSchema.parse(
    safeMetadata({
      schema: "ytriple-portable",
      version: 1,
      createdAt: now(),
      tasks,
      library,
      skills: skillCatalog(store).map(({ id, enabled }) => ({ id, enabled })),
      managedSkills: exportManagedSkills(store),
      media: {
        channels: media.channels.map(stripDocument),
        works: media.works.map(stripDocument),
        documents,
      },
      deliveries,
      routines,
      blobs,
    }),
  );
}

function validateBundle(bundle: Bundle): void {
  validateManagedSkills(bundle.managedSkills);
  const checkPins = (pins: Task["skillPins"]) => {
    for (const pin of validateSkillBindings(pins)) {
      const managed = bundle.managedSkills.find(
        (entry) => entry.id === pin.id,
      ) as import("./skill-library.js").ManagedSkill | undefined;
      if (
        managed &&
        !managed.versions.some(
          (version) => version.definition.hash === pin.hash,
        )
      )
        throw new Error("方法备份缺少任务已固定的历史版本。");
    }
  };
  for (const [expected, encoded] of Object.entries(bundle.blobs)) {
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        encoded,
      )
    )
      throw new Error("备份正文编码无效。");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.byteLength > 20 * 1024 * 1024 || hash(bytes) !== expected)
      throw new Error("备份正文哈希不一致或文件过大，尚未恢复任何数据。");
  }
  const unique = (items: { id: string }[], name: string) => {
    if (new Set(items.map((item) => item.id)).size !== items.length)
      throw new Error(`${name}存在重复身份。`);
  };
  unique(bundle.tasks, "任务");
  unique(bundle.library, "资产");
  const requireBlob = (value: string) => {
    if (!Object.hasOwn(bundle.blobs, value))
      throw new Error("备份缺少引用的正文版本。");
  };
  for (const task of bundle.tasks) {
    checkPins(task.skillPins as unknown as Task["skillPins"]);
    unique(task.artifacts, "成果");
    unique(task.sources, "资料");
    for (const artifact of task.artifacts) {
      requireBlob(artifact.hash);
      for (const version of artifact.versions) requireBlob(version.hash);
    }
    for (const message of task.messages)
      z.object({
        id,
        role: z.enum(["user", "assistant"]),
        member: z.enum(["coordinator", "cto", "researcher", "editor"]),
        content: z.string(),
        createdAt: z.string(),
        goalVersion: z.number().int().positive(),
      })
        .strict()
        .parse(message);
    for (const event of task.events)
      z.object({
        id,
        type: z.string(),
        member: z
          .enum(["coordinator", "cto", "researcher", "editor"])
          .optional(),
        summary: z.string(),
        createdAt: z.string(),
        goalVersion: z.number().int().positive(),
        data: jsonObject.optional(),
      })
        .strict()
        .parse(event);
  }
  for (const entry of bundle.library) {
    requireBlob(entry.hash);
    for (const version of entry.versions) requireBlob(version.hash);
  }
  for (const document of bundle.media.documents) requireBlob(document.hash);
  const mediaIds = new Set<string>();
  for (const entity of [...bundle.media.channels, ...bundle.media.works]) {
    const key = id.parse(entity.id);
    if (mediaIds.has(key)) throw new Error("媒体实体身份重复。");
    mediaIds.add(key);
    z.number().int().positive().parse(entity.revision);
    if (
      !bundle.media.documents.some(
        (document) =>
          document.entityId === key &&
          document.version === entity.revision &&
          document.hash === entity.documentHash,
      )
    )
      throw new Error("媒体资料缺少对应的准确正文版本。");
    z.array(
      z.object({
        taskId: id,
        stage: z.enum([
          "topic",
          "research",
          "script",
          "production",
          "publish",
          "review",
        ]),
        channelRevision: z.number().int().positive(),
        workRevision: z.number().int().nonnegative(),
        createdAt: z.string(),
        requestId: id,
      }),
    ).parse(entity.taskLinks);
  }
  for (const channel of bundle.media.channels)
    mediaChannelInputSchema.strip().parse(channel);
  for (const work of bundle.media.works) {
    mediaWorkInputSchema.strip().parse(work);
    id.parse(work.channelId);
    if (!bundle.media.channels.some((channel) => channel.id === work.channelId))
      throw new Error("作品关联的频道缺失。");
    z.array(
      z.object({
        id,
        variantId: id,
        url: z.string(),
        publishedAt: z.string(),
        recordedAt: z.string(),
      }),
    ).parse(work.publications);
    z.array(
      z.object({
        id,
        kind: z.enum(["comments", "report", "finished-work"]),
        title: z.string(),
        text: z.string(),
        url: z.string(),
        observedAt: z.string(),
        addedAt: z.string(),
        range: z.enum(["provided-text", "link-only"]),
      }),
    ).parse(work.feedback);
  }
  if (
    new Set(
      bundle.media.documents.map(
        (document) => `${document.entityId}:${document.version}`,
      ),
    ).size !== bundle.media.documents.length
  )
    throw new Error("媒体正文版本重复。");
  const routineRecord = z.object({
    id,
    taskId: id,
    workTaskId: id.optional(),
    title: z.string(),
    goal: z.string(),
    kind: z.enum(["research", "project", "learning", "brainstorm"]),
    member: z.enum(["coordinator", "cto", "researcher", "editor"]),
    version: z.number().int().positive(),
    schedule: routineScheduleSchema,
    limits: routineLimitsSchema,
    scope: z.object({
      taskSources: z.boolean(),
      sourceIds: z.array(id),
      libraryIds: z.array(id),
      aiRoot: z.string(),
      workspace: z.string(),
    }),
    permissionVersion: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    runCount: z.number().int().nonnegative(),
    tokens: z.number().nonnegative(),
    usageKnown: z.boolean(),
    runs: z.array(
      z.object({
        id,
        state: z.enum([
          "running",
          "completed",
          "unchanged",
          "failed",
          "interrupted",
          "waiting",
        ]),
        summary: z.string(),
        sourceIds: z.array(id),
        artifactIds: z.array(id),
        version: z.number().int().positive(),
        tokens: z.number().nonnegative(),
        usageKnown: z.boolean(),
        meaningful: z.boolean(),
      }),
    ),
    outputs: z.record(
      z.string(),
      z.object({ artifactId: id, hash: digest, sourceHash: digest }),
    ),
  });
  for (const routine of bundle.routines) {
    routineRecord.parse(routine);
    checkPins(routine.skills as Task["skillPins"]);
    if (!bundle.tasks.some((task) => task.id === routine.taskId))
      throw new Error("例行工作引用的原任务没有包含在备份中。");
  }
  for (const record of bundle.deliveries) {
    deliveryRecordSchema.parse(record);
    id.parse(record.id);
    id.parse(record.taskId);
    digest.parse(record.artifactHash);
    if (
      typeof record.content !== "string" ||
      hash(record.content) !== record.artifactHash ||
      !Array.isArray(record.history) ||
      !Array.isArray(record.feedback) ||
      !Array.isArray(record.works)
    )
      throw new Error("交付正文或版本关系无效。");
  }
}

async function restoreBundle(
  store: Store,
  bundle: Bundle,
  requestId: string,
): Promise<PortableSnapshot["restores"][number]> {
  const base = await ensureOwnedDirectory(store.settings().workspaceRoot);
  const root = path.join(base, `restored-${requestId}`);
  try {
    await fs.mkdir(root, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        "此恢复目录已存在。已保留现有文件，请重新选择备份发起新的恢复。",
      );
    throw error;
  }
  const map = new Map<string, string>();
  for (const item of [
    ...bundle.tasks,
    ...bundle.library,
    ...bundle.media.channels,
    ...bundle.media.works,
    ...bundle.deliveries,
    ...bundle.routines,
  ])
    map.set(String(item.id), uid());
  const mapped = (old: unknown) =>
    typeof old === "string" ? (map.get(old) ?? old) : old;
  const rewrite = (input: unknown): unknown => {
    if (typeof input === "string") return mapped(input);
    if (Array.isArray(input)) return input.map(rewrite);
    if (input && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input)
          .filter(
            ([key]) => !["__proto__", "constructor", "prototype"].includes(key),
          )
          .map(([key, value]) => [
            String(mapped(key)),
            [
              "text",
              "content",
              "quote",
              "instructions",
              "originalTaskId",
              "originalProjectId",
            ].includes(key)
              ? value
              : rewrite(value),
          ]),
      );
    return input;
  };
  const write = async (destination: string, digest: string) => {
    await ensureOwnedDirectory(path.dirname(destination));
    await fs.writeFile(
      destination,
      Buffer.from(bundle.blobs[digest]!, "base64"),
      { flag: "wx", mode: 0o600 },
    );
  };
  const tasks: Task[] = [];
  for (const saved of bundle.tasks) {
    const taskId = String(mapped(saved.id));
    const workspace = await ensureOwnedDirectory(path.join(root, taskId));
    const artifacts: Artifact[] = [];
    for (const item of saved.artifacts) {
      const destination = path.join(workspace, `${item.id}.${item.format}`);
      await write(destination, item.hash);
      const versions: Artifact["versions"] = [];
      for (const [index, version] of item.versions.entries()) {
        const file = path.join(
          workspace,
          ".versions",
          item.id,
          `${version.version}-${index}.${item.format}`,
        );
        await write(file, version.hash);
        versions.push({ ...version, path: file });
      }
      artifacts.push({ ...item, path: destination, versions });
    }
    const { projectId: originalProject, ...rest } = rewrite(
      saved,
    ) as unknown as Task;
    const importedLibraryIds = new Set(
      bundle.library.map((entry) => mapped(entry.id)),
    );
    const sources = (rest.sources ?? []).map((source) => {
      if (!source.library) return source;
      if (importedLibraryIds.has(source.library.entryId))
        return {
          ...source,
          library: { ...source.library, root: store.settings().aiRoot },
        };
      const { library: _library, ...local } = source;
      return {
        ...local,
        coverage: `${local.coverage}；原 Lib 关系未包含在备份中，已作为本地资料快照保留。`,
      };
    });
    tasks.push({
      ...rest,
      id: taskId,
      workspace,
      status: "paused",
      isolatedContext: true,
      skillPolicy: { mode: "off", skillIds: [] },
      skillBindings: [],
      sources,
      artifacts,
      events: [
        ...(rest.events ?? []),
        {
          id: uid(),
          type: "portable.restored",
          createdAt: now(),
          goalVersion: saved.goalVersion,
          summary:
            "已从本地备份恢复到新工作区。未恢复模型连接或运行权限；请选择方法与连接后继续。",
          data: {
            originalTaskId: saved.id,
            originalProjectId: originalProject,
          },
        },
      ],
    });
  }
  const assets: { entry: LibraryEntry; feedback: unknown[] }[] = [];
  const libRoot = await ensureOwnedDirectory(
    libraryRoot(store.settings().aiRoot),
  );
  for (const saved of bundle.library) {
    const entryId = String(mapped(saved.id));
    const destination = path.join(libRoot, `${entryId}.${saved.format}`);
    await write(destination, saved.hash);
    const versions: Artifact["versions"] = [];
    for (const [index, version] of saved.versions.entries()) {
      const file = path.join(
        libRoot,
        ".versions",
        entryId,
        `${version.version}-${index}.${saved.format}`,
      );
      await write(file, version.hash);
      versions.push({ ...version, path: file });
    }
    const restored = rewrite(saved) as unknown as LibraryEntry;
    const feedback = (restored.feedback ?? []).map((item) => ({
      ...item,
      id: uid(),
      entryId,
    }));
    const resolutionMap = new Map(
      (restored.feedback ?? []).map((item, index) => [
        item.id,
        feedback[index]!.id,
      ]),
    );
    assets.push({
      entry: {
        ...restored,
        id: entryId,
        path: destination,
        versions,
        feedbackResolutions: restored.feedbackResolutions?.map((item) => ({
          ...item,
          feedbackId: resolutionMap.get(item.feedbackId) ?? item.feedbackId,
        })),
      },
      feedback,
    });
  }
  const existingMedia = mediaSnapshot(store);
  const mediaRoot = existingMedia.root;
  const channels: MediaChannel[] = [],
    works: MediaWork[] = [];
  for (const old of [...bundle.media.channels, ...bundle.media.works]) {
    const entity = rewrite(old) as unknown as MediaChannel | MediaWork;
    const document = bundle.media.documents.find(
      (item) => item.entityId === old.id && item.version === entity.revision,
    );
    if (!document) throw new Error("媒体资料缺少当前正文版本。");
    const file =
      "channelId" in entity
        ? path.join(
            mediaRoot,
            entity.channelId,
            "works",
            entity.id,
            `work-v${entity.revision}.md`,
          )
        : path.join(mediaRoot, entity.id, `channel-v${entity.revision}.md`);
    for (const version of bundle.media.documents.filter(
      (item) => item.entityId === old.id,
    )) {
      await write(
        path.join(
          path.dirname(file),
          `${"channelId" in entity ? "work" : "channel"}-v${version.version}.md`,
        ),
        version.hash,
      );
    }
    const complete = {
      ...entity,
      documentPath: file,
      documentHash: document.hash,
    };
    if ("channelId" in complete) works.push(complete);
    else channels.push(complete);
  }
  const restoredDeliveries = bundle.deliveries.map((saved) => {
    const record = rewrite(saved) as unknown as DeliveryRecord;
    const task = tasks.find((item) => item.id === record.taskId);
    delete record.projectId;
    record.exports = (record.exports ?? []).map((item) => ({
      ...item,
      path:
        task?.artifacts.find((artifact) => artifact.id === item.artifactId)
          ?.path ?? "原导出文件未包含在本次备份中",
    }));
    return record;
  });
  const routines = bundle.routines.map((saved) => {
    const routine = rewrite(saved) as unknown as Routine;
    delete routine.projectId;
    delete routine.nextRunAt;
    delete routine.lastInputFingerprint;
    routine.state = "paused";
    routine.location = "client";
    routine.runs = routine.runs.map((run) =>
      run.state === "running"
        ? {
            ...run,
            state: "interrupted",
            finishedAt: now(),
            usageKnown: false,
            summary: "恢复的旧运行没有在本机继续执行，请核对已有结果。",
          }
        : run,
    );
    const task = tasks.find((task) => task.id === routine.taskId);
    if (
      routine.workTaskId &&
      !tasks.some((item) => item.id === routine.workTaskId)
    )
      delete routine.workTaskId;
    routine.scope = {
      ...routine.scope,
      aiRoot: store.settings().aiRoot,
      workspace: task?.workspace ?? root,
      libraryIds: routine.scope.libraryIds.filter((entryId) =>
        assets.some((asset) => asset.entry.id === entryId),
      ),
      sourceIds: routine.scope.sourceIds.filter((sourceId) =>
        task?.sources.some((source) => source.id === sourceId),
      ),
    };
    routine.lastError =
      "从备份恢复后已暂停；请核对资料、方法、额度和运行位置后重新启用。";
    return routine;
  });
  const skillIds = await importManagedSkills(
    store,
    bundle.managedSkills,
    requestId,
    Object.fromEntries(
      bundle.tasks.map((task) => [task.id, String(mapped(task.id))]),
    ),
  );
  const importedMethods = exportManagedSkills(store);
  const remapMethods = (definitions: NonNullable<Task["skillPins"]>) =>
    definitions.map((definition) => {
      const newId = skillIds[definition.id];
      if (!newId) return definition;
      const restored = importedMethods
        .find((entry) => entry.id === newId)
        ?.versions.find(
          (version) => version.definition.hash === definition.hash,
        )?.definition;
      if (!restored) throw new Error("恢复的方法缺少任务使用的准确版本。");
      return structuredClone(restored);
    });
  for (const task of tasks) {
    task.skillPins = remapMethods(task.skillPins ?? []);
    task.events = task.events.map((event) =>
      event.data?.skillId &&
      typeof event.data.skillId === "string" &&
      skillIds[event.data.skillId]
        ? {
            ...event,
            data: { ...event.data, skillId: skillIds[event.data.skillId] },
          }
        : event,
    );
  }
  for (const routine of routines) routine.skills = remapMethods(routine.skills);
  // All files are new and verified before the database atomically publishes restored objects.
  store.db.exec("BEGIN IMMEDIATE");
  try {
    for (const task of tasks) store.saveTask(task);
    for (const { entry, feedback } of assets) {
      store.saveLibrary(
        store.settings().aiRoot,
        entry,
        `portable:${requestId}:${entry.id}`,
      );
      for (const item of feedback)
        store.appendLibraryFeedback(
          store.settings().aiRoot,
          item as import("../shared/types.js").LibraryFeedback,
        );
    }
    const currentMedia = store.config<
      typeof existingMedia & { receipts: Record<string, unknown> }
    >(`media.v1:${mediaRoot}`, () => ({ ...existingMedia, receipts: {} }));
    store.setConfig(`media.v1:${mediaRoot}`, {
      ...currentMedia,
      revision: currentMedia.revision + 1,
      channels: [...currentMedia.channels, ...channels],
      works: [...currentMedia.works, ...works],
    });
    const delivery = store.config<{
      records: DeliveryRecord[];
      receipts: Record<string, unknown>;
    }>("delivery.ledger.v1", () => ({ records: [], receipts: {} }));
    store.setConfig("delivery.ledger.v1", {
      ...delivery,
      records: [...delivery.records, ...restoredDeliveries],
    });
    routineSnapshot(store);
    for (const routine of routines)
      store.db
        .prepare("INSERT INTO routines(id,body) VALUES(?,?)")
        .run(routine.id, JSON.stringify(routine));
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
  return {
    id: requestId,
    createdAt: now(),
    root,
    taskIds: tasks
      .filter((task) => task.surface !== "background")
      .map((task) => task.id),
    assets: assets.length,
    notices: [
      "所有任务及例行工作均暂停；方法选择默认为不用，固定方法版本仍保留。",
      "软件项目原归属只保留为历史证据，未迁移或写入中央项目登记。",
      "原有本机连接、密钥、规则和 Skill 全局启停设置保留；备份中的启停值不扩大本机权限。",
    ],
  };
}

export function parseBookmarks(
  content: string,
  format: "text" | "json" | "html",
) {
  const candidates: { title: string; url?: string; text?: string }[] = [];
  let skipped = 0,
    duplicates = 0;
  const add = (title: string, url?: string, text?: string) => {
    if (candidates.length >= 100) {
      skipped++;
      return;
    }
    candidates.push({ title, url, text });
  };
  if (format === "html") {
    const { document } = parseHTML(content);
    for (const anchor of document.querySelectorAll("a")) {
      const attribute = anchor
        .getAttributeNames()
        .find((name) => name.toLowerCase() === "href");
      if (attribute)
        add(
          anchor.textContent?.trim() || "未命名书签",
          anchor.getAttribute(attribute) ?? "",
        );
    }
  } else if (format === "json") {
    const visit = (node: unknown, depth: number) => {
      if (depth > 30) throw new Error("书签 JSON 嵌套过深，请导出简化列表。");
      if (Array.isArray(node)) {
        node.forEach((item) => visit(item, depth + 1));
        return;
      }
      if (!node || typeof node !== "object") return;
      const value = node as Record<string, unknown>;
      const url =
        typeof value.url === "string"
          ? value.url
          : typeof value.href === "string"
            ? value.href
            : undefined;
      const text =
        typeof value.text === "string"
          ? value.text
          : typeof value.content === "string"
            ? value.content
            : undefined;
      if (url || text)
        add(String(value.title ?? value.name ?? "导入资料"), url, text);
      for (const [key, child] of Object.entries(value))
        if (
          !["text", "content"].includes(key) &&
          child &&
          typeof child === "object"
        )
          visit(child, depth + 1);
    };
    visit(JSON.parse(content), 0);
  } else {
    for (const line of content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)) {
      const url = line.match(/https?:\/\/\S+/i)?.[0]?.replace(/[)>]+$/, "");
      if (url)
        add(
          line.replace(url, "").replace(/^[\s|\-*\d.]+|[\s|\-]+$/g, "") || url,
          url,
        );
      else if (
        /^[a-z]+:\/\//i.test(line) ||
        /^(?:javascript|data|file):/i.test(line)
      )
        skipped++;
      else add(line.slice(0, 160), undefined, line);
    }
  }
  const sources: Source[] = [],
    seen = new Set<string>();
  for (const item of candidates) {
    if (item.url) {
      let url: URL;
      try {
        url = new URL(item.url);
      } catch {
        skipped++;
        continue;
      }
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        /(?:token|api[_-]?key|password|auth|secret)/i.test(
          [...url.searchParams.keys()].join(" "),
        )
      ) {
        skipped++;
        continue;
      }
      url.hash = "";
      const key = url.toString();
      if (seen.has(key)) {
        duplicates++;
        continue;
      }
      seen.add(key);
      const source = textSource(
        item.title,
        item.text?.trim() ||
          `书签标题：${item.title}\n地址：${key}\n只导入了用户的标题与链接，尚未读取网页正文、字幕或画面。`,
        "url",
        key,
      );
      source.coverage = item.text?.trim()
        ? "用户随收藏提供的正文；未联网核验"
        : "仅书签标题与链接，未读取网页正文";
      sources.push(source);
    } else if (item.text?.trim()) {
      const key = hash(item.text.trim());
      if (seen.has(key)) {
        duplicates++;
        continue;
      }
      seen.add(key);
      const source = textSource(item.title, item.text.trim());
      source.coverage = "本次用户导入的文本；未联网核验";
      sources.push(source);
    }
  }
  return {
    sources,
    duplicates,
    skipped,
    coverage: `读取本次 ${format.toUpperCase()} 输入，最多 100 项；去重 ${duplicates} 项，跳过 ${skipped} 项。导入范围为用户书签与附带文本，不表示已取得平台完整收藏、私有登录态、网页全文、字幕或画面。`,
  };
}
