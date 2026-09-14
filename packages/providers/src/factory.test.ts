import type { YtripleConfig } from "@ytriple/shared";
import { describe, expect, it } from "vitest";
import { createProviderAdapter, createProviderRegistry } from "./factory.js";
import { createFakeHttpPort, createFakeSecretsPort } from "./testSupport.js";

const http = createFakeHttpPort(() => ({ body: { output_text: "{}" } }));
const secrets = createFakeSecretsPort({ ARK_API_KEY: "ark-secret", GOOGLE_API_KEY: "g-secret" });

const config: YtripleConfig = {
  providers: [
    {
      providerId: "ark-default",
      kind: "ark",
      model: "doubao-seed-1-6",
      apiKeyRef: { kind: "env", name: "ARK_API_KEY" },
    },
    {
      providerId: "gemini-fast",
      kind: "google",
      model: "gemini-2.5-flash",
      apiKeyRef: { kind: "env", name: "GOOGLE_API_KEY" },
      capabilityOverrides: { maxContextTokens: 128_000 },
    },
  ],
  defaultModel: { providerId: "ark-default" },
};

describe("createProviderAdapter", () => {
  it("builds adapters per kind and applies capability overrides", async () => {
    const ark = await createProviderAdapter(config.providers[0]!, { http, secrets });
    const gemini = await createProviderAdapter(config.providers[1]!, { http, secrets });

    expect(ark.kind).toBe("ark");
    expect(ark.capabilities.nativeWebSearch).toBe(true);
    expect(gemini.kind).toBe("google");
    expect(gemini.capabilities.maxContextTokens).toBe(128_000);
  });

  it("fails with a pointer to the secret ref when a credential is missing", async () => {
    await expect(
      createProviderAdapter(
        {
          providerId: "deepseek",
          kind: "deepseek",
          model: "deepseek-chat",
          apiKeyRef: { kind: "env", name: "DEEPSEEK_API_KEY" },
        },
        { http, secrets },
      ),
    ).rejects.toThrowError(/secret ref "DEEPSEEK_API_KEY" \(env\) is unset/);
  });

  it("requires an explicit base URL for generic OpenAI-compatible endpoints", async () => {
    await expect(
      createProviderAdapter(
        {
          providerId: "local",
          kind: "openai_compatible",
          model: "qwen",
          apiKeyRef: { kind: "env", name: "ARK_API_KEY" },
        },
        { http, secrets },
      ),
    ).rejects.toThrowError(/needs an explicit baseUrl/);
  });
});

describe("createProviderRegistry", () => {
  it("caches adapters per provider id", async () => {
    let built = 0;
    const registry = createProviderRegistry(config, { http, secrets }, {
      adapterFactory: async (providerConfig, deps) => {
        built += 1;
        return createProviderAdapter(providerConfig, deps);
      },
    });

    const first = await registry.get("ark-default");
    const second = await registry.get("ark-default");

    expect(first).toBe(second);
    expect(built).toBe(1);
    expect(registry.listConfigured()).toEqual(["ark-default", "gemini-fast"]);
  });

  it("names the configured providers when an id is unknown", async () => {
    const registry = createProviderRegistry(config, { http, secrets });
    await expect(registry.get("nope")).rejects.toThrowError(
      /Unknown providerId "nope". Configured providers: ark-default, gemini-fast/,
    );
  });
});
