import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { WorkServer } from "./server.js";
import type { WorkJob, WorkLoginResponse } from "./contract.js";
import { BUILTIN_SKILLS } from "../../src/core/skills.js";

async function fixture(
  t: { after(fn: () => unknown): void },
  providerFetch?: typeof fetch,
) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "ytriple-work-service-"),
  );
  let calls = 0;
  const received: Record<string, unknown>[] = [];
  let waiting: (() => void) | undefined;
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    calls++;
    received.push(input);
    assert.equal(
      req.headers.authorization,
      "Bearer private-synthetic-upstream-key",
    );
    const text = JSON.stringify(input.messages);
    if (text.includes("WAIT_PROVIDER"))
      await new Promise<void>((resolve) => {
        waiting = resolve;
      });
    if (text.includes("FAIL_PROVIDER")) {
      res.writeHead(500);
      res.end("private-synthetic-upstream-key");
      return;
    }
    const hasToolOutput = input.messages.some(
      (message: { role: string }) => message.role === "tool",
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: `upstream-${calls}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: input.model,
        choices: [
          {
            index: 0,
            message:
              input.tools?.length && !hasToolOutput
                ? {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "call-read-1",
                        type: "function",
                        function: {
                          name: "read_source",
                          arguments: '{"sourceId":"source-1"}',
                        },
                      },
                    ],
                  }
                : {
                    role: "assistant",
                    content: `# 真实合成HTTP输出\n${text.includes("ORCHID 43") ? "ORCHID 43" : "ORCHID 42"}${hasToolOutput ? "（已消费工具结果）" : ""}`,
                  },
            finish_reason:
              input.tools?.length && !hasToolOutput ? "tool_calls" : "stop",
          },
        ],
        ...(text.includes("OMIT_USAGE")
          ? {}
          : {
              usage: {
                prompt_tokens: 20,
                completion_tokens: 30,
                total_tokens: 50,
              },
            }),
      }),
    );
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const upAddress = upstream.address();
  assert.ok(upAddress && typeof upAddress !== "string");
  const options = {
    directory,
    allowHttpUpstream: true,
    models: [
      {
        id: "service-model",
        name: "合成模型",
        provider: "openai" as const,
        model: "private-model",
        apiKeyEnv: "TEST_UPSTREAM",
        tools: true,
        baseURL: `http://127.0.0.1:${upAddress.port}/v1`,
      },
    ],
    readKey: () => "private-synthetic-upstream-key",
    tickMs: 1000000,
    requestTimeoutMs: 5000,
    fetch: providerFetch,
  };
  let service = new WorkServer(options);
  service.store.provision("alice", "alice-password-1234", {
    plan: "admin-test",
    active: true,
    modelIds: ["service-model"],
    tokenLimit: 2000000,
    maxConcurrent: 2,
  });
  service.store.provision("bob", "bob-password-123456", {
    plan: "admin-test",
    active: true,
    modelIds: ["service-model"],
    tokenLimit: 2000000,
    maxConcurrent: 2,
  });
  let baseURL = "";
  async function listen() {
    const address = await service.listen(0);
    assert.ok(address && typeof address !== "string");
    baseURL = `http://127.0.0.1:${address.port}`;
  }
  await listen();
  const request = async (
    method: string,
    route: string,
    token?: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => {
    const response = await fetch(`${baseURL}${route}`, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    return { status: response.status, body: result };
  };
  const login = async (username = "alice", deviceName = "测试设备") => {
    const response = await request("POST", "/v1/auth/login", undefined, {
      username,
      password:
        username === "alice" ? "alice-password-1234" : "bob-password-123456",
      deviceName,
    });
    assert.equal(response.status, 200);
    return response.body as WorkLoginResponse;
  };
  t.after(async () => {
    waiting?.();
    await service.close();
    await new Promise<void>((resolve) => {
      upstream.close(() => resolve());
      upstream.closeAllConnections();
    });
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    request,
    login,
    calls: () => calls,
    received,
    service: () => service,
    url: () => baseURL,
    release: () => waiting?.(),
    isWaiting: () => !!waiting,
    reopen: async () => {
      await service.close();
      service = new WorkServer(options);
      await listen();
    },
  };
}

test("device login, revocation, logout, model capabilities and tenant data remain separate", async (t) => {
  const f = await fixture(t),
    alice = await f.login(),
    bob = await f.login("bob");
  assert.equal((await f.request("GET", "/v1/account")).status, 401);
  const models = await f.request("GET", "/v1/models", alice.token);
  assert.equal(models.body.data[0].capabilities.tools, true);
  assert.equal(models.body.data[0].streamingMode, "buffered");
  assert.doesNotMatch(
    JSON.stringify(models.body),
    /private-synthetic-upstream-key|TEST_UPSTREAM|baseURL/,
  );
  const created = await f.request("POST", "/v1/jobs", alice.token, {
    requestId: "alice-job",
    model: "service-model",
    title: "Alice资料",
    goal: "整理",
    materials: [{ id: "one", title: "资料", text: "ORCHID 42" }],
  });
  assert.equal(created.status, 202);
  assert.equal(
    (await f.request("GET", `/v1/jobs/${created.body.job.id}`, bob.token))
      .status,
    404,
  );
  assert.equal(
    (await f.request("GET", "/v1/jobs", bob.token)).body.jobs.length,
    0,
  );
  const devices = (await f.request("GET", "/v1/devices", alice.token)).body
    .devices;
  assert.equal(devices.length, 1);
  assert.equal(devices[0].current, true);
  await f.request("DELETE", `/v1/devices/${alice.device.id}`, bob.token);
  assert.equal(
    (await f.request("GET", "/v1/account", alice.token)).status,
    200,
  );
  await f.request("DELETE", `/v1/devices/${alice.device.id}`, alice.token);
  assert.equal(
    (await f.request("GET", "/v1/account", alice.token)).status,
    401,
  );
  await f.request("POST", "/v1/auth/logout", bob.token);
  assert.equal((await f.request("GET", "/v1/account", bob.token)).status, 401);
});

test("official OpenAI SDK consumes real tool calls and buffered SSE and returns tool output through the service", async (t) => {
  const f = await fixture(t),
    alice = await f.login();
  const sdk = new OpenAI({
    apiKey: alice.token,
    baseURL: `${f.url()}/v1`,
    maxRetries: 0,
  });
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "user", content: "读取 ORCHID 42" },
  ];
  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
      type: "function",
      function: {
        name: "read_source",
        parameters: {
          type: "object",
          properties: { sourceId: { type: "string" } },
          required: ["sourceId"],
        },
      },
    },
  ];
  const stream = await sdk.chat.completions.create({
    model: "service-model",
    messages,
    tools,
    stream: true,
    stream_options: { include_usage: true },
  });
  let toolCall: { id?: string; function?: { arguments?: string } } | undefined,
    usage = 0;
  for await (const chunk of stream) {
    if (chunk.choices[0]?.delta.tool_calls?.[0])
      toolCall = chunk.choices[0].delta.tool_calls[0];
    if (chunk.usage) usage = chunk.usage.total_tokens;
  }
  assert.equal(toolCall?.id, "call-read-1");
  assert.deepEqual(
    (toolCall?.function as { arguments: string }).arguments,
    '{"sourceId":"source-1"}',
  );
  assert.equal(usage, 50);
  const result = await sdk.chat.completions.create({
    model: "service-model",
    tools,
    messages: [
      ...messages,
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-read-1",
            type: "function",
            function: {
              name: "read_source",
              arguments: '{"sourceId":"source-1"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-read-1",
        content: "实际合成工具结果：ORCHID 42",
      },
    ],
  });
  assert.match(result.choices[0]!.message.content!, /已消费工具结果/);
  assert.equal(f.calls(), 2);
  const account = await f.request("GET", "/v1/account", alice.token);
  assert.equal(account.body.usage.usedTokens, 100);
  assert.equal(account.body.usage.reservedTokens, 0);
  assert.equal(f.received[0]!.model, "private-model");
});

test("upstream destinations cannot be overridden, quota is enforced, and idempotent completions do not repeat charges", async (t) => {
  const f = await fixture(t),
    alice = await f.login();
  const input = {
    model: "service-model",
    messages: [{ role: "user", content: "ORCHID 42" }],
    max_tokens: 100,
  };
  assert.equal(
    (
      await f.request("POST", "/v1/chat/completions", alice.token, {
        ...input,
        baseURL: "http://attacker.test",
      })
    ).status,
    400,
  );
  const first = await f.request(
    "POST",
    "/v1/chat/completions",
    alice.token,
    input,
    { "Idempotency-Key": "same-request" },
  );
  const second = await f.request(
    "POST",
    "/v1/chat/completions",
    alice.token,
    input,
    { "Idempotency-Key": "same-request" },
  );
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, second.body);
  assert.equal(f.calls(), 1);
  const account = f.service().store.account(alice.user.id);
  f.service()
    .store.db.prepare("UPDATE accounts SET entitlement=? WHERE id=?")
    .run(
      JSON.stringify({ ...account.entitlement, tokenLimit: 50 }),
      alice.user.id,
    );
  assert.equal(
    (await f.request("POST", "/v1/chat/completions", alice.token, input))
      .status,
    429,
  );
  assert.equal(f.calls(), 1);
});

test("supplied-material jobs lock methods, dedupe input changes and survive server restart without replaying uncertain requests", async (t) => {
  const f = await fixture(t),
    alice = await f.login();
  const {
    source: _source,
    description: _description,
    ...method
  } = BUILTIN_SKILLS[0]!;
  const input = {
    requestId: "change-job",
    model: "service-model",
    title: "资料检查",
    goal: "整理材料",
    materials: [{ id: "source-1", title: "资料", text: "ORCHID 42" }],
    skills: [method],
    schedule: { kind: "change" },
    limits: { maxRuns: 4, maxTokens: 50000 },
  };
  const first = await f.request("POST", "/v1/jobs", alice.token, input);
  const duplicate = await f.request("POST", "/v1/jobs", alice.token, input);
  assert.equal(first.body.job.id, duplicate.body.job.id);
  const id = first.body.job.id;
  await Promise.all([f.service().jobs.tick(), f.service().jobs.tick()]);
  assert.equal(f.calls(), 1);
  const completed = (await f.request("GET", `/v1/jobs/${id}`, alice.token)).body
    .job as WorkJob;
  assert.equal(completed.state, "waiting");
  assert.equal(completed.tokens, 50);
  assert.equal(completed.skills[0]?.hash, method.hash);
  await f.request("PATCH", `/v1/jobs/${id}`, alice.token, {
    requestId: "unchanged",
    expectedVersion: 1,
    materials: input.materials,
  });
  await f.service().jobs.tick();
  assert.equal(f.calls(), 1);
  await f.request("PATCH", `/v1/jobs/${id}`, alice.token, {
    requestId: "changed",
    expectedVersion: 2,
    materials: [{ id: "source-1", title: "资料", text: "ORCHID 43" }],
  });
  await f.service().jobs.tick();
  assert.equal(f.calls(), 2);
  const job = f.service().store.job(alice.user.id, id);
  job.state = "running";
  job.runs.push({
    id: "unknown",
    version: job.version,
    startedAt: new Date().toISOString(),
    state: "running",
    inputHash: "unknown",
    meaningful: false,
  });
  f.service().store.saveJob(alice.user.id, job);
  await f.reopen();
  await f.service().jobs.tick();
  const restored = (await f.request("GET", `/v1/jobs/${id}`, alice.token)).body
    .job;
  assert.equal(restored.state, "uncertain");
  assert.equal(restored.runs.at(-1).state, "uncertain");
  assert.equal(f.calls(), 2);
});

test("relative jobs require real publication and preserve no-change checks, export and content cleanup remain tenant-scoped", async (t) => {
  const f = await fixture(t),
    alice = await f.login(),
    bob = await f.login("bob");
  const created = await f.request("POST", "/v1/jobs", alice.token, {
    requestId: "node-job",
    model: "service-model",
    title: "发布后复盘",
    goal: "复盘实际反馈",
    materials: [{ id: "m", title: "反馈", text: "ORCHID 42" }],
    schedule: { kind: "after_node", delayMinutes: 60, timezone: "UTC" },
  });
  assert.equal(created.status, 202);
  const id = created.body.job.id;
  await f.service().jobs.tick(new Date(Date.now() + 3 * 86400000));
  assert.equal(f.calls(), 0);
  const future = await f.request("PATCH", `/v1/jobs/${id}`, alice.token, {
    requestId: "future",
    expectedVersion: 1,
    node: {
      occurredAt: new Date(Date.now() + 86400000).toISOString(),
      evidence: "计划",
      actual: true,
    },
  });
  assert.equal(future.status, 400);
  await f.request("PATCH", `/v1/jobs/${id}`, alice.token, {
    requestId: "actual",
    expectedVersion: 1,
    node: {
      occurredAt: new Date(Date.now() - 2 * 3600000).toISOString(),
      evidence: "实际发布页面",
      actual: true,
    },
  });
  await f.service().jobs.tick();
  assert.equal(f.calls(), 1);
  const exported = await f.request("GET", "/v1/export", alice.token);
  assert.equal(exported.body.jobs.length, 1);
  assert.doesNotMatch(
    JSON.stringify(exported.body),
    /private-synthetic-upstream-key|password|token_hash/,
  );
  assert.equal(
    (await f.request("GET", "/v1/export", bob.token)).body.jobs.length,
    0,
  );
  await f.request("DELETE", "/v1/data", alice.token, {
    confirm: "delete-my-data",
  });
  assert.equal(
    (await f.request("GET", "/v1/jobs", alice.token)).body.jobs.length,
    0,
  );
  assert.equal(
    (await f.request("GET", "/v1/account", alice.token)).body.usage.usedTokens,
    50,
  );
});

test("cancelling an active remote job stops future schedules, hides upstream errors and never retries unknown usage", async (t) => {
  const f = await fixture(t),
    alice = await f.login();
  const created = await f.request("POST", "/v1/jobs", alice.token, {
    requestId: "cancel-job",
    model: "service-model",
    title: "取消测试",
    goal: "WAIT_PROVIDER",
    materials: [{ id: "m", title: "资料", text: "ORCHID 42" }],
  });
  const id = created.body.job.id,
    running = f.service().jobs.tick();
  while (!f.isWaiting()) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(
    (
      await f.request("PATCH", `/v1/jobs/${id}`, alice.token, {
        requestId: "edit-running",
        expectedVersion: 1,
        goal: "new",
      })
    ).status,
    409,
  );
  await f.request("POST", `/v1/jobs/${id}/cancel`, alice.token, {
    requestId: "cancel",
  });
  f.release();
  await running;
  assert.equal(
    (await f.request("GET", `/v1/jobs/${id}`, alice.token)).body.job.state,
    "cancelled",
  );
  await f.service().jobs.tick(new Date(Date.now() + 86400000));
  assert.equal(f.calls(), 1);
  const failure = await f.request(
    "POST",
    "/v1/chat/completions",
    alice.token,
    {
      model: "service-model",
      messages: [{ role: "user", content: "FAIL_PROVIDER" }],
    },
    { "Idempotency-Key": "failure" },
  );
  assert.equal(failure.status, 502);
  assert.doesNotMatch(
    JSON.stringify(failure.body),
    /private-synthetic-upstream-key/,
  );
  const repeat = await f.request(
    "POST",
    "/v1/chat/completions",
    alice.token,
    {
      model: "service-model",
      messages: [{ role: "user", content: "FAIL_PROVIDER" }],
    },
    { "Idempotency-Key": "failure" },
  );
  assert.equal(repeat.status, 409);
  assert.equal(f.calls(), 2);
  const account = (await f.request("GET", "/v1/account", alice.token)).body;
  assert.ok(account.usage.reservedTokens > 0);
  assert.ok(account.usage.unknownRequests > 0);
});

test("account cleanup blocks concurrent work and stale request bodies, discards late results, and preserves usage without affecting another tenant", async (t) => {
  const releases = new Map<string, () => void>();
  const delayedFetch: typeof fetch = async (input, init) => {
    // Model responses can arrive even when cancellation cannot stop upstream execution.
    const response = await fetch(input, { ...init, signal: undefined });
    const marker = String(init?.body).includes("CLEAR_JOB")
      ? "job"
      : String(init?.body).includes("CLEAR_CHAT")
        ? "chat"
        : undefined;
    if (marker)
      await new Promise<void>((resolve) => releases.set(marker, resolve));
    return response;
  };
  t.after(() => {
    for (const release of releases.values()) release();
  });
  const f = await fixture(t, delayedFetch),
    alice = await f.login(),
    bob = await f.login("bob");
  const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!condition()) {
      assert.ok(
        Date.now() < deadline,
        "controlled concurrency point did not arrive",
      );
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  };
  const jobInput = {
    requestId: "clear-job",
    model: "service-model",
    title: "删除材料",
    goal: "CLEAR_JOB",
    materials: [{ id: "m", title: "私有材料", text: "ORCHID 42" }],
  };
  const first = await f.request("POST", "/v1/jobs", alice.token, jobInput);
  const jobRunning = f.service().jobs.tick();
  await waitFor(() => releases.has("job"));
  const chatInput = {
    model: "service-model",
    messages: [{ role: "user", content: "CLEAR_CHAT" }],
  };
  const chatRunning = f.request(
    "POST",
    "/v1/chat/completions",
    alice.token,
    chatInput,
    { "Idempotency-Key": "clear-chat" },
  );
  await waitFor(() => releases.has("chat"));
  const queued = await f.request("POST", "/v1/jobs", alice.token, {
    ...jobInput,
    requestId: "clear-queued",
    goal: "queued-only",
  });

  const slowRequest = async (route: string, payload: unknown) => {
    let finish!: () => void;
    const entered = new Promise<void>((resolve) =>
      f.service().server.once("request", () => resolve()),
    );
    const result = new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        `${f.url()}${route}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${alice.token}`,
            "Content-Type": "application/json",
          },
        },
        (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode!));
        },
      );
      request.once("error", reject);
      const encoded = JSON.stringify(payload);
      request.write(encoded.slice(0, 1));
      finish = () => request.end(encoded.slice(1));
      t.after(() => request.destroy());
    });
    await entered;
    return { finish, result };
  };
  const staleJob = await slowRequest("/v1/jobs", {
    ...jobInput,
    requestId: "stale-job",
  });
  const staleChat = await slowRequest("/v1/chat/completions", chatInput);
  const clearing = f.request("DELETE", "/v1/data", alice.token, {
    confirm: "delete-my-data",
  });
  await waitFor(() => f.service().store.isDataClearing(alice.user.id));
  const before = f.calls();
  assert.equal(
    (
      await f.request("POST", "/v1/jobs", alice.token, {
        ...jobInput,
        requestId: "during-clear",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.request("PATCH", `/v1/jobs/${queued.body.job.id}`, alice.token, {
        requestId: "edit-during-clear",
        expectedVersion: 1,
        goal: "new",
      })
    ).status,
    409,
  );
  assert.equal(
    (await f.request("POST", "/v1/chat/completions", alice.token, chatInput))
      .status,
    409,
  );
  assert.equal(
    (
      await f.request("DELETE", "/v1/data", alice.token, {
        confirm: "delete-my-data",
      })
    ).status,
    409,
  );
  await assert.rejects(
    f
      .service()
      .gateway.complete(alice.user.id, chatInput, "internal-during-clear"),
    /清理/,
  );
  assert.equal(f.calls(), before);
  // The first run settles while another remains in flight. A fresh tick still cannot run queued work.
  releases.get("job")!();
  await jobRunning;
  await f.service().jobs.tick();
  assert.equal(f.calls(), before);
  const otherTenant = await f.request(
    "POST",
    "/v1/chat/completions",
    bob.token,
    {
      model: "service-model",
      messages: [{ role: "user", content: "unaffected" }],
    },
  );
  assert.equal(otherTenant.status, 200);
  releases.get("chat")!();
  const [deleted, lateChat] = await Promise.all([clearing, chatRunning]);
  assert.equal(deleted.status, 200);
  assert.equal(lateChat.status, 409);
  assert.doesNotMatch(JSON.stringify(lateChat.body), /ORCHID/);
  staleJob.finish();
  staleChat.finish();
  assert.equal(await staleJob.result, 409);
  assert.equal(await staleChat.result, 409);
  assert.equal(f.calls(), before + 1);
  assert.equal(
    (await f.request("GET", "/v1/jobs", alice.token)).body.jobs.length,
    0,
  );
  assert.equal(
    (await f.request("GET", `/v1/jobs/${first.body.job.id}`, alice.token))
      .status,
    404,
  );
  assert.equal(
    (await f.request("GET", "/v1/account", alice.token)).body.usage.usedTokens,
    100,
  );
  assert.equal(
    (await f.request("GET", "/v1/account", bob.token)).body.usage.usedTokens,
    50,
  );
  const records = f
    .service()
    .store.db.prepare("SELECT result FROM usage WHERE owner=?")
    .all(alice.user.id);
  assert.ok(
    records.length === 2 && records.every((entry) => entry.result === null),
  );
  assert.equal(
    (await f.request("POST", "/v1/jobs", alice.token, jobInput)).status,
    409,
  );
  assert.equal(
    (
      await f.request("POST", "/v1/chat/completions", alice.token, chatInput, {
        "Idempotency-Key": "clear-chat",
      })
    ).status,
    409,
  );
  await f.reopen();
  await f.service().jobs.tick();
  assert.equal(f.calls(), before + 1);
  assert.equal(
    (await f.request("GET", "/v1/export", alice.token)).body.jobs.length,
    0,
  );
  assert.equal(
    (
      await f.request("POST", "/v1/jobs", alice.token, {
        ...jobInput,
        requestId: "new-explicit-request",
        goal: "new work",
      })
    ).status,
    202,
  );
});

test("restarting during a durable account cleanup removes queued work and cached bodies before any scheduling, while uncertain usage remains reserved", async (t) => {
  const f = await fixture(t),
    alice = await f.login(),
    bob = await f.login("bob");
  const input = {
    requestId: "interrupted-clear",
    model: "service-model",
    title: "清理中断",
    goal: "整理",
    materials: [{ id: "m", title: "私有材料", text: "ORCHID 42" }],
  };
  await f.request("POST", "/v1/jobs", alice.token, input);
  await f.request("POST", "/v1/jobs", bob.token, input);
  f.service()
    .store.db.prepare(
      "INSERT INTO usage(id,owner,request_id,fingerprint,model,state,reserved,result,created_at) VALUES(?,?,?,?,?,'pending',?, ?,?)",
    )
    .run(
      randomUUID(),
      alice.user.id,
      "unknown-before-clear",
      "hash",
      "service-model",
      800,
      "private cached body",
      new Date().toISOString(),
    );
  f.service().store.beginDataCleanup(
    alice.user.id,
    f.service().store.dataEpoch(alice.user.id),
  );
  await f.reopen();
  assert.equal(f.service().store.isDataClearing(alice.user.id), false);
  assert.equal(f.service().store.jobs(alice.user.id).length, 0);
  assert.equal(f.service().store.jobs(bob.user.id).length, 1);
  const account = (await f.request("GET", "/v1/account", alice.token)).body;
  assert.equal(account.usage.unknownRequests, 1);
  assert.equal(account.usage.reservedTokens, 800);
  const cached = f
    .service()
    .store.db.prepare("SELECT result FROM usage WHERE owner=?")
    .get(alice.user.id);
  assert.equal(cached?.result, null);
  assert.equal(
    (await f.request("POST", "/v1/jobs", alice.token, input)).status,
    409,
  );
  await f.service().jobs.tick();
  assert.equal(f.calls(), 1);
  assert.equal(f.service().store.jobs(alice.user.id).length, 0);
});
