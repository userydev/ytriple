import type { YtripleConfig } from "@ytriple/shared";
import type { ProviderError } from "@ytriple/shared";
import { describe, expect, it } from "vitest";
import { createAdapter, createModelRouter } from "./factory.js";
import { createFakeHttpPort, createFakeSecretPort } from "./testSupport.js";

const http = createFakeHttpPort(() => ({ body: { output_text: "{}" } }));
const secrets = createFakeSecretPort({ ARK_API_KEY: "ark-secret", GOOGLE_API_KEY: "g-secret" });

const config: YtripleConfig = {
  providers: [
    {
      providerId: "ark-personal",
      adapterId: "ark",
      displayName: "Ark",
      credentialRef: "ARK_API_KEY",
      models: [{ modelId: "doubao-seed-1-6", displayName: "Doubao Seed 1.6" }],
    },
    {
      providerId: "gemini-fast",
      adapterId: "google",
      displayName: "Gemini Flash",
      credentialRef: "GOOGLE_API_KEY",
      models: [
        {
          modelId: "gemini-2.5-flash",
          displayName: "Gemini 2.5 Flash",
          capabilities: { maxContextTokens: 128_000, costTier: "cheap" },
        },
      ],
    },
  ],
  defaultModel: { providerId: "ark-personal", modelId: "doubao-seed-1-6" },
};

describe("createAdapter", () => {
  it("builds one adapter per family and applies per-model capability overrides", async () => {
    const ark = await createAdapter(config.providers[0]!, { http, secrets });
    const gemini = await createAdapter(config.providers[1]!, { http, secrets });

    expect(ark.adapterId).toBe("ark");
    expect(ark.describe(config.providers[0]!.models[0]!).nativeWebSearch).toBe(true);

    const geminiCapabilities = gemini.describe(config.providers[1]!.models[0]!);
    expect(geminiCapabilities.maxContextTokens).toBe(128_000);
    expect(geminiCapabilities.costTier).toBe("cheap");
    expect(geminiCapabilities.structuredOutput).toBe("json_schema");
  });

  it("names the credentialRef when a credential cannot be resolved", async () => {
    await expect(
      createAdapter(
        {
          providerId: "deepseek-personal",
          adapterId: "openai_compatible",
          displayName: "DeepSeek",
          baseUrl: "https://api.deepseek.com/v1",
          credentialRef: "DEEPSEEK_API_KEY",
          models: [{ modelId: "deepseek-chat", displayName: "DeepSeek Chat" }],
        },
        { http, secrets },
      ),
    ).rejects.toThrowError(/credentialRef "DEEPSEEK_API_KEY" could not be resolved/);
  });

  it("allows a local provider to run without a credential", async () => {
    const adapter = await createAdapter(
      {
        providerId: "ollama-local",
        adapterId: "openai_compatible",
        displayName: "Ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        credentialRef: "OLLAMA_API_KEY",
        credentialOptional: true,
        models: [{ modelId: "qwen3", displayName: "Qwen 3" }],
      },
      { http, secrets },
    );
    expect(adapter.adapterId).toBe("openai_compatible");
  });

  it("requires an explicit base URL for the compatible family", async () => {
    await expect(
      createAdapter(
        {
          providerId: "mystery",
          adapterId: "openai_compatible",
          displayName: "Mystery",
          credentialRef: "ARK_API_KEY",
          models: [{ modelId: "m", displayName: "M" }],
        },
        { http, secrets },
      ),
    ).rejects.toThrowError(/needs an explicit baseUrl/);
  });
});

describe("createModelRouter", () => {
  it("caches one adapter per provider and resolves the bound model", async () => {
    let built = 0;
    const router = createModelRouter(config, { http, secrets }, {
      adapterFactory: async (providerConfig, deps) => {
        built += 1;
        return createAdapter(providerConfig, deps);
      },
    });

    const first = await router.resolve({ providerId: "ark-personal", modelId: "doubao-seed-1-6" });
    const second = await router.resolve({ providerId: "ark-personal", modelId: "doubao-seed-1-6" });

    expect(first.adapter).toBe(second.adapter);
    expect(first.model.displayName).toBe("Doubao Seed 1.6");
    expect(built).toBe(1);
    expect(router.listProviders()).toEqual(["ark-personal", "gemini-fast"]);
  });

  it("reports the configured ids when a binding does not resolve", async () => {
    const router = createModelRouter(config, { http, secrets });

    await expect(router.resolve({ providerId: "nope", modelId: "x" })).rejects.toThrowError(
      /Unknown providerId "nope". Configured providers: ark-personal, gemini-fast/,
    );
    const error = (await router
      .resolve({ providerId: "ark-personal", modelId: "not-configured" })
      .catch((caught: unknown) => caught)) as ProviderError;
    expect(error.message).toMatch(/has no model "not-configured". Configured models: doubao-seed-1-6/);
  });
});
