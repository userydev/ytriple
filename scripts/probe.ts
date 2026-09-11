import { probeProfile, safeModelError } from "../src/core/models.js";
import { TeamRuntime, type RuntimeCheckpoint } from "../src/core/runtime.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Artifact, ModelProfile, Task } from "../src/shared/types.js";

async function teamProbe(profile: ModelProfile): Promise<void> {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "ytriple-synthetic-team-"),
  );
  const task: Task = {
    id: randomUUID(),
    title: "合成团队联调",
    kind: "research",
    member: "coordinator",
    goalVersion: 1,
    status: "idle",
    workspace,
    createdAt: "",
    updatedAt: "",
    events: [],
    messages: [],
    artifacts: [],
    goal: "这是合成联调。统筹必须调用研究员读取 source-synthetic 的完整内容并返回核查结果；再调用 CTO 审视这份样本的一条技术判断；然后根据两位成员真实返回的结果写一份简短 Markdown 成果，包含校验词 ORCHID_42 和验证结论。主回复只需一句完成总结。不要请求用户补充，不要联网或创建更深的专项团队。",
    sources: [
      {
        id: "source-synthetic",
        title: "合成资料",
        type: "text",
        location: "",
        addedAt: "",
        coverage: "完整合成样本",
        text: "校验词：ORCHID_42。合成项目拟用本地 SQLite 保存任务状态、Markdown 文件保存成果。这里不包含用户真实数据。",
      },
    ],
  };
  let checkpoint: RuntimeCheckpoint | undefined;
  const operations = new Map<string, Artifact>();
  const runtime = new TeamRuntime({
    getTask: () => task,
    getProfile: () => profile,
    readKey: (p) => process.env[p.apiKeyEnv],
    appendEvent: (_id, event) => {
      task.events.push({
        ...event,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
      });
    },
    addAssistantMessage: (_id, member, content, goalVersion) => {
      task.messages.push({
        id: randomUUID(),
        role: "assistant",
        member,
        content,
        goalVersion,
        createdAt: "",
      });
    },
    writeArtifact: async (_id, input) => {
      if (input.goalVersion !== task.goalVersion) throw new Error("目标已变更");
      const prior = operations.get(input.operationId);
      if (prior) return prior;
      const existing = task.artifacts.find((a) => a.id === input.artifactId);
      if (existing && existing.hash !== input.expectedHash)
        throw new Error("成果版本冲突");
      const artifact: Artifact = {
        id: existing?.id ?? randomUUID(),
        title: input.title,
        content: input.content,
        format: input.format,
        path: path.join(
          workspace,
          `artifact-${task.artifacts.length}.${input.format}`,
        ),
        goalVersion: 1,
        version: (existing?.version ?? 0) + 1,
        hash: createHash("sha256").update(input.content).digest("hex"),
        updatedAt: "",
        versions: [],
      };
      await writeFile(artifact.path, input.content, { mode: 0o600 });
      operations.set(input.operationId, artifact);
      if (existing)
        task.artifacts.splice(task.artifacts.indexOf(existing), 1, artifact);
      else task.artifacts.push(artifact);
      return artifact;
    },
    loadCheckpoint: () => checkpoint,
    saveCheckpoint: (_id, value) => {
      checkpoint = value ?? undefined;
    },
    setStatus: (_id, status, error) => {
      task.status = status;
      task.error = error;
    },
  });
  // Only this bounded smoke test has an overall deadline; ordinary work has request deadlines.
  const timeout = setTimeout(() => {
    void runtime.stop(task.id);
  }, 180_000);
  try {
    await runtime.run(task.id);
    const delegated = new Set(
      task.events
        .filter((e) => e.type === "delegation_completed")
        .map((e) => String(e.data?.tool)),
    );
    const passed =
      task.status === "completed" &&
      delegated.has("consult_researcher") &&
      delegated.has("consult_cto") &&
      task.artifacts.some((a) => a.content?.includes("ORCHID_42"));
    console.log(
      JSON.stringify({
        provider: profile.provider,
        modelId: profile.modelId,
        teamProbe: passed ? "passed" : "failed",
        status: task.status,
        delegatedTools: [...delegated],
        artifacts: task.artifacts.length,
        modelResponses: task.events.filter((e) => e.type === "model_usage")
          .length,
        error: task.error,
        syntheticOnly: true,
      }),
    );
    if (!passed) process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    await runtime.stopAll();
    await rm(workspace, { recursive: true, force: true });
  }
}

// This script sends synthetic test strings only. Credentials are never logged.
const selection = process.argv[2] ?? "gemini";
if (!["gemini", "deepseek", "ark", "all"].includes(selection)) {
  console.error("用法：npm run probe -- gemini|deepseek|ark|all [--team]");
  process.exitCode = 1;
} else {
  for (const provider of selection === "all"
    ? (["gemini", "deepseek", "ark"] as const)
    : [selection as "gemini" | "deepseek" | "ark"]) {
    try {
      let profile: ModelProfile;
      if (provider === "gemini") {
        const apiKeyEnv = process.env.GEMINI_API_KEY
          ? "GEMINI_API_KEY"
          : "GOOGLE_API_KEY";
        const key = process.env[apiKeyEnv];
        if (!key)
          throw new Error("Gemini 缺少 GEMINI_API_KEY / GOOGLE_API_KEY。");
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
            throw new Error(
              `Google models.list 返回 HTTP ${response.status}。`,
            );
          const body = (await response.json()) as {
            models?: { name: string; supportedGenerationMethods?: string[] }[];
          };
          const models = (body.models ?? []).filter((model) =>
            model.supportedGenerationMethods?.includes("generateContent"),
          );
          const stableFlash = models.filter((model) =>
            /gemini-[\d.]+-flash$/.test(model.name),
          );
          stableFlash.sort((a, b) =>
            b.name.localeCompare(a.name, "en", { numeric: true }),
          );
          modelId = (stableFlash[0] ?? models[0])?.name.replace(
            /^models\//,
            "",
          );
          if (!modelId)
            throw new Error(
              "当前 Google models.list 未返回可用的 generateContent 模型。",
            );
        }
        profile = {
          id: "probe-gemini",
          name: "Gemini",
          provider,
          protocol: "google",
          baseURL: "",
          modelId,
          apiKeyEnv,
          hasKey: true,
          status: "untested",
        };
      } else {
        const prefix = provider === "ark" ? "VOLCENGINE_ARK" : "DEEPSEEK";
        const apiKeyEnv = `${prefix}_API_KEY`;
        const modelId = process.env[`${prefix}_MODEL`] ?? "";
        const baseURL =
          process.env[`${prefix}_BASE_URL`] ??
          (provider === "deepseek" ? "https://api.deepseek.com/v1" : "");
        if (!process.env[apiKeyEnv] || !modelId || !baseURL)
          throw new Error(
            `${provider} 需要 ${prefix}_API_KEY、${prefix}_MODEL 和明确的 OpenAI 兼容 ${prefix}_BASE_URL。`,
          );
        profile = {
          id: `probe-${provider}`,
          name: provider,
          provider,
          protocol: "openai",
          baseURL,
          modelId,
          apiKeyEnv,
          hasKey: true,
          status: "untested",
        };
      }
      console.log(
        JSON.stringify({
          provider,
          modelId: profile.modelId,
          state: "testing",
          syntheticOnly: true,
        }),
      );
      const result = await probeProfile(
        profile,
        (p) => process.env[p.apiKeyEnv],
      );
      console.log(
        JSON.stringify({ provider, modelId: profile.modelId, ...result }),
      );
      if (
        !result.capabilities.text ||
        !result.capabilities.tools ||
        !result.capabilities.streaming
      )
        process.exitCode = 1;
      if (
        process.argv.includes("--team") &&
        result.capabilities.text &&
        result.capabilities.tools
      )
        await teamProbe({ ...profile, capabilities: result.capabilities });
    } catch (error) {
      console.error(JSON.stringify({ provider, error: safeModelError(error) }));
      process.exitCode = 1;
    }
  }
}
