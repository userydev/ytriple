import type {
  HealthCheckResult,
  ModelConfig,
  ProviderAdapter,
  ProviderCapabilities,
} from "@ytriple/shared";
import { ProviderError, parseJsonPayload, validateAgainstSchema } from "@ytriple/shared";

export interface HealthCheckOptions {
  /** Injected so the provider layer does not read the wall clock itself. */
  now?: () => number;
  probeToolCalling?: boolean;
  probeStructuredOutput?: boolean;
}

const PROBE_SCHEMA = {
  name: "ytriple_probe",
  schema: {
    type: "object" as const,
    required: ["ok"],
    properties: { ok: { type: "boolean" as const } },
  },
};

const PROBE_TOOL = {
  name: "ytriple_probe_tool",
  description: "Report the probe token back to the caller.",
  parameters: {
    type: "object" as const,
    required: ["token"],
    properties: { token: { type: "string" as const, description: "Always the string ping" } },
  },
};

/**
 * Provider self-check: connectivity, a minimum completion, a structured-output
 * probe and a tool-calling probe. Detected capabilities overwrite the declared
 * table, which is how "declares tool calling but does not support it" is
 * caught at configuration time instead of mid-task.
 */
export async function runHealthCheck(
  adapter: ProviderAdapter,
  model: ModelConfig,
  options: HealthCheckOptions = {},
): Promise<HealthCheckResult> {
  const declared = adapter.describe(model);
  const detected: Partial<ProviderCapabilities> = {};
  const mismatches: string[] = [];
  const startedAt = options.now?.();

  try {
    if (options.probeStructuredOutput ?? true) {
      const structured = await adapter.generate({
        model,
        system: "You are a connectivity probe. Answer with JSON only.",
        messages: [{ role: "user", content: 'Reply with exactly {"ok":true}.' }],
        responseSchema: PROBE_SCHEMA,
        maxOutputTokens: 64,
        metadata: { agentId: "healthcheck", phase: "structured_output_probe", round: 0 },
      });

      const parsed = parseJsonPayload(structured.text);
      const valid =
        parsed.ok && validateAgainstSchema(parsed.value, PROBE_SCHEMA.schema).length === 0;

      if (valid) {
        detected.structuredOutput = declared.structuredOutput === "none" ? "json_mode" : declared.structuredOutput;
      } else {
        detected.structuredOutput = "none";
        if (declared.structuredOutput !== "none") {
          mismatches.push(
            `declares structuredOutput=${declared.structuredOutput} but the probe response did not satisfy a minimal schema`,
          );
        }
      }
    }

    if ((options.probeToolCalling ?? true) && declared.toolCalling !== "none") {
      const toolProbe = await adapter.generate({
        model,
        system: "You are a connectivity probe. Use the provided tool.",
        messages: [{ role: "user", content: 'Call ytriple_probe_tool with token "ping".' }],
        tools: [PROBE_TOOL],
        maxOutputTokens: 64,
        metadata: { agentId: "healthcheck", phase: "tool_calling_probe", round: 0 },
      });

      if (toolProbe.toolCalls.length > 0) {
        detected.toolCalling = declared.toolCalling;
      } else {
        detected.toolCalling = "none";
        mismatches.push(
          `declares toolCalling=${declared.toolCalling} but returned no tool call for a direct tool request`,
        );
      }
    }
  } catch (error) {
    const providerError =
      error instanceof ProviderError
        ? error
        : new ProviderError(error instanceof Error ? error.message : "unknown error", {
            providerId: adapter.providerId,
            code: "unknown",
          });

    return {
      reachable: providerError.code !== "network" && providerError.code !== "timeout",
      ...(startedAt !== undefined && options.now ? { latencyMs: options.now() - startedAt } : {}),
      detected,
      mismatches,
      error: { code: providerError.code, message: providerError.message },
    };
  }

  return {
    reachable: true,
    ...(startedAt !== undefined && options.now ? { latencyMs: options.now() - startedAt } : {}),
    detected,
    mismatches,
  };
}
