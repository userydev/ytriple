import type {
  AgentId,
  Degradation,
  RuntimeEvent,
  SourceNote,
  TaskBrief,
  TaskStatus,
  TeamDefinition,
  TokenUsage,
} from "@ytriple/shared";
import { EMPTY_TOKEN_USAGE, addUsage } from "@ytriple/shared";

/**
 * The event stream folded into everything the UI draws.
 *
 * This is a pure function on purpose. It is the guarantee behind "render only
 * real events": a pane can show a stage, a source or a sub-agent only if an
 * event produced it, and there is no path for a component to invent progress.
 * It is also why the UI can be tested without a browser.
 */

export type MemberStatus = "idle" | "dispatched" | "working" | "contributed" | "failed";

export interface StageView {
  stage: string;
  detail: string;
  at: number;
  sources?: SourceNote[];
}

export interface ToolCallView {
  tool: string;
  intent: string;
  outcome: "ok" | "denied" | "error";
  detail: string;
  at: number;
}

export interface SubAgentView {
  subAgentId: string;
  objective: string;
  depth: number;
  tools: string[];
  tokenBudget: number;
  status: "running" | "completed" | "aborted";
  stages: StageView[];
  toolCalls: ToolCallView[];
  summary?: string;
  tokensUsed?: number;
  abortReason?: string;
  abortDetail?: string;
}

export interface MemberView {
  agentId: AgentId;
  displayName: string;
  roleId: string;
  roleDisplayName: string;
  responsibility: string;
  panelSections: string[];
  isOrchestrator: boolean;
  status: MemberStatus;
  objective?: string;
  stages: StageView[];
  toolCalls: ToolCallView[];
  sources: SourceNote[];
  /** Nested work, rendered collapsed inside this member's panel. */
  subAgents: SubAgentView[];
  degradations: Degradation[];
  contribution?: { schemaId: string; payload: Record<string, unknown> };
  error?: { message: string; retryable: boolean };
  usage: TokenUsage;
}

export interface ChatEntry {
  id: string;
  kind: "user" | "agent" | "question" | "answer";
  agentId?: AgentId;
  displayName: string;
  text: string;
  reason?: string;
  at: number;
}

export interface TaskView {
  taskId: string;
  status: TaskStatus;
  chat: ChatEntry[];
  brief?: TaskBrief;
  orchestrator: MemberView;
  /** Contributors only; the orchestrator owns the centre pane. */
  members: MemberView[];
  artifact?: { filename: string; path: string };
  /** Every degradation the run reported, with the agent it happened to. */
  degradations: Array<{ degradation: Degradation; agentId?: AgentId; subAgentId?: string }>;
  errors: Array<{ stage: string; message: string; agentId?: AgentId; retryable: boolean }>;
  usage: TokenUsage;
  eventCount: number;
  /** Questions the user has been asked but not yet answered. */
  pendingQuestions: Array<{ questionId: string; agentId: AgentId; displayName: string; question: string; reason: string }>;
}

export function buildTaskView(
  team: TeamDefinition,
  taskId: string,
  events: readonly RuntimeEvent[],
): TaskView {
  const members = new Map<AgentId, MemberView>();
  for (const member of team.members) {
    members.set(member.agentId, {
      agentId: member.agentId,
      displayName: member.displayName,
      roleId: member.role.roleId,
      roleDisplayName: member.role.displayName,
      responsibility: member.role.responsibility,
      panelSections: [...member.role.panelSections],
      isOrchestrator: member.agentId === team.orchestratorId,
      status: "idle",
      stages: [],
      toolCalls: [],
      sources: [],
      subAgents: [],
      degradations: [],
      usage: EMPTY_TOKEN_USAGE,
    });
  }

  const view: TaskView = {
    taskId,
    status: "idle",
    chat: [],
    orchestrator: members.get(team.orchestratorId)!,
    members: [],
    degradations: [],
    errors: [],
    usage: EMPTY_TOKEN_USAGE,
    eventCount: events.length,
    pendingQuestions: [],
  };

  const answered = new Set<string>();
  const askedQuestions = new Map<
    string,
    { questionId: string; agentId: AgentId; displayName: string; question: string; reason: string }
  >();

  const memberFor = (agentId: AgentId | undefined): MemberView | undefined =>
    agentId === undefined ? undefined : members.get(agentId);

  const subAgentFor = (parentAgentId: AgentId, subAgentId: string): SubAgentView | undefined =>
    members.get(parentAgentId)?.subAgents.find((entry) => entry.subAgentId === subAgentId);

  for (const event of events) {
    const body = event.body;

    switch (body.type) {
      case "task_status":
        view.status = body.status;
        break;

      case "user_message":
        view.chat.push({
          id: `${event.seq}`,
          kind: "user",
          displayName: "You",
          text: body.text,
          at: event.at,
        });
        break;

      case "agent_message": {
        const member = memberFor(body.agentId);
        view.chat.push({
          id: `${event.seq}`,
          kind: "agent",
          agentId: body.agentId,
          displayName: member?.displayName ?? body.agentId,
          text: body.text,
          at: event.at,
        });
        break;
      }

      case "agent_question": {
        const member = memberFor(body.agentId);
        const displayName = member?.displayName ?? body.agentId;
        view.chat.push({
          id: `${event.seq}`,
          kind: "question",
          agentId: body.agentId,
          displayName,
          text: body.question,
          reason: body.reason,
          at: event.at,
        });
        askedQuestions.set(body.questionId, {
          questionId: body.questionId,
          agentId: body.agentId,
          displayName,
          question: body.question,
          reason: body.reason,
        });
        break;
      }

      case "user_answer":
        answered.add(body.questionId);
        view.chat.push({
          id: `${event.seq}`,
          kind: "answer",
          displayName: "You",
          text: body.text,
          at: event.at,
        });
        break;

      case "task_brief_updated":
        view.brief = body.brief;
        break;

      case "agent_dispatched": {
        const member = memberFor(body.agentId);
        if (member) {
          member.status = "dispatched";
          member.objective = body.objective;
        }
        break;
      }

      case "agent_stage": {
        const member = memberFor(body.agentId);
        if (member) {
          if (member.status === "idle" || member.status === "dispatched") member.status = "working";
          member.stages.push({
            stage: body.stage,
            detail: body.detail,
            at: event.at,
            ...(body.sources ? { sources: body.sources } : {}),
          });
          if (body.sources) member.sources = mergeSources(member.sources, body.sources);
        }
        break;
      }

      case "tool_call": {
        const member = memberFor(body.agentId);
        if (!member) break;
        const call: ToolCallView = {
          tool: body.tool,
          intent: body.intent,
          outcome: body.outcome,
          detail: body.detail,
          at: event.at,
        };
        // A sub-agent's tool calls belong to that sub-agent's nested view.
        const subAgent = body.subAgentId
          ? subAgentFor(body.agentId, body.subAgentId)
          : undefined;
        if (subAgent) subAgent.toolCalls.push(call);
        else member.toolCalls.push(call);
        break;
      }

      case "agent_contribution": {
        const member = memberFor(body.agentId);
        if (member) {
          member.status = "contributed";
          member.contribution = {
            schemaId: body.schemaId,
            payload: (body.payload ?? {}) as Record<string, unknown>,
          };
        }
        break;
      }

      case "subagent_spawned": {
        const member = memberFor(body.parentAgentId);
        member?.subAgents.push({
          subAgentId: body.subAgentId,
          objective: body.objective,
          depth: body.depth,
          tools: [...body.tools],
          tokenBudget: body.tokenBudget,
          status: "running",
          stages: [],
          toolCalls: [],
        });
        break;
      }

      case "subagent_stage": {
        subAgentFor(body.parentAgentId, body.subAgentId)?.stages.push({
          stage: body.stage,
          detail: body.detail,
          at: event.at,
        });
        break;
      }

      case "subagent_completed": {
        const subAgent = subAgentFor(body.parentAgentId, body.subAgentId);
        if (subAgent) {
          subAgent.status = "completed";
          subAgent.summary = body.summary;
          subAgent.tokensUsed = body.tokensUsed;
        }
        break;
      }

      case "subagent_aborted": {
        const subAgent = subAgentFor(body.parentAgentId, body.subAgentId);
        if (subAgent) {
          subAgent.status = "aborted";
          subAgent.abortReason = body.reason;
          subAgent.abortDetail = body.detail;
        }
        break;
      }

      case "degradation": {
        view.degradations.push({
          degradation: body.degradation,
          ...(body.agentId ? { agentId: body.agentId } : {}),
          ...(body.subAgentId ? { subAgentId: body.subAgentId } : {}),
        });
        memberFor(body.agentId)?.degradations.push(body.degradation);
        break;
      }

      case "model_usage": {
        view.usage = addUsage(view.usage, body.usage);
        const member = memberFor(body.agentId);
        if (member) member.usage = addUsage(member.usage, body.usage);
        break;
      }

      case "artifact_written":
        view.artifact = { filename: body.filename, path: body.path };
        break;

      case "error": {
        view.errors.push({
          stage: body.stage,
          message: body.message,
          retryable: body.retryable,
          ...(body.agentId ? { agentId: body.agentId } : {}),
        });
        const member = memberFor(body.agentId);
        if (member && body.stage !== "member_questions") {
          member.status = "failed";
          member.error = { message: body.message, retryable: body.retryable };
        }
        break;
      }
    }
  }

  view.members = team.members
    .filter((member) => member.agentId !== team.orchestratorId)
    .map((member) => members.get(member.agentId)!);

  view.pendingQuestions = [...askedQuestions.values()].filter(
    (question) => !answered.has(question.questionId),
  );

  return view;
}

function mergeSources(existing: SourceNote[], incoming: readonly SourceNote[]): SourceNote[] {
  const byUrl = new Map(existing.map((source) => [source.url, source]));
  for (const source of incoming) {
    if (!byUrl.has(source.url)) byUrl.set(source.url, source);
  }
  return [...byUrl.values()];
}

export function memberStatusLabel(status: MemberStatus): string {
  switch (status) {
    case "idle":
      return "Waiting";
    case "dispatched":
      return "Dispatched";
    case "working":
      return "Working";
    case "contributed":
      return "Contribution ready";
    case "failed":
      return "Blocked";
  }
}

export const TASK_STAGE_ORDER: readonly TaskStatus[] = [
  "chatting",
  "agent_questioning",
  "brief_ready",
  "dispatching",
  "running",
  "merging",
  "writing_outputs",
  "completed",
];

export function taskStatusLabel(status: TaskStatus): string {
  switch (status) {
    case "idle":
      return "Idle";
    case "chatting":
      return "Reading your request";
    case "agent_questioning":
      return "Asking you";
    case "brief_ready":
      return "Task Brief ready";
    case "dispatching":
      return "Dispatching";
    case "running":
      return "Team working";
    case "merging":
      return "Merging";
    case "writing_outputs":
      return "Writing prd.md";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
  }
}
