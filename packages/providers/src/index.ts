export { PROVIDERS_PACKAGE_VERSION } from "./version.js";

export type { CapabilityDescription } from "./capabilities.js";
export { DEFAULT_CAPABILITIES, PROVIDER_CATALOG, capabilitiesFor } from "./capabilities.js";

export type { OpenAiCompatibleOptions } from "./openaiCompatible.js";
export { createOpenAiCompatibleProvider } from "./openaiCompatible.js";

export type { ArkProviderOptions } from "./ark.js";
export { ARK_DEFAULT_BASE_URL, createArkProvider } from "./ark.js";

export type { GoogleProviderOptions } from "./google.js";
export { GOOGLE_DEFAULT_BASE_URL, createGoogleProvider, toGeminiSchema } from "./google.js";

export type { ProviderDeps, ProviderRegistry, ProviderRegistryOptions } from "./factory.js";
export {
  DEEPSEEK_DEFAULT_BASE_URL,
  createProviderAdapter,
  createProviderRegistry,
} from "./factory.js";

export type {
  PreflightCheck,
  PreflightOptions,
  PreflightReport,
  PreflightStatus,
  ProviderPreflightReport,
} from "./preflight.js";
export { formatPreflightReport, preflightConfig, preflightProvider } from "./preflight.js";

export type {
  ProviderRecording,
  ProviderRecordingEntry,
  RecordingProviderOptions,
  ReplayProviderOptions,
  ScriptedProviderOptions,
} from "./testing.js";
export {
  createJsonScriptedProvider,
  createRecordingProvider,
  createReplayProvider,
  createScriptedProvider,
  recordingKey,
} from "./testing.js";
