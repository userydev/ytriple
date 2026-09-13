import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkbenchService } from "../src/core/service.js";
import {
  collectArtifact,
  recordLibraryFeedback,
  readLibraryEntry,
} from "../src/core/library.js";
import { writeArtifact } from "../src/core/files.js";
import { uid, now } from "../src/core/store.js";
import { safeModelError } from "../src/core/models.js";
import type { ModelProfile, Task } from "../src/shared/types.js";

// Real Gemini calls, synthetic material only. Never opens the real AI registry or user task database.
const apiKeyEnv = process.env.GEMINI_API_KEY
  ? "GEMINI_API_KEY"
  : "GOOGLE_API_KEY";
const key = process.env[apiKeyEnv];
if (!key) throw new Error("缺少已获授权的 Gemini 环境配置。");
let modelId = process.env.GEMINI_MODEL;
if (!modelId) {
  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models",
    {
      headers: { "x-goog-api-key": key },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok)
    throw new Error(`模型目录读取失败：HTTP ${response.status}`);
  const body = (await response.json()) as {
    models?: { name: string; supportedGenerationMethods?: string[] }[];
  };
  modelId = body.models
    ?.filter(
      (model) =>
        model.supportedGenerationMethods?.includes("generateContent") &&
        /gemini-[\d.]+-flash$/.test(model.name),
    )
    .sort((a, b) => b.name.localeCompare(a.name, "en", { numeric: true }))[0]
    ?.name.replace(/^models\//, "");
}
if (!modelId) throw new Error("未找到可用的 Gemini Flash 模型。");
const root = await realpath(
  await mkdtemp(path.join(os.tmpdir(), "ytriple-library-probe-")),
);
const startedAt = now();
let service = new WorkbenchService(
  path.join(root, "data"),
  (profile) => process.env[profile.apiKeyEnv],
);
const aiRoot = path.join(root, "AI");
service.store.setConfig("settings", {
  ...service.store.settings(),
  aiRoot,
  codeRoot: path.join(root, "Code"),
  workspaceRoot: path.join(root, "work"),
  projectMonitoring: false,
  defaultProfileId: "library-probe",
  memberProfiles: {
    coordinator: "library-probe",
    researcher: "library-probe",
    cto: "library-probe",
  },
});
const profile: ModelProfile = {
  id: "library-probe",
  name: "Gemini 合成 Lib 验收",
  provider: "gemini",
  protocol: "google",
  apiKeyEnv,
  baseURL: "",
  modelId,
  hasKey: true,
  status: "untested",
  capabilities: { text: true, tools: true, streaming: true },
};
service.store.setConfig("profiles", [profile]);
const origin: Task = {
  id: uid(),
  title: "阅读方法 · 合成材料",
  goal: "积累深度阅读方法",
  goalVersion: 1,
  kind: "learning",
  member: "coordinator",
  status: "completed",
  workspace: path.join(root, "work", "origin"),
  createdAt: now(),
  updatedAt: now(),
  messages: [],
  events: [],
  sources: [],
  artifacts: [],
};
service.store.saveTask(origin);
const timeout = setTimeout(() => {
  void service.runtime.stopAll();
}, 180_000);
try {
  const artifact = await writeArtifact(service.store, origin.id, {
    title: "新手深度阅读方法",
    content:
      "# 新手深度阅读方法\n合成待检验方法：每次连续阅读 120 分钟，之后总结。旧方法代号 LEGACY_120。此文本没有用户私人资料。",
    format: "md",
    goalVersion: 1,
  });
  const entry = await collectArtifact(service.store, aiRoot, {
    type: "library.collect",
    taskId: origin.id,
    artifactId: artifact.id,
    expectedHash: artifact.hash,
    tags: ["阅读", "新手", "方法"],
  });
  recordLibraryFeedback(service.store, aiRoot, {
    type: "library.feedback",
    entryId: entry.id,
    feedbackId: uid(),
    expectedHash: entry.hash,
    expectedVersion: 1,
    expectedFeedbackRevision: 0,
    kind: "correction",
    note: "合成纠正：120 分钟不适合本次新手；应每 20 分钟暂停，复述三条要点。采用 ORCHID_20 代号。",
    purpose: "形成新手可执行的阅读练习",
    conditions: "本次合成新手场景",
    evidence: "合成输入，只测试真实模型能否理解纠正；不是真人效果验证。",
  });
  let snapshot = await service.execute({
    type: "task.create",
    goal: "为新手制定深度阅读练习说明书。这是合成验收，只使用已选入的本地资料，不联网。统筹先检查资料目录，委派研究员实际读取相关 Lib 正文和用户反馈并提出需要改变的判断；再依据研究员回复写一份不超过 400 字的 Markdown 说明，包含方法、适用条件、来源 ID、正确代号与待验证方式。明确旧判断如何被修正，保留未验证身份。不请求用户补充，不让研究员再委派子团队。",
    title: "新手阅读练习 · 真实模型合成验收",
  });
  const task = snapshot.tasks.find((task) => task.id !== origin.id)!;
  const originalRun = service.runtime.run.bind(service.runtime);
  let done: Promise<void> | undefined;
  service.runtime.run = (id) => (done = originalRun(id));
  await service.execute({ type: "task.run", taskId: task.id });
  await done;
  const finished = service.store.task(task.id);
  assert.equal(finished.status, "completed", finished.error);
  const source = finished.sources.find(
    (source) =>
      source.library?.entryId === entry.id && !source.library.supersededAt,
  )!;
  assert.ok(source, "automatic recall");
  const reads = finished.events.filter(
    (event) =>
      event.type === "tool_completed" &&
      event.data?.tool === "read_source" &&
      event.data?.sourceId === source.id,
  );
  assert.ok(reads.length, "actual source reading");
  assert.ok(
    finished.events.some(
      (event) =>
        event.type === "delegation_completed" &&
        event.data?.tool === "consult_researcher",
    ),
    "actual researcher collaboration",
  );
  assert.ok(finished.artifacts.length, "saved output");
  let result = finished.artifacts.at(-1)!;
  const content = await readFile(result.path, "utf8");
  assert.match(content, /ORCHID_20/);
  assert.ok(
    content.includes(source.id) || content.includes(entry.id),
    "traceable Lib source",
  );
  await service.execute({
    type: "library.feedback",
    entryId: entry.id,
    feedbackId: uid(),
    expectedHash: entry.hash,
    expectedVersion: 1,
    expectedFeedbackRevision: 1,
    kind: "correction",
    note: "新增合成纠正：如果暂停时无法复述三条要点，应重读当前一节，不能直接进入下一节。请在同一份说明书加入这一判断分支，分支代号 ORCHID_REPEAT。",
    purpose: "完善已有的新手阅读说明书",
    conditions: "无法复述时",
    evidence: "合成条件；仅验证真实模型接续和同文档修订。",
  });
  assert.equal(service.store.task(task.id).status, "paused");
  await service.execute({ type: "task.run", taskId: task.id });
  await done;
  const continued = service.store.task(task.id);
  assert.equal(continued.status, "completed", continued.error);
  assert.equal(
    continued.messages.filter((message) => message.role === "user").length,
    1,
    "must retain the original user message without duplicating it",
  );
  assert.equal(
    continued.artifacts.length,
    1,
    "same instruction document is revised",
  );
  const revised = continued.artifacts.find(
    (artifact) => artifact.id === result.id,
  )!;
  assert.ok(revised.version > result.version, "revision after new feedback");
  result = revised;
  assert.match(await readFile(result.path, "utf8"), /ORCHID_REPEAT/);
  assert.equal(
    await readFile(entry.path, "utf8"),
    entry.content,
    "Lib source is not silently overwritten",
  );
  const runResponses = continued.events.filter(
    (event) => event.type === "model_usage",
  ).length;
  await service.close();
  service = new WorkbenchService(
    path.join(root, "data"),
    (profile) => process.env[profile.apiKeyEnv],
  );
  snapshot = await service.initialize();
  assert.equal(
    readLibraryEntry(service.store, aiRoot, entry.id).feedbackRevision,
    2,
  );
  assert.equal(
    snapshot.tasks.find((item) => item.id === task.id)?.artifacts.at(-1)?.hash,
    result.hash,
  );
  console.log(
    JSON.stringify(
      {
        probe: "library-recall-feedback",
        result: "passed",
        modelId,
        startedAt,
        finishedAt: now(),
        actualReads: continued.events.filter(
          (event) =>
            event.type === "tool_completed" &&
            event.data?.tool === "read_source",
        ).length,
        feedbackContinuation: true,
        artifactVersion: result.version,
        delegated: "researcher",
        artifacts: finished.artifacts.length,
        modelResponses: runResponses,
        reopened: true,
        syntheticOnly: true,
        actualUserOutcome: "not-tested",
        ...(process.argv.includes("--keep-temp")
          ? { temporaryRoot: root, artifactPath: result.path }
          : {}),
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      probe: "library-recall-feedback",
      result: "failed",
      error: safeModelError(error, key),
      syntheticOnly: true,
    }),
  );
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  await service.close();
  if (!process.argv.includes("--keep-temp"))
    await rm(root, { recursive: true, force: true });
}
