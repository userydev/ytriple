import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponder,
  modelStreamResponder,
  modelError,
} from "@openai/agents/testing";
import type {
  Artifact,
  MemberId,
  ModelProfile,
  RadarDigestPublicationInput,
  Task,
} from "../src/shared/types.js";
import {
  TeamRuntime,
  type RuntimeCheckpoint,
  type RuntimeHooks,
} from "../src/core/runtime.js";
import { buildAgentProgress } from "../src/shared/progress.js";
import { createGoogleAgentModel } from "../src/core/google-agents.js";

function fixture() {
  const task: Task = {
    id: "task-1",
    title: "测试",
    goal: "读取资料，与研究员核查后保存报告。",
    goalVersion: 1,
    kind: "research",
    member: "coordinator",
    workspace: "/unused",
    status: "idle",
    createdAt: "",
    updatedAt: "",
    messages: [],
    events: [],
    artifacts: [],
    sources: [
      {
        id: "source-1",
        title: "合成资料",
        type: "text",
        location: "",
        text: "synthetic evidence: ORCHID 42",
        addedAt: "",
        coverage: "全文",
      },
    ],
  };
  const profiles = Object.fromEntries(
    ["coordinator", "cto", "researcher"].map((member) => [
      member,
      {
        id: member,
        name: member,
        provider: "compatible",
        protocol: "openai",
        baseURL: "https://example.test/v1",
        modelId: `${member}-model`,
        apiKeyEnv: "TEST_KEY",
        hasKey: true,
        status: "ready",
        capabilities: { text: true, tools: true, streaming: true },
      },
    ]),
  ) as Record<MemberId, ModelProfile>;
  let saved: RuntimeCheckpoint | undefined;
  let writes = 0;
  const operations = new Map<string, Artifact>();
  const hooks: RuntimeHooks = {
    getTask: () => task,
    getProfile: (_task, member) => profiles[member],
    readKey: () => "synthetic-key",
    appendEvent: (_id, event) => {
      assert.equal(event.goalVersion, task.goalVersion, "late event");
      task.events.push({ ...event, id: randomUUID(), createdAt: "" });
    },
    addAssistantMessage: (_id, member, content, goalVersion) => {
      assert.equal(goalVersion, task.goalVersion, "late message");
      task.messages.push({
        id: randomUUID(),
        member,
        content,
        goalVersion,
        role: "assistant",
        createdAt: "",
      });
    },
    writeArtifact: async (_id, input) => {
      assert.equal(input.goalVersion, task.goalVersion, "late write");
      const previous = operations.get(input.operationId);
      if (previous) return previous;
      const existing = task.artifacts.find((a) => a.id === input.artifactId);
      if (existing)
        assert.equal(existing.hash, input.expectedHash, "version conflict");
      writes++;
      const artifact: Artifact = {
        id: existing?.id ?? randomUUID(),
        title: input.title,
        content: input.content,
        format: input.format,
        path: "/unused/report.md",
        goalVersion: input.goalVersion,
        hash: createHash("sha256").update(input.content).digest("hex"),
        version: (existing?.version ?? 0) + 1,
        updatedAt: "",
        versions: [],
      };
      if (existing)
        task.artifacts.splice(task.artifacts.indexOf(existing), 1, artifact);
      else task.artifacts.push(artifact);
      operations.set(input.operationId, artifact);
      return artifact;
    },
    publishRadarDigest: async () => ({ digests: [], dispositions: [] }),
    loadCheckpoint: () => saved,
    saveCheckpoint: (_id, value) => {
      saved = value ? structuredClone(value) : undefined;
    },
    setStatus: (_id, status, error) => {
      task.status = status;
      task.error = error;
    },
  };
  return {
    task,
    profiles,
    hooks,
    checkpoint: () => saved,
    writes: () => writes,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const draft = {
  title: "合成报告",
  content: "# 结论\nORCHID 42",
  format: "md",
  artifactId: null,
  expectedHash: null,
};

function markAsRadarDigest(task: Task) {
  task.sources[0].remote = {
    serverInstanceId: "radar-server",
    tenantId: "tenant-1",
    sourceId: "remote-source-1",
    itemId: "remote-item-1",
    revisionId: "revision-1",
    contentHash: "a".repeat(64),
    observedAt: "2026-09-12T00:00:00.000Z",
    coverageLevel: "fulltext",
    missing: [],
  };
  task.events.push({
    id: "radar-digest-request",
    type: "radar.digest_requested",
    summary: "整理一批雷达资料",
    member: task.member,
    goalVersion: task.goalVersion,
    createdAt: "",
    data: { runId: "digest-run-1", sourceIds: ["source-1"] },
  });
}

test("only a marked Radar batch exposes the structured publication tool and persists its result", async () => {
  const f = fixture();
  markAsRadarDigest(f.task);
  f.task.sources.push({
    id: "context-1",
    title: "本地知识上下文",
    type: "text",
    location: "",
    text: "Earlier local understanding: ORCHID was 40.",
    addedAt: "",
    coverage: "Lib 条目第 3 版全文",
  });
  let published:
    | {
        operationId: string;
        input: RadarDigestPublicationInput;
      }
    | undefined;
  f.hooks.publishRadarDigest = async (
    _taskId,
    goalVersion,
    operationId,
    input,
  ) => {
    assert.equal(goalVersion, 1);
    published = { operationId, input: structuredClone(input) };
    return {
      digests: [{ id: "digest-1" } as never],
      dispositions: [],
    };
  };
  const publication: RadarDigestPublicationInput = {
    runId: "digest-run-1",
    themes: [
      {
        title: "ORCHID 指标已更新",
        summary: "最新雷达资料把 ORCHID 指标更新为 42。",
        whyItMatters: "这会修正本地原有的 40，并影响后续判断。",
        topics: ["ORCHID"],
        evidence: [
          {
            sourceId: "source-1",
            revisionId: "revision-1",
            note: "资料正文明确给出 42。",
          },
        ],
        context: [
          {
            sourceId: "context-1",
            relation: "conflicts",
            note: "本地旧版本记录为 40。",
          },
        ],
        disagreements: ["新旧数值不一致"],
        gaps: [],
      },
    ],
    dispositions: [],
  };
  const model = new ScriptedModel([
    modelResponder((call) => {
      assert.ok(
        call.request.tools.some(
          (entry) => entry.name === "publish_radar_digest",
        ),
      );
      assert.ok(
        !call.request.tools.some(
          (entry) => entry.name === "request_clarification",
        ),
        "hidden Radar work must resolve uncertainty as incomplete/deferred",
      );
      assert.ok(
        !call.request.tools.some(
          (entry) => entry.name === "request_clarification",
        ),
        "hidden Radar batches must resolve uncertainty as incomplete/deferred",
      );
      assert.match(
        call.request.systemInstructions!,
        /只有顶层成员调用 publish_radar_digest/,
      );
      assert.match(JSON.stringify(call.request.input), /digest-run-1/);
      return [
        functionCall(
          "read_source",
          { sourceId: "source-1", start: 0, maxCharacters: 1_000 },
          { callId: "read-radar" },
        ),
      ];
    }),
    [
      functionCall(
        "read_source",
        { sourceId: "context-1", start: 0, maxCharacters: 1_000 },
        { callId: "read-context" },
      ),
    ],
    [
      functionCall(
        "publish_radar_digest",
        { ...publication },
        { callId: "publish-radar" },
      ),
    ],
    modelResponder((call) => {
      assert.match(JSON.stringify(call.request.input), /digest-1/);
      return [assistantMessage("本批雷达资料已形成主题理解。")];
    }),
  ]);
  await new TeamRuntime(f.hooks, { modelFactory: () => model }).run(f.task.id);
  assert.equal(f.task.status, "completed", f.task.error);
  assert.deepEqual(published?.input, publication);
  assert.match(published?.operationId ?? "", /publish-radar$/);
  assert.ok(
    f.task.events.some(
      (event) =>
        event.type === "tool_completed" &&
        event.data?.tool === "publish_radar_digest" &&
        event.data?.digestRunId === "digest-run-1",
    ),
  );
  const reads = f.task.events.filter(
    (event) =>
      event.type === "tool_completed" && event.data?.tool === "read_source",
  );
  assert.deepEqual(
    reads.map((event) => ({
      sourceId: event.data?.sourceId,
      readStart: event.data?.readStart,
      readEnd: event.data?.readEnd,
      totalCharacters: event.data?.totalCharacters,
    })),
    [
      {
        sourceId: "source-1",
        readStart: 0,
        readEnd: f.task.sources[0]!.text.length,
        totalCharacters: f.task.sources[0]!.text.length,
      },
      {
        sourceId: "context-1",
        readStart: 0,
        readEnd: f.task.sources[1]!.text.length,
        totalCharacters: f.task.sources[1]!.text.length,
      },
    ],
  );
  model.assertComplete();
});

test("Radar publication merges contiguous paginated reads into full source coverage", async () => {
  const f = fixture();
  markAsRadarDigest(f.task);
  f.task.sources[0]!.text = "R".repeat(30_000);
  let publications = 0;
  f.hooks.publishRadarDigest = async () => {
    publications++;
    return { digests: [{ id: "digest-paged" } as never], dispositions: [] };
  };
  const publication: RadarDigestPublicationInput = {
    runId: "digest-run-1",
    themes: [
      {
        title: "分页核查后的主题",
        summary: "两段连续读取共同覆盖了锁定正文。",
        whyItMatters: "完整范围证明阻止局部文字冒充全文核查。",
        evidence: [{ sourceId: "source-1", revisionId: "revision-1" }],
      },
    ],
    dispositions: [],
  };
  const model = new ScriptedModel([
    modelResponder((call) => {
      const readTool = call.request.tools.find(
        (entry) => entry.name === "read_source",
      );
      assert.match(
        readTool && "description" in readTool ? readTool.description : "",
        /hasMore=false/,
      );
      assert.match(call.request.systemInstructions ?? "", /读取范围不能留缺口/);
      return [
        functionCall(
          "read_source",
          { sourceId: "source-1", start: 0, maxCharacters: 24_000 },
          { callId: "read-first-page" },
        ),
      ];
    }),
    [
      functionCall(
        "read_source",
        { sourceId: "source-1", start: 24_000, maxCharacters: 24_000 },
        { callId: "read-second-page" },
      ),
    ],
    [
      functionCall(
        "publish_radar_digest",
        { ...publication },
        { callId: "publish-paged" },
      ),
    ],
    [assistantMessage("已在完整读取后发布。")],
  ]);

  await new TeamRuntime(f.hooks, { modelFactory: () => model }).run(f.task.id);
  assert.equal(f.task.status, "completed", f.task.error);
  assert.equal(publications, 1);
  assert.deepEqual(
    f.task.events
      .filter(
        (event) =>
          event.type === "tool_completed" && event.data?.tool === "read_source",
      )
      .map((event) => [event.data?.readStart, event.data?.readEnd]),
    [
      [0, 24_000],
      [24_000, 30_000],
    ],
  );
  model.assertComplete();
});

test("Radar publication rejects partial evidence and out-of-range reads before persistence", async () => {
  const f = fixture();
  markAsRadarDigest(f.task);
  f.task.sources[0]!.text = "ABCDE";
  let publications = 0;
  f.hooks.publishRadarDigest = async () => {
    publications++;
    return { digests: [], dispositions: [] };
  };
  const publication: RadarDigestPublicationInput = {
    runId: "digest-run-1",
    themes: [
      {
        title: "不能发布的局部判断",
        summary: "只读取一个字符不足以支持主题。",
        whyItMatters: "未经全文核查的判断不能进入雷达。",
        evidence: [{ sourceId: "source-1", revisionId: "revision-1" }],
      },
    ],
    dispositions: [],
  };
  const model = new ScriptedModel([
    [
      functionCall(
        "read_source",
        { sourceId: "source-1", start: 0, maxCharacters: 1 },
        { callId: "read-one-character" },
      ),
    ],
    [
      functionCall(
        "read_source",
        { sourceId: "source-1", start: 999, maxCharacters: 1 },
        { callId: "read-out-of-range" },
      ),
    ],
    [
      functionCall(
        "publish_radar_digest",
        { ...publication },
        { callId: "publish-partial" },
      ),
    ],
    [assistantMessage("普通文字不能绕过发布校验。")],
  ]);

  await new TeamRuntime(f.hooks, { modelFactory: () => model }).run(f.task.id);
  assert.equal(f.task.status, "failed");
  assert.equal(publications, 0);
  const validRead = f.task.events.find(
    (event) =>
      event.type === "tool_completed" &&
      event.data?.callId === "read-one-character",
  );
  assert.deepEqual(
    {
      start: validRead?.data?.readStart,
      end: validRead?.data?.readEnd,
      total: validRead?.data?.totalCharacters,
    },
    { start: 0, end: 1, total: 5 },
  );
  const invalidRead = f.task.events.findLast(
    (event) => event.data?.callId === "read-out-of-range",
  );
  assert.equal(invalidRead?.type, "tool_failed");
  assert.equal(invalidRead?.data?.readStart, undefined);
  assert.match(String(invalidRead?.data?.error), /超出正文范围/);
  const rejectedPublication = f.task.events.findLast(
    (event) => event.data?.callId === "publish-partial",
  );
  assert.equal(rejectedPublication?.type, "tool_failed");
  assert.match(String(rejectedPublication?.data?.error), /完整分页读取/);
  model.assertComplete();
});

test("Radar publication allows a non-empty partial read only with incomplete disposition", async () => {
  const f = fixture();
  markAsRadarDigest(f.task);
  f.task.sources[0]!.text = "正文仍缺少后续页面";
  let published: RadarDigestPublicationInput | undefined;
  f.hooks.publishRadarDigest = async (_taskId, _goal, _operation, input) => {
    published = structuredClone(input);
    return { digests: [], dispositions: [{ id: "incomplete" } as never] };
  };
  const publication: RadarDigestPublicationInput = {
    runId: "digest-run-1",
    themes: [],
    dispositions: [
      {
        sourceId: "source-1",
        kind: "incomplete",
        reason: "只收到部分正文，先保留并等待后续修订。",
      },
    ],
  };
  const model = new ScriptedModel([
    [
      functionCall(
        "read_source",
        { sourceId: "source-1", start: 0, maxCharacters: 1 },
        { callId: "read-partial-incomplete" },
      ),
    ],
    [
      functionCall(
        "publish_radar_digest",
        { ...publication },
        { callId: "publish-incomplete" },
      ),
    ],
    [assistantMessage("已明确保留为资料不完整。")],
  ]);

  await new TeamRuntime(f.hooks, { modelFactory: () => model }).run(f.task.id);
  assert.equal(f.task.status, "completed", f.task.error);
  assert.deepEqual(published, publication);
  model.assertComplete();
});

test("Radar final prose cannot impersonate a digest publication", async () => {
  const f = fixture();
  markAsRadarDigest(f.task);
  let publications = 0;
  f.hooks.publishRadarDigest = async () => {
    publications++;
    return { digests: [], dispositions: [] };
  };
  const model = new ScriptedModel([
    modelResponder((call) => {
      assert.ok(
        call.request.tools.some(
          (entry) => entry.name === "publish_radar_digest",
        ),
      );
      return [assistantMessage("我在普通回复里声称已经整理好了。")];
    }),
  ]);
  await new TeamRuntime(f.hooks, { modelFactory: () => model }).run(f.task.id);
  assert.equal(f.task.status, "failed");
  assert.match(f.task.error ?? "", /未调用 publish_radar_digest/);
  assert.equal(publications, 0);
  assert.equal(f.task.messages.length, 0);
});

test("ordinary tasks never receive the Radar publication capability", async () => {
  const f = fixture();
  const model = new ScriptedModel([
    modelResponder((call) => {
      assert.ok(
        !call.request.tools.some(
          (entry) => entry.name === "publish_radar_digest",
        ),
      );
      return [assistantMessage("普通任务已完成。")];
    }),
  ]);
  await new TeamRuntime(f.hooks, { modelFactory: () => model }).run(f.task.id);
  assert.equal(f.task.status, "completed", f.task.error);
});

test("SDK executes member delegation, reads evidence, consumes returned results and writes an artifact", async () => {
  const f = fixture();
  const researcher = new ScriptedModel([
    [
      functionCall(
        "read_source",
        { sourceId: "source-1", start: 0, maxCharacters: 1000 },
        { callId: "read-1" },
      ),
    ],
    modelResponder((call) => {
      assert.match(JSON.stringify(call.request.input), /ORCHID 42/);
      return [
        functionCall(
          "report_progress",
          {
            stage: "finding",
            summary: "资料 source-1 已核对，关键结果为 ORCHID 42。",
            detail: "资料正文提供了结果，仍需要独立核查样本范围。",
            method: "先读正文，再对照统计口径。",
            questions: ["样本范围是否完整？"],
            sourceIds: ["source-1"],
            artifactIds: [],
          },
          { callId: "report-1" },
        ),
      ];
    }),
    modelResponder((call) => {
      assert.match(JSON.stringify(call.request.input), /recorded/);
      return [assistantMessage("已从 source-1 核对：ORCHID 42。")];
    }),
  ]);
  const coordinator = new ScriptedModel([
    [
      functionCall(
        "consult_researcher",
        { input: "读取 source-1 并返回核查结果" },
        { callId: "delegate-1" },
      ),
    ],
    modelResponder((call) => {
      assert.match(JSON.stringify(call.request.input), /已从 source-1 核对/);
      return [functionCall("write_artifact", draft, { callId: "write-1" })];
    }),
    [assistantMessage("已核查并保存报告。")],
  ]);
  const selected: string[] = [];
  const runtime = new TeamRuntime(f.hooks, {
    modelFactory: (profile, _key, member) => {
      selected.push(profile.id);
      return member === "researcher" ? researcher : coordinator;
    },
  });
  await runtime.run(f.task.id);
  assert.equal(f.task.status, "completed", f.task.error);
  assert.equal(f.writes(), 1);
  assert.deepEqual(selected.sort(), ["coordinator", "researcher"]);
  assert.ok(f.task.events.some((e) => e.type === "delegation_started"));
  assert.ok(
    f.task.events.some(
      (e) => e.member === "researcher" && e.type === "agent_completed",
    ),
  );
  assert.ok(
    f.task.events.some(
      (e) =>
        e.type === "artifact_written" &&
        typeof e.data?.operationId === "string",
    ),
  );
  const delegation = f.task.events.find(
    (event) => event.type === "delegation_started",
  )!;
  const read = f.task.events.find(
    (event) =>
      event.type === "tool_completed" && event.data?.tool === "read_source",
  )!;
  const report = f.task.events.find(
    (event) => event.type === "progress_reported",
  )!;
  assert.equal(read.data?.sourceId, "source-1");
  assert.equal(read.summary, "研究员已阅读资料");
  assert.ok(
    f.task.events
      .filter((event) => /^(tool|delegation)_/.test(event.type))
      .every(
        (event) =>
          !/read_source|read_artifact|write_artifact|report_progress|list_materials|consult_researcher/.test(
            event.summary,
          ),
      ),
    "public activity uses readable labels while data.tool preserves protocol names",
  );
  assert.equal(read.data?.invocationId, delegation.data?.childInvocationId);
  assert.equal(read.data?.parentInvocationId, delegation.data?.invocationId);
  assert.equal(report.data?.invocationId, read.data?.invocationId);
  assert.deepEqual(report.data?.sourceIds, ["source-1"]);
  assert.equal(report.data?.stage, "finding");
  assert.equal(
    report.data?.detail,
    "资料正文提供了结果，仍需要独立核查样本范围。",
  );
  assert.equal(report.data?.method, "先读正文，再对照统计口径。");
  assert.deepEqual(report.data?.questions, ["样本范围是否完整？"]);
  assert.ok(
    !read.data?.result,
    "source body must not be copied into the event log",
  );
  const lanes = buildAgentProgress(f.task);
  assert.equal(lanes.length, 2);
  assert.ok(lanes.every((lane) => lane.status === "completed"));
  assert.equal(
    lanes.find((lane) => lane.member === "researcher")?.tools.length,
    2,
  );
  assert.equal(
    f.task.events.filter((event) => event.type === "agent_started").length,
    2,
    "approval checkpoints do not create extra agent cards",
  );
  assert.equal(f.task.messages.at(-1)?.content, "已核查并保存报告。");
  assert.equal(f.checkpoint(), undefined);
  coordinator.assertComplete();
  researcher.assertComplete();
});

test("a changed goal rejects a provider response that arrives late", async () => {
  const f = fixture();
  const started = deferred<void>();
  const finish = deferred<void>();
  const model = new ScriptedModel([
    modelResponder(async () => {
      started.resolve();
      await finish.promise;
      return [functionCall("write_artifact", draft, { callId: "late-write" })];
    }),
  ]);
  const runtime = new TeamRuntime(f.hooks, { modelFactory: () => model });
  const done = runtime.run(f.task.id);
  await started.promise;
  f.task.goalVersion = 2;
  f.task.goal = "新的目标";
  f.task.status = "idle";
  const eventCount = f.task.events.length;
  finish.resolve();
  await done;
  assert.equal(f.writes(), 0);
  assert.equal(f.task.messages.length, 0);
  assert.equal(f.task.events.length, eventCount);
  assert.equal(f.task.status, "idle");
});

test("pause serializes SDK state; a new runtime resumes after an already committed tool", async () => {
  const f = fixture();
  const startedSecondRequest = deferred<void>();
  const firstModel = new ScriptedModel([
    [functionCall("write_artifact", draft, { callId: "write-before-pause" })],
    modelStreamResponder(async () => {
      startedSecondRequest.resolve();
      return (async function* () {
        await new Promise(() => undefined);
      })();
    }),
  ]);
  const first = new TeamRuntime(f.hooks, { modelFactory: () => firstModel });
  const run = first.run(f.task.id);
  await startedSecondRequest.promise;
  await first.stop(f.task.id);
  await run;
  assert.equal(f.task.status, "paused");
  assert.equal(f.writes(), 1);
  assert.ok(f.checkpoint()?.serializedState);
  assert.ok(!f.checkpoint()?.serializedState.includes("synthetic-key"));
  const resumed = new ScriptedModel([
    modelResponder((call) => {
      assert.match(JSON.stringify(call.request.input), /write-before-pause/);
      return [assistantMessage("已从保存点继续，报告仍为一版。")];
    }),
  ]);
  const second = new TeamRuntime(f.hooks, { modelFactory: () => resumed });
  await second.run(f.task.id);
  assert.equal(f.task.status, "completed", f.task.error);
  assert.equal(f.writes(), 1);
  assert.ok(f.task.events.some((e) => e.type === "run_resumed"));
  assert.equal(
    f.task.messages.at(-1)?.content,
    "已从保存点继续，报告仍为一版。",
  );
});

test("direct member chats honor profile selection and explicitly downgrade missing streaming", async () => {
  const f = fixture();
  f.task.member = "cto";
  f.profiles.cto.capabilities!.streaming = false;
  const model = new ScriptedModel([[assistantMessage("产品范围已整理。")]]);
  const runtime = new TeamRuntime(f.hooks, {
    modelFactory: (profile, _key, member) => {
      assert.equal(member, "cto");
      assert.equal(profile.id, "cto");
      return model;
    },
  });
  await runtime.run(f.task.id);
  assert.equal(f.task.status, "completed", f.task.error);
  assert.equal(model.firstCall?.streamed, false);
  assert.ok(f.task.events.some((e) => e.type === "capability_downgrade"));
  assert.equal(f.task.messages.at(-1)?.member, "cto");
});

test("a paused nested member resumes inside the original SDK delegation", async () => {
  const f = fixture();
  const childWaiting = deferred<void>();
  const parent = new ScriptedModel([
    [
      functionCall(
        "consult_researcher",
        { input: "保存资料核查报告后返回依据" },
        { callId: "nested-consult" },
      ),
    ],
  ]);
  const child = new ScriptedModel([
    [
      functionCall(
        "report_progress",
        {
          stage: "plan",
          summary: "正在核对资料并保存一份报告。",
          sourceIds: ["source-1"],
          artifactIds: [],
        },
        { callId: "nested-report" },
      ),
    ],
    [functionCall("write_artifact", draft, { callId: "nested-write" })],
    modelStreamResponder(async () => {
      childWaiting.resolve();
      return (async function* () {
        await new Promise(() => undefined);
      })();
    }),
  ]);
  const first = new TeamRuntime(f.hooks, {
    modelFactory: (_profile, _key, member) =>
      member === "researcher" ? child : parent,
  });
  const done = first.run(f.task.id);
  await childWaiting.promise;
  await first.stop(f.task.id);
  await done;
  assert.equal(f.writes(), 1);
  assert.equal(f.task.status, "paused");
  const pausedLanes = buildAgentProgress(f.task);
  assert.equal(pausedLanes.length, 2);
  assert.ok(pausedLanes.every((lane) => lane.status === "paused"));
  assert.ok(f.task.events.some((event) => event.type === "delegation_paused"));
  assert.equal(
    f.task.events.filter((event) => event.type === "progress_reported").length,
    1,
  );
  const childAfter = new ScriptedModel([
    modelResponder((call) => {
      assert.match(JSON.stringify(call.request.input), /nested-write/);
      return [assistantMessage("已保存 ORCHID 42 核查报告。")];
    }),
  ]);
  const parentAfter = new ScriptedModel([
    modelResponder((call) => {
      assert.match(
        JSON.stringify(call.request.input),
        /已保存 ORCHID 42 核查报告/,
      );
      return [assistantMessage("团队已完成核查。")];
    }),
  ]);
  await new TeamRuntime(f.hooks, {
    modelFactory: (_profile, _key, member) =>
      member === "researcher" ? childAfter : parentAfter,
  }).run(f.task.id);
  assert.equal(f.task.status, "completed", f.task.error);
  assert.equal(f.writes(), 1);
  const resumedLanes = buildAgentProgress(f.task);
  assert.equal(resumedLanes.length, 2);
  assert.ok(resumedLanes.every((lane) => lane.status === "completed"));
  assert.equal(
    f.task.events.filter((event) => event.type === "progress_reported").length,
    1,
  );
  assert.equal(
    f.task.events.filter((event) => event.type === "agent_started").length,
    2,
  );
  assert.ok(f.task.events.some((event) => event.type === "agent_resumed"));
  childAfter.assertComplete();
  parentAfter.assertComplete();
});

test("a profile without tools fails explicitly without producing simulated agent output", async () => {
  const f = fixture();
  f.profiles.coordinator.capabilities!.tools = false;
  const runtime = new TeamRuntime(f.hooks, {
    modelFactory: () => {
      throw new Error("must not call model");
    },
  });
  await runtime.run(f.task.id);
  assert.equal(f.task.status, "failed");
  assert.match(f.task.error!, /工具回读/);
  assert.equal(f.task.messages.length, 0);
  assert.equal(f.writes(), 0);
});

test("clarification pauses for a real user answer and bounded input omits old goals", async () => {
  const f = fixture();
  f.task.messages.push({
    id: "old",
    role: "user",
    member: "coordinator",
    content: "DO_NOT_INCLUDE_OLD_GOAL",
    goalVersion: 0,
    createdAt: "",
  });
  const model = new ScriptedModel([
    modelResponder((call) => {
      assert.doesNotMatch(
        JSON.stringify(call.request.input),
        /DO_NOT_INCLUDE_OLD_GOAL/,
      );
      return [
        functionCall(
          "request_clarification",
          { question: "这份报告面向谁？" },
          { callId: "ask-1" },
        ),
      ];
    }),
  ]);
  await new TeamRuntime(f.hooks, { modelFactory: () => model }).run(f.task.id);
  assert.equal(f.task.status, "waiting", f.task.error);
  assert.equal(f.task.messages.at(-1)?.content, "这份报告面向谁？");
});

test("public progress rejects nonexistent references and can recover with an honest summary", async () => {
  const f = fixture();
  const model = new ScriptedModel([
    [
      functionCall(
        "report_progress",
        {
          stage: "finding",
          summary: "不能发布的虚构来源",
          sourceIds: ["invented"],
          artifactIds: [],
        },
        { callId: "bad-report" },
      ),
    ],
    modelResponder((call) => {
      assert.match(JSON.stringify(call.request.input), /不存在/);
      return [
        functionCall(
          "report_progress",
          {
            stage: "decision",
            summary: "当前没有这条依据，先标为待核查。",
            sourceIds: [],
            artifactIds: [],
          },
          { callId: "honest-report" },
        ),
      ];
    }),
    [assistantMessage("待核查项已标明。")],
  ]);
  await new TeamRuntime(f.hooks, { modelFactory: () => model }).run(f.task.id);
  assert.equal(f.task.status, "completed", f.task.error);
  assert.equal(
    f.task.events.filter((event) => event.type === "progress_reported").length,
    1,
  );
  assert.ok(
    f.task.events.some(
      (event) =>
        event.type === "tool_failed" && event.data?.callId === "bad-report",
    ),
  );
  assert.doesNotMatch(JSON.stringify(f.task.events), /不能发布的虚构来源/);
});

test("a nested provider failure closes both member activity and delegation with the same identities", async () => {
  const f = fixture();
  const parent = new ScriptedModel([
    [
      functionCall(
        "consult_researcher",
        { input: "核查资料" },
        { callId: "failed-consult" },
      ),
    ],
  ]);
  const child = new ScriptedModel([
    modelError(new Error("synthetic connection failure")),
  ]);
  await new TeamRuntime(f.hooks, {
    modelFactory: (_profile, _key, member) =>
      member === "researcher" ? child : parent,
  }).run(f.task.id);
  assert.equal(f.task.status, "failed");
  const lanes = buildAgentProgress(f.task);
  assert.equal(lanes.length, 2);
  assert.ok(lanes.every((lane) => lane.status === "failed"));
  const delegation = f.task.events.find(
    (event) => event.type === "delegation_failed",
  )!;
  const childFailure = f.task.events.find(
    (event) => event.type === "agent_failed" && event.member === "researcher",
  )!;
  assert.ok(delegation, JSON.stringify(f.task.events, null, 2));
  assert.ok(childFailure, JSON.stringify(f.task.events, null, 2));
  assert.equal(
    childFailure.data?.invocationId,
    delegation.data?.childInvocationId,
  );
});

test("raw model reasoning events and provider metadata never enter public task events", async () => {
  const f = fixture();
  const secretReasoning = "PRIVATE_REASONING_SENTINEL_do_not_render";
  const model = new ScriptedModel([
    modelStreamResponder(() => [
      { type: "response_started" },
      {
        type: "model",
        event: { type: "reasoning-delta", delta: secretReasoning },
      },
      {
        type: "model",
        event: {
          type: "response.reasoning_text.delta",
          delta: secretReasoning,
        },
      },
      {
        type: "output_text_delta",
        delta: "这是公开回复。",
        providerData: { privateReasoning: secretReasoning },
      },
      {
        type: "response_done",
        response: {
          id: "public-response",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          output: [assistantMessage("这是公开回复。")],
          providerData: { privateReasoning: secretReasoning },
        },
      },
    ]),
  ]);
  await new TeamRuntime(f.hooks, { modelFactory: () => model }).run(f.task.id);
  assert.equal(f.task.status, "completed", f.task.error);
  assert.doesNotMatch(
    JSON.stringify(f.task.events),
    new RegExp(secretReasoning),
  );
  assert.equal(f.task.messages.at(-1)?.content, "这是公开回复。");
  assert.ok(f.task.events.some((event) => event.type === "member_output"));
  assert.ok(
    !f.task.events.some((event) => event.type === "progress_reported"),
    "a simple reply must not manufacture progress",
  );
});

test("selected refinement stays in structured model context and revises the selected artifact", async () => {
  const f = fixture();
  const artifact = await f.hooks.writeArtifact(f.task.id, {
    ...draft,
    format: "md",
    artifactId: undefined,
    expectedHash: undefined,
    goalVersion: 1,
    operationId: "seed-refinement",
  });
  f.task.goalVersion = 2;
  f.task.messages.push({
    id: "refine-user",
    role: "user",
    member: "coordinator",
    content: "继续处理《合成报告》：精简为一句话",
    createdAt: "",
    goalVersion: 2,
  });
  f.task.events.push({
    id: "refine-target",
    type: "artifact.refine_requested",
    summary: "继续处理《合成报告》",
    member: "coordinator",
    createdAt: "",
    goalVersion: 2,
    data: {
      artifactId: artifact.id,
      expectedHash: artifact.hash,
      instruction: "精简为一句话",
    },
  });
  f.task.events.push({
    id: "old-refine",
    type: "artifact.refine_requested",
    summary: "旧目标",
    member: "coordinator",
    createdAt: "",
    goalVersion: 1,
    data: {
      artifactId: "OLD_REFINEMENT_SENTINEL",
      expectedHash: "0".repeat(64),
      instruction: "旧要求不能再进入上下文",
    },
  });
  const model = new ScriptedModel([
    modelResponder((call) => {
      const raw = JSON.stringify(call.request.input);
      assert.match(raw, /selectedRefinement/);
      assert.match(raw, new RegExp(artifact.id));
      assert.match(raw, new RegExp(artifact.hash));
      assert.match(raw, /不要另建同名文档/);
      assert.doesNotMatch(raw, /OLD_REFINEMENT_SENTINEL/);
      return [
        functionCall(
          "read_artifact",
          { artifactId: artifact.id, start: null, maxCharacters: null },
          { callId: "read-selected" },
        ),
      ];
    }),
    [
      functionCall(
        "write_artifact",
        {
          title: artifact.title,
          content: "ORCHID 42。",
          format: "md",
          artifactId: artifact.id,
          expectedHash: artifact.hash,
        },
        { callId: "revise-selected" },
      ),
    ],
    [assistantMessage("已精简这份报告。")],
  ]);
  await new TeamRuntime(f.hooks, { modelFactory: () => model }).run(f.task.id);
  assert.equal(f.task.status, "completed", f.task.error);
  assert.equal(f.task.artifacts.length, 1);
  assert.equal(f.task.artifacts[0].id, artifact.id);
  assert.equal(f.task.artifacts[0].version, 2);
  assert.equal(
    f.task.messages.find((message) => message.id === "refine-user")?.content,
    "继续处理《合成报告》：精简为一句话",
  );
  assert.ok(
    !f.task.messages.some((message) =>
      /selectedRefinement|expectedHash|read_artifact/.test(message.content),
    ),
  );
});

test("custom member prompt and response style reach actual model requests; independent mode removes delegation tools", async () => {
  const f = fixture();
  f.task.member = "cto";
  f.hooks.getMemberSettings = (member) => ({
    prompt:
      member === "cto"
        ? "CUSTOM_CTO_PROMPT: 用产品成本来评价所有建议。"
        : "OTHER_MEMBER_PROMPT",
    responseStyle: "detailed",
    delegation: "off",
  });
  const model = new ScriptedModel([
    modelResponder((call) => {
      assert.match(call.request.systemInstructions!, /CUSTOM_CTO_PROMPT/);
      assert.match(call.request.systemInstructions!, /充分说明依据/);
      assert.doesNotMatch(
        call.request.systemInstructions!,
        /OTHER_MEMBER_PROMPT/,
      );
      const names = call.request.tools.map((entry) => entry.name);
      assert.ok(names.includes("read_artifact"));
      assert.ok(
        !names.some(
          (name) => name.startsWith("consult_") || name === "specialist",
        ),
      );
      return [assistantMessage("已按成本维度整理。")];
    }),
  ]);
  await new TeamRuntime(f.hooks, { modelFactory: () => model }).run(f.task.id);
  assert.equal(f.task.status, "completed", f.task.error);
  assert.ok(
    !f.task.events.some((event) => event.type === "delegation_started"),
  );
});

test("a changed member setting invalidates the old SDK checkpoint before resuming work", async () => {
  const f = fixture();
  const blocked = deferred<void>();
  let prompt = "OLD_MEMBER_PROMPT";
  f.hooks.getMemberSettings = () => ({
    prompt,
    responseStyle: "concise",
    delegation: "auto",
  });
  const firstModel = new ScriptedModel([
    [functionCall("write_artifact", draft, { callId: "settings-write" })],
    modelStreamResponder(() => {
      blocked.resolve();
      return (async function* () {
        await new Promise(() => undefined);
      })();
    }),
  ]);
  const first = new TeamRuntime(f.hooks, { modelFactory: () => firstModel });
  const running = first.run(f.task.id);
  await blocked.promise;
  await first.stop(f.task.id);
  await running;
  assert.ok(f.checkpoint());
  prompt = "NEW_MEMBER_PROMPT";
  const nextModel = new ScriptedModel([
    modelResponder((call) => {
      assert.match(call.request.systemInstructions!, /NEW_MEMBER_PROMPT/);
      assert.doesNotMatch(
        call.request.systemInstructions!,
        /OLD_MEMBER_PROMPT/,
      );
      assert.doesNotMatch(JSON.stringify(call.request.input), /settings-write/);
      return [assistantMessage("已使用更新后的成员设置继续。")];
    }),
  ]);
  await new TeamRuntime(f.hooks, { modelFactory: () => nextModel }).run(
    f.task.id,
  );
  assert.equal(f.task.status, "completed", f.task.error);
  assert.equal(f.writes(), 1);
  assert.ok(
    f.task.events.some((event) => event.type === "checkpoint_invalidated"),
  );
  assert.ok(!f.task.events.some((event) => event.type === "run_resumed"));
});

function hostedProfile(f: ReturnType<typeof fixture>, member: MemberId) {
  Object.assign(f.profiles[member], {
    provider: "gemini",
    protocol: "google",
    execution: "google-agent",
    baseURL: "https://generativelanguage.googleapis.com/v1beta",
    modelId: "synthetic-research-agent",
    capabilities: { text: true, tools: false, streaming: false },
  });
}
test("hosted execution uses actual adapter callbacks, receives material text, saves a full report and keeps main reply short", async () => {
  const f = fixture();
  hostedProfile(f, "coordinator");
  const report =
    "# 合成报告\n\n" +
    "这是公开成果，需要保存在右侧供用户继续编辑。".repeat(180);
  let posts = 0;
  const runtime = new TeamRuntime(f.hooks, {
    requestTimeoutMs: 1,
    googleAgentFactory: (profile, key, options) =>
      createGoogleAgentModel(profile, key, {
        ...options,
        pollMs: 0,
        fetch: (async (_url, init) => {
          posts++;
          const body = JSON.parse(String(init?.body));
          assert.ok(!("tools" in body));
          assert.match(body.input, /synthetic evidence: ORCHID 42/);
          await new Promise((resolve) => setTimeout(resolve, 8));
          return new Response(
            JSON.stringify({
              id: "interaction-first",
              status: "completed",
              outputs: [{ type: "text", text: report }],
            }),
            { status: 200 },
          );
        }) as typeof fetch,
      }),
  });
  await runtime.run(f.task.id);
  assert.equal(f.task.status, "completed", f.task.error);
  assert.equal(posts, 1);
  assert.equal(f.task.artifacts[0].content, report);
  assert.ok(f.task.messages.at(-1)!.content.length < 700);
  assert.match(f.task.messages.at(-1)!.content, /已保存/);
  assert.ok(!f.task.events.some((event) => event.type === "tool_started"));
  assert.ok(
    f.task.events.some(
      (event) => event.type === "artifact_written" && event.data?.hosted,
    ),
  );
});

test("parallel hosted consultations preserve separate invocation identity and full results for the parent", async () => {
  const f = fixture();
  hostedProfile(f, "researcher");
  const parent = new ScriptedModel([
    [
      functionCall(
        "consult_researcher",
        { input: "核查第一项" },
        { callId: "hosted-child-a" },
      ),
      functionCall(
        "consult_researcher",
        { input: "核查第二项" },
        { callId: "hosted-child-b" },
      ),
    ],
    modelResponder((call) => {
      assert.match(JSON.stringify(call.request.input), /HOSTED_RESULT_1/);
      assert.match(JSON.stringify(call.request.input), /HOSTED_RESULT_2/);
      return [assistantMessage("已综合两项结果。")];
    }),
  ]);
  let factories = 0;
  await new TeamRuntime(f.hooks, {
    modelFactory: () => parent,
    googleAgentFactory: (_profile, _key, options) => {
      const index = ++factories;
      return new ScriptedModel([
        modelResponder(async (call) => {
          assert.deepEqual(call.request.tools, []);
          options.onProgress?.(`正在处理合成子任务 ${index}`);
          await new Promise((resolve) =>
            setTimeout(resolve, index === 1 ? 12 : 2),
          );
          await options.onReport?.(
            `HOSTED_RESULT_${index}`,
            `interaction-${index}`,
          );
          return [assistantMessage(`HOSTED_RESULT_${index}`)];
        }),
      ]);
    },
  }).run(f.task.id);
  assert.equal(f.task.status, "completed", f.task.error);
  assert.equal(factories, 2);
  assert.equal(f.task.artifacts.length, 2);
  const delegations = f.task.events.filter(
    (event) => event.type === "delegation_started",
  );
  const reports = f.task.events.filter(
    (event) => event.type === "artifact_written",
  );
  assert.equal(
    new Set(reports.map((event) => event.data?.invocationId)).size,
    2,
  );
  for (const event of reports)
    assert.ok(
      delegations.some(
        (delegation) =>
          delegation.data?.childInvocationId === event.data?.invocationId,
      ),
    );
});

test("hosted interaction identity survives pause and resumes without creating another remote interaction", async () => {
  const f = fixture();
  hostedProfile(f, "coordinator");
  const started = deferred<void>();
  const first = new TeamRuntime(f.hooks, {
    googleAgentFactory: (_profile, _key, options) =>
      new ScriptedModel([
        modelStreamResponder((call) => {
          options.saveInteraction?.(
            "persisted-interaction",
            "input-fingerprint",
          );
          options.onProgress?.("正在核查公开资料");
          started.resolve();
          return (async function* () {
            await new Promise((_resolve, reject) =>
              call.request.signal?.addEventListener(
                "abort",
                () => reject(call.request.signal!.reason),
                { once: true },
              ),
            );
          })();
        }),
      ]),
  });
  const running = first.run(f.task.id);
  await started.promise;
  await first.stop(f.task.id);
  await running;
  assert.equal(f.task.status, "paused");
  assert.ok(
    Object.values(f.checkpoint()?.hostedInteractions ?? {}).some(
      (entry) => entry.id === "persisted-interaction",
    ),
  );
  const resumed = new TeamRuntime(f.hooks, {
    googleAgentFactory: (_profile, _key, options) => {
      assert.equal(
        options.loadInteraction?.("input-fingerprint"),
        "persisted-interaction",
      );
      assert.equal(options.loadInteraction?.("another-input"), undefined);
      return new ScriptedModel([
        modelResponder(async () => {
          options.onProgress?.("正在核查公开资料");
          await options.onReport?.(
            "恢复后的公开成果。",
            "persisted-interaction",
          );
          return [assistantMessage("恢复后的公开成果。")];
        }),
      ]);
    },
  });
  await resumed.run(f.task.id);
  assert.equal(f.task.status, "completed", f.task.error);
  assert.equal(f.writes(), 1);
  assert.equal(
    f.task.events.filter(
      (event) =>
        event.type === "progress_reported" &&
        event.summary === "正在核查公开资料",
    ).length,
    1,
  );
  assert.match(
    buildAgentProgress(f.task)[0].latestSummary,
    /已保存，可继续查看和编辑/,
  );
  assert.ok(f.task.events.some((event) => event.type === "run_resumed"));
});

test("a hosted report committed before pause is reused without repeating its write or public event", async () => {
  const f = fixture();
  hostedProfile(f, "coordinator");
  const reportSaved = deferred<void>();
  const first = new TeamRuntime(f.hooks, {
    googleAgentFactory: (_profile, _key, options) =>
      new ScriptedModel([
        modelStreamResponder(async (call) => {
          options.saveInteraction?.("completed-remote", "original-input");
          await options.onReport?.("已经持久保存的成果。", "completed-remote");
          reportSaved.resolve();
          return (async function* () {
            await new Promise((_resolve, reject) =>
              call.request.signal?.addEventListener(
                "abort",
                () => reject(call.request.signal!.reason),
                { once: true },
              ),
            );
          })();
        }),
      ]),
  });
  const run = first.run(f.task.id);
  await reportSaved.promise;
  await first.stop(f.task.id);
  await run;
  assert.equal(f.writes(), 1);
  assert.ok(
    Object.values(f.checkpoint()?.hostedInteractions ?? {}).some(
      (entry) => entry.completedArtifact?.id === f.task.artifacts[0].id,
    ),
  );
  await new TeamRuntime(f.hooks, {
    googleAgentFactory: (_profile, _key, options) => {
      assert.equal(
        options.loadInteraction?.("input-now-includes-our-own-artifact"),
        "completed-remote",
      );
      return new ScriptedModel([
        modelResponder(async () => {
          await options.onReport?.("已经持久保存的成果。", "completed-remote");
          return [assistantMessage("已经持久保存的成果。")];
        }),
      ]);
    },
  }).run(f.task.id);
  assert.equal(f.task.status, "completed", f.task.error);
  assert.equal(f.writes(), 1);
  assert.equal(
    f.task.events.filter((event) => event.type === "artifact_written").length,
    1,
  );
  assert.equal(
    f.task.events.filter(
      (event) =>
        event.type === "progress_reported" && event.data?.stage === "finding",
    ).length,
    1,
  );
  assert.match(
    buildAgentProgress(f.task)[0].latestSummary,
    /已保存，可继续查看和编辑/,
  );
});

test("hosted refinement rejects a changed selected version before remote submission", async () => {
  const f = fixture();
  hostedProfile(f, "coordinator");
  const original = await f.hooks.writeArtifact(f.task.id, {
    title: "原始资料",
    content: "原始版本",
    format: "md",
    goalVersion: 1,
    operationId: "seed-hosted-original",
  });
  f.task.events.push({
    id: "hosted-refine",
    type: "artifact.refine_requested",
    summary: "继续修改",
    goalVersion: 1,
    createdAt: "",
    data: {
      artifactId: original.id,
      expectedHash: original.hash,
      instruction: "精简内容",
    },
  });
  await f.hooks.writeArtifact(f.task.id, {
    title: "原始资料",
    content: "用户稍后手改的版本",
    format: "md",
    goalVersion: 1,
    operationId: "manual-new-version",
    artifactId: original.id,
    expectedHash: original.hash,
  });
  let remoteCreated = false;
  await new TeamRuntime(f.hooks, {
    googleAgentFactory: () => {
      remoteCreated = true;
      return new ScriptedModel([[assistantMessage("must not run")]]);
    },
  }).run(f.task.id);
  assert.equal(f.task.status, "failed");
  assert.match(f.task.error!, /选定成果已被修改/);
  assert.equal(remoteCreated, false);
  assert.equal(f.task.artifacts[0].content, "用户稍后手改的版本");
});

test("remote cancellation uncertainty remains visible after local pause", async () => {
  const f = fixture();
  hostedProfile(f, "coordinator");
  const started = deferred<void>();
  const runtime = new TeamRuntime(f.hooks, {
    googleAgentFactory: (_profile, _key, options) =>
      new ScriptedModel([
        modelStreamResponder((call) => {
          const blocked = new Promise((_resolve, reject) =>
            call.request.signal?.addEventListener(
              "abort",
              () => {
                options.onCancel?.(false);
                reject(call.request.signal!.reason);
              },
              { once: true },
            ),
          );
          void blocked.catch(() => undefined);
          started.resolve();
          return (async function* () {
            await blocked;
          })();
        }),
      ]),
  });
  const run = runtime.run(f.task.id);
  await started.promise;
  await runtime.stop(f.task.id);
  await run;
  assert.equal(f.task.status, "paused");
  assert.ok(
    f.task.events.some(
      (event) =>
        event.type === "progress_reported" &&
        event.data?.cancelConfirmed === false &&
        /远端取消尚未确认/.test(event.summary),
    ),
  );
});

test("pausing during a local hosted commit waits for storage and retains its remote identity", async () => {
  const f = fixture();
  hostedProfile(f, "coordinator");
  const writing = deferred<void>();
  const finishWrite = deferred<void>();
  const write = f.hooks.writeArtifact;
  f.hooks.writeArtifact = async (id, input) => {
    writing.resolve();
    await finishWrite.promise;
    return write(id, input);
  };
  const runtime = new TeamRuntime(f.hooks, {
    googleAgentFactory: (_profile, _key, options) =>
      new ScriptedModel([
        modelResponder(async () => {
          options.saveInteraction?.("committing-remote", "committing-input");
          await options.onReport?.("安全保存的完整成果。", "committing-remote");
          return [assistantMessage("安全保存的完整成果。")];
        }),
      ]),
  });
  const run = runtime.run(f.task.id);
  await writing.promise;
  let stopped = false;
  const stopping = runtime.stop(f.task.id).then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(
    stopped,
    false,
    "storage must not close before its atomic write finishes",
  );
  finishWrite.resolve();
  await stopping;
  await run;
  assert.equal(f.task.status, "paused");
  assert.equal(f.writes(), 1);
  assert.ok(
    Object.values(f.checkpoint()?.hostedInteractions ?? {}).some(
      (entry) =>
        entry.id === "committing-remote" &&
        entry.completedArtifact?.id === f.task.artifacts[0].id,
    ),
  );
  assert.equal(
    f.task.events.filter((event) => event.type === "artifact_written").length,
    1,
  );
});

test(
  "a hosted creation arriving after pause persists its ID despite failed cancellation and resumes with GET only",
  { timeout: 2000 },
  async () => {
    const f = fixture();
    hostedProfile(f, "coordinator");
    const creating = deferred<void>();
    const created = deferred<void>();
    const cancellationReported = deferred<void>();
    const requests: string[] = [];
    const fetchResponse: typeof fetch = async (url, init) => {
      const pathname = new URL(String(url)).pathname;
      requests.push(`${init?.method} ${pathname}`);
      if (pathname.endsWith("/cancel"))
        return new Response("", { status: 503 });
      if (init?.method === "POST") {
        creating.resolve();
        // Simulate a server response already in flight when the local abort occurs.
        await created.promise;
        return Response.json({
          id: "late-created-remote",
          status: "in_progress",
        });
      }
      assert.equal(pathname, "/v1beta/interactions/late-created-remote");
      return Response.json({
        id: "late-created-remote",
        status: "completed",
        outputs: [{ type: "text", text: "恢复后读取到原远端任务的成果。" }],
      });
    };
    const runtime = new TeamRuntime(f.hooks, {
      googleAgentFactory: (profile, key, options) =>
        createGoogleAgentModel(profile, key, {
          ...options,
          fetch: fetchResponse,
          pollMs: 0,
          onCancel: (confirmed) => {
            options.onCancel?.(confirmed);
            cancellationReported.resolve();
          },
        }),
    });
    const run = runtime.run(f.task.id);
    await creating.promise;
    const stopping = runtime.stop(f.task.id);
    const pausedState = f.checkpoint()!.serializedState;
    created.resolve();
    await Promise.all([run, stopping, cancellationReported.promise]);
    assert.equal(f.task.status, "paused");
    assert.equal(f.checkpoint()!.serializedState, pausedState);
    assert.equal(
      Object.values(f.checkpoint()?.hostedInteractions ?? {})[0]?.id,
      "late-created-remote",
    );
    assert.ok(
      f.task.events.some((event) => event.data?.cancelConfirmed === false),
    );
    await new TeamRuntime(f.hooks, {
      googleAgentFactory: (profile, key, options) =>
        createGoogleAgentModel(profile, key, {
          ...options,
          fetch: fetchResponse,
          pollMs: 0,
        }),
    }).run(f.task.id);
    assert.equal(f.task.status, "completed", f.task.error);
    assert.equal(f.writes(), 1);
    assert.deepEqual(requests, [
      "POST /v1beta/interactions",
      "POST /v1beta/interactions/late-created-remote/cancel",
      "GET /v1beta/interactions/late-created-remote",
    ]);
  },
);

test(
  "a late hosted creation for an obsolete goal is cancelled without changing its replacement checkpoint",
  { timeout: 2000 },
  async () => {
    const f = fixture();
    hostedProfile(f, "coordinator");
    const creating = deferred<void>();
    const created = deferred<void>();
    const cancellationReported = deferred<void>();
    const requests: string[] = [];
    const runtime = new TeamRuntime(f.hooks, {
      googleAgentFactory: (profile, key, options) =>
        createGoogleAgentModel(profile, key, {
          ...options,
          fetch: async (url, init) => {
            const pathname = new URL(String(url)).pathname;
            requests.push(`${init?.method} ${pathname}`);
            if (pathname.endsWith("/cancel"))
              return new Response("", { status: 503 });
            creating.resolve();
            await created.promise;
            return Response.json({
              id: "obsolete-remote",
              status: "in_progress",
            });
          },
          onCancel: (confirmed) => {
            options.onCancel?.(confirmed);
            cancellationReported.resolve();
          },
        }),
    });
    const run = runtime.run(f.task.id);
    await creating.promise;
    const stopping = runtime.stop(f.task.id);
    f.task.goalVersion = 2;
    const replacement: RuntimeCheckpoint = {
      ...f.checkpoint()!,
      goalVersion: 2,
      runId: "replacement-run",
      hostedInteractions: {
        replacement: { id: "current-remote", inputHash: "current-input" },
      },
    };
    f.hooks.saveCheckpoint(f.task.id, replacement);
    const eventCount = f.task.events.length;
    created.resolve();
    await Promise.all([run, stopping, cancellationReported.promise]);
    assert.deepEqual(f.checkpoint(), replacement);
    assert.equal(f.task.events.length, eventCount);
    assert.equal(f.writes(), 0);
    assert.deepEqual(requests, [
      "POST /v1beta/interactions",
      "POST /v1beta/interactions/obsolete-remote/cancel",
    ]);
  },
);

test("real hosted adapter callback persists public summaries and verified source metadata in task events", async () => {
  const f = fixture();
  hostedProfile(f, "coordinator");
  await new TeamRuntime(f.hooks, {
    googleAgentFactory: (profile, key, options) =>
      createGoogleAgentModel(profile, key, {
        ...options,
        fetch: async () =>
          new Response(
            JSON.stringify({
              id: "public-details",
              status: "completed",
              steps: [
                {
                  type: "thought",
                  summary: [
                    { type: "text", text: "先比较证据覆盖，再确认局限。" },
                  ],
                  text: "PRIVATE_THOUGHT",
                  signature: "PRIVATE_SIGNATURE",
                },
                {
                  type: "url_context_result",
                  result: [
                    {
                      url: "https://example.com/evidence",
                      title: "Evidence",
                      status: "success",
                      snippet: "Public excerpt",
                    },
                  ],
                },
                {
                  type: "model_output",
                  content: [
                    {
                      type: "text",
                      text: "# Public report\nA sourced conclusion.",
                    },
                  ],
                },
              ],
            }),
          ),
      }),
  }).run(f.task.id);
  assert.equal(f.task.status, "completed", f.task.error);
  const summary = f.task.events.find(
    (event) => event.data?.progressKind === "analysis",
  )!;
  assert.equal(summary.data?.detail, "先比较证据覆盖，再确认局限。");
  assert.equal(summary.data?.hosted, true);
  const sources = f.task.events.find((event) =>
    Array.isArray(event.data?.webSources),
  )!;
  assert.equal(
    (sources.data?.webSources as { status: string }[])[0].status,
    "read",
  );
  assert.doesNotMatch(
    JSON.stringify(f.task.events),
    /PRIVATE_THOUGHT|PRIVATE_SIGNATURE/,
  );
  const { buildProcessDocument } =
    await import("../src/core/process-document.js");
  const document = buildProcessDocument(f.task).content;
  assert.match(document, /研究进展说明/);
  assert.match(document, /example.com\/evidence/);
  assert.match(document, /已读取/);
});
