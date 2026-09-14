import type { NamedJsonSchema } from "./jsonSchema.js";
import type { SourceNote, TokenUsage } from "./task.js";

export type ProviderKind = "google" | "openai_compatible" | "ark" | "deepseek";

export const PROVIDER_KINDS: readonly ProviderKind[] = [
  "google",
  "openai_compatible",
  "ark",
  "deepseek",
];

/**
 * Capabilities are the only thing the orchestrator is allowed to branch on. No
 * code path may test a provider by name.
 */
export interface ProviderCapabilities {
  /** `json_schema`: native strict schema. `json_object`: JSON mode only. */
  structuredOutput: "json_schema" | "json_object" | "text_only";
  toolCalling: boolean;
  /** The provider can search the web itself, without a SearchPort. */
  nativeWebSearch: boolean;
  streaming: boolean;
  maxContextTokens: number;
}

export interface ProviderRequestMetadata {
  agentId: string;
  /** Runtime phase, e.g. `intake`, `plan`, `synthesis`, `merge`. */
  phase: string;
  round: number;
  /** Set when the call belongs to a spawned sub-agent. */
  subAgentId?: string;
}

export interface ProviderRequest {
  system: string;
  user: string;
  /** When set, the response must be JSON matching this schema. */
  responseSchema?: NamedJsonSchema;
  temperature?: number;
  maxOutputTokens?: number;
  /** Honoured only by providers whose capabilities declare native web search. */
  webSearch?: { enabled: boolean; maxResults?: number };
  metadata: ProviderRequestMetadata;
}

export interface ProviderResponse {
  text: string;
  usage: TokenUsage;
  /** Grounding citations returned by native provider search. */
  sources?: SourceNote[];
  /** How the request was actually encoded, for degradation reporting. */
  structuredOutputMode?: ProviderCapabilities["structuredOutput"];
}

export interface ProviderAdapter {
  readonly providerId: string;
  readonly kind: ProviderKind;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
}

export class ProviderError extends Error {
  readonly providerId: string;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { providerId: string; status?: number; retryable?: boolean },
  ) {
    super(message);
    this.name = "ProviderError";
    this.providerId = options.providerId;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}
