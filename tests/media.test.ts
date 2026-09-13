import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { Store, now, uid } from "../src/core/store.js";
import { writeArtifact } from "../src/core/files.js";
import { handleMediaCommand, mediaSnapshot } from "../src/core/media.js";
import {
  mediaCommandSchema,
  type MediaChannelInput,
  type MediaWorkInput,
} from "../src/shared/media.js";
import type {
  FeatureHost,
  FeatureTaskInput,
} from "../src/core/feature-host.js";
import type { Task } from "../src/shared/types.js";

test("media stages carry selected edited artifact versions, reject unknown changes and unrelated tasks, and freeze retry inputs", async (t) => {
  const { host, channelId, workId, inputs } = await setup(t);
  const start = {
    type: "media.work.start" as const,
    requestId: uid(),
    channelId,
    workId,
    expectedRevision: 1,
    stage: "script" as const,
    instruction: "",
    materialIds: [],
    feedbackIds: [],
  };
  await handleMediaCommand(host, start);
  const scriptTask = host.store.task(
    mediaSnapshot(host.store).works[0]!.taskLinks[0]!.taskId,
  );
  host.store.updateTask(scriptTask.id, (task) => {
    task.messages.push({
      id: uid(),
      role: "user",
      member: "coordinator",
      content: "原讨论的私人信息不允许带出",
      createdAt: now(),
      goalVersion: 1,
    });
  });
  const first = await writeArtifact(host.store, scriptTask.id, {
    title: "原创脚本",
    content: "# 脚本 v1",
    format: "md",
    goalVersion: 1,
  });
  const body = "# 已经核对的脚本\n\n保留用户修订的例子与约束。\n";
  const second = await writeArtifact(host.store, scriptTask.id, {
    artifactId: first.id,
    expectedHash: first.hash,
    title: first.title,
    content: body,
    format: "md",
    goalVersion: 1,
  });
  const request = {
    ...start,
    requestId: uid(),
    expectedRevision: 2,
    stage: "production" as const,
    artifacts: [
      {
        taskId: scriptTask.id,
        artifactId: first.id,
        version: first.version,
        hash: first.hash,
      },
    ],
  };
  await assert.rejects(handleMediaCommand(host, request), /已有新版本/);
  const outsider = await host.createWork({
    title: "无关作品",
    goal: "此工作不属于当前作品",
  });
  await assert.rejects(
    handleMediaCommand(host, {
      ...request,
      artifacts: [{ ...request.artifacts[0]!, taskId: outsider.id }],
    }),
    /不属于当前频道或作品/,
  );
  const ready = {
    ...request,
    artifacts: [
      {
        taskId: scriptTask.id,
        artifactId: second.id,
        version: second.version,
        hash: second.hash,
      },
    ],
  };
  await fs.writeFile(second.path, "外部未知修改");
  await assert.rejects(handleMediaCommand(host, ready), /外部发生未知修改/);
  await fs.writeFile(second.path, body);
  const before = inputs.length;
  await handleMediaCommand(host, ready);
  await handleMediaCommand(host, ready);
  assert.equal(inputs.length, before + 1);
  const input = inputs.at(-1)!;
  assert.equal(input.isolatedContext, true);
  const artifactSource = input.sources!.find((source) =>
    source.location.startsWith("media-artifact:"),
  )!;
  assert.ok(artifactSource.text.includes(body));
  assert.ok(artifactSource.text.includes(second.hash));
  assert.doesNotMatch(JSON.stringify(input), /原讨论的私人信息/);
  assert.deepEqual(
    mediaSnapshot(host.store).works[0]!.taskLinks.at(-1)!.artifacts,
    ready.artifacts,
  );
  const third = await writeArtifact(host.store, scriptTask.id, {
    artifactId: second.id,
    expectedHash: second.hash,
    title: second.title,
    content: "# 下一个编辑版本",
    format: "md",
    goalVersion: 1,
  });
  assert.ok(
    artifactSource.text.includes(body),
    "later source edits leave the running input unchanged",
  );
  const publish = {
    ...ready,
    requestId: uid(),
    expectedRevision: 3,
    stage: "publish" as const,
    artifacts: [
      {
        taskId: scriptTask.id,
        artifactId: third.id,
        version: third.version,
        hash: third.hash,
      },
    ],
  };
  const create = host.createWork;
  let failed = false;
  host.createWork = async (input) => {
    const task = await create(input);
    if (!failed) {
      failed = true;
      throw new Error("模拟创建完成后回执丢失");
    }
    return task;
  };
  await assert.rejects(handleMediaCommand(host, publish), /回执丢失/);
  const frozen = structuredClone(inputs.at(-1));
  await writeArtifact(host.store, scriptTask.id, {
    artifactId: third.id,
    expectedHash: third.hash,
    title: third.title,
    content: "# 后来再次编辑",
    format: "md",
    goalVersion: 1,
  });
  await handleMediaCommand(host, publish);
  assert.deepEqual(
    inputs.at(-1),
    frozen,
    "retry keeps exact prior source bodies and IDs",
  );
  assert.ok(
    inputs
      .at(-1)!
      .sources!.some((source) => source.text.includes("下一个编辑版本")),
  );
  assert.ok(
    !inputs
      .at(-1)!
      .sources!.some((source) => source.text.includes("后来再次编辑")),
  );
});

async function setup(t: { after(fn: () => unknown): void }) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "ytriple-media-"));
  const root = await fs.realpath(temporary);
  let store = new Store(path.join(root, "data"));
  store.setConfig("settings", {
    ...store.settings(),
    aiRoot: path.join(root, "AI"),
    codeRoot: path.join(root, "Code"),
    workspaceRoot: path.join(root, "workspaces"),
  });
  const inputs: FeatureTaskInput[] = [],
    runs: string[] = [];
  const host: FeatureHost = {
    get store() {
      return store;
    },
    createWork: async (input) => {
      inputs.push(input);
      const key = `test-work:${input.requestId}`;
      const existing = store.config<string | null>(key, () => null);
      if (existing) return store.task(existing);
      const task: Task = {
        id: uid(),
        title: input.title,
        goal: input.goal,
        goalVersion: 1,
        kind: input.kind ?? "research",
        member: input.member ?? "coordinator",
        teamMode: input.teamMode,
        workspace: path.join(root, "workspaces", uid()),
        createdAt: now(),
        updatedAt: now(),
        status: "idle",
        messages: [],
        events: [],
        artifacts: [],
        sources: input.sources ?? [],
        skillPolicy: input.skillPolicy,
      };
      store.saveTask(task);
      store.setConfig(key, task.id);
      return task;
    },
    addSource: async (taskId, source) => {
      const task = store.task(taskId);
      task.sources.push(source);
      store.saveTask(task);
    },
    runWork: async (id) => {
      runs.push(id);
    },
    stopWork: async () => undefined,
    isRunning: () => false,
  };
  t.after(async () => {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const channelInput: MediaChannelInput = {
    name: "个人开发频道",
    goal: "解释真正有用的开发方法",
    audience: "独立开发者",
    productionConditions: "每周两小时，已有录屏工具",
    expressionStandards: "先展示证据，再解释取舍",
    accounts: [
      {
        id: uid(),
        label: "自己的频道",
        relation: "own",
        url: "https://www.youtube.com/@example",
      },
      {
        id: uid(),
        label: "公开参考账号",
        relation: "reference",
        url: "https://www.youtube.com/@reference",
      },
    ],
    materials: [
      {
        id: uid(),
        title: "代表脚本文本",
        relation: "own",
        url: "",
        text: "真实提供的一段脚本：先提出问题，再解释方法。",
        usageRights: "owned",
      },
      {
        id: uid(),
        title: "公开对标链接",
        relation: "reference",
        url: "https://example.com/public",
        text: "",
        usageRights: "unknown",
      },
    ],
  };
  const channelId = uid();
  await handleMediaCommand(host, {
    type: "media.channel.save",
    requestId: channelId,
    expectedRevision: 0,
    input: channelInput,
  });
  const workInput: MediaWorkInput = {
    title: "第一期作品",
    angle: "解释为什么读源码仍需要可复现证据",
    format: "短视频",
    targetDate: "2026-10-01",
    variants: [
      {
        id: uid(),
        platform: "YouTube",
        language: "中文",
        versionLabel: "初稿",
      },
    ],
    materials: [],
  };
  const workId = uid();
  await handleMediaCommand(host, {
    type: "media.work.save",
    requestId: workId,
    channelId,
    expectedRevision: 0,
    input: workInput,
  });
  return {
    root,
    host,
    inputs,
    runs,
    channelId,
    channelInput,
    workId,
    workInput,
    reopen: () => {
      store.close();
      store = new Store(path.join(root, "data"));
    },
  };
}

test("media channels and related work versions persist local documents, reject stale writes and survive reopening", async (t) => {
  const { host, root, channelId, channelInput, workId, workInput, reopen } =
    await setup(t);
  const requestId = uid();
  await Promise.all(
    [1, 2].map(() =>
      handleMediaCommand(host, {
        type: "media.work.save",
        requestId,
        channelId,
        workId,
        expectedRevision: 1,
        input: { ...workInput, title: "已修订的第一期" },
      }),
    ),
  );
  const snapshot = mediaSnapshot(host.store),
    work = snapshot.works[0]!;
  assert.equal(work.revision, 2);
  assert.equal(work.title, "已修订的第一期");
  assert.match(work.documentPath, new RegExp(`${workId}/work-v2.md$`));
  assert.match(
    await fs.readFile(work.documentPath, "utf8"),
    /目标日期，非实际发布时间/,
  );
  assert.equal(
    await fs
      .readFile(
        path.join(path.dirname(work.documentPath), "work-v1.md"),
        "utf8",
      )
      .then((text) => text.includes("第一期作品")),
    true,
  );
  await assert.rejects(
    handleMediaCommand(host, {
      type: "media.work.save",
      requestId: uid(),
      channelId,
      workId,
      expectedRevision: 1,
      input: workInput,
    }),
    /媒体资料已更新/,
  );
  await assert.rejects(
    handleMediaCommand(host, {
      type: "media.work.save",
      requestId,
      channelId,
      workId,
      expectedRevision: 1,
      input: workInput,
    }),
    /同一请求标识/,
  );
  await handleMediaCommand(host, {
    type: "media.channel.save",
    requestId: uid(),
    channelId,
    expectedRevision: 1,
    input: { ...channelInput, expressionStandards: "由我修正后的频道标准" },
  });
  reopen();
  assert.equal(
    mediaSnapshot(host.store).channels[0]!.expressionStandards,
    "由我修正后的频道标准",
  );
  assert.equal(mediaSnapshot(host.store).works[0]!.revision, 2);
  assert.equal(
    await fs
      .stat(path.join(root, "workspaces", "media-projects"))
      .then((stat) => stat.isDirectory()),
    true,
  );
  assert.equal(
    await fs
      .stat(path.join(root, "AI", "system"))
      .then(() => true)
      .catch(() => false),
    false,
    "media metadata never registers synthetic projects in central rules",
  );
});

test("publication evidence and manually supplied feedback remain distinct from schedules and linked variants", async (t) => {
  const { host, workId, workInput, channelId } = await setup(t);
  const second = {
    id: uid(),
    platform: "TikTok",
    language: "English",
    versionLabel: "adaptation",
    basedOnId: workInput.variants[0]!.id,
  };
  await handleMediaCommand(host, {
    type: "media.work.save",
    requestId: uid(),
    workId,
    channelId,
    expectedRevision: 1,
    input: { ...workInput, variants: [...workInput.variants, second] },
  });
  const publish = {
    type: "media.work.publish" as const,
    requestId: uid(),
    workId,
    expectedRevision: 2,
    variantId: second.id,
    url: "https://example.com/actual-published-work",
    publishedAt: "2026-09-29T12:00:00Z",
  };
  await handleMediaCommand(host, publish);
  await handleMediaCommand(host, publish);
  let work = mediaSnapshot(host.store).works[0]!;
  assert.equal(work.publications.length, 1);
  assert.equal(work.targetDate, "2026-10-01");
  assert.equal(work.publications[0]!.publishedAt, "2026-09-29T12:00:00Z");
  assert.notEqual(
    work.publications[0]!.recordedAt,
    work.publications[0]!.publishedAt,
  );
  await handleMediaCommand(host, {
    type: "media.feedback.add",
    requestId: uid(),
    workId,
    expectedRevision: 3,
    input: {
      kind: "comments",
      title: "实际评论节选",
      text: "用户评论：示例可以再讲慢一些。",
      url: "",
      observedAt: "2026-09-30",
    },
  });
  await handleMediaCommand(host, {
    type: "media.feedback.add",
    requestId: uid(),
    workId,
    expectedRevision: 4,
    input: {
      kind: "report",
      title: "尚未读取的报告链接",
      text: "",
      url: "https://example.com/report",
      observedAt: "",
    },
  });
  work = mediaSnapshot(host.store).works[0]!;
  assert.equal(work.feedback[0]!.range, "provided-text");
  assert.equal(work.feedback[1]!.range, "link-only");
  assert.match(
    await fs.readFile(work.documentPath, "utf8"),
    /仅链接，未读取正文/,
  );
  await assert.rejects(
    handleMediaCommand(host, {
      type: "media.work.save",
      requestId: uid(),
      channelId,
      workId,
      expectedRevision: work.revision,
      input: workInput,
    }),
    /已经登记发布的版本需要保留/,
  );
});

test("media stages create real persisted tasks with selected context, scope and original-work links exactly once", async (t) => {
  const { host, channelId, channelInput, workId, inputs, runs, reopen } =
    await setup(t);
  const feedbackId = uid();
  await handleMediaCommand(host, {
    type: "media.feedback.add",
    requestId: feedbackId,
    workId,
    expectedRevision: 1,
    input: {
      kind: "comments",
      title: "评论原文",
      text: "实际评论：想看一个完整例子。",
      url: "",
      observedAt: "2026-09-30",
    },
  });
  const request = {
    type: "media.work.start" as const,
    requestId: uid(),
    channelId,
    workId,
    expectedRevision: 2,
    stage: "review" as const,
    instruction: "核对第一期的创作假设",
    materialIds: [channelInput.materials[0]!.id],
    feedbackIds: [feedbackId],
  };
  await Promise.all([
    handleMediaCommand(host, request),
    handleMediaCommand(host, request),
  ]);
  assert.equal(host.store.tasks().length, 1);
  const task = host.store.tasks()[0]!;
  assert.equal(task.teamMode, "media");
  assert.equal(task.projectId, undefined);
  assert.equal(inputs[0]!.isolatedContext, true);
  assert.equal(inputs[0]!.requestId, `media:${request.requestId}`);
  assert.match(task.goal, /不虚构数据、受众反馈或因果/);
  assert.match(
    task.sources.map((source) => source.text).join("\n"),
    /每周两小时/,
  );
  assert.match(
    task.sources.map((source) => source.text).join("\n"),
    /实际评论：想看一个完整例子/,
  );
  assert.equal(
    task.sources.some((source) =>
      source.text.includes("https://example.com/public"),
    ),
    false,
    "unselected material is not sent to the team",
  );
  assert.equal(
    task.sources.some((source) => source.title.includes("代表脚本文本")),
    true,
  );
  assert.equal(
    task.sources.some((source) => source.coverage.includes("不是完整平台数据")),
    true,
  );
  assert.deepEqual(runs, [task.id]);
  const link = mediaSnapshot(host.store).works[0]!.taskLinks[0]!;
  assert.equal(link.taskId, task.id);
  assert.equal(link.workRevision, 2);
  reopen();
  await handleMediaCommand(host, request);
  assert.equal(host.store.tasks().length, 1);
  assert.deepEqual(runs, [task.id]);
  assert.equal(mediaSnapshot(host.store).works[0]!.taskLinks.length, 1);
});

test("media refuses changed local files and foreign materials without overwriting or expanding scope", async (t) => {
  const { host, channelId, channelInput, workId } = await setup(t);
  await assert.rejects(
    handleMediaCommand(host, {
      type: "media.work.start",
      requestId: uid(),
      channelId,
      workId,
      expectedRevision: 1,
      stage: "script",
      instruction: "",
      materialIds: [uid()],
      feedbackIds: [],
    }),
    /不属于当前频道作品/,
  );
  assert.equal(host.store.tasks().length, 0);
  const channel = mediaSnapshot(host.store).channels[0]!;
  await fs.appendFile(channel.documentPath, "\n外部修改必须保留");
  await assert.rejects(
    handleMediaCommand(host, {
      type: "media.channel.save",
      requestId: uid(),
      channelId,
      expectedRevision: 1,
      input: channelInput,
    }),
    /正文已在外部修改/,
  );
  assert.match(
    await fs.readFile(channel.documentPath, "utf8"),
    /外部修改必须保留/,
  );
  assert.equal(mediaSnapshot(host.store).channels[0]!.revision, 1);
});

test("media IPC accepts public URLs, rejects hidden payloads and requires actual publication evidence", () => {
  assert.equal(
    mediaCommandSchema.safeParse({
      type: "media.work.publish",
      requestId: uid(),
      workId: uid(),
      expectedRevision: 1,
      variantId: uid(),
      url: "",
      publishedAt: "",
    }).success,
    false,
  );
  assert.equal(
    mediaCommandSchema.safeParse({
      type: "media.work.publish",
      requestId: uid(),
      workId: uid(),
      expectedRevision: 1,
      variantId: uid(),
      url: "https://secret:token@example.com/video",
      publishedAt: "",
    }).success,
    false,
  );
  assert.equal(
    mediaCommandSchema.safeParse({
      type: "media.feedback.add",
      requestId: uid(),
      workId: uid(),
      expectedRevision: 1,
      input: {
        kind: "report",
        title: "report",
        text: "data",
        url: "file:///private/report",
        observedAt: "",
      },
    }).success,
    false,
  );
  assert.equal(
    mediaCommandSchema.safeParse({
      type: "media.work.start",
      requestId: uid(),
      channelId: uid(),
      expectedRevision: 1,
      stage: "topic",
      instruction: "",
      materialIds: [],
      feedbackIds: [],
      script: "run anything",
    }).success,
    false,
  );
});
