import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { Store, uid, now } from "../src/core/store.js";
import { WorkbenchService } from "../src/core/service.js";
import {
  collectArtifact,
  libraryRoot,
  librarySource,
  listLibrary,
  readLibraryBytes,
  readLibraryEntry,
  recoverLibrary,
  saveLibraryEntry,
} from "../src/core/library.js";
import { hash, writeArtifact, writeArtifactData } from "../src/core/files.js";
import type { Artifact, Task } from "../src/shared/types.js";

async function setup(t: { after(fn: () => unknown): void }) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "ytriple-library-"));
  const root = await fs.realpath(temp),
    aiRoot = path.join(root, "AI");
  const store = new Store(path.join(root, "data"));
  store.setConfig("settings", {
    ...store.settings(),
    aiRoot,
    codeRoot: path.join(root, "Code"),
    workspaceRoot: path.join(root, "work"),
  });
  const task: Task = {
    id: uid(),
    title: "合成阅读方法研究",
    goal: "整理可复用阅读方法",
    goalVersion: 1,
    kind: "research",
    member: "coordinator",
    workspace: path.join(root, "work", "task"),
    status: "idle",
    createdAt: now(),
    updatedAt: now(),
    messages: [],
    events: [],
    sources: [],
    artifacts: [],
  };
  store.saveTask(task);
  t.after(async () => {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const artifact = await writeArtifact(store, task.id, {
    title: "阅读方法",
    format: "md",
    content: "# 阅读方法\n先提问，再阅读。",
    goalVersion: 1,
  });
  const collect = (a = artifact) =>
    collectArtifact(store, aiRoot, {
      type: "library.collect",
      taskId: task.id,
      artifactId: a.id,
      expectedHash: a.hash,
      tags: ["方法", "方法"],
      note: "可跨项目复用",
    });
  return { root, aiRoot, store, task, artifact, collect };
}

test("收藏是明确快照，保留来源；重复请求幂等且原成果保持原位", async (t) => {
  const { aiRoot, store, task, artifact, collect } = await setup(t);
  assert.equal(listLibrary(store, aiRoot).length, 0);
  const [first, second] = await Promise.all([collect(), collect()]);
  assert.equal(first.id, second.id);
  assert.equal(listLibrary(store, aiRoot).length, 1);
  assert.equal(first.content, artifact.content);
  assert.deepEqual(first.tags, ["方法"]);
  assert.deepEqual(first.source, {
    taskId: task.id,
    taskTitle: task.title,
    artifactId: artifact.id,
    artifactVersion: 1,
    artifactHash: artifact.hash,
    goalVersion: 1,
  });
  assert.equal(path.dirname(first.path), libraryRoot(aiRoot));
  assert.notEqual(first.path, artifact.path);
  assert.equal(await fs.readFile(artifact.path, "utf8"), artifact.content);
  const updated = await saveLibraryEntry(store, aiRoot, {
    type: "library.save",
    entryId: first.id,
    content: "收藏自己的加工结果",
    expectedHash: first.hash,
  });
  const again = await collect();
  assert.equal(again.id, first.id);
  assert.equal(again.hash, updated.hash);
  assert.equal(again.content, "收藏自己的加工结果");
  assert.equal(await fs.readFile(artifact.path, "utf8"), artifact.content);
});

test("编辑收藏保留版本、刷新可观察外部修改但不能以旧 hash 覆盖", async (t) => {
  const { aiRoot, store, artifact, collect } = await setup(t),
    first = await collect();
  const second = await saveLibraryEntry(store, aiRoot, {
    type: "library.save",
    entryId: first.id,
    expectedHash: first.hash,
    content: "第二版",
    title: "精炼阅读方法",
    tags: ["学习"],
  });
  assert.equal(second.version, 2);
  assert.equal(second.title, "精炼阅读方法");
  assert.deepEqual(
    await Promise.all(
      second.versions.map((version) => fs.readFile(version.path, "utf8")),
    ),
    [artifact.content, "第二版"],
  );
  await fs.writeFile(second.path, "外部编辑器修改");
  await assert.rejects(
    saveLibraryEntry(store, aiRoot, {
      type: "library.save",
      entryId: first.id,
      expectedHash: second.hash,
      content: "禁止覆盖",
    }),
    /修改/,
  );
  const observed = readLibraryEntry(store, aiRoot, first.id);
  assert.equal(observed.hash, hash("外部编辑器修改"));
  assert.equal(store.libraryEntry(aiRoot, first.id).hash, second.hash);
  const fourth = await saveLibraryEntry(store, aiRoot, {
    type: "library.save",
    entryId: first.id,
    expectedHash: observed.hash,
    content: "看过外部版本后继续编辑",
  });
  assert.equal(fourth.version, 4);
  assert.deepEqual(
    await Promise.all(
      fourth.versions.map((version) => fs.readFile(version.path, "utf8")),
    ),
    [artifact.content, "第二版", "外部编辑器修改", "看过外部版本后继续编辑"],
  );
});

test("重新收藏原成果的新版本生成新快照；旧选择不允许误收藏新字节", async (t) => {
  const { store, task, artifact, collect } = await setup(t),
    original = await collect();
  const next = await writeArtifact(store, task.id, {
    title: artifact.title,
    format: "md",
    content: "原文档新版本",
    goalVersion: 1,
    artifactId: artifact.id,
    expectedHash: artifact.hash,
  });
  await assert.rejects(collect(), /成果已改变/);
  const newer = await collect(next);
  assert.notEqual(newer.id, original.id);
  assert.equal(newer.source.artifactVersion, 2);
  assert.equal(await fs.readFile(original.path, "utf8"), artifact.content);
});

test("真实 Lib 正文作为新资料，媒体复用仅是明确未解析的引用", async (t) => {
  const { aiRoot, store, task, artifact, collect } = await setup(t),
    entry = await collect();
  const source = librarySource(store, aiRoot, entry.id);
  assert.equal(source.text, artifact.content);
  assert.equal(source.location, entry.path);
  assert.match(source.coverage, new RegExp(task.id));
  assert.match(source.coverage, /收藏版本 1/);
  for (const format of ["png", "pptx"] as const) {
    const media = await writeArtifactData(store, task.id, {
      title: "媒体合成文件",
      format,
      content: Buffer.from("synthetic media bytes"),
      goalVersion: 1,
    });
    const saved = await collect(media),
      mediaSource = librarySource(store, aiRoot, saved.id);
    assert.equal(saved.content, undefined);
    assert.match(mediaSource.text, /尚未解析/);
    assert.match(mediaSource.coverage, /仅媒体引用/);
    assert.ok(!mediaSource.text.includes("synthetic media bytes"));
    await assert.rejects(
      saveLibraryEntry(store, aiRoot, {
        type: "library.save",
        entryId: saved.id,
        content: "假文本",
        expectedHash: saved.hash,
      }),
      /不能直接文本编辑/,
    );
  }
});

test("收藏拒绝未知 ID、越界成果和符号链接，不读外部内容", async (t) => {
  const { root, aiRoot, store, task, artifact, collect } = await setup(t);
  await assert.rejects(
    collectArtifact(store, aiRoot, {
      type: "library.collect",
      taskId: task.id,
      artifactId: "unknown",
      expectedHash: artifact.hash,
    }),
    /找不到/,
  );
  const outside = path.join(root, "outside.md");
  await fs.writeFile(outside, "合成私有内容");
  store.updateTask(task.id, (current) => {
    current.artifacts[0]!.path = outside;
  });
  await assert.rejects(collect(), /路径/);
  store.updateTask(task.id, (current) => {
    current.artifacts[0]!.path = artifact.path;
  });
  await fs.rm(artifact.path);
  await fs.symlink(outside, artifact.path);
  await assert.rejects(collect());
  assert.equal(await fs.readFile(outside, "utf8"), "合成私有内容");
});

test("Lib 文件或父目录被替换为链接后，读、写、复用都拒绝", async (t) => {
  const { root, aiRoot, store, collect } = await setup(t),
    entry = await collect();
  const outside = path.join(root, "private.md");
  await fs.writeFile(outside, "私有合成文本");
  await fs.rename(entry.path, entry.path + ".old");
  await fs.symlink(outside, entry.path);
  assert.equal(readLibraryEntry(store, aiRoot, entry.id).content, undefined);
  assert.ok(readLibraryEntry(store, aiRoot, entry.id).readError);
  assert.throws(() => readLibraryBytes(store, aiRoot, entry.id));
  assert.throws(() => librarySource(store, aiRoot, entry.id));
  await assert.rejects(
    saveLibraryEntry(store, aiRoot, {
      type: "library.save",
      entryId: entry.id,
      content: "不能写入",
      expectedHash: entry.hash,
    }),
  );
  await fs.rm(entry.path);
  await fs.rename(entry.path + ".old", entry.path);
  const former = libraryRoot(aiRoot) + "-old",
    replacement = path.join(root, "replacement");
  await fs.rename(libraryRoot(aiRoot), former);
  await fs.mkdir(replacement);
  await fs.writeFile(
    path.join(replacement, path.basename(entry.path)),
    "同名外部文件",
  );
  await fs.symlink(replacement, libraryRoot(aiRoot));
  assert.ok(readLibraryEntry(store, aiRoot, entry.id).readError);
  await assert.rejects(collect(), /符号链接|ELOOP/);
  assert.equal(
    await fs.readFile(
      path.join(replacement, path.basename(entry.path)),
      "utf8",
    ),
    "同名外部文件",
  );
});

test("切换 AI 根隔离收藏，切回恢复原索引且不触碰旧根", async (t) => {
  const { root, aiRoot, store, collect } = await setup(t),
    entry = await collect();
  const secondRoot = path.join(root, "AI-second");
  store.setConfig("settings", { ...store.settings(), aiRoot: secondRoot });
  assert.deepEqual(listLibrary(store, secondRoot), []);
  assert.throws(() => readLibraryBytes(store, aiRoot, entry.id), /已切换/);
  assert.throws(() => readLibraryBytes(store, secondRoot, entry.id), /找不到/);
  await assert.rejects(
    saveLibraryEntry(store, secondRoot, {
      type: "library.save",
      entryId: entry.id,
      content: "不能修改旧根",
      expectedHash: entry.hash,
    }),
    /找不到/,
  );
  await recoverLibrary(store, secondRoot);
  store.setConfig("settings", { ...store.settings(), aiRoot });
  assert.equal(listLibrary(store, aiRoot)[0]!.id, entry.id);
  assert.equal(await fs.readFile(entry.path, "utf8"), entry.content);
});

test("并发编辑只提交一个版本，处理中切换根不会继续写入旧收藏", async (t) => {
  const { root, aiRoot, store, collect } = await setup(t),
    entry = await collect();
  const results = await Promise.allSettled(
    ["并发版本 A", "并发版本 B"].map((content) =>
      saveLibraryEntry(store, aiRoot, {
        type: "library.save",
        entryId: entry.id,
        expectedHash: entry.hash,
        content,
      }),
    ),
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.filter((result) => result.status === "rejected").length,
    1,
  );
  const saved = readLibraryEntry(store, aiRoot, entry.id);
  assert.equal(saved.version, 2);
  const pending = saveLibraryEntry(store, aiRoot, {
    type: "library.save",
    entryId: entry.id,
    expectedHash: saved.hash,
    content: "切换根后的旧请求",
  });
  store.setConfig("settings", {
    ...store.settings(),
    aiRoot: path.join(root, "next-AI"),
  });
  await assert.rejects(pending, /目录已切换/);
  assert.equal(await fs.readFile(entry.path, "utf8"), saved.content);
});

test("恢复日志按 AI 根隔离，切换根不恢复另一根的中断记录", async (t) => {
  const { root, aiRoot, store, collect } = await setup(t),
    entry = await collect();
  const op = store.libraryOperations(aiRoot)[0]!;
  store.db.prepare("DELETE FROM library_entries WHERE id=?").run(entry.id);
  store.libraryOperation(op.id, aiRoot, { ...op.data, state: "prepared" });
  const nextRoot = path.join(root, "next-AI");
  store.setConfig("settings", { ...store.settings(), aiRoot: nextRoot });
  await recoverLibrary(store, nextRoot);
  assert.equal(store.library(aiRoot).length, 0);
  assert.equal(store.libraryOperations(aiRoot)[0]!.data.state, "prepared");
  store.setConfig("settings", { ...store.settings(), aiRoot });
  await recoverLibrary(store, aiRoot);
  assert.equal(store.library(aiRoot)[0]!.id, entry.id);
});

test("重开数据库保留收藏；文件提交后中断可恢复且不回退新版本", async (t) => {
  const { aiRoot, store, collect } = await setup(t),
    entry = await collect();
  const op = store
    .libraryOperations(aiRoot)
    .find((record) => record.data.state === "committed")!;
  store.db.prepare("DELETE FROM library_entries WHERE id=?").run(entry.id);
  store.libraryOperation(op.id, aiRoot, { ...op.data, state: "prepared" });
  // A second Store models reopening persisted SQLite rather than using in-memory state.
  const reopened = new Store(store.dataPath);
  try {
    await recoverLibrary(reopened, aiRoot);
    assert.equal(reopened.libraryEntry(aiRoot, entry.id).id, entry.id);
    assert.equal(
      readLibraryEntry(reopened, aiRoot, entry.id).content,
      entry.content,
    );
    await saveLibraryEntry(reopened, aiRoot, {
      type: "library.save",
      entryId: entry.id,
      expectedHash: entry.hash,
      content: "新收藏版本",
    });
    reopened.libraryOperation(op.id, aiRoot, { ...op.data, state: "prepared" });
    await recoverLibrary(reopened, aiRoot);
    assert.equal(reopened.libraryEntry(aiRoot, entry.id).version, 2);
    assert.equal(
      reopened.libraryOperations(aiRoot).find((record) => record.id === op.id)!
        .data.state,
      "superseded",
    );
  } finally {
    reopened.close();
  }
});

test("恢复未提交记录遇到外部修改时保留文件并标记未接纳", async (t) => {
  const { aiRoot, store, collect } = await setup(t),
    entry = await collect();
  const op = store.libraryOperations(aiRoot)[0]!;
  store.libraryOperation(op.id, aiRoot, { ...op.data, state: "prepared" });
  await fs.writeFile(entry.path, "恢复前外部修改");
  await recoverLibrary(store, aiRoot);
  assert.equal(await fs.readFile(entry.path, "utf8"), "恢复前外部修改");
  assert.equal(store.libraryOperations(aiRoot)[0]!.data.state, "abandoned");
  assert.equal(store.libraryEntry(aiRoot, entry.id).hash, entry.hash);
});

test("继续加工先停旧运行并携带选定成果 ID、哈希和同文档修订要求", async (t) => {
  const { root, task, artifact, store, aiRoot } = await setup(t);
  const service = new WorkbenchService(
    path.join(root, "service-data"),
    () => undefined,
  );
  service.store.setConfig("settings", store.settings());
  service.store.saveTask(store.task(task.id));
  let stops = 0,
    runTask: Task | undefined;
  service.runtime.stop = async () => {
    stops++;
  };
  service.runtime.run = async (id) => {
    runTask = service.store.task(id);
  };
  t.after(() => service.close());
  const snapshot = await service.execute({
    type: "artifact.refine",
    taskId: task.id,
    artifactId: artifact.id,
    instruction: "加上适用条件",
    expectedHash: artifact.hash,
  });
  assert.equal(stops, 1);
  assert.equal(runTask!.goalVersion, 2);
  assert.equal(runTask!.artifacts.length, 1);
  assert.equal(runTask!.artifacts[0]!.id, artifact.id);
  assert.equal(
    runTask!.messages.at(-1)!.content,
    `继续处理《${artifact.title}》：\n加上适用条件`,
  );
  assert.equal(runTask!.events.at(-1)!.data!.artifactId, artifact.id);
  assert.equal(runTask!.events.at(-1)!.data!.expectedHash, artifact.hash);
  assert.deepEqual(snapshot.library, []);
  await assert.rejects(
    service.execute({
      type: "artifact.refine",
      taskId: task.id,
      artifactId: artifact.id,
      instruction: "过期请求",
      expectedHash: "outdated",
    }),
    /已经改变/,
  );
  const entry = await collectArtifact(service.store, aiRoot, {
    type: "library.collect",
    taskId: task.id,
    artifactId: artifact.id,
    expectedHash: artifact.hash,
  });
  await service.execute({
    type: "library.reuse",
    taskId: task.id,
    entryId: entry.id,
  });
  assert.equal(service.store.task(task.id).sources[0]!.text, artifact.content);
  assert.equal(service.store.task(task.id).sources[0]!.location, entry.path);
});
