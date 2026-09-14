import { readFile } from "node:fs/promises";
import type { ModelBinding, ProviderConfig, YtripleConfig } from "@ytriple/shared";

/**
 * Provider configuration for the harness.
 *
 * Everything here is data: adding a vendor means adding an entry, never
 * touching core. Credentials are referenced by environment variable name and
 * resolved through the SecretPort at call time.
 */
export const BUILT_IN_PROVIDERS: ProviderConfig[] = [
  {
    providerId: "ark",
    adapterId: "ark",
    displayName: "Volcengine Ark",
    credentialRef: "ARK_API_KEY",
    models: [
      {
        modelId: process.env.ARK_MODEL ?? "doubao-seed-1-6-250615",
        displayName: "Ark default model",
        capabilities: { nativeWebSearch: true, structuredOutput: "json_schema" },
      },
    ],
  },
  {
    providerId: "google",
    adapterId: "google",
    displayName: "Google Gemini",
    credentialRef: "GOOGLE_API_KEY",
    models: [
      {
        modelId: process.env.GOOGLE_MODEL ?? "gemini-2.5-flash",
        displayName: "Gemini Flash",
      },
    ],
  },
  {
    providerId: "deepseek",
    adapterId: "openai_compatible",
    displayName: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    credentialRef: "DEEPSEEK_API_KEY",
    models: [
      {
        modelId: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
        displayName: "DeepSeek Chat",
        capabilities: { structuredOutput: "json_mode", toolCalling: "sequential" },
      },
    ],
  },
];

export function defaultConfig(defaultModel?: ModelBinding): YtripleConfig {
  return {
    providers: BUILT_IN_PROVIDERS,
    defaultModel: defaultModel ?? { providerId: "ark", modelId: BUILT_IN_PROVIDERS[0]!.models[0]!.modelId },
  };
}

export async function loadConfig(path: string | undefined): Promise<YtripleConfig> {
  if (!path) return defaultConfig();

  const raw = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${path} does not contain a configuration object`);
  }

  const config = parsed as Partial<YtripleConfig>;
  if (!Array.isArray(config.providers) || config.providers.length === 0) {
    throw new Error(`${path} has no providers`);
  }
  if (!config.defaultModel) {
    throw new Error(`${path} has no defaultModel binding`);
  }

  return config as YtripleConfig;
}
