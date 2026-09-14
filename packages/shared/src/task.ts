import type { AgentId } from "./team.js";

export type TaskStatus =
  | "idle"
  | "chatting"
  | "agent_questioning"
  | "brief_ready"
  | "dispatching"
  | "running"
  | "merging"
  | "writing_outputs"
  | "completed"
  | "failed";

/**
 * The structured summary the orchestrator must publish before any contributor
 * is dispatched. Field names follow the V1 runtime contract.
 */
export interface TaskBrief {
  product_object: string;
  target_user: string;
  core_scenario: string;
  pain_or_problem: string;
  v1_scope: string[];
  non_goals: string[];
  success_criteria: string[];
  research_scope: string;
  specialist_focus: string;
  assumptions: string[];
  open_questions: string[];
}

export type SessionAuthorKind = "user" | "agent";

export interface SessionMessage {
  messageId: string;
  authorKind: SessionAuthorKind;
  /** `"user"` for the human, otherwise the agent id. */
  authorId: AgentId | "user";
  kind: "statement" | "question" | "answer";
  text: string;
  /** Why an agent asked this, shown next to the question. */
  reason?: string;
  /** Set on answers, pointing at the question message id. */
  inReplyTo?: string;
  createdAt: number;
}

export interface AgentQuestion {
  questionId: string;
  agentId: AgentId;
  agentDisplayName: string;
  question: string;
  reason: string;
}

export interface AgentAnswer {
  questionId: string;
  text: string;
}

export interface SourceNote {
  title: string;
  url: string;
  snippet?: string;
  sourceType?: string;
  /** `native` when the provider grounded the answer itself. */
  origin: "native_provider_search" | "search_port" | "workspace";
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export const EMPTY_TOKEN_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0 };

export function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
  };
}

export function totalTokens(usage: TokenUsage): number {
  return usage.promptTokens + usage.completionTokens;
}

/** One contributor's structured hand-off to the orchestrator's merge step. */
export interface AgentContribution {
  agentId: AgentId;
  summary: string;
  key_findings: string[];
  risks: string[];
  recommendations: string[];
  proposed_sections: Array<{ title: string; body: string }>;
  assumptions: string[];
  open_questions: string[];
  sources: SourceNote[];
}
