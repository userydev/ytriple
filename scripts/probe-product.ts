import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID as uid } from "node:crypto";
import { WorkbenchService, safeError } from "../src/core/service.js";
import { normalizeTeamSettings } from "../src/shared/member-settings.js";

// Real providers, invented product materials, temporary data and AI roots only.
const keyEnv = process.env.GEMINI_API_KEY ? "GEMINI_API_KEY" : "GOOGLE_API_KEY";
if (!process.env[keyEnv])
  throw new Error("需要 Gemini 环境凭据执行真实模型验收。");
const response = await fetch(
  "https://generativelanguage.googleapis.com/v1beta/models",
  {
    headers: { "x-goog-api-key": process.env[keyEnv]! },
    signal: AbortSignal.timeout(20_000),
  },
);
if (!response.ok) throw new Error(`读取模型目录失败：${response.status}`);
const models = (await response.json()) as {
  models: { name: string; supportedGenerationMethods?: string[] }[];
};
const modelId =
  process.env.GEMINI_MODEL ??
  models.models
    .filter(
      (m) =>
        m.supportedGenerationMethods?.includes("generateContent") &&
        /gemini-[\d.]+-flash$/.test(m.name),
    )
    .sort((a, b) => b.name.localeCompare(a.name, "en", { numeric: true }))[0]
    ?.name.replace("models/", "");
if (!modelId) throw new Error("没有找到可用 Gemini Flash 模型。");
const resume = process.argv[process.argv.indexOf("--resume") + 1];
const resumeRoot = process.argv.includes("--resume")
  ? await realpath(resume!)
  : undefined;
if (
  resumeRoot &&
  (!path.basename(resumeRoot).startsWith("ytriple-product-probe-") ||
    path.dirname(resumeRoot) !== (await realpath(os.tmpdir())))
)
  throw new Error("只允许恢复本验收脚本的临时工作区。");
const root =
  resumeRoot ??
  (await realpath(
    await mkdtemp(path.join(os.tmpdir(), "ytriple-product-probe-")),
  ));
let service = new WorkbenchService(
  path.join(root, "data"),
  (p) => process.env[p.apiKeyEnv],
  () => {},
  { autoDigestRadar: false },
);
service.store.setConfig("settings", {
  ...service.store.settings(),
  aiRoot: path.join(root, "AI"),
  codeRoot: path.join(root, "Code"),
  workspaceRoot: path.join(root, "work"),
  projectMonitoring: false,
  libraryRecall: false,
  defaultProfileId: "probe",
  memberProfiles: {
    coordinator: "probe",
    researcher: "probe",
    cto: "probe",
    editor: "probe",
  },
  memberSettings: normalizeTeamSettings(undefined),
});
service.store.setConfig("profiles", [
  {
    id: "probe",
    name: "Gemini 产品闭环合成验收",
    provider: "gemini",
    protocol: "google",
    baseURL: "",
    modelId,
    apiKeyEnv: keyEnv,
    hasKey: true,
    status: "ready",
    capabilities: { text: true, tools: true, streaming: true },
  },
]);
const runs = new Map<string, Promise<void>>();
const original = service.runtime.run.bind(service.runtime);
service.runtime.run = (id) => {
  const run = original(id);
  runs.set(id, run);
  return run;
};
const watchdog = setTimeout(() => {
  void service.runtime.stopAll();
}, 360_000);
let closed = false;
try {
  let snapshot = await service.initialize();
  let taskId = snapshot.media?.works[0]?.taskLinks[0]?.taskId;
  if (!taskId) {
    snapshot = await service.execute({
      type: "media.channel.save",
      requestId: uid(),
      expectedRevision: 0,
      input: {
        name: "合成验收 · 工具观察",
        goal: "给独立创作者解释工具变化及证据限制",
        audience: "中文个人创作者",
        productionConditions:
          "30秒口播，本人录音；时长只按每分钟240字估算，未实际试读",
        expressionStandards:
          "每个数字保留适用条件；不推断总成本或收益；保留校验词 ORBIT_26",
        accounts: [],
        materials: [],
      },
    });
    const channel = snapshot.media!.channels[0]!;
    const materialId = uid(),
      variantId = uid();
    snapshot = await service.execute({
      type: "media.work.save",
      requestId: uid(),
      channelId: channel.id,
      expectedRevision: 0,
      input: {
        title: "合成工具降价是否代表制作成本减半",
        angle: "区别单次草稿生成标价和全部制作成本",
        format: "30秒口播",
        targetDate: "",
        variants: [
          {
            id: variantId,
            platform: "测试平台",
            language: "zh-CN",
            versionLabel: "中文口播 v1",
          },
        ],
        materials: [
          {
            id: materialId,
            title: "虚构公告与错误原稿",
            relation: "own",
            url: "",
            usageRights: "owned",
            text: "这是合成测试，不是真实市场事件。ORBIT_26。公告只说新用户前5次草稿生成价格由20降到10，没有成片成功率、剪辑工时和素材许可数据。错误原稿：所有用户总制作成本立刻减半，保证收益提高。",
          },
        ],
      },
    });
    const work = snapshot.media!.works[0]!;
    snapshot = await service.execute({
      type: "media.work.start",
      requestId: uid(),
      channelId: channel.id,
      workId: work.id,
      expectedRevision: work.revision,
      stage: "script",
      instruction:
        "本次验收要求分别实际 consult_researcher 核对数字条件、consult_editor 修订表达（各一次，各100字内，子成员不要再委派），再由主编整合保存一份300字内Markdown脚本。不要请求补充。保留 ORBIT_26，真实资料已经选入。不写成片已验证。",
      materialIds: [materialId],
      feedbackIds: [],
    });
    taskId = snapshot.media!.works[0]!.taskLinks[0]!.taskId;
  } else if (
    snapshot.tasks.find((t) => t.id === taskId)!.status !== "completed"
  ) {
    snapshot = await service.execute({ type: "task.run", taskId });
  }
  console.log(
    JSON.stringify({ stage: "media_started", root, taskId, modelId }),
  );
  if (snapshot.tasks.find((t) => t.id === taskId)!.status !== "completed") {
    assert.ok(runs.get(taskId));
    await runs.get(taskId);
  }
  snapshot = await service.snapshot();
  const task = snapshot.tasks.find((t) => t.id === taskId)!;
  assert.equal(task.status, "completed", task.error);
  assert.ok(
    task.events.some(
      (e) =>
        e.type === "delegation_completed" && e.data?.tool === "consult_editor",
    ),
    "内容编辑未实际贡献",
  );
  assert.ok(
    task.events.some(
      (e) =>
        e.type === "delegation_completed" &&
        e.data?.tool === "consult_researcher",
    ),
    "研究员未实际贡献",
  );
  assert.ok(
    task.events.some(
      (e) =>
        e.type === "text_measured" && Number(e.data?.estimatedSeconds) <= 30,
    ),
    "没有实际计量符合30秒约束的台词",
  );
  const artifact = task.artifacts.find(
    (a) => a.format === "md" && a.content?.includes("ORBIT_26"),
  );
  assert.ok(artifact, "媒体工作未保存带校验词的成果");
  snapshot = await service.execute({
    type: "delivery.register",
    requestId: uid(),
    taskId,
    artifactId: artifact.id,
    expectedHash: artifact.hash,
    spec: {
      recipient: "合成测试录音者",
      goal: "录制有依据的工具解读",
      criteria: "保留新用户前5次草稿适用条件，明确时长估算，删除成本收益保证",
      missing: "尚未试读和成片",
      plannedDate: new Date().toISOString().slice(0, 10),
    },
  });
  const delivery = snapshot.delivery!.records[0]!;
  snapshot = await service.execute({
    type: "delivery.check",
    requestId: uid(),
    deliveryId: delivery.id,
    expectedRevision: delivery.revision,
    sourceIds: [],
  });
  const checkId = snapshot.delivery!.records[0]!.works[0]!.taskId;
  console.log(JSON.stringify({ stage: "readiness_started", checkId }));
  await runs.get(checkId);
  snapshot = await service.snapshot();
  const check = snapshot.tasks.find((t) => t.id === checkId)!;
  assert.equal(check.status, "completed", check.error);
  assert.equal(check.isolatedContext, true);
  assert.equal(check.sources.length, 1, "独立检查混入额外背景");
  assert.ok(check.artifacts.length);
  assert.equal(
    snapshot.delivery!.records[0]!.status,
    "draft",
    "模型检查擅自推进真实交付状态",
  );
  snapshot = await service.execute({
    type: "routine.create",
    requestId: uid(),
    taskId,
    title: "合成更新检查",
    schedule: {
      kind: "change",
      pollMinutes: 60,
      timezone: "America/Los_Angeles",
    },
    limits: { maxRuns: 2, maxTokens: 100000 },
    watchTaskSources: true,
  });
  const routine = snapshot.routines!.items[0]!;
  const updated = await service.execute({
    type: "routine.run",
    requestId: uid(),
    routineId: routine.id,
  });
  assert.equal(
    updated.routines!.items[0]!.runs.at(-1)?.state,
    "unchanged",
    "无变化检查没有跳过模型",
  );
  const record = updated.delivery!.records[0]!;
  snapshot = await service.execute({
    type: "delivery.export",
    requestId: uid(),
    deliveryId: record.id,
    expectedRevision: record.revision,
  });
  assert.ok(snapshot.delivery!.records[0]!.exports.length);
  await service.close();
  closed = true;
  service = new WorkbenchService(
    path.join(root, "data"),
    (p) => process.env[p.apiKeyEnv],
    () => {},
    { autoDigestRadar: false },
  );
  closed = false;
  const reopened = await service.initialize();
  assert.equal(reopened.media!.works[0]!.taskLinks[0]!.taskId, taskId);
  assert.equal(reopened.delivery!.records[0]!.artifactHash, artifact.hash);
  assert.equal(reopened.routines!.items[0]!.id, routine.id);
  const report = {
    modelId,
    root,
    taskId,
    checkId,
    artifactId: artifact.id,
    content: artifact.content,
    readiness: check.artifacts.map((a) => a.content),
    members: task.events
      .filter(
        (e) =>
          e.type === "delegation_completed" &&
          String(e.data?.tool).startsWith("consult_"),
      )
      .map((e) => e.data?.tool),
    reopened: true,
    noChangeSkipped: true,
    evidenceScope:
      "真实模型、真实成员工具和合成材料；不表示真实发布、创作者效果或客户接收验收。",
  };
  await writeFile(
    path.join(root, "evidence.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  process.exitCode = 1;
  console.error(safeError(error));
} finally {
  clearTimeout(watchdog);
  if (!closed) await service.close();
  if (!process.argv.includes("--keep"))
    await rm(root, { recursive: true, force: true });
}
