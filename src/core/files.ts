import {
  promises as fs,
  readFileSync,
  renameSync,
  lstatSync,
  realpathSync,
  openSync,
  closeSync,
  fstatSync,
  existsSync,
  constants,
} from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Artifact, Source } from "../shared/types.js";
import { Store, now, uid } from "./store.js";

export const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export function within(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    rel === "" ||
    (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel))
  );
}
export async function ensureOwnedDirectory(root: string): Promise<string> {
  assertDirectoryChain(root, true);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  assertDirectoryChain(root);
  return realpathSync(root);
}

function assertDirectoryChain(directory: string, allowMissing = false): void {
  for (let p = path.resolve(directory); ; p = path.dirname(p)) {
    try {
      const stat = lstatSync(p);
      if (stat.isSymbolicLink()) {
        // macOS system aliases are fixed; user-created links are never an ownership boundary.
        if (!(
          process.platform === "darwin" &&
          ["/var", "/tmp", "/etc"].includes(p) &&
          realpathSync(p) === "/private" + p
        ))
          throw new Error("工作目录经过符号链接，请选择实际目录。");
      } else if (!stat.isDirectory()) throw new Error("工作路径不是目录。");
    } catch (error) {
      if (!(allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT"))
        throw error;
    }
    if (p === path.dirname(p)) break;
  }
}
const sameIdentity = (
  a: { dev: number; ino: number },
  b: { dev: number; ino: number },
) => a.dev === b.dev && a.ino === b.ino;

/** Checks both the directory and opened inode; no caller may bypass this to hydrate model input. */
export function readOwnedArtifactSync(
  artifact: Artifact,
  workspace: string,
): Buffer {
  assertDirectoryChain(workspace);
  const root = realpathSync(workspace);
  const parent = path.dirname(path.resolve(artifact.path));
  if (parent !== path.resolve(workspace) && parent !== root)
    throw new Error("成果路径无效。");
  assertDirectoryChain(parent);
  if (realpathSync(parent) !== root) throw new Error("成果目录已经改变。");
  const directory = openSync(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let file: number | undefined;
  try {
    const directoryBefore = fstatSync(directory);
    if (!directoryBefore.isDirectory()) throw new Error("成果目录不可读取。");
    file = openSync(artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(file);
    if (!before.isFile() || before.size > 20 * 1024 * 1024)
      throw new Error("成果不可读取。");
    const content = readFileSync(file);
    const after = fstatSync(file),
      finalPath = lstatSync(artifact.path);
    assertDirectoryChain(workspace);
    assertDirectoryChain(parent);
    if (
      realpathSync(workspace) !== root ||
      !sameIdentity(directoryBefore, lstatSync(root)) ||
      finalPath.isSymbolicLink() ||
      !sameIdentity(before, finalPath) ||
      !sameIdentity(before, after) ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("成果或工作目录在读取时发生改变，请刷新。");
    return content;
  } finally {
    if (file !== undefined) closeSync(file);
    closeSync(directory);
  }
}
type ArtifactInput = {
  title: string;
  content: string;
  format: "md" | "html";
  goalVersion: number;
  artifactId?: string;
  expectedHash?: string;
  operationId?: string;
};
export async function writeArtifact(
  store: Store,
  taskId: string,
  input: ArtifactInput,
): Promise<Artifact> {
  return writeArtifactData(store, taskId, input);
}
export async function writeArtifactData(
  store: Store,
  taskId: string,
  input: Omit<ArtifactInput, "content" | "format"> & {
    content: string | Buffer;
    format: Artifact["format"];
  },
): Promise<Artifact> {
  const task = store.task(taskId);
  if (task.goalVersion !== input.goalVersion)
    throw new Error("目标已经更新，旧任务的成果不会写入。");
  if (input.operationId) {
    const prior = store.getOperation(input.operationId);
    if (prior && prior.taskId !== taskId)
      throw new Error("操作不属于当前任务。");
    if (prior?.data.state === "committed") {
      const saved = prior.data.artifact as Artifact;
      const current = task.artifacts.find((a) => a.id === saved.id);
      if (!current) throw new Error("已完成操作的成果记录缺失。");
      return hydrateArtifact(current, task.workspace);
    }
  }
  if (
    !(typeof input.content === "string"
      ? input.content.trim()
      : input.content.length)
  )
    throw new Error("成果内容不能为空。");
  if (Buffer.byteLength(input.content) > 20 * 1024 * 1024)
    throw new Error("成果过大，请拆成多个文档。");
  const root = await ensureOwnedDirectory(task.workspace);
  const rootIdentity = lstatSync(root);
  const existing = input.artifactId
    ? task.artifacts.find((a) => a.id === input.artifactId)
    : undefined;
  if (input.artifactId && !existing) throw new Error("找不到要修订的成果。");
  if (existing && existing.format !== input.format)
    throw new Error("修订不能改变成果格式。");
  const id = existing?.id ?? uid();
  const destination =
    existing?.path ?? path.join(root, `${id}.${input.format}`);
  if (!within(root, destination) || path.dirname(destination) !== root)
    throw new Error("成果路径不在当前工作目录中。");
  const expectedHash = input.expectedHash ?? existing?.hash;
  let oldContent: Buffer | undefined;
  try {
    const stat = await fs.lstat(destination);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("成果路径已被其他文件占用。");
    oldContent = readOwnedArtifactSync(
      { path: destination } as Artifact,
      task.workspace,
    );
    if (!expectedHash || hash(oldContent) !== expectedHash)
      throw new Error("文档已在其他地方修改，请刷新后再保存。");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    else if (existing)
      throw new Error("原成果文件已丢失，不能直接覆盖原版本。");
  }
  const externalChange = !!(
    existing &&
    oldContent &&
    hash(oldContent) !== existing.hash
  );
  const version = (existing?.version ?? 0) + (externalChange ? 2 : 1);
  const nextHash = hash(input.content);
  const versionRoot = path.join(root, ".versions", id);
  await ensureOwnedDirectory(path.join(root, ".versions"));
  await ensureOwnedDirectory(versionRoot);
  const opId = input.operationId ?? uid();
  const archive = path.join(
    versionRoot,
    `${version}-${hash(opId).slice(0, 16)}.${input.format}`,
  );
  const externalArchive = externalChange
    ? path.join(
        versionRoot,
        `${version - 1}-${hash(opId + ":external").slice(0, 16)}.${input.format}`,
      )
    : undefined;
  const tmp = path.join(root, `.write-${randomUUID()}`);
  const artifact: Artifact = {
    id,
    title: input.title.slice(0, 160),
    path: destination,
    format: input.format,
    version,
    hash: nextHash,
    goalVersion: input.goalVersion,
    updatedAt: now(),
    versions: [
      ...(existing?.versions ?? []),
      ...(externalArchive && oldContent
        ? [
            {
              version: version - 1,
              hash: hash(oldContent),
              path: externalArchive,
              createdAt: now(),
              summary: "外部修改（修订前保留）",
            },
          ]
        : []),
      {
        version,
        hash: nextHash,
        path: archive,
        createdAt: now(),
        summary: existing ? "更新文档" : "创建成果",
      },
    ],
  };
  const operation = {
    goalVersion: input.goalVersion,
    expectedVersion: existing?.version ?? 0,
    destination,
    archive,
    externalArchive,
    artifact,
  };
  store.operation(opId, taskId, { ...operation, state: "prepared" });
  try {
    await fs.writeFile(tmp, input.content, { flag: "wx", mode: 0o600 });
    if (externalArchive && oldContent) {
      await fs
        .writeFile(externalArchive, oldContent, { flag: "wx", mode: 0o600 })
        .catch((error) => {
          if (
            error.code !== "EEXIST" ||
            hash(
              readOwnedArtifactSync(
                { path: externalArchive } as Artifact,
                versionRoot,
              ),
            ) !== hash(oldContent!)
          )
            throw error;
        });
    }
    await fs
      .writeFile(archive, input.content, { flag: "wx", mode: 0o600 })
      .catch(async (error) => {
        if (
          error.code !== "EEXIST" ||
          hash(
            readOwnedArtifactSync({ path: archive } as Artifact, versionRoot),
          ) !== nextHash
        )
          throw error;
      });
    // Keep the final goal/file check and commit in one event-loop turn.
    if (existing) {
      const current = readOwnedArtifactSync(existing, task.workspace);
      if (hash(current) !== expectedHash)
        throw new Error("文档已被其他操作修改，请重试。");
    }
    if (!existing && existsSync(destination))
      throw new Error("成果路径已被其他文件占用。");
    assertDirectoryChain(task.workspace);
    if (
      realpathSync(task.workspace) !== root ||
      !sameIdentity(rootIdentity, lstatSync(root))
    )
      throw new Error("工作目录已经改变，未写入成果。");
    const currentTask = store.task(taskId),
      currentArtifact = currentTask.artifacts.find((a) => a.id === id);
    if (currentTask.goalVersion !== input.goalVersion)
      throw new Error("目标已经更新，旧任务的成果不会写入。");
    if (
      existing &&
      (!currentArtifact ||
        currentArtifact.version !== existing.version ||
        currentArtifact.hash !== existing.hash)
    )
      throw new Error("成果版本已被其他操作更新，请刷新后再保存。");
    renameSync(tmp, destination);
    store.updateTask(taskId, (current) => {
      current.artifacts = [
        ...current.artifacts.filter((a) => a.id !== id),
        artifact,
      ];
    });
    store.operation(opId, taskId, { ...operation, state: "committed" });
    return typeof input.content === "string"
      ? { ...artifact, content: input.content }
      : artifact;
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    store.operation(opId, taskId, { ...operation, state: "needs-check" });
    throw error;
  }
}
export async function recoverArtifacts(store: Store): Promise<void> {
  for (const op of store.operations()) {
    if (
      op.data.state === "committed" ||
      op.data.state === "abandoned" ||
      op.data.state === "superseded"
    )
      continue;
    const artifact = op.data.artifact as Artifact | undefined;
    if (!artifact) continue;
    let task;
    try {
      task = store.task(op.taskId);
    } catch {
      continue;
    }
    const current = task.artifacts.find((a) => a.id === artifact.id);
    if (
      current &&
      (current.version > artifact.version ||
        (current.version === artifact.version &&
          current.hash !== artifact.hash))
    ) {
      store.operation(op.id, task.id, { ...op.data, state: "superseded" });
      continue;
    }
    const workspace = await fs
      .realpath(task.workspace)
      .catch(() => task.workspace);
    if (
      !within(workspace, artifact.path) &&
      !within(task.workspace, artifact.path)
    )
      continue;
    const content = await readOwnedArtifact(artifact, task.workspace).catch(
      () => null,
    );
    const expectedVersion =
      typeof op.data.expectedVersion === "number"
        ? op.data.expectedVersion
        : artifact.version - 1;
    const canAdvance =
      !current ||
      current.version === artifact.version ||
      current.version === expectedVersion;
    if (
      content &&
      hash(content) === artifact.hash &&
      task.goalVersion === artifact.goalVersion &&
      canAdvance
    ) {
      // A persisted equal/newer revision wins over an older operation journal, even if bytes match.
      if (!current || current.version < artifact.version)
        store.updateTask(task.id, (t) => {
          t.artifacts = [
            ...t.artifacts.filter((a) => a.id !== artifact.id),
            artifact,
          ];
        });
      store.operation(op.id, task.id, { ...op.data, state: "committed" });
    } else {
      store.event(task.id, {
        type: "artifact.recovery",
        goalVersion: task.goalVersion,
        summary: "有一项未完成的文档写入需要核查，已有文件已保留。",
      });
      store.operation(op.id, task.id, { ...op.data, state: "abandoned" });
    }
  }
}
export async function readOwnedArtifact(
  artifact: Artifact,
  workspace: string,
): Promise<Buffer> {
  return readOwnedArtifactSync(artifact, workspace);
}
export async function hydrateArtifact(
  artifact: Artifact,
  workspace: string,
): Promise<Artifact> {
  return hydrateArtifactSync(artifact, workspace);
}
export function hydrateArtifactSync(
  artifact: Artifact,
  workspace: string,
): Artifact {
  if (artifact.format !== "md" && artifact.format !== "html") return artifact;
  const { content: _content, readError: _readError, ...metadata } = artifact;
  try {
    const bytes = readOwnedArtifactSync(artifact, workspace),
      content = bytes.toString("utf8");
    // Snapshot only observes the actual file. It never adopts external edits into the database.
    return { ...metadata, content, hash: hash(bytes) };
  } catch {
    return {
      ...metadata,
      readError: "无法读取成果文件，请检查文件或工作目录是否已移动。",
    };
  }
}
export function textSource(
  title: string,
  text: string,
  type: Source["type"] = "text",
  location = "用户提供",
): Source {
  if (!text.trim()) throw new Error("资料内容为空。");
  if (Buffer.byteLength(text) > 2 * 1024 * 1024)
    throw new Error("资料过大，请拆成较小部分导入。");
  return {
    id: uid(),
    title: title.slice(0, 200),
    text,
    type,
    location,
    addedAt: now(),
    coverage: "正文文本",
  };
}
