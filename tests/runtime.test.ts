import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponder,
  modelStreamResponder,
} from "@openai/agents/testing";
import type {
  Artifact,
  MemberId,
  ModelProfile,
  Task,
} from "../src/shared/types.js";
import {
  TeamRuntime,
  type RuntimeCheckpoint,
  type RuntimeHooks,
} from "../src/core/runtime.js";

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
