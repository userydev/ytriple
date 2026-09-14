import type { YtripleConfig } from "@ytriple/shared";
import { describe, expect, it } from "vitest";
import { formatPreflightReport, preflightConfig } from "./preflight.js";
import { createFakeHttpPort, createFakeSecretsPort } from "./testSupport.js";

const http = createFakeHttpPort(() => ({
  body: { output_text: '{"ok":true}', usage: { input_tokens: 4, output_tokens: 3 } },
}));

function checkById(checks: Array<{ id: string; status: string; detail: string }>, id: string) {
  const check = checks.find((entry) => entry.id === id);
  if (!check) throw new Error(`No check ${id} in ${checks.map((entry) => entry.id).join(", ")}`);
  return check;
}

describe("preflightConfig", () => {
  const secrets = createFakeSecretsPort({
    ARK_API_KEY: "ark-secret-value",
    PLACEHOLDER_KEY: "changeme",
  });

  it("passes a well-formed configuration without touching the network", async () => {
    const config: YtripleConfig = {
      providers: [
        {
          providerId: "ark-default",
          kind: "ark",
          model: "doubao-seed-1-6",
          apiKeyRef: { kind: "env", name: "ARK_API_KEY" },
          enableNativeWebSearch: true,
        },
      ],
      defaultModel: { providerId: "ark-default" },
    };

    const report = await preflightConfig(config, { http, secrets });

    expect(report.status).toBe("ok");
    expect(http.calls).toHaveLength(0);
    expect(checkById(report.providers[0]!.checks, "ark-default.credential").detail).toBe(
      "Resolved (16 chars, value not logged)",
    );
  });

  it("never puts secret material in the report", async () => {
    const config: YtripleConfig = {
      providers: [
        {
          providerId: "ark-default",
          kind: "ark",
          model: "doubao-seed-1-6",
          apiKeyRef: { kind: "env", name: "ARK_API_KEY" },
        },
      ],
      defaultModel: { providerId: "ark-default" },
    };

    const report = await preflightConfig(config, { http, secrets });
    expect(JSON.stringify(report)).not.toContain("ark-secret-value");
    expect(formatPreflightReport(report)).not.toContain("ark-secret-value");
  });

  it("reports every configuration defect it can find", async () => {
    const config: YtripleConfig = {
      providers: [
        {
          providerId: "dup",
          kind: "openai_compatible",
          model: "",
          apiKeyRef: { kind: "env", name: "MISSING_KEY" },
        },
        {
          providerId: "dup",
          kind: "deepseek",
          model: "deepseek-chat",
          baseUrl: "http://insecure.example/v1",
          apiKeyRef: { kind: "env", name: "PLACEHOLDER_KEY" },
          enableNativeWebSearch: true,
        },
      ],
      defaultModel: { providerId: "not-configured" },
      agentModels: { researcher: { providerId: "also-missing" } },
    };

    const report = await preflightConfig(config, { http, secrets });

    expect(report.status).toBe("fail");
    expect(checkById(report.checks, "providers.unique").detail).toBe("Duplicate providerId(s): dup");
    expect(checkById(report.checks, "model.default").status).toBe("fail");
    expect(checkById(report.checks, "model.agent.researcher").status).toBe("fail");

    const first = report.providers[0]!.checks;
    expect(checkById(first, "dup.model").status).toBe("fail");
    expect(checkById(first, "dup.baseUrl").detail).toContain("require an explicit baseUrl");
    expect(checkById(first, "dup.credential").detail).toContain('Secret "MISSING_KEY" is not set');

    const second = report.providers[1]!.checks;
    expect(checkById(second, "dup.baseUrl").status).toBe("warn");
    expect(checkById(second, "dup.nativeWebSearch").detail).toContain("fall back to the SearchPort");
    expect(checkById(second, "dup.credential").detail).toBe("Secret is still a placeholder value");
  });

  it("probes connectivity only when asked", async () => {
    const config: YtripleConfig = {
      providers: [
        {
          providerId: "ark-default",
          kind: "ark",
          model: "doubao-seed-1-6",
          apiKeyRef: { kind: "env", name: "ARK_API_KEY" },
        },
      ],
      defaultModel: { providerId: "ark-default" },
    };

    const report = await preflightConfig(config, { http, secrets }, { probeConnectivity: true });

    expect(http.calls).toHaveLength(1);
    expect(checkById(report.providers[0]!.checks, "ark-default.probe").status).toBe("ok");
  });
});
