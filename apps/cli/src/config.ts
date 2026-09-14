import { readFile } from "node:fs/promises";
import { defaultModelBinding, defaultProviderConfigs } from "@ytriple/providers";
import type { ModelBinding, ProviderConfig, YtripleConfig } from "@ytriple/shared";

/**
 * Provider configuration for the harness. The catalog itself is shared data
 * from `@ytriple/providers`; the harness only decides which model ids the
 * environment overrides and which credential each one refers to.
 */
export function builtInProviders(env: NodeJS.ProcessEnv = process.env): ProviderConfig[] {
  return defaultProviderConfigs({
    arkModelId: env.ARK_MODEL,
    googleModelId: env.GOOGLE_MODEL,
    deepseekModelId: env.DEEPSEEK_MODEL,
  });
}

export function defaultConfig(
  env: NodeJS.ProcessEnv = process.env,
  defaultModel?: ModelBinding,
): YtripleConfig {
  const providers = builtInProviders(env);
  return { providers, defaultModel: defaultModel ?? defaultModelBinding(providers) };
}

export async function loadConfig(
  path: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<YtripleConfig> {
  if (!path) return defaultConfig(env);

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
