import path from "node:path";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type {
  Artifact,
  Command,
  LibraryEntry,
  LibraryFeedback,
  Source,
} from "../shared/types.js";
import {
  ensureOwnedDirectory,
  hash,
  readOwnedArtifactSync,
  textSource,
} from "./files.js";
import { Store, now, uid } from "./store.js";
import {
  libraryAssessment,
  LIBRARY_ASSESSMENT_LABELS,
} from "../shared/library.js";

type CollectInput = Extract<Command, { type: "library.collect" }>;
type SaveInput = Extract<Command, { type: "library.save" }>;
type LibraryOperation = {
  state: "prepared" | "committed" | "needs-check" | "abandoned" | "superseded";
  entry: LibraryEntry;
  collectionKey: string;
  expectedVersion: number;
};

export const libraryRoot = (aiRoot: string) =>
  path.join(path.resolve(aiRoot), "knowledge", "lib");
const collectionKey = (source: LibraryEntry["source"]) =>
  hash(JSON.stringify([source.taskId, source.artifactId, source.artifactHash]));
const asArtifact = (entry: LibraryEntry): Artifact => ({
  ...entry,
  goalVersion: entry.source.goalVersion,
});
function existingCollection(
  store: Store,
  aiRoot: string,
  entry: LibraryEntry,
): LibraryEntry {
  readLibraryBytes(store, aiRoot, entry.id);
  return readLibraryEntry(store, aiRoot, entry.id);
}

function activeRoot(store: Store, aiRoot: string): string {
  if (path.resolve(store.settings().aiRoot) !== path.resolve(aiRoot))
    throw new Error("AI 目录已切换，请在当前目录重新选择收藏。");
  return libraryRoot(aiRoot);
}
function validatePath(entry: LibraryEntry, root: string): void {
  if (
    !/^[a-f0-9-]{36}$/.test(entry.id) ||
    !["md", "html", "png", "pptx"].includes(entry.format) ||
    path.resolve(entry.path) !== path.join(root, `${entry.id}.${entry.format}`)
  )
    throw new Error("收藏路径不属于当前 Lib，已停止读取。");
}
function assertLibraryChain(directory: string): void {
  for (
    let current = path.resolve(directory);
    ;
    current = path.dirname(current)
  ) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      if (!(
        process.platform === "darwin" &&
        ["/var", "/tmp", "/etc"].includes(current) &&
        realpathSync(current) === "/private" + current
      ))
        throw new Error("Lib 路径经过符号链接，已停止读写。");
    } else if (!stat.isDirectory()) throw new Error("Lib 路径不是目录。");
    if (current === path.dirname(current)) break;
  }
}
function metadata(
  input: { title?: string; tags?: string[]; note?: string },
  fallback: { title: string; tags: string[]; note: string },
) {
  const title = input.title === undefined ? fallback.title : input.title.trim();
  const note = input.note === undefined ? fallback.note : input.note.trim();
  const tags =
    input.tags === undefined
      ? fallback.tags
      : input.tags.map((tag) => tag.trim()).filter(Boolean);
  if (
    !title ||
    title.length > 160 ||
    note.length > 4000 ||
    tags.length > 20 ||
    tags.some((tag) => tag.length > 60)
  )
    throw new Error("收藏标题、标签或备注为空或过长。");
  return { title, note, tags: [...new Set(tags)] };
}

/** Reads only an entry registered in the currently selected AI root. */
export function readLibraryBytes(
  store: Store,
  aiRoot: string,
  entryId: string,
): Buffer {
  const root = activeRoot(store, aiRoot),
    entry = store.libraryEntry(aiRoot, entryId);
  validatePath(entry, root);
  return readOwnedArtifactSync(asArtifact(entry), root);
}
export function readLibraryEntry(
  store: Store,
  aiRoot: string,
  entryId: string,
): LibraryEntry {
  activeRoot(store, aiRoot);
  const entry = store.libraryEntry(aiRoot, entryId);
  const feedback = store.libraryFeedback(aiRoot, entryId);
  const {
    content: _content,
    readError: _readError,
    previewURL: _previewURL,
    ...record
  } = entry;
  try {
    const bytes = readLibraryBytes(store, aiRoot, entryId);
    return {
      ...record,
      hash: hash(bytes),
      externalChange: hash(bytes) !== entry.hash,
      feedback,
      feedbackRevision: feedback.length,
      ...(["md", "html"].includes(entry.format)
        ? { content: bytes.toString("utf8") }
        : {}),
    };
  } catch {
    return {
      ...record,
      feedback,
      feedbackRevision: feedback.length,
      readError: "无法读取收藏，文件或 AI 目录可能已移动或改变。",
    };
  }
}
export function listLibrary(store: Store, aiRoot: string): LibraryEntry[] {
  activeRoot(store, aiRoot);
  return store
    .library(aiRoot)
    .map((entry) => readLibraryEntry(store, aiRoot, entry.id));
}

function writeExclusive(file: string, bytes: Buffer): void {
  const fd = openSync(
    file,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function writeArchive(file: string, bytes: Buffer): void {
  try {
    writeExclusive(file, bytes);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "EEXIST" ||
      hash(
        readOwnedArtifactSync({ path: file } as Artifact, path.dirname(file)),
      ) !== hash(bytes)
    )
      throw error;
  }
}

export async function collectArtifact(
  store: Store,
  aiRoot: string,
  input: CollectInput,
): Promise<LibraryEntry> {
  const rootPath = activeRoot(store, aiRoot);
  const task = store.task(input.taskId),
    artifact = task.artifacts.find((entry) => entry.id === input.artifactId);
  if (!artifact) throw new Error("找不到要收藏的成果。");
  const bytes = readOwnedArtifactSync(artifact, task.workspace),
    digest = hash(bytes);
  if (digest !== input.expectedHash)
    throw new Error("成果已改变，请刷新后再收藏。");
  const source: LibraryEntry["source"] = {
    taskId: task.id,
    taskTitle: task.title,
    artifactId: artifact.id,
    artifactVersion: artifact.version,
    artifactHash: digest,
    goalVersion: artifact.goalVersion,
  };
  const key = collectionKey(source),
    prior = store.collectedEntry(aiRoot, key);
  if (prior) return existingCollection(store, aiRoot, prior);
  await ensureOwnedDirectory(rootPath);
  // The path stored in the registry is anchored to the configured root, including a permitted macOS /tmp alias.
  const id = uid(),
    savedAt = now();
  const entry: LibraryEntry = {
    id,
    ...metadata(input, { title: artifact.title, tags: [], note: "" }),
    path: path.join(rootPath, `${id}.${artifact.format}`),
    format: artifact.format,
    hash: digest,
    version: 1,
    savedAt,
    updatedAt: savedAt,
    source,
    versions: [],
  };
  const versionRoot = path.join(rootPath, ".versions", id);
  await ensureOwnedDirectory(versionRoot);
  activeRoot(store, aiRoot);
  // Two requests can prepare directories concurrently. The first completed collection wins.
  const raced = store.collectedEntry(aiRoot, key);
  if (raced) return existingCollection(store, aiRoot, raced);
  const current = store
    .task(task.id)
    .artifacts.find((a) => a.id === artifact.id);
  if (
    !current ||
    current.version !== artifact.version ||
    current.hash !== artifact.hash ||
    hash(readOwnedArtifactSync(current, task.workspace)) !== digest
  )
    throw new Error("成果在收藏时发生改变，请刷新后重试。");
  const archive = path.join(versionRoot, `1.${entry.format}`);
  entry.versions.push({
    version: 1,
    hash: digest,
    path: archive,
    createdAt: savedAt,
    summary: "明确收藏为可复用资产；保留原成果来源",
  });
  return commitLibrary(store, aiRoot, entry, bytes, undefined, key);
}

export async function saveLibraryEntry(
  store: Store,
  aiRoot: string,
  input: SaveInput,
): Promise<LibraryEntry> {
  const rootPath = activeRoot(store, aiRoot),
    previous = store.libraryEntry(aiRoot, input.entryId);
  validatePath(previous, rootPath);
  if (!["md", "html"].includes(previous.format))
    throw new Error("媒体收藏不能直接文本编辑，请修改源文档后重新导出。");
  if (
    typeof input.content !== "string" ||
    !input.content.trim() ||
    Buffer.byteLength(input.content) > 20 * 1024 * 1024
  )
    throw new Error("收藏正文为空或过大。");
  const original = readLibraryBytes(store, aiRoot, previous.id),
    currentHash = hash(original);
  if (currentHash !== input.expectedHash)
    throw new Error("收藏已在其他地方修改，请刷新后再保存。");
  const external = currentHash !== previous.hash;
  const version = previous.version + (external ? 2 : 1),
    updatedAt = now(),
    revisionId = uid();
  const versionRoot = path.join(rootPath, ".versions", previous.id);
  await ensureOwnedDirectory(versionRoot);
  activeRoot(store, aiRoot);
  const bytes = Buffer.from(input.content),
    digest = hash(bytes);
  const entry: LibraryEntry = {
    ...previous,
    ...metadata(input, previous),
    version,
    hash: digest,
    updatedAt,
    versions: [
      ...previous.versions,
      ...(external
        ? [
            {
              version: version - 1,
              hash: currentHash,
              path: path.join(
                versionRoot,
                `${version - 1}-${revisionId}.${previous.format}`,
              ),
              createdAt: updatedAt,
              summary: "外部修改（修订前保留）",
            },
          ]
        : []),
      {
        version,
        hash: digest,
        path: path.join(
          versionRoot,
          `${version}-${revisionId}.${previous.format}`,
        ),
        createdAt: updatedAt,
        summary: "编辑收藏副本；原成果保持来源版本",
      },
    ],
  };
  const resolvedIds = [...new Set(input.resolvedFeedbackIds ?? [])];
  if (resolvedIds.length) {
    const feedback = store.libraryFeedback(aiRoot, entry.id);
    if (
      digest === currentHash ||
      resolvedIds.some(
        (id) =>
          !feedback.some((item) => item.id === id && item.kind !== "useful"),
      )
    )
      throw new Error("请实际修订正文，并仅确认这项资产已有的修正或失败反馈。");
    entry.feedbackResolutions = [
      ...(previous.feedbackResolutions ?? []),
      ...resolvedIds
        .filter(
          (id) =>
            !previous.feedbackResolutions?.some(
              (item) => item.feedbackId === id,
            ),
        )
        .map((feedbackId) => ({ feedbackId, version, hash: digest })),
    ];
  }
  return commitLibrary(
    store,
    aiRoot,
    entry,
    bytes,
    { previous, expectedHash: input.expectedHash, original },
    collectionKey(previous.source),
  );
}

function commitLibrary(
  store: Store,
  aiRoot: string,
  entry: LibraryEntry,
  bytes: Buffer,
  revision:
    | { previous: LibraryEntry; expectedHash: string; original: Buffer }
    | undefined,
  key: string,
): LibraryEntry {
  const rootPath = activeRoot(store, aiRoot);
  validatePath(entry, rootPath);
  assertLibraryChain(rootPath);
  const root = realpathSync(rootPath),
    identity = lstatSync(root);
  const operationId = uid(),
    temp = path.join(rootPath, `.write-${operationId}`);
  const operation: LibraryOperation = {
    state: "prepared",
    entry,
    collectionKey: key,
    expectedVersion: revision?.previous.version ?? 0,
  };
  store.libraryOperation(operationId, aiRoot, operation);
  try {
    if (revision) {
      const current = store.libraryEntry(aiRoot, entry.id);
      if (
        current.version !== revision.previous.version ||
        current.hash !== revision.previous.hash ||
        hash(readLibraryBytes(store, aiRoot, entry.id)) !==
          revision.expectedHash
      )
        throw new Error("收藏已被其他操作修改，请刷新后再保存。");
    } else if (existsSync(entry.path))
      throw new Error("收藏路径已被未知文件占用，已保留原文件。");
    for (const version of entry.versions.filter(
      (v) => v.version > (revision?.previous.version ?? 0),
    )) {
      assertLibraryChain(path.dirname(version.path));
      const archiveBytes =
        version.hash === entry.hash ? bytes : revision!.original;
      writeArchive(version.path, archiveBytes);
    }
    writeExclusive(temp, bytes);
    // No await between the final file/version checks, rename, and database update.
    activeRoot(store, aiRoot);
    assertLibraryChain(rootPath);
    const finalIdentity = lstatSync(rootPath);
    if (
      finalIdentity.isSymbolicLink() ||
      identity.ino !== finalIdentity.ino ||
      identity.dev !== finalIdentity.dev ||
      realpathSync(rootPath) !== root
    )
      throw new Error("Lib 目录已改变，未写入收藏。");
    if (revision) {
      if (
        hash(readLibraryBytes(store, aiRoot, entry.id)) !==
        revision.expectedHash
      )
        throw new Error("收藏在保存时被外部修改，请刷新。");
    } else {
      // Reading the archive validates every parent, including replacement links, before committing a new file.
      readOwnedArtifactSync(
        { path: entry.versions[0]!.path } as Artifact,
        path.dirname(entry.versions[0]!.path),
      );
      if (existsSync(entry.path)) throw new Error("收藏路径已被其他文件占用。");
    }
    renameSync(temp, entry.path);
    store.saveLibrary(aiRoot, entry, key);
    store.libraryOperation(operationId, aiRoot, {
      ...operation,
      state: "committed",
    });
    return readLibraryEntry(store, aiRoot, entry.id);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      /* Keep the original failure; recovery never overwrites files. */
    }
    store.libraryOperation(operationId, aiRoot, {
      ...operation,
      state: "needs-check",
    });
    throw error;
  }
}

export async function recoverLibrary(
  store: Store,
  aiRoot: string,
): Promise<void> {
  const root = activeRoot(store, aiRoot);
  for (const record of store.libraryOperations(aiRoot)) {
    const operation = record.data as unknown as LibraryOperation;
    if (!["prepared", "needs-check"].includes(operation.state)) continue;
    const entry = operation.entry;
    try {
      validatePath(entry, root);
      const current = store
        .library(aiRoot)
        .find((item) => item.id === entry.id);
      if (
        current &&
        (current.version > entry.version ||
          (current.version === entry.version && current.hash !== entry.hash))
      ) {
        store.libraryOperation(record.id, aiRoot, {
          ...operation,
          state: "superseded",
        });
        continue;
      }
      const data = readOwnedArtifactSync(asArtifact(entry), root);
      if (
        hash(data) !== entry.hash ||
        (current &&
          ![entry.version, operation.expectedVersion].includes(current.version))
      )
        throw new Error("收藏需要手动核查。");
      if (!current || current.version < entry.version)
        store.saveLibrary(aiRoot, entry, operation.collectionKey);
      store.libraryOperation(record.id, aiRoot, {
        ...operation,
        state: "committed",
      });
    } catch {
      // Interrupted writes are reconciled from committed bytes; unknown/external files are never overwritten.
      store.libraryOperation(record.id, aiRoot, {
        ...operation,
        state: "abandoned",
      });
    }
  }
}

export function librarySource(
  store: Store,
  aiRoot: string,
  entryId: string,
): Source {
  const entry = readLibraryEntry(store, aiRoot, entryId),
    bytes = readLibraryBytes(store, aiRoot, entryId),
    digest = hash(bytes);
  const provenance = `Lib：${entry.id}，收藏版本 ${entry.version}，当前内容哈希 ${digest}。\n原任务：${entry.source.taskTitle}（${entry.source.taskId}）；原成果 ${entry.source.artifactId} 第 ${entry.source.artifactVersion} 版。`;
  const textual = ["md", "html"].includes(entry.format);
  const source = textSource(
    entry.title,
    textual
      ? bytes.toString("utf8")
      : `${provenance}\n媒体文件：${entry.path}\n格式：${entry.format}。仅引用此本地媒体，尚未解析图片或幻灯片内容；请让用户提供文字描述，或导入对应的源文档后分析。`,
    "file",
    entry.path,
  );
  source.coverage = `${textual ? "收藏正文快照" : "仅媒体引用，未解析内容"}；${provenance}`;
  source.library = {
    root: path.resolve(aiRoot),
    entryId,
    version: entry.version,
    hash: digest,
    feedbackRevision: entry.feedbackRevision ?? 0,
    feedback: entry.feedback ?? [],
    resolvedFeedbackIds:
      entry.feedbackResolutions?.map((item) => item.feedbackId) ?? [],
    assessment: libraryAssessment(entry),
    selection: "explicit",
    reason: "用户选入本项工作的 Lib 资产",
  };
  source.coverage += `\n${LIBRARY_ASSESSMENT_LABELS[source.library.assessment]}；${source.library.feedbackRevision} 条使用或修正反馈。收藏和模型阅读均不代表能力已验证。`;
  return source;
}

/** Adopt only previously saved Lib snapshots with a verifiable path, version and content hash. */
export function migrateLibrarySources(store: Store, aiRoot: string): void {
  activeRoot(store, aiRoot);
  const entries = new Map(
    store.library(aiRoot).map((entry) => [entry.path, entry]),
  );
  for (const task of store.tasks()) {
    if (task.surface === "background") continue;
    let changed = false;
    for (const source of task.sources) {
      if (source.library || source.type !== "file") continue;
      const entry = entries.get(source.location);
      if (
        !entry ||
        !source.coverage.startsWith(`收藏正文快照；Lib：${entry.id}，`)
      )
        continue;
      const version = Number(source.coverage.match(/收藏版本 (\d+)/)?.[1]),
        digest = hash(source.text);
      if (
        !entry.versions.some(
          (record) => record.version === version && record.hash === digest,
        )
      )
        continue;
      source.library = {
        root: path.resolve(aiRoot),
        entryId: entry.id,
        version,
        hash: digest,
        feedbackRevision: 0,
        feedback: [],
        resolvedFeedbackIds: [],
        assessment: "unverified",
        selection: "explicit",
        reason: "此前由用户选入这项工作的 Lib 正文快照",
      };
      changed = true;
    }
    if (changed) store.saveTask(task);
  }
}

/** Only an explicit user command writes feedback; model tools have no access to this mutation. */
export function recordLibraryFeedback(
  store: Store,
  aiRoot: string,
  input: Extract<Command, { type: "library.feedback" }>,
): LibraryFeedback {
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const feedback = recordFeedback(store, aiRoot, input);
    store.db.exec("COMMIT");
    return feedback;
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}
function recordFeedback(
  store: Store,
  aiRoot: string,
  input: Extract<Command, { type: "library.feedback" }>,
): LibraryFeedback {
  activeRoot(store, aiRoot);
  const entry = store.libraryEntry(aiRoot, input.entryId);
  const feedback = store.libraryFeedback(aiRoot, entry.id);
  const fields = {
    note: input.note.trim(),
    purpose: input.purpose.trim(),
    conditions: input.conditions.trim(),
    evidence: input.evidence.trim(),
  };
  if (
    !/^[a-f0-9-]{36}$/i.test(input.feedbackId) ||
    !["correction", "useful", "failed"].includes(input.kind) ||
    !fields.note ||
    fields.note.length > 4000 ||
    fields.purpose.length > 1000 ||
    fields.conditions.length > 2000 ||
    fields.evidence.length > 4000 ||
    (input.kind !== "correction" &&
      (!fields.purpose || !fields.conditions || !fields.evidence))
  )
    throw new Error("请填写反馈；使用结果还需要实际用途、适用条件与观察依据。");
  const prior = feedback.find((item) => item.id === input.feedbackId);
  if (prior) {
    if (
      prior.kind !== input.kind ||
      prior.targetHash !== input.expectedHash ||
      prior.targetVersion !== input.expectedVersion ||
      Object.entries(fields).some(
        ([key, value]) => prior[key as keyof typeof fields] !== value,
      ) ||
      prior.outcome?.taskId !== input.taskId ||
      prior.outcome?.sourceId !== input.sourceId ||
      prior.outcome?.artifactId !== input.artifactId ||
      prior.outcome?.artifactHash !== input.expectedArtifactHash ||
      prior.outcome?.artifactVersion !== input.expectedArtifactVersion
    )
      throw new Error("同一反馈请求不能改写已经记录的内容。");
    return prior;
  }
  if (feedback.length !== input.expectedFeedbackRevision)
    throw new Error("反馈已有更新，请核对后再次提交，输入仍保留。");
  let outcome: LibraryFeedback["outcome"];
  if (
    Boolean(input.artifactId) !== Boolean(input.expectedArtifactHash) ||
    Boolean(input.artifactId) !== Boolean(input.expectedArtifactVersion)
  )
    throw new Error("请选择要反馈的具体成果版本。");
  if (input.taskId && input.sourceId) {
    const task = store.task(input.taskId);
    const source = task.sources.find((item) => item.id === input.sourceId);
    if (
      !source?.library ||
      source.library.root !== path.resolve(aiRoot) ||
      source.library.entryId !== entry.id ||
      source.library.hash !== input.expectedHash ||
      source.library.version !== input.expectedVersion
    )
      throw new Error(
        "所选工作没有使用这个 Lib 版本，不能把反馈归到其他资产。",
      );
    const artifact = input.artifactId
      ? task.artifacts.find((item) => item.id === input.artifactId)
      : undefined;
    if (input.artifactId && !artifact)
      throw new Error("反馈对应的成果不存在。");
    if (
      artifact &&
      (artifact.hash !== input.expectedArtifactHash ||
        artifact.version !== input.expectedArtifactVersion)
    )
      throw new Error("对应成果版本已改变，请核对后重新选择。");
    if (
      artifact &&
      hash(readOwnedArtifactSync(artifact, task.workspace)) !== artifact.hash
    )
      throw new Error("对应成果已有外部修改，请先保存并核对成果版本。");
    outcome = {
      taskId: task.id,
      taskTitle: task.title,
      sourceId: source.id,
      ...(artifact
        ? {
            artifactId: artifact.id,
            artifactTitle: artifact.title,
            artifactVersion: artifact.version,
            artifactHash: artifact.hash,
          }
        : {}),
    };
  } else {
    if (input.taskId || input.sourceId || input.artifactId)
      throw new Error("使用反馈缺少对应工作和资料。");
    if (
      entry.version !== input.expectedVersion ||
      hash(readLibraryBytes(store, aiRoot, entry.id)) !== input.expectedHash
    )
      throw new Error("收藏版本已改变，请核对后重新记录反馈。");
  }
  const record: LibraryFeedback = {
    id: input.feedbackId,
    entryId: entry.id,
    kind: input.kind,
    ...fields,
    targetVersion: input.expectedVersion,
    targetHash: input.expectedHash,
    createdAt: now(),
    ...(outcome ? { outcome } : {}),
  };
  store.appendLibraryFeedback(aiRoot, record);
  return record;
}
