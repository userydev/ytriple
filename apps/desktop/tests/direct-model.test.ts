import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  randomUUID,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { createServer } from "node:http";
import { Store } from "../src/core/store";
import { DirectModel } from "../src/core/direct-model";
import {
  ModelConnections,
  type CredentialVault,
} from "../src/core/model-connections";
import { Runtime } from "../src/core/runtime";
import { Radar } from "../src/core/radar";
import { WorkspaceBackups } from "../src/core/workspace-backup";
import type { DirectProfile, DirectCall } from "../src/core/model-contract";
import type { Model, Prompt, StreamEvent } from "../src/core/ycore";
import type { Run, Contribution } from "../src/core/types";
const profile: DirectProfile = {
  baseUrl: "https://model.example/v1/",
  model: "fixture-text",
  maxOutputTokens: 4096,
  tokenParameter: "max_tokens",
};
const prompt: Prompt = {
  messages: [
    { role: "system", content: "仅使用给定资料" },
    { role: "user", content: "记录一条事实" },
  ],
  refs: [{ id: "local-material", revision: 1 }],
  taskId: "fixture",
};
const frame = (
  content: string | null,
  reason: string | null = null,
  id = "provider-1",
) =>
  `data: ${JSON.stringify({ id, choices: [{ index: 0, delta: { content }, finish_reason: reason }] })}\r\n\r\n`;
function response(
  body = frame("实测记录：十秒。") + frame(null, "stop") + "data: [DONE]\n\n",
  stride = 3,
) {
  const bytes = new TextEncoder().encode(body);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += stride)
          controller.enqueue(bytes.slice(offset, offset + stride));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
async function collect(model: Model, key: string = randomUUID(), input = prompt) {
  const events: StreamEvent[] = [];
  for await (const event of model.stream(
    input,
    key,
    new AbortController().signal,
  ))
    events.push(event);
  return events;
}
function vault(): CredentialVault {
  const key = randomBytes(32);
  return {
    available: () => true,
    encrypt(text) {
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, iv),
        body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decrypt(buffer) {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        buffer.subarray(0, 12),
      );
      decipher.setAuthTag(buffer.subarray(12, 28));
      return Buffer.concat([
        decipher.update(buffer.subarray(28)),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}

test("direct text stream decodes split UTF-8 and CRLF, persists terminal receipt before reporting completion, and sends only selected prompt", async () => {
  const store = new Store(":memory:");
  let calls = 0;
  const model = new DirectModel(
    store,
    profile,
    "test-key",
    async (url, init) => {
      calls++;
      assert.equal(String(url), "https://model.example/v1/chat/completions");
      assert.equal(init?.redirect, "error");
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.messages, prompt.messages);
      assert.equal(body.document_refs, undefined);
      assert.equal(body.max_tokens, 4096);
      assert.equal(body.stream, true);
      return response(
        ": heartbeat\n\n" +
          frame("你好，事实。") +
          frame(null, "stop") +
          `data: ${JSON.stringify({ choices: [] })}\n\n` +
          "data: [DONE]\n\n",
      );
    },
  );
  try {
    const events = await collect(model, "same-key");
    const id = events[0].run_id;
    assert.equal(
      events
        .filter((e) => e.type === "text.delta")
        .map((e) => e.text)
        .join(""),
      "你好，事实。",
    );
    assert.equal(events.at(-1)?.type, "run.completed");
    assert.equal((await model.lookup(id)).status, "succeeded");
    await assert.rejects(collect(model, "same-key"), /不会重发/);
    assert.equal(calls, 1);
    await assert.rejects(
      collect(model, "same-key", {
        ...prompt,
        messages: [{ role: "user", content: "different" }],
      }),
      /身份的内容已改变/,
    );
    const restarted = new DirectModel(store, profile, "test-key", async () => {
      throw Error("must not call");
    });
    assert.deepEqual((await restarted.lookupByKey("same-key")).result, {
      text: "你好，事实。",
    });
    assert.ok(!JSON.stringify(store.exportState()).includes("test-key"));
  } finally {
    store.close();
  }
});

test("EOF without provider stop, changed response identity and false DONE never create a successful result", async () => {
  for (const body of [
    frame("部分内容"),
    frame("部分内容") + "data: [DONE]\n\n",
    frame("a", null, "one") + frame("b", null, "two"),
    "data: not-json\n\n",
  ]) {
    const store = new Store(":memory:"),
      model = new DirectModel(store, profile, "secret", async () =>
        response(body),
      );
    try {
      await assert.rejects(collect(model), /尚未确认/);
      assert.equal(store.all<DirectCall>("direct-call")[0].status, "unknown");
    } finally {
      store.close();
    }
  }
});

test("length limits and provider rejection preserve partial output without success or leaking upstream errors", async () => {
  const store = new Store(":memory:");
  try {
    const truncated = new DirectModel(store, profile, "secret", async () =>
      response(frame("部分正文") + frame(null, "length")),
    );
    await assert.rejects(collect(truncated, "length"), /输出上限/);
    const record = store.all<DirectCall>("direct-call")[0];
    assert.equal(record.status, "failed");
    assert.equal(record.body, "部分正文");
    const rejected = new DirectModel(
      store,
      profile,
      "secret",
      async () =>
        new Response(JSON.stringify({ error: { message: "secret" } }), {
          status: 401,
        }),
    );
    await assert.rejects(
      collect(rejected, "auth"),
      (error) =>
        error instanceof Error &&
        !error.message.includes("secret") &&
        error.message.includes("授权"),
    );
    const serverFailure = new DirectModel(
      store,
      profile,
      "secret",
      async () => new Response("provider may have accepted", { status: 503 }),
    );
    await assert.rejects(collect(serverFailure, "server"), /尚未确认/);
    assert.equal((await serverFailure.lookupByKey("server")).status, "unknown");
  } finally {
    store.close();
  }
});

test("request and stream bounds, abort and endpoint restrictions fail without retries", async () => {
  const store = new Store(":memory:");
  let calls = 0;
  try {
    const model = new DirectModel(store, profile, "secret", async () => {
      calls++;
      return response(frame("x".repeat(260000)), 32768);
    });
    await assert.rejects(
      collect(model, "input", {
        ...prompt,
        messages: [{ role: "user", content: "x".repeat(530000) }],
      }),
      /512 KiB/,
    );
    assert.equal(calls, 0);
    await assert.rejects(collect(model, "output"), /尚未确认/);
    assert.equal(calls, 1);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(async () => {
      for await (const _ of model.stream(
        prompt,
        "cancelled-before",
        controller.signal,
      )) {
      }
    }, /发送前已停止/);
    assert.equal(calls, 1);
    for (const baseUrl of [
      "http://remote.example/v1",
      "https://user:pass@model.example/v1",
      "https://model.example/v1?key=x",
      "https://model.example/v1/chat/completions",
    ])
      assert.throws(
        () => new DirectModel(store, { ...profile, baseUrl }, "secret"),
      );
  } finally {
    store.close();
  }
});

test("redirecting compatible endpoint cannot forward API credentials to a second server", async () => {
  let forwarded = 0;
  const destination = createServer((_req, res) => {
    forwarded++;
    res.end("not allowed");
  });
  await new Promise<void>((r) => destination.listen(0, "127.0.0.1", r));
  const destinationPort = (destination.address() as any).port;
  const source = createServer((_req, res) => {
    res.writeHead(302, {
      location: `http://127.0.0.1:${destinationPort}/stolen`,
    });
    res.end();
  });
  await new Promise<void>((r) => source.listen(0, "127.0.0.1", r));
  const store = new Store(":memory:");
  try {
    const model = new DirectModel(
      store,
      {
        ...profile,
        baseUrl: `http://127.0.0.1:${(source.address() as any).port}/v1`,
      },
      "must-not-forward",
    );
    await assert.rejects(collect(model), /尚未确认/);
    assert.equal(forwarded, 0);
  } finally {
    store.close();
    source.closeAllConnections();
    destination.closeAllConnections();
    await Promise.all([
      new Promise<void>((r) => source.close(() => r())),
      new Promise<void>((r) => destination.close(() => r())),
    ]);
  }
});

test("model configuration securely persists across restart, guards endpoint credential reuse and stays outside workspace backups", async () => {
  const root = await mkdtemp(join(tmpdir(), "ytriple-model-")),
    store = new Store(join(root, "workbench.sqlite")),
    secure = vault();
  const service: Model = { scope: "service", async *stream() {} };
  try {
    const models = new ModelConnections(store, root, secure, () => service);
    models.save(profile, "private-api-key", false, () => {});
    const file = await readFile(join(root, "model.json"), "utf8");
    assert.ok(!file.includes("private-api-key"));
    const reopened = new ModelConnections(store, root, secure, () => service);
    assert.equal(reopened.info().mode, "direct");
    assert.equal(reopened.model().scope, models.model().scope);
    reopened.save({ ...profile, model: "another-model" }, "", false, () => {});
    await assert.rejects(
      async () =>
        reopened.save(
          { ...profile, baseUrl: "https://another.example/v1" },
          "",
          false,
          () => {},
        ),
      /API Key/,
    );
    assert.throws(
      () =>
        reopened.select("service", () => {
          throw Error("active run");
        }),
      /active run/,
    );
    assert.equal(reopened.info().mode, "direct");
    reopened.select("service", () => {});
    assert.equal(
      new ModelConnections(store, root, secure, () => service).info().mode,
      "service",
    );
    const backups = new WorkspaceBackups(root);
    await backups.export(store, join(root, "work.ytriple-backup"));
    assert.ok(
      !(await readFile(join(root, "work.ytriple-backup"), "utf8")).includes(
        "private-api-key",
      ),
    );
    const disabled = new ModelConnections(
      store,
      root,
      { ...secure, available: () => false },
      () => service,
    );
    assert.equal(disabled.info().configured, false);
    assert.match(disabled.info().error!, /无法读取/);
    assert.throws(
      () => disabled.save(profile, "replacement", false, () => {}),
      /安全存储/,
    );
    assert.equal(
      new ModelConnections(store, root, secure, () => service).info().mode,
      "service",
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("interrupted direct team run can be explicitly abandoned locally without losing evidence or auto retry", async () => {
  const store = new Store(":memory:");
  let calls = 0;
  const model = new DirectModel(store, profile, "secret", async () => {
    calls++;
    return response(frame("已收到但尚未完成"));
  });
  const runtime = new Runtime(store, () => model);
  try {
    const run = runtime.submit({
      key: randomUUID(),
      context: "new",
      text: "整理",
      refs: [],
      recipient: null,
      projectId: null,
    });
    await runtime.settled(run.workId);
    assert.equal(store.require<Run>("run", run.id).status, "unknown");
    assert.equal(store.require<Run>("run", run.id).recovery, "local");
    await assert.rejects(runtime.reconcile(run.id), /终态/);
    assert.equal(calls, 1);
    runtime.abandonLocal(run.id);
    assert.equal(store.require<Run>("run", run.id).status, "cancelled");
    assert.ok(store.require<Run>("run", run.id).abandonedAt);
    assert.equal(store.all<DirectCall>("direct-call")[0].status, "unknown");
    assert.equal(
      store.all<Contribution>("contribution")[0].body,
      "已收到但尚未完成",
    );
    runtime.assertCanChangeProvider("another");
    assert.equal(calls, 1);
  } finally {
    store.close();
  }
});

test("a durable complete direct response is reconciled before further team work, never abandoned or re-sent", async () => {
  const store = new Store(":memory:");
  let calls = 0;
  const model = new DirectModel(store, profile, "secret", async () => {
    calls++;
    return response(frame("partial"));
  });
  const runtime = new Runtime(store, () => model);
  try {
    const run = runtime.submit({
      key: randomUUID(),
      context: "new",
      text: "整理",
      refs: [],
      recipient: null,
      projectId: null,
    });
    await runtime.settled(run.workId);
    const receipt = store.all<DirectCall>("direct-call")[0];
    store.put("direct-call", receipt.id, {
      ...receipt,
      status: "succeeded",
      body: "重启前已持久化的完整正文",
      error: null,
    });
    assert.throws(() => runtime.abandonLocal(run.id), /完整结果/);
    await runtime.reconcile(run.id);
    assert.equal(store.require<Run>("run", run.id).status, "queued");
    assert.equal(
      store.all<Contribution>("contribution")[0].body,
      "重启前已持久化的完整正文",
    );
    assert.equal(calls, 1);
  } finally {
    store.close();
  }
});

test("Radar uses direct model identity and explicit local abandonment without publishing an incomplete edition", async () => {
  const store = new Store(":memory:"),
    model = new DirectModel(store, profile, "secret", async () =>
      response(frame("incomplete")),
    );
  const radar = new Radar(
    store,
    () => model,
    () => {},
  );
  try {
    const material = store.addMaterial("输入", "已读范围");
    const topic = radar.saveTopic({
      revision: 0,
      title: "观察",
      focus: "事实",
      sources: [{ materialId: material.id, policy: "auto", reason: "" }],
    });
    const job = radar.refresh(topic.id);
    await radar.settled(job.id);
    assert.equal(store.require<any>("radar-job", job.id).status, "unknown");
    radar.abandonLocal(job.id);
    assert.equal(store.require<any>("radar-job", job.id).status, "cancelled");
    assert.equal(store.all("radar-edition").length, 0);
    assert.equal(store.all<DirectCall>("direct-call")[0].status, "unknown");
  } finally {
    store.close();
  }
});
