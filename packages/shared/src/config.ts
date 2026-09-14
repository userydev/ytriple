import type { ProviderConfig } from "./provider.js";
import type { ModelBinding } from "./team.js";

/**
 * Configuration holds a `credentialRef`, never key material, so persisted
 * config is safe to sync, log and hand to a renderer. The host resolves the
 * ref through the SecretPort at call time.
 */

export interface RuntimeLimits {
  /** Tool rounds a member may run before it must produce its contribution. */
  maxToolRounds: number;
  maxToolCallsPerRound: number;
  /** Retries when a model returns JSON that fails schema validation. */
  maxSchemaRepairAttempts: number;
  maxQuestionRounds: number;
  /** Upper bound on questions the orchestrator may forward in one round. */
  maxApprovedQuestions: number;
  /** Characters per token used by the context estimator. */
  charsPerToken: number;
}

export const DEFAULT_RUNTIME_LIMITS: RuntimeLimits = {
  maxToolRounds: 3,
  maxToolCallsPerRound: 3,
  maxSchemaRepairAttempts: 2,
  maxQuestionRounds: 1,
  maxApprovedQuestions: 3,
  charsPerToken: 4,
};

export interface WorkspacePolicy {
  includeGlobs: string[];
  excludeGlobs: string[];
  maxFiles: number;
  maxFileBytes: number;
}

export const DEFAULT_WORKSPACE_POLICY: WorkspacePolicy = {
  includeGlobs: ["**/*.md", "**/*.txt", "**/*.json", "**/*.ts", "**/*.tsx", "**/*.py", "**/*.rs"],
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
  /** Team-level fallback binding; members may override per agent. */
  defaultModel: ModelBinding;
  /** Per-agent overrides keyed by agentId. */
  agentModels?: Record<string, ModelBinding>;
  limits?: Partial<RuntimeLimits>;
  workspace?: Partial<WorkspacePolicy>;
}

export function resolveLimits(config: Pick<YtripleConfig, "limits">): RuntimeLimits {
  return { ...DEFAULT_RUNTIME_LIMITS, ...config.limits };
}

export function resolveWorkspacePolicy(
  config: Pick<YtripleConfig, "workspace">,
): WorkspacePolicy {
  return { ...DEFAULT_WORKSPACE_POLICY, ...config.workspace };
}

export function findProviderConfig(
  config: Pick<YtripleConfig, "providers">,
  providerId: string,
): ProviderConfig | undefined {
  return config.providers.find((provider) => provider.providerId === providerId);
}

export function findModelConfig(
  config: Pick<YtripleConfig, "providers">,
  binding: ModelBinding,
) {
  const provider = findProviderConfig(config, binding.providerId);
  const model = provider?.models.find((entry) => entry.modelId === binding.modelId);
  return provider && model ? { provider, model } : undefined;
}

const SECRET_LIKE_KEY = /(api[-_ ]?key|secret|token|password|authorization|credential)/i;

/**
 * Defence in depth for logs, events and crash reports: even if key material
 * reaches an object it must not reach a sink. `credentialRef` is exempt — it is
 * a name, not a secret.
 */
export function redactSecrets<T>(value: T): T {
  return redactUnknown(value) as T;
}

function redactUnknown(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactUnknown);
  if (value === null || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === "credentialRef") {
      result[key] = entry;
      continue;
    }
    if (SECRET_LIKE_KEY.test(key) && typeof entry === "string") {
      result[key] = "[redacted]";
      continue;
    }
    result[key] = redactUnknown(entry);
  }
  return result;
}
