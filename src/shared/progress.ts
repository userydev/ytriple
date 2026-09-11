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

/** A view of committed, public events only. No SDK payloads or raw data are rendered. */
export function buildAgentProgress(
  task: Pick<Task, "events" | "goalVersion" | "status">,
): AgentProgress[] {
  const events = task.events.filter(
    (event) => event.goalVersion === task.goalVersion,
  );
  // Re-running the same goal creates a fresh run. Old runs remain in the timeline but do not
  // masquerade as active teammates. Older data without run IDs remains readable by scope.
  const latestRunId = [...events]
    .reverse()
    .find((event) => /^run_(started|resumed)$/.test(event.type))?.data?.runId;
  const currentEvents =
    typeof latestRunId === "string"
      ? events.filter(
          (event) => !event.data?.runId || event.data.runId === latestRunId,
        )
      : events;
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
    for (const activity of lane.tools) {
      if (activity.status === "running" && lane.status !== "running") {
        // A final answer does not prove a tool whose completion event is missing succeeded.
        activity.status = lane.status === "completed" ? "stale" : lane.status;
      }
    }
  }
  return [...agents.values()];
}
