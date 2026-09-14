import type {
  ProviderAdapter,
  ProviderConfig,
  SecretsPort,
  YtripleConfig,
} from "@ytriple/shared";
import { findProviderConfig } from "@ytriple/shared";
import { capabilitiesFor } from "./capabilities.js";
import { createProviderAdapter, type ProviderDeps } from "./factory.js";

export type PreflightStatus = "ok" | "warn" | "fail";

export interface PreflightCheck {
  id: string;
  label: string;
  status: PreflightStatus;
  detail: string;
}

export interface ProviderPreflightReport {
  providerId: string;
  status: PreflightStatus;
  checks: PreflightCheck[];
}

export interface PreflightReport {
  status: PreflightStatus;
  checks: PreflightCheck[];
  providers: ProviderPreflightReport[];
}

export interface PreflightOptions {
  /** Issue one tiny live request per provider. Off by default: it costs money. */
  probeConnectivity?: boolean;
}

const PLACEHOLDER_KEYS = new Set(["", "changeme", "your-api-key", "xxx", "todo", "<your-key>"]);

/**
 * Configuration self-check. Everything here runs without touching the network
 * unless `probeConnectivity` is requested, so a desktop settings screen can run
 * it on every edit.
 */
export async function preflightConfig(
  config: YtripleConfig,
  deps: ProviderDeps,
  options: PreflightOptions = {},
): Promise<PreflightReport> {
  const checks: PreflightCheck[] = [];

  checks.push(checkProvidersPresent(config));
  checks.push(checkUniqueProviderIds(config));
  checks.push(checkDefaultBinding(config));
  checks.push(...checkAgentBindings(config));

  const providers: ProviderPreflightReport[] = [];
  for (const providerConfig of config.providers) {
    providers.push(await preflightProvider(providerConfig, deps, options));
  }

  return {
    status: worstStatus([...checks.map((check) => check.status), ...providers.map((report) => report.status)]),
    checks,
    providers,
  };
}

export async function preflightProvider(
  config: ProviderConfig,
  deps: ProviderDeps,
  options: PreflightOptions = {},
): Promise<ProviderPreflightReport> {
  const checks: PreflightCheck[] = [];

  checks.push(checkModel(config));
  checks.push(checkBaseUrl(config));
  checks.push(...checkCapabilityExpectations(config));
  checks.push(await checkCredential(config, deps.secrets));

  const credentialOk = checks.every((check) => check.status !== "fail");
  if (options.probeConnectivity && credentialOk) {
    checks.push(await probeProvider(config, deps));
  }

  return {
    providerId: config.providerId,
    status: worstStatus(checks.map((check) => check.status)),
    checks,
  };
}

function checkProvidersPresent(config: YtripleConfig): PreflightCheck {
  return config.providers.length > 0
    ? {
        id: "providers.present",
        label: "Providers configured",
        status: "ok",
        detail: `${config.providers.length} provider(s) configured`,
      }
    : {
        id: "providers.present",
        label: "Providers configured",
        status: "fail",
        detail: "No providers configured. Add at least one before running a task.",
      };
}

function checkUniqueProviderIds(config: YtripleConfig): PreflightCheck {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const provider of config.providers) {
    if (seen.has(provider.providerId)) duplicates.add(provider.providerId);
    seen.add(provider.providerId);
  }
  return duplicates.size === 0
    ? { id: "providers.unique", label: "Provider ids unique", status: "ok", detail: "No duplicates" }
    : {
        id: "providers.unique",
        label: "Provider ids unique",
        status: "fail",
        detail: `Duplicate providerId(s): ${[...duplicates].join(", ")}`,
      };
}

function checkDefaultBinding(config: YtripleConfig): PreflightCheck {
  const target = findProviderConfig(config, config.defaultModel.providerId);
  return target
    ? {
        id: "model.default",
        label: "Default model binding",
        status: "ok",
        detail: `defaultModel -> ${target.providerId} (${config.defaultModel.model ?? target.model})`,
      }
    : {
        id: "model.default",
        label: "Default model binding",
        status: "fail",
        detail: `defaultModel points at unknown provider "${config.defaultModel.providerId}"`,
      };
}

function checkAgentBindings(config: YtripleConfig): PreflightCheck[] {
  return Object.entries(config.agentModels ?? {}).map(([agentId, binding]) => {
    const target = findProviderConfig(config, binding.providerId);
    return target
      ? {
          id: `model.agent.${agentId}`,
          label: `Model binding for ${agentId}`,
          status: "ok" as const,
          detail: `${agentId} -> ${target.providerId} (${binding.model ?? target.model})`,
        }
      : {
          id: `model.agent.${agentId}`,
          label: `Model binding for ${agentId}`,
          status: "fail" as const,
          detail: `${agentId} points at unknown provider "${binding.providerId}"`,
        };
  });
}

function checkModel(config: ProviderConfig): PreflightCheck {
  return config.model.trim().length > 0
    ? {
        id: `${config.providerId}.model`,
        label: "Model name",
        status: "ok",
        detail: config.model,
      }
    : {
        id: `${config.providerId}.model`,
        label: "Model name",
        status: "fail",
        detail: "Model name is empty",
      };
}

function checkBaseUrl(config: ProviderConfig): PreflightCheck {
  const id = `${config.providerId}.baseUrl`;
  if (!config.baseUrl) {
    return config.kind === "openai_compatible"
      ? {
          id,
          label: "Base URL",
          status: "fail",
          detail: "openai_compatible providers require an explicit baseUrl",
        }
      : { id, label: "Base URL", status: "ok", detail: "Using the built-in default endpoint" };
  }

  try {
    const url = new URL(config.baseUrl);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      return {
        id,
        label: "Base URL",
        status: "warn",
        detail: `${config.baseUrl} is not HTTPS; credentials would travel in clear text`,
      };
    }
    return { id, label: "Base URL", status: "ok", detail: config.baseUrl };
  } catch {
    return { id, label: "Base URL", status: "fail", detail: `"${config.baseUrl}" is not a valid URL` };
  }
}

function checkCapabilityExpectations(config: ProviderConfig): PreflightCheck[] {
  const capabilities = capabilitiesFor(config.kind, config.capabilityOverrides);
  const checks: PreflightCheck[] = [
    {
      id: `${config.providerId}.capabilities`,
      label: "Declared capabilities",
      status: "ok",
      detail: `structuredOutput=${capabilities.structuredOutput}, nativeWebSearch=${capabilities.nativeWebSearch}, context=${capabilities.maxContextTokens}`,
    },
  ];

  if (config.enableNativeWebSearch && !capabilities.nativeWebSearch) {
    checks.push({
      id: `${config.providerId}.nativeWebSearch`,
      label: "Native web search",
      status: "warn",
      detail:
        "enableNativeWebSearch is set but this provider cannot search natively; research will fall back to the SearchPort",
    });
  }

  if (capabilities.structuredOutput === "text_only") {
    checks.push({
      id: `${config.providerId}.structuredOutput`,
      label: "Structured output",
      status: "warn",
      detail: "No JSON mode; the runtime will prompt for JSON and validate with repair retries",
    });
  }

  return checks;
}

async function checkCredential(
  config: ProviderConfig,
  secrets: SecretsPort,
): Promise<PreflightCheck> {
  const id = `${config.providerId}.credential`;
  const label = `Credential (${config.apiKeyRef.kind}:${config.apiKeyRef.name})`;

  if (config.apiKeyRef.kind === "inline_dev") {
    return {
      id,
      label,
      status: "warn",
      detail: "inline_dev secrets are for local development only; use keychain or env elsewhere",
    };
  }

  const value = await secrets.get(config.apiKeyRef.name);
  if (value === undefined) {
    return { id, label, status: "fail", detail: `Secret "${config.apiKeyRef.name}" is not set` };
  }
  if (PLACEHOLDER_KEYS.has(value.trim().toLowerCase())) {
    return { id, label, status: "fail", detail: "Secret is still a placeholder value" };
  }
  return { id, label, status: "ok", detail: `Resolved (${value.length} chars, value not logged)` };
}

async function probeProvider(
  config: ProviderConfig,
  deps: ProviderDeps,
): Promise<PreflightCheck> {
  const id = `${config.providerId}.probe`;
  try {
    const adapter: ProviderAdapter = await createProviderAdapter(config, deps);
    const response = await adapter.complete({
      system: "You are a connectivity probe. Answer with JSON only.",
      user: 'Reply with exactly {"ok":true}.',
      maxOutputTokens: 32,
      responseSchema: {
        name: "connectivity_probe",
        schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
      },
      metadata: { agentId: "preflight", phase: "probe", round: 0 },
    });
    return {
      id,
      label: "Connectivity probe",
      status: response.text.includes("ok") ? "ok" : "warn",
      detail: `Responded in ${response.usage.completionTokens} completion tokens`,
    };
  } catch (error) {
    return {
      id,
      label: "Connectivity probe",
      status: "fail",
      detail: error instanceof Error ? error.message : "Probe failed",
    };
  }
}

function worstStatus(statuses: PreflightStatus[]): PreflightStatus {
  if (statuses.includes("fail")) return "fail";
  if (statuses.includes("warn")) return "warn";
  return "ok";
}

export function formatPreflightReport(report: PreflightReport): string {
  const lines: string[] = [`Configuration self-check: ${report.status.toUpperCase()}`];
  const icon = (status: PreflightStatus) => (status === "ok" ? "✓" : status === "warn" ? "!" : "✗");

  for (const check of report.checks) {
    lines.push(`  ${icon(check.status)} ${check.label}: ${check.detail}`);
  }
  for (const provider of report.providers) {
    lines.push(`  ${icon(provider.status)} provider ${provider.providerId}`);
    for (const check of provider.checks) {
      lines.push(`      ${icon(check.status)} ${check.label}: ${check.detail}`);
    }
  }
  return lines.join("\n");
}
