import { describe, expect, it } from "vitest";
import {
  findModelConfig,
  redactSecrets,
  resolveLimits,
  resolveWorkspacePolicy,
  type YtripleConfig,
} from "./config.js";

const config: YtripleConfig = {
  providers: [
    {
      providerId: "ark-personal",
      adapterId: "ark",
      displayName: "Ark (personal key)",
      credentialRef: "ARK_API_KEY",
      models: [{ modelId: "doubao-seed-1-6-250615", displayName: "Doubao Seed 1.6" }],
    },
  ],
  defaultModel: { providerId: "ark-personal", modelId: "doubao-seed-1-6-250615" },
};

describe("provider configuration", () => {
  it("stores a credential reference instead of key material", () => {
    const serialized = JSON.stringify(config);
    expect(serialized).toContain('"credentialRef":"ARK_API_KEY"');
    expect(serialized).not.toMatch(/sk-|Bearer /);
  });

  it("resolves a model binding to its provider and model config", () => {
    const resolved = findModelConfig(config, config.defaultModel);
    expect(resolved?.provider.adapterId).toBe("ark");
    expect(resolved?.model.displayName).toBe("Doubao Seed 1.6");
  });

  it("returns nothing when the binding points at a model the provider lacks", () => {
    expect(
      findModelConfig(config, { providerId: "ark-personal", modelId: "not-configured" }),
    ).toBeUndefined();
  });

  it("merges partial limits and workspace policy over defaults", () => {
    expect(resolveLimits({ limits: { maxToolRounds: 5 } })).toMatchObject({
      maxToolRounds: 5,
      maxSchemaRepairAttempts: 2,
    });
    expect(resolveWorkspacePolicy({ workspace: { maxFiles: 10 } }).excludeGlobs).toContain(
      "node_modules/**",
    );
  });
});

describe("redactSecrets", () => {
  it("masks key-like fields at any depth", () => {
    expect(
      redactSecrets({
        providerId: "ark",
        apiKey: "sk-live-123",
        nested: { authorization: "Bearer sk-live-123", modelId: "doubao" },
        list: [{ secret: "hunter2" }],
      }),
    ).toEqual({
      providerId: "ark",
      apiKey: "[redacted]",
      nested: { authorization: "[redacted]", modelId: "doubao" },
      list: [{ secret: "[redacted]" }],
    });
  });

  it("keeps credentialRef readable because it is a name, not a secret", () => {
    expect(redactSecrets({ credentialRef: "ARK_API_KEY" })).toEqual({
      credentialRef: "ARK_API_KEY",
    });
  });
});
