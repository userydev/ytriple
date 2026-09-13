import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { Store, now, uid } from "../src/core/store.js";
import {
  attentionSnapshot,
  handleAttentionCommand,
} from "../src/core/attention.js";
import { attentionCommandSchema } from "../src/shared/attention.js";
import { RoutineEngine, routineSnapshot } from "../src/core/routines.js";
import {
  deliverySnapshot,
  handleDeliveryCommand,
} from "../src/core/delivery.js";
import { textSource, writeArtifact } from "../src/core/files.js";
import type { Task } from "../src/shared/types.js";
import type { FeatureHost } from "../src/core/feature-host.js";
import type { WorkServiceSnapshot } from "../src/shared/work-service.js";

async function setup(t: { after(fn: () => unknown): void }) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "ytriple-attention-")),
  );
  let store = new Store(path.join(root, "data"));
  store.setConfig("settings", {
    ...store.settings(),
    aiRoot: path.join(root, "AI"),
    codeRoot: path.join(root, "Code"),
    workspaceRoot: path.join(root, "work"),
  });
  const task = (status: Task["status"] = "waiting"): Task => ({
    id: uid(),
    title: "真实原工作",
    goal: "阅读用户材料形成说明",
    goalVersion: 1,
    kind: "research",
    member: "researcher",
    workspace: path.join(root, "work", uid()),
    status,
    createdAt: now(),
    updatedAt: now(),
    messages: [],
    events: [],
    artifacts: [],
    sources: [],
  });
  let failRun = false;
  const pending: Promise<void>[] = [];
  const host: FeatureHost = {
    get store() {
      return store;
    },
    createWork: async (input) => {
      const created = {
        ...task("idle"),
        title: input.title,
        goal: input.goal,
        sources: input.sources ?? [],
      };
      store.saveTask(created);
      return created;
    },
    runWork: (id) => {
      const operation = (async () => {
        host.store.event(id, {
          type: "model_usage",
          goalVersion: store.task(id).goalVersion,
          summary: "测试替身的已知用量",
          data: { totalTokens: 30 },
        });
        if (failRun) {
          store.updateTask(id, (current) => {
            current.status = "failed";
            current.error = "真实来源读取失败";
          });
          return;
        }
        const current = store.task(id);
        await writeArtifact(store, id, {
          title: "核查成果",
          format: "md",
          content: "# 核查\n实际输入的新结论",
          goalVersion: current.goalVersion,
        });
        store.updateTask(id, (value) => {
          value.status = "completed";
        });
      })();
      pending.push(operation);
      return operation;
    },
    addSource: async () => undefined,
    stopWork: async () => undefined,
    isRunning: () => false,
  };
  t.after(async () => {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    host,
    task,
    pending,
    failNext: () => {
      failRun = true;
    },
    reopen: () => {
      store.close();
      store = new Store(path.join(root, "data"));
    },
  };
}

test("attention reads are pure; handling, snoozing, changes and notification preferences persist without altering original work", async (t) => {
  const { host, task, reopen } = await setup(t);
  const work = task();
  work.events.push({
    id: uid(),
    type: "clarification_requested",
    summary: "这项作品的目标读者是谁？",
    goalVersion: 1,
    createdAt: now(),
  });
  host.store.saveTask(work);
  const persisted = host.store.task(work.id);
  const ordinary = task("completed");
  ordinary.messages.push({
    id: uid(),
    role: "assistant",
    member: "researcher",
    content: "普通回复",
    createdAt: now(),
    goalVersion: 1,
  });
  host.store.saveTask(ordinary);
  host.store.saveTask({ ...task("failed"), surface: "background" });
  host.store.saveTask({ ...task("failed"), archivedAt: now() });
  const dbBefore = host.store.db
    .prepare("SELECT key,body FROM config ORDER BY key")
    .all();
  let view = attentionSnapshot(host.store);
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0]!.summary, "这项作品的目标读者是谁？");
  assert.deepEqual(
    host.store.db.prepare("SELECT key,body FROM config ORDER BY key").all(),
    dbBefore,
  );
  assert.equal(
    host.store.db
      .prepare("SELECT 1 FROM sqlite_master WHERE name='routines'")
      .get(),
    undefined,
  );
  const first = view.items[0]!;
  const command = {
    type: "attention.resolve" as const,
    requestId: uid(),
    itemId: first.id,
    expectedFingerprint: first.fingerprint,
    action: "handled" as const,
  };
  await Promise.all([
    handleAttentionCommand(host, command),
    handleAttentionCommand(host, command),
  ]);
  assert.deepEqual(host.store.task(work.id), persisted);
  host.store.event(work.id, {
    type: "workspace.viewed",
    summary: "查看界面",
    goalVersion: 1,
  });
  assert.equal(
    attentionSnapshot(host.store).items[0]!.state,
    "handled",
    "unrelated UI activity does not resurrect the same question",
  );
  await handleAttentionCommand(host, {
    type: "attention.preferences",
    requestId: uid(),
    expectedRevision: 0,
    mode: "muted",
  });
  reopen();
  view = attentionSnapshot(host.store);
  assert.equal(view.items[0]!.state, "handled");
  assert.equal(view.preferences.mode, "muted");
  host.store.event(work.id, {
    type: "clarification_requested",
    summary: "目标平台需要哪个实际账号？",
    goalVersion: 1,
  });
  view = attentionSnapshot(host.store);
  assert.equal(view.items[0]!.state, "open");
  assert.equal(view.notification.count, 0);
  assert.equal(
    view.counts.important,
    1,
    "muting does not disguise a real blocked task",
  );
  await handleAttentionCommand(host, command);
  assert.equal(
    attentionSnapshot(host.store).items[0]!.state,
    "open",
    "a replay never handles a newly changed issue",
  );
  await assert.rejects(
    handleAttentionCommand(host, { ...command, requestId: uid() }),
    /情况已经变化/,
  );
  const at = Date.now(),
    latest = view.items[0]!;
  await handleAttentionCommand(
    host,
    {
      ...command,
      requestId: uid(),
      expectedFingerprint: latest.fingerprint,
      action: "snoozed",
      snoozedUntil: new Date(at + 3600000).toISOString(),
    },
    at,
  );
  assert.equal(attentionSnapshot(host.store, at).counts.snoozed, 1);
  assert.equal(attentionSnapshot(host.store, at + 3600001).counts.open, 1);
  await assert.rejects(
    handleAttentionCommand(host, {
      type: "attention.preferences",
      requestId: uid(),
      expectedRevision: 0,
      mode: "summary",
    }),
    /偏好已经更新/,
  );
  assert.equal(
    attentionCommandSchema.safeParse({
      ...command,
      action: "handled",
      snoozedUntil: now(),
    }).success,
    false,
  );
  assert.equal(
    attentionCommandSchema.safeParse({ ...command, action: "snoozed" }).success,
    false,
  );
  await assert.rejects(
    handleAttentionCommand(
      host,
      {
        ...command,
        requestId: uid(),
        expectedFingerprint: latest.fingerprint,
        action: "snoozed",
        snoozedUntil: new Date(at - 1).toISOString(),
      },
      at,
    ),
    /未来一年/,
  );
  const recovered = task("paused");
  recovered.events = [
    {
      id: uid(),
      type: "clarification_requested",
      summary: "已经回答的旧问题",
      goalVersion: 1,
      createdAt: now(),
    },
    {
      id: uid(),
      type: "run_started",
      summary: "已经继续本轮工作",
      goalVersion: 1,
      createdAt: now(),
    },
    {
      id: uid(),
      type: "recovered",
      summary: "上次执行中断，已有成果保留",
      goalVersion: 1,
      createdAt: now(),
    },
  ];
  host.store.saveTask(recovered);
  assert.equal(
    attentionSnapshot(host.store).items.find(
      (item) => item.origin.taskId === recovered.id,
    )!.summary,
    "上次执行中断，已有成果保留",
  );
});

test("real routine outputs are linked once, unchanged runs stay quiet, and source failures remain visible", async (t) => {
  const { host, task, failNext } = await setup(t);
  const work = task("completed");
  work.sources = [textSource("获准材料", "实际用户正文")];
  work.messages = [
    {
      id: uid(),
      role: "assistant",
      member: "researcher",
      content: "有效完成原工作",
      createdAt: now(),
      goalVersion: 1,
    },
  ];
  host.store.saveTask(work);
  const engine = new RoutineEngine(host);
  await engine.execute({
    type: "routine.create",
    requestId: uid(),
    taskId: work.id,
    templateId: "saved-digest",
    schedule: { kind: "change", pollMinutes: 15, timezone: "UTC" },
  });
  const routine = routineSnapshot(host.store).items[0]!;
  await engine.execute({
    type: "routine.run",
    requestId: uid(),
    routineId: routine.id,
  });
  let view = attentionSnapshot(host.store);
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0]!.reason, "result");
  assert.equal(view.items[0]!.origin.taskId, work.id);
  assert.ok(
    host.store
      .task(work.id)
      .artifacts.some((item) =>
        view.items[0]!.origin.artifactIds.includes(item.id),
      ),
  );
  const prior = view.items[0]!.fingerprint;
  await engine.execute({
    type: "routine.run",
    requestId: uid(),
    routineId: routine.id,
  });
  assert.equal(attentionSnapshot(host.store).items[0]!.fingerprint, prior);
  failNext();
  host.store.updateTask(work.id, (current) => {
    current.sources[0]!.text += "新增材料";
  });
  await engine.execute({
    type: "routine.run",
    requestId: uid(),
    routineId: routine.id,
  });
  view = attentionSnapshot(host.store);
  assert.equal(view.items.filter((item) => item.reason === "failed").length, 1);
  assert.match(
    view.items.find((item) => item.reason === "failed")!.summary,
    /来源读取失败/,
  );
  assert.equal(
    view.items.some((item) => item.kind === "task"),
    false,
    "a managed worker is not repeated as a separate failure",
  );
  await handleAttentionCommand(host, {
    type: "attention.preferences",
    requestId: uid(),
    expectedRevision: 0,
    mode: "important",
  });
  assert.equal(attentionSnapshot(host.store).notification.count, 1);
  await engine.close();
});

test("delivery feedback and actual check artifacts stay on their original records; attention actions never decide feedback", async (t) => {
  const { host, task, pending } = await setup(t);
  const work = task("completed");
  host.store.saveTask(work);
  const artifact = await writeArtifact(host.store, work.id, {
    title: "制作交接",
    format: "md",
    content: "# 交接\n实际交付",
    goalVersion: 1,
  });
  await handleDeliveryCommand(host, {
    type: "delivery.register",
    requestId: uid(),
    taskId: work.id,
    artifactId: artifact.id,
    expectedHash: artifact.hash,
    spec: {
      recipient: "用户",
      goal: "按说明制作",
      criteria: "步骤明确",
      missing: "",
    },
  });
  const ref = () => {
    const record = deliverySnapshot(host.store).records[0]!;
    return {
      deliveryId: record.id,
      expectedRevision: record.revision,
      requestId: uid(),
    };
  };
  await handleDeliveryCommand(host, {
    type: "delivery.addFeedback",
    ...ref(),
    kind: "text",
    quote: "实际使用时第二步不清楚",
    observedAt: now(),
    coverage: "一名用户的一次使用",
  });
  await handleDeliveryCommand(host, {
    type: "delivery.status",
    ...ref(),
    status: "revision_needed",
    evidence: {},
    note: "按实际反馈修订步骤",
  });
  await handleDeliveryCommand(host, {
    type: "delivery.check",
    ...ref(),
    sourceIds: [],
  });
  await Promise.all(pending);
  let view = attentionSnapshot(host.store);
  assert.deepEqual(
    new Set(view.items.map((item) => item.reason)),
    new Set(["revision", "feedback", "check"]),
  );
  const feedback = view.items.find((item) => item.reason === "feedback")!;
  const record = deliverySnapshot(host.store).records[0]!;
  assert.deepEqual(feedback.origin.feedbackIds, [record.feedback[0]!.id]);
  const before = structuredClone(record);
  await handleAttentionCommand(host, {
    type: "attention.resolve",
    requestId: uid(),
    itemId: feedback.id,
    expectedFingerprint: feedback.fingerprint,
    action: "handled",
  });
  assert.deepEqual(deliverySnapshot(host.store).records[0], before);
  assert.equal(
    deliverySnapshot(host.store).records[0]!.feedback[0]!.decision,
    "pending",
  );
  const check = view.items.find((item) => item.reason === "check")!;
  assert.ok(check.origin.workTaskId);
  assert.equal(
    host.store.task(check.origin.workTaskId!).artifacts[0]!.id,
    check.origin.artifactIds[0],
  );
  await handleDeliveryCommand(host, {
    type: "delivery.decideFeedback",
    ...ref(),
    feedbackId: record.feedback[0]!.id,
    decision: "accepted",
    note: "在原工作修订第二步",
  });
  view = attentionSnapshot(host.store);
  assert.equal(
    view.items.some((item) => item.reason === "feedback"),
    false,
  );
});

test("remote attention uses the current account and local submission records, never a server-provided local origin", async (t) => {
  const { host, task } = await setup(t);
  const original = task("completed");
  host.store.saveTask(original);
  const service: WorkServiceSnapshot = {
    state: "connected",
    baseURL: "https://work.example.com",
    account: {
      user: { id: "user-a", username: "用户甲" },
      entitlement: {
        plan: "test",
        active: true,
        modelIds: [],
        tokenLimit: 1000,
        maxConcurrent: 1,
      },
      usage: {
        usedTokens: 10,
        reservedTokens: 0,
        remainingTokens: 990,
        unknownRequests: 1,
      },
    },
    devices: [],
    models: [],
    exports: [],
    collected: {},
    submissions: {},
    jobs: [
      {
        id: "remote-job",
        title: "服务器检查",
        model: "model",
        goal: "阅读获准材料",
        materials: [],
        skills: [],
        origin: { taskId: original.id },
        version: 1,
        schedule: { kind: "once" },
        limits: { maxRuns: 5, maxTokens: 1000 },
        state: "uncertain",
        createdAt: now(),
        updatedAt: now(),
        runCount: 1,
        tokens: 10,
        lastError: "网络中断，本轮结果未知",
        runs: [
          {
            id: "remote-run",
            version: 1,
            state: "uncertain",
            startedAt: now(),
            inputHash: "hash",
            meaningful: true,
          },
        ],
      },
    ],
  };
  let view = attentionSnapshot(host.store, Date.now(), service);
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0]!.kind, "remote");
  assert.equal(
    view.items[0]!.origin.taskId,
    undefined,
    "remote origin cannot point to a same-named local task",
  );
  assert.equal(view.counts.important, 1);
  service.submissions!["remote-job"] = {
    taskId: original.id,
    goalVersion: 1,
    sourceHashes: {},
    skillHashes: {},
  };
  view = attentionSnapshot(host.store, Date.now(), service);
  assert.equal(view.items[0]!.origin.taskId, original.id);
  const issue = view.items[0]!;
  const action = {
    type: "attention.resolve" as const,
    requestId: uid(),
    itemId: issue.id,
    expectedFingerprint: issue.fingerprint,
    action: "handled" as const,
  };
  await assert.rejects(handleAttentionCommand(host, action), /情况已经变化/);
  await handleAttentionCommand(host, action, Date.now(), service);
  assert.equal(
    attentionSnapshot(host.store, Date.now(), service).items[0]!.state,
    "handled",
  );
  assert.equal(
    attentionSnapshot(host.store, Date.now(), {
      ...service,
      account: undefined,
    }).items.length,
    0,
  );
  const other = {
    ...service,
    account: {
      ...service.account!,
      user: { id: "user-b", username: "用户乙" },
    },
  };
  assert.equal(
    attentionSnapshot(host.store, Date.now(), other).items[0]!.state,
    "open",
    "equal remote job IDs in another account have independent decisions",
  );
  service.jobs[0]!.state = "completed";
  service.jobs[0]!.lastError = undefined;
  Object.assign(service.jobs[0]!.runs[0]!, {
    state: "completed",
    finishedAt: now(),
    result: "实际服务器保存的结果",
    meaningful: true,
  });
  view = attentionSnapshot(host.store, Date.now(), service);
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0]!.reason, "result");
  service.jobs[0]!.runs[0]!.meaningful = false;
  assert.equal(
    attentionSnapshot(host.store, Date.now(), service).items.length,
    0,
  );
  service.error = "当前服务刷新失败";
  service.state = "offline";
  assert.equal(
    attentionSnapshot(host.store, Date.now(), service).counts.important,
    1,
  );
});
