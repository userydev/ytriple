import type { ProviderConfig } from "@ytriple/shared";

/**
 * The provider catalog a fresh install starts with.
 *
 * Pure data, shared by every host so the CLI and the desktop app agree on what
 * "DeepSeek" means without either of them hard-coding a vendor in code. Users
 * edit or replace it; adding a vendor is another entry here or in their own
 * configuration file.
 */
export interface DefaultModelOverrides {
  arkModelId?: string | undefined;
  googleModelId?: string | undefined;
  deepseekModelId?: string | undefined;
}

export function defaultProviderConfigs(
  overrides: DefaultModelOverrides = {},
): ProviderConfig[] {
  return [
    {
      providerId: "ark",
      adapterId: "ark",
      displayName: "Volcengine Ark",
      credentialRef: "ARK_API_KEY",
      models: [
        {
          modelId: overrides.arkModelId ?? "doubao-seed-1-6-250615",
          displayName: "Doubao Seed 1.6",
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
          modelId: overrides.googleModelId ?? "gemini-2.5-flash",
          displayName: "Gemini 2.5 Flash",
          capabilities: { costTier: "cheap" },
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
          modelId: overrides.deepseekModelId ?? "deepseek-chat",
          displayName: "DeepSeek Chat",
          capabilities: { structuredOutput: "json_mode", toolCalling: "sequential" },
        },
      ],
    },
  ];
}

export function defaultModelBinding(providers: ProviderConfig[]) {
  const first = providers[0];
  if (!first || !first.models[0]) {
    throw new Error("the default provider catalog is empty");
  }
  return { providerId: first.providerId, modelId: first.models[0].modelId };
}
