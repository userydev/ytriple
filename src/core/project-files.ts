import { constants, promises as fs } from "node:fs";
import path from "node:path";
import type { ProjectInfo } from "../shared/types.js";
import type {
  ProjectBrowserState,
  ProjectFileEntry,
} from "../shared/project-files.js";

const MAX_ENTRIES = 400;
const MAX_TEXT_BYTES = 192 * 1024;
const SKIP = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  "target",
  "coverage",
  "__pycache__",
  "venv",
  "env",
  "secrets",
  "credentials",
  "keys",
]);
const TEXT = new Set([
  ".md",
  ".markdown",
  ".mdx",
  ".txt",
  ".json",
  ".jsonc",
  ".jsonl",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".xml",
  ".csv",
  ".tsv",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".css",
  ".scss",
  ".html",
  ".htm",
  ".svg",
  ".vue",
  ".svelte",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".sql",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".rb",
  ".php",
  ".ex",
  ".exs",
  ".graphql",
  ".gql",
  ".proto",
  ".prisma",
  ".lock",
  ".log",
]);
const TEXT_NAMES = new Set([
  "readme",
  "license",
  "copying",
  "makefile",
  "dockerfile",
  "justfile",
]);

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}
function visible(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    !name.startsWith(".") &&
    !SKIP.has(lower) &&
    !/(?:^|[._-])(?:secret|secrets|credential|credentials|token|tokens|api[_-]?key|private[_-]?key|password|passwords|id_rsa|id_ed25519)(?:[._-]|$)/i.test(
      name,
    ) &&
    !/\.(?:pem|key|p12|pfx|kdbx|keystore)$/i.test(name) &&
    !/^keys?(?:[._-]|$)/i.test(name)
  );
}
function relativePath(value: string): string {
  if (
    value.length > 2048 ||
    path.isAbsolute(value) ||
    value.includes("\\") ||
    /[\x00-\x1f]/.test(value)
  )
    throw new Error("请选择项目文件树中的路径。");
  const parts = value.split("/").filter(Boolean);
  if (
    parts.length > 24 ||
    parts.some((part) => part === "." || part === ".." || !visible(part))
  )
    throw new Error("该路径不在可预览范围内。");
  return parts.join("/");
}
async function checkedChain(file: string): Promise<void> {
  const resolved = path.resolve(file);
  let current = path.parse(resolved).root;
  for (const segment of resolved
    .slice(current.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, segment);
    const info = await fs.lstat(current);
    if (info.isSymbolicLink()) {
      // macOS supplies these system aliases; user-created links remain excluded.
      const systemAlias =
        process.platform === "darwin" &&
        ["/tmp", "/var", "/etc"].includes(current) &&
        (await fs.realpath(current)) === "/private" + current;
      if (!systemAlias) throw new Error("为保持项目边界，不预览符号链接。");
    }
  }
}
async function worktree(
  project: ProjectInfo,
  codeRoot: string,
  requested?: string,
): Promise<string> {
  const selected = requested ?? project.devPath;
  const allowed = [
    project.devPath,
    ...(project.observation?.worktrees.map((item) => item.path) ?? []),
  ];
  if (
    !path.isAbsolute(selected) ||
    !allowed.some((item) => path.resolve(item) === path.resolve(selected))
  )
    throw new Error("工作目录不属于当前项目。");
  const root = path.resolve(project.imported ? project.root : codeRoot),
    location = path.resolve(selected);
  if (!inside(root, location) || !inside(path.resolve(project.root), location))
    throw new Error("项目目录不在配置的 Code 范围内。");
  await checkedChain(location);
  if (!(await fs.stat(location)).isDirectory())
    throw new Error("项目工作目录不可读取。");
  return location;
}
function userError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT" || code === "ENOTDIR")
    return "目录或文件已不存在，请刷新后重新选择。";
  if (code === "EACCES" || code === "EPERM")
    return "没有读取该文件或目录的权限。";
  return error instanceof Error && !code
    ? error.message
    : "读取失败，请刷新后重试。";
}

export class ProjectFiles {
  async browse(
    project: ProjectInfo,
    codeRoot: string,
    worktreePath?: string,
    directory = "",
  ): Promise<ProjectBrowserState> {
    const state: ProjectBrowserState = {
      projectId: project.id,
      worktreePath: worktreePath ?? project.devPath,
      directory,
      entries: [],
      truncated: false,
    };
    try {
      state.directory = relativePath(directory);
      state.worktreePath = await worktree(project, codeRoot, worktreePath);
      const location = path.join(state.worktreePath, state.directory);
      await checkedChain(location);
      const directoryHandle = await fs.opendir(location);
      let seen = 0;
      try {
        for await (const entry of directoryHandle) {
          // Count every entry, including excluded names, to bound work on huge directories.
          if (++seen > MAX_ENTRIES) {
            state.truncated = true;
            break;
          }
          if (
            !visible(entry.name) ||
            entry.isSymbolicLink() ||
            (!entry.isDirectory() && !entry.isFile())
          )
            continue;
          state.entries.push({
            name: entry.name,
            path: [state.directory, entry.name].filter(Boolean).join("/"),
            kind: entry.isDirectory() ? "directory" : "file",
          });
        }
      } finally {
        // The async iterator closes automatically, including on break.
        await directoryHandle.close().catch(() => {});
      }
      state.entries.sort(
        (left, right) =>
          (left.kind === right.kind ? 0 : left.kind === "directory" ? -1 : 1) ||
          left.name.localeCompare(right.name, "zh-CN", { numeric: true }),
      );
      await checkedChain(location);
    } catch (error) {
      state.entries = [];
      state.error = userError(error);
    }
    return state;
  }

  async read(
    project: ProjectInfo,
    codeRoot: string,
    worktreePath: string | undefined,
    file: string,
  ): Promise<ProjectBrowserState> {
    let relative = "";
    try {
      relative = relativePath(file);
    } catch (error) {
      return {
        projectId: project.id,
        worktreePath: worktreePath ?? project.devPath,
        directory: "",
        entries: [],
        truncated: false,
        error: userError(error),
      };
    }
    const directory = relative.split("/").slice(0, -1).join("/");
    const state = await this.browse(project, codeRoot, worktreePath, directory);
    if (state.error) return state;
    try {
      if (!relative) throw new Error("请选择要查看的文件。");
      const location = path.join(state.worktreePath, relative);
      await checkedChain(location);
      const handle = await fs.open(
        location,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.nlink > 1)
          throw new Error("仅预览普通项目文件，链接与特殊文件已跳过。");
        await checkedChain(location);
        const current = await fs.lstat(location);
        if (current.ino !== info.ino || current.dev !== info.dev)
          throw new Error("文件读取期间发生变化，请重新选择。");
        const name = path.basename(relative),
          extension = path.extname(name).toLowerCase();
        state.preview = {
          path: relative,
          name,
          bytes: info.size,
          modifiedAt: info.mtime.toISOString(),
          format: "unsupported",
          truncated: false,
        };
        if (!TEXT.has(extension) && !TEXT_NAMES.has(name.toLowerCase())) {
          state.preview.reason =
            "此格式暂不支持项目内预览，可在本地目录中打开。";
          return state;
        }
        const buffer = Buffer.alloc(Math.min(info.size, MAX_TEXT_BYTES + 1));
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
          const chunk = await handle.read(
            buffer,
            bytesRead,
            buffer.length - bytesRead,
            bytesRead,
          );
          if (!chunk.bytesRead) break;
          bytesRead += chunk.bytesRead;
        }
        const bytes = buffer.subarray(0, Math.min(bytesRead, MAX_TEXT_BYTES));
        let content: string;
        try {
          // Streaming avoids a partial final UTF-8 character when a large file is truncated.
          content = new TextDecoder("utf-8", { fatal: true }).decode(bytes, {
            stream: info.size > MAX_TEXT_BYTES,
          });
        } catch {
          state.preview.reason = "文件不是 UTF-8 文本，暂不支持预览。";
          return state;
        }
        if (content.includes("\0")) {
          state.preview.reason = "这是二进制文件，暂不支持文本预览。";
          return state;
        }
        const after = await handle.stat();
        if (after.mtimeMs !== info.mtimeMs || after.size !== info.size)
          throw new Error("文件读取期间发生变化，请重新选择。");
        state.preview.format = [".md", ".markdown"].includes(extension)
          ? "markdown"
          : "text";
        state.preview.content = content;
        state.preview.truncated = info.size > MAX_TEXT_BYTES;
      } finally {
        await handle.close();
      }
    } catch (error) {
      state.preview = undefined;
      state.error = userError(error);
    }
    return state;
  }
}
