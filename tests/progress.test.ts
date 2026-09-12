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

test("a completed legacy run does not keep its initial in-progress plan as the current status", () => {
  const plan = {
    ...event("progress_reported", { stage: "plan" }),
    summary: "已接收任务，正在处理。",
  };
  const [lane] = buildAgentProgress({
    events: [
      event("agent_started"),
      plan,
      event("agent_completed"),
      event("run_completed"),
    ],
    goalVersion: 2,
    status: "completed",
  });
  assert.equal(lane.latestSummary, "本次处理已完成。");
  assert.equal(lane.reports[0].summary, plan.summary);
});

test("public analysis classifies only explicit summaries, keeping hosted action states separate", async () => {
  const { publicAnalysisSection } = await import("../src/shared/progress.js");
  assert.equal(
    publicAnalysisSection(event("progress_reported", { stage: "framing" })),
    "framing",
  );
  assert.equal(
    publicAnalysisSection(event("progress_reported", { stage: "finding" })),
    "evidence",
  );
  assert.equal(
    publicAnalysisSection(
      event("progress_reported", { stage: "alternatives" }),
    ),
    "alternatives",
  );
  assert.equal(
    publicAnalysisSection(
      event("progress_reported", { stage: "plan", hosted: true }),
    ),
    undefined,
  );
  assert.equal(
    publicAnalysisSection(
      event("raw_model_stream_event", {
        stage: "decision",
        reasoning: "private",
      }),
    ),
    undefined,
  );
});

test("member conversation combines actual delegation request and result without exposing other payload fields", async () => {
  const { buildPublicExchanges } = await import("../src/shared/progress.js");
  const exchanges = buildPublicExchanges([
    event("delegation_started", {
      callId: "c",
      receiver: "cto",
      request: "Compare the two designs.",
      reasoning: "PRIVATE",
      raw: "PRIVATE",
    }),
    event("tool_completed", {
      callId: "other",
      receiver: "cto",
      result: "PRIVATE TOOL BODY",
    }),
    event("delegation_completed", {
      callId: "c",
      receiver: "cto",
      result: "Design A supports offline use.",
      providerData: "PRIVATE",
    }),
  ]);
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0].request, "Compare the two designs.");
  assert.equal(exchanges[0].response, "Design A supports offline use.");
  assert.equal(exchanges[0].status, "completed");
  assert.doesNotMatch(
    JSON.stringify(exchanges),
    /PRIVATE|reasoning|providerData/,
  );
});

test("interrupted member conversations cannot keep claiming they are working or completed", async () => {
  const { buildPublicExchanges } = await import("../src/shared/progress.js");
  const events = [
    event("delegation_started", {
      callId: "c",
      receiver: "cto",
      request: "Compare.",
    }),
  ];
  assert.equal(buildPublicExchanges(events, "paused")[0].status, "paused");
  assert.equal(buildPublicExchanges(events, "completed")[0].status, "stale");
});

test("historical exchanges retain their own run state when a later run pauses", async () => {
  const { buildPublicExchanges } = await import("../src/shared/progress.js");
  const events = [
    event("run_started", { runId: "old" }),
    event("delegation_completed", {
      runId: "old",
      callId: "same-call",
      receiver: "cto",
      result: "Old completed response",
    }),
    event("delegation_started", {
      runId: "old",
      callId: "missing-end",
      receiver: "cto",
    }),
    event("run_completed", { runId: "old" }),
    event("run_started", { runId: "new" }),
    event("delegation_started", {
      runId: "new",
      callId: "same-call",
      receiver: "cto",
    }),
    event("run_paused", { runId: "new" }),
  ];
  const exchanges = buildPublicExchanges(events, "paused");
  assert.equal(exchanges.length, 3);
  assert.equal(exchanges[0].status, "completed");
  assert.equal(exchanges[0].response, "Old completed response");
  assert.equal(
    exchanges[1].status,
    "stale",
    "a missing completion in a finished old run is unknown, not paused by the new run",
  );
  assert.equal(exchanges[2].status, "paused");
});

test("process sources distinguish citations, search hits, explicit reads and failed reads", async () => {
  const {
    buildProcessSources,
    publicReportDetails,
    publicAnalysisSection,
    publicSearchQueries,
  } = await import("../src/shared/progress.js");
  const events = [
    event("progress_reported", {
      stage: "finding",
      sourceIds: ["local"],
      detail: "可公开解释",
      method: "交叉对照",
      questions: ["样本是否可比？"],
      reasoning: "PRIVATE",
    }),
    event("progress_reported", {
      hosted: true,
      progressKind: "search",
      queries: ["actual query"],
      webSources: [
        {
          title: "Search",
          url: "https://example.com/search",
          status: "searched",
        },
        {
          title: "Citation",
          url: "https://example.com/citation",
          status: "cited",
        },
        {
          title: "Blocked",
          url: "https://example.com/blocked",
          status: "unavailable",
        },
      ],
    }),
    event("progress_reported", {
      hosted: true,
      progressKind: "source",
      webSources: [
        { title: "Search", url: "https://example.com/search", status: "read" },
        { url: "javascript:bad", status: "read" },
        { url: "https://example.com/prototype", status: "__proto__" },
      ],
    }),
  ];
  const task = {
    sources: [
      {
        id: "local",
        title: "Local reference",
        type: "text" as const,
        location: "",
        coverage: "全文已导入",
        text: "正文",
        addedAt: "",
      },
    ],
  };
  const sources = buildProcessSources(task, events);
  assert.equal(sources.length, 4);
  assert.equal(
    sources.find((source) => source.sourceId === "local")?.status,
    "cited",
  );
  assert.equal(
    sources.find((source) => source.url.endsWith("/search"))?.status,
    "read",
  );
  assert.equal(
    sources.find((source) => source.url.endsWith("/citation"))?.status,
    "cited",
  );
  assert.equal(
    sources.find((source) => source.url.endsWith("/blocked"))?.status,
    "unavailable",
  );
  const readSources = buildProcessSources(task, [
    ...events,
    event("tool_completed", { tool: "read_source", sourceId: "local" }),
  ]);
  assert.equal(
    readSources.find((source) => source.sourceId === "local")?.status,
    "read",
  );
  assert.deepEqual(publicReportDetails(events[0]), {
    detail: "可公开解释",
    method: "交叉对照",
    questions: ["样本是否可比？"],
  });
  assert.deepEqual(publicSearchQueries(events), ["actual query"]);
  assert.equal(
    publicAnalysisSection(
      event("progress_reported", { hosted: true, progressKind: "analysis" }),
    ),
    "provider",
  );
  assert.doesNotMatch(JSON.stringify(sources), /PRIVATE|javascript|prototype/);
});
