import type {
  AgentAnswer,
  AgentQuestion,
  ClockPort,
  GenerateRequest,
  GenerateResult,
  ModelConfig,
  ProviderAdapter,
  ProviderCapabilities,
  FileContent,
  FileEntry,
  FsPort,
  LoggerPort,
  OutputPort,
  RuntimeCapabilities,
  SearchPort,
  SearchResult,
  SecretPort,
  StoragePort,
  TextMatch,
  UserPort,
} from "@ytriple/shared";
import { matchesAnyGlob, normalizeRelativePath } from "../tools/glob.js";

/**
 * In-memory port doubles.
 *
 * Exported from the package rather than kept in test files: the CLI harness
 * uses the same fakes for a dry run, and a desktop build can use them for a
 * demo mode.
 */

export interface FakeClock extends ClockPort {
  advance(ms: number): void;
}

/** Deterministic clock: the whole event stream is reproducible without it. */
export function createFakeClock(start = 1_700_000_000_000, step = 1_000): FakeClock {
  let current = start;
  return {
    now() {
      const value = current;
      current += step;
      return value;
    },
    async sleep(ms) {
      current += ms;
    },
    advance(ms) {
      current += ms;
    },
  };
}

export interface FakeFsOptions {
  rootLabel?: string;
  files: Record<string, string>;
}

export function createFakeFsPort(options: FakeFsOptions): FsPort {
  const files = new Map(
    Object.entries(options.files).map(([path, content]) => [normalizeRelativePath(path), content]),
  );

  const visible = (path: string, include?: readonly string[], exclude?: readonly string[]) => {
    if (exclude && matchesAnyGlob(exclude, path)) return false;
    if (include && include.length > 0) return matchesAnyGlob(include, path);
    return true;
  };

  return {
    rootLabel: options.rootLabel ?? "fake-workspace",
    async listFiles(request) {
      const entries: FileEntry[] = [];
      for (const [path, content] of files) {
        if (!visible(path, request.includeGlobs, request.excludeGlobs)) continue;
        entries.push({ path, sizeBytes: content.length });
      }
      return entries.slice(0, request.maxResults ?? entries.length);
    },
    async readFile(request): Promise<FileContent> {
      const path = normalizeRelativePath(request.path);
      const content = files.get(path);
      if (content === undefined) throw new Error(`no such file: ${path}`);

      const lines = content.split("\n");
      const startLine = Math.max(1, request.startLine ?? 1);
      const endLine = Math.min(lines.length, request.endLine ?? lines.length);
      let slice = lines.slice(startLine - 1, endLine).join("\n");
      let truncated = startLine > 1 || endLine < lines.length;

      if (request.maxBytes !== undefined && slice.length > request.maxBytes) {
        slice = slice.slice(0, request.maxBytes);
        truncated = true;
      }

      return { path, content: slice, startLine, endLine, truncated };
    },
    async searchText(request): Promise<TextMatch[]> {
      const needle = request.query.toLowerCase();
      const matches: TextMatch[] = [];

      for (const [path, content] of files) {
        if (!visible(path, request.includeGlobs, request.excludeGlobs)) continue;
        content.split("\n").forEach((line, index) => {
          if (line.toLowerCase().includes(needle)) {
            matches.push({ path, line: index + 1, snippet: line });
          }
        });
      }

      return matches.slice(0, request.maxResults ?? matches.length);
    },
  };
}

export interface FakeOutputPort extends OutputPort {
  readonly documents: Map<string, string>;
  readonly revealed: string[];
}

export function createFakeOutputPort(rootLabel = "/tmp/ytriple-outputs"): FakeOutputPort {
  const documents = new Map<string, string>();
  const revealed: string[] = [];

  return {
    documents,
    revealed,
    async writeDocument(request) {
      const path = `${rootLabel}/${request.taskId}/${request.filename}`;
      if (documents.has(path)) {
        // Mirrors the real contract: a task never overwrites its own output.
        throw new Error(`${path} already exists; outputs are never overwritten`);
      }
      documents.set(path, request.content);
      return { path };
    },
    async revealOutput(taskId) {
      revealed.push(taskId);
    },
  };
}

export function createFakeSearchPort(
  results: Record<string, SearchResult[]> | SearchResult[],
): SearchPort {
  return {
    async search(request) {
      if (Array.isArray(results)) return results.slice(0, request.maxResults);
      return (results[request.query] ?? []).slice(0, request.maxResults);
    },
  };
}

export function createFailingSearchPort(message = "search backend unavailable"): SearchPort {
  return {
    async search() {
      throw new Error(message);
    },
  };
}

/** Answers every question from a map, or with a fixed fallback. */
export function createScriptedUserPort(
  answers: Record<string, string> | ((question: AgentQuestion) => string),
): UserPort & { readonly asked: AgentQuestion[] } {
  const asked: AgentQuestion[] = [];
  return {
    asked,
    async askQuestions(questions) {
      asked.push(...questions);
      return questions.map(
        (question): AgentAnswer => ({
          questionId: question.questionId,
          text:
            typeof answers === "function"
              ? answers(question)
              : (answers[question.questionId] ?? answers[question.agentId] ?? ""),
        }),
      );
    },
  };
}

export function createSilentUserPort(): UserPort {
  return {
    async askQuestions() {
      return [];
    },
  };
}

export function createFakeSecretPort(values: Record<string, string>): SecretPort {
  return {
    async resolve(credentialRef) {
      const value = values[credentialRef];
      if (value === undefined) throw new Error(`secret "${credentialRef}" is not set`);
      return value;
    },
  };
}

export function createMemoryStoragePort(): StoragePort {
  const store = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      return (store.get(key) as T) ?? null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async list(prefix) {
      return [...store.keys()].filter((key) => key.startsWith(prefix));
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

export function createCollectingLogger(): LoggerPort & {
  readonly entries: Array<{ level: string; event: string; fields: Record<string, unknown> }>;
} {
  const entries: Array<{ level: string; event: string; fields: Record<string, unknown> }> = [];
  return {
    entries,
    log(level, event, fields) {
      entries.push({ level, event, fields });
    },
  };
}

export const DEFAULT_FAKE_MODEL_CAPABILITIES: ProviderCapabilities = {
  structuredOutput: "json_schema",
  toolCalling: "parallel",
  nativeWebSearch: false,
  streaming: false,
  maxContextTokens: 128_000,
  maxOutputTokens: 4_096,
  reasoningEffort: false,
  visionInput: false,
  costTier: "cheap",
};

export type ScriptedHandler = (request: GenerateRequest) => unknown;

export interface ScriptedAdapterOptions {
  providerId?: string;
  capabilities?: Partial<ProviderCapabilities>;
  /**
   * Keyed by `agentId:phase`, then `phase`, then `*`. Returning a plain object
   * makes it the JSON answer; returning a GenerateResult controls tool calls,
   * usage and degradations directly.
   */
  handlers: Record<string, ScriptedHandler>;
}

export interface FakeProviderAdapter extends ProviderAdapter {
  readonly requests: GenerateRequest[];
}

/**
 * Provider double for runtime tests. Core depends on the adapter *interface*
 * only, so this lives here rather than pulling the providers package into core.
 */
export function createScriptedProviderAdapter(
  options: ScriptedAdapterOptions,
): FakeProviderAdapter {
  const requests: GenerateRequest[] = [];
  const capabilities: ProviderCapabilities = {
    ...DEFAULT_FAKE_MODEL_CAPABILITIES,
    ...options.capabilities,
  };

  const lookup = (request: GenerateRequest): ScriptedHandler => {
    const { agentId, phase, subAgentId } = request.metadata;
    const handler =
      (subAgentId ? options.handlers[`${subAgentId}:${phase}`] : undefined) ??
      options.handlers[`${agentId}:${phase}`] ??
      options.handlers[phase] ??
      options.handlers["*"];
    if (!handler) {
      throw new Error(
        `No scripted handler for ${agentId}:${phase} (known: ${Object.keys(options.handlers).join(", ")})`,
      );
    }
    return handler;
  };

  return {
    adapterId: "openai_compatible",
    providerId: options.providerId ?? "scripted",
    requests,
    describe: (model: ModelConfig) => ({ ...capabilities, ...model.capabilities }),
    async healthCheck() {
      return { reachable: true, detected: capabilities, mismatches: [] };
    },
    async generate(request): Promise<GenerateResult> {
      requests.push(request);
      const payload = lookup(request)(request);

      if (isGenerateResult(payload)) return payload;

      const text = typeof payload === "string" ? payload : JSON.stringify(payload);
      return {
        text,
        toolCalls: [],
        usage: { inputTokens: estimateFakeTokens(request), outputTokens: Math.ceil(text.length / 4) },
        degradations: [],
      };
    },
  };
}

function isGenerateResult(value: unknown): value is GenerateResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "toolCalls" in value &&
    "usage" in value &&
    "degradations" in value
  );
}

function estimateFakeTokens(request: GenerateRequest): number {
  const length =
    request.system.length +
    request.messages.reduce((total, message) => total + message.content.length, 0);
  return Math.ceil(length / 4);
}

export const FULL_CAPABILITIES: RuntimeCapabilities = {
  workspaceRead: true,
  outputWrite: true,
  webSearch: true,
  localModels: false,
  persistentBackgroundRuns: false,
  streaming: false,
};

export const HOSTED_CAPABILITIES: RuntimeCapabilities = {
  ...FULL_CAPABILITIES,
  // A server never gets the user's disk.
  workspaceRead: false,
};
