import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkbenchService } from "../src/core/service.js";
import { parseCommand } from "../src/desktop/commands.js";
import { Store } from "../src/core/store.js";
import { createServer, type ServerResponse } from "node:http";
import { decisionExcerpt } from "../src/workbench/decision-summary.js";

test("task archive is recoverable but permanent deletion removes the conversation and retains independent documents", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ytriple-task-menu-"));
  let service = new WorkbenchService(path.join(root, "data"), () => undefined);
  t.after(async () => {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  service.store.setConfig("settings", {
    ...service.store.settings(),
    aiRoot: path.join(root, "AI"),
    codeRoot: path.join(root, "Code"),
    workspaceRoot: path.join(root, "work"),
    projectMonitoring: false,
  });
  await service.initialize();
  let snap = await service.execute({
    type: "task.create",
    goal: "合成任务保留成果",
  });
  const task = snap.tasks[0]!;
  const content = "# 完整分析\n\n" + "这份正文需要完整保留。\n".repeat(70);
  service.store.updateTask(task.id, (task) => {
    task.status = "completed";
    task.messages.push({
      id: "reply-1",
      role: "assistant",
      member: "coordinator",
      content,
      createdAt: new Date().toISOString(),
      goalVersion: 1,
    });
  });
  snap = await service.execute(
    parseCommand({
      type: "message.save",
      taskId: task.id,
      messageId: "reply-1",
    }),
  );
  const saved = snap.tasks[0]!.artifacts[0]!;
  assert.equal(saved.content, content);
  await Promise.all([
    service.execute({
      type: "message.save",
      taskId: task.id,
      messageId: "reply-1",
    }),
    service.execute({
      type: "message.save",
      taskId: task.id,
      messageId: "reply-1",
    }),
  ]);
  assert.equal(service.store.task(task.id).artifacts.length, 1);
  await service.execute({
    type: "task.rename",
    taskId: task.id,
    title: "新的工作名称",
  });
  await service.execute({ type: "task.archive", taskId: task.id });
  await assert.rejects(
    service.execute({ type: "task.run", taskId: task.id }),
    /先恢复/,
  );
  await service.execute({ type: "task.restore", taskId: task.id });
  service.store.saveCheckpoint(task.id, { synthetic: "private checkpoint" });
  const lib = await service.execute({
    type: "library.collect",
    taskId: task.id,
    artifactId: saved.id,
    expectedHash: saved.hash,
  });
  const collected = lib.library![0]!;
  assert.equal(await fs.readFile(collected.path, "utf8"), content);
  service.store.updateTask(task.id, (task) => {
    task.projectId = "already-linked";
  });
  await assert.rejects(
    service.execute({
      type: "project.initialize",
      input: {
        id: "another",
        name: "不应重复初始化",
        series: "y",
        description: "test",
        taskId: task.id,
      },
    }),
    /已经关联项目/,
  );
  snap = await service.execute({ type: "task.delete", taskId: task.id });
  assert.equal(snap.tasks.length, 0);
  assert.equal(service.store.checkpoint(task.id), undefined);
  assert.equal(
    service.store.operations().filter((item) => item.taskId === task.id).length,
    0,
  );
  assert.throws(() => service.store.task(task.id), /找不到/);
  await assert.rejects(
    service.execute({ type: "task.restore", taskId: task.id }),
    /找不到/,
  );
  await assert.rejects(
    service.execute({ type: "task.send", taskId: task.id, text: "不能运行" }),
    /找不到/,
  );
  assert.equal(await fs.readFile(saved.path, "utf8"), content);
  assert.equal(await fs.readFile(collected.path, "utf8"), content);
  await service.close();
  service = new WorkbenchService(path.join(root, "data"), () => undefined);
  snap = await service.initialize();
  assert.equal(snap.tasks.length, 0);
  assert.equal(snap.library![0]!.hash, collected.hash);
  assert.throws(() => service.store.saveTask(task), /永久删除/);
  assert.throws(
    () => service.store.saveCheckpoint(task.id, { late: true }),
    /找不到/,
  );
  assert.throws(
    () => service.store.operation("late-operation", task.id, { late: true }),
    /找不到/,
  );
  assert.equal(service.store.tasks().length, 0);
  assert.equal(service.store.operations().length, 0);
});

test("decision excerpt prefers explicit conclusion and never mutates the full report", () => {
  const body =
    "# 详细报告\n\n" +
    "展开背景与过程。".repeat(80) +
    "\n## 结论\n\n推荐先完成核心体验，再扩展外围能力。\n\n" +
    "详细依据。".repeat(90);
  const result = decisionExcerpt(body);
  assert.match(result.text, /推荐先完成核心体验，再扩展外围能力。/);
  assert.equal(result.detailed, false);
  assert.ok(body.includes("展开背景与过程。"));
  assert.deepEqual(decisionExcerpt("结论：可以直接使用。"), {
    text: "结论：可以直接使用。",
    detailed: false,
  });
});

function temporarySettings(service: WorkbenchService, root: string) {
  service.store.setConfig("settings", {
    ...service.store.settings(),
    aiRoot: path.join(root, "AI"),
    codeRoot: path.join(root, "Code"),
    workspaceRoot: path.join(root, "work"),
    projectMonitoring: false,
  });
}

test("legacy deleted conversations are permanently removed while archive records and independent assets remain", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ytriple-legacy-deleted-"),
  );
  let service = new WorkbenchService(root, () => undefined);
  t.after(async () => {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  temporarySettings(service, root);
  await service.initialize();
  const deleted = (
    await service.execute({ type: "task.create", goal: "旧版已删除的会话" })
  ).tasks[0]!;
  service.store.updateTask(deleted.id, (current) => {
    current.messages.push({
      id: "legacy-reply",
      role: "assistant",
      member: "coordinator",
      content: "# 已另存的独立成果\n\n应在会话删除后保留。",
      createdAt: current.updatedAt,
      goalVersion: current.goalVersion,
    });
  });
  const saved = (
    await service.execute({
      type: "message.save",
      taskId: deleted.id,
      messageId: "legacy-reply",
    })
  ).tasks.find((task) => task.id === deleted.id)!.artifacts[0]!;
  const collected = (
    await service.execute({
      type: "library.collect",
      taskId: deleted.id,
      artifactId: saved.id,
      expectedHash: saved.hash,
    })
  ).library![0]!;
  service.store.saveCheckpoint(deleted.id, { private: "deleted checkpoint" });
  service.store.updateTask(deleted.id, (current) => {
    current.archivedAt = "2026-09-11T12:00:00.000Z";
    current.deletedAt = "2026-09-11T12:01:00.000Z";
  });
  const archived = (
    await service.execute({
      type: "task.create",
      goal: "只有归档才保留恢复能力",
    })
  ).tasks.find((task) => task.id !== deleted.id)!;
  await service.execute({ type: "task.archive", taskId: archived.id });
  service.store.saveCheckpoint(archived.id, {
    retained: "archived checkpoint",
  });
  service.store.operation("archived-operation", archived.id, {
    state: "committed",
    retained: true,
  });
  const originalArchive = service.store.task(archived.id);
  await service.close();
  service = new WorkbenchService(root, () => undefined);
  const snapshot = await service.initialize();
  assert.deepEqual(
    snapshot.tasks.map((task) => task.id),
    [archived.id],
  );
  assert.equal(snapshot.tasks[0]!.archivedAt, originalArchive.archivedAt);
  assert.deepEqual(snapshot.tasks[0]!.messages, originalArchive.messages);
  assert.deepEqual(snapshot.tasks[0]!.events, originalArchive.events);
  assert.equal(service.store.checkpoint(deleted.id), undefined);
  assert.deepEqual(service.store.checkpoint(archived.id), {
    retained: "archived checkpoint",
  });
  assert.equal(
    service.store
      .operations()
      .some((operation) => operation.taskId === deleted.id),
    false,
  );
  assert.ok(service.store.getOperation("archived-operation"));
  assert.throws(() => service.store.saveTask(deleted), /永久删除/);
  await assert.rejects(
    service.execute({ type: "task.restore", taskId: deleted.id }),
    /找不到/,
  );
  assert.equal(await fs.readFile(saved.path, "utf8"), saved.content);
  assert.equal(await fs.readFile(collected.path, "utf8"), collected.content);
  assert.equal(snapshot.library![0]!.id, collected.id);
  const restored = await service.execute({
    type: "task.restore",
    taskId: archived.id,
  });
  assert.equal(restored.tasks[0]!.archivedAt, undefined);
  assert.equal(restored.tasks[0]!.messages[0]!.content, archived.goal);
});

test("deletion waits for concurrent document saves, removes all journals, and rejects further commands", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ytriple-delete-save-"));
  const service = new WorkbenchService(
    path.join(root, "data"),
    () => undefined,
  );
  t.after(async () => {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  temporarySettings(service, root);
  await service.initialize();
  const task = (
    await service.execute({ type: "task.create", goal: "并发保存合成验收" })
  ).tasks[0]!;
  service.store.updateTask(task.id, (current) => {
    current.messages.push({
      id: "long-reply",
      role: "assistant",
      member: "coordinator",
      content: "# 另存的答复\n\n完整内容应保留。",
      createdAt: current.updatedAt,
      goalVersion: 1,
    });
    current.events.push({
      id: "public-progress",
      type: "progress_reported",
      summary: "公开进度应能另存。",
      member: "researcher",
      goalVersion: 1,
      createdAt: current.updatedAt,
      data: { stage: "finding" },
    });
  });
  const message = service.execute({
    type: "message.save",
    taskId: task.id,
    messageId: "long-reply",
  });
  const process = service.execute({ type: "process.save", taskId: task.id });
  const deletion = service.execute({ type: "task.delete", taskId: task.id });
  await assert.rejects(
    service.execute({
      type: "task.send",
      taskId: task.id,
      text: "不能在删除时重新运行",
    }),
    /正在永久删除/,
  );
  const results = await Promise.allSettled([message, process, deletion]);
  assert.ok(
    results.every((result) => result.status === "fulfilled"),
    JSON.stringify(results),
  );
  assert.equal(service.store.tasks().length, 0);
  assert.equal(service.store.operations().length, 0);
  const files = (await fs.readdir(task.workspace)).filter((file) =>
    file.endsWith(".md"),
  );
  assert.equal(files.length, 2);
  const text = (
    await Promise.all(
      files.map((file) => fs.readFile(path.join(task.workspace, file), "utf8")),
    )
  ).join("\n");
  assert.match(text, /完整内容应保留/);
  assert.match(text, /公开进度应能另存/);
  await assert.rejects(
    service.execute({
      type: "message.save",
      taskId: task.id,
      messageId: "long-reply",
    }),
    /找不到/,
  );
  const reopened = new Store(path.join(root, "data"));
  try {
    assert.equal(reopened.tasks().length, 0);
    assert.equal(reopened.operations().length, 0);
  } finally {
    reopened.close();
  }
});

test("deleting a running model task cancels its request and late responses cannot resurrect it", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ytriple-delete-running-"),
  );
  let arrive!: () => void;
  const requested = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  let response: ServerResponse | undefined;
  const server = createServer(async (request, reply) => {
    for await (const _ of request) {
      /* Drain the synthetic request only. */
    }
    response = reply;
    arrive();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const service = new WorkbenchService(root, () => "synthetic-key");
  t.after(async () => {
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });
  temporarySettings(service, root);
  service.store.setConfig("profiles", [
    {
      id: "synthetic",
      name: "本地测试替身",
      protocol: "openai",
      provider: "compatible",
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      modelId: "synthetic",
      apiKeyEnv: "SYNTHETIC_KEY",
      hasKey: true,
      status: "ready",
      capabilities: { text: true, tools: true, streaming: false },
    },
  ]);
  service.store.setConfig("settings", {
    ...service.store.settings(),
    defaultProfileId: "synthetic",
    memberProfiles: {
      coordinator: "synthetic",
      researcher: "synthetic",
      cto: "synthetic",
    },
  });
  await service.initialize();
  const task = (
    await service.execute({ type: "task.create", goal: "只发一个本地合成请求" })
  ).tasks[0]!;
  await service.execute({ type: "task.run", taskId: task.id });
  await requested;
  assert.equal(service.runtime.isRunning(task.id), true);
  await service.execute({ type: "task.delete", taskId: task.id });
  assert.equal(service.runtime.isRunning(task.id), false);
  response?.end(
    JSON.stringify({
      id: "late",
      choices: [
        {
          message: { role: "assistant", content: "迟到的答复" },
          finish_reason: "stop",
          index: 0,
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(service.store.tasks().length, 0);
  assert.equal(service.store.checkpoint(task.id), undefined);
  assert.equal(service.store.operations().length, 0);
  const reopened = new Store(root);
  try {
    assert.equal(reopened.tasks().length, 0);
    assert.equal(reopened.checkpoint(task.id), undefined);
  } finally {
    reopened.close();
  }
});

test("quitting during deletion finishes the record transaction before closing storage", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ytriple-delete-close-"),
  );
  let service = new WorkbenchService(root, () => undefined);
  t.after(async () => {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  temporarySettings(service, root);
  await service.initialize();
  const task = (
    await service.execute({ type: "task.create", goal: "退出时删除合成会话" })
  ).tasks[0]!;
  service.store.saveCheckpoint(task.id, { private: "synthetic checkpoint" });
  const deletion = service
    .execute({ type: "task.delete", taskId: task.id })
    .catch((error) => error);
  await service.close();
  await deletion;
  service = new WorkbenchService(root, () => undefined);
  assert.equal((await service.initialize()).tasks.length, 0);
  assert.equal(service.store.checkpoint(task.id), undefined);
  assert.throws(() => service.store.saveTask(task), /永久删除/);
});
