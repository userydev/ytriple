import type {
  ChatMessage,
  ModelBinding,
  NamedJsonSchema,
  RuntimeEventBody,
  SourceNote,
  TokenUsage,
} from "@ytriple/shared";
import { EMPTY_TOKEN_USAGE, addUsage } from "@ytriple/shared";
import type { ContextSection } from "../context/contextBudget.js";
import { observationsSection } from "./prompt.js";
import type { ModelCaller } from "./modelCall.js";
import type { ToolRegistry } from "../tools/registry.js";

/** Set by the web search tool when the bound model will ground its own answer. */
export interface GroundingFlag {
  requested: boolean;
}

export interface AgentLoopOptions {
  agentId: string;
  subAgentId?: string;
  depth: number;
  binding: ModelBinding;
  /** The agent's tool allowlist. Anything outside it is refused, not degraded. */
  allowlist: readonly string[];
  registry: ToolRegistry;
  modelCaller: ModelCaller;
  systemSections: ContextSection[];
  instruction: string;
  schema: NamedJsonSchema;
  phase: string;
  maxRounds: number;
  maxToolCallsPerRound: number;
  grounding: GroundingFlag;
  emit(body: RuntimeEventBody): void;
  onStage(stage: string, detail: string, sources?: SourceNote[]): void;
  /** Charged after every model call. Throwing here aborts the loop on budget. */
  onUsage?(usage: TokenUsage): void;
}

export interface AgentLoopResult {
  value: Record<string, unknown>;
  usage: TokenUsage;
  sources: SourceNote[];
  rounds: number;
}

/**
 * Tool loop shared by team members and sub-agents.
 *
 * The model may call tools for a bounded number of rounds; on the last round
 * tools are withdrawn so it has to answer. Tool dispatch is native — there is
 * no prompt-simulated fallback — and the registry enforces the allowlist.
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const specs = options.registry.specsFor({
    agentId: options.agentId,
    tools: options.allowlist,
  });

  const messages: ChatMessage[] = [{ role: "user", content: options.instruction }];
  const observations: string[] = [];
  const sources: SourceNote[] = [];
  let usage: TokenUsage = EMPTY_TOKEN_USAGE;

  for (let round = 0; ; round += 1) {
    const isFinalRound = round >= options.maxRounds || specs.length === 0;

    const outcome = await options.modelCaller.call({
      agentId: options.agentId,
      ...(options.subAgentId ? { subAgentId: options.subAgentId } : {}),
      phase: options.phase,
      round,
      binding: options.binding,
      systemSections: [...options.systemSections, observationsSection(observations)],
      messages,
      schema: options.schema,
      ...(isFinalRound ? {} : { tools: specs }),
      ...(options.grounding.requested ? { nativeWebSearch: true } : {}),
    });

    usage = addUsage(usage, outcome.usage);
    options.onUsage?.(outcome.usage);
    if (outcome.sources.length > 0) {
      sources.push(...outcome.sources);
      options.onStage(
        "sources",
        `${outcome.sources.length} source(s) returned by native provider search`,
        outcome.sources,
      );
    }

    if (outcome.value) {
      return { value: outcome.value, usage, sources, rounds: round };
    }

    const toolCalls = outcome.toolCalls.slice(0, options.maxToolCallsPerRound);
    if (toolCalls.length === 0) {
      // No structured value and no tool call: ask once more without tools.
      messages.push({ role: "user", content: "Reply now with the required JSON object." });
      continue;
    }

    messages.push({ role: "assistant", content: outcome.text, toolCalls });
    options.onStage(
      "tool_round",
      `round ${round + 1}: ${toolCalls.map((call) => call.name).join(", ")}`,
    );

    for (const call of toolCalls) {
      const result = await options.registry.execute(options.allowlist, call.name, call.arguments, {
        agentId: options.agentId,
        ...(options.subAgentId ? { subAgentId: options.subAgentId } : {}),
        depth: options.depth,
        emit: options.emit,
      });

      if (result.sources && result.sources.length > 0) {
        sources.push(...result.sources);
        // Without this the SearchPort fallback produced sources that reached
        // the contribution but never the event stream, so a UI built from
        // events showed an empty source list for a member that had cited work.
        options.onStage(
          "sources",
          `${result.sources.length} source(s) from ${call.name}`,
          result.sources,
        );
      }
      observations.push(`[${call.name}] ${result.detail}`);
      messages.push({
        role: "tool",
        toolCallId: call.toolCallId,
        name: call.name,
        content: result.detail,
      });
    }
  }
}
