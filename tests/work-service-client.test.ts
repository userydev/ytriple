import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WorkServer } from "../services/work-service/server.js";
import { WorkServiceClient } from "../src/core/work-service.js";
import {
  WorkGateway,
  loginWorkService,
  keyForWorkProfile,
  workProfileId,
  type WorkConnection,
} from "../src/core/work-gateway.js";
import { Store } from "../src/core/store.js";
import { hash, writeArtifact } from "../src/core/files.js";
import { BUILTIN_SKILLS } from "../src/core/skills.js";
import type { FeatureHost } from "../src/core/feature-host.js";
import type { Task, ModelProfile } from "../src/shared/types.js";

async function fixture(t: { after(fn: () => unknown): void }) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ytriple-client-service-"),
  );
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8")),
      text = JSON.stringify(input.messages);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        id: randomUUID(),
        object: "chat.completion",
        created: 1,
        model: "synthetic",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: `# 合成结果\n${text.includes("ORCHID 43") ? "ORCHID 43" : "ORCHID 42"}`,
            },
            finish_reason: "stop",
          },
        ],
        ...(text.includes("UNKNOWN_USAGE")
          ? {}
          : {
              usage: {
                prompt_tokens: 10,
                completion_tokens: 20,
                total_tokens: 30,
              },
            }),
      }),
    );
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
  const service = new WorkServer({
    directory: path.join(root, "server"),
    models: [
      {
        id: "model-1",
        name: "合成服务模型",
        provider: "openai",
        model: "synthetic",
        apiKeyEnv: "TEST_KEY",
        tools: true,
        baseURL: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      },
    ],
    allowHttpUpstream: true,
    readKey: () => "synthetic-upstream-key",
    tickMs: 1000000,
  });
  for (const name of ["alice", "bob"])
    service.store.provision(name, `${name}-password-123456`, {
      plan: "test",
      active: true,
      modelIds: ["model-1"],
      tokenLimit: 2000000,
      maxConcurrent: 2,
    });
  const address = await service.listen(0);
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const alice = await loginWorkService(url, {
    username: "alice",
    password: "alice-password-123456",
    deviceName: "client-test",
  });
  const bob = await loginWorkService(url, {
    username: "bob",
    password: "bob-password-123456",
    deviceName: "client-test",
  });
  const store = new Store(path.join(root, "client"));
  store.setConfig("settings", {
    ...store.settings(),
    workspaceRoot: path.join(root, "work"),
    aiRoot: path.join(root, "AI"),
    codeRoot: path.join(root, "Code"),
  });
  const task: Task = {
    id: "original",
    title: "原说明",
    goal: "整理合成资料",
    goalVersion: 1,
    member: "coordinator",
    kind: "research",
    status: "completed",
    workspace: path.join(root, "work", "original"),
    createdAt: "",
    updatedAt: "",
    messages: [],
    artifacts: [],
    events: [],
    skillPins: structuredClone(BUILTIN_SKILLS),
    skillBindings: structuredClone(BUILTIN_SKILLS),
    sources: [
      {
        id: "source-1",
        title: "明确选择的资料",
        text: "ORCHID 42",
        type: "text",
        location: "/never-upload-this-path",
        addedAt: "",
        coverage: "全文",
      },
      {
        id: "source-2",
        title: "不应上传",
        text: "LOCAL_ONLY_NONSELECTED",
        type: "text",
        location: "",
        addedAt: "",
        coverage: "全文",
      },
    ],
  };
  store.saveTask(task);
  const host: FeatureHost = {
    store,
    addSource: async () => undefined,
    runWork: async () => undefined,
    stopWork: async () => undefined,
    isRunning: () => false,
    createWork: async (input) => {
      const work = {
        ...structuredClone(task),
        id: randomUUID(),
        title: input.title,
        goal: input.goal,
        sources: input.sources ?? [],
        artifacts: [],
        events: [],
        workspace: path.join(root, "work", randomUUID()),
      };
      store.saveTask(work);
      return work;
    },
  };
  const client = new WorkServiceClient(host);
  await client.connect(new WorkGateway(alice));
  t.after(async () => {
    await client.close();
    store.close();
    await service.close();
    await new Promise<void>((resolve) => {
      upstream.close(() => resolve());
      upstream.closeAllConnections();
    });
    await fs.rm(root, { recursive: true, force: true });
  });
  const create = async () => {
    await client.execute({
      type: "service.job.create",
      requestId: randomUUID(),
      taskId: task.id,
      modelId: "model-1",
      sourceIds: ["source-1"],
      skillIds: ["material-digest"],
      schedule: "change",
      maxRuns: 10,
      maxTokens: 100000,
    });
    return client.snapshot().jobs.at(-1)!;
  };
  return { root, service, store, task, host, client, alice, bob, url, create };
}

test("client uploads only selected material and fixed methods, receives real remote output into its locally recorded original task", async (t) => {
  const f = await fixture(t),
    job = await f.create();
  assert.equal(f.client.snapshot().state, "connected");
  assert.deepEqual(
    job.materials.map((item) => item.id),
    ["source-1"],
  );
  assert.equal(job.materials[0]?.hash, hash("ORCHID 42"));
  assert.equal(job.skills[0]?.hash, BUILTIN_SKILLS[0]?.hash);
  assert.doesNotMatch(
    JSON.stringify(job),
    /LOCAL_ONLY_NONSELECTED|never-upload-this-path/,
  );
  await f.service.jobs.tick();
  await f.client.refresh();
  await Promise.all([
    f.client.execute({
      type: "service.job.collect",
      requestId: randomUUID(),
      jobId: job.id,
    }),
    f.client.execute({
      type: "service.job.collect",
      requestId: randomUUID(),
      jobId: job.id,
    }),
  ]);
  const collected = f.client.snapshot().collected[job.id]!;
  assert.equal(collected.taskId, f.task.id);
  assert.equal(f.store.tasks().length, 1);
  assert.equal(f.store.task(f.task.id).artifacts.length, 1);
  assert.ok(collected.artifactHash);
  assert.equal(f.client.snapshot().account?.usage.usedTokens, 30);
  const stored = JSON.stringify(
    f.store.db.prepare("SELECT body FROM config").all(),
  );
  assert.ok(!stored.includes(f.alice.token));
  assert.doesNotMatch(stored, /alice-password|synthetic-upstream-key/);
});

test("a later remote version cannot overwrite a locally edited collected artifact", async (t) => {
  const f = await fixture(t),
    job = await f.create();
  await f.service.jobs.tick();
  await f.client.execute({
    type: "service.job.collect",
    requestId: randomUUID(),
    jobId: job.id,
  });
  const collected = f.client.snapshot().collected[job.id]!;
  const local = await writeArtifact(f.store, f.task.id, {
    artifactId: collected.artifactId,
    expectedHash: collected.artifactHash,
    title: "用户修订",
    content: "用户的手动修订需要保留",
    format: "md",
    goalVersion: 1,
  });
  f.store.updateTask(f.task.id, (task) => {
    task.sources[0]!.text = "ORCHID 43";
  });
  await f.client.execute({
    type: "service.job.update",
    requestId: randomUUID(),
    jobId: job.id,
    expectedVersion: job.version,
    taskId: f.task.id,
    sourceIds: ["source-1"],
  });
  await f.service.jobs.tick();
  await assert.rejects(
    f.client.execute({
      type: "service.job.collect",
      requestId: randomUUID(),
      jobId: job.id,
    }),
    /改变|变化|冲突|修改/,
  );
  assert.equal(f.store.task(f.task.id).artifacts[0]?.hash, local.hash);
});

test("switching accounts during an old refresh never imports the old account or blocks the new refresh", async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const old = new WorkGateway(f.alice),
    original = old.request.bind(old);
  old.request = async <T>(route: string): Promise<T> => {
    const value = await original<T>(route);
    await blocked;
    return value;
  };
  const connecting = f.client.connect(old);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await f.client.connect(new WorkGateway(f.bob));
  assert.equal(f.client.snapshot().account?.user.id, f.bob.user.id);
  release();
  await connecting;
  assert.equal(f.client.snapshot().account?.user.id, f.bob.user.id);
  assert.deepEqual(f.client.snapshot().jobs, []);
});

test("client validates deep responses and reports unknown usage without treating it as zero", async (t) => {
  const f = await fixture(t);
  f.store.updateTask(f.task.id, (task) => {
    task.sources[0]!.text = "ORCHID 42 UNKNOWN_USAGE";
  });
  const job = await f.create();
  await f.service.jobs.tick();
  await f.client.refresh();
  assert.equal(f.client.snapshot().jobs[0]?.state, "uncertain");
  assert.ok(f.client.snapshot().account!.usage.unknownRequests > 0);
  assert.ok(f.client.snapshot().account!.usage.reservedTokens > 0);
  const malformed = new WorkGateway(f.alice),
    original = malformed.request.bind(malformed);
  malformed.request = async <T>(route: string): Promise<T> =>
    route === "/v1/jobs"
      ? ({
          jobs: [
            {
              ...f.service.store.job(f.alice.user.id, job.id),
              materials: "not-an-array",
            },
          ],
        } as T)
      : original<T>(route);
  await f.client.connect(malformed);
  assert.equal(f.client.snapshot().state, "offline");
  assert.equal(f.client.snapshot().jobs.length, 0);
  assert.match(f.client.snapshot().error ?? "", /数据格式/);
});

test("device keys bind to both account and service profile and expire, logout preserves a safe offline notice", async (t) => {
  const f = await fixture(t);
  await f.client.execute({ type: "service.model.select", modelId: "model-1" });
  const profile = f.store
    .profiles()
    .find((profile) => profile.id === workProfileId(f.alice, "model-1"))!;
  assert.equal(keyForWorkProfile(f.alice, profile), f.alice.token);
  assert.equal(keyForWorkProfile(f.bob, profile), undefined);
  assert.equal(
    keyForWorkProfile(
      { ...f.alice, expiresAt: "2000-01-01T00:00:00Z" },
      profile,
    ),
    undefined,
  );
  assert.equal(
    keyForWorkProfile(f.alice, {
      ...profile,
      baseURL: "https://another.test/v1",
    } as ModelProfile),
    undefined,
  );
  await f.client.disconnect("本机已退出，远端撤销未确认。");
  assert.equal(f.client.snapshot().state, "unconfigured");
  assert.equal(f.client.snapshot().baseURL, undefined);
  assert.match(f.client.snapshot().error!, /远端撤销未确认/);
});

test("closing waits for an in-flight collection and remote origin metadata never grants local overwrite authority", async (t) => {
  const f = await fixture(t);
  const { job } = f.service.jobs.create(f.alice.user.id, {
    requestId: "created-on-another-device",
    model: "model-1",
    title: "其他设备的委托",
    goal: "整理合成材料",
    materials: [{ id: "source-1", title: "资料", text: "ORCHID 42" }],
    origin: { taskId: f.task.id, version: 1 },
  });
  await f.service.jobs.tick();
  const originalCreate = f.host.createWork;
  let release!: () => void, started!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const beginning = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.host.createWork = async (input) => {
    started();
    await blocked;
    return originalCreate(input);
  };
  const collecting = f.client.execute({
    type: "service.job.collect",
    requestId: randomUUID(),
    jobId: job.id,
  });
  const rejected = assert.rejects(collecting, /账户已切换|连接已关闭/);
  await beginning;
  let closed = false;
  const closing = f.client.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(closed, false);
  release();
  await rejected;
  await closing;
  assert.equal(closed, true);
  assert.equal(f.store.task(f.task.id).artifacts.length, 0);
  assert.deepEqual(f.client.snapshot().collected, {});
});

test("login cannot redirect its stored token through response fields and password echoes are redacted", async (t) => {
  let fail = false;
  const server = createServer((_request, response) => {
    response.writeHead(fail ? 401 : 200, {
      "Content-Type": "application/json",
    });
    response.end(
      JSON.stringify(
        fail
          ? { error: { message: "bad password private-login-password" } }
          : {
              baseURL: "https://attacker.test",
              token: "synthetic-device-token-1234",
              expiresAt: "2099-01-01T00:00:00Z",
              user: { id: "user", username: "name" },
              device: { id: "device", name: "desktop" },
            },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  });
  const url = `http://127.0.0.1:${address.port}`,
    input = {
      username: "name",
      password: "private-login-password",
      deviceName: "desktop",
    };
  await assert.rejects(loginWorkService(url, input));
  fail = true;
  await assert.rejects(loginWorkService(url, input), (error) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /private-login-password/);
    assert.match(error.message, /已隐藏/);
    return true;
  });
});
