import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { Store, uid, now } from "../src/core/store.js";
import {
  writeArtifact,
  recoverArtifacts,
  hydrateArtifact,
  hydrateArtifactSync,
  readOwnedArtifact,
  readOwnedArtifactSync,
  ensureOwnedDirectory,
  hash,
} from "../src/core/files.js";
import type { Task } from "../src/shared/types.js";
async function setup(t: { after(fn: () => unknown): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ytriple-files-"));
  const store = new Store(path.join(root, "data"));
  const task: Task = {
    id: uid(),
    title: "合成测试",
    goal: "比较阅读方式",
    goalVersion: 1,
    kind: "research",
    member: "coordinator",
    workspace: path.join(root, "work"),
    status: "idle",
    createdAt: now(),
    updatedAt: now(),
    messages: [],
    events: [],
    sources: [],
    artifacts: [],
  };
  store.saveTask(task);
  t.after(() => {
    store.close();
    return fs.rm(root, { recursive: true, force: true });
  });
  return { root, store, task };
}
test("文档修订保留版本、拒绝覆盖外部改动与过期目标", async (t) => {
  const { store, task } = await setup(t);
  const a = await writeArtifact(store, task.id, {
    title: "结论",
    format: "md",
    content: "第一版",
    goalVersion: 1,
  });
  const b = await writeArtifact(store, task.id, {
    title: "结论",
    format: "md",
    content: "第二版",
    goalVersion: 1,
    artifactId: a.id,
    expectedHash: a.hash,
  });
  assert.equal(b.version, 2);
  assert.equal(b.versions.length, 2);
  assert.equal(await fs.readFile(b.versions[0]!.path, "utf8"), "第一版");
  await fs.writeFile(a.path, "用户在编辑器里的修改");
  await assert.rejects(
    writeArtifact(store, task.id, {
      title: "结论",
      format: "md",
      content: "覆盖",
      goalVersion: 1,
      artifactId: a.id,
      expectedHash: b.hash,
    }),
    /修改/,
  );
  store.updateTask(task.id, (current) => {
    current.goalVersion = 2;
  });
  await assert.rejects(
    writeArtifact(store, task.id, {
      title: "旧目标",
      format: "md",
      content: "迟到结果",
      goalVersion: 1,
    }),
    /目标/,
  );
  assert.equal(await fs.readFile(a.path, "utf8"), "用户在编辑器里的修改");
});
test("相同工具操作恢复只产生一个成果；已修订的当前内容会回读", async (t) => {
  const { store, task } = await setup(t);
  const input = {
    title: "记录",
    format: "md" as const,
    content: "第一次",
    goalVersion: 1,
    operationId: "task:tool-1",
  };
  const a = await writeArtifact(store, task.id, input);
  const b = await writeArtifact(store, task.id, input);
  assert.equal(a.id, b.id);
  assert.equal(store.task(task.id).artifacts.length, 1);
  await writeArtifact(store, task.id, {
    ...input,
    content: "手动修订",
    artifactId: a.id,
    expectedHash: a.hash,
    operationId: "manual-2",
  });
  assert.equal(
    (await writeArtifact(store, task.id, input)).content,
    "手动修订",
  );
});
test("进程在文件提交后中断，可重建数据库成果记录", async (t) => {
  const { store, task } = await setup(t);
  const artifact = await writeArtifact(store, task.id, {
    title: "恢复",
    format: "md",
    content: "已写入",
    goalVersion: 1,
    operationId: "crash-1",
  });
  store.updateTask(task.id, (task) => {
    task.artifacts = [];
  });
  store.operation("crash-1", task.id, { state: "prepared", artifact });
  await recoverArtifacts(store);
  assert.equal(store.task(task.id).artifacts.length, 1);
  assert.equal(store.getOperation("crash-1")!.data.state, "committed");
  await recoverArtifacts(store);
  assert.equal(store.task(task.id).artifacts.length, 1);
});
test("成果路径被替换为符号链接时不读取目标内容", async (t) => {
  const { root, store, task } = await setup(t);
  const a = await writeArtifact(store, task.id, {
    title: "记录",
    format: "md",
    content: "正常",
    goalVersion: 1,
  });
  const other = path.join(root, "private.txt");
  await fs.writeFile(other, "不得读取的内容");
  await fs.rm(a.path);
  await fs.symlink(other, a.path);
  const hydrated = await hydrateArtifact(
    { ...a, content: undefined },
    task.workspace,
  );
  assert.equal(hydrated.content, undefined);
  assert.ok(hydrated.readError);
  await assert.rejects(
    writeArtifact(store, task.id, {
      title: "记录",
      format: "md",
      content: "修改",
      goalVersion: 1,
      artifactId: a.id,
      expectedHash: hash("正常"),
    }),
  );
  assert.equal(await fs.readFile(other, "utf8"), "不得读取的内容");
});
test("数据库重开保留任务并将运行中状态恢复为暂停", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ytriple-reopen-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = new Store(root);
  const id = uid();
  first.saveTask({
    id,
    title: "恢复",
    goal: "合成目标",
    goalVersion: 1,
    kind: "research",
    member: "coordinator",
    workspace: path.join(root, "work"),
    status: "running",
    createdAt: now(),
    updatedAt: now(),
    messages: [],
    events: [],
    sources: [],
    artifacts: [],
  });
  first.close();
  const second = new Store(root);
  assert.equal(second.task(id).status, "paused");
  assert.ok(second.task(id).events.some((e) => e.type === "recovered"));
  second.close();
});

test("刷新外部修改只读返回实际 hash；修订保存独立保留外部版本", async (t) => {
  const { store, task } = await setup(t);
  const a = await writeArtifact(store, task.id, {
    title: "外部编辑",
    format: "md",
    content: "原始版本",
    goalVersion: 1,
  });
  await fs.writeFile(a.path, "用户在外部编辑器里的版本");
  const observed = await hydrateArtifact(a, task.workspace);
  assert.equal(observed.hash, hash("用户在外部编辑器里的版本"));
  assert.equal(hydrateArtifactSync(a, task.workspace).hash, observed.hash);
  assert.equal(store.task(task.id).artifacts[0]!.hash, a.hash);
  assert.equal(store.task(task.id).artifacts[0]!.versions.length, 1);
  const saved = await writeArtifact(store, task.id, {
    title: a.title,
    format: "md",
    content: "审阅后继续修订",
    goalVersion: 1,
    artifactId: a.id,
    expectedHash: observed.hash,
  });
  assert.equal(saved.version, 3);
  assert.equal(saved.versions.length, 3);
  assert.deepEqual(
    await Promise.all(saved.versions.map((v) => fs.readFile(v.path, "utf8"))),
    ["原始版本", "用户在外部编辑器里的版本", "审阅后继续修订"],
  );
  assert.match(saved.versions[1]!.summary, /外部修改/);
});

test("外部文件再次改变后，刷新过的旧 hash 仍不能覆盖新修改", async (t) => {
  const { store, task } = await setup(t);
  const a = await writeArtifact(store, task.id, {
    title: "冲突",
    format: "md",
    content: "初始",
    goalVersion: 1,
  });
  await fs.writeFile(a.path, "第一次外部修改");
  const observed = await hydrateArtifact(a, task.workspace);
  await fs.writeFile(a.path, "第二次外部修改");
  await assert.rejects(
    writeArtifact(store, task.id, {
      title: a.title,
      format: "md",
      content: "过时覆盖",
      goalVersion: 1,
      artifactId: a.id,
      expectedHash: observed.hash,
    }),
    /修改/,
  );
  assert.equal(await fs.readFile(a.path, "utf8"), "第二次外部修改");
  assert.equal(store.task(task.id).artifacts[0]!.version, 1);
});

test("工作目录整体被替换为符号链接后，快照与同步模型读取均拒绝外部文件", async (t) => {
  const { root, store, task } = await setup(t);
  const a = await writeArtifact(store, task.id, {
    title: "路径",
    format: "md",
    content: "允许内容",
    goalVersion: 1,
  });
  await fs.rename(task.workspace, task.workspace + "-old");
  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, path.basename(a.path)), "合成私有内容");
  await fs.symlink(outside, task.workspace);
  assert.equal((await hydrateArtifact(a, task.workspace)).content, undefined);
  assert.equal(hydrateArtifactSync(a, task.workspace).content, undefined);
  await assert.rejects(readOwnedArtifact(a, task.workspace));
  assert.throws(() => readOwnedArtifactSync(a, task.workspace));
  await assert.rejects(
    writeArtifact(store, task.id, {
      title: a.title,
      format: "md",
      content: "禁止写入",
      goalVersion: 1,
      artifactId: a.id,
      expectedHash: a.hash,
    }),
    /符号链接/,
  );
  assert.equal(
    await fs.readFile(path.join(outside, path.basename(a.path)), "utf8"),
    "合成私有内容",
  );
});

test("工作目录的父级链接不能用于创建目录或读取替换文件", async (t) => {
  const { root, store, task } = await setup(t);
  const nested = path.join(root, "parent/work");
  store.updateTask(task.id, (current) => {
    current.workspace = nested;
  });
  const a = await writeArtifact(store, task.id, {
    title: "祖先路径",
    format: "md",
    content: "初始",
    goalVersion: 1,
  });
  await fs.rename(path.dirname(nested), path.join(root, "parent-original"));
  const outside = path.join(root, "outside-parent");
  await fs.mkdir(path.join(outside, "work"), { recursive: true });
  await fs.writeFile(
    path.join(outside, "work", path.basename(a.path)),
    "合成外部内容",
  );
  await fs.symlink(outside, path.join(root, "parent"));
  assert.equal((await hydrateArtifact(a, nested)).content, undefined);
  await assert.rejects(
    ensureOwnedDirectory(path.join(root, "parent/should-not-create")),
    /符号链接/,
  );
  await assert.rejects(fs.stat(path.join(outside, "should-not-create")));
});

test("恢复旧 prepared 操作不能让当前版本与历史倒退", async (t) => {
  const { store, task } = await setup(t);
  const a = await writeArtifact(store, task.id, {
    title: "恢复单调性",
    format: "md",
    content: "相同正文",
    goalVersion: 1,
    operationId: "old-pending",
  });
  store.operation("old-pending", task.id, { state: "prepared", artifact: a });
  const b = await writeArtifact(store, task.id, {
    title: a.title,
    format: "md",
    content: "中间正文",
    goalVersion: 1,
    artifactId: a.id,
    expectedHash: a.hash,
  });
  const c = await writeArtifact(store, task.id, {
    title: a.title,
    format: "md",
    content: "相同正文",
    goalVersion: 1,
    artifactId: a.id,
    expectedHash: b.hash,
  });
  await recoverArtifacts(store);
  const { content: _content, readError: _readError, ...savedMetadata } = c;
  assert.deepEqual(store.task(task.id).artifacts[0], savedMetadata);
  assert.equal(store.getOperation("old-pending")!.data.state, "superseded");
  await recoverArtifacts(store);
  assert.equal(store.task(task.id).artifacts[0]!.version, 3);
  assert.equal(store.task(task.id).artifacts[0]!.versions.length, 3);
});

test("恢复相同版本的旧记录也不替换当前标题及历史信息", async (t) => {
  const { store, task } = await setup(t);
  const a = await writeArtifact(store, task.id, {
    title: "初始标题",
    format: "md",
    content: "正文",
    goalVersion: 1,
    operationId: "same-revision",
  });
  store.operation("same-revision", task.id, { state: "prepared", artifact: a });
  store.updateTask(task.id, (current) => {
    current.artifacts[0]!.title = "用户修正标题";
    current.artifacts[0]!.versions[0]!.summary = "用户保留的历史备注";
  });
  await recoverArtifacts(store);
  assert.equal(store.task(task.id).artifacts[0]!.title, "用户修正标题");
  assert.equal(
    store.task(task.id).artifacts[0]!.versions[0]!.summary,
    "用户保留的历史备注",
  );
});
