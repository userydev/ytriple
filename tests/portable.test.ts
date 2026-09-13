import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { Store, uid, now } from "../src/core/store.js";
import { textSource, writeArtifact } from "../src/core/files.js";
import {
  collectArtifact,
  readLibraryEntry,
  saveLibraryEntry,
} from "../src/core/library.js";
import { BUILTIN_SKILLS } from "../src/core/skills.js";
import {
  handleSkillCommand,
  exportManagedSkills,
} from "../src/core/skill-library.js";
import { handleMediaCommand, mediaSnapshot } from "../src/core/media.js";
import {
  handleDeliveryCommand,
  deliverySnapshot,
} from "../src/core/delivery.js";
import { RoutineEngine, routineSnapshot } from "../src/core/routines.js";
import {
  handlePortableCommand,
  portableSnapshot,
  parseBookmarks,
} from "../src/core/portable.js";
import { portableCommandSchema } from "../src/shared/portable.js";
import type { Task } from "../src/shared/types.js";
import type { FeatureHost } from "../src/core/feature-host.js";

async function fixture(t: { after(fn: () => unknown): void }) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "ytriple-portable-")),
  );
  const store = new Store(path.join(root, "data"));
  store.setConfig("settings", {
    ...store.settings(),
    aiRoot: path.join(root, "AI"),
    codeRoot: path.join(root, "Code"),
    workspaceRoot: path.join(root, "work"),
  });
  store.setConfig("private.connection", {
    password: "do-not-copy-account-password",
    apiKey: "sk-this-is-a-real-looking-private-secret-12345",
  });
  const task: Task = {
    id: uid(),
    title: "可恢复工作",
    goal: "保留材料与准确版本",
    goalVersion: 1,
    kind: "research",
    member: "coordinator",
    projectId: "existing-software-project",
    workspace: path.join(root, "work", "original"),
    status: "completed",
    createdAt: now(),
    updatedAt: now(),
    messages: [
      {
        id: uid(),
        role: "assistant",
        member: "coordinator",
        content: "已完成合成检查",
        goalVersion: 1,
        createdAt: now(),
      },
    ],
    events: [],
    sources: [textSource("真实保存的文本", "恢复后仍能读取这一正文")],
    artifacts: [],
    skillPins: structuredClone(BUILTIN_SKILLS),
    skillBindings: structuredClone(BUILTIN_SKILLS),
    skillPolicy: { mode: "auto", skillIds: [] },
  };
  store.saveTask(task);
  const first = await writeArtifact(store, task.id, {
    title: "第一版说明",
    content: "# 第一版\n原先的内容",
    format: "md",
    goalVersion: 1,
  });
  const artifact = await writeArtifact(store, task.id, {
    title: "第二版说明",
    content: "# 第二版\n修订后的内容",
    format: "md",
    goalVersion: 1,
    artifactId: first.id,
    expectedHash: first.hash,
  });
  let runs = 0;
  const host: FeatureHost = {
    store,
    createWork: async (input) => {
      if (input.requestId && store.hasTask(input.requestId))
        return store.task(input.requestId);
      const id = input.requestId ?? uid();
      const work: Task = {
        ...task,
        id,
        title: input.title,
        goal: input.goal,
        workspace: path.join(root, "work", id),
        status: "idle",
        sources: input.sources ?? [],
        artifacts: [],
        messages: [],
        events: [],
        isolatedContext: input.isolatedContext,
      };
      store.saveTask(work);
      return work;
    },
    addSource: async (id, source) => {
      store.updateTask(id, (task) => {
        task.sources.push(source);
      });
    },
    runWork: async () => {
      runs++;
    },
    stopWork: async () => undefined,
    isRunning: () => false,
  };
  t.after(async () => {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, store, task, artifact, first, host, runs: () => runs };
}

test("portable backup restores versions, Lib feedback, media and delivery links into new paused objects without copying credentials", async (t) => {
  const { host, store, task, artifact, first, root } = await fixture(t);
  const entry = await collectArtifact(store, store.settings().aiRoot, {
    type: "library.collect",
    taskId: task.id,
    artifactId: artifact.id,
    expectedHash: artifact.hash,
    note: "可重复使用",
    tags: ["方法"],
  });
  await saveLibraryEntry(store, store.settings().aiRoot, {
    type: "library.save",
    entryId: entry.id,
    expectedHash: entry.hash,
    content: "# Lib 修订\n独立的资产改进",
  });
  await handleMediaCommand(host, {
    type: "media.channel.save",
    requestId: uid(),
    expectedRevision: 0,
    input: {
      name: "我的栏目",
      goal: "用实际资料解释问题",
      audience: "普通读者",
      productionConditions: "单人制作",
      expressionStandards: "表达准确",
      accounts: [],
      materials: [],
    },
  });
  await handleDeliveryCommand(host, {
    type: "delivery.register",
    requestId: uid(),
    taskId: task.id,
    artifactId: artifact.id,
    expectedHash: artifact.hash,
    spec: {
      recipient: "使用者",
      goal: task.goal,
      criteria: "能依据说明完成工作",
      missing: "",
    },
  });
  const engine = new RoutineEngine(host);
  await engine.execute({
    type: "routine.create",
    requestId: uid(),
    taskId: task.id,
    schedule: {
      kind: "time",
      cadence: "interval",
      everyMinutes: 30,
      timezone: "UTC",
    },
    location: "client",
  });
  const beforeRoutine = routineSnapshot(store).items[0]!;
  const backup = { type: "portable.backup" as const, requestId: uid() };
  await Promise.all([
    handlePortableCommand(host, backup),
    handlePortableCommand(host, backup),
  ]);
  const exported = portableSnapshot(store).backups[0]!;
  assert.equal(portableSnapshot(store).backups.length, 1);
  const serialized = await fs.readFile(exported.path, "utf8");
  assert.doesNotMatch(
    serialized,
    /private-secret|account-password|private\.connection/,
  );
  const originalBytes = await fs.readFile(artifact.path);
  const restore = {
    type: "portable.restore.path" as const,
    requestId: uid(),
    path: exported.path,
  };
  await Promise.all([
    handlePortableCommand(host, restore),
    handlePortableCommand(host, restore),
  ]);
  const imported = portableSnapshot(store).restores[0]!;
  assert.equal(imported.taskIds.length, 1);
  assert.notEqual(imported.taskIds[0], task.id);
  const restored = store.task(imported.taskIds[0]!);
  assert.equal(restored.status, "paused");
  assert.equal(restored.projectId, undefined);
  assert.equal(restored.events.at(-1)!.data!.originalTaskId, task.id);
  assert.deepEqual(restored.skillPolicy, { mode: "off", skillIds: [] });
  assert.equal(restored.skillPins!.length, BUILTIN_SKILLS.length);
  assert.equal(restored.artifacts[0]!.versions.length, 2);
  assert.equal(
    await fs.readFile(restored.artifacts[0]!.versions[0]!.path, "utf8"),
    first.content,
  );
  assert.equal(
    await fs.readFile(restored.artifacts[0]!.path, "utf8"),
    artifact.content,
  );
  assert.deepEqual(await fs.readFile(artifact.path), originalBytes);
  assert.equal(store.library(store.settings().aiRoot).length, 2);
  const restoredLib = store
    .library(store.settings().aiRoot)
    .find((item) => item.id !== entry.id)!;
  assert.match(
    readLibraryEntry(store, store.settings().aiRoot, restoredLib.id).content!,
    /独立的资产改进/,
  );
  assert.equal(restoredLib.source.taskId, restored.id);
  assert.equal(mediaSnapshot(store).channels.length, 2);
  assert.equal(
    deliverySnapshot(store).records.find(
      (record) => record.taskId === restored.id,
    )!.artifactHash,
    artifact.hash,
  );
  const restoredRoutine = routineSnapshot(store).items.find(
    (item) => item.id !== beforeRoutine.id,
  )!;
  assert.equal(restoredRoutine.state, "paused");
  assert.equal(restoredRoutine.taskId, restored.id);
  assert.equal(restoredRoutine.scope.workspace, restored.workspace);
  assert.equal(
    await fs.stat(path.join(root, "AI", "system")).catch(() => undefined),
    undefined,
  );
});

test("backup excludes credential fields and rejects credential-looking document content instead of corrupting version hashes", async (t) => {
  const { host, store, task } = await fixture(t);
  store.updateTask(task.id, (current) => {
    current.events.push({
      id: uid(),
      type: "model",
      summary: "元数据",
      createdAt: now(),
      goalVersion: 1,
      data: {
        nested: { apiKey: "should-never-be-exported", useful: "应保留" },
      },
    });
  });
  await handlePortableCommand(host, {
    type: "portable.backup",
    requestId: uid(),
  });
  const original = await fs.readFile(
    portableSnapshot(store).backups[0]!.path,
    "utf8",
  );
  assert.doesNotMatch(original, /should-never-be-exported/);
  assert.match(original, /应保留/);
  store.updateTask(task.id, (current) => {
    current.sources.push(
      textSource("误贴的秘密", "Bearer abcdefghijklmnopqrstuvwxyz1234567890"),
    );
  });
  await assert.rejects(
    handlePortableCommand(host, { type: "portable.backup", requestId: uid() }),
    /疑似凭据/,
  );
  assert.equal(portableSnapshot(store).backups.length, 1);
});

test("restore validates all hashes and disallows supplied output paths before writing any restored data", async (t) => {
  const { host, store, root } = await fixture(t);
  await handlePortableCommand(host, {
    type: "portable.backup",
    requestId: uid(),
  });
  const bundle = JSON.parse(
    await fs.readFile(portableSnapshot(store).backups[0]!.path, "utf8"),
  );
  const bad = path.join(root, "bad.ytriple.json");
  const blobId = Object.keys(bundle.blobs)[0]!;
  await fs.writeFile(
    bad,
    JSON.stringify({
      ...bundle,
      blobs: {
        ...bundle.blobs,
        [blobId]: Buffer.from("损坏内容").toString("base64"),
      },
    }),
  );
  const before = await fs.readdir(store.settings().workspaceRoot);
  await assert.rejects(
    handlePortableCommand(host, {
      type: "portable.restore.path",
      requestId: uid(),
      path: bad,
    }),
    /哈希/,
  );
  bundle.tasks[0].artifacts[0].path = "../../outside.md";
  await fs.writeFile(bad, JSON.stringify(bundle));
  await assert.rejects(
    handlePortableCommand(host, {
      type: "portable.restore.path",
      requestId: uid(),
      path: bad,
    }),
  );
  assert.deepEqual(await fs.readdir(store.settings().workspaceRoot), before);
  assert.throws(() =>
    portableCommandSchema.parse({
      type: "portable.restore",
      requestId: uid(),
      path: bad,
    }),
  );
});

test("bookmark imports keep real supplied coverage, deduplicate content, and do not claim link text is a read article", async (t) => {
  const { host, store, runs, root } = await fixture(t);
  const parsed = parseBookmarks(
    '<DL><A HREF="https://example.com/a">收藏一</A><A HREF="https://example.com/a#section">重复收藏</A><A HREF="javascript:alert(1)">不可用</A></DL>',
    "html",
  );
  assert.equal(parsed.sources.length, 1);
  assert.equal(parsed.duplicates, 1);
  assert.equal(parsed.skipped, 1);
  assert.match(parsed.sources[0]!.coverage, /未读取网页正文/);
  const command = {
    type: "portable.importBookmarks" as const,
    requestId: uid(),
    title: "我的导入",
    goal: "先判断该看哪些资料",
    format: "json" as const,
    content: JSON.stringify({
      roots: {
        bookmark_bar: {
          children: [
            {
              name: "收藏一",
              url: "https://example.com/a",
              text: "用户随收藏提供的实际摘录",
            },
            { name: "收藏二", url: "https://example.com/b" },
            {
              name: "秘密URL",
              url: "https://example.com/?access_token=private",
            },
          ],
        },
      },
    }),
    run: true,
  };
  await Promise.all([
    handlePortableCommand(host, command),
    handlePortableCommand(host, command),
  ]);
  const imported = portableSnapshot(store).imports[0]!;
  assert.equal(imported.added, 2);
  assert.equal(imported.skipped, 1);
  assert.equal(runs(), 1);
  assert.match(store.task(imported.taskId).sources[0]!.text, /实际摘录/);
  assert.equal(store.task(imported.taskId).isolatedContext, true);
  await handlePortableCommand(host, {
    ...command,
    requestId: uid(),
    taskId: imported.taskId,
  });
  assert.equal(store.task(imported.taskId).sources.length, 2);
  assert.equal(portableSnapshot(store).imports[1]!.duplicates, 2);
  assert.equal(runs(), 1);
  const book = path.join(root, "bookmarks.html");
  await fs.writeFile(
    book,
    '<A HREF="https://example.org/article">实际书签标题</A>',
  );
  await handlePortableCommand(host, {
    type: "portable.importBookmarks.path",
    requestId: uid(),
    path: book,
    title: "本地书签文件",
    goal: "整理导入的书签",
    run: false,
  });
  assert.equal(portableSnapshot(store).imports.at(-1)!.added, 1);
});

test("new collection digestion carries only bounded matching Lib versions before running and respects disabled recall", async (t) => {
  const { host, store, task } = await fixture(t);
  const artifact = await writeArtifact(store, task.id, {
    title: "电池热管理条件",
    content: "# 电池热管理\n既有验证条件：先控制电池温度再比较续航。",
    format: "md",
    goalVersion: 1,
  });
  const entry = await collectArtifact(store, store.settings().aiRoot, {
    type: "library.collect",
    taskId: task.id,
    artifactId: artifact.id,
    expectedHash: artifact.hash,
    tags: ["电池", "热管理"],
    note: "已有条件",
  });
  const unrelated = await writeArtifact(store, task.id, {
    title: "私人无关资料",
    content: "不应进入收藏对照的私人正文",
    format: "md",
    goalVersion: 1,
  });
  await collectArtifact(store, store.settings().aiRoot, {
    type: "library.collect",
    taskId: task.id,
    artifactId: unrelated.id,
    expectedHash: unrelated.hash,
    tags: [],
    note: "",
  });
  const command = {
    type: "portable.importBookmarks" as const,
    requestId: uid(),
    title: "新的电池材料",
    goal: "消化实际取得的资料",
    content: "电池热管理：新研究观察到温度差异，续航对比需要相同温度条件。",
    format: "text" as const,
    run: true,
  };
  let inputAtRun = "";
  host.runWork = async (id) => {
    inputAtRun = JSON.stringify(store.task(id).sources);
  };
  await handlePortableCommand(host, command);
  const result = store.task(command.requestId);
  assert.equal(result.sources.filter((source) => source.library).length, 1);
  const source = result.sources.find((source) => source.library)!;
  assert.equal(source.library!.hash, entry.hash);
  assert.equal(source.library!.entryId, entry.id);
  assert.match(inputAtRun, /先控制电池温度/);
  assert.doesNotMatch(inputAtRun, /私人正文/);
  assert.match(
    portableSnapshot(store).imports.at(-1)!.coverage,
    /携带 1 份本地候选/,
  );
  await saveLibraryEntry(store, store.settings().aiRoot, {
    type: "library.save",
    entryId: entry.id,
    expectedHash: entry.hash,
    content: "# 后续新版本",
  });
  assert.match(
    store.task(command.requestId).sources.find((source) => source.library)!
      .text,
    /先控制电池温度/,
  );
  store.setConfig("settings", { ...store.settings(), libraryRecall: false });
  const disabled = { ...command, requestId: uid() };
  await handlePortableCommand(host, disabled);
  assert.equal(
    store.task(disabled.requestId).sources.filter((source) => source.library)
      .length,
    0,
  );
  assert.match(
    portableSnapshot(store).imports.at(-1)!.coverage,
    /Lib 查找已关闭/,
  );
});

test("explicit public-page reads are bounded and preserve failures and returned coverage before running the team", async (t) => {
  const { host, store, runs } = await fixture(t);
  const calls: string[] = [];
  host.readURL = async (url) => {
    calls.push(url);
    if (url.endsWith("/blocked"))
      throw new Error("该来源要求登录，本次没有取得正文");
    const source = textSource(
      "已读公开文章",
      "通过公开读取接口取得的实际文章正文",
      "url",
      url,
    );
    source.coverage = "公开网页文字提取，未理解页面视频";
    return source;
  };
  const input = {
    type: "portable.importBookmarks" as const,
    requestId: uid(),
    title: "公开收藏",
    goal: "据实际正文整理",
    format: "text" as const,
    content: "https://example.org/read\nhttps://example.org/blocked",
    fetchURLs: true,
    run: true,
  };
  await handlePortableCommand(host, input);
  const record = portableSnapshot(store).imports[0]!;
  assert.equal(calls.length, 2);
  assert.equal(record.fetched, 1);
  assert.equal(record.failures!.length, 1);
  const sources = store.task(record.taskId).sources;
  assert.match(sources[0]!.text, /实际文章正文/);
  assert.match(sources[0]!.coverage, /未理解页面视频/);
  assert.match(sources[1]!.coverage, /仅书签/);
  assert.equal(runs(), 1);
  calls.length = 0;
  await handlePortableCommand(host, {
    ...input,
    requestId: uid(),
    taskId: record.taskId,
  });
  assert.deepEqual(calls, ["https://example.org/blocked"]);
  assert.equal(store.task(record.taskId).sources.length, 2);
  calls.length = 0;
  await handlePortableCommand(host, {
    ...input,
    requestId: uid(),
    content: Array.from(
      { length: 105 },
      (_, index) => `https://example.org/${index}`,
    ).join("\n"),
  });
  assert.equal(calls.length, 50);
  assert.equal(portableSnapshot(store).imports.at(-1)!.added, 100);
  assert.equal(portableSnapshot(store).imports.at(-1)!.skipped, 5);
});

test("managed method history survives a portable copy with remapped, disabled identity and unchanged hashes", async (t) => {
  const { host, store, task } = await fixture(t);
  await handleSkillCommand(host, {
    type: "skill.importText",
    requestId: uid(),
    content:
      "---\nname: portable-method\ndescription: 可恢复的资料检查方法\n---\n# 检查方法\n实际读取资料并定位依据。",
  });
  const original = exportManagedSkills(store)[0]!;
  const definition = original.versions[0]!.definition;
  store.updateTask(task.id, (task) => {
    task.skillPins = [definition];
    task.skillBindings = [definition];
  });
  await handlePortableCommand(host, {
    type: "portable.backup",
    requestId: uid(),
  });
  const file = portableSnapshot(store).backups[0]!.path;
  await handlePortableCommand(host, {
    type: "portable.restore.path",
    requestId: uid(),
    path: file,
  });
  const restoredMethod = exportManagedSkills(store).find(
    (entry) => entry.id !== original.id,
  )!;
  assert.equal(restoredMethod.enabled, false);
  assert.equal(restoredMethod.activeHash, original.activeHash);
  assert.equal(
    restoredMethod.versions[0]!.definition.instructions,
    definition.instructions,
  );
  const restoredTask = store.task(
    portableSnapshot(store).restores[0]!.taskIds[0]!,
  );
  assert.equal(restoredTask.skillPins![0]!.id, restoredMethod.id);
  assert.equal(restoredTask.skillPins![0]!.hash, definition.hash);
});
