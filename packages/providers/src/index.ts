export { PROVIDERS_PACKAGE_VERSION } from "./version.js";

export type { AdapterDescription } from "./capabilities.js";
export {
  ADAPTER_BASELINE_CAPABILITIES,
  ADAPTER_CATALOG,
  KNOWN_OPENAI_COMPATIBLE_ENDPOINTS,
  baselineFor,
} from "./capabilities.js";

export { resolveCapabilities } from "./adapterSupport.js";

export type { OpenAiCompatibleAdapterOptions } from "./openaiCompatible.js";
export { createOpenAiCompatibleAdapter } from "./openaiCompatible.js";

export type { ArkAdapterOptions } from "./ark.js";
export { ARK_DEFAULT_BASE_URL, createArkAdapter } from "./ark.js";

export type { GoogleAdapterOptions } from "./google.js";
export { GOOGLE_DEFAULT_BASE_URL, createGoogleAdapter, toGeminiSchema } from "./google.js";

export type { HealthCheckOptions } from "./healthCheck.js";
export { runHealthCheck } from "./healthCheck.js";

export type {
  ModelRouter,
  ModelRouterOptions,
  ProviderDeps,
  ResolvedModel,
} from "./factory.js";
export { createAdapter, createModelRouter } from "./factory.js";

export type {
  PreflightCheck,
  PreflightOptions,
  PreflightReport,
  PreflightStatus,
  ProviderPreflightReport,
} from "./preflight.js";
export { formatPreflightReport, preflightConfig, preflightProvider } from "./preflight.js";

export type {
  PhaseHandler,
  ProviderRecording,
  ProviderRecordingEntry,
  RecordingAdapter,
  RecordingAdapterOptions,
  ReplayAdapterOptions,
  ScriptedAdapter,
  ScriptedAdapterOptions,
} from "./testing.js";
export {
  createJsonScriptedAdapter,
  createRecordingAdapter,
  createReplayAdapter,
  createReplayRouter,
  createScriptedAdapter,
  recordingKey,
} from "./testing.js";

export type { RecordedScenario, RecordedScenarioEntry } from "./scenarios.js";
export {
  DEMO_SCENARIO,
  SCENARIOS,
  findScenario,
  scenarioNames,
  scenarioToRecording,
} from "./scenarios.js";

export type { DefaultModelOverrides } from "./defaults.js";
export { defaultModelBinding, defaultProviderConfigs } from "./defaults.js";
