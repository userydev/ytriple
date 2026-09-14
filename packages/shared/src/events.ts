import type { AgentId, TaskId } from "./team.js";
import type {
  AgentContribution,
  SourceNote,
  TaskBrief,
  TaskStatus,
  TokenUsage,
} from "./task.js";

/**
 * Every event is addressed by `agentId` rather than by a fixed slot, so a team
 * of two or of seven produces the same event shapes. A UI must be able to
 * render a run from this stream alone; nothing may be inferred or faked.
 */
export type RuntimeEventBody =
  | { type: "task_status"; status: TaskStatus }
  | { type: "agent_message"; agentId: AgentId; text: string }
  | {
      type: "agent_question";
      agentId: AgentId;
      questionId: string;
      question: string;
      reason: string;
    }
  | { type: "user_answer"; questionId: string; text: string }
  | { type: "task_brief_updated"; brief: TaskBrief }
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
      tool: string;
      intent: string;
      outcome: "ok" | "denied" | "error";
      detail: string;
    }
  | { type: "agent_contribution"; agentId: AgentId; contribution: AgentContribution }
  | {
      type: "subagent_spawned";
      parentAgentId: AgentId;
      subAgentId: AgentId;
      purpose: string;
      depth: number;
      tokenBudget: number;
      tools: string[];
    }
  | {
      type: "subagent_stage";
      parentAgentId: AgentId;
      subAgentId: AgentId;
      stage: string;
      detail: string;
    }
  | {
      type: "subagent_completed";
      parentAgentId: AgentId;
      subAgentId: AgentId;
      summary: string;
      usage: TokenUsage;
    }
  | {
      type: "subagent_rejected";
      parentAgentId: AgentId;
      purpose: string;
      reason: string;
      constraint: "depth" | "tools" | "token_budget" | "permission";
    }
  | {
      type: "capability_degraded";
      agentId?: AgentId;
      capability: "native_web_search" | "json_schema" | "web_search";
      detail: string;
    }
  | { type: "model_usage"; agentId: AgentId; phase: string; usage: TokenUsage }
  | { type: "artifact_written"; filename: string; path: string }
  | { type: "error"; stage: string; message: string; agentId?: AgentId };

export interface RuntimeEvent {
  taskId: TaskId;
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

/** One-line rendering shared by the CLI harness and any log surface. */
export function formatEvent(event: RuntimeEvent): string {
  const body = event.body;
  switch (body.type) {
    case "task_status":
      return `[status] ${body.status}`;
    case "agent_message":
      return `[${body.agentId}] ${body.text}`;
    case "agent_question":
      return `[${body.agentId}] ? ${body.question} (${body.reason})`;
    case "user_answer":
      return `[you] ${body.text}`;
    case "task_brief_updated":
      return `[brief] ${body.brief.product_object}`;
    case "agent_stage":
      return `[${body.agentId}] ${body.stage}: ${body.detail}`;
    case "tool_call":
      return `[${body.agentId}] tool ${body.tool} -> ${body.outcome}: ${body.detail}`;
    case "agent_contribution":
      return `[${body.agentId}] contribution ready: ${body.contribution.summary}`;
    case "subagent_spawned":
      return `[${body.parentAgentId}] spawned ${body.subAgentId} (depth ${body.depth}, budget ${body.tokenBudget}): ${body.purpose}`;
    case "subagent_stage":
      return `  [${body.subAgentId}] ${body.stage}: ${body.detail}`;
    case "subagent_completed":
      return `  [${body.subAgentId}] done: ${body.summary}`;
    case "subagent_rejected":
      return `[${body.parentAgentId}] spawn denied (${body.constraint}): ${body.reason}`;
    case "capability_degraded":
      return `[degraded] ${body.capability}: ${body.detail}`;
    case "model_usage":
      return `[usage] ${body.agentId} ${body.phase} ${body.usage.promptTokens}+${body.usage.completionTokens}`;
    case "artifact_written":
      return `[artifact] ${body.filename} -> ${body.path}`;
    case "error":
      return `[error] ${body.stage}: ${body.message}`;
  }
}
