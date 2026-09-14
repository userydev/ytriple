import type { AdapterId, ProviderCapabilities } from "@ytriple/shared";

/**
 * Adapter baselines. Deliberately conservative: a model that under-declares
 * degrades gracefully, one that over-declares fails at run time. Real values
 * come from the self-check and overwrite these.
 */
export const ADAPTER_BASELINE_CAPABILITIES: Record<AdapterId, ProviderCapabilities> = {
  google: {
    structuredOutput: "json_schema",
    toolCalling: "parallel",
    nativeWebSearch: true,
    streaming: true,
    maxContextTokens: 1_000_000,
    maxOutputTokens: 8_192,
    reasoningEffort: true,
    visionInput: true,
    costTier: "standard",
  },
  ark: {
    structuredOutput: "json_schema",
    toolCalling: "sequential",
    nativeWebSearch: true,
    streaming: true,
    maxContextTokens: 256_000,
    maxOutputTokens: 16_384,
    reasoningEffort: true,
    visionInput: true,
    costTier: "standard",
  },
  openai_compatible: {
    // Widest common denominator across DeepSeek, OpenRouter, vLLM and Ollama.
    // Raise per model with capability overrides or a self-check.
    structuredOutput: "json_mode",
    toolCalling: "sequential",
    nativeWebSearch: false,
    streaming: true,
    maxContextTokens: 64_000,
    maxOutputTokens: 8_192,
    reasoningEffort: false,
    visionInput: false,
    costTier: "cheap",
  },
};

export interface AdapterDescription {
  adapterId: AdapterId;
  label: string;
  defaultBaseUrl?: string;
  covers: string;
  notes: string;
  baseline: ProviderCapabilities;
}

/** Rendered by a settings UI when the user adds a provider. */
export const ADAPTER_CATALOG: readonly AdapterDescription[] = [
  {
    adapterId: "google",
    label: "Google Gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    covers: "Gemini",
    notes:
      "Native search grounding and native JSON schema, but not in the same request: a grounded call moves the schema into the prompt and reports a degradation.",
    baseline: ADAPTER_BASELINE_CAPABILITIES.google,
  },
  {
    adapterId: "openai_compatible",
    label: "OpenAI-compatible endpoint",
    covers: "DeepSeek, Ark's compatible endpoint, OpenRouter, Ollama, vLLM",
    notes:
      "Distinguished by baseUrl, modelId and capability overrides. Adding a vendor here is a configuration change, not a code change.",
    baseline: ADAPTER_BASELINE_CAPABILITIES.openai_compatible,
  },
  {
    adapterId: "ark",
    label: "Volcengine Ark (Responses API)",
    defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    covers: "Ark Responses API",
    notes: "Non-OpenAI shape. Combines its native web_search tool with strict json_schema output.",
    baseline: ADAPTER_BASELINE_CAPABILITIES.ark,
  },
];

export function baselineFor(adapterId: AdapterId): ProviderCapabilities {
  return ADAPTER_BASELINE_CAPABILITIES[adapterId];
}

/**
 * Handy presets for well-known endpoints behind `openai_compatible`. These are
 * data, not code paths: nothing in the runtime reads them.
 */
export const KNOWN_OPENAI_COMPATIBLE_ENDPOINTS = [
  {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    capabilities: { structuredOutput: "json_mode", maxContextTokens: 64_000 },
  },
  {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    capabilities: {},
  },
  {
    label: "Ollama (local)",
    baseUrl: "http://127.0.0.1:11434/v1",
    capabilities: { structuredOutput: "json_mode", toolCalling: "none", maxContextTokens: 8_192 },
  },
] as const satisfies ReadonlyArray<{
  label: string;
  baseUrl: string;
  capabilities: Partial<ProviderCapabilities>;
}>;
