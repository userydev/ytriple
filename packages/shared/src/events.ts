import type { Degradation } from "./degradation.js";
import type { ProviderErrorCode } from "./provider.js";
import type { AgentId, TaskId } from "./team.js";
import type { AgentContribution, SourceNote, TaskBrief, TaskStatus, TokenUsage } from "./task.js";

export type SubAgentAbortReason =
  | "depth_exceeded"
  | "tools_not_subset"
  | "token_budget_exhausted"
  | "spawn_limit_reached"
  | "wall_clock_exceeded"
  | "permission_denied"
  | "provider_error";

/**
 * Everything is addressed by `agentId`. There are no per-role event fields, so
 * a two-member team and a five-member team emit the same shapes and a UI can
 * render either without changes.
 */
export type RuntimeEventBody =
  | { type: "task_status"; status: TaskStatus }
  /** The human's own turn. A UI must be able to render the chat from events alone. */
  | { type: "user_message"; text: string }
  | { type: "agent_message"; agentId: AgentId; text: string }
  | { type: "agent_question"; agentId: AgentId; questionId: string; question: string; reason: string }
  | { type: "user_answer"; questionId: string; text: string }
  | { type: "task_brief_updated"; brief: TaskBrief }
  | { type: "agent_dispatched"; agentId: AgentId; objective: string }
  | {
      type: "agent_stage";
      agentId: AgentId;
      stage: string;
      detail: string;
      sources?: SourceNote[];
    }
  | {
      type: "tool_call";
      agentId: AgentId;
      subAgentId?: string;
      tool: string;
      intent: string;
      outcome: "ok" | "denied" | "error";
      detail: string;
    }
  | { type: "agent_contribution"; agentId: AgentId; schemaId: string; payload: unknown }
  | {
      type: "subagent_spawned";
      parentAgentId: AgentId;
      subAgentId: string;
      objective: string;
      depth: number;
      tools: string[];
      tokenBudget: number;
    }
  | { type: "subagent_stage"; parentAgentId: AgentId; subAgentId: string; stage: string; detail: string }
  | {
      type: "subagent_completed";
      parentAgentId: AgentId;
      subAgentId: string;
      summary: string;
      tokensUsed: number;
    }
  | {
      type: "subagent_aborted";
      parentAgentId: AgentId;
      subAgentId: string;
      reason: SubAgentAbortReason;
      detail: string;
    }
  | { type: "degradation"; agentId?: AgentId; subAgentId?: string; degradation: Degradation }
  | { type: "model_usage"; agentId: AgentId; subAgentId?: string; phase: string; usage: TokenUsage }
  | { type: "artifact_written"; filename: "prd.md"; path: string }
  | {
      type: "error";
      agentId?: AgentId;
      stage: string;
      message: string;
      retryable: boolean;
      code?: ProviderErrorCode;
    };

export interface RuntimeEvent {
  taskId: TaskId;
  /** Monotonic per task. Consumers de-duplicate and backfill on it. */
  seq: number;
  at: number;
  body: RuntimeEventBody;
}

export type RuntimeEventType = RuntimeEventBody["type"];

export type RuntimeEventListener = (event: RuntimeEvent) => void;

export function isEventOfType<T extends RuntimeEventType>(
  event: RuntimeEvent,
  type: T,
): event is RuntimeEvent & { body: Extract<RuntimeEventBody, { type: T }> } {
  return event.body.type === type;
}

export function eventsOfType<T extends RuntimeEventType>(
  events: readonly RuntimeEvent[],
  type: T,
): Array<Extract<RuntimeEventBody, { type: T }>> {
  return events
    .filter((event): event is RuntimeEvent & { body: Extract<RuntimeEventBody, { type: T }> } =>
      isEventOfType(event, type),
    )
    .map((event) => event.body);
}

/** Contributions are carried as opaque payloads; this narrows one for a host. */
export function asContribution(
  agentId: AgentId,
  schemaId: string,
  payload: Record<string, unknown>,
  sources: SourceNote[],
  usage: TokenUsage,
): AgentContribution {
  return { agentId, schemaId, payload, sources, usage };
}

/** One-line rendering shared by the CLI harness and any log surface. */
export function formatEvent(event: RuntimeEvent): string {
  const body = event.body;
  switch (body.type) {
    case "task_status":
      return `[status] ${body.status}`;
    case "user_message":
      return `[you] ${body.text}`;
    case "agent_message":
      return `[${body.agentId}] ${body.text}`;
    case "agent_question":
      return `[${body.agentId}] ? ${body.question} (${body.reason})`;
    case "user_answer":
      return `[you] ${body.text}`;
    case "task_brief_updated":
      return `[brief] ${body.brief.productObject} | member tasks: ${body.brief.memberTasks
        .map((task) => task.agentId)
        .join(", ")}`;
    case "agent_dispatched":
      return `[${body.agentId}] dispatched: ${body.objective}`;
    case "agent_stage":
      return `[${body.agentId}] ${body.stage}: ${body.detail}`;
    case "tool_call":
      return `[${body.subAgentId ?? body.agentId}] tool ${body.tool} -> ${body.outcome}: ${body.detail}`;
    case "agent_contribution":
      return `[${body.agentId}] contribution ready (${body.schemaId})`;
    case "subagent_spawned":
      return `[${body.parentAgentId}] spawned ${body.subAgentId} (depth ${body.depth}, ${body.tokenBudget} tokens): ${body.objective}`;
    case "subagent_stage":
      return `  [${body.subAgentId}] ${body.stage}: ${body.detail}`;
    case "subagent_completed":
      return `  [${body.subAgentId}] done (${body.tokensUsed} tokens): ${body.summary}`;
    case "subagent_aborted":
      return `  [${body.subAgentId}] aborted (${body.reason}): ${body.detail}`;
    case "degradation":
      return `[degraded] ${body.degradation.kind}: ${body.degradation.from} -> ${body.degradation.to} (${body.degradation.detail})`;
    case "model_usage":
      return `[usage] ${body.subAgentId ?? body.agentId} ${body.phase} ${body.usage.inputTokens}+${body.usage.outputTokens}`;
    case "artifact_written":
      return `[artifact] ${body.filename} -> ${body.path}`;
    case "error":
      return `[error] ${body.stage}${body.code ? ` (${body.code})` : ""}: ${body.message}`;
  }
}
