import test from "node:test";
import assert from "node:assert/strict";
import { buildAgentProgress } from "../src/shared/progress.js";
import type { TaskEvent } from "../src/shared/types.js";

function event(
  type: string,
  data: Record<string, unknown> = {},
  goalVersion = 2,
): TaskEvent {
  return {
    id: `${type}:${data.invocationId ?? "run"}`,
    createdAt: "2026-09-11T12:00:00Z",
    type,
    member: "researcher",
    summary: type,
    goalVersion,
    data: {
      runId: "new-run",
      scope: "coordinator/researcher",
      invocationId: "research-call",
      ...data,
    },
  };
}

test("progress excludes the previous goal and previous run instead of showing ghost workers", () => {
  const events = [
    event("run_started", { runId: "old-goal" }, 1),
    event(
      "agent_started",
      { invocationId: "old-goal-worker", runId: "old-goal" },
      1,
    ),
    event("run_started", { runId: "old-run" }),
    event("agent_started", {
      invocationId: "old-run-worker",
      runId: "old-run",
    }),
    event("run_started"),
    event("agent_started"),
  ];
  const lanes = buildAgentProgress({
    events,
    goalVersion: 2,
    status: "running",
  });
  assert.equal(lanes.length, 1);
  assert.equal(lanes[0].invocationId, "research-call");
  assert.equal(lanes[0].status, "running");
  assert.equal(
    buildAgentProgress({ events, goalVersion: 3, status: "idle" }).length,
    0,
  );
});

test("recovered interrupted task marks unmatched work paused, not completed", () => {
  const events = [
    event("agent_started"),
    event("tool_started", {
      callId: "read-call",
      tool: "read_source",
      sourceId: "s-1",
    }),
  ];
  const [lane] = buildAgentProgress({
    events,
    goalVersion: 2,
    status: "paused",
  });
  assert.equal(lane.status, "paused");
  assert.equal(lane.tools[0].status, "paused");
  assert.deepEqual(lane.sourceIds, ["s-1"]);
  const [completedLane] = buildAgentProgress({
    events: [...events, event("run_completed")],
    goalVersion: 2,
    status: "completed",
  });
  assert.equal(
    completedLane.tools[0].status,
    "stale",
    "missing tool completion is not proof of success",
  );
});

test("resumed invocations and tool calls preserve identity, public finding and output links", () => {
  const events = [
    event("agent_started", {
      parentInvocationId: "coordinator-call",
      parentCallId: "delegate-1",
    }),
    event("tool_started", { callId: "write-1", tool: "write_artifact" }),
    event("tool_paused", { callId: "write-1", tool: "write_artifact" }),
    event("agent_paused"),
    event("agent_resumed"),
    event("tool_resumed", { callId: "write-1", tool: "write_artifact" }),
    event("tool_completed", {
      callId: "write-1",
      tool: "write_artifact",
      artifactId: "report-1",
    }),
    {
      ...event("progress_reported", {
        sourceIds: ["s-1", "s-1"],
        artifactIds: ["report-1"],
        stage: "finding",
      }),
      summary: "已核查的重要发现。",
    },
    event("agent_completed"),
    event("run_completed"),
  ];
  const [lane] = buildAgentProgress({
    events,
    goalVersion: 2,
    status: "completed",
  });
  assert.equal(lane.tools.length, 1);
  assert.equal(lane.tools[0].status, "completed");
  assert.equal(lane.parentInvocationId, "coordinator-call");
  assert.equal(lane.parentCallId, "delegate-1");
  assert.equal(lane.latestSummary, "已核查的重要发现。");
  assert.deepEqual(lane.sourceIds, ["s-1"]);
  assert.deepEqual(lane.artifactIds, ["report-1"]);
});
