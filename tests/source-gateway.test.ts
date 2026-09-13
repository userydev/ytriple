import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HttpSourceGateway,
  type SourceGateway,
  type SourceReceiveSink,
} from "../src/core/source-gateway.js";
import { WorkbenchService } from "../src/core/service.js";
import type { RemoteSourceIdentity, Source } from "../src/shared/types.js";

const observedAt = "2026-09-12T03:00:00.000Z";
const serverInstanceId = "71fb60c7-f5ee-4cfc-91a8-fb4ddfa3b33d";
const meta = { protocolVersion: "1.0", serverInstanceId };
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
const sse = (value: unknown, cursor: string) =>
  new Response(
    `event: change\nid: ${cursor}\ndata: ${JSON.stringify(value)}\n\n`,
    { headers: { "content-type": "text/event-stream; charset=utf-8" } },
  );

async function fixture(
  t: { after(fn: () => unknown): void },
  sourceGateway?: SourceGateway,
  lifecycle?: { closed: boolean },
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ytriple-gateway-"));
  const service = new WorkbenchService(
    path.join(root, "data"),
    () => undefined,
    () => {},
    sourceGateway ? { sourceGateway } : {},
  );
  t.after(async () => {
    if (!lifecycle?.closed) await service.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  service.store.setConfig("settings", {
    ...service.store.settings(),
    aiRoot: path.join(root, "AI"),
    codeRoot: path.join(root, "Code"),
    workspaceRoot: path.join(root, "work"),
    projectMonitoring: false,
  });
  await service.initialize();
  return service;
}

test("HTTP source gateway upserts, polls and returns a local source with remote provenance", async () => {
  const content = "可核查的服务端网页 etsuko-42";
  const contentHash = createHash("sha256").update(content).digest("hex");
  const calls: { url: string; init?: RequestInit }[] = [];
  let upsertAttempts = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    calls.push({ url: url.href, init });
    if (url.pathname === "/v1/capabilities")
      return json({
        meta,
        tenantId: "tenant-1",
        capabilities: {
          publicUrl: true,
          explicitRefresh: true,
          changes: true,
          itemRevisions: true,
        },
        scopes: [
          "sources:read",
          "sources:write",
          "refreshes:write",
          "content:read",
        ],
      });
    if (url.pathname === "/v1/sources/url" && ++upsertAttempts === 1)
      throw new TypeError("socket closed after the write may have committed");
    if (url.pathname === "/v1/sources/url")
      return json({
        meta,
        source: {
          id: "source-1",
          url: "https://example.com/requested",
          version: 1,
        },
        job: {
          id: "job-1",
          sourceId: "source-1",
          status: "queued",
          createdAt: observedAt,
          updatedAt: observedAt,
        },
      });
    if (url.pathname === "/v1/jobs/job-1")
      return json({
        meta,
        job: {
          id: "job-1",
          sourceId: "source-1",
          status: "succeeded",
          itemId: "item-1",
          revisionId: "revision-1",
          createdAt: observedAt,
          updatedAt: observedAt,
        },
      });
    if (url.pathname === "/v1/items/item-1/revisions/revision-1")
      return json({
        meta,
        item: {
          id: "item-1",
          sourceId: "source-1",
          canonicalUrl: "https://example.com/final",
          title: "远端文章",
        },
        revision: {
          id: "revision-1",
          itemId: "item-1",
          observedAt,
          contentHash,
          coverage: "fulltext",
          missing: ["images"],
          content,
        },
      });
    return json({ error: "unexpected route" }, 404);
  };
  const gateway = new HttpSourceGateway({
    baseURL: "http://localhost:47891/",
    token: "device-token",
    tenantId: "tenant-1",
    fetch,
    pollIntervalMs: 0,
  });
  const source = await gateway.addURL("https://example.com/requested");
  assert.equal(source.type, "url");
  assert.equal(source.location, "https://example.com/final");
  assert.equal(source.text, content);
  assert.deepEqual(source.remote, {
    serverInstanceId,
    tenantId: "tenant-1",
    sourceId: "source-1",
    itemId: "item-1",
    revisionId: "revision-1",
    contentHash,
    observedAt,
    coverageLevel: "fulltext",
    missing: ["images"],
  });
  assert.deepEqual(
    calls.map(({ url }) => new URL(url).pathname),
    [
      "/v1/capabilities",
      "/v1/sources/url",
      "/v1/sources/url",
      "/v1/jobs/job-1",
      "/v1/items/item-1/revisions/revision-1",
    ],
  );
  const headers = new Headers(calls[1]!.init?.headers);
  const replayHeaders = new Headers(calls[2]!.init?.headers);
  assert.equal(headers.get("authorization"), "Bearer device-token");
  assert.ok(headers.get("idempotency-key"));
  assert.equal(
    replayHeaders.get("idempotency-key"),
    headers.get("idempotency-key"),
  );
  assert.deepEqual(JSON.parse(String(calls[1]!.init?.body)), {
    url: "https://example.com/requested",
  });
});

test("HTTP source gateway manages user and recommended Radar follows", async () => {
  let follow:
    | {
        id: string;
        sourceId: string;
        origin: "recommended";
        recommendedSourceId: string;
        name: string;
        category: string;
        url: string;
        state: "active" | "paused";
        refreshIntervalMinutes: number;
        createdAt: string;
        updatedAt: string;
      }
    | undefined;
  const calls: {
    path: string;
    method: string;
    body?: unknown;
    idempotency?: string | null;
  }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({
      path: url.pathname,
      method,
      body,
      idempotency: new Headers(init?.headers).get("idempotency-key"),
    });
    if (url.pathname === "/v1/capabilities")
      return json({
        meta,
        tenantId: "tenant-radar",
        capabilities: {
          publicUrl: true,
          explicitRefresh: true,
          changes: true,
          itemRevisions: true,
          changeStream: true,
          sourceFollows: true,
          recommendedSources: true,
        },
        scopes: [
          "sources:read",
          "sources:write",
          "refreshes:write",
          "content:read",
        ],
      });
    if (url.pathname === "/v1/recommended-sources")
      return json({
        meta,
        sources: [
          {
            id: "recommended-open-source",
            name: "开源动态",
            description: "服务器维护的开源工具来源",
            category: "开发工具",
            url: "https://example.com/open-source",
            refreshIntervalMinutes: 60,
            enabledByDefault: false,
          },
        ],
      });
    if (url.pathname === "/v1/follows" && method === "GET")
      return json({ meta, follows: follow ? [follow] : [] });
    if (url.pathname === "/v1/follows" && method === "POST") {
      follow = {
        id: "follow-radar",
        sourceId: "source-radar",
        origin: "recommended",
        recommendedSourceId: body.source.recommendedSourceId,
        name: "开源动态",
        category: "开发工具",
        url: "https://example.com/open-source",
        state: "active",
        refreshIntervalMinutes: 60,
        createdAt: observedAt,
        updatedAt: observedAt,
      };
      return json(
        {
          meta,
          follow,
          job: {
            id: "job-follow",
            sourceId: follow.sourceId,
            status: "succeeded",
            itemId: "item-follow",
            revisionId: "revision-follow",
            createdAt: observedAt,
            updatedAt: observedAt,
          },
        },
        202,
      );
    }
    if (url.pathname === "/v1/follows/follow-radar" && method === "PATCH") {
      follow = { ...follow!, state: body.state, updatedAt: observedAt };
      return json({ meta, follow });
    }
    if (url.pathname === "/v1/follows/follow-radar/refresh")
      return json(
        {
          meta,
          follow,
          job: {
            id: "job-refresh",
            sourceId: follow!.sourceId,
            status: "succeeded",
            itemId: "item-follow",
            revisionId: "revision-follow",
            createdAt: observedAt,
            updatedAt: observedAt,
          },
        },
        202,
      );
    if (url.pathname === "/v1/follows/follow-radar" && method === "DELETE") {
      follow = undefined;
      return json({ meta, followId: "follow-radar", deleted: true });
    }
    return json({ error: "unexpected route" }, 404);
  };
  const gateway = new HttpSourceGateway({
    baseURL: "http://localhost:47891",
    token: "radar-device-token",
    tenantId: "tenant-radar",
    fetch,
    pollIntervalMs: 0,
  });

  const catalog = await gateway.radarCatalog();
  assert.equal(catalog.follows.length, 0);
  assert.equal(catalog.recommendedSources[0]?.category, "开发工具");
  const created = await gateway.follow({
    recommendedSourceId: "recommended-open-source",
  });
  assert.equal(created.origin, "recommended");
  assert.equal(created.category, "开发工具");
  assert.equal(
    (
      calls.find(
        (call) => call.method === "POST" && call.path === "/v1/follows",
      )?.body as { source: { kind: string } }
    ).source.kind,
    "recommended",
  );
  assert.ok(
    calls
      .filter((call) => call.method !== "GET")
      .every((call) => call.idempotency),
  );
  assert.equal(
    (await gateway.setFollowState(created.id, "paused")).state,
    "paused",
  );
  assert.equal((await gateway.refreshFollow(created.id)).id, created.id);
  await gateway.unfollow(created.id);
  assert.equal((await gateway.radarCatalog()).follows.length, 0);
  await gateway.close();
});

test("HTTP source gateway rejects insecure remote endpoints and redacts its token", async () => {
  assert.throws(
    () =>
      new HttpSourceGateway({
        baseURL: "http://source.example.com",
        token: "device-token",
      }),
    /HTTPS/,
  );
  const token = "private-device-token";
  const gateway = new HttpSourceGateway({
    baseURL: "https://source.example.com",
    token,
    fetch: async (input) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      if (url.pathname === "/v1/capabilities")
        return json({
          meta,
          tenantId: "tenant-1",
          capabilities: {
            publicUrl: true,
            explicitRefresh: true,
            changes: true,
            itemRevisions: true,
          },
          scopes: [
            "sources:read",
            "sources:write",
            "refreshes:write",
            "content:read",
          ],
        });
      return json({
        meta,
        source: {
          id: "source-1",
          url: "https://example.com/article",
          version: 1,
        },
        job: {
          id: "job-failed",
          sourceId: "source-1",
          status: "failed",
          createdAt: observedAt,
          updatedAt: observedAt,
          error: {
            code: "SOURCE_FETCH_FAILED",
            message: `upstream accidentally echoed ${token}`,
            retryable: false,
          },
        },
      });
    },
  });
  await assert.rejects(
    gateway.addURL("https://example.com/article"),
    (error) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, new RegExp(token));
      assert.match(error.message, /已隐藏令牌/);
      return true;
    },
  );
});

test("HTTP source gateway bounds untrusted responses before JSON parsing", async () => {
  const gateway = new HttpSourceGateway({
    baseURL: "https://source.example.com",
    token: "device-token",
    fetch: async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-length": String(32 * 1024 * 1024) },
      }),
  });
  await assert.rejects(
    gateway.addURL("https://example.com/article"),
    /响应过大/,
  );
});

test("closing the HTTP source gateway aborts in-flight work", async () => {
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gateway = new HttpSourceGateway({
    baseURL: "https://source.example.com",
    token: "device-token",
    fetch: async (_input, init) => {
      started();
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return reject(new Error("missing abort signal"));
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  });
  const pending = gateway.addURL("https://example.com/article");
  await requestStarted;
  gateway.close();
  await assert.rejects(pending, /请求已停止/);
});

test("WorkbenchService checks the task before remote access and screens local fallback URLs", async (t) => {
  let calls = 0;
  const gateway: SourceGateway = {
    addURL: async () => {
      calls++;
      throw new Error("不应访问远端");
    },
  };
  const configured = await fixture(t, gateway);
  await assert.rejects(
    configured.execute({
      type: "source.addURL",
      taskId: "missing-task",
      url: "http://127.0.0.1/private",
    }),
    /找不到/,
  );
  assert.equal(calls, 0);

  const unconfigured = await fixture(t);
  const task = (
    await unconfigured.execute({ type: "task.create", goal: "导入网页资料" })
  ).tasks[0]!;
  await assert.rejects(
    unconfigured.execute({
      type: "source.addURL",
      taskId: task.id,
      url: "http://127.0.0.1/private",
    }),
    /公开|禁止|不允许|不能|本地|地址|HTTPS/,
  );
});

test("WorkbenchService exposes follow, pause, refresh, and unfollow as Radar state", async (t) => {
  const identity = { serverInstanceId, tenantId: "tenant-radar-service" };
  let current:
    | {
        id: string;
        sourceId: string;
        origin: "recommended";
        recommendedSourceId: string;
        name: string;
        category: string;
        url: string;
        state: "active" | "paused";
        refreshIntervalMinutes: number;
        createdAt: string;
        updatedAt: string;
      }
    | undefined;
  let refreshes = 0;
  const gateway: SourceGateway = {
    addURL: async () => {
      throw new Error("not used");
    },
    radarCatalog: async () => ({
      ...identity,
      follows: current ? [current] : [],
      recommendedSources: [
        {
          id: "recommended-service",
          name: "服务推荐",
          description: "由服务器维护",
          category: "产品动态",
          url: "https://example.com/recommended",
          defaultRefreshIntervalMinutes: 60,
        },
      ],
    }),
    follow: async () => {
      current = {
        id: "follow-service",
        sourceId: "source-service",
        origin: "recommended",
        recommendedSourceId: "recommended-service",
        name: "服务推荐",
        category: "产品动态",
        url: "https://example.com/recommended",
        state: "active",
        refreshIntervalMinutes: 60,
        createdAt: observedAt,
        updatedAt: observedAt,
      };
      return current;
    },
    setFollowState: async (_followId, state) => {
      current = { ...current!, state };
      return current;
    },
    refreshFollow: async () => {
      refreshes++;
      return current!;
    },
    unfollow: async () => {
      current = undefined;
    },
  };
  const service = await fixture(t, gateway);
  let snapshot = await service.execute({
    type: "radar.follow",
    recommendedSourceId: "recommended-service",
  });
  assert.equal(snapshot.radar?.follows[0]?.origin, "recommended");
  assert.equal(snapshot.radar?.recommendedSources[0]?.followed, true);
  assert.equal(
    snapshot.radar?.recommendedSources[0]?.followId,
    "follow-service",
  );
  snapshot = await service.execute({
    type: "radar.setFollowState",
    followId: "follow-service",
    state: "paused",
  });
  assert.equal(snapshot.radar?.follows[0]?.state, "paused");
  await service.execute({ type: "radar.refresh", followId: "follow-service" });
  assert.equal(refreshes, 1);
  snapshot = await service.execute({
    type: "radar.unfollow",
    followId: "follow-service",
  });
  assert.equal(snapshot.radar?.follows.length, 0);
  assert.equal(snapshot.radar?.recommendedSources[0]?.followed, false);
  assert.deepEqual(
    snapshot.radar?.events?.map((event) => event.type),
    ["follow.removed", "follow.updated", "follow.created"],
  );
});

test("remote revision replay does not increment the goal or clear its checkpoint", async (t) => {
  let calls = 0;
  const text = "远端正文";
  const remote = (): Source => ({
    id: randomUUID(),
    title: calls === 1 ? "第一次交付" : "重复交付",
    type: "url",
    location: "https://example.com/final",
    text,
    addedAt: observedAt,
    coverage: "网页正文（fulltext）",
    remote: {
      serverInstanceId,
      tenantId: "tenant-1",
      sourceId: "source-1",
      itemId: "item-1",
      revisionId: "revision-1",
      contentHash: createHash("sha256").update(text).digest("hex"),
      observedAt,
      coverageLevel: "fulltext",
      missing: [],
    },
  });
  const gateway: SourceGateway = {
    addURL: async () => {
      calls++;
      return remote();
    },
  };
  const service = await fixture(t, gateway);
  const task = (
    await service.execute({ type: "task.create", goal: "验证来源幂等" })
  ).tasks[0]!;
  let snapshot = await service.execute({
    type: "source.addURL",
    taskId: task.id,
    url: "https://example.com/article",
  });
  const imported = snapshot.tasks.find((entry) => entry.id === task.id)!;
  assert.equal(imported.sources.length, 1);
  assert.equal(imported.goalVersion, task.goalVersion + 1);
  service.store.saveCheckpoint(task.id, { replaySentinel: true });

  snapshot = await service.execute({
    type: "source.addURL",
    taskId: task.id,
    url: "https://example.com/article",
  });
  const replayed = snapshot.tasks.find((entry) => entry.id === task.id)!;
  assert.equal(calls, 2);
  assert.equal(replayed.sources.length, 1);
  assert.equal(replayed.sources[0]!.title, "第一次交付");
  assert.equal(replayed.goalVersion, imported.goalVersion);
  assert.deepEqual(service.store.checkpoint(task.id), {
    replaySentinel: true,
  });
  assert.equal(service.store.hasRemoteRevision(replayed.sources[0]!), true);
});

test("HTTP source receiver reconnects from the last committed SSE cursor", async () => {
  const firstCursor = "cursor_one.signature_one";
  const secondCursor = "cursor_two.signature_two";
  const firstContent = "第一条由长连接推送并核验的远端正文。";
  const secondContent = "断线重连后从已提交游标接续的第二条正文。";
  const firstHash = createHash("sha256").update(firstContent).digest("hex");
  const secondHash = createHash("sha256").update(secondContent).digest("hex");
  const firstObserved = "2026-09-12T04:00:00.000Z";
  const secondObserved = "2026-09-12T04:01:00.000Z";
  const envelope = (
    cursor: string,
    number: number,
    contentHash: string,
    observed: string,
  ) => ({
    meta,
    cursor,
    change: {
      id: `change:${number}`,
      kind: number === 1 ? "item.created" : "item.revised",
      sourceId: "source-stream",
      followId: "follow-stream",
      itemId: "item-stream",
      revisionId: `revision-${number}`,
      observedAt: observed,
      contentHash,
      coverage: "fulltext",
      missing: [],
      occurredAt: observed,
    },
  });
  const revisions = new Map([
    [
      "/v1/items/item-stream/revisions/revision-1",
      {
        meta,
        item: {
          id: "item-stream",
          sourceId: "source-stream",
          canonicalUrl: "https://example.com/stream",
          title: "推送文章",
        },
        revision: {
          id: "revision-1",
          itemId: "item-stream",
          observedAt: firstObserved,
          contentHash: firstHash,
          coverage: "fulltext",
          missing: [],
          content: firstContent,
        },
      },
    ],
    [
      "/v1/items/item-stream/revisions/revision-2",
      {
        meta,
        item: {
          id: "item-stream",
          sourceId: "source-stream",
          canonicalUrl: "https://example.com/stream",
          title: "推送文章（更新）",
        },
        revision: {
          id: "revision-2",
          itemId: "item-stream",
          observedAt: secondObserved,
          contentHash: secondHash,
          coverage: "fulltext",
          missing: [],
          content: secondContent,
        },
      },
    ],
  ]);
  const streamRequests: Array<{
    cursor: string | null;
    lastEventId: string | null;
  }> = [];
  let streamNumber = 0;
  let thirdStream!: () => void;
  const thirdStreamOpened = new Promise<void>((resolve) => {
    thirdStream = resolve;
  });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (url.pathname === "/v1/capabilities")
      return json({
        meta,
        tenantId: "tenant-stream",
        capabilities: {
          publicUrl: true,
          explicitRefresh: true,
          changes: true,
          itemRevisions: true,
          changeStream: true,
        },
        scopes: [
          "sources:read",
          "sources:write",
          "refreshes:write",
          "content:read",
        ],
      });
    const revision = revisions.get(url.pathname);
    if (revision) return json(revision);
    if (url.pathname === "/v1/changes/stream") {
      streamRequests.push({
        cursor: url.searchParams.get("cursor"),
        lastEventId: new Headers(init?.headers).get("last-event-id"),
      });
      streamNumber++;
      if (streamNumber === 1)
        return sse(
          envelope(firstCursor, 1, firstHash, firstObserved),
          firstCursor,
        );
      if (streamNumber === 2)
        return sse(
          envelope(secondCursor, 2, secondHash, secondObserved),
          secondCursor,
        );
      thirdStream();
      return new Response(new ReadableStream<Uint8Array>(), {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return json({ error: "unexpected route" }, 404);
  };
  const gateway = new HttpSourceGateway({
    baseURL: "http://localhost:47891",
    token: "stream-device-token",
    tenantId: "tenant-stream",
    fetch,
    streamReconnectMs: 0,
    streamMaxReconnectMs: 1,
  });
  const received: Source[] = [];
  let committedCursor: string | undefined;
  let secondCommit!: () => void;
  const receivedTwo = new Promise<void>((resolve) => {
    secondCommit = resolve;
  });
  gateway.startReceiving({
    cursorFor: () => committedCursor,
    commit: async (page) => {
      received.push(...page.sources);
      committedCursor = page.nextCursor;
      if (received.length === 2) secondCommit();
    },
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([receivedTwo, thirdStreamOpened]),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("SSE reconnect timed out")),
          2_000,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  await gateway.close();

  assert.deepEqual(streamRequests.slice(0, 3), [
    { cursor: null, lastEventId: null },
    { cursor: firstCursor, lastEventId: firstCursor },
    { cursor: secondCursor, lastEventId: secondCursor },
  ]);
  assert.deepEqual(
    received.map((source) => source.remote?.revisionId),
    ["revision-1", "revision-2"],
  );
  assert.deepEqual(
    received.map((source) => source.remote?.followId),
    ["follow-stream", "follow-stream"],
  );
  assert.deepEqual(
    received.map((source) => source.text),
    [firstContent, secondContent],
  );
});

test("closing the source receiver waits for an in-flight cursor commit", async () => {
  const cursor = "close_commit.signature_close";
  const content = "关闭过程必须等待这条远端修订完成原子提交。";
  const contentHash = createHash("sha256").update(content).digest("hex");
  const frame = {
    meta,
    cursor,
    change: {
      id: "change:close",
      kind: "item.created",
      sourceId: "source-close",
      itemId: "item-close",
      revisionId: "revision-close",
      observedAt,
      contentHash,
      coverage: "fulltext",
      missing: [],
      occurredAt: observedAt,
    },
  };
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (url.pathname === "/v1/capabilities")
      return json({
        meta,
        tenantId: "tenant-close",
        capabilities: {
          publicUrl: true,
          explicitRefresh: true,
          changes: true,
          itemRevisions: true,
          changeStream: true,
        },
        scopes: ["sources:read", "content:read"],
      });
    if (url.pathname === "/v1/changes/stream") return sse(frame, cursor);
    if (url.pathname === "/v1/items/item-close/revisions/revision-close")
      return json({
        meta,
        item: {
          id: "item-close",
          sourceId: "source-close",
          canonicalUrl: "https://example.com/close",
          title: "关闭提交",
        },
        revision: {
          id: "revision-close",
          itemId: "item-close",
          observedAt,
          contentHash,
          coverage: "fulltext",
          missing: [],
          content,
        },
      });
    return json({ error: "unexpected route" }, 404);
  };
  const gateway = new HttpSourceGateway({
    baseURL: "https://source.example.com",
    token: "close-device-token",
    tenantId: "tenant-close",
    fetch,
  });
  let commitStarted!: () => void;
  let releaseCommit!: () => void;
  const started = new Promise<void>((resolve) => {
    commitStarted = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseCommit = resolve;
  });
  let committedCursor: string | undefined;
  gateway.startReceiving({
    cursorFor: () => committedCursor,
    commit: async (page) => {
      commitStarted();
      await release;
      committedCursor = page.nextCursor;
    },
  });
  await started;
  let closed = false;
  const closing = gateway.close().then(() => {
    closed = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  releaseCommit();
  await closing;
  assert.equal(committedCursor, cursor);
});

test("pushed revisions and cursor enter the persistent Radar without creating a task", async (t) => {
  let sink: SourceReceiveSink | undefined;
  const gateway: SourceGateway = {
    addURL: async () => {
      throw new Error("not used");
    },
    startReceiving: (receiver) => {
      sink = receiver;
    },
  };
  const service = await fixture(t, gateway);
  assert.ok(sink);
  const identity = { serverInstanceId, tenantId: "tenant-inbox" };
  service.store.saveRadarFollow(identity, {
    id: "follow-inbox",
    sourceId: "source-inbox",
    origin: "user",
    name: "用户指定来源",
    category: "用户指定",
    url: "https://example.com/inbox",
    state: "active",
    refreshIntervalMinutes: 60,
    createdAt: observedAt,
    updatedAt: observedAt,
  });
  const source = (revision: string, text: string): Source => ({
    id: randomUUID(),
    title: `收件资料 ${revision}`,
    type: "url",
    location: "https://example.com/inbox",
    text,
    addedAt: observedAt,
    coverage: "网页正文（fulltext）",
    remote: {
      ...identity,
      sourceId: "source-inbox",
      itemId: "item-inbox",
      revisionId: revision,
      contentHash: createHash("sha256").update(text).digest("hex"),
      observedAt,
      coverageLevel: "fulltext",
      missing: [],
    },
  });
  const first = source("revision-1", "收件箱第一版正文");
  await sink.commit({
    ...identity,
    nextCursor: "inbox_one.signature_one",
    sources: [first],
  });
  let radar = (await service.snapshot()).radar!;
  assert.equal(radar.items.length, 1);
  assert.equal(radar.items[0]!.content, first.text);
  assert.equal(radar.items[0]!.revisionCount, 1);
  assert.equal(radar.items[0]!.origin, "user");
  assert.equal(radar.items[0]!.category, "用户指定");
  assert.equal(service.store.tasks().length, 0);
  assert.equal(
    service.store.remoteSourceCursor(identity),
    "inbox_one.signature_one",
  );

  await sink.commit({
    ...identity,
    nextCursor: "inbox_two.signature_two",
    sources: [{ ...first, id: randomUUID(), title: "重复投递" }],
  });
  radar = (await service.snapshot()).radar!;
  assert.equal(radar.items.length, 1);
  assert.equal(radar.items[0]!.revisionCount, 1);
  assert.equal(service.store.tasks().length, 0);
  assert.equal(
    service.store.remoteSourceCursor(identity),
    "inbox_two.signature_two",
  );

  const second = source("revision-2", "收件箱第二版正文");
  await sink.commit({
    ...identity,
    nextCursor: "inbox_three.signature_three",
    sources: [second],
  });
  radar = (await service.snapshot()).radar!;
  assert.equal(radar.items.length, 1);
  assert.equal(radar.items[0]!.content, second.text);
  assert.equal(radar.items[0]!.revisionCount, 2);
  assert.equal(radar.items[0]!.isUpdated, true);
  assert.equal(radar.items[0]!.readAt, undefined);

  const beforeTaskIds = new Set(service.store.tasks().map((task) => task.id));
  const created = await service.execute({
    type: "radar.createTask",
    itemIds: [radar.items[0]!.id],
    instruction: "判断这次更新对产品路线的影响",
  });
  const task = created.tasks.find((entry) => !beforeTaskIds.has(entry.id));
  assert.ok(task);
  assert.equal(task.sources.length, 1);
  assert.equal(task.sources[0]!.remote?.revisionId, "revision-2");
  assert.equal(task.sources[0]!.text, second.text);
  assert.ok(task.events.some((event) => event.type === "radar.material_added"));
  assert.ok(created.radar?.items[0]?.readAt);
  service.store.removeRadarFollow(identity, "follow-inbox");
  const historical = service.store.radarItems(identity)[0]!;
  assert.equal(historical.origin, "user");
  assert.equal(historical.category, "用户指定");

  const conflictingText = "同一 revision 的冲突正文";
  await assert.rejects(
    sink.commit({
      ...identity,
      nextCursor: "must_not_commit.signature_four",
      sources: [
        {
          ...second,
          id: randomUUID(),
          text: conflictingText,
          remote: {
            ...second.remote!,
            contentHash: createHash("sha256")
              .update(conflictingText)
              .digest("hex"),
          },
        },
      ],
    }),
    /冲突内容/,
  );
  assert.equal(
    service.store.remoteSourceCursor(identity),
    "inbox_three.signature_three",
  );

  await assert.rejects(
    sink.commit({
      ...identity,
      nextCursor: "must_not_commit.signature_five",
      sources: [
        {
          ...source("revision-3", "错误身份不应提交"),
          remote: {
            ...source("revision-3", "错误身份不应提交").remote!,
            tenantId: "wrong-tenant",
          },
        },
      ],
    }),
    /身份不一致/,
  );
  assert.equal(
    service.store.remoteSourceCursor(identity),
    "inbox_three.signature_three",
  );
});

test("Radar uses the exact delivery follow and keeps user origin dominant for a shared source", async (t) => {
  const service = await fixture(t);
  const identity: RemoteSourceIdentity = {
    serverInstanceId,
    tenantId: "tenant-shared-source",
  };
  const common = {
    sourceId: "source-shared",
    url: "https://example.com/shared",
    state: "active" as const,
    refreshIntervalMinutes: 60,
    createdAt: observedAt,
    updatedAt: observedAt,
  };
  service.store.saveRadarFollow(identity, {
    ...common,
    id: "follow-recommended-shared",
    origin: "recommended",
    recommendedSourceId: "recommended-shared",
    name: "服务器推荐来源",
    category: "服务器分类",
  });
  service.store.saveRadarFollow(identity, {
    ...common,
    id: "follow-user-shared",
    origin: "user",
    name: "用户关注来源",
    category: "用户分类",
  });
  const delivery = (
    revisionId: string,
    text: string,
    followId: string,
  ): Source => ({
    id: randomUUID(),
    title: `共享来源 ${revisionId}`,
    type: "url",
    location: common.url,
    text,
    addedAt: observedAt,
    coverage: "网页正文（fulltext）",
    remote: {
      ...identity,
      sourceId: common.sourceId,
      followId,
      itemId: "item-shared",
      revisionId,
      contentHash: createHash("sha256").update(text).digest("hex"),
      observedAt,
      coverageLevel: "fulltext",
      missing: [],
    },
  });

  const first = delivery(
    "revision-shared-1",
    "服务器推荐首次投递",
    "follow-recommended-shared",
  );
  service.store.commitRemoteSourcePage({
    ...identity,
    nextCursor: "shared_recommended.signature",
    sources: [first],
  });
  let item = service.store.radarItems(identity)[0]!;
  assert.equal(item.origin, "recommended");
  assert.equal(item.followId, "follow-recommended-shared");
  assert.equal(item.sourceTitle, "服务器推荐来源");

  service.store.commitRemoteSourcePage({
    ...identity,
    nextCursor: "shared_user.signature",
    sources: [
      delivery("revision-shared-1", "服务器推荐首次投递", "follow-user-shared"),
    ],
  });
  item = service.store.radarItems(identity)[0]!;
  assert.equal(item.revisionCount, 1);
  assert.equal(item.origin, "user");
  assert.equal(item.followId, "follow-user-shared");
  assert.equal(item.sourceTitle, "用户关注来源");
  assert.equal(item.category, "用户分类");

  service.store.commitRemoteSourcePage({
    ...identity,
    nextCursor: "shared_recommended_revision.signature",
    sources: [
      delivery(
        "revision-shared-2",
        "服务器推荐后续修订",
        "follow-recommended-shared",
      ),
    ],
  });
  const items = service.store.radarItems(identity);
  assert.equal(items.length, 1);
  item = items[0]!;
  assert.equal(item.revisionCount, 2);
  assert.equal(item.origin, "user");
  assert.equal(item.followId, "follow-user-shared");
  assert.equal(item.sourceTitle, "用户关注来源");
  assert.equal(item.category, "用户分类");
});

test("Radar persists one current identity, scopes offline data, and stops catalog polling on close", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ytriple-radar-identity-"),
  );
  const dataPath = path.join(root, "data");
  const identityA: RemoteSourceIdentity = {
    serverInstanceId,
    tenantId: "tenant-isolation-a",
  };
  const identityB: RemoteSourceIdentity = {
    serverInstanceId: "2d584da9-e2eb-46aa-87a3-64fc84068be1",
    tenantId: "tenant-isolation-b",
  };
  const services = new Set<WorkbenchService>();
  t.after(async () => {
    await Promise.all(
      [...services].map((service) => service.close().catch(() => undefined)),
    );
    await fs.rm(root, { recursive: true, force: true });
  });
  const open = (
    sourceGateway?: SourceGateway,
    radarRefreshIntervalMs?: number,
  ) => {
    const service = new WorkbenchService(
      dataPath,
      () => undefined,
      () => {},
      sourceGateway ? { sourceGateway, radarRefreshIntervalMs } : {},
    );
    services.add(service);
    service.store.setConfig("settings", {
      ...service.store.settings(),
      aiRoot: path.join(root, "AI"),
      codeRoot: path.join(root, "Code"),
      workspaceRoot: path.join(root, "work"),
      projectMonitoring: false,
    });
    return service;
  };
  const close = async (service: WorkbenchService) => {
    await service.close();
    services.delete(service);
  };
  const sourceFor = (
    identity: RemoteSourceIdentity,
    suffix: string,
  ): Source => {
    const text = `隔离正文 ${suffix}`;
    return {
      id: randomUUID(),
      title: `隔离条目 ${suffix}`,
      type: "url",
      location: `https://example.com/${suffix}`,
      text,
      addedAt: observedAt,
      coverage: "网页正文（fulltext）",
      remote: {
        ...identity,
        sourceId: `source-${suffix}`,
        itemId: `item-${suffix}`,
        revisionId: `revision-${suffix}`,
        contentHash: createHash("sha256").update(text).digest("hex"),
        observedAt,
        coverageLevel: "fulltext",
        missing: [],
      },
    };
  };
  const waitFor = async (ready: () => boolean, description: string) => {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if (ready()) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`等待超时：${description}`);
  };

  const seed = open();
  await seed.initialize();
  seed.store.commitRemoteSourcePage({
    ...identityA,
    nextCursor: "identity_a.signature",
    sources: [sourceFor(identityA, "identity-a")],
  });
  seed.store.commitRemoteSourcePage({
    ...identityB,
    nextCursor: "identity_b.signature",
    sources: [sourceFor(identityB, "identity-b")],
  });
  await close(seed);

  const cached = open();
  let snapshot = await cached.initialize();
  assert.equal(snapshot.radar?.configured, false);
  assert.equal(snapshot.radar?.connection, "unconfigured");
  assert.deepEqual(
    snapshot.radar?.items.map((item) => item.tenantId),
    [identityB.tenantId],
  );
  assert.equal(cached.store.radarItems(identityA).length, 1);
  assert.equal(cached.store.radarItems(identityB).length, 1);
  cached.store.db
    .prepare("DELETE FROM config WHERE key=?")
    .run("radar.source_identity");
  await close(cached);

  const unconfigured = open();
  snapshot = await unconfigured.initialize();
  assert.equal(snapshot.radar?.connection, "unconfigured");
  assert.deepEqual(snapshot.radar?.items, []);
  assert.deepEqual(snapshot.radar?.follows, []);
  assert.deepEqual(snapshot.radar?.recommendedSources, []);
  assert.deepEqual(snapshot.radar?.events, []);
  assert.equal(snapshot.radar?.lastSyncAt, undefined);
  await close(unconfigured);

  const catalogGateway: SourceGateway = {
    addURL: async () => {
      throw new Error("not used");
    },
    radarCatalog: async () => ({
      ...identityA,
      follows: [],
      recommendedSources: [],
    }),
  };
  const online = open(catalogGateway, 60_000);
  await online.initialize();
  await waitFor(
    () => online.store.radarIdentity()?.tenantId === identityA.tenantId,
    "成功目录请求持久化身份",
  );
  await close(online);

  let attempts = 0;
  const offlineGateway: SourceGateway = {
    addURL: async () => {
      throw new Error("not used");
    },
    radarCatalog: async () => {
      attempts++;
      throw new Error("source service offline");
    },
    startReceiving: (sink) => sink.reportStatus?.("offline"),
  };
  const offline = open(offlineGateway, 15);
  await offline.initialize();
  await waitFor(() => attempts >= 2, "周期刷新 Radar 状态");
  snapshot = await offline.snapshot();
  assert.equal(snapshot.radar?.configured, true);
  assert.equal(snapshot.radar?.connection, "offline");
  assert.match(snapshot.radar?.error ?? "", /source service offline/);
  assert.deepEqual(
    snapshot.radar?.items.map((item) => item.tenantId),
    [identityA.tenantId],
  );
  assert.equal(snapshot.radar?.items[0]?.title, "隔离条目 identity-a");
  await close(offline);
  const attemptsAtClose = attempts;
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  assert.equal(attempts, attemptsAtClose);
});

test("legacy generated inbox migrates into Radar while a user-modified inbox is preserved", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ytriple-radar-migration-"),
  );
  const dataPath = path.join(root, "data");
  const first = new WorkbenchService(dataPath, () => undefined);
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const goal =
    "接收信息源服务同步的资料，并由团队筛选、理解和整理为可复用内容。";
  const makeSource = (
    identity: { serverInstanceId: string; tenantId: string },
    suffix: string,
  ): Source => {
    const text = `迁移前远端正文 ${suffix}`;
    return {
      id: randomUUID(),
      title: `迁移资料 ${suffix}`,
      type: "url",
      location: `https://example.com/${suffix}`,
      text,
      addedAt: observedAt,
      coverage: "网页正文（fulltext）",
      remote: {
        ...identity,
        sourceId: `source-${suffix}`,
        itemId: `item-${suffix}`,
        revisionId: `revision-${suffix}`,
        contentHash: createHash("sha256").update(text).digest("hex"),
        observedAt,
        coverageLevel: "fulltext",
        missing: [],
      },
    };
  };
  const saveLegacy = (
    id: string,
    identity: { serverInstanceId: string; tenantId: string },
    title: string,
    withSource = true,
  ) => {
    first.store.saveTask({
      id,
      title,
      goal,
      goalVersion: 1,
      kind: "research",
      member: "coordinator",
      workspace: path.join(root, id),
      status: "idle",
      createdAt: observedAt,
      updatedAt: observedAt,
      messages: [
        {
          id: randomUUID(),
          role: "user",
          member: "coordinator",
          content: goal,
          createdAt: observedAt,
          goalVersion: 1,
        },
      ],
      events: [],
      sources: withSource ? [makeSource(identity, id)] : [],
      artifacts: [],
    });
    first.store.db
      .prepare(
        `INSERT INTO remote_source_inboxes(
           server_instance_id, tenant_id, task_id, created_at
         ) VALUES(?,?,?,?)`,
      )
      .run(identity.serverInstanceId, identity.tenantId, id, observedAt);
  };
  const generatedIdentity = {
    serverInstanceId,
    tenantId: "tenant-generated-inbox",
  };
  const modifiedIdentity = {
    serverInstanceId: "b5fd8d84-cb0e-4fdb-bab5-0bc915398cc8",
    tenantId: "tenant-modified-inbox",
  };
  const emptyIdentity = {
    serverInstanceId: "80fb7caa-1c6b-4416-bad3-6573749a3b71",
    tenantId: "tenant-empty-inbox",
  };
  saveLegacy("generated-inbox", generatedIdentity, "信息源收件箱");
  saveLegacy("modified-inbox", modifiedIdentity, "我整理过的信息源");
  saveLegacy("empty-generated-inbox", emptyIdentity, "信息源收件箱", false);
  first.store.db
    .prepare(
      `INSERT INTO remote_source_cursors(
         server_instance_id, tenant_id, cursor, updated_at
       ) VALUES(?,?,?,?)`,
    )
    .run(
      generatedIdentity.serverInstanceId,
      generatedIdentity.tenantId,
      "legacy_cursor.signature",
      observedAt,
    );
  await first.close();

  const reopened = new WorkbenchService(dataPath, () => undefined);
  try {
    assert.equal(reopened.store.hasTask("generated-inbox"), false);
    assert.equal(reopened.store.hasTask("empty-generated-inbox"), false);
    assert.equal(reopened.store.hasTask("modified-inbox"), true);
    const item = reopened.store.radarItems(generatedIdentity)[0];
    assert.equal(item?.remoteItemId, "item-generated-inbox");
    assert.equal(item?.content, "迁移前远端正文 generated-inbox");
    assert.equal(
      reopened.store.remoteSourceCursor(generatedIdentity),
      "legacy_cursor.signature",
    );
    assert.equal(
      Number(
        (
          reopened.store.db
            .prepare("SELECT COUNT(*) AS count FROM remote_source_inboxes")
            .get() as { count: number }
        ).count,
      ),
      0,
    );
  } finally {
    await reopened.close();
  }
});

test("editorial delivery, corrections and immutable versions are cached without automatic tasks", async (t) => {
  const { editorialRevision } = await import("./fixtures/editorial.js");
  const first = editorialRevision();
  const identity = { serverInstanceId, tenantId: "editorial-tenant" };
  let available = true;
  let lookups = 0;
  const requests: string[] = [];
  const gateway: SourceGateway = {
    addURL: async () => {
      throw new Error("unused");
    },
    radarCatalog: async () => {
      if (!available) throw new Error("offline");
      return {
        ...identity,
        follows: [],
        recommendedSources: [],
        editorial: {
          status: { state: "ready" },
          issues: [
            {
              id: first.issueId,
              focus: "AI",
              createdAt: first.createdAt,
              updatedAt: first.createdAt,
              latest: first,
              history: [first],
              corrections: [],
            },
          ],
        },
      };
    },
    editorialRevision: async () => {
      lookups++;
      return { ...identity, revision: first };
    },
    correctEditorial: async (issueId, input, requestId) => {
      requests.push(requestId);
      return {
        ...identity,
        correction: {
          ...input,
          issueId,
          id: "d95c065c-3374-4b3b-bcda-b50d9e3d4ac4",
          createdAt: first.createdAt,
          status: "pending",
        },
      };
    },
  };
  const lifecycle = { closed: false };
  const service = await fixture(t, gateway, lifecycle);
  let snapshot = await service.connectSourceService(
    gateway,
    "https://editorial.example.com",
  );
  assert.equal(snapshot.radar?.editorial?.issues.length, 1);
  assert.equal(snapshot.tasks.length, 0);
  snapshot = await service.execute({
    type: "radar.editorialVersion",
    issueId: first.issueId,
    revisionId: first.id,
  });
  assert.deepEqual(snapshot.radar?.editorialVersions?.[first.id], first);
  assert.equal(lookups, 0, "current version comes from validated local feed");
  const requestId = randomUUID();
  snapshot = await service.execute({
    type: "radar.correctEditorial",
    issueId: first.issueId,
    revisionId: first.id,
    text: "请复核当前证据的完整性。",
    requestId,
  });
  assert.equal(
    snapshot.radar?.editorial?.issues[0]?.corrections[0]?.status,
    "pending",
  );
  assert.deepEqual(requests, [requestId]);
  assert.equal(snapshot.tasks.length, 0);
  available = false;
  const taskId = randomUUID();
  snapshot = await service.execute({
    type: "radar.discussEditorial",
    issueId: first.issueId,
    revisionId: first.id,
    requestId: taskId,
  });
  const task = snapshot.tasks.find((task) => task.id === taskId)!;
  assert.ok(task);
  assert.match(task.sources[0]!.text, /未取得全文/);
  assert.ok(task.sources[0]!.text.includes(first.id));
  assert.match(task.sources[0]!.text, /当时使用的材料/);
  snapshot = await service.execute({
    type: "radar.discussEditorial",
    issueId: first.issueId,
    revisionId: first.id,
    requestId: taskId,
  });
  assert.equal(
    snapshot.tasks.length,
    1,
    "uncertain retry must not duplicate a discussion",
  );
  assert.equal(lookups, 0);
  await service.close();
  lifecycle.closed = true;
  const reopened = new WorkbenchService(
    service.store.dataPath,
    () => undefined,
    () => {},
    { sourceGateway: gateway, autoDigestRadar: false },
  );
  try {
    const restored = await reopened.initialize();
    assert.equal(restored.radar?.editorial?.issues[0]?.latest.id, first.id);
    assert.deepEqual(restored.radar?.editorialVersions?.[first.id], first);
    assert.equal(restored.tasks.length, 1);
  } finally {
    await reopened.close();
  }
});

test("HTTP editorial endpoints preserve identity, revisions, and correction idempotency", async () => {
  const { editorialRevision } = await import("./fixtures/editorial.js");
  const first = editorialRevision();
  const requestId = randomUUID();
  const calls: string[] = [];
  const gateway = new HttpSourceGateway({
    baseURL: "https://editorial.example.com",
    token: "device-key",
    fetch: async (input, request) => {
      const pathname = new URL(String(input)).pathname;
      calls.push(pathname);
      if (pathname === "/v1/capabilities")
        return json({
          meta,
          tenantId: "tenant-editorial",
          capabilities: {
            publicUrl: true,
            explicitRefresh: true,
            changes: true,
            itemRevisions: true,
            sourceFollows: true,
            recommendedSources: true,
            readingTopics: true,
            editorial: true,
          },
          scopes: ["content:read", "sources:read", "sources:write"],
        });
      if (pathname === "/v1/follows") return json({ meta, follows: [] });
      if (pathname === "/v1/recommended-sources")
        return json({ meta, sources: [] });
      if (pathname === "/v1/editorial")
        return json({ meta, issues: [], status: { state: "waiting" } });
      if (pathname.endsWith("/corrections")) {
        assert.equal(
          new Headers(request?.headers).get("Idempotency-Key"),
          requestId,
        );
        return json(
          {
            meta,
            correction: {
              id: randomUUID(),
              issueId: first.issueId,
              revisionId: first.id,
              text: "明确独立证据的缺口。",
              createdAt: first.createdAt,
              status: "pending",
            },
          },
          201,
        );
      }
      if (pathname.endsWith(`/revisions/${first.id}`))
        return json({ meta, revision: first });
      throw new Error("unexpected request");
    },
  });
  const catalog = await gateway.radarCatalog();
  assert.equal(catalog.editorial?.status.state, "waiting");
  assert.ok(
    !calls.includes("/v1/reading"),
    "new delivery does not request abandoned category summaries",
  );
  const old = await gateway.editorialRevision(first.issueId, first.id);
  assert.deepEqual(old.revision, first);
  assert.equal(old.serverInstanceId, serverInstanceId);
  const corrected = await gateway.correctEditorial(
    first.issueId,
    { revisionId: first.id, text: "明确独立证据的缺口。" },
    requestId,
  );
  assert.equal(corrected.correction.status, "pending");
  await gateway.close();
});
