import { readdir, readFile, stat } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import type { WorkspaceFileRead, WorkspaceSummary, WorkspaceTextMatch } from "./types";

const DEFAULT_EXCLUDES = [
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
] as const;

const TEXT_EXTENSIONS = new Set([".md", ".txt", ".json", ".yaml", ".yml"]);

export interface ListWorkspaceFilesInput {
  workspaceRoot: string;
  maxResults?: number;
}

export interface ReadWorkspaceFileInput {
  workspaceRoot: string;
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface SearchWorkspaceTextInput {
  workspaceRoot: string;
  query: string;
  maxResults?: number;
}

export async function listWorkspaceFiles({
  workspaceRoot,
  maxResults = 500,
}: ListWorkspaceFilesInput): Promise<WorkspaceSummary> {
  const root = resolve(workspaceRoot);
  const files: WorkspaceSummary["files"] = [];

  async function walk(dir: string) {
    if (files.length >= maxResults) {
      return;
    }

    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= maxResults) {
        return;
      }

      if (shouldExclude(entry.name)) {
        continue;
      }

      const absolutePath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }

      if (!entry.isFile() || !isTextFile(entry.name)) {
        continue;
      }

      const fileStat = await stat(absolutePath);
      files.push({
        path: toRelativePath(root, absolutePath),
        sizeBytes: fileStat.size,
        mimeType: mimeTypeFor(entry.name),
      });
    }
  }

  await walk(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files };
}

export async function readWorkspaceFile(input: ReadWorkspaceFileInput): Promise<WorkspaceFileRead> {
  const root = resolve(input.workspaceRoot);
  const absolutePath = assertInsideWorkspace(root, input.path);
  const content = await readFile(absolutePath, "utf8");
  const lines = content.split(/(?<=\n)/);

  if (!input.startLine && !input.endLine) {
    return { path: input.path, content, truncated: false };
  }

  const start = Math.max((input.startLine ?? 1) - 1, 0);
  const end = Math.min(input.endLine ?? lines.length, lines.length);
  return {
    path: input.path,
    content: lines.slice(start, end).join(""),
    truncated: false,
  };
}

export async function searchWorkspaceText({
  workspaceRoot,
  query,
  maxResults = 50,
}: SearchWorkspaceTextInput): Promise<{ matches: WorkspaceTextMatch[] }> {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return { matches: [] };
  }

  const files = await listWorkspaceFiles({ workspaceRoot, maxResults: 500 });
  const matches: WorkspaceTextMatch[] = [];

  for (const file of files.files) {
    if (matches.length >= maxResults) {
      break;
    }

    const content = await readWorkspaceFile({ workspaceRoot, path: file.path });
    const lines = content.content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (line.toLowerCase().includes(normalizedQuery)) {
        matches.push({
          path: file.path,
          line: index + 1,
          snippet: line.trim(),
        });
      }
      if (matches.length >= maxResults) {
        break;
      }
    }
  }

  return { matches };
}

function assertInsideWorkspace(root: string, requestedPath: string) {
  const absolutePath = resolve(root, requestedPath);
  const relativePath = relative(root, absolutePath);
  if (relativePath.startsWith("..") || relativePath === "" || relativePath.includes(`..${sep}`)) {
    throw new Error("Path must stay inside the selected workspace.");
  }
  return absolutePath;
}

function toRelativePath(root: string, absolutePath: string) {
  return relative(root, absolutePath).split(sep).join("/");
}

function shouldExclude(name: string) {
  return DEFAULT_EXCLUDES.includes(name as (typeof DEFAULT_EXCLUDES)[number]) || name.endsWith(".log");
}

function isTextFile(name: string) {
  return TEXT_EXTENSIONS.has(extname(name).toLowerCase());
}

function mimeTypeFor(name: string) {
  const extension = extname(name).toLowerCase();
  if (extension === ".md") {
    return "text/markdown";
  }
  if (extension === ".json") {
    return "application/json";
  }
  return "text/plain";
}
