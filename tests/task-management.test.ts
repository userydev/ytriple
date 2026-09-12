import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkbenchService } from "../src/core/service.js";
import { parseCommand } from "../src/desktop/commands.js";
import { decisionExcerpt } from "../src/workbench/decision-summary.js";

test("task rename, archive and recoverable deletion retain documents and cannot restart hidden work", async (t) => {
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
  snap = await service.execute({ type: "task.delete", taskId: task.id });
  assert.ok(snap.tasks[0]!.deletedAt);
  await assert.rejects(
    service.execute({ type: "task.send", taskId: task.id, text: "不能运行" }),
    /先恢复/,
  );
  assert.equal(await fs.readFile(saved.path, "utf8"), content);
  await service.close();
  service = new WorkbenchService(path.join(root, "data"), () => undefined);
  await service.initialize();
  snap = await service.execute({ type: "task.restore", taskId: task.id });
  assert.equal(snap.tasks[0]!.title, "新的工作名称");
  assert.equal(snap.tasks[0]!.deletedAt, undefined);
  assert.equal(snap.tasks[0]!.archivedAt, undefined);
  assert.equal(snap.tasks[0]!.artifacts[0]!.hash, saved.hash);
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
});

test("decision excerpt prefers explicit conclusion and never mutates the full report", () => {
  const body =
    "# 详细报告\n\n" +
    "展开背景与过程。".repeat(80) +
    "\n## 结论\n\n推荐先完成核心体验，再扩展外围能力。\n\n" +
    "详细依据。".repeat(90);
  const result = decisionExcerpt(body);
  assert.equal(result.text, "推荐先完成核心体验，再扩展外围能力。");
  assert.equal(result.detailed, true);
  assert.ok(body.includes("展开背景与过程。"));
  assert.deepEqual(decisionExcerpt("结论：可以直接使用。"), {
    text: "结论：可以直接使用。",
    detailed: false,
  });
});
