/** Explicit real-provider probe. Uses a temporary account/database and synthetic material only. */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import OpenAI from "openai";
import { WorkServer } from "../services/work-service/server.js";
import { BUILTIN_SKILLS } from "../src/core/skills.js";

const apiKeyEnv = process.env.GEMINI_API_KEY
  ? "GEMINI_API_KEY"
  : "GOOGLE_API_KEY";
const keep = process.argv.includes("--keep");
let passed = false;
if (!process.env[apiKeyEnv]) throw new Error("缺少 Gemini 环境凭据。");
let modelId = process.env.GEMINI_MODEL;
if (!modelId) {
  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models",
    {
      headers: { "x-goog-api-key": process.env[apiKeyEnv]! },
      signal: AbortSignal.timeout(20000),
    },
  );
  if (!response.ok)
    throw new Error(`模型列表读取失败：HTTP ${response.status}`);
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
if (!modelId) throw new Error("没有可用的稳定 Flash 模型。");
const directory = await fs.mkdtemp(
  path.join(os.tmpdir(), "ytriple-real-work-service-"),
);
const username = "probe-user",
  password = randomBytes(24).toString("base64url");
const service = new WorkServer({
  directory,
  models: [
    {
      id: "gemini-service",
      name: `Gemini ${modelId}`,
      provider: "gemini",
      model: modelId,
      apiKeyEnv,
      tools: true,
    },
  ],
  tickMs: 10000,
});
service.store.provision(username, password, {
  plan: "temporary-real-probe",
  active: true,
  modelIds: ["gemini-service"],
  tokenLimit: 150000,
  maxConcurrent: 2,
});
const address = await service.listen(
  Number(process.env.WORK_PROBE_PORT ?? 8790),
);
assert.ok(address && typeof address !== "string");
const url = `http://127.0.0.1:${address.port}`;
const login = service.store.login(username, password, "临时真实探针");
const credentialsPath = path.join(directory, "desktop-login.json");
await fs.writeFile(
  credentialsPath,
  JSON.stringify(
    {
      url,
      username,
      password,
      token: login.token,
      deviceId: login.device.id,
      directory,
      pid: process.pid,
      modelId,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
process.stdout.write(`Temporary service login file: ${credentialsPath}\n`);
try {
  const client = new OpenAI({
    apiKey: login.token,
    baseURL: `${url}/v1`,
    maxRetries: 0,
  });
  const tool: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: "function",
    function: {
      name: "read_nonce",
      description:
        "Read the actual supplied synthetic nonce. You must call this tool before stating its value.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  };
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "user",
      content:
        "Call read_nonce and then quote exactly the nonce returned by the tool. Do not invent it.",
    },
  ];
  const first = await client.chat.completions.create({
    model: "gemini-service",
    messages,
    tools: [tool],
    tool_choice: { type: "function", function: { name: "read_nonce" } },
    max_tokens: 1024,
  });
  const call = first.choices[0]?.message.tool_calls?.[0];
  assert.ok(
    call && call.type === "function" && call.function.name === "read_nonce",
    "actual Gemini function call required",
  );
  const nonce = `ORCHID-${randomUUID()}`;
  const second = await client.chat.completions.create({
    model: "gemini-service",
    messages: [
      ...messages,
      first.choices[0]!.message,
      {
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify({ nonce }),
      },
    ],
    tools: [tool],
    tool_choice: "none",
    max_tokens: 1024,
    stream: true,
    stream_options: { include_usage: true },
  });
  let output = "",
    secondUsage = 0;
  for await (const chunk of second) {
    output += chunk.choices[0]?.delta.content ?? "";
    if (chunk.usage) secondUsage = chunk.usage.total_tokens;
  }
  assert.ok(output.includes(nonce), "actual tool result consumed by Gemini");
  const {
    source: _source,
    description: _description,
    ...method
  } = BUILTIN_SKILLS[0]!;
  const created = service.jobs.create(login.user.id, {
    requestId: "real-probe-job",
    model: "gemini-service",
    title: "合成资料远端委托",
    goal: "读取合成资料并生成简短中文Markdown，必须保留资料中的准确标记；明确这里只验证合成材料。",
    materials: [
      {
        id: "synthetic-source",
        title: "合成材料",
        text: `Synthetic evidence: ${nonce}. This is artificial test data, not a real measurement.`,
        coverage: "全文",
      },
    ],
    skills: [method],
    limits: { maxRuns: 1, maxTokens: 20000 },
  });
  await service.jobs.tick();
  const job = service.store.job(login.user.id, created.job.id);
  assert.equal(job.state, "completed", job.lastError);
  assert.ok(
    job.result?.includes(nonce),
    "remote job keeps real supplied evidence",
  );
  const evidence = {
    capturedAt: new Date().toISOString(),
    modelId,
    provider: "gemini",
    route: "Google official OpenAI-compatible endpoint through work-service",
    syntheticOnly: true,
    toolCall: {
      actual: true,
      name: "read_nonce",
      consumedExactNonce: true,
      firstUsage: first.usage,
      secondUsage,
      streamingMode: "buffered",
    },
    job: {
      id: job.id,
      state: job.state,
      tokens: job.tokens,
      exactMaterialPreserved: true,
      methodHash: method.hash,
    },
    accountUsage: service.store.account(login.user.id).usage,
  };
  const evidencePath = path.join(directory, "probe-evidence.json");
  await fs.writeFile(evidencePath, JSON.stringify(evidence, null, 2), {
    mode: 0o600,
  });
  process.stdout.write(
    `Real work-service probe passed. Evidence: ${evidencePath}\n`,
  );
  passed = true;
} catch (error) {
  process.stdout.write(
    `Real work-service probe failed: ${error instanceof Error ? error.message.replace(/Bearer\s+\S+/g, "Bearer [redacted]") : "unknown failure"}\n`,
  );
}
if (!keep) {
  await service.close();
  await fs.rm(credentialsPath, { force: true });
  process.exitCode = passed ? 0 : 1;
} else
  process.stdout.write(
    "Temporary service remains available for desktop verification; terminate this process after review.\n",
  );
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void service.close().finally(() => process.exit(passed ? 0 : 1));
  });
