import type { ProviderCapabilities, ProviderKind } from "./provider.js";
import type { ModelBinding } from "./team.js";

/**
 * Configuration never contains key material. It contains a *reference* that the
 * host resolves through the SecretsPort at call time:
 *
 * - `keychain`: OS keychain / Tauri secure store. The desktop default.
 * - `env`: process environment. Used by the CLI harness and servers.
 * - `inline_dev`: explicit, opt-in, development-only escape hatch.
 *
 * Persisted config is therefore safe to sync, log and show in a renderer.
 */
export type SecretRefKind = "keychain" | "env" | "inline_dev";

export interface SecretRef {
  kind: SecretRefKind;
  name: string;
}

export interface ProviderConfig {
  providerId: string;
  kind: ProviderKind;
  model: string;
  baseUrl?: string;
  apiKeyRef: SecretRef;
  /** Request native grounding when the adapter supports it. */
  enableNativeWebSearch?: boolean;
  /** Narrow declared capabilities, e.g. for a gateway with a reduced feature set. */
  capabilityOverrides?: Partial<ProviderCapabilities>;
}

export interface SubAgentPolicy {
  enabled: boolean;
  maxDepth: number;
  maxConcurrentPerAgent: number;
  /** Shared across the whole sub-agent tree of one task. */
  tokenBudget: number;
  /** A spawn is refused when fewer tokens than this remain. */
  minTokensPerSpawn: number;
}

export interface RuntimeLimits {
  /** Plan/act rounds a contributor may run before it must synthesise. */
  maxToolRounds: number;
  maxToolCallsPerRound: number;
  /** Re-asks when a model returns JSON that fails schema validation. */
  maxSchemaRepairAttempts: number;
  maxQuestionsPerAgent: number;
  maxQuestionRounds: number;
}

export const DEFAULT_RUNTIME_LIMITS: RuntimeLimits = {
  maxToolRounds: 2,
  maxToolCallsPerRound: 3,
  maxSchemaRepairAttempts: 2,
  maxQuestionsPerAgent: 2,
  maxQuestionRounds: 1,
};

export const DEFAULT_SUBAGENT_POLICY: SubAgentPolicy = {
  enabled: true,
  maxDepth: 1,
  maxConcurrentPerAgent: 2,
  tokenBudget: 20_000,
  minTokensPerSpawn: 1_500,
};

export interface WorkspacePolicy {
  includeGlobs: string[];
  excludeGlobs: string[];
  maxFiles: number;
  maxFileBytes: number;
}

export const DEFAULT_WORKSPACE_POLICY: WorkspacePolicy = {
  includeGlobs: ["**/*.md", "**/*.txt", "**/*.json", "**/*.ts", "**/*.tsx", "**/*.py"],
  excludeGlobs: [
    ".git/**",
    "node_modules/**",
    "dist/**",
    "build/**",
    ".next/**",
    "coverage/**",
    "target/**",
    "ytriple-outputs/**",
    "**/*.log",
    "**/*.lock",
    "**/*.min.*",
  ],
  maxFiles: 500,
  maxFileBytes: 200_000,
};

export interface YtripleConfig {
  providers: ProviderConfig[];
  defaultModel: ModelBinding;
  /** Per-agent overrides, keyed by agent id. */
  agentModels?: Record<string, ModelBinding>;
  limits?: Partial<RuntimeLimits>;
  subAgents?: Partial<SubAgentPolicy>;
  workspace?: Partial<WorkspacePolicy>;
}

export function resolveLimits(config: YtripleConfig): RuntimeLimits {
  return { ...DEFAULT_RUNTIME_LIMITS, ...config.limits };
}

export function resolveSubAgentPolicy(config: YtripleConfig): SubAgentPolicy {
  return { ...DEFAULT_SUBAGENT_POLICY, ...config.subAgents };
}

export function resolveWorkspacePolicy(config: YtripleConfig): WorkspacePolicy {
  return { ...DEFAULT_WORKSPACE_POLICY, ...config.workspace };
}

export function findProviderConfig(
  config: YtripleConfig,
  providerId: string,
): ProviderConfig | undefined {
  return config.providers.find((provider) => provider.providerId === providerId);
}

const SECRET_LIKE_KEY = /(api[-_ ]?key|secret|token|password|authorization)/i;

/**
 * Defence in depth for logs, crash reports and event payloads: even if a key
 * reaches an object it must not reach a sink.
 */
export function redactSecrets<T>(value: T): T {
  return redactUnknown(value) as T;
}

function redactUnknown(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactUnknown);
  if (value === null || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_LIKE_KEY.test(key) && typeof entry === "string") {
      result[key] = "[redacted]";
      continue;
    }
    result[key] = redactUnknown(entry);
  }
  return result;
}
