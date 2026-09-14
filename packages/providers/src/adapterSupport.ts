import type {
  Degradation,
  GenerateRequest,
  HttpPort,
  ModelConfig,
  ProviderCapabilities,
  ProviderErrorCode,
} from "@ytriple/shared";
import { ProviderError, describeSchema } from "@ytriple/shared";

/**
 * Capability precedence: self-check result (written back into the model config
 * by the caller) > user override > adapter baseline.
 */
export function resolveCapabilities(
  baseline: ProviderCapabilities,
  model: ModelConfig,
): ProviderCapabilities {
  return { ...baseline, ...model.capabilities };
}

export interface StructuredOutputPlan {
  mode: ProviderCapabilities["structuredOutput"];
  /** System prompt to send, with the schema appended when it cannot be native. */
  system: string;
  degradations: Degradation[];
}

/**
 * The structured-output chain, resolved once per call so every adapter
 * degrades the same way instead of inventing its own fallback.
 */
export function planStructuredOutput(
  request: GenerateRequest,
  capabilities: ProviderCapabilities,
  options: { nativeSchemaAvailable?: boolean; nativeUnavailableReason?: string } = {},
): StructuredOutputPlan {
  if (!request.responseSchema) {
    return { mode: "none", system: request.system, degradations: [] };
  }

  const nativeSchemaAvailable = options.nativeSchemaAvailable ?? true;
  const effective: ProviderCapabilities["structuredOutput"] =
    capabilities.structuredOutput === "json_schema" && !nativeSchemaAvailable
      ? "json_mode"
      : capabilities.structuredOutput;

  if (effective === "json_schema") {
    return { mode: "json_schema", system: request.system, degradations: [] };
  }

  const detail =
    capabilities.structuredOutput === "json_schema"
      ? (options.nativeUnavailableReason ??
        "native schema unavailable for this request shape; schema moved into the prompt")
      : `model declares structuredOutput=${capabilities.structuredOutput}; schema moved into the prompt and validated locally with repair retries`;

  return {
    mode: effective,
    system: appendSchemaInstruction(request.system, request.responseSchema),
    degradations: [
      {
        kind: "structured_output",
        from: "json_schema",
        to: effective === "json_mode" ? "json_mode" : "prompt_only",
        detail,
      },
    ],
  };
}

export function appendSchemaInstruction(
  system: string,
  schema: { name: string; schema: Parameters<typeof describeSchema>[0] },
): string {
  return [
    system,
    "",
    `Reply with a single JSON object named ${schema.name} and nothing else.`,
    "Do not wrap it in Markdown fences and do not add commentary.",
    "It must match this shape exactly:",
    describeSchema(schema.schema),
  ].join("\n");
}

/**
 * Native-search chain. The SearchPort fallback itself lives in core; the
 * adapter's job is to refuse honestly rather than pretend it searched.
 */
export function planNativeWebSearch(
  request: GenerateRequest,
  capabilities: ProviderCapabilities,
): { enabled: boolean; degradations: Degradation[] } {
  if (!request.nativeWebSearch) return { enabled: false, degradations: [] };
  if (capabilities.nativeWebSearch) return { enabled: true, degradations: [] };

  return {
    enabled: false,
    degradations: [
      {
        kind: "native_web_search",
        from: "native",
        to: "search_port",
        detail: "bound model has no native web search; the runtime must use the SearchPort",
      },
    ],
  };
}

/** Tool-calling chain. There is no prompt-simulated fallback, by contract. */
export function assertToolCallingSupported(
  request: GenerateRequest,
  capabilities: ProviderCapabilities,
  providerId: string,
): void {
  if (!request.tools || request.tools.length === 0) return;
  if (capabilities.toolCalling !== "none") return;

  throw new ProviderError(
    `Model ${request.model.modelId} declares toolCalling="none" but ${request.tools.length} tool(s) were dispatched. Bind a tool-capable model to this member; there is no prompt-simulated fallback.`,
    { providerId, code: "unsupported" },
  );
}

/** `sequential` models get one tool per turn; `parallel` may get several. */
export function limitToolCalls<T>(
  toolCalls: T[],
  capabilities: ProviderCapabilities,
): { toolCalls: T[]; degradations: Degradation[] } {
  if (capabilities.toolCalling !== "sequential" || toolCalls.length <= 1) {
    return { toolCalls, degradations: [] };
  }
  return {
    toolCalls: toolCalls.slice(0, 1),
    degradations: [
      {
        kind: "tool_calling",
        from: "parallel",
        to: "sequential",
        detail: `model returned ${toolCalls.length} tool calls but declares sequential tool calling; only the first is executed`,
      },
    ],
  };
}

export interface JsonPostOptions {
  providerId: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs?: number;
}

export async function postJson(
  http: HttpPort,
  options: JsonPostOptions,
): Promise<Record<string, unknown>> {
  const response = await http.request({
    url: options.url,
    method: "POST",
    headers: { "content-type": "application/json", ...options.headers },
    body: JSON.stringify(options.body),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });

  if (response.status < 200 || response.status >= 300) {
    const code = classifyHttpStatus(response.status, response.body);
    throw new ProviderError(describeHttpFailure(options.providerId, response.status, code, response.body), {
      providerId: options.providerId,
      code,
      status: response.status,
    });
  }

  try {
    const parsed: unknown = JSON.parse(response.body);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("response body was not a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new ProviderError(
      `${options.providerId} returned an unparseable response: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
      { providerId: options.providerId, code: "unknown" },
    );
  }
}

export function classifyHttpStatus(status: number, body: string): ProviderErrorCode {
  const lowered = body.toLowerCase();
  if (lowered.includes("context length") || lowered.includes("context_length") || lowered.includes("too many tokens")) {
    return "context_overflow";
  }
  if (lowered.includes("content filter") || lowered.includes("content_filter")) {
    return "content_filtered";
  }
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 402 || status === 413) return "quota_exceeded";
  if (status === 404) return "unsupported";
  if (status === 408) return "timeout";
  if (status === 429) return lowered.includes("quota") ? "quota_exceeded" : "rate_limited";
  if (status >= 500) return "network";
  return "unknown";
}

function describeHttpFailure(
  providerId: string,
  status: number,
  code: ProviderErrorCode,
  body: string,
): string {
  const detail = body.slice(0, 300).replace(/\s+/g, " ").trim();
  switch (code) {
    case "auth_failed":
      return `${providerId} rejected the credentials (HTTP ${status}). Check the credentialRef and base URL. ${detail}`;
    case "unsupported":
      return `${providerId} endpoint or model not found (HTTP ${status}). Check the base URL and modelId. ${detail}`;
    case "rate_limited":
      return `${providerId} rate limited the request (HTTP ${status}). ${detail}`;
    case "quota_exceeded":
      return `${providerId} reported a quota problem (HTTP ${status}). ${detail}`;
    case "context_overflow":
      return `${providerId} rejected the prompt as too long (HTTP ${status}). ${detail}`;
    default:
      return `${providerId} request failed with HTTP ${status}. ${detail}`;
  }
}

export function readRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const entry = (value as Record<string, unknown>)[key];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
  return entry as Record<string, unknown>;
}

export function readArray(value: unknown, key: string): unknown[] {
  if (typeof value !== "object" || value === null) return [];
  const entry = (value as Record<string, unknown>)[key];
  return Array.isArray(entry) ? entry : [];
}

export function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const entry = (value as Record<string, unknown>)[key];
  return typeof entry === "string" ? entry : undefined;
}

export function readNumber(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const entry = (value as Record<string, unknown>)[key];
  return typeof entry === "number" ? entry : undefined;
}

export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== "string" || raw.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
