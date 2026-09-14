import type {
  HttpPort,
  ProviderAdapter,
  ProviderConfig,
  SecretsPort,
  YtripleConfig,
} from "@ytriple/shared";
import { ProviderError, findProviderConfig } from "@ytriple/shared";
import { ARK_DEFAULT_BASE_URL, createArkProvider } from "./ark.js";
import { capabilitiesFor } from "./capabilities.js";
import { GOOGLE_DEFAULT_BASE_URL, createGoogleProvider } from "./google.js";
import { createOpenAiCompatibleProvider } from "./openaiCompatible.js";

export const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com/v1";

export interface ProviderDeps {
  http: HttpPort;
  secrets: SecretsPort;
}

export interface ProviderRegistry {
  get(providerId: string): Promise<ProviderAdapter>;
  listConfigured(): string[];
}

export async function createProviderAdapter(
  config: ProviderConfig,
  deps: ProviderDeps,
): Promise<ProviderAdapter> {
  const capabilities = capabilitiesFor(config.kind, config.capabilityOverrides);
  const apiKey = await resolveApiKey(config, deps.secrets);

  switch (config.kind) {
    case "ark":
      return createArkProvider({
        providerId: config.providerId,
        model: config.model,
        baseUrl: config.baseUrl ?? ARK_DEFAULT_BASE_URL,
        apiKey,
        capabilities,
        http: deps.http,
      });
    case "google":
      return createGoogleProvider({
        providerId: config.providerId,
        model: config.model,
        baseUrl: config.baseUrl ?? GOOGLE_DEFAULT_BASE_URL,
        apiKey,
        capabilities,
        http: deps.http,
      });
    case "deepseek":
      return createOpenAiCompatibleProvider({
        providerId: config.providerId,
        model: config.model,
        baseUrl: config.baseUrl ?? DEEPSEEK_DEFAULT_BASE_URL,
        apiKey,
        capabilities,
        http: deps.http,
        kind: "deepseek",
      });
    case "openai_compatible": {
      if (!config.baseUrl) {
        throw new ProviderError(
          `Provider ${config.providerId} is openai_compatible and needs an explicit baseUrl`,
          { providerId: config.providerId },
        );
      }
      return createOpenAiCompatibleProvider({
        providerId: config.providerId,
        model: config.model,
        baseUrl: config.baseUrl,
        apiKey,
        capabilities,
        http: deps.http,
      });
    }
  }
}

export interface ProviderRegistryOptions {
  /** Swapped in tests and by the CLI harness to run against a recording. */
  adapterFactory?: (config: ProviderConfig, deps: ProviderDeps) => Promise<ProviderAdapter>;
}

export function createProviderRegistry(
  config: YtripleConfig,
  deps: ProviderDeps,
  options: ProviderRegistryOptions = {},
): ProviderRegistry {
  const factory = options.adapterFactory ?? createProviderAdapter;
  const cache = new Map<string, Promise<ProviderAdapter>>();

  return {
    listConfigured: () => config.providers.map((provider) => provider.providerId),
    get(providerId: string) {
      const cached = cache.get(providerId);
      if (cached) return cached;

      const providerConfig = findProviderConfig(config, providerId);
      if (!providerConfig) {
        return Promise.reject(
          new ProviderError(
            `Unknown providerId "${providerId}". Configured providers: ${
              config.providers.map((provider) => provider.providerId).join(", ") || "none"
            }`,
            { providerId },
          ),
        );
      }

      const pending = factory(providerConfig, deps);
      cache.set(providerId, pending);
      return pending;
    },
  };
}

async function resolveApiKey(config: ProviderConfig, secrets: SecretsPort): Promise<string> {
  const apiKey = await secrets.get(config.apiKeyRef.name);
  if (!apiKey) {
    throw new ProviderError(
      `No credential found for ${config.providerId}: secret ref "${config.apiKeyRef.name}" (${config.apiKeyRef.kind}) is unset`,
      { providerId: config.providerId },
    );
  }
  return apiKey;
}
