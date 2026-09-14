import type { Degradation } from "./degradation.js";
import type { JsonSchema } from "./jsonSchema.js";
import type { SourceNote, TokenUsage } from "./task.js";

/**
 * Three adapter families cover every vendor. Adding a vendor is a
 * configuration change; a new family is only justified by an incompatible API
 * shape.
 */
export type AdapterId = "google" | "openai_compatible" | "ark";

export const ADAPTER_IDS: readonly AdapterId[] = ["google", "openai_compatible", "ark"];

/** The only thing orchestration is allowed to branch on. Never a brand. */
export interface ProviderCapabilities {
  structuredOutput: "json_schema" | "json_mode" | "none";
  toolCalling: "parallel" | "sequential" | "none";
  nativeWebSearch: boolean;
  streaming: boolean;
  maxContextTokens: number;
  maxOutputTokens: number;
  reasoningEffort: boolean;
  visionInput: boolean;
  costTier: "cheap" | "standard" | "premium";
}

export interface ModelPricing {
  inputPerMTokens: number;
  outputPerMTokens: number;
  currency: "USD" | "CNY";
}

export interface ModelConfig {
  modelId: string;
  displayName: string;
  /**
   * Partial: the adapter's baseline fills the rest. Precedence is
   * self-check result > user override > adapter default.
   */
  capabilities?: Partial<ProviderCapabilities>;
  pricing?: ModelPricing;
}

export interface ProviderConfig {
  /** User-visible instance id, e.g. "deepseek-personal". */
  providerId: string;
  adapterId: AdapterId;
  displayName: string;
  baseUrl?: string;
  models: ModelConfig[];
  /** Key into the SecretPort. Never key material. */
  credentialRef: string;
  /** Local providers such as Ollama may run without a credential. */
  credentialOptional?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ToolCall {
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  /** Set on assistant turns that requested tools. */
  toolCalls?: ToolCall[];
  /** Set on tool result turns. */
  toolCallId?: string;
  name?: string;
}

export interface GenerateRequest {
  model: ModelConfig;
  system: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  responseSchema?: { name: string; schema: JsonSchema };
  maxOutputTokens?: number;
  temperature?: number;
  /** Only permitted when the resolved capabilities allow it. */
  nativeWebSearch?: boolean;
  /** Trace and recording key material; never contains user secrets. */
  metadata: GenerateMetadata;
}

export interface GenerateMetadata {
  agentId: string;
  phase: string;
  round: number;
  subAgentId?: string;
}

export interface GenerateResult {
  text: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  sources?: SourceNote[];
  /** Degradations that happened inside this call. Never silent. */
  degradations: Degradation[];
}

export interface HealthCheckResult {
  reachable: boolean;
  latencyMs?: number;
  detected: Partial<ProviderCapabilities>;
  mismatches: string[];
  error?: { code: ProviderErrorCode; message: string };
}

export interface ProviderAdapter {
  readonly adapterId: AdapterId;
  readonly providerId: string;
  /** Resolved capability table for one model. */
  describe(model: ModelConfig): ProviderCapabilities;
  healthCheck(model: ModelConfig): Promise<HealthCheckResult>;
  generate(request: GenerateRequest): Promise<GenerateResult>;
}

export type ProviderErrorCode =
  | "auth_failed"
  | "rate_limited"
  | "quota_exceeded"
  | "context_overflow"
  | "schema_violation"
  | "content_filtered"
  | "network"
  | "timeout"
  | "unsupported"
  | "unknown";

const RECOVERABLE_CODES: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>([
  "rate_limited",
  "context_overflow",
  "schema_violation",
  "content_filtered",
  "network",
  "timeout",
]);

export class ProviderError extends Error {
  readonly providerId: string;
  readonly code: ProviderErrorCode;
  readonly status?: number;

  constructor(
    message: string,
    options: { providerId: string; code: ProviderErrorCode; status?: number },
  ) {
    super(message);
    this.name = "ProviderError";
    this.providerId = options.providerId;
    this.code = options.code;
    this.status = options.status;
  }

  get retryable(): boolean {
    return RECOVERABLE_CODES.has(this.code);
  }
}

export function isRecoverableProviderCode(code: ProviderErrorCode): boolean {
  return RECOVERABLE_CODES.has(code);
}
