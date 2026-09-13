import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Store, now, uid } from "../src/core/store.js";
import { hash, textSource, writeArtifact } from "../src/core/files.js";
import {
  deliveryMarkdown,
  deliverySnapshot,
  handleDeliveryCommand,
} from "../src/core/delivery.js";
import {
  deliveryCommandSchema,
  type DeliveryCommand,
} from "../src/shared/delivery.js";
import type {
  FeatureHost,
  FeatureTaskInput,
} from "../src/core/feature-host.js";
import type { Task } from "../src/shared/types.js";
import { bootstrapSystem, initializeProject } from "../src/core/system.js";

async function fixture(t: { after(fn: () => unknown): void }) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "ytriple-delivery-")),
  );
  const store = new Store(path.join(root, "data"));
  store.setConfig("settings", {
    ...store.settings(),
    aiRoot: path.join(root, "AI"),
    codeRoot: path.join(root, "Code"),
    workspaceRoot: path.join(root, "work"),
  });
  let closed = false;
  const close = () => {
    if (!closed) {
      store.close();
      closed = true;
    }
  };
  t.after(async () => {
    close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const task: Task = {
    id: uid(),
    title: "交接材料",
    goal: "向专业工具交接可靠目标",
    goalVersion: 1,
    kind: "research",
    member: "coordinator",
    workspace: path.join(root, "work", "original"),
    status: "idle",
    createdAt: now(),
    updatedAt: now(),
    messages: [
      {
        id: uid(),
        role: "user",
        member: "coordinator",
        content: "秘密原讨论不应带入独立检查",
        createdAt: now(),
        goalVersion: 1,
      },
    ],
    events: [],
    sources: [
      textSource("指定证据", "获准材料原文"),
      textSource("未选材料", "不可隐式带入"),
    ],
    artifacts: [],
  };
  store.saveTask(task);
  const artifact = await writeArtifact(store, task.id, {
    title: "可交接目标",
    content: "# 准确原稿\n目标与完成条件。",
    format: "md",
    goalVersion: 1,
  });
  const created: FeatureTaskInput[] = [],
    runs: string[] = [];
  const host: FeatureHost = {
    store,
    createWork: async (input) => {
      if (input.requestId && store.hasTask(input.requestId))
        return store.task(input.requestId);
      created.push(input);
      const id = input.requestId ?? uid();
      const work: Task = {
        ...task,
        id,
        title: input.title,
        goal: input.goal,
        member: input.member ?? "coordinator",
        workspace: path.join(root, "work", id),
        messages: [],
        sources: input.sources ?? [],
        artifacts: [],
        skillPolicy: input.skillPolicy,
      };
      store.saveTask(work);
      return work;
    },
    addSource: async (id, source) => {
      store.updateTask(id, (task) => {
        task.sources.push(source);
      });
    },
    runWork: async (id) => {
      runs.push(id);
      store.updateTask(id, (task) => {
        task.status = "completed";
      });
    },
    stopWork: async () => undefined,
    isRunning: () => false,
  };
  const registration: DeliveryCommand = {
    type: "delivery.register",
    requestId: uid(),
    taskId: task.id,
    artifactId: artifact.id,
    expectedHash: artifact.hash,
    spec: {
      recipient: "制作执行者",
      goal: task.goal,
      criteria: "能够复述目标并按约定完成结果",
      missing: "",
      plannedDate: "2026-09-20",
    },
  };
  const register = async () => {
    await handleDeliveryCommand(host, registration);
    return deliverySnapshot(store).records[0]!;
  };
  const reference = () => {
    const record = deliverySnapshot(store).records[0]!;
    return {
      requestId: uid(),
      deliveryId: record.id,
      expectedRevision: record.revision,
    };
  };
  return {
    root,
    store,
    task,
    artifact,
    host,
    created,
    runs,
    registration,
    register,
    reference,
    close,
  };
}

test("delivery registration freezes actual bytes, survives reopening, and rejects stale or concurrent writes", async (t) => {
  const {
    host,
    store,
    task,
    artifact,
    register,
    registration,
    root,
    close,
    reference,
  } = await fixture(t);
  await Promise.all([
    handleDeliveryCommand(host, registration),
    handleDeliveryCommand(host, registration),
  ]);
  const record = await register();
  assert.equal(deliverySnapshot(store).records.length, 1);
  assert.equal(record.content, artifact.content);
  await assert.rejects(
    handleDeliveryCommand(host, {
      ...registration,
      expectedHash: hash("其他内容"),
    }),
    /不同操作/,
  );
  const command = {
    type: "delivery.update" as const,
    ...reference(),
    spec: {
      recipient: "另一接收人",
      goal: record.goal,
      criteria: record.criteria,
      missing: "缺素材",
    },
  };
  await handleDeliveryCommand(host, command);
  await assert.rejects(
    handleDeliveryCommand(host, { ...command, requestId: uid() }),
    /已更新/,
  );
  await writeArtifact(store, task.id, {
    title: artifact.title,
    content: "# 后来的新稿",
    format: "md",
    goalVersion: 1,
    artifactId: artifact.id,
    expectedHash: artifact.hash,
  });
  assert.equal(deliverySnapshot(store).records[0]!.sourceChanged, true);
  assert.equal(deliverySnapshot(store).records[0]!.artifactHash, artifact.hash);
  close();
  const reopened = new Store(path.join(root, "data"));
  try {
    assert.equal(
      deliverySnapshot(reopened).records[0]!.content,
      artifact.content,
    );
  } finally {
    reopened.close();
  }
});

test("delivery status requires real-use fields and never treats checking or export as receipt", async (t) => {
  const { host, store, register, reference, artifact } = await fixture(t);
  await register();
  await assert.rejects(
    handleDeliveryCommand(host, {
      type: "delivery.status",
      ...reference(),
      status: "handed_off",
      evidence: {},
    }),
    /接收/,
  );
  await assert.rejects(
    handleDeliveryCommand(host, {
      type: "delivery.status",
      ...reference(),
      status: "verified",
      evidence: { usage: "制作说明已用" },
    }),
    /用途/,
  );
  await handleDeliveryCommand(host, {
    type: "delivery.status",
    ...reference(),
    status: "handed_off",
    evidence: { receipt: "执行者回执：已收到 9 月 13 日的 v1 原稿" },
  });
  await handleDeliveryCommand(host, {
    type: "delivery.status",
    ...reference(),
    status: "used",
    evidence: {
      usage: "按说明完成试拍",
      conditions: "室内单人录制，共两段",
      observations: "实际成片第一段完成；第二段仍缺镜头",
    },
  });
  const record = deliverySnapshot(store).records[0]!;
  assert.equal(record.history.length, 3);
  assert.equal(record.artifactHash, artifact.hash);
  const exportCommand = { type: "delivery.export" as const, ...reference() };
  await Promise.all([
    handleDeliveryCommand(host, exportCommand),
    handleDeliveryCommand(host, exportCommand),
  ]);
  const exported = deliverySnapshot(store).records[0]!;
  assert.equal(exported.status, "used");
  assert.equal(exported.exports.length, 1);
  const body = await fs.readFile(exported.exports[0]!.path, "utf8");
  assert.match(body, /准确原稿/);
  assert.ok(body.includes(artifact.hash));
  assert.match(body, /实际成片第一段完成/);
});

test("readiness uses an isolated researcher and only the frozen version plus explicitly selected sources", async (t) => {
  const { host, store, register, reference, task, artifact, created, runs } =
    await fixture(t);
  await register();
  await writeArtifact(store, task.id, {
    title: "新稿",
    content: "后来内容不属于旧版检查",
    format: "md",
    goalVersion: 1,
    artifactId: artifact.id,
    expectedHash: artifact.hash,
  });
  const command = {
    type: "delivery.check" as const,
    ...reference(),
    sourceIds: [task.sources[0]!.id],
  };
  await Promise.all([
    handleDeliveryCommand(host, command),
    handleDeliveryCommand(host, command),
  ]);
  assert.equal(created.length, 1);
  assert.equal(runs.length, 1);
  assert.equal(created[0]!.isolatedContext, true);
  assert.equal(created[0]!.member, "researcher");
  assert.deepEqual(created[0]!.skillPolicy, {
    mode: "explicit",
    skillIds: ["handoff-review"],
  });
  assert.equal(created[0]!.sources!.length, 2);
  assert.match(created[0]!.sources![0]!.text, /准确原稿/);
  assert.doesNotMatch(
    JSON.stringify(created[0]),
    /后来内容不属于|秘密原讨论|不可隐式带入/,
  );
  assert.equal(deliverySnapshot(store).records[0]!.status, "draft");
  assert.equal(
    deliverySnapshot(store).records[0]!.works[0]!.status,
    "completed",
  );
});

test("feedback keeps quotes, report coverage and version; decisions and analysis never rewrite original work", async (t) => {
  const { host, store, register, reference, task, created, artifact } =
    await fixture(t);
  await register();
  const original = store.task(task.id);
  await handleDeliveryCommand(host, {
    type: "delivery.addFeedback",
    ...reference(),
    kind: "url",
    quote: "这一段的步骤没有讲清楚",
    location: "https://example.com/comments/1",
    observedAt: "2026-09-13T14:00:00Z",
    coverage: "一条用户评论，未取得全量评论",
  });
  await handleDeliveryCommand(host, {
    type: "delivery.addFeedback",
    ...reference(),
    kind: "report",
    quote: "用户导入的报告说明",
    reportSourceId: task.sources[0]!.id,
    observedAt: "2026-09-13T15:00:00Z",
    coverage: "导入的一页报告",
  });
  const record = deliverySnapshot(store).records[0]!;
  assert.equal(record.feedback[0]!.decision, "pending");
  assert.match(record.feedback[0]!.coverage, /未抓取网页/);
  assert.match(record.feedback[1]!.quote, /获准材料原文/);
  await handleDeliveryCommand(host, {
    type: "delivery.reviewFeedback",
    ...reference(),
    feedbackIds: record.feedback.map((feedback) => feedback.id),
  });
  assert.equal(created[0]!.isolatedContext, true);
  assert.match(created[0]!.goal, /少数意见/);
  assert.equal(created[0]!.sources!.length, 3);
  await handleDeliveryCommand(host, {
    type: "delivery.decideFeedback",
    ...reference(),
    feedbackId: record.feedback[0]!.id,
    decision: "accepted",
    note: "只修订本作品的第二段，不升级全频道标准",
  });
  assert.deepEqual(store.task(task.id), original);
  assert.equal(deliverySnapshot(store).records[0]!.artifactHash, artifact.hash);
  assert.match(
    deliveryMarkdown(deliverySnapshot(store).records[0]!),
    /只修订本作品/,
  );
});

test("only the registered dedicated feedback file accepts approved feedback, with idempotent append", async (t) => {
  const { host, store, task, register, reference } = await fixture(t);
  const { aiRoot, codeRoot } = store.settings();
  await bootstrapSystem(aiRoot, codeRoot);
  const initialized = await initializeProject(aiRoot, codeRoot, {
    id: "deliverysample",
    name: "Delivery Sample",
    series: "y",
    description: "临时测试独立反馈入口",
  });
  store.updateTask(task.id, (current) => {
    current.projectId = initialized.project.id;
  });
  await register();
  await handleDeliveryCommand(host, {
    type: "delivery.addFeedback",
    ...reference(),
    kind: "text",
    quote: "步骤二与实际入口不一致",
    observedAt: now(),
    coverage: "一名用户的一次操作",
  });
  const feedback = deliverySnapshot(store).records[0]!.feedback[0]!;
  await assert.rejects(
    handleDeliveryCommand(host, {
      type: "delivery.writeFeedback",
      ...reference(),
      feedbackId: feedback.id,
    }),
    /先明确采纳/,
  );
  await handleDeliveryCommand(host, {
    type: "delivery.decideFeedback",
    ...reference(),
    feedbackId: feedback.id,
    decision: "accepted",
    note: "本版本说明需要修订，先给开发工具作为反馈",
  });
  const target = initialized.project.documents.external_ai_writeback!;
  const formal = initialized.project.documents.product!;
  const originalFormal = await fs.readFile(formal, "utf8");
  const command = {
    type: "delivery.writeFeedback" as const,
    ...reference(),
    feedbackId: feedback.id,
  };
  await Promise.all([
    handleDeliveryCommand(host, command),
    handleDeliveryCommand(host, command),
  ]);
  assert.equal(
    (await fs.readFile(target, "utf8")).split("步骤二与实际入口不一致").length -
      1,
    1,
  );
  assert.equal(await fs.readFile(formal, "utf8"), originalFormal);
  assert.throws(() =>
    deliveryCommandSchema.parse({ ...command, path: formal }),
  );
});

test("registration rejects external file changes and command validation rejects false dates and private URLs", async (t) => {
  const { host, artifact, registration } = await fixture(t);
  await fs.writeFile(artifact.path, "外部修改不能伪装成原版本");
  await assert.rejects(handleDeliveryCommand(host, registration), /已改变/);
  assert.throws(() =>
    deliveryCommandSchema.parse({
      ...registration,
      spec: {
        recipient: "工具",
        goal: "交付",
        criteria: "完成",
        missing: "",
        plannedDate: "2026-02-30",
      },
    }),
  );
  assert.throws(() =>
    deliveryCommandSchema.parse({
      type: "delivery.addFeedback",
      requestId: uid(),
      deliveryId: uid(),
      expectedRevision: 1,
      kind: "url",
      quote: "片段",
      location: "http://127.0.0.1/private",
      observedAt: now(),
      coverage: "用户说明",
    }),
  );
});
