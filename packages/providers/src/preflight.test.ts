import type { YtripleConfig } from "@ytriple/shared";
import { describe, expect, it } from "vitest";
import { formatPreflightReport, preflightConfig } from "./preflight.js";
import { createFakeHttpPort, createFakeSecretPort } from "./testSupport.js";

const secrets = createFakeSecretPort({
  ARK_API_KEY: "ark-secret-value",
  PLACEHOLDER_KEY: "changeme",
});

function checkById(checks: Array<{ id: string; status: string; detail: string }>, id: string) {
  const check = checks.find((entry) => entry.id === id);
  if (!check) throw new Error(`No check ${id} in ${checks.map((entry) => entry.id).join(", ")}`);
  return check;
}

const healthyConfig: YtripleConfig = {
  providers: [
    {
      providerId: "ark-personal",
      adapterId: "ark",
      displayName: "Ark",
      credentialRef: "ARK_API_KEY",
      models: [{ modelId: "doubao-seed-1-6", displayName: "Doubao" }],
    },
  ],
  defaultModel: { providerId: "ark-personal", modelId: "doubao-seed-1-6" },
};

describe("preflightConfig", () => {
  it("passes a well-formed configuration without touching the network", async () => {
    const http = createFakeHttpPort(() => ({ body: {} }));
    const report = await preflightConfig(healthyConfig, { http, secrets });

    expect(report.status).toBe("ok");
    expect(http.calls).toHaveLength(0);
    expect(checkById(report.providers[0]!.checks, "ark-personal.credential").detail).toBe(
      "Resolved (16 chars, value not logged)",
    );
  });

  it("never puts credential material in the report", async () => {
    const http = createFakeHttpPort(() => ({ body: {} }));
    const report = await preflightConfig(healthyConfig, { http, secrets });

    expect(JSON.stringify(report)).not.toContain("ark-secret-value");
    expect(formatPreflightReport(report)).not.toContain("ark-secret-value");
    expect(formatPreflightReport(report)).toContain("ARK_API_KEY");
  });

  it("reports every configuration defect it can find", async () => {
    const http = createFakeHttpPort(() => ({ body: {} }));
    const config: YtripleConfig = {
      providers: [
        {
          providerId: "dup",
          adapterId: "openai_compatible",
          displayName: "No base URL",
          credentialRef: "MISSING_KEY",
          models: [],
        },
        {
          providerId: "dup",
          adapterId: "openai_compatible",
          displayName: "Insecure",
          baseUrl: "http://insecure.example/v1",
          credentialRef: "PLACEHOLDER_KEY",
          models: [
            { modelId: "local", displayName: "Local", capabilities: { toolCalling: "none" } },
          ],
        },
      ],
      defaultModel: { providerId: "not-configured", modelId: "x" },
      agentModels: { "member-a": { providerId: "dup", modelId: "also-missing" } },
    };

    const report = await preflightConfig(config, { http, secrets });

    expect(report.status).toBe("fail");
    expect(checkById(report.checks, "providers.unique").detail).toBe("Duplicate providerId(s): dup");
    expect(checkById(report.checks, "model.default").status).toBe("fail");
    expect(checkById(report.checks, "model.agent.member-a").status).toBe("fail");

    const first = report.providers[0]!.checks;
    expect(checkById(first, "dup.models").detail).toBe("Provider has no models configured");
    expect(checkById(first, "dup.baseUrl").detail).toContain("requires an explicit baseUrl");
    expect(checkById(first, "dup.credential").detail).toContain('Could not resolve "MISSING_KEY"');

    const second = report.providers[1]!.checks;
    expect(checkById(second, "dup.baseUrl").status).toBe("warn");
    expect(checkById(second, "dup.capabilities.local").detail).toContain("no tool calling");
    expect(checkById(second, "dup.credential").detail).toBe("Credential is still a placeholder value");
  });

  it("runs the live self-check only when asked and surfaces capability mismatches", async () => {
    const http = createFakeHttpPort((_init, call) =>
      call === 0
        ? { body: { output_text: '{"ok":true}', usage: { input_tokens: 4, output_tokens: 3 } } }
        : // Second probe: the model ignores the tool it claims to support.
          { body: { output_text: "I cannot call tools." } },
    );

    const report = await preflightConfig(healthyConfig, { http, secrets }, {
      runHealthChecks: true,
      now: () => 1_000,
    });

    expect(http.calls).toHaveLength(2);
    expect(checkById(report.providers[0]!.checks, "ark-personal.healthCheck.doubao-seed-1-6")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("declares toolCalling=sequential but returned no tool call"),
    });
  });
});
