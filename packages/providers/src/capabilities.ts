import type { ProviderCapabilities, ProviderKind } from "@ytriple/shared";

/**
 * The capability table is the contract between the provider layer and the
 * orchestrator. Orchestration branches on these flags and never on a provider
 * name, which is what keeps adding a provider a data change.
 *
 * Values are deliberately conservative: a provider that under-declares degrades
 * gracefully, one that over-declares fails at run time.
 */
export const DEFAULT_CAPABILITIES: Record<ProviderKind, ProviderCapabilities> = {
  google: {
    structuredOutput: "json_schema",
    toolCalling: true,
    nativeWebSearch: true,
    streaming: true,
    maxContextTokens: 1_000_000,
  },
  ark: {
    structuredOutput: "json_schema",
    toolCalling: true,
    nativeWebSearch: true,
    streaming: true,
    maxContextTokens: 256_000,
  },
  deepseek: {
    // DeepSeek exposes JSON mode but not strict per-request schemas.
    structuredOutput: "json_object",
    toolCalling: true,
    nativeWebSearch: false,
    streaming: true,
    maxContextTokens: 64_000,
  },
  openai_compatible: {
    // Covers OpenRouter, vLLM, Ollama and friends. JSON mode is the widest
    // common denominator; raise it per provider with capabilityOverrides.
    structuredOutput: "json_object",
    toolCalling: true,
    nativeWebSearch: false,
    streaming: true,
    maxContextTokens: 128_000,
  },
};

export function capabilitiesFor(
  kind: ProviderKind,
  overrides?: Partial<ProviderCapabilities>,
): ProviderCapabilities {
  return { ...DEFAULT_CAPABILITIES[kind], ...overrides };
}

export interface CapabilityDescription {
  kind: ProviderKind;
  label: string;
  defaultBaseUrl?: string;
  notes: string;
  capabilities: ProviderCapabilities;
}

/** Rendered by settings UIs and by `preflightConfig` reports. */
export const PROVIDER_CATALOG: readonly CapabilityDescription[] = [
  {
    kind: "google",
    label: "Google Gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    notes:
      "Native search grounding. Grounding and strict response schemas are mutually exclusive, so a grounded call degrades to prompt-injected schema.",
    capabilities: DEFAULT_CAPABILITIES.google,
  },
  {
    kind: "ark",
    label: "Volcengine Ark (Responses API)",
    defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    notes: "Native web_search tool and strict json_schema output in the same request.",
    capabilities: DEFAULT_CAPABILITIES.ark,
  },
  {
    kind: "deepseek",
    label: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    notes: "OpenAI-compatible chat completions with JSON mode. No native search; uses the SearchPort.",
    capabilities: DEFAULT_CAPABILITIES.deepseek,
  },
  {
    kind: "openai_compatible",
    label: "OpenAI-compatible endpoint",
    notes:
      "Any /chat/completions endpoint: OpenRouter, Ark's compatible mode, vLLM, Ollama. Base URL is required.",
    capabilities: DEFAULT_CAPABILITIES.openai_compatible,
  },
];
