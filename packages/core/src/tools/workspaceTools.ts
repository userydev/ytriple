import type { FsPort, WorkspacePolicy } from "@ytriple/shared";
import { createGlobMatcher, normalizeRelativePath } from "./glob.js";
import { TOOL_NAMES } from "./toolNames.js";
import {
  readNumberArg,
  readStringArg,
  toolFailure,
  type ToolDefinition,
  type ToolResult,
} from "./types.js";

/**
 * Read-only workspace access.
 *
 * `FsPort` has no write method, so this file cannot modify the workspace even
 * by mistake. The policy globs travel with each request and are re-checked here
 * so a lenient host implementation still cannot widen the exposure.
 */
export interface WorkspaceToolsOptions {
  fs: FsPort;
  policy: WorkspacePolicy;
}

export function createWorkspaceTools(options: WorkspaceToolsOptions): ToolDefinition[] {
  return [createListTool(options), createReadTool(options), createSearchTool(options)];
}

export function isPathAllowed(policy: WorkspacePolicy, path: string): boolean {
  return createPathFilter(policy)(path);
}

/**
 * Compiles the policy once for callers that check many paths, which is every
 * listing and every search.
 */
export function createPathFilter(policy: WorkspacePolicy): (path: string) => boolean {
  const excluded = createGlobMatcher(policy.excludeGlobs);
  const included = createGlobMatcher(policy.includeGlobs);

  return (path: string) => {
    const normalized = normalizeRelativePath(path);
    if (normalized.length === 0) return false;
    if (normalized.startsWith("../") || normalized.includes("/../")) return false;
    if (excluded(normalized)) return false;
    return included(normalized);
  };
}

function createListTool(options: WorkspaceToolsOptions): ToolDefinition {
  return {
    name: TOOL_NAMES.listWorkspaceFiles,
    description:
      "List readable files in the user's workspace. Paths are relative to the workspace root.",
    parameters: {
      type: "object",
      properties: {
        max_results: { type: "integer", description: "How many paths to return, default 60" },
      },
    },
    async execute(args): Promise<ToolResult> {
      const limit = clamp(readNumberArg(args, "max_results") ?? 60, 1, options.policy.maxFiles);
      const entries = await options.fs.listFiles({
        includeGlobs: options.policy.includeGlobs,
        excludeGlobs: options.policy.excludeGlobs,
        maxResults: options.policy.maxFiles,
      });

      const allowed = createPathFilter(options.policy);
      const files = entries
        .map((entry) => ({ ...entry, path: normalizeRelativePath(entry.path) }))
        .filter((entry) => allowed(entry.path))
        .sort((left, right) => left.path.localeCompare(right.path));
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
      const requested = readStringArg(args, "path");
      if (!requested) return toolFailure(`${TOOL_NAMES.readWorkspaceFile} needs a path`);

      const path = normalizeRelativePath(requested);
      if (!isPathAllowed(options.policy, path)) {
        return toolFailure(
          `${path} is outside the readable workspace policy`,
          `${path} cannot be read: it is excluded by the workspace policy or lies outside the workspace root.`,
        );
      }

      const startLine = readNumberArg(args, "start_line");
      const endLine = readNumberArg(args, "end_line");

      try {
        const file = await options.fs.readFile({
          path,
          ...(startLine === undefined ? {} : { startLine: Math.trunc(startLine) }),
          ...(endLine === undefined ? {} : { endLine: Math.trunc(endLine) }),
          maxBytes: options.policy.maxFileBytes,
        });

        return {
          ok: true,
          summary: `read ${path} lines ${file.startLine}-${file.endLine}${
            file.truncated ? " (truncated)" : ""
          }`,
          detail: [
            `File ${path} (lines ${file.startLine}-${file.endLine}${
              file.truncated ? ", truncated" : ""
            }):`,
            file.content,
          ].join("\n"),
        };
      } catch (error) {
        // One unreadable file is a recoverable failure: report and continue.
        return toolFailure(
          `could not read ${path}`,
          `Reading ${path} failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    },
  };
}

function createSearchTool(options: WorkspaceToolsOptions): ToolDefinition {
  return {
    name: TOOL_NAMES.searchWorkspaceText,
    description: "Search readable workspace files for a string. Returns path, line and snippet.",
    parameters: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        max_results: { type: "integer" },
      },
    },
    async execute(args): Promise<ToolResult> {
      const query = readStringArg(args, "query");
      if (!query) return toolFailure(`${TOOL_NAMES.searchWorkspaceText} needs a query`);

      const limit = clamp(readNumberArg(args, "max_results") ?? 20, 1, 100);
      const matches = (
        await options.fs.searchText({
          query,
          includeGlobs: options.policy.includeGlobs,
          excludeGlobs: options.policy.excludeGlobs,
          maxResults: limit,
        })
      ).filter(createPathFilterOn(options.policy));

      if (matches.length === 0) {
        return {
          ok: true,
          summary: `no workspace match for "${query}"`,
          detail: `No readable workspace file contains "${query}".`,
        };
      }

      return {
        ok: true,
        summary: `${matches.length} workspace match(es) for "${query}"`,
        detail: [
          `Matches for "${query}":`,
          ...matches.map((match) => `${match.path}:${match.line}: ${match.snippet.trim().slice(0, 200)}`),
        ].join("\n"),
      };
    },
  };
}

function createPathFilterOn(policy: WorkspacePolicy) {
  const allowed = createPathFilter(policy);
  return (match: { path: string }) => allowed(match.path);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), min), max);
}
