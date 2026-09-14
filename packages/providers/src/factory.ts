import type {
  HttpPort,
  ModelBinding,
  ModelConfig,
  ProviderAdapter,
  ProviderConfig,
  SecretPort,
  YtripleConfig,
} from "@ytriple/shared";
import { ProviderError, findProviderConfig } from "@ytriple/shared";
import { ARK_DEFAULT_BASE_URL, createArkAdapter } from "./ark.js";
import { GOOGLE_DEFAULT_BASE_URL, createGoogleAdapter } from "./google.js";
import { createOpenAiCompatibleAdapter } from "./openaiCompatible.js";

export interface ProviderDeps {
  http: HttpPort;
  secrets: SecretPort;
}

export interface ResolvedModel {
  adapter: ProviderAdapter;
  model: ModelConfig;
}

/**
 * Resolves `ModelBinding -> { adapter, model }`. Core holds this interface and
 * never learns which vendor is behind an id, so adding a vendor stays a
 * configuration change.
 */
export interface ModelRouter {
  resolve(binding: ModelBinding): Promise<ResolvedModel>;
  listProviders(): string[];
}

export async function createAdapter(
  config: ProviderConfig,
  deps: ProviderDeps,
): Promise<ProviderAdapter> {
  const apiKey = await resolveCredential(config, deps.secrets);

  switch (config.adapterId) {
    case "ark":
      if (!apiKey) {
        throw new ProviderError(`Provider ${config.providerId} requires a credential`, {
          providerId: config.providerId,
          code: "auth_failed",
        });
      }
      return createArkAdapter({
        providerId: config.providerId,
        baseUrl: config.baseUrl ?? ARK_DEFAULT_BASE_URL,
        apiKey,
        http: deps.http,
      });
    case "google":
      if (!apiKey) {
        throw new ProviderError(`Provider ${config.providerId} requires a credential`, {
          providerId: config.providerId,
          code: "auth_failed",
        });
      }
      return createGoogleAdapter({
        providerId: config.providerId,
        baseUrl: config.baseUrl ?? GOOGLE_DEFAULT_BASE_URL,
        apiKey,
        http: deps.http,
      });
    case "openai_compatible":
      if (!config.baseUrl) {
        throw new ProviderError(
          `Provider ${config.providerId} uses the openai_compatible adapter and needs an explicit baseUrl`,
          { providerId: config.providerId, code: "unsupported" },
        );
      }
      return createOpenAiCompatibleAdapter({
        providerId: config.providerId,
        baseUrl: config.baseUrl,
        ...(apiKey ? { apiKey } : {}),
        http: deps.http,
      });
  }
}

export interface ModelRouterOptions {
  /** Swapped by tests and by the CLI harness to run against a recording. */
  adapterFactory?: (config: ProviderConfig, deps: ProviderDeps) => Promise<ProviderAdapter>;
}

export function createModelRouter(
  config: Pick<YtripleConfig, "providers">,
  deps: ProviderDeps,
  options: ModelRouterOptions = {},
): ModelRouter {
  const factory = options.adapterFactory ?? createAdapter;
  const cache = new Map<string, Promise<ProviderAdapter>>();

  return {
    listProviders: () => config.providers.map((provider) => provider.providerId),
    async resolve(binding) {
      const providerConfig = findProviderConfig(config, binding.providerId);
      if (!providerConfig) {
        throw new ProviderError(
          `Unknown providerId "${binding.providerId}". Configured providers: ${
            config.providers.map((provider) => provider.providerId).join(", ") || "none"
          }`,
          { providerId: binding.providerId, code: "unsupported" },
        );
      }

      const model = providerConfig.models.find((entry) => entry.modelId === binding.modelId);
      if (!model) {
        throw new ProviderError(
          `Provider "${binding.providerId}" has no model "${binding.modelId}". Configured models: ${
            providerConfig.models.map((entry) => entry.modelId).join(", ") || "none"
          }`,
          { providerId: binding.providerId, code: "unsupported" },
        );
      }

      let pending = cache.get(binding.providerId);
      if (!pending) {
        pending = factory(providerConfig, deps);
        cache.set(binding.providerId, pending);
      }

      return { adapter: await pending, model };
    },
  };
}

async function resolveCredential(
  config: ProviderConfig,
  secrets: SecretPort,
): Promise<string | undefined> {
  try {
    const value = await secrets.resolve(config.credentialRef);
    if (value) return value;
  } catch (error) {
    if (!config.credentialOptional) {
      throw new ProviderError(
        `No credential for ${config.providerId}: credentialRef "${config.credentialRef}" could not be resolved (${
          error instanceof Error ? error.message : "unknown error"
        })`,
        { providerId: config.providerId, code: "auth_failed" },
      );
    }
    return undefined;
  }

  if (config.credentialOptional) return undefined;
  throw new ProviderError(
    `No credential for ${config.providerId}: credentialRef "${config.credentialRef}" resolved to an empty value`,
    { providerId: config.providerId, code: "auth_failed" },
  );
}
