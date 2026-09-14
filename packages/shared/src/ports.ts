import type { AgentAnswer, AgentQuestion, SourceNote } from "./task.js";

/**
 * Ports are the only way core reaches the outside world, and they speak plain
 * data so the same core runs under Tauri, under Node and on a server.
 *
 * The split between `FsPort` and `OutputPort` is deliberate: workspace
 * read-only is a type-level property, not a runtime check. `FsPort` has no
 * write method to call.
 */

export interface ListFilesRequest {
  includeGlobs?: readonly string[];
  excludeGlobs?: readonly string[];
  maxResults?: number;
}

export interface FileEntry {
  /** POSIX-style path relative to the workspace root. Never absolute. */
  path: string;
  sizeBytes: number;
}

export interface ReadFileRequest {
  path: string;
  startLine?: number;
  endLine?: number;
  maxBytes?: number;
}

export interface FileContent {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  truncated: boolean;
}

export interface SearchTextRequest {
  query: string;
  includeGlobs?: readonly string[];
  excludeGlobs?: readonly string[];
  maxResults?: number;
}

export interface TextMatch {
  path: string;
  line: number;
  snippet: string;
}

/** Read-only by construction. */
export interface FsPort {
  readonly rootLabel: string;
  listFiles(request: ListFilesRequest): Promise<FileEntry[]>;
  readFile(request: ReadFileRequest): Promise<FileContent>;
  searchText(request: SearchTextRequest): Promise<TextMatch[]>;
}

export interface WriteDocumentRequest {
  taskId: string;
  filename: "prd.md";
  content: string;
}

/** The only write channel in the system. */
export interface OutputPort {
  writeDocument(request: WriteDocumentRequest): Promise<{ path: string }>;
  revealOutput(taskId: string): Promise<void>;
}

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
  request(request: HttpRequestInit): Promise<HttpResponseData>;
}

export interface StoragePort {
  get<T>(key: string): Promise<T | null>;
  put<T>(key: string, value: T): Promise<void>;
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
}

/** Standalone search: the fallback when a provider cannot ground itself. */
export interface SearchPort {
  search(request: { query: string; maxResults: number }): Promise<SearchResult[]>;
}

/** Core only ever sees a reference; plaintext stays in the host. */
export interface SecretPort {
  resolve(credentialRef: string): Promise<string>;
}

export interface ClockPort {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggerPort {
  log(level: LogLevel, event: string, fields: Record<string, unknown>): void;
}

/**
 * How the host asks the human the questions the orchestrator approved. Members
 * never address the user directly.
 */
export interface UserPort {
  askQuestions(questions: AgentQuestion[]): Promise<AgentAnswer[]>;
}

export const noopLogger: LoggerPort = {
  log() {},
};

export function sourceFromSearchResult(result: SearchResult): SourceNote {
  return {
    title: result.title,
    url: result.url,
    ...(result.snippet ? { snippet: result.snippet } : {}),
    origin: "search_port",
  };
}
