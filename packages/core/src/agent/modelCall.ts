import type {
  ChatMessage,
  Degradation,
  GenerateResult,
  ModelBinding,
  NamedJsonSchema,
  ProviderAdapter,
  ProviderCapabilities,
  RuntimeEventBody,
  RuntimeLimits,
  SourceNote,
  ToolCall,
  ToolSpec,
  TokenUsage,
} from "@ytriple/shared";
import {
  EMPTY_TOKEN_USAGE,
  ProviderError,
  addUsage,
  parseJsonPayload,
  validateAgainstSchema,
} from "@ytriple/shared";
import {
  ContextOverflowError,
  assembleContext,
  type ContextSection,
} from "../context/contextBudget.js";

export interface ResolvedBinding {
  adapter: ProviderAdapter;
  model: { modelId: string; displayName: string; capabilities?: Partial<ProviderCapabilities> };
}

export type BindingResolver = (binding: ModelBinding) => Promise<ResolvedBinding>;

export interface ModelCallOptions {
  agentId: string;
  subAgentId?: string;
  phase: string;
  round: number;
  binding: ModelBinding;
  /** Assembled into the system prompt in priority order, trimmed when needed. */
  systemSections: ContextSection[];
  messages: ChatMessage[];
  schema?: NamedJsonSchema;
  tools?: ToolSpec[];
  nativeWebSearch?: boolean;
}

export interface ModelCallOutcome {
  text: string;
  /** Present when a schema was requested; already validated against it. */
  value?: Record<string, unknown>;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  sources: SourceNote[];
  capabilities: ProviderCapabilities;
}

export interface ModelCallerDeps {
  resolveBinding: BindingResolver;
  limits: RuntimeLimits;
  emit(body: RuntimeEventBody): void;
  /** Charged before the call is issued; throws when a budget is exhausted. */
  chargeUsage?(usage: TokenUsage, options: ModelCallOptions): void;
}

export interface ModelCaller {
  call(options: ModelCallOptions): Promise<ModelCallOutcome>;
}

/**
 * One place where a model call happens, so every degradation chain is applied
 * uniformly: context trimming before the call, schema repair after it, and
 * every `degradations` entry the adapter reports bubbled into the event stream.
 */
export function createModelCaller(deps: ModelCallerDeps): ModelCaller {
  return {
    async call(options) {
      const { adapter, model } = await deps.resolveBinding(options.binding);
      const capabilities = adapter.describe(model);

      let contextBudget = contextBudgetFor(capabilities, options.binding);
      let messages = [...options.messages];
      let usage: TokenUsage = EMPTY_TOKEN_USAGE;
      const sources: SourceNote[] = [];
      let contextRetried = false;
      let attempt = 0;

      for (;;) {
        const assembled = assembleContext(options.systemSections, {
          maxTokens: contextBudget,
          charsPerToken: deps.limits.charsPerToken,
        });
        emitDegradations(deps, options, assembled.degradations);

        let result: GenerateResult;
        try {
          result = await adapter.generate({
            model,
            system: assembled.text,
            messages,
            ...(options.tools && options.tools.length > 0 ? { tools: options.tools } : {}),
            ...(options.schema ? { responseSchema: options.schema } : {}),
            ...(options.nativeWebSearch ? { nativeWebSearch: true } : {}),
            ...(options.binding.maxOutputTokens === undefined
              ? {}
              : { maxOutputTokens: options.binding.maxOutputTokens }),
            metadata: {
              agentId: options.agentId,
              phase: options.phase,
              round: options.round,
              ...(options.subAgentId ? { subAgentId: options.subAgentId } : {}),
            },
          });
        } catch (error) {
          if (
            error instanceof ProviderError &&
            error.code === "context_overflow" &&
            !contextRetried
          ) {
            // Recoverable once: trim harder, then retry.
            contextRetried = true;
            contextBudget = Math.floor(contextBudget * 0.6);
            continue;
          }
          throw error;
        }

        usage = addUsage(usage, result.usage);
        deps.chargeUsage?.(result.usage, options);
        emitDegradations(deps, options, result.degradations);
        deps.emit({
          type: "model_usage",
          agentId: options.agentId,
          ...(options.subAgentId ? { subAgentId: options.subAgentId } : {}),
          phase: options.phase,
          usage: result.usage,
        });
        if (result.sources) sources.push(...result.sources);

        if (!options.schema || result.toolCalls.length > 0) {
          return { text: result.text, toolCalls: result.toolCalls, usage, sources, capabilities };
        }

        const validation = validateStructured(result.text, options.schema);
        if (validation.ok) {
          return {
            text: result.text,
            value: validation.value,
            toolCalls: result.toolCalls,
            usage,
            sources,
            capabilities,
          };
        }

        attempt += 1;
        if (attempt > deps.limits.maxSchemaRepairAttempts) {
          throw new ProviderError(
            `${adapter.providerId} could not produce valid ${options.schema.name} after ${attempt} attempt(s): ${validation.error}`,
            { providerId: adapter.providerId, code: "schema_violation" },
          );
        }

        deps.emit({
          type: "degradation",
          agentId: options.agentId,
          ...(options.subAgentId ? { subAgentId: options.subAgentId } : {}),
          degradation: {
            kind: "structured_output",
            from: "first_attempt",
            to: `repair_attempt_${attempt}`,
            detail: validation.error,
          },
        });

        messages = [
          ...messages,
          { role: "assistant", content: result.text },
          {
            role: "user",
            content: [
              `Your previous reply did not satisfy the ${options.schema.name} schema:`,
              validation.error,
              "Reply again with only the corrected JSON object.",
            ].join("\n"),
          },
        ];
      }
    },
  };
}

function validateStructured(
  text: string,
  schema: NamedJsonSchema,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const parsed = parseJsonPayload(text);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const violations = validateAgainstSchema(parsed.value, schema.schema);
  if (violations.length > 0) {
    return {
      ok: false,
      error: violations.map((violation) => `${violation.path}: ${violation.message}`).join("; "),
    };
  }
  return { ok: true, value: parsed.value as Record<string, unknown> };
}

function contextBudgetFor(
  capabilities: ProviderCapabilities,
  binding: ModelBinding,
): number {
  const reservedForOutput = binding.maxOutputTokens ?? capabilities.maxOutputTokens;
  // Leave room for the message history and the reply itself.
  return Math.max(512, Math.floor((capabilities.maxContextTokens - reservedForOutput) * 0.7));
}

function emitDegradations(
  deps: ModelCallerDeps,
  options: ModelCallOptions,
  degradations: readonly Degradation[],
): void {
  for (const degradation of degradations) {
    deps.emit({
      type: "degradation",
      agentId: options.agentId,
      ...(options.subAgentId ? { subAgentId: options.subAgentId } : {}),
      degradation,
    });
  }
}

export { ContextOverflowError };
