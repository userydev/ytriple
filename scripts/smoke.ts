/** Local integration acceptance. No model calls; all writes use disposable roots. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { WorkbenchService } from "../src/core/service.js";
import { writeArtifact } from "../src/core/files.js";
import { imageDocument } from "../src/core/exports.js";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "ytriple-smoke-"));
let service = new WorkbenchService(path.join(root, "data"), () => undefined);
try {
  let snapshot = await service.initialize();
  snapshot = await service.execute({
    type: "settings.save",
    settings: {
      ...snapshot.settings,
      aiRoot: path.join(root, "AI"),
      codeRoot: path.join(root, "Code"),
      workspaceRoot: path.join(root, "AI/knowledge/workspaces"),
    },
  });
  assert.equal(snapshot.system.state, "missing");
  snapshot = await service.execute({ type: "system.bootstrap" });
  assert.equal(snapshot.system.state, "ready");
  snapshot = await service.execute({
    type: "task.create",
    goal: "整理 8 人读书小组的产品想法并准备开发说明书。",
    kind: "project",
  });
  const task = snapshot.tasks[0]!;
  snapshot = await service.execute({
    type: "source.import.paths",
    taskId: task.id,
    paths: [path.resolve("fixtures/research-brief.md")],
  });
  assert.equal(snapshot.tasks[0]!.sources.length, 1);
  const version = service.store.task(task.id).goalVersion;
  const artifact = await writeArtifact(service.store, task.id, {
    title: "读书小组产品说明",
    content:
      "# 读书小组\n\n## 目标\n帮助 8 人小组整理阅读记录与待讨论问题。\n\n## 第一版\n- 记录一本书\n- 整理读书笔记\n- 汇总本周讨论主题\n\n## 验收\n记录保存后可以重新打开。",
    format: "md",
    goalVersion: version,
  });
  snapshot = await service.execute({
    type: "artifact.save",
    taskId: task.id,
    artifactId: artifact.id,
    expectedHash: artifact.hash,
    content: `${artifact.content}\n\n## 边界\n暂不加入付费与公开社区。`,
  });
  const updated = snapshot.tasks[0]!.artifacts[0]!;
  assert.equal(updated.version, 2);
  assert.ok(updated.content?.includes("付费"));
  await assert.rejects(
    service.execute({
      type: "artifact.save",
      taskId: task.id,
      artifactId: artifact.id,
      expectedHash: artifact.hash,
      content: "过时覆盖",
    }),
    /修改/,
  );
  snapshot = await service.execute({
    type: "artifact.export",
    taskId: task.id,
    artifactId: artifact.id,
    format: "pptx",
  });
  const pptx = snapshot.tasks[0]!.artifacts.find((a) => a.format === "pptx")!;
  assert.equal((await fs.readFile(pptx.path)).subarray(0, 2).toString(), "PK");
  assert.match(imageDocument(updated), /Content-Security-Policy/);
  snapshot = await service.execute({
    type: "project.initialize",
    input: {
      id: "reading-circle",
      name: "读书小组",
      series: "y",
      description:
        "一个供 8 人读书小组整理阅读记录、问题与讨论主题的本地工具。",
      taskId: task.id,
    },
  });
  const project = snapshot.projects.find((p) => p.id === "reading-circle")!;
  assert.ok(project?.devPath);
  assert.ok(
    (
      await fs.readFile(path.join(project.devPath, "README.md"), "utf8")
    ).includes("读书小组"),
  );
  await service.close();
  service = new WorkbenchService(path.join(root, "data"), () => undefined);
  snapshot = await service.initialize();
  assert.equal(snapshot.tasks.length, 1);
  assert.equal(snapshot.tasks[0]!.artifacts.length, 2);
  assert.equal(snapshot.projects.length, 1);
  console.log(
    "PASS: 新机器规则创建 → 建立任务 → 导入真实 MD → 保存与冲突检查 → PPTX 文件 → 项目 main/dev → 重开接续",
  );
  console.log("所有写入均在临时目录；无模型请求、无真实项目新增。");
} finally {
  await service.close();
  await fs.rm(root, { recursive: true, force: true });
}
