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
 * What the host actually offers this run. The tool registry is filtered by
 * these flags, so an unavailable capability means the tool does not exist for
 * the task rather than failing when called.
 */
export interface RuntimeCapabilities {
  workspaceRead: boolean;
  outputWrite: boolean;
  webSearch: boolean;
  localModels: boolean;
  persistentBackgroundRuns: boolean;
  streaming: boolean;
}

export interface MemberTask {
  agentId: AgentId;
  objective: string;
  mustCover: string[];
  outOfScope: string[];
}

/**
 * The orchestrator's only dispatch credential. `memberTasks` is addressed by
 * `agentId`, which is what decouples the brief from the team size.
 */
export interface TaskBrief {
  productObject: string;
  targetUser: string;
  coreScenario: string;
  painOrProblem: string;
  v1Scope: string[];
  nonGoals: string[];
  successCriteria: string[];
  assumptions: string[];
  openQuestions: string[];
  memberTasks: MemberTask[];
  /** Filled from capability negotiation so the plan can degrade explicitly. */
  contextAvailability: {
    workspace: boolean;
    webSearch: boolean;
  };
}

export function memberTaskFor(brief: TaskBrief, agentId: AgentId): MemberTask | undefined {
  return brief.memberTasks.find((task) => task.agentId === agentId);
}

export type SessionAuthorKind = "user" | "agent";

export interface SessionMessage {
  messageId: string;
  authorKind: SessionAuthorKind;
  /** `"user"` for the human, otherwise the agent id. Sub-agents never appear. */
  authorId: AgentId | "user";
  kind: "statement" | "question" | "answer";
  text: string;
  reason?: string;
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
  origin: "native_provider_search" | "search_port" | "workspace";
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export const EMPTY_TOKEN_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 };

export function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  };
}

export function totalTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens;
}

/**
 * A member's hand-off. The payload shape is whatever the role's `outputSchema`
 * declares, so the runtime carries it without understanding it.
 */
export interface AgentContribution {
  agentId: AgentId;
  schemaId: string;
  payload: Record<string, unknown>;
  sources: SourceNote[];
  usage: TokenUsage;
  /** Set when a member finished with a gap, e.g. an aborted sub-agent. */
  incomplete?: boolean;
}
