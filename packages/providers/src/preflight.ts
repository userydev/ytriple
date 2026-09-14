import type { ProviderConfig, YtripleConfig } from "@ytriple/shared";
import { findModelConfig } from "@ytriple/shared";
import { baselineFor } from "./capabilities.js";
import { createAdapter, type ProviderDeps } from "./factory.js";
import { runHealthCheck } from "./healthCheck.js";

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
  /** Run the live self-check for every provider. Off by default: it costs money. */
  runHealthChecks?: boolean;
  now?: () => number;
}

const PLACEHOLDER_CREDENTIALS = new Set(["", "changeme", "your-api-key", "xxx", "todo", "<your-key>"]);

/**
 * Configuration self-check. Everything is offline unless `runHealthChecks` is
 * requested, so a settings screen can run it on every edit.
 */
export async function preflightConfig(
  config: YtripleConfig,
  deps: ProviderDeps,
  options: PreflightOptions = {},
): Promise<PreflightReport> {
  const checks: PreflightCheck[] = [
    checkProvidersPresent(config),
    checkUniqueProviderIds(config),
    checkBinding(config, "model.default", "Default model binding", config.defaultModel),
    ...Object.entries(config.agentModels ?? {}).map(([agentId, binding]) =>
      checkBinding(config, `model.agent.${agentId}`, `Model binding for ${agentId}`, binding),
    ),
  ];

  const providers: ProviderPreflightReport[] = [];
  for (const providerConfig of config.providers) {
    providers.push(await preflightProvider(providerConfig, deps, options));
  }

  return {
    status: worstStatus([
      ...checks.map((check) => check.status),
      ...providers.map((report) => report.status),
    ]),
    checks,
    providers,
  };
}

export async function preflightProvider(
  config: ProviderConfig,
  deps: ProviderDeps,
  options: PreflightOptions = {},
): Promise<ProviderPreflightReport> {
  const checks: PreflightCheck[] = [
    checkModels(config),
    checkBaseUrl(config),
    ...checkCapabilities(config),
    await checkCredential(config, deps),
  ];

  if (options.runHealthChecks && checks.every((check) => check.status !== "fail")) {
    checks.push(...(await runProviderHealthChecks(config, deps, options)));
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

function checkBinding(
  config: YtripleConfig,
  id: string,
  label: string,
  binding: { providerId: string; modelId: string },
): PreflightCheck {
  const resolved = findModelConfig(config, binding);
  return resolved
    ? {
        id,
        label,
        status: "ok",
        detail: `${binding.providerId} / ${binding.modelId}`,
      }
    : {
        id,
        label,
        status: "fail",
        detail: `"${binding.providerId} / ${binding.modelId}" is not a configured provider+model pair`,
      };
}

function checkModels(config: ProviderConfig): PreflightCheck {
  const id = `${config.providerId}.models`;
  if (config.models.length === 0) {
    return { id, label: "Models", status: "fail", detail: "Provider has no models configured" };
  }
  const unnamed = config.models.filter((model) => model.modelId.trim().length === 0);
  return unnamed.length > 0
    ? { id, label: "Models", status: "fail", detail: `${unnamed.length} model(s) have an empty modelId` }
    : {
        id,
        label: "Models",
        status: "ok",
        detail: config.models.map((model) => model.modelId).join(", "),
      };
}

function checkBaseUrl(config: ProviderConfig): PreflightCheck {
  const id = `${config.providerId}.baseUrl`;
  if (!config.baseUrl) {
    return config.adapterId === "openai_compatible"
      ? {
          id,
          label: "Base URL",
          status: "fail",
          detail: "the openai_compatible adapter requires an explicit baseUrl",
        }
      : { id, label: "Base URL", status: "ok", detail: "Using the adapter's default endpoint" };
  }

  try {
    const url = new URL(config.baseUrl);
    const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !isLocal) {
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

function checkCapabilities(config: ProviderConfig): PreflightCheck[] {
  const baseline = baselineFor(config.adapterId);
  return config.models.map((model) => {
    const capabilities = { ...baseline, ...model.capabilities };
    const notes: string[] = [];
    if (capabilities.structuredOutput === "none") {
      notes.push("no JSON mode: only non-orchestrator members may use it");
    }
    if (capabilities.toolCalling === "none") {
      notes.push("no tool calling: only members with an empty tool allowlist may use it");
    }
    return {
      id: `${config.providerId}.capabilities.${model.modelId}`,
      label: `Capabilities for ${model.modelId}`,
      status: notes.length > 0 ? ("warn" as const) : ("ok" as const),
      detail: [
        `structuredOutput=${capabilities.structuredOutput}`,
        `toolCalling=${capabilities.toolCalling}`,
        `nativeWebSearch=${capabilities.nativeWebSearch}`,
        `context=${capabilities.maxContextTokens}`,
        ...notes,
      ].join(", "),
    };
  });
}

async function checkCredential(
  config: ProviderConfig,
  deps: ProviderDeps,
): Promise<PreflightCheck> {
  const id = `${config.providerId}.credential`;
  const label = `Credential (${config.credentialRef})`;

  let value: string | undefined;
  try {
    value = await deps.secrets.resolve(config.credentialRef);
  } catch (error) {
    value = undefined;
    if (!config.credentialOptional) {
      return {
        id,
        label,
        status: "fail",
        detail: `Could not resolve "${config.credentialRef}": ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      };
    }
  }

  if (!value) {
    return config.credentialOptional
      ? { id, label, status: "ok", detail: "No credential needed for this provider" }
      : { id, label, status: "fail", detail: `Credential "${config.credentialRef}" is not set` };
  }
  if (PLACEHOLDER_CREDENTIALS.has(value.trim().toLowerCase())) {
    return { id, label, status: "fail", detail: "Credential is still a placeholder value" };
  }
  return { id, label, status: "ok", detail: `Resolved (${value.length} chars, value not logged)` };
}

async function runProviderHealthChecks(
  config: ProviderConfig,
  deps: ProviderDeps,
  options: PreflightOptions,
): Promise<PreflightCheck[]> {
  try {
    const adapter = await createAdapter(config, deps);
    const results: PreflightCheck[] = [];

    for (const model of config.models) {
      const health = await runHealthCheck(adapter, model, {
        ...(options.now ? { now: options.now } : {}),
      });
      const id = `${config.providerId}.healthCheck.${model.modelId}`;
      if (!health.reachable) {
        results.push({
          id,
          label: `Self-check ${model.modelId}`,
          status: "fail",
          detail: health.error?.message ?? "unreachable",
        });
        continue;
      }
      results.push({
        id,
        label: `Self-check ${model.modelId}`,
        status: health.mismatches.length > 0 ? "warn" : "ok",
        detail:
          health.mismatches.length > 0
            ? health.mismatches.join("; ")
            : `verified: ${Object.entries(health.detected)
                .map(([key, value]) => `${key}=${String(value)}`)
                .join(", ")}`,
      });
    }

    return results;
  } catch (error) {
    return [
      {
        id: `${config.providerId}.healthCheck`,
        label: "Self-check",
        status: "fail",
        detail: error instanceof Error ? error.message : "self-check failed",
      },
    ];
  }
}

function worstStatus(statuses: PreflightStatus[]): PreflightStatus {
  if (statuses.includes("fail")) return "fail";
  if (statuses.includes("warn")) return "warn";
  return "ok";
}

export function formatPreflightReport(report: PreflightReport): string {
  const icon = (status: PreflightStatus) => (status === "ok" ? "✓" : status === "warn" ? "!" : "✗");
  const lines: string[] = [`Configuration self-check: ${report.status.toUpperCase()}`];

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
