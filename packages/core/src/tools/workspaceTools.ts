import type { WorkspaceFileMeta, WorkspaceFsPort, WorkspacePolicy } from "@ytriple/shared";
import { matchesAnyGlob, normalizeRelativePath } from "./glob.js";
import { TOOL_NAMES } from "./toolNames.js";
import { toolFailure, type ToolDefinition, type ToolResult } from "./types.js";

/**
 * Read-only workspace access.
 *
 * The host port is deliberately dumb: it walks a rooted directory and returns
 * relative paths. Include/exclude rules, size caps, line ranges and search all
 * live here, where they are testable without a file system and where no path
 * can escape the root.
 */
export interface WorkspaceToolsOptions {
  fs: WorkspaceFsPort;
  policy: WorkspacePolicy;
}

export function createWorkspaceTools(options: WorkspaceToolsOptions): ToolDefinition[] {
  return [
    createListTool(options),
    createReadTool(options),
    createSearchTool(options),
  ];
}

export function isPathAllowed(policy: WorkspacePolicy, path: string): boolean {
  const normalized = normalizeRelativePath(path);
  if (normalized.startsWith("../") || normalized.includes("/../")) return false;
  if (matchesAnyGlob(policy.excludeGlobs, normalized)) return false;
  return matchesAnyGlob(policy.includeGlobs, normalized);
}

export async function listAllowedFiles(
  options: WorkspaceToolsOptions,
): Promise<WorkspaceFileMeta[]> {
  const { fs, policy } = options;
  const entries = await fs.listFiles({
    maxEntries: policy.maxFiles * 4,
    skipDirectories: [".git", "node_modules", "dist", "build", "target", ".next", "coverage"],
  });

  return entries
    .map((entry) => ({ ...entry, path: normalizeRelativePath(entry.path) }))
    .filter((entry) => isPathAllowed(policy, entry.path))
    .sort((left, right) => left.path.localeCompare(right.path))
    .slice(0, policy.maxFiles);
}

function createListTool(options: WorkspaceToolsOptions): ToolDefinition {
  return {
    name: TOOL_NAMES.listWorkspaceFiles,
    description:
      "List readable files in the user's workspace. Paths are relative to the workspace root.",
    parameters: {
      type: "object",
      properties: {
        max_results: { type: "integer", description: "Maximum number of paths to return" },
      },
    },
    async execute(args): Promise<ToolResult> {
      const files = await listAllowedFiles(options);
      const limit = clamp(args.max_results ?? 60, 1, options.policy.maxFiles);
      const shown = files.slice(0, limit);

      if (shown.length === 0) {
        return {
          ok: true,
          summary: "workspace has no readable files",
          detail: "The workspace contains no files matching the readable-file policy.",
        };
      }

      return {
        ok: true,
        summary: `${shown.length} of ${files.length} readable file(s)`,
        detail: [
          `Workspace ${options.fs.rootLabel}: ${files.length} readable file(s), showing ${shown.length}.`,
          ...shown.map((file) => `- ${file.path} (${file.sizeBytes} bytes)`),
        ].join("\n"),
      };
    },
  };
}

function createReadTool(options: WorkspaceToolsOptions): ToolDefinition {
  return {
    name: TOOL_NAMES.readWorkspaceFile,
    description: "Read one workspace file, optionally a line range.",
    parameters: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string", description: "Path relative to the workspace root" },
        start_line: { type: "integer", description: "1-based first line" },
        end_line: { type: "integer", description: "1-based last line" },
      },
    },
    async execute(args): Promise<ToolResult> {
      if (!args.path) return toolFailure("read_workspace_file needs a path");

      const path = normalizeRelativePath(args.path);
      if (!isPathAllowed(options.policy, path)) {
        return toolFailure(
          `${path} is outside the readable workspace policy`,
          `${path} cannot be read: it is excluded by the workspace policy or lies outside the workspace root.`,
        );
      }

      let content: string;
      try {
        content = await options.fs.readFile(path);
      } catch (error) {
        // A single unreadable file is a recoverable failure: report and continue.
        return toolFailure(
          `could not read ${path}`,
          `Reading ${path} failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }

      const lines = content.split("\n");
      const start = clamp(args.start_line ?? 1, 1, Math.max(lines.length, 1));
      const end = clamp(args.end_line ?? lines.length, start, lines.length);
      let slice = lines.slice(start - 1, end).join("\n");

      let truncated = end < lines.length || start > 1;
      if (slice.length > options.policy.maxFileBytes) {
        slice = slice.slice(0, options.policy.maxFileBytes);
        truncated = true;
      }

      return {
        ok: true,
        summary: `read ${path} lines ${start}-${end}${truncated ? " (truncated)" : ""}`,
        detail: [`File ${path} (lines ${start}-${end}${truncated ? ", truncated" : ""}):`, slice].join(
          "\n",
        ),
      };
    },
  };
}

function createSearchTool(options: WorkspaceToolsOptions): ToolDefinition {
  return {
    name: TOOL_NAMES.searchWorkspaceText,
    description: "Case-insensitive text search across readable workspace files.",
    parameters: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        max_results: { type: "integer" },
      },
    },
    async execute(args): Promise<ToolResult> {
      const query = args.query?.trim();
      if (!query) return toolFailure("search_workspace_text needs a query");

      const needle = query.toLowerCase();
      const limit = clamp(args.max_results ?? 20, 1, 100);
      const files = await listAllowedFiles(options);
      const matches: string[] = [];

      for (const file of files) {
        if (matches.length >= limit) break;
        let content: string;
        try {
          content = await options.fs.readFile(file.path);
        } catch {
          continue;
        }
        const lines = content.split("\n");
        for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
          const line = lines[index]!;
          if (!line.toLowerCase().includes(needle)) continue;
          matches.push(`${file.path}:${index + 1}: ${line.trim().slice(0, 200)}`);
        }
      }

      if (matches.length === 0) {
        return {
          ok: true,
          summary: `no workspace match for "${query}"`,
          detail: `No workspace file contains "${query}".`,
        };
      }

      return {
        ok: true,
        summary: `${matches.length} workspace match(es) for "${query}"`,
        detail: [`Matches for "${query}":`, ...matches].join("\n"),
      };
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), min), max);
}
