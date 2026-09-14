import type {
  AgentDefinition,
  ModelBinding,
  RuntimeEventBody,
  SourceNote,
  SubAgentAbortReason,
  TokenUsage,
} from "@ytriple/shared";
import { EMPTY_TOKEN_USAGE, totalTokens } from "@ytriple/shared";
import { runAgentLoop, type GroundingFlag } from "../agent/agentLoop.js";
import type { ModelCaller } from "../agent/modelCall.js";
import { CONTEXT_PRIORITY, type ContextSection } from "../context/contextBudget.js";
import { SUBAGENT_RESULT_SCHEMA } from "../schemas/runtimeSchemas.js";
import { TOOL_NAMES } from "../tools/toolNames.js";
import type { ToolRegistry } from "../tools/registry.js";
import { SubAgentBudgetError, type SubAgentLedger } from "./budget.js";

export interface SpawnRequest {
  objective: string;
  instructions: string;
  tools: string[];
  maxTokens: number;
}

export interface SubAgentOutcome {
  subAgentId: string;
  objective: string;
  summary: string;
  findings: string[];
  gaps: string[];
  usage: TokenUsage;
  sources: SourceNote[];
  incomplete: boolean;
  abortReason?: SubAgentAbortReason;
}

export interface SubAgentDeps {
  parent: AgentDefinition;
  parentDepth: number;
  binding: ModelBinding;
  ledger: SubAgentLedger;
  registry: ToolRegistry;
  modelCaller: ModelCaller;
  grounding: GroundingFlag;
  maxRounds: number;
  maxToolCallsPerRound: number;
  emit(body: RuntimeEventBody): void;
  nextSubAgentId(): string;
}

export interface SpawnRejection {
  reason: SubAgentAbortReason;
  detail: string;
}

/**
 * The three constraints, checked together and failing loudly.
 *
 * Depth, tool subset and budget are all structural: a sub-agent can never hold
 * a tool its parent lacks, so privilege escalation is impossible by
 * construction rather than by policy.
 */
export function checkSpawnConstraints(
  request: SpawnRequest,
  deps: Pick<SubAgentDeps, "parent" | "parentDepth" | "ledger">,
): SpawnRejection | undefined {
  const { parent, parentDepth, ledger } = deps;

  if (!parent.canSpawnSubAgents || !parent.subAgentBudget) {
    return {
      reason: "permission_denied",
      detail: `${parent.agentId} is not allowed to spawn sub-agents`,
    };
  }

  const depth = parentDepth + 1;
  if (depth > parent.subAgentBudget.maxDepth) {
    return {
      reason: "depth_exceeded",
      detail: `spawning at depth ${depth} exceeds maxDepth ${parent.subAgentBudget.maxDepth} for ${parent.agentId}`,
    };
  }

  const requested = [...new Set(request.tools)];
  const notInherited = requested.filter((tool) => !parent.tools.includes(tool));
  if (notInherited.length > 0) {
    return {
      reason: "tools_not_subset",
      detail: `requested tool(s) ${notInherited.join(", ")} are not in ${parent.agentId}'s allowlist (${parent.tools.join(", ")}); a sub-agent can only inherit a subset`,
    };
  }

  const budgetRejection = ledger.check(request.maxTokens);
  if (budgetRejection) return budgetRejection;

  return undefined;
}

/**
 * Sub-agents are an implementation detail of their parent: they never touch the
 * shared session, never appear in the team, and their result flows back only to
 * the parent, which decides what to keep.
 */
export async function runSubAgent(
  request: SpawnRequest,
  deps: SubAgentDeps,
): Promise<SubAgentOutcome | SpawnRejection> {
  const rejection = checkSpawnConstraints(request, deps);
  if (rejection) return rejection;

  const subAgentId = deps.nextSubAgentId();
  const depth = deps.parentDepth + 1;
  const budget = deps.parent.subAgentBudget!;

  // A sub-agent at the depth limit cannot spawn further, so the tool is removed
  // from its inherited set rather than left to fail later.
  const canNest = depth < budget.maxDepth;
  const tools = [...new Set(request.tools)].filter(
    (tool) => canNest || tool !== TOOL_NAMES.spawnSubAgent,
  );

  deps.emit({
    type: "subagent_spawned",
    parentAgentId: deps.parent.agentId,
    subAgentId,
    objective: request.objective,
    depth,
    tools,
    tokenBudget: request.maxTokens,
  });

  const child = deps.ledger.openChild(subAgentId, request.maxTokens);
  const stage = (name: string, detail: string) =>
    deps.emit({
      type: "subagent_stage",
      parentAgentId: deps.parent.agentId,
      subAgentId,
      stage: name,
      detail,
    });

  const sections: ContextSection[] = [
    {
      id: `subagent:${subAgentId}`,
      priority: CONTEXT_PRIORITY.briefAndMemberTask,
      content: [
        `You are a temporary sub-agent spawned by ${deps.parent.displayName} for one objective.`,
        `Objective: ${request.objective}`,
        "",
        request.instructions,
        "",
        "You report only to the agent that spawned you. You never address the user.",
        "Answer the objective and stop; do not expand the scope.",
      ].join("\n"),
    },
    {
      id: `subagent:tools:${subAgentId}`,
      priority: CONTEXT_PRIORITY.roleAndTools,
      content:
        tools.length > 0
          ? ["Tools available to you:", ...tools.map((tool) => `- ${tool}`)].join("\n")
          : "You have no tools. Answer from what you already know.",
    },
  ];

  try {
    const result = await runAgentLoop({
      agentId: deps.parent.agentId,
      subAgentId,
      depth,
      binding: deps.binding,
      allowlist: tools,
      registry: deps.registry,
      modelCaller: deps.modelCaller,
      systemSections: sections,
      instruction: request.objective,
      schema: SUBAGENT_RESULT_SCHEMA,
      phase: "subagent_work",
      maxRounds: deps.maxRounds,
      maxToolCallsPerRound: deps.maxToolCallsPerRound,
      grounding: deps.grounding,
      emit: deps.emit,
      onStage: stage,
      onUsage: (usage) => child.charge(usage),
    });

    const outcome: SubAgentOutcome = {
      subAgentId,
      objective: request.objective,
      summary: readString(result.value, "summary") ?? "",
      findings: readStringList(result.value, "findings"),
      gaps: readStringList(result.value, "gaps"),
      usage: result.usage,
      sources: result.sources,
      incomplete: false,
    };

    deps.emit({
      type: "subagent_completed",
      parentAgentId: deps.parent.agentId,
      subAgentId,
      summary: outcome.summary,
      tokensUsed: totalTokens(result.usage),
    });

    return outcome;
  } catch (error) {
    const reason: SubAgentAbortReason =
      error instanceof SubAgentBudgetError ? error.reason : "provider_error";
    const detail = error instanceof Error ? error.message : "unknown error";

    deps.emit({
      type: "subagent_aborted",
      parentAgentId: deps.parent.agentId,
      subAgentId,
      reason,
      detail,
    });

    // A dead sub-agent is a recoverable failure for the parent: it continues
    // with its own work and records the gap in its contribution.
    return {
      subAgentId,
      objective: request.objective,
      summary: "",
      findings: [],
      gaps: [`sub-agent ${subAgentId} aborted (${reason}): ${detail}`],
      usage: EMPTY_TOKEN_USAGE,
      sources: [],
      incomplete: true,
      abortReason: reason,
    };
  }
}

export function isSpawnRejection(
  value: SubAgentOutcome | SpawnRejection,
): value is SpawnRejection {
  return !("subAgentId" in value);
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
  const entry = value[key];
  return typeof entry === "string" ? entry : undefined;
}

function readStringList(value: Record<string, unknown>, key: string): string[] {
  const entry = value[key];
  return Array.isArray(entry) ? entry.filter((item): item is string => typeof item === "string") : [];
}
