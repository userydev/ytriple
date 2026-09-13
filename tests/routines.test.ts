import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/core/store.js";
import {
  RoutineEngine,
  nextRoutineTime,
  routineSnapshot,
} from "../src/core/routines.js";
import { routineCommandSchema } from "../src/shared/routines.js";
import { BUILTIN_SKILLS } from "../src/core/skills.js";
import { writeArtifact } from "../src/core/files.js";
import { collectArtifact, saveLibraryEntry } from "../src/core/library.js";
import type { Task } from "../src/shared/types.js";
import type { FeatureHost } from "../src/core/feature-host.js";

async function fixture(t: { after(fn: () => unknown): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ytriple-routines-"));
  const store = new Store(path.join(root, "data"));
  store.setConfig("settings", {
    ...store.settings(),
    aiRoot: path.join(root, "AI"),
    workspaceRoot: path.join(root, "work"),
    codeRoot: path.join(root, "Code"),
  });
  const task: Task = {
    id: "original",
    title: "原栏目",
    goal: "依据提供的材料整理栏目说明。",
    goalVersion: 1,
    kind: "research",
    member: "coordinator",
    projectId: "project-1",
    workspace: path.join(root, "work", "original"),
    status: "completed",
    createdAt: "",
    updatedAt: "",
    sources: [
      {
        id: "source-1",
        title: "现有资料",
        text: "ORCHID 42",
        type: "text",
        location: "",
        coverage: "全文",
        addedAt: "",
      },
    ],
    artifacts: [],
    messages: [
      {
        id: "original-message",
        role: "assistant",
        member: "coordinator",
        content: "已经读完资料，得到说明。",
        createdAt: "",
        goalVersion: 1,
      },
    ],
    events: [
      {
        id: "loaded",
        type: "skill_loaded",
        goalVersion: 1,
        createdAt: "",
        summary: "已加载",
        data: { skillId: BUILTIN_SKILLS[0]!.id, hash: BUILTIN_SKILLS[0]!.hash },
      },
    ],
    skillPolicy: { mode: "auto", skillIds: [] },
    skillPins: structuredClone(BUILTIN_SKILLS),
    skillBindings: structuredClone(BUILTIN_SKILLS),
  };
  store.saveTask(task);
  let calls = 0,
    creations = 0;
  const running = new Set<string>();
  const host: FeatureHost = {
    store,
    createWork: async (input) => {
      creations++;
      const work: Task = {
        ...structuredClone(task),
        id: "routine-worker",
        title: input.title,
        goal: input.goal,
        workspace: path.join(root, "work", "worker"),
        status: "idle",
        sources: input.sources ?? [],
        messages: [],
        events: [],
        artifacts: [],
        skillPolicy: input.skillPolicy,
        skillPins: input.skillPins,
      };
      store.saveTask(work);
      return work;
    },
    addSource: async (id, source) => {
      store.updateTask(id, (task) => task.sources.push(source));
    },
    runWork: async (id) => {
      calls++;
      running.add(id);
      const work = store.task(id);
      try {
        const existing = work.artifacts[0];
        await writeArtifact(store, id, {
          title: "持续栏目说明",
          content: `# 说明\n${work.sources.map((source) => source.text).join("\n")}`,
          format: "md",
          goalVersion: work.goalVersion,
          artifactId: existing?.id,
          expectedHash: existing?.hash,
          operationId: `fake-run-${calls}`,
        });
        store.event(id, {
          type: "model_usage",
          member: work.member,
          goalVersion: work.goalVersion,
          summary: "合成用量",
          data: { totalTokens: 120 },
        });
        store.updateTask(id, (task) => {
          task.status = "completed";
          task.messages.push({
            id: randomUUID(),
            role: "assistant",
            member: task.member,
            goalVersion: task.goalVersion,
            createdAt: "",
            content: "新材料说明已保存。",
          });
        });
      } finally {
        running.delete(id);
      }
    },
    stopWork: async (id) => {
      running.delete(id);
      store.updateTask(id, (task) => {
        task.status = "paused";
      });
    },
    isRunning: (id) => running.has(id),
  };
  const engine = new RoutineEngine(host);
  t.after(async () => {
    await engine.close();
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const create = async (extra: Record<string, unknown> = {}) => {
    await engine.execute(
      routineCommandSchema.parse({
        type: "routine.create",
        requestId: randomUUID(),
        taskId: task.id,
        schedule: { kind: "change", pollMinutes: 1, timezone: "UTC" },
        ...extra,
      }),
    );
    return routineSnapshot(store).items[0]!;
  };
  return {
    root,
    store,
    task,
    host,
    engine,
    create,
    calls: () => calls,
    creations: () => creations,
    state: () => routineSnapshot(store).items[0]!,
    change: (text: string) =>
      store.updateTask(task.id, (task) => {
        task.sources[0]!.text = text;
      }),
  };
}

test("daily and weekly timezone schedules handle DST gaps, repeated hours and missed periods deterministically", () => {
  const daily = {
    kind: "time" as const,
    cadence: "daily" as const,
    timezone: "America/Los_Angeles",
    time: "02:30",
  };
  assert.equal(
    nextRoutineTime(daily, new Date("2026-03-08T08:00:00Z")),
    "2026-03-08T10:00:00.000Z",
  );
  assert.equal(
    nextRoutineTime(
      { ...daily, time: "01:30" },
      new Date("2026-11-01T08:31:00Z"),
    ),
    "2026-11-02T09:30:00.000Z",
  );
  assert.equal(
    nextRoutineTime(
      {
        ...daily,
        cadence: "weekly",
        weekday: 1,
        time: "09:00",
        timezone: "Asia/Shanghai",
      },
      new Date("2026-09-13T16:00:00Z"),
    ),
    "2026-09-14T01:00:00.000Z",
  );
  assert.equal(
    nextRoutineTime(
      { kind: "time", cadence: "interval", timezone: "UTC", everyMinutes: 60 },
      new Date("2026-09-13T16:01:30Z"),
    ),
    "2026-09-13T17:01:30.000Z",
  );
  assert.throws(() =>
    routineCommandSchema.parse({
      type: "routine.create",
      requestId: "r",
      taskId: "x",
      schedule: { kind: "change", pollMinutes: 1, timezone: "made-up" },
    }),
  );
  assert.throws(() =>
    routineCommandSchema.parse({
      type: "routine.create",
      requestId: "server-placeholder",
      taskId: "x",
      location: "server",
      schedule: { kind: "change", pollMinutes: 1, timezone: "UTC" },
    }),
  );
});

test("proven work skips unchanged checks, locks only actually loaded methods, reuses one hidden worker and writes stable original artifacts", async (t) => {
  const f = await fixture(t);
  const original = await writeArtifact(f.store, f.task.id, {
    title: "用户原有成果",
    content: "用户原稿不可覆盖",
    format: "md",
    goalVersion: 1,
  });
  const routine = await f.create();
  assert.deepEqual(
    routine.skills.map((skill) => skill.id),
    ["material-digest"],
  );
  await f.engine.execute({
    type: "routine.run",
    requestId: "unchanged",
    routineId: routine.id,
  });
  assert.equal(f.calls(), 0);
  assert.equal(f.state().runs[0]?.state, "unchanged");
  f.change("ORCHID 43");
  await f.engine.tick(new Date(Date.now() + 20 * 86400000));
  assert.equal(f.calls(), 1);
  assert.equal(f.creations(), 1);
  const result = f.store
    .task(f.task.id)
    .artifacts.find((artifact) => artifact.id !== original.id)!;
  assert.equal(
    f.store
      .task(f.task.id)
      .artifacts.find((artifact) => artifact.id === original.id)?.hash,
    original.hash,
  );
  assert.equal(f.store.task("routine-worker").surface, "background");
  assert.deepEqual(f.store.task("routine-worker").skillPolicy, {
    mode: "explicit",
    skillIds: ["material-digest"],
  });
  assert.equal(
    f.store.task("routine-worker").skillPins?.[0]?.hash,
    routine.skills[0]?.hash,
  );
  assert.equal(f.state().tokens, 120);
  assert.equal(f.state().runCount, 1);
  await f.engine.execute({
    type: "routine.run",
    requestId: "outputs-dont-trigger",
    routineId: routine.id,
  });
  assert.equal(f.calls(), 1);
  f.change("ORCHID 44");
  await f.engine.execute({
    type: "routine.run",
    requestId: "changed-again",
    routineId: routine.id,
  });
  assert.equal(f.creations(), 1);
  assert.equal(f.calls(), 2);
  const updated = f.store
    .task(f.task.id)
    .artifacts.find((artifact) => artifact.id === result.id)!;
  assert.equal(updated.version, 2);
  assert.equal(
    f.store
      .task(f.task.id)
      .events.filter((event) => event.type === "routine.result").length,
    2,
  );
});

test("request IDs are durable and concurrent ticks charge once; editing a live run is rejected", async (t) => {
  const f = await fixture(t);
  const routine = await f.create();
  f.change("ORCHID 43");
  let release!: () => void, started!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const beginning = new Promise<void>((resolve) => {
    started = resolve;
  });
  const run = f.host.runWork;
  f.host.runWork = async (id) => {
    started();
    await blocked;
    await run(id);
  };
  const tickTime = new Date(Date.now() + 100000);
  const a = f.engine.tick(tickTime),
    b = f.engine.tick(tickTime);
  await beginning;
  await assert.rejects(
    f.engine.execute({
      type: "routine.edit",
      requestId: "edit-live",
      routineId: routine.id,
      expectedVersion: 1,
      title: "changed",
    }),
    /正在执行/,
  );
  release();
  await Promise.all([a, b]);
  assert.equal(f.calls(), 1);
  const command = {
    type: "routine.run" as const,
    requestId: "once",
    routineId: routine.id,
  };
  f.change("ORCHID 44");
  await f.engine.execute(command);
  await f.engine.execute(command);
  assert.equal(f.calls(), 2);
  const reopened = new RoutineEngine(f.host);
  await reopened.execute(command);
  assert.equal(f.calls(), 2);
  await reopened.close();
});

test("actual publication, not a future planned date, controls relative timing and duplicate node records do not rerun", async (t) => {
  const f = await fixture(t);
  const routine = await f.create({
    templateId: "post-review",
    schedule: {
      kind: "after_node",
      node: "published",
      delayMinutes: 60,
      timezone: "UTC",
    },
  });
  await f.engine.tick(new Date(Date.now() + 86400000));
  assert.equal(f.calls(), 0);
  await assert.rejects(
    f.engine.execute({
      type: "routine.recordNode",
      requestId: "future",
      routineId: routine.id,
      occurredAt: new Date(Date.now() + 86400000).toISOString(),
      evidence: "计划发布日期",
      actual: true,
    }),
    /计划发布时间/,
  );
  const occurredAt = new Date(Date.now() - 2 * 3600000).toISOString();
  await f.engine.execute({
    type: "routine.recordNode",
    requestId: "actual",
    routineId: routine.id,
    occurredAt,
    evidence: "实际发布页面记录",
    actual: true,
  });
  await f.engine.tick(new Date());
  assert.equal(f.calls(), 1);
  assert.equal(f.state().nextRunAt, undefined);
  await f.engine.execute({
    type: "routine.recordNode",
    requestId: "actual-again",
    routineId: routine.id,
    occurredAt,
    evidence: "实际发布页面记录",
    actual: true,
  });
  await f.engine.tick(new Date(Date.now() + 86400000));
  assert.equal(f.calls(), 1);
});

test("pause, usage limits and failed work stop new calls while restart interrupts uncertain prior work", async (t) => {
  const f = await fixture(t);
  const routine = await f.create({ limits: { maxRuns: 1, maxTokens: 1000 } });
  await f.engine.execute({
    type: "routine.pause",
    requestId: "pause",
    routineId: routine.id,
  });
  f.change("ORCHID 43");
  await f.engine.tick(new Date(Date.now() + 100000));
  assert.equal(f.calls(), 0);
  await f.engine.execute({
    type: "routine.resume",
    requestId: "resume",
    routineId: routine.id,
  });
  await f.engine.execute({
    type: "routine.run",
    requestId: "run",
    routineId: routine.id,
  });
  assert.equal(f.state().state, "paused");
  assert.equal(f.state().tokens, 120);
  await assert.rejects(
    f.engine.execute({
      type: "routine.resume",
      requestId: "over-limit",
      routineId: routine.id,
    }),
    /达到运行上限/,
  );
  await f.engine.execute({
    type: "routine.edit",
    requestId: "raise",
    routineId: routine.id,
    expectedVersion: 1,
    limits: { maxRuns: 3, maxTokens: 1000 },
  });
  await f.engine.execute({
    type: "routine.resume",
    requestId: "resume-again",
    routineId: routine.id,
  });
  f.change("ORCHID 44");
  f.host.runWork = async () => {
    throw new Error("合成模型失败");
  };
  await f.engine.execute({
    type: "routine.run",
    requestId: "failure",
    routineId: routine.id,
  });
  assert.equal(f.state().state, "failed");
  const unknown = f.state();
  unknown.state = "running";
  unknown.runs.push({ ...unknown.runs[0]!, id: "unknown", state: "running" });
  f.store.db
    .prepare("UPDATE routines SET body=? WHERE id=?")
    .run(JSON.stringify(unknown), routine.id);
  const reopened = new RoutineEngine(f.host);
  assert.equal(f.state().state, "paused");
  assert.equal(f.state().runs.at(-1)?.state, "interrupted");
  assert.equal(f.state().usageKnown, false);
  await reopened.tick(new Date(Date.now() + 86400000));
  assert.equal(f.calls(), 1);
  await reopened.close();
});

test("selected Lib file changes are read from the registered root and cannot be replaced by directory metadata", async (t) => {
  const f = await fixture(t);
  const artifact = await writeArtifact(f.store, f.task.id, {
    title: "待收藏",
    content: "# 初版收藏",
    format: "md",
    goalVersion: 1,
  });
  const entry = await collectArtifact(f.store, f.store.settings().aiRoot, {
    type: "library.collect",
    taskId: f.task.id,
    artifactId: artifact.id,
    expectedHash: artifact.hash,
    tags: [],
    note: "",
  });
  const routine = await f.create({ libraryIds: [entry.id] });
  await f.engine.execute({
    type: "routine.run",
    requestId: "lib-unchanged",
    routineId: routine.id,
  });
  assert.equal(f.calls(), 0);
  await saveLibraryEntry(f.store, f.store.settings().aiRoot, {
    type: "library.save",
    entryId: entry.id,
    title: entry.title,
    content: "# 收藏新增证据",
    expectedHash: entry.hash,
    tags: [],
    note: "",
  });
  await f.engine.execute({
    type: "routine.run",
    requestId: "lib-changed",
    routineId: routine.id,
  });
  assert.equal(f.calls(), 1);
  assert.match(
    f.store
      .task("routine-worker")
      .sources.find((source) => source.id === `routine-library-${entry.id}`)!
      .text,
    /收藏新增证据/,
  );
});

test("schedule-only edits preserve the no-new-material baseline and globally disabled pinned methods wait safely", async (t) => {
  const f = await fixture(t),
    routine = await f.create();
  await f.engine.execute({
    type: "routine.edit",
    requestId: "edit-time",
    routineId: routine.id,
    expectedVersion: 1,
    schedule: {
      kind: "time",
      cadence: "daily",
      timezone: "UTC",
      time: "10:00",
    },
  });
  await f.engine.execute({
    type: "routine.run",
    requestId: "time-no-change",
    routineId: routine.id,
  });
  assert.equal(f.calls(), 0);
  f.store.setConfig("skills.enabled", { "material-digest": false });
  f.change("ORCHID 99");
  await f.engine.execute({
    type: "routine.run",
    requestId: "disabled",
    routineId: routine.id,
  });
  assert.equal(f.calls(), 0);
  assert.equal(f.state().state, "waiting");
  assert.match(f.state().lastError ?? "", /方法已停用/);
});
