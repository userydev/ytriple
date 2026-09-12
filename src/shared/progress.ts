import type { MemberId, Task, TaskEvent } from "./types.js";

export type ProgressStatus =
  "running" | "completed" | "waiting" | "paused" | "failed" | "stale";
export interface ToolProgress {
  id: string;
  callId: string;
  tool: string;
  status: ProgressStatus;
  summary: string;
  startedAt: string;
  updatedAt: string;
  receiver?: MemberId;
  childInvocationId?: string;
  sourceId?: string;
  artifactId?: string;
}
export interface AgentProgress {
  id: string;
  invocationId: string;
  member: MemberId;
  scope: string;
  parentInvocationId?: string;
  parentCallId?: string;
  specialist: boolean;
  status: ProgressStatus;
  latestSummary: string;
  startedAt: string;
  updatedAt: string;
  tools: ToolProgress[];
  sourceIds: string[];
  artifactIds: string[];
  reports: TaskEvent[];
}
const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const members = new Set<string>(["coordinator", "cto", "researcher"]);
const memberId = (value: unknown): MemberId | undefined =>
  typeof value === "string" && members.has(value)
    ? (value as MemberId)
    : undefined;
const terminal = (type: string): ProgressStatus | undefined => {
  if (type.endsWith("_completed")) return "completed";
  if (type.endsWith("_paused")) return "paused";
  if (type.endsWith("_failed")) return "failed";
  if (type.endsWith("_waiting")) return "waiting";
  if (type.endsWith("_started") || type.endsWith("_resumed")) return "running";
  return undefined;
};
const add = (list: string[], value: unknown) => {
  if (typeof value === "string" && !list.includes(value)) list.push(value);
};

export const ANALYSIS_SECTIONS = [
  {
    id: "framing",
    title: "问题理解与计划",
    description: "如何理解目标、需要澄清的边界与核查方向",
  },
  {
    id: "evidence",
    title: "依据与发现",
    description: "资料说明了什么，还有哪些信息不确定",
  },
  {
    id: "alternatives",
    title: "方案与取舍",
    description: "可选路径、优缺点与适用条件",
  },
  {
    id: "decision",
    title: "判断与结论",
    description: "作出什么判断，以及判断的关键依据",
  },
] as const;
export type AnalysisSection = (typeof ANALYSIS_SECTIONS)[number]["id"];
export function publicAnalysisSection(
  event: TaskEvent,
): AnalysisSection | undefined {
  if (
    event.type.replaceAll(".", "_") !== "progress_reported" ||
    event.data?.hosted === true
  )
    return undefined;
  switch (event.data?.stage) {
    case "plan":
    case "framing":
      return "framing";
    case "finding":
    case "evidence":
      return "evidence";
    case "alternatives":
      return "alternatives";
    case "decision":
      return "decision";
    default:
      return undefined;
  }
}
export function currentProgressEvents(
  task: Pick<Task, "events" | "goalVersion">,
): TaskEvent[] {
  const events = task.events.filter(
    (event) => event.goalVersion === task.goalVersion,
  );
  const latestRunId = [...events]
    .reverse()
    .find((event) => /^run[_.](started|resumed)$/.test(event.type))
    ?.data?.runId;
  return typeof latestRunId === "string"
    ? events.filter(
        (event) => !event.data?.runId || event.data.runId === latestRunId,
      )
    : events;
}
export interface PublicExchange {
  id: string;
  sender: MemberId;
  receiver: MemberId;
  specialist: boolean;
  request?: string;
  response?: string;
  status: ProgressStatus;
  createdAt: string;
  invocationId?: string;
  runId?: string;
}
/** Only real delegation message fields are conversation, never raw model/tool payloads. */
export function buildPublicExchanges(
  events: TaskEvent[],
  taskStatus?: Task["status"],
): PublicExchange[] {
  const exchanges = new Map<string, PublicExchange>();
  const runStatuses = new Map<string, ProgressStatus>();
  let latestRunId: string | undefined;
  for (const event of events) {
    const type = event.type.replaceAll(".", "_");
    const runId = text(event.data?.runId);
    if (type.startsWith("run_") && runId) {
      const status = terminal(type);
      if (status) runStatuses.set(runId, status);
      if (type === "run_started" || type === "run_resumed") latestRunId = runId;
    }
    if (
      !/^delegation_(started|resumed|completed|failed|paused)$/.test(type) ||
      !event.member
    )
      continue;
    const data = event.data ?? {};
    const receiver = memberId(data.receiver);
    if (!receiver || typeof data.callId !== "string") continue;
    const id = `${runId ?? "legacy"}:${text(data.invocationId) ?? text(data.scope) ?? event.member}:${data.callId}`;
    const current = exchanges.get(id) ?? {
      id,
      sender: event.member,
      receiver,
      specialist: data.specialist === true,
      status: "running" as const,
      createdAt: event.createdAt,
      invocationId: text(data.invocationId),
      runId,
    };
    current.status = terminal(type) ?? current.status;
    if (typeof data.request === "string" && data.request.trim())
      current.request = data.request.slice(0, 4000);
    if (
      type === "delegation_completed" &&
      typeof data.result === "string" &&
      data.result.trim()
    )
      current.response = data.result.slice(0, 12000);
    exchanges.set(id, current);
  }
  return [...exchanges.values()].map((exchange) => {
    if (exchange.status !== "running") return exchange;
    const currentRun = !latestRunId || exchange.runId === latestRunId;
    const runStatus = exchange.runId
      ? runStatuses.get(exchange.runId)
      : undefined;
    const status =
      runStatus && runStatus !== "running"
        ? runStatus
        : currentRun
          ? (taskStatus ?? "running")
          : "stale";
    if (status === "running") return exchange;
    return {
      ...exchange,
      status:
        status === "paused" || status === "failed" || status === "waiting"
          ? status
          : "stale",
    };
  });
}

/** A view of committed, public events only. No SDK payloads or raw data are rendered. */
export function buildAgentProgress(
  task: Pick<Task, "events" | "goalVersion" | "status">,
): AgentProgress[] {
  // Re-running the same goal creates a fresh run. Old runs remain in the timeline but do not
  // masquerade as active teammates. Older data without run IDs remains readable by scope.
  const currentEvents = currentProgressEvents(task);
  const agents = new Map<string, AgentProgress>();
  for (const event of currentEvents) {
    const type = event.type.replaceAll(".", "_");
    if (
      !/^(agent_|tool_|delegation_|progress_reported|artifact_written|clarification_requested)/.test(
        type,
      )
    )
      continue;
    if (!event.member) continue;
    const data = event.data ?? {};
    const scope = text(data.scope) ?? event.member;
    const invocationId =
      text(data.invocationId) ?? `${text(data.runId) ?? "legacy"}:${scope}`;
    let lane = agents.get(invocationId);
    if (!lane) {
      lane = {
        id: invocationId,
        invocationId,
        member: event.member,
        scope,
        parentInvocationId: text(data.parentInvocationId),
        parentCallId: text(data.parentCallId),
        specialist: data.specialist === true || scope.endsWith("/specialist"),
        status: "running",
        latestSummary: event.summary,
        startedAt: event.createdAt,
        updatedAt: event.createdAt,
        tools: [],
        sourceIds: [],
        artifactIds: [],
        reports: [],
      };
      agents.set(invocationId, lane);
    }
    lane.updatedAt = event.createdAt;
    if (type.startsWith("agent_")) lane.status = terminal(type) ?? lane.status;
    // Keep a meaningful public finding visible after the generic completion notification.
    if (type === "progress_reported" || !lane.reports.length)
      lane.latestSummary = event.summary;
    if (type === "progress_reported") {
      lane.reports.push(event);
      if (Array.isArray(data.sourceIds))
        data.sourceIds.forEach((id) => add(lane.sourceIds, id));
      if (Array.isArray(data.artifactIds))
        data.artifactIds.forEach((id) => add(lane.artifactIds, id));
    }
    add(lane.sourceIds, data.sourceId);
    add(lane.artifactIds, data.artifactId);
    if (/^(tool|delegation)_/.test(type) && typeof data.callId === "string") {
      let activity = lane.tools.find((entry) => entry.callId === data.callId);
      if (!activity) {
        activity = {
          id: `${invocationId}:${data.callId}`,
          callId: data.callId,
          tool: text(data.tool) ?? "tool",
          status: "running",
          summary: event.summary,
          startedAt: event.createdAt,
          updatedAt: event.createdAt,
          receiver: memberId(data.receiver),
          childInvocationId: text(data.childInvocationId),
          sourceId: text(data.sourceId),
          artifactId: text(data.artifactId),
        };
        lane.tools.push(activity);
      }
      activity.status = terminal(type) ?? activity.status;
      activity.summary = event.summary;
      activity.updatedAt = event.createdAt;
      activity.artifactId = text(data.artifactId) ?? activity.artifactId;
    }
  }
  const lastRunEvent = [...currentEvents]
    .reverse()
    .find((event) =>
      /^run_(completed|paused|failed|waiting)$/.test(event.type),
    );
  const status = lastRunEvent ? terminal(lastRunEvent.type) : undefined;
  for (const lane of agents.values()) {
    if (lane.status === "running" && task.status !== "running") {
      lane.status =
        status ??
        (task.status === "paused" ||
        task.status === "failed" ||
        task.status === "waiting"
          ? task.status
          : "stale");
    }
    if (
      lane.status === "completed" &&
      lane.reports.length &&
      lane.reports.every((report) => report.data?.stage === "plan")
    )
      lane.latestSummary = "本次处理已完成。";
    for (const activity of lane.tools) {
      if (activity.status === "running" && lane.status !== "running") {
        // A final answer does not prove a tool whose completion event is missing succeeded.
        activity.status = lane.status === "completed" ? "stale" : lane.status;
      }
    }
  }
  return [...agents.values()];
}
