import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkbenchService } from "../src/core/service.js";
import { normalizeTeamSettings } from "../src/shared/member-settings.js";
import { safeModelError } from "../src/core/models.js";

// Real model, synthetic script only. Never opens the user's AI registry or task database.
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
if (!modelId) throw new Error("没有找到可用的 Gemini Flash 模型。");
const root = await realpath(
  await mkdtemp(path.join(os.tmpdir(), "ytriple-skills-probe-")),
);
let service = new WorkbenchService(
  path.join(root, "data"),
  (profile) => process.env[profile.apiKeyEnv],
);
const memberSettings = normalizeTeamSettings(undefined);
for (const settings of Object.values(memberSettings))
  settings.delegation = "off";
service.store.setConfig("settings", {
  ...service.store.settings(),
  aiRoot: path.join(root, "AI"),
  codeRoot: path.join(root, "Code"),
  workspaceRoot: path.join(root, "work"),
  projectMonitoring: false,
  libraryRecall: false,
  defaultProfileId: "skill-probe",
  memberSettings,
  memberProfiles: {
    coordinator: "skill-probe",
    cto: "skill-probe",
    researcher: "skill-probe",
  },
});
service.store.setConfig("profiles", [
  {
    id: "skill-probe",
    name: "Gemini 合成 Skill 验收",
    provider: "gemini",
    protocol: "google",
    apiKeyEnv,
    modelId,
    baseURL: "",
    hasKey: true,
    status: "untested",
    capabilities: { text: true, tools: true, streaming: true },
  },
]);
let closed = false;
const timer = setTimeout(() => {
  void service.runtime.stopAll();
}, 150_000);
try {
  await service.initialize();
  let snapshot = await service.execute({
    type: "task.create",
    title: "脚本核查 · 真实模型合成验收",
    goal: "这是无私人信息的合成验收。请使用我明确指定的方法，实际读取已添加的脚本和公告，核查标题承诺与成本主张，给出可直接使用的修订稿并保存一份简洁 Markdown 成果（500字以内）。保留合成校验词 LANTERN_26。只使用提供的材料，不联网、不请求补充、不委派。不能把方法加载称为验证通过；已有成果时修订同一份。",
    skillPolicy: { mode: "explicit", skillIds: ["script-review"] },
  });
  const id = snapshot.tasks[0]!.id;
  await service.execute({
    type: "source.addText",
    taskId: id,
    title: "合成公告及待审脚本",
    text: [
      "此材料是虚构产品样本，不是真实市场事件。校验词 LANTERN_26。",
      "公告：视频工具仅在草稿模式下，单次生成标价从20元降至10元，限新用户前5次。没有公布成片成功率、重试次数、剪辑工时和素材许可。",
      "待审标题：所有创作者总制作成本立减一半！",
      "待审脚本：这次降价适用于每个人的所有视频模式。每次便宜一半，所以成片总成本必然减少50%，现在就能稳定赚到更多。",
      "创作目标：30秒口播，帮助普通创作者理解这个合成公告，清晰诚实，不制造收益保证。",
    ].join("\n"),
  });
  const originalRun = service.runtime.run.bind(service.runtime);
  let done: Promise<void> | undefined;
  service.runtime.run = (taskId) => (done = originalRun(taskId));
  await service.execute({ type: "task.run", taskId: id });
  await done;
  snapshot = await service.snapshot();
  const task = snapshot.tasks.find((candidate) => candidate.id === id)!;
  assert.equal(task.status, "completed", task.error ?? "任务没有完成");
  const loads = task.events.filter((event) => event.type === "skill_loaded");
  assert.ok(
    loads.some(
      (event) =>
        event.data?.skillId === "script-review" &&
        event.data?.hash === task.skillBindings?.[0]?.hash,
    ),
  );
  assert.ok(
    task.events.some(
      (event) =>
        event.type === "tool_completed" && event.data?.tool === "read_source",
    ),
  );
  const artifact = task.artifacts.find(
    (candidate) => candidate.format === "md",
  );
  assert.ok(artifact);
  assert.ok(artifact.content?.includes("LANTERN_26"));
  const saved = await service.execute({
    type: "artifact.save",
    taskId: id,
    artifactId: artifact.id,
    expectedHash: artifact.hash,
    content:
      artifact.content +
      "\n\n合成编辑补充：这是合成测试，真实使用效果仍待检验。",
  });
  const savedArtifact = saved.tasks
    .find((candidate) => candidate.id === id)!
    .artifacts.find((candidate) => candidate.id === artifact.id)!;
  await service.close();
  closed = true;
  service = new WorkbenchService(
    path.join(root, "data"),
    (profile) => process.env[profile.apiKeyEnv],
  );
  closed = false;
  const restored = await service.initialize();
  const reopened = restored.tasks.find((candidate) => candidate.id === id)!;
  assert.deepEqual(reopened.skillBindings, task.skillBindings);
  assert.equal(
    reopened.artifacts.find((candidate) => candidate.id === artifact.id)!.hash,
    savedArtifact.hash,
  );
  assert.equal(
    reopened.artifacts.find((candidate) => candidate.id === artifact.id)!
      .version,
    savedArtifact.version,
  );
  console.log(
    JSON.stringify(
      {
        modelId,
        taskId: id,
        root: process.argv.includes("--keep") ? root : undefined,
        skill: loads.map((event) => ({
          id: event.data?.skillId,
          version: event.data?.version,
          hash: event.data?.hash,
          selection: event.data?.selection,
        })),
        readSources: task.events.filter(
          (event) =>
            event.type === "tool_completed" &&
            event.data?.tool === "read_source",
        ).length,
        artifactVersion: savedArtifact.version,
        reopened: true,
        content: artifact.content,
        evidenceScope:
          "真实模型与合成输入；自动断言验证加载/读取/保存/修订/重开，文本质量需另读，不代表真实创作者效果。",
      },
      null,
      2,
    ),
  );
} catch (error) {
  process.exitCode = 1;
  console.error(safeModelError(error));
} finally {
  clearTimeout(timer);
  if (!closed) await service.close();
  if (!process.argv.includes("--keep"))
    await rm(root, { recursive: true, force: true });
}
