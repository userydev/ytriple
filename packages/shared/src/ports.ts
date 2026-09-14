import type { AgentAnswer, AgentQuestion, SourceNote } from "./task.js";

/**
 * Ports are the only way core reaches the outside world. Every port speaks in
 * plain data so the same core runs in Tauri, in Node and on a server.
 */

export interface HttpRequestInit {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface HttpResponseData {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface HttpPort {
  request(init: HttpRequestInit): Promise<HttpResponseData>;
}

export interface WorkspaceFileMeta {
  /** POSIX-style path relative to the workspace root. Never absolute. */
  path: string;
  sizeBytes: number;
}

export interface WorkspaceListOptions {
  maxEntries?: number;
  /** Directory names the host may skip while walking, for speed. */
  skipDirectories?: readonly string[];
}

/**
 * Read-only, rooted view of the user's workspace. Core only ever sees relative
 * paths, which is what makes workspace escape impossible by construction.
 */
export interface WorkspaceFsPort {
  /** Display label for the root, e.g. the folder name. Not a usable path. */
  readonly rootLabel: string;
  listFiles(options?: WorkspaceListOptions): Promise<WorkspaceFileMeta[]>;
  readFile(relativePath: string): Promise<string>;
}

export interface OutputWriteResult {
  /** Absolute path, for display and for opening the folder. */
  path: string;
  created: boolean;
}

/** Write-only, rooted at the task output directory. Refuses overwrites. */
export interface OutputFsPort {
  readonly rootLabel: string;
  exists(relativePath: string): Promise<boolean>;
  writeNewFile(relativePath: string, content: string): Promise<OutputWriteResult>;
}

export interface SearchQuery {
  query: string;
  maxResults?: number;
}

/** Standalone web search, used when the bound provider cannot search natively. */
export interface SearchPort {
  search(query: SearchQuery): Promise<SourceNote[]>;
}

/**
 * Secret material never enters config objects or the renderer. Core asks for a
 * named ref; the host resolves it from a keychain, an env var or a dev file.
 */
export interface SecretsPort {
  has(refName: string): Promise<boolean>;
  get(refName: string): Promise<string | undefined>;
}

export interface ClockPort {
  now(): number;
}

export interface IdPort {
  next(prefix: string): string;
}

/** How the runtime asks the human the agents' questions. */
export interface UserPort {
  askQuestions(questions: AgentQuestion[]): Promise<AgentAnswer[]>;
}

export interface LoggerPort {
  debug(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
}

export const noopLogger: LoggerPort = {
  debug() {},
  warn() {},
};
