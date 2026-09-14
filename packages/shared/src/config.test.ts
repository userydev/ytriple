import { describe, expect, it } from "vitest";
import {
  DEFAULT_SUBAGENT_POLICY,
  redactSecrets,
  resolveLimits,
  resolveSubAgentPolicy,
  type YtripleConfig,
} from "./config.js";

const config: YtripleConfig = {
  providers: [
    {
      providerId: "ark-default",
      kind: "ark",
      model: "doubao-seed-1-6-250615",
      apiKeyRef: { kind: "env", name: "ARK_API_KEY" },
      enableNativeWebSearch: true,
    },
  ],
  defaultModel: { providerId: "ark-default" },
};

describe("provider configuration", () => {
  it("stores a secret reference instead of key material", () => {
    const serialized = JSON.stringify(config);
    expect(serialized).toContain('"apiKeyRef"');
    expect(serialized).not.toMatch(/sk-|Bearer /);
    expect(config.providers[0]?.apiKeyRef).toEqual({ kind: "env", name: "ARK_API_KEY" });
  });

  it("merges partial limits over defaults", () => {
    expect(resolveLimits({ ...config, limits: { maxToolRounds: 5 } })).toMatchObject({
      maxToolRounds: 5,
      maxSchemaRepairAttempts: 2,
    });
  });

  it("merges partial sub-agent policy over defaults", () => {
    expect(resolveSubAgentPolicy({ ...config, subAgents: { tokenBudget: 100 } })).toEqual({
      ...DEFAULT_SUBAGENT_POLICY,
      tokenBudget: 100,
    });
  });
});

describe("redactSecrets", () => {
  it("masks key-like fields at any depth", () => {
    expect(
      redactSecrets({
        providerId: "ark",
        apiKey: "sk-live-123",
        nested: { authorization: "Bearer sk-live-123", model: "doubao" },
        list: [{ secret: "hunter2" }],
      }),
    ).toEqual({
      providerId: "ark",
      apiKey: "[redacted]",
      nested: { authorization: "[redacted]", model: "doubao" },
      list: [{ secret: "[redacted]" }],
    });
  });

  it("leaves non-secret data untouched", () => {
    expect(redactSecrets({ model: "gemini-2.5-flash", count: 3, ok: true })).toEqual({
      model: "gemini-2.5-flash",
      count: 3,
      ok: true,
    });
  });
});
