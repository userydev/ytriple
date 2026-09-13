import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponder,
} from "@openai/agents/testing";
import { Store, now, uid } from "../src/core/store.js";
import { WorkbenchService } from "../src/core/service.js";
import {
  collectArtifact,
  librarySource,
  readLibraryEntry,
  recordLibraryFeedback,
  saveLibraryEntry,
} from "../src/core/library.js";
import {
  assertLibraryContextCurrent,
  prepareLibraryRecall,
  rankLibrary,
} from "../src/core/library-recall.js";
import { libraryAssessment } from "../src/shared/library.js";
import { hash, writeArtifact } from "../src/core/files.js";
import { parseCommand } from "../src/desktop/commands.js";
import type { Command, LibraryEntry, Task } from "../src/shared/types.js";

async function setup(t: { after(fn: () => unknown): void }) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "ytriple-learning-")),
  );
  const store = new Store(path.join(root, "data"));
  const aiRoot = path.join(root, "AI");
  store.setConfig("settings", {
    ...store.settings(),
    aiRoot,
    codeRoot: path.join(root, "Code"),
    workspaceRoot: path.join(root, "work"),
    projectMonitoring: false,
  });
  t.after(async () => {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const makeTask = (goal: string): Task => {
    const task: Task = {
      id: uid(),
      title: goal,
      goal,
      goalVersion: 1,
      kind: "research",
      member: "coordinator",
      status: "idle",
      workspace: path.join(root, "work", uid()),
      createdAt: now(),
      updatedAt: now(),
      sources: [],
      artifacts: [],
      events: [],
      messages: [
        {
          id: uid(),
          role: "user",
          member: "coordinator",
          content: goal,
          goalVersion: 1,
          createdAt: now(),
        },
      ],
    };
    store.saveTask(task);
    return task;
  };
  const origin = makeTask("阅读方法研究");
  const artifact = await writeArtifact(store, origin.id, {
    title: "深度阅读方法",
    content: "# 深度阅读方法\n先提出问题，再阅读材料。建议每次阅读两小时。",
    format: "md",
    goalVersion: 1,
  });
  const entry = await collectArtifact(store, aiRoot, {
    type: "library.collect",
    taskId: origin.id,
    artifactId: artifact.id,
    expectedHash: artifact.hash,
    tags: ["阅读", "学习"],
  });
  const feedback = (
    patch: Partial<Extract<Command, { type: "library.feedback" }>> = {},
  ) => ({
    type: "library.feedback" as const,
    entryId: entry.id,
    feedbackId: uid(),
    expectedHash: entry.hash,
    expectedVersion: entry.version,
    expectedFeedbackRevision: 0,
    kind: "correction" as const,
    note: "连续两小时不适合新手；改成二十分钟并做理解检查。",
    purpose: "",
    conditions: "",
    evidence: "",
    ...patch,
  });
  return { root, aiRoot, store, origin, artifact, entry, makeTask, feedback };
}

test("local recall ranks relevant Chinese and English assets; no arbitrary recent asset or media injection", async (t) => {
  const { store, aiRoot, entry } = await setup(t);
  const english: LibraryEntry = {
    ...entry,
    id: "english",
    title: "SQLite backup recovery",
    content: "Use WAL checkpoints and verify a backup by restoring it.",
    tags: [],
  };
  const unrelated: LibraryEntry = {
    ...entry,
    id: "other",
    title: "烘焙曲奇",
    content: "黄油、面粉、烤箱。",
    tags: [],
  };
  const entries = [
    readLibraryEntry(store, aiRoot, entry.id),
    english,
    unrelated,
    { ...entry, id: "media", format: "png" as const },
    { ...entry, id: "broken", readError: "missing" },
  ];
  assert.equal(
    rankLibrary(entries, "为新手制定深度阅读练习")[0]?.entry.id,
    entry.id,
  );
  assert.equal(
    rankLibrary(entries, "How should I restore a SQLite backup?")[0]?.entry.id,
    "english",
  );
  assert.deepEqual(rankLibrary(entries, "你好，请帮助我"), []);
  assert.deepEqual(rankLibrary(entries, "研究木星卫星的轨道"), []);
  assert.ok(
    rankLibrary(entries, "阅读方法").every(
      (match) => !["media", "broken"].includes(match.entry.id),
    ),
  );
});

test("feedback is append-only, idempotent, revision checked, user attributed, and survives database reopen", async (t) => {
  const { store, aiRoot, entry, feedback } = await setup(t);
  const input = feedback();
  const first = recordLibraryFeedback(
    store,
    aiRoot,
    parseCommand(input) as typeof input,
  );
  assert.deepEqual(recordLibraryFeedback(store, aiRoot, input), first);
  assert.throws(
    () => recordLibraryFeedback(store, aiRoot, { ...input, note: "偷偷覆盖" }),
    /不能改写/,
  );
  assert.throws(
    () => recordLibraryFeedback(store, aiRoot, feedback()),
    /反馈已有更新/,
  );
  assert.throws(() => parseCommand(feedback({ kind: "useful" })), /参数无效/);
  assert.throws(
    () =>
      recordLibraryFeedback(store, aiRoot, feedback({ entryId: "foreign" })),
    /找不到/,
  );
  const reopened = new Store(store.dataPath);
  try {
    const current = readLibraryEntry(reopened, aiRoot, entry.id);
    assert.equal(current.content, entry.content);
    assert.equal(current.feedbackRevision, 1);
    assert.equal(current.feedback?.[0]?.note, first.note);
    assert.equal(libraryAssessment(current), "needs_review");
  } finally {
    reopened.close();
  }
});

test("positive feedback applies only to observed bytes; unresolved corrections require explicit substantive revision", async (t) => {
  const { store, aiRoot, entry, feedback } = await setup(t);
  recordLibraryFeedback(
    store,
    aiRoot,
    feedback({
      kind: "useful",
      note: "完成了两段阅读并能复述",
      purpose: "练习复述",
      conditions: "已有基础的成年人",
      evidence: "两次练习各复述三条要点",
    }),
  );
  assert.equal(
    libraryAssessment(readLibraryEntry(store, aiRoot, entry.id)),
    "user_reported_useful",
  );
  const correction = recordLibraryFeedback(
    store,
    aiRoot,
    feedback({ expectedFeedbackRevision: 1 }),
  );
  assert.equal(
    libraryAssessment(readLibraryEntry(store, aiRoot, entry.id)),
    "needs_review",
  );
  await assert.rejects(
    saveLibraryEntry(store, aiRoot, {
      type: "library.save",
      entryId: entry.id,
      expectedHash: entry.hash,
      content: entry.content!,
      resolvedFeedbackIds: [correction.id],
    }),
    /实际修订/,
  );
  const next = await saveLibraryEntry(store, aiRoot, {
    type: "library.save",
    entryId: entry.id,
    expectedHash: entry.hash,
    content: "# 深度阅读方法\n新手每二十分钟做一次理解检查。",
    resolvedFeedbackIds: [correction.id],
  });
  assert.equal(libraryAssessment(next), "unverified");
  assert.equal(next.feedbackResolutions?.[0]?.version, 2);
  assert.equal(next.feedback?.length, 2);
  assert.equal(
    librarySource(store, aiRoot, entry.id).library?.resolvedFeedbackIds[0],
    correction.id,
  );
  await fs.writeFile(entry.path, "外部改写正文");
  assert.equal(
    libraryAssessment(readLibraryEntry(store, aiRoot, entry.id)),
    "needs_review",
  );
});

test("recall snapshots remain immutable history; new feedback is read on continuation without duplication or cross-root reads", async (t) => {
  const { store, aiRoot, entry, makeTask, feedback, root } = await setup(t);
  const task = makeTask("制定深度阅读练习");
  prepareLibraryRecall(store, task.id);
  const initial = store.task(task.id).sources[0]!;
  assert.equal(initial.library?.selection, "recalled");
  assert.equal(initial.library?.feedback.length, 0);
  prepareLibraryRecall(store, task.id);
  assert.equal(store.task(task.id).sources.length, 1);
  store.updateTask(task.id, (current) => {
    current.messages.push({
      id: uid(),
      role: "user",
      member: "coordinator",
      content: "请补充适用条件",
      goalVersion: current.goalVersion,
      createdAt: now(),
    });
  });
  prepareLibraryRecall(store, task.id);
  assert.equal(
    store
      .task(task.id)
      .sources.filter((source) => !source.library?.supersededAt).length,
    1,
    "short follow-up retains context of the current goal",
  );
  recordLibraryFeedback(store, aiRoot, feedback());
  assert.throws(
    () => assertLibraryContextCurrent(store, store.task(task.id)),
    /反馈/,
  );
  prepareLibraryRecall(store, task.id);
  const next = store.task(task.id);
  assert.equal(next.sources.length, 2);
  assert.ok(next.sources[0]?.library?.supersededAt);
  assert.deepEqual(next.sources[0]?.library?.feedback, []);
  assert.equal(next.sources[1]?.library?.feedback[0]?.note, feedback().note);
  assert.equal(
    next.messages.length,
    2,
    "context refresh must not fabricate another user message",
  );
  assert.doesNotThrow(() => assertLibraryContextCurrent(store, next));
  store.setConfig("settings", { ...store.settings(), libraryRecall: false });
  prepareLibraryRecall(store, task.id);
  assert.ok(
    store.task(task.id).sources.every((source) => source.library?.supersededAt),
  );
  store.setConfig("settings", {
    ...store.settings(),
    aiRoot: path.join(root, "other-AI"),
    libraryRecall: true,
  });
  const other = makeTask("制定深度阅读练习");
  prepareLibraryRecall(store, other.id);
  assert.deepEqual(store.task(other.id).sources, []);
});

test("outcome feedback binds the exact asset version used, rejects unrelated tasks, and survives deleting the conversation", async (t) => {
  const { store, aiRoot, entry, makeTask, feedback } = await setup(t);
  const used = makeTask("深度阅读方法实践");
  prepareLibraryRecall(store, used.id);
  const source = store.task(used.id).sources[0]!;
  await saveLibraryEntry(store, aiRoot, {
    type: "library.save",
    entryId: entry.id,
    expectedHash: entry.hash,
    content: "当前新版本",
  });
  const input = feedback({
    taskId: used.id,
    sourceId: source.id,
    kind: "useful",
    note: "旧版在本次场景有效",
    purpose: "阅读练习",
    conditions: "有经验的阅读者",
    evidence: "三次完成预期总结",
  });
  const saved = recordLibraryFeedback(store, aiRoot, input);
  assert.equal(saved.targetHash, entry.hash);
  assert.equal(saved.targetVersion, 1);
  assert.equal(
    libraryAssessment(readLibraryEntry(store, aiRoot, entry.id)),
    "unverified",
  );
  const unrelated = makeTask("烘焙方法");
  assert.throws(
    () =>
      recordLibraryFeedback(store, aiRoot, {
        ...input,
        feedbackId: uid(),
        expectedFeedbackRevision: 1,
        taskId: unrelated.id,
      }),
    /没有使用/,
  );
  store.deleteTask(used.id);
  assert.equal(
    store.libraryFeedback(aiRoot, entry.id)[0]?.outcome?.taskTitle,
    used.title,
  );
  assert.deepEqual(recordLibraryFeedback(store, aiRoot, input), saved);
});

test("feedback fences affected goals before stopping runs, idempotent delivery does not invalidate twice", async (t) => {
  const { store, root, aiRoot, entry, makeTask, feedback } = await setup(t);
  const task = makeTask("深度阅读练习");
  prepareLibraryRecall(store, task.id);
  const service = new WorkbenchService(
    path.join(root, "data"),
    () => undefined,
  );
  t.after(() => service.close());
  let stops = 0;
  service.runtime.stop = async (id) => {
    if (id === task.id) {
      stops++;
      assert.ok(service.store.task(id).goalVersion > task.goalVersion);
    }
  };
  const input = feedback();
  await service.execute(input);
  const version = service.store.task(task.id).goalVersion;
  await service.execute(input);
  assert.equal(service.store.task(task.id).goalVersion, version);
  assert.equal(service.store.task(task.id).status, "paused");
  assert.equal(stops, 1);
  assert.equal(
    readLibraryEntry(service.store, aiRoot, entry.id).feedbackRevision,
    1,
  );
});

test("deterministic model journey reads recalled feedback, saves an instruction, reopens and attributes actual-use feedback", async (t) => {
  const { store, root, aiRoot, entry, makeTask, feedback } = await setup(t);
  const task = makeTask("给新手一份深度阅读练习说明书");
  prepareLibraryRecall(store, task.id);
  recordLibraryFeedback(store, aiRoot, feedback());
  let readVerified = false;
  let service = new WorkbenchService(
    path.join(root, "data"),
    () => "synthetic-key",
    () => {},
    {
      modelFactory: () =>
        new ScriptedModel([
          modelResponder((call) => {
            assert.match(
              JSON.stringify(call.request.input),
              /给新手一份深度阅读练习说明书/,
            );
            const source = service.store
              .task(task.id)
              .sources.find(
                (item) =>
                  item.library?.entryId === entry.id &&
                  !item.library.supersededAt,
              )!;
            assert.ok(source);
            return [
              functionCall(
                "read_source",
                { sourceId: source.id, start: 0, maxCharacters: 24000 },
                { callId: "read-lib" },
              ),
            ];
          }),
          modelResponder((request) => {
            const serialized = JSON.stringify(request);
            assert.match(serialized, /二十分钟/);
            assert.match(serialized, /needs_review/);
            readVerified = true;
            return [
              functionCall(
                "write_artifact",
                {
                  title: "新手阅读练习说明书",
                  content: `# 新手阅读练习\n目标：读完一节并复述。\n方法：每二十分钟做理解检查。\n条件：新手。\n依据：Lib ${entry.id} v1 与用户修正。\n验证：实际复述三条要点后再记录结果。`,
                  format: "md",
                  artifactId: null,
                  expectedHash: null,
                },
                { callId: "write-result" },
              ),
            ];
          }),
          [
            assistantMessage(
              "已依据 Lib 的用户修正形成练习说明；实际效果待使用。",
            ),
          ],
        ]),
    },
  );
  t.after(() => service.close());
  const original = service.runtime.run.bind(service.runtime);
  let running: Promise<void> | undefined;
  service.runtime.run = (id) => (running = original(id));
  await service.execute({ type: "task.run", taskId: task.id });
  await running;
  const finished = service.store.task(task.id);
  assert.equal(finished.status, "completed", finished.error);
  assert.ok(readVerified);
  assert.equal(finished.artifacts.length, 1);
  assert.ok(
    finished.events.some(
      (event) =>
        event.type === "tool_completed" && event.data?.tool === "read_source",
    ),
  );
  const artifact = finished.artifacts[0]!;
  assert.match(await fs.readFile(artifact.path, "utf8"), /每二十分钟/);
  await service.close();
  service = new WorkbenchService(path.join(root, "data"), () => undefined);
  const snapshot = await service.initialize();
  assert.equal(
    snapshot.library?.find((item) => item.id === entry.id)?.feedbackRevision,
    1,
  );
  const source = finished.sources.find(
    (item) => item.library?.entryId === entry.id,
  )!;
  await service.execute(
    feedback({
      expectedFeedbackRevision: 1,
      kind: "useful",
      note: "按说明完成三条复述",
      purpose: "阅读练习",
      conditions: "一次合成练习",
      evidence: "确定性夹具验证反馈归因；非真人效果证据",
      taskId: task.id,
      sourceId: source.id,
      artifactId: artifact.id,
      expectedArtifactHash: artifact.hash,
      expectedArtifactVersion: artifact.version,
    }),
  );
  const recorded = service.store.libraryFeedback(aiRoot, entry.id).at(-1)!;
  assert.equal(
    recorded.outcome?.artifactHash,
    hash(await fs.readFile(artifact.path)),
  );
  assert.equal(
    libraryAssessment(readLibraryEntry(service.store, aiRoot, entry.id)),
    "needs_review",
    "positive report cannot erase an unresolved correction",
  );
});

test("explicit selection keeps an automatically recalled asset when automatic recall is later disabled", async (t) => {
  const { root, store, entry, makeTask } = await setup(t);
  const task = makeTask("深度阅读练习");
  prepareLibraryRecall(store, task.id);
  const service = new WorkbenchService(
    path.join(root, "data"),
    () => undefined,
  );
  t.after(() => service.close());
  await service.execute({
    type: "library.reuse",
    taskId: task.id,
    entryId: entry.id,
  });
  service.store.setConfig("settings", {
    ...service.store.settings(),
    libraryRecall: false,
  });
  prepareLibraryRecall(service.store, task.id);
  const active = service.store
    .task(task.id)
    .sources.filter((source) => !source.library?.supersededAt);
  assert.equal(active.length, 1);
  assert.equal(active[0]?.library?.selection, "explicit");
});

test("reopening reconciles a feedback commit interrupted before task invalidation, including first-stage Lib snapshots", async (t) => {
  const { root, store, aiRoot, entry, makeTask, feedback } = await setup(t);
  const task = makeTask("继续上次练习");
  const legacy = librarySource(store, aiRoot, entry.id);
  delete legacy.library;
  store.updateTask(task.id, (current) => {
    current.sources.push(legacy);
    current.status = "completed";
  });
  recordLibraryFeedback(store, aiRoot, feedback());
  const service = new WorkbenchService(
    path.join(root, "data"),
    () => undefined,
  );
  t.after(() => service.close());
  const snapshot = await service.initialize();
  const recovered = snapshot.tasks.find((item) => item.id === task.id)!;
  assert.equal(recovered.status, "paused");
  assert.equal(recovered.sources[0]?.id, legacy.id);
  assert.equal(recovered.sources[0]?.library?.entryId, entry.id);
  assert.equal(recovered.messages.length, 1);
  prepareLibraryRecall(service.store, task.id);
  const active = service.store
    .task(task.id)
    .sources.filter((source) => !source.library?.supersededAt);
  assert.equal(active.length, 1);
  assert.equal(active[0]?.library?.feedbackRevision, 1);
});
