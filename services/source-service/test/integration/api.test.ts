import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import {
  ChangeStreamEventSchema,
  ChangesResponseSchema,
  ErrorResponseSchema,
  JobResponseSchema,
  PairResponseSchema,
  RecommendedSourcesResponseSchema,
  RevisionResponseSchema,
  SourceFollowJobResponseSchema,
  SourceFollowResponseSchema,
  SourceFollowsResponseSchema,
  UpsertURLSourceResponseSchema,
} from "@ytriple/source-contract";
import { createSourceApi, type SourceApi } from "../../src/api.js";
import type { SourceServiceConfig } from "../../src/config.js";
import { PublicURLConnectorError } from "../../src/connectors/public-url.js";
import { tokenForDevice } from "../../src/security.js";
import { JobLeaseLostError, SourceDatabase } from "../../src/store/database.js";
import { SourceWorker } from "../../src/worker.js";

const databaseURL = process.env.SOURCE_TEST_DATABASE_URL;
if (!databaseURL) throw new Error("SOURCE_TEST_DATABASE_URL 未设置。");

const config: SourceServiceConfig = {
  databaseURL,
  host: "127.0.0.1",
  port: 47321,
  bootstrapToken: "integration-bootstrap",
  tokenSecret: "integration-device-token-secret-000000000",
  cursorSecret: "integration-cursor-signing-secret-0000000",
  pairingEnabled: true,
  workerPollMs: 25,
};
const contentHash = (content: string) =>
  createHash("sha256").update(content).digest("hex");

let database: SourceDatabase;
let api: SourceApi;
let baseURL: string;

async function listenAPI(nextApi: SourceApi): Promise<void> {
  api = nextApi;
  await new Promise<void>((resolve, reject) => {
    api.server.once("error", reject);
    api.server.listen(0, "127.0.0.1", resolve);
  });
  const address = api.server.address() as AddressInfo;
  baseURL = `http://127.0.0.1:${address.port}`;
}

beforeEach(async () => {
  database = new SourceDatabase(databaseURL);
  await database.migrate();
  await database.pool.query("TRUNCATE tenant RESTART IDENTITY CASCADE");
  await listenAPI(
    await createSourceApi(database, config, {
      streamHeartbeatMs: 50,
      // A stream test that receives a prompt change proves LISTEN/NOTIFY woke it;
      // the low-frequency fallback cannot be responsible within the test window.
      streamFallbackPollMs: 60_000,
      streamBackpressureTimeoutMs: 1_000,
    }),
  );
});

afterEach(async () => {
  await api.close();
  await database.close();
});

async function json(path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseURL}${path}`, {
    ...init,
    headers: { Accept: "application/json", ...init.headers },
    redirect: "error",
  });
  return { response, body: await response.json() };
}

async function pair(key = "pair-device-1", deviceName = "integration desktop") {
  const result = await json("/v1/pairing/bootstrap", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify({
      deviceName,
      bootstrapToken: config.bootstrapToken,
    }),
  });
  assert.equal(result.response.status, 201);
  return PairResponseSchema.parse(result.body);
}

function bearer(token: string, extra: Record<string, string> = {}) {
  return { Authorization: `Bearer ${token}`, ...extra };
}

type ParsedSSEFrame = {
  comment?: string;
  event?: string;
  id?: string;
  data?: unknown;
};

class TestSSEStream {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = "";

  constructor(
    response: Response,
    private readonly controller: AbortController,
  ) {
    assert.ok(response.body);
    this.reader = response.body.getReader();
  }

  async next(): Promise<ParsedSSEFrame> {
    while (!this.buffer.includes("\n\n")) {
      const { done, value } = await this.reader.read();
      if (done) throw new Error("SSE 连接在下一帧前关闭。");
      this.buffer += this.decoder.decode(value, { stream: true });
    }
    const boundary = this.buffer.indexOf("\n\n");
    const raw = this.buffer.slice(0, boundary);
    this.buffer = this.buffer.slice(boundary + 2);
    if (raw.startsWith(":")) return { comment: raw.slice(1).trim() };
    const result: ParsedSSEFrame = {};
    const data: string[] = [];
    for (const line of raw.split("\n")) {
      const separator = line.indexOf(":");
      const name = separator < 0 ? line : line.slice(0, separator);
      const value =
        separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
      if (name === "id") result.id = value;
      else if (name === "event") result.event = value;
      else if (name === "data") data.push(value);
    }
    if (data.length) result.data = JSON.parse(data.join("\n"));
    return result;
  }

  async nextChange(): Promise<ParsedSSEFrame> {
    while (true) {
      const frame = await this.next();
      if (frame.event === "change") return frame;
    }
  }

  close(): void {
    this.controller.abort();
  }
}

async function openSSE(
  path: string,
  token: string,
  headers: Record<string, string> = {},
): Promise<TestSSEStream> {
  const controller = new AbortController();
  const response = await fetch(`${baseURL}${path}`, {
    headers: bearer(token, { Accept: "text/event-stream", ...headers }),
    signal: controller.signal,
    redirect: "error",
  });
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") || "",
    /^text\/event-stream/,
  );
  return new TestSSEStream(response, controller);
}

test("持久 URL 作业、修订、changes 与幂等写入形成完整纵向切片", async () => {
  const unauthenticatedCapabilities = await json("/v1/capabilities");
  assert.equal(unauthenticatedCapabilities.response.status, 401);
  const device = await pair();
  const capabilities = await json("/v1/capabilities", {
    headers: bearer(device.token),
  });
  assert.equal(capabilities.response.status, 200);
  const sourceRequest = {
    method: "PUT",
    headers: bearer(device.token, {
      "Content-Type": "application/json",
      "Idempotency-Key": "url-upsert-1",
    }),
    body: JSON.stringify({ url: "https://example.com/article#fragment" }),
  } satisfies RequestInit;

  const [firstRaw, replayRaw] = await Promise.all([
    json("/v1/sources/url", sourceRequest),
    json("/v1/sources/url", sourceRequest),
  ]);
  assert.equal(firstRaw.response.status, 202);
  assert.equal(replayRaw.response.status, 202);
  const first = UpsertURLSourceResponseSchema.parse(firstRaw.body);
  const replay = UpsertURLSourceResponseSchema.parse(replayRaw.body);
  assert.deepEqual(replay, first);

  const counts = await database.pool.query<{
    sources: string;
    jobs: string;
  }>(`SELECT
        (SELECT count(*) FROM source) AS sources,
        (SELECT count(*) FROM fetch_run) AS jobs`);
  assert.deepEqual(counts.rows[0], { sources: "1", jobs: "1" });

  const pending = await json(`/v1/jobs/${first.job.id}`, {
    headers: bearer(device.token),
  });
  assert.equal(JobResponseSchema.parse(pending.body).job.status, "queued");

  const initialContent =
    "A complete integration article body with enough useful text to read.";
  let content = initialContent;
  let title = "Integration article";
  const worker = new SourceWorker(database, {
    fetcher: async (url) => ({
      canonicalUrl: url,
      title,
      content,
      observedAt: new Date().toISOString(),
      contentHash: contentHash(content),
      coverage: "fulltext",
      missing: ["media", "authenticated-content"],
    }),
  });
  assert.equal(await worker.processOne(), true);

  const completedRaw = await json(`/v1/jobs/${first.job.id}`, {
    headers: bearer(device.token),
  });
  const completed = JobResponseSchema.parse(completedRaw.body).job;
  assert.equal(completed.status, "succeeded");
  assert.ok(completed.itemId && completed.revisionId);

  const revisionRaw = await json(
    `/v1/items/${completed.itemId}/revisions/${completed.revisionId}`,
    { headers: bearer(device.token) },
  );
  const revision = RevisionResponseSchema.parse(revisionRaw.body);
  assert.equal(revision.revision.content, content);
  assert.equal(revision.item.canonicalUrl, "https://example.com/article");
  assert.equal(revision.item.externalItemKey, "page");

  // The persistence model must already allow a future feed/platform source to
  // hold many stable external items, even though public-url emits only `page`.
  await database.pool.query(
    `INSERT INTO source_item(
       id, tenant_id, source_id, external_item_key, canonical_url, title
     ) VALUES ($1, $2, $3, 'future-entry-2', $4, 'Future feed entry')`,
    [
      randomUUID(),
      device.tenantId,
      first.source.id,
      "https://example.com/article/entry-2",
    ],
  );
  const sourceItems = await database.pool.query<{ count: string }>(
    `SELECT count(*) FROM source_item
     WHERE tenant_id = $1 AND source_id = $2`,
    [device.tenantId, first.source.id],
  );
  assert.equal(sourceItems.rows[0]!.count, "2");

  const oneShotChanges = ChangesResponseSchema.parse(
    (
      await json("/v1/changes?limit=1", {
        headers: bearer(device.token),
      })
    ).body,
  );
  assert.deepEqual(oneShotChanges.changes, []);

  const followed = SourceFollowJobResponseSchema.parse(
    (
      await json("/v1/follows", {
        method: "POST",
        headers: bearer(device.token, {
          "Content-Type": "application/json",
          "Idempotency-Key": "follow-existing-url",
        }),
        body: JSON.stringify({
          source: { kind: "public-url", url: first.source.url },
          name: "Integration follow",
          category: "测试",
        }),
      })
    ).body,
  );
  assert.equal(followed.follow.sourceId, first.source.id);
  assert.equal(await worker.processOne(), true);
  const firstChangesRaw = await json("/v1/changes?limit=1", {
    headers: bearer(device.token),
  });
  const firstChanges = ChangesResponseSchema.parse(firstChangesRaw.body);
  assert.equal(firstChanges.changes.length, 1);
  assert.equal(firstChanges.changes[0]!.kind, "item.created");
  assert.equal(firstChanges.changes[0]!.followId, followed.follow.id);
  const samePage = ChangesResponseSchema.parse(
    (await json("/v1/changes?limit=1", { headers: bearer(device.token) })).body,
  );
  assert.deepEqual(samePage, firstChanges);

  const empty = ChangesResponseSchema.parse(
    (
      await json(
        `/v1/changes?limit=1&cursor=${encodeURIComponent(firstChanges.nextCursor)}`,
        { headers: bearer(device.token) },
      )
    ).body,
  );
  assert.deepEqual(empty.changes, []);

  const conflict = await json("/v1/sources/url", {
    ...sourceRequest,
    body: JSON.stringify({ url: "https://example.net/different" }),
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(
    ErrorResponseSchema.parse(conflict.body).error.code,
    "IDEMPOTENCY_KEY_REUSED",
  );

  const refresh = await json(`/v1/follows/${followed.follow.id}/refresh`, {
    method: "POST",
    headers: bearer(device.token, {
      "Content-Type": "application/json",
      "Idempotency-Key": "refresh-2",
    }),
    body: "{}",
  });
  assert.equal(refresh.response.status, 202);
  content = `${content} A later revision adds one verified fact.`;
  assert.equal(await worker.processOne(), true);
  const later = ChangesResponseSchema.parse(
    (
      await json(`/v1/changes?cursor=${encodeURIComponent(empty.nextCursor)}`, {
        headers: bearer(device.token),
      })
    ).body,
  );
  assert.equal(later.changes.length, 1);
  assert.equal(later.changes[0]!.kind, "item.revised");

  content = `${content} Two simultaneous workers observe this same third revision.`;
  const concurrentRefreshes = await Promise.all(
    ["refresh-concurrent-a", "refresh-concurrent-b"].map((key) =>
      json(`/v1/follows/${followed.follow.id}/refresh`, {
        method: "POST",
        headers: bearer(device.token, {
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        }),
        body: "{}",
      }),
    ),
  );
  const concurrentJobs = concurrentRefreshes.map(
    ({ body }) => SourceFollowJobResponseSchema.parse(body).job,
  );
  assert.equal(concurrentJobs[0]!.id, concurrentJobs[1]!.id);
  const processedConcurrently = await Promise.all([
    worker.processOne(),
    worker.processOne(),
  ]);
  assert.equal(
    processedConcurrently.filter(Boolean).length,
    1,
    "并发 worker 只能有一个获得同一关注任务",
  );
  for (const job of concurrentJobs) {
    const result = JobResponseSchema.parse(
      (
        await json(`/v1/jobs/${job.id}`, {
          headers: bearer(device.token),
        })
      ).body,
    );
    assert.equal(result.job.status, "succeeded");
  }
  const concurrentChanges = ChangesResponseSchema.parse(
    (
      await json(`/v1/changes?cursor=${encodeURIComponent(later.nextCursor)}`, {
        headers: bearer(device.token),
      })
    ).body,
  );
  assert.equal(concurrentChanges.changes.length, 1);
  assert.equal(concurrentChanges.changes[0]!.kind, "item.revised");

  content = initialContent;
  const rollbackRefresh = SourceFollowJobResponseSchema.parse(
    (
      await json(`/v1/follows/${followed.follow.id}/refresh`, {
        method: "POST",
        headers: bearer(device.token, {
          "Content-Type": "application/json",
          "Idempotency-Key": "refresh-content-rollback",
        }),
        body: "{}",
      })
    ).body,
  ).job;
  assert.equal(await worker.processOne(), true);
  const rollbackJob = JobResponseSchema.parse(
    (
      await json(`/v1/jobs/${rollbackRefresh.id}`, {
        headers: bearer(device.token),
      })
    ).body,
  ).job;
  assert.equal(rollbackJob.status, "succeeded");
  assert.notEqual(rollbackJob.revisionId, completed.revisionId);
  const rollbackChanges = ChangesResponseSchema.parse(
    (
      await json(
        `/v1/changes?cursor=${encodeURIComponent(concurrentChanges.nextCursor)}`,
        { headers: bearer(device.token) },
      )
    ).body,
  );
  assert.equal(rollbackChanges.changes.length, 1);
  assert.equal(
    rollbackChanges.changes[0]!.contentHash,
    contentHash(initialContent),
  );

  title = "Integration article retitled";
  const metadataRefresh = SourceFollowJobResponseSchema.parse(
    (
      await json(`/v1/follows/${followed.follow.id}/refresh`, {
        method: "POST",
        headers: bearer(device.token, {
          "Content-Type": "application/json",
          "Idempotency-Key": "refresh-metadata-only",
        }),
        body: "{}",
      })
    ).body,
  ).job;
  assert.equal(await worker.processOne(), true);
  const metadataJob = JobResponseSchema.parse(
    (
      await json(`/v1/jobs/${metadataRefresh.id}`, {
        headers: bearer(device.token),
      })
    ).body,
  ).job;
  assert.equal(metadataJob.status, "succeeded");
  assert.notEqual(metadataJob.revisionId, rollbackJob.revisionId);
  const metadataChanges = ChangesResponseSchema.parse(
    (
      await json(
        `/v1/changes?cursor=${encodeURIComponent(rollbackChanges.nextCursor)}`,
        { headers: bearer(device.token) },
      )
    ).body,
  );
  assert.equal(metadataChanges.changes.length, 1);
});

test(
  "服务器默认来源自动关注，worker 定时观察并经 SSE 推送，用户关注可暂停删除",
  { timeout: 10_000 },
  async () => {
    await api.close();
    const recommendedURL =
      "https://raw.githubusercontent.com/openai/openai-agents-js/main/packages/agents/CHANGELOG.md";
    await listenAPI(
      await createSourceApi(
        database,
        {
          ...config,
          recommendedDefaultsEnabled: true,
          recommendedSources: [
            {
              id: "openai-agents-js-changelog",
              name: "OpenAI Agents JS 更新",
              category: "开发工具",
              description: "OpenAI 官方仓库发布的 SDK 变更记录。",
              url: recommendedURL,
              refreshIntervalMinutes: 360,
              enabledByDefault: true,
            },
          ],
        },
        {
          streamHeartbeatMs: 50,
          streamFallbackPollMs: 60_000,
          streamBackpressureTimeoutMs: 1_000,
        },
      ),
    );
    const device = await pair("pair-follow-default", "Radar desktop");
    const catalog = RecommendedSourcesResponseSchema.parse(
      (
        await json("/v1/recommended-sources", {
          headers: bearer(device.token),
        })
      ).body,
    );
    assert.equal(catalog.sources.length, 1);
    assert.equal(catalog.sources[0]!.url, recommendedURL);
    assert.equal(catalog.sources[0]!.category, "开发工具");

    let follows = SourceFollowsResponseSchema.parse(
      (await json("/v1/follows", { headers: bearer(device.token) })).body,
    ).follows;
    assert.equal(follows.length, 1);
    const recommended = follows[0]!;
    assert.equal(recommended.origin, "recommended");
    assert.equal(recommended.state, "active");

    let content =
      "# OpenAI Agents JS changelog\n\nA factual SDK release entry.";
    const worker = new SourceWorker(database, {
      fetcher: async (url) => ({
        canonicalUrl: url,
        title: "OpenAI Agents JS changelog",
        content,
        observedAt: new Date().toISOString(),
        contentHash: contentHash(content),
        coverage: "fulltext",
        missing: [],
      }),
    });
    const stream = await openSSE("/v1/changes/stream", device.token);
    assert.deepEqual(await stream.next(), { comment: "connected" });
    assert.equal(await worker.processOne(), true);
    const initial = ChangeStreamEventSchema.parse(
      (await stream.nextChange()).data,
    );
    assert.equal(initial.change.kind, "item.created");
    assert.equal(initial.change.sourceId, recommended.sourceId);

    follows = SourceFollowsResponseSchema.parse(
      (await json("/v1/follows", { headers: bearer(device.token) })).body,
    ).follows;
    assert.ok(follows[0]!.lastAttemptAt);
    assert.ok(follows[0]!.lastSuccessAt);
    assert.equal(follows[0]!.lastError, undefined);

    await database.pool.query(
      `UPDATE source_follow SET next_refresh_at = clock_timestamp() - interval '1 second'
       WHERE tenant_id = $1 AND id = $2`,
      [device.tenantId, recommended.id],
    );
    content += "\nA later scheduled SDK release entry.";
    assert.equal(await worker.processOne(), true);
    const scheduled = ChangeStreamEventSchema.parse(
      (await stream.nextChange()).data,
    );
    assert.equal(scheduled.change.kind, "item.revised");
    assert.equal(scheduled.change.sourceId, recommended.sourceId);

    await json(`/v1/follows/${recommended.id}/refresh`, {
      method: "POST",
      headers: bearer(device.token, {
        "Content-Type": "application/json",
        "Idempotency-Key": "failed-follow-refresh",
      }),
      body: "{}",
    });
    const failingWorker = new SourceWorker(database, {
      fetcher: async () => {
        throw new PublicURLConnectorError(
          "SOURCE_UNSUPPORTED_CONTENT",
          "该来源本次返回了不支持的内容类型。",
        );
      },
    });
    assert.equal(await failingWorker.processOne(), true);
    follows = SourceFollowsResponseSchema.parse(
      (await json("/v1/follows", { headers: bearer(device.token) })).body,
    ).follows;
    assert.equal(
      follows.find((follow) => follow.id === recommended.id)?.lastError?.code,
      "SOURCE_UNSUPPORTED_CONTENT",
    );

    const paused = SourceFollowResponseSchema.parse(
      (
        await json(`/v1/follows/${recommended.id}`, {
          method: "PATCH",
          headers: bearer(device.token, {
            "Content-Type": "application/json",
            "Idempotency-Key": "pause-recommended-follow",
          }),
          body: JSON.stringify({ state: "paused" }),
        })
      ).body,
    );
    assert.equal(paused.follow.state, "paused");
    await database.pool.query(
      `UPDATE source_follow SET next_refresh_at = clock_timestamp() - interval '1 second'
       WHERE tenant_id = $1 AND id = $2`,
      [device.tenantId, recommended.id],
    );
    assert.equal(await database.scheduleDueFollows(), 0);
    const deleteRecommended = await json(`/v1/follows/${recommended.id}`, {
      method: "DELETE",
      headers: bearer(device.token, {
        "Idempotency-Key": "delete-recommended-follow",
      }),
    });
    assert.equal(deleteRecommended.response.status, 409);
    assert.equal(
      ErrorResponseSchema.parse(deleteRecommended.body).error.code,
      "CONFLICT",
    );

    const userFollow = SourceFollowJobResponseSchema.parse(
      (
        await json("/v1/follows", {
          method: "POST",
          headers: bearer(device.token, {
            "Content-Type": "application/json",
            "Idempotency-Key": "create-user-follow",
          }),
          body: JSON.stringify({
            source: {
              kind: "public-url",
              url: `${recommendedURL}#ignored`,
            },
            name: "用户指定来源",
            category: "研究",
            refreshIntervalMinutes: 30,
          }),
        })
      ).body,
    );
    assert.equal(userFollow.follow.origin, "user");
    assert.equal(userFollow.follow.url, recommendedURL);
    assert.equal(userFollow.follow.sourceId, recommended.sourceId);
    follows = SourceFollowsResponseSchema.parse(
      (await json("/v1/follows", { headers: bearer(device.token) })).body,
    ).follows;
    assert.deepEqual(follows.map((follow) => follow.origin).sort(), [
      "recommended",
      "user",
    ]);
    const pausedUser = SourceFollowResponseSchema.parse(
      (
        await json(`/v1/follows/${userFollow.follow.id}`, {
          method: "PATCH",
          headers: bearer(device.token, {
            "Content-Type": "application/json",
            "Idempotency-Key": "pause-user-follow",
          }),
          body: JSON.stringify({ state: "paused" }),
        })
      ).body,
    );
    assert.equal(pausedUser.follow.state, "paused");
    const queued = await database.pool.query<{ count: string }>(
      `SELECT count(*) FROM fetch_run
       WHERE follow_id = $1 AND status = 'queued'`,
      [userFollow.follow.id],
    );
    assert.equal(queued.rows[0]!.count, "0");
    const deleted = await json(`/v1/follows/${userFollow.follow.id}`, {
      method: "DELETE",
      headers: bearer(device.token, {
        "Idempotency-Key": "delete-user-follow",
      }),
    });
    assert.equal(deleted.response.status, 200);
    assert.deepEqual(deleted.body, {
      meta: paused.meta,
      followId: userFollow.follow.id,
      deleted: true,
    });

    await database.configureRecommendedSources([
      {
        id: "openai-agents-js-changelog",
        name: "OpenAI Agents JS 更新",
        category: "开发工具",
        description: "OpenAI 官方仓库发布的 SDK 变更记录。",
        url: recommendedURL,
        refreshIntervalMinutes: 360,
        enabledByDefault: false,
      },
    ]);
    const secondDevice = await pair(
      "pair-user-before-recommended",
      "second Radar desktop",
    );
    const userFirst = SourceFollowJobResponseSchema.parse(
      (
        await json("/v1/follows", {
          method: "POST",
          headers: bearer(secondDevice.token, {
            "Content-Type": "application/json",
            "Idempotency-Key": "second-user-follow",
          }),
          body: JSON.stringify({
            source: { kind: "public-url", url: recommendedURL },
            name: "用户先关注",
          }),
        })
      ).body,
    );
    const recommendedSecond = SourceFollowJobResponseSchema.parse(
      (
        await json("/v1/follows", {
          method: "POST",
          headers: bearer(secondDevice.token, {
            "Content-Type": "application/json",
            "Idempotency-Key": "second-recommended-follow",
          }),
          body: JSON.stringify({
            source: {
              kind: "recommended",
              recommendedSourceId: "openai-agents-js-changelog",
            },
          }),
        })
      ).body,
    );
    assert.equal(userFirst.follow.sourceId, recommendedSecond.follow.sourceId);
    assert.notEqual(userFirst.follow.id, recommendedSecond.follow.id);
    const secondFollows = SourceFollowsResponseSchema.parse(
      (await json("/v1/follows", { headers: bearer(secondDevice.token) })).body,
    ).follows;
    assert.deepEqual(secondFollows.map((follow) => follow.origin).sort(), [
      "recommended",
      "user",
    ]);
    stream.close();
  },
);

test("同 URL 的用户与推荐关注在两种创建顺序下各自收到每个修订", async () => {
  await database.configureRecommendedSources([
    {
      id: "shared-recommendation-first",
      name: "推荐先创建",
      category: "产品",
      description: "用于验证关注身份保持独立。",
      url: "https://example.com/shared-follow-source-first",
      refreshIntervalMinutes: 60,
      enabledByDefault: false,
    },
    {
      id: "shared-recommendation-second",
      name: "用户先创建",
      category: "产品",
      description: "用于反向验证关注身份保持独立。",
      url: "https://example.com/shared-follow-source-second",
      refreshIntervalMinutes: 60,
      enabledByDefault: false,
    },
  ]);
  const contentByURL = new Map<string, string>();
  const worker = new SourceWorker(database, {
    fetcher: async (url) => ({
      canonicalUrl: url,
      title: "Shared source",
      content: contentByURL.get(url)!,
      observedAt: new Date().toISOString(),
      contentHash: contentHash(contentByURL.get(url)!),
      coverage: "fulltext",
      missing: [],
    }),
  });

  for (const [index, order] of [
    [0, ["recommended", "user"]],
    [1, ["user", "recommended"]],
  ] as const) {
    const sharedURL = `https://example.com/shared-follow-source-${index === 0 ? "first" : "second"}`;
    const recommendationId = `shared-recommendation-${index === 0 ? "first" : "second"}`;
    contentByURL.set(sharedURL, `Shared source ${index} revision zero.`);
    const device = await pair(
      `pair-shared-follow-${index}`,
      `shared follow desktop ${index}`,
    );
    const baseline = ChangesResponseSchema.parse(
      (await json("/v1/changes", { headers: bearer(device.token) })).body,
    );
    const created = [];
    for (const origin of order) {
      const result = await json("/v1/follows", {
        method: "POST",
        headers: bearer(device.token, {
          "Content-Type": "application/json",
          "Idempotency-Key": `shared-${index}-${origin}`,
        }),
        body: JSON.stringify({
          source:
            origin === "recommended"
              ? {
                  kind: "recommended",
                  recommendedSourceId: recommendationId,
                }
              : { kind: "public-url", url: sharedURL },
        }),
      });
      assert.equal(result.response.status, 202);
      created.push(SourceFollowJobResponseSchema.parse(result.body).follow);
    }
    assert.equal(created[0]!.sourceId, created[1]!.sourceId);
    assert.notEqual(created[0]!.id, created[1]!.id);
    assert.equal(await worker.processOne(), true);
    assert.equal(await worker.processOne(), true);
    const initial = ChangesResponseSchema.parse(
      (
        await json(
          `/v1/changes?cursor=${encodeURIComponent(baseline.nextCursor)}`,
          { headers: bearer(device.token) },
        )
      ).body,
    );
    assert.equal(initial.changes.length, 2);
    assert.deepEqual(
      initial.changes.map((change) => change.followId).sort(),
      created.map((follow) => follow.id).sort(),
    );
    assert.equal(
      new Set(initial.changes.map((change) => change.revisionId)).size,
      1,
    );
    assert.ok(
      initial.changes.every((change) => change.kind === "item.created"),
    );

    contentByURL.set(sharedURL, `Shared source ${index} revision one.`);
    for (const follow of created)
      await json(`/v1/follows/${follow.id}/refresh`, {
        method: "POST",
        headers: bearer(device.token, {
          "Content-Type": "application/json",
          "Idempotency-Key": `shared-refresh-${index}-${follow.origin}`,
        }),
        body: "{}",
      });
    assert.equal(await worker.processOne(), true);
    assert.equal(await worker.processOne(), true);
    const revised = ChangesResponseSchema.parse(
      (
        await json(
          `/v1/changes?cursor=${encodeURIComponent(initial.nextCursor)}`,
          { headers: bearer(device.token) },
        )
      ).body,
    );
    assert.equal(revised.changes.length, 2);
    assert.deepEqual(
      revised.changes.map((change) => change.followId).sort(),
      created.map((follow) => follow.id).sort(),
    );
    assert.equal(
      new Set(revised.changes.map((change) => change.revisionId)).size,
      1,
    );
    assert.ok(
      revised.changes.every((change) => change.kind === "item.revised"),
    );
  }
});

test("取消关注保留历史投递身份，并让已领取任务安全完成但不再投递", async () => {
  const device = await pair("pair-unfollow-boundary", "unfollow desktop");
  let serial = 0;
  const createFollow = async () => {
    serial += 1;
    const result = await json("/v1/follows", {
      method: "POST",
      headers: bearer(device.token, {
        "Content-Type": "application/json",
        "Idempotency-Key": `unfollow-create-${serial}`,
      }),
      body: JSON.stringify({
        source: {
          kind: "public-url",
          url: `https://example.com/unfollow-${serial}`,
        },
      }),
    });
    return SourceFollowJobResponseSchema.parse(result.body).follow;
  };
  const removeFollow = async (followId: string) => {
    const result = await json(`/v1/follows/${followId}`, {
      method: "DELETE",
      headers: bearer(device.token, {
        "Idempotency-Key": `unfollow-delete-${serial}`,
      }),
    });
    assert.equal(result.response.status, 200);
  };
  const item = (url: string, content: string) => ({
    canonicalUrl: url,
    title: "Unfollow boundary",
    content,
    observedAt: new Date().toISOString(),
    contentHash: contentHash(content),
    coverage: "fulltext" as const,
    missing: [],
  });

  const deliveredFollow = await createFollow();
  const firstJob = await database.claimJob();
  assert.ok(firstJob);
  await database.completeJob(
    firstJob,
    item(firstJob.sourceURL!, "Delivered before unfollow."),
  );
  const delivered = ChangesResponseSchema.parse(
    (await json("/v1/changes", { headers: bearer(device.token) })).body,
  );
  assert.equal(delivered.changes[0]!.followId, deliveredFollow.id);
  await removeFollow(deliveredFollow.id);
  const replayed = ChangesResponseSchema.parse(
    (await json("/v1/changes", { headers: bearer(device.token) })).body,
  );
  assert.equal(replayed.changes[0]!.followId, deliveredFollow.id);

  const removedInFlight = await createFollow();
  const inFlight = await database.claimJob();
  assert.ok(inFlight);
  assert.equal(inFlight.followId, removedInFlight.id);
  await removeFollow(removedInFlight.id);
  const completed = await database.completeJob(
    inFlight,
    item(inFlight.sourceURL!, "Fetched while the follow was removed."),
  );
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.followId, undefined);
  const afterRemoval = ChangesResponseSchema.parse(
    (
      await json(
        `/v1/changes?cursor=${encodeURIComponent(delivered.nextCursor)}`,
        { headers: bearer(device.token) },
      )
    ).body,
  );
  assert.deepEqual(afterRemoval.changes, []);
});

test(
  "authenticated SSE 补发游标、由 LISTEN/NOTIFY 唤醒并用 Last-Event-ID 恢复",
  { timeout: 10_000 },
  async () => {
    const device = await pair("pair-sse", "SSE desktop");
    const followed = SourceFollowJobResponseSchema.parse(
      (
        await json("/v1/follows", {
          method: "POST",
          headers: bearer(device.token, {
            "Content-Type": "application/json",
            "Idempotency-Key": "sse-source",
          }),
          body: JSON.stringify({
            source: { kind: "public-url", url: "https://example.com/sse" },
          }),
        })
      ).body,
    );
    let content = "The first committed source revision for the SSE stream.";
    const worker = new SourceWorker(database, {
      fetcher: async (url) => ({
        canonicalUrl: url,
        title: "SSE source",
        content,
        observedAt: new Date().toISOString(),
        contentHash: contentHash(content),
        coverage: "fulltext",
        missing: ["media"],
      }),
    });
    assert.equal(await worker.processOne(), true);

    const stream = await openSSE("/v1/changes/stream", device.token);
    assert.deepEqual(await stream.next(), { comment: "connected" });
    const firstFrame = await stream.nextChange();
    const first = ChangeStreamEventSchema.parse(firstFrame.data);
    assert.equal(firstFrame.id, first.cursor);
    assert.equal(firstFrame.event, "change");
    assert.equal(first.change.kind, "item.created");

    content = `${content} A notification-backed second revision.`;
    await json(`/v1/follows/${followed.follow.id}/refresh`, {
      method: "POST",
      headers: bearer(device.token, {
        "Content-Type": "application/json",
        "Idempotency-Key": "sse-refresh-notified",
      }),
      body: "{}",
    });
    assert.equal(await worker.processOne(), true);
    const notifiedFrame = await stream.nextChange();
    const notified = ChangeStreamEventSchema.parse(notifiedFrame.data);
    assert.equal(notifiedFrame.id, notified.cursor);
    assert.equal(notified.change.kind, "item.revised");
    assert.notEqual(notified.change.revisionId, first.change.revisionId);
    stream.close();

    content = `${content} A third revision committed while disconnected.`;
    await json(`/v1/follows/${followed.follow.id}/refresh`, {
      method: "POST",
      headers: bearer(device.token, {
        "Content-Type": "application/json",
        "Idempotency-Key": "sse-refresh-resume",
      }),
      body: "{}",
    });
    assert.equal(await worker.processOne(), true);

    const resumed = await openSSE(
      `/v1/changes/stream?cursor=${encodeURIComponent(first.cursor)}`,
      device.token,
      { "Last-Event-ID": notified.cursor },
    );
    assert.deepEqual(await resumed.next(), { comment: "connected" });
    const resumedFrame = await resumed.nextChange();
    const third = ChangeStreamEventSchema.parse(resumedFrame.data);
    assert.equal(resumedFrame.id, third.cursor);
    assert.notEqual(third.change.revisionId, notified.change.revisionId);

    let heartbeat: ParsedSSEFrame;
    do heartbeat = await resumed.next();
    while (heartbeat.event === "change");
    assert.deepEqual(heartbeat, { comment: "heartbeat" });

    // API shutdown must abort idle streams before waiting for server.close().
    await Promise.race([
      api.close(),
      delay(1_000).then(() => {
        throw new Error("API close did not clean up its SSE stream");
      }),
    ]);
  },
);

test(
  "API 关闭会中止仍在建立通知订阅的 SSE 请求",
  { timeout: 5_000 },
  async () => {
    const device = await pair("pair-sse-close-race", "closing SSE desktop");
    const originalSubscribe = database.subscribeToChanges.bind(database);
    let entered!: () => void;
    let release!: () => void;
    const subscriptionEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const subscriptionGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    database.subscribeToChanges = async (tenantId, listener) => {
      entered();
      await subscriptionGate;
      return originalSubscribe(tenantId, listener);
    };

    const streamRequest = fetch(`${baseURL}/v1/changes/stream`, {
      headers: bearer(device.token, { Accept: "text/event-stream" }),
    }).catch(() => undefined);
    await subscriptionEntered;
    try {
      await Promise.race([
        api.close(),
        delay(1_000).then(() => {
          throw new Error("API close waited for an SSE subscription setup");
        }),
      ]);
    } finally {
      release();
    }
    await streamRequest;
  },
);

test("令牌决定租户，跨租户 ID 查询统一返回 404", async () => {
  const [owner, sibling] = await Promise.all([
    pair("pair-tenant-owner", "owner desktop"),
    pair("pair-tenant-sibling", "sibling desktop"),
  ]);
  assert.equal(sibling.tenantId, owner.tenantId);
  assert.notEqual(sibling.deviceId, owner.deviceId);
  await database.pool.query("UPDATE device SET scopes = $2 WHERE id = $1", [
    sibling.deviceId,
    ["sources:read"],
  ]);
  const siblingReplay = await pair("pair-tenant-sibling", "sibling desktop");
  assert.deepEqual(siblingReplay.scopes, ["sources:read"]);
  const upsert = UpsertURLSourceResponseSchema.parse(
    (
      await json("/v1/sources/url", {
        method: "PUT",
        headers: bearer(owner.token, {
          "Content-Type": "application/json",
          "Idempotency-Key": "owner-source",
        }),
        body: JSON.stringify({ url: "https://example.com/private-to-tenant" }),
      })
    ).body,
  );

  const tenantId = randomUUID();
  const principalId = randomUUID();
  const deviceId = randomUUID();
  const otherToken = tokenForDevice(config.tokenSecret, deviceId);
  const tokenHash = createHash("sha256").update(otherToken).digest("hex");
  await database.pool.query("INSERT INTO tenant(id) VALUES ($1)", [tenantId]);
  await database.pool.query(
    "INSERT INTO principal(id, tenant_id, kind) VALUES ($1, $2, 'self-host-owner')",
    [principalId, tenantId],
  );
  await database.pool.query(
    `INSERT INTO device(id, tenant_id, principal_id, name, token_hash, scopes)
     VALUES ($1, $2, $3, 'other tenant', $4, $5)`,
    [deviceId, tenantId, principalId, tokenHash, owner.scopes],
  );

  const hidden = await json(`/v1/jobs/${upsert.job.id}`, {
    headers: bearer(otherToken),
  });
  assert.equal(hidden.response.status, 404);
  assert.equal(ErrorResponseSchema.parse(hidden.body).error.code, "NOT_FOUND");

  const ownerCursor = ChangesResponseSchema.parse(
    (await json("/v1/changes", { headers: bearer(owner.token) })).body,
  ).nextCursor;
  const invalidCursor = await json(
    `/v1/changes?cursor=${encodeURIComponent(ownerCursor)}`,
    { headers: bearer(otherToken) },
  );
  assert.equal(invalidCursor.response.status, 400);
  assert.equal(
    ErrorResponseSchema.parse(invalidCursor.body).error.code,
    "INVALID_CURSOR",
  );

  const invalidStreamCursor = await json(
    `/v1/changes/stream?cursor=${encodeURIComponent(ownerCursor)}`,
    { headers: bearer(otherToken) },
  );
  assert.equal(invalidStreamCursor.response.status, 400);
  assert.equal(
    ErrorResponseSchema.parse(invalidStreamCursor.body).error.code,
    "INVALID_CURSOR",
  );

  const unauthenticatedStream = await json("/v1/changes/stream");
  assert.equal(unauthenticatedStream.response.status, 401);
  assert.equal(
    ErrorResponseSchema.parse(unauthenticatedStream.body).error.code,
    "UNAUTHORIZED",
  );

  const malformedId = await json("/v1/jobs/not-a-uuid", {
    headers: bearer(owner.token),
  });
  assert.equal(malformedId.response.status, 400);
  assert.equal(
    ErrorResponseSchema.parse(malformedId.body).error.code,
    "INVALID_REQUEST",
  );
});

test("过期 worker 的 fencing token 不能覆盖新租约", async () => {
  const device = await pair("pair-lease", "lease desktop");
  const upsert = UpsertURLSourceResponseSchema.parse(
    (
      await json("/v1/sources/url", {
        method: "PUT",
        headers: bearer(device.token, {
          "Content-Type": "application/json",
          "Idempotency-Key": "lease-source",
        }),
        body: JSON.stringify({ url: "https://example.com/lease" }),
      })
    ).body,
  );
  const stale = await database.claimJob(1);
  assert.ok(stale?.leaseToken);
  const content = "The current lease owns this complete source item body.";
  const item = {
    canonicalUrl: "https://example.com/lease",
    title: "Current lease",
    content,
    observedAt: new Date().toISOString(),
    contentHash: contentHash(content),
    coverage: "fulltext" as const,
    missing: ["media"],
  };
  await database.pool.query(
    "UPDATE fetch_run SET locked_until = now() - interval '1 second' WHERE id = $1",
    [upsert.job.id],
  );
  assert.equal(await database.renewJobLease(stale), false);
  assert.equal(
    await database.failJob(stale, {
      code: "SOURCE_TIMEOUT",
      message: "expired failure",
      retryable: true,
    }),
    false,
  );
  await assert.rejects(database.completeJob(stale, item), JobLeaseLostError);

  const current = await database.claimJob(45);
  assert.ok(current?.leaseToken);
  assert.notEqual(current.leaseToken, stale.leaseToken);
  assert.equal(current.attempt, stale.attempt + 1);
  await assert.rejects(database.completeJob(stale, item), JobLeaseLostError);
  assert.equal(
    await database.failJob(stale, {
      code: "SOURCE_TIMEOUT",
      message: "stale failure",
      retryable: true,
    }),
    false,
  );
  const completed = await database.completeJob(current, item);
  assert.equal(completed.status, "succeeded");
  const rows = await database.pool.query<{ count: string }>(
    "SELECT count(*) FROM delivery_change WHERE tenant_id = $1",
    [device.tenantId],
  );
  assert.equal(rows.rows[0]!.count, "0");
});

test("worker 在慢抓取期间续租，作业不会被重复领取", async () => {
  const device = await pair("pair-heartbeat", "heartbeat desktop");
  await json("/v1/sources/url", {
    method: "PUT",
    headers: bearer(device.token, {
      "Content-Type": "application/json",
      "Idempotency-Key": "heartbeat-source",
    }),
    body: JSON.stringify({ url: "https://example.com/heartbeat" }),
  });
  const content = "A slow but bounded source response owned by one worker.";
  const worker = new SourceWorker(database, {
    leaseSeconds: 1,
    leaseHeartbeatMs: 100,
    fetcher: async (url) => {
      await delay(1_400);
      return {
        canonicalUrl: url,
        title: "Heartbeat source",
        content,
        observedAt: new Date().toISOString(),
        contentHash: contentHash(content),
        coverage: "fulltext",
        missing: ["media"],
      };
    },
  });
  const processing = worker.processOne();
  await delay(1_100);
  assert.equal(await database.claimJob(), undefined);
  assert.equal(await processing, true);
});

test("worker 只持久公开错误码，且不重试确定的 HTTP 4xx", async () => {
  const device = await pair("pair-errors", "error desktop");
  const enqueue = async (key: string, suffix: string) =>
    UpsertURLSourceResponseSchema.parse(
      (
        await json("/v1/sources/url", {
          method: "PUT",
          headers: bearer(device.token, {
            "Content-Type": "application/json",
            "Idempotency-Key": key,
          }),
          body: JSON.stringify({ url: `https://example.com/${suffix}` }),
        })
      ).body,
    ).job;

  const internal = await enqueue("error-internal", "internal");
  const internalWorker = new SourceWorker(database, {
    fetcher: async () => {
      throw Object.assign(new Error("database constraint detail"), {
        code: "23505",
      });
    },
  });
  assert.equal(await internalWorker.processOne(), true);
  const internalResult = JobResponseSchema.parse(
    (
      await json(`/v1/jobs/${internal.id}`, {
        headers: bearer(device.token),
      })
    ).body,
  ).job;
  assert.equal(internalResult.status, "failed");
  if (internalResult.status !== "failed") assert.fail("job must fail");
  assert.equal(internalResult.error.code, "SOURCE_FETCH_FAILED");
  assert.equal(internalResult.error.message, "信息源刷新失败。");
  assert.equal(internalResult.error.retryable, false);

  const missing = await enqueue("error-http-404", "missing");
  const missingWorker = new SourceWorker(database, {
    fetcher: async () => {
      throw new PublicURLConnectorError(
        "SOURCE_HTTP_ERROR",
        "来源返回 HTTP 404。",
        { status: 404 },
      );
    },
  });
  assert.equal(await missingWorker.processOne(), true);
  const missingResult = JobResponseSchema.parse(
    (
      await json(`/v1/jobs/${missing.id}`, {
        headers: bearer(device.token),
      })
    ).body,
  ).job;
  assert.equal(missingResult.status, "failed");
  if (missingResult.status !== "failed") assert.fail("job must fail");
  assert.equal(missingResult.error.code, "SOURCE_HTTP_ERROR");
  assert.equal(missingResult.error.retryable, false);
});

test("同租户并发完成按提交顺序产生 changes 游标", async () => {
  const device = await pair("pair-change-order", "change order desktop");
  const follow = async (key: string, url: string) =>
    SourceFollowJobResponseSchema.parse(
      (
        await json("/v1/follows", {
          method: "POST",
          headers: bearer(device.token, {
            "Content-Type": "application/json",
            "Idempotency-Key": key,
          }),
          body: JSON.stringify({ source: { kind: "public-url", url } }),
        })
      ).body,
    );
  const slowSource = await follow(
    "change-order-slow",
    "https://example.com/change-order-slow",
  );
  const fastSource = await follow(
    "change-order-fast",
    "https://example.com/change-order-fast",
  );
  const claimed = [await database.claimJob(), await database.claimJob()];
  const slowJob = claimed.find(
    (job) => job?.sourceId === slowSource.follow.sourceId,
  );
  const fastJob = claimed.find(
    (job) => job?.sourceId === fastSource.follow.sourceId,
  );
  assert.ok(slowJob && fastJob);

  await database.pool.query(`
    DROP TRIGGER IF EXISTS integration_change_gate_trigger ON delivery_change;
    DROP FUNCTION IF EXISTS integration_wait_before_change();
    DROP TABLE IF EXISTS integration_change_gate;
    CREATE TABLE integration_change_gate(source_id uuid PRIMARY KEY);
    CREATE FUNCTION integration_wait_before_change() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM integration_change_gate WHERE source_id = NEW.source_id
      ) THEN
        PERFORM pg_advisory_xact_lock(81273, 11902);
      END IF;
      RETURN NEW;
    END
    $$;
    CREATE TRIGGER integration_change_gate_trigger
      BEFORE INSERT ON delivery_change
      FOR EACH ROW EXECUTE FUNCTION integration_wait_before_change();
  `);
  await database.pool.query(
    "INSERT INTO integration_change_gate(source_id) VALUES ($1)",
    [slowSource.follow.sourceId],
  );
  const gate = await database.pool.connect();
  await gate.query("SELECT pg_advisory_lock(81273, 11902)");
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await gate.query("SELECT pg_advisory_unlock(81273, 11902)");
    gate.release();
  };
  const item = (source: string) => {
    const content = `Full source body for ${source}.`;
    return {
      canonicalUrl: `https://example.com/${source}`,
      title: source,
      content,
      observedAt: new Date().toISOString(),
      contentHash: contentHash(content),
      coverage: "fulltext" as const,
      missing: ["media"],
    };
  };
  const slowCompletion = database.completeJob(slowJob, item("slow"));
  let fastCompletion: Promise<unknown> | undefined;
  try {
    let slowIsWaiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await database.pool.query<{ waiting: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_stat_activity
           WHERE pid <> pg_backend_pid()
             AND lower(coalesce(wait_event, '')) = 'advisory'
             AND query LIKE '%INSERT INTO delivery_change%'
         ) AS waiting`,
      );
      if (state.rows[0]!.waiting) {
        slowIsWaiting = true;
        break;
      }
      await delay(20);
    }
    assert.equal(slowIsWaiting, true);

    fastCompletion = database.completeJob(fastJob, item("fast"));
    const stateBeforeRelease = await Promise.race([
      fastCompletion.then(
        () => "completed",
        () => "completed",
      ),
      delay(150).then(() => "waiting"),
    ]);
    assert.equal(stateBeforeRelease, "waiting");
    await release();
    await Promise.all([slowCompletion, fastCompletion]);
    const ordered = await database.pool.query<{ source_id: string }>(
      `SELECT source_id FROM delivery_change
       WHERE tenant_id = $1 ORDER BY sequence`,
      [device.tenantId],
    );
    assert.deepEqual(
      ordered.rows.map(({ source_id }) => source_id),
      [slowSource.follow.sourceId, fastSource.follow.sourceId],
    );
  } finally {
    await release();
    await Promise.allSettled(
      [slowCompletion, fastCompletion].filter(
        (promise): promise is Promise<unknown> => Boolean(promise),
      ),
    );
    await database.pool.query(`
      DROP TRIGGER IF EXISTS integration_change_gate_trigger ON delivery_change;
      DROP FUNCTION IF EXISTS integration_wait_before_change();
      DROP TABLE IF EXISTS integration_change_gate;
    `);
  }
});

test("自部署默认策略可由未来租户权益策略替换", async () => {
  await api.close();
  api = await createSourceApi(database, config, {
    policy: {
      allows: ({ action }) => action !== "source.create",
    },
  });
  await new Promise<void>((resolve, reject) => {
    api.server.once("error", reject);
    api.server.listen(0, "127.0.0.1", resolve);
  });
  const address = api.server.address() as AddressInfo;
  baseURL = `http://127.0.0.1:${address.port}`;
  const device = await pair();

  const denied = await json("/v1/sources/url", {
    method: "PUT",
    headers: bearer(device.token, {
      "Content-Type": "application/json",
      "Idempotency-Key": "policy-denied-source",
    }),
    body: JSON.stringify({ url: "https://example.com/denied" }),
  });
  assert.equal(denied.response.status, 403);
  assert.equal(ErrorResponseSchema.parse(denied.body).error.code, "FORBIDDEN");
});

test("feed batches commit stable independent revisions, deduplicate refreshes and accept empty observations", async () => {
  const device = await pair();
  const followed = SourceFollowJobResponseSchema.parse(
    (
      await json("/v1/follows", {
        method: "POST",
        headers: bearer(device.token, {
          "Content-Type": "application/json",
          "Idempotency-Key": "feed-follow",
        }),
        body: JSON.stringify({
          source: { kind: "public-url", url: "https://example.com/feed" },
          name: "Feed source",
          category: "Research",
        }),
      })
    ).body,
  );
  const article = (id: string, content: string) => ({
    externalItemKey: `feed:${id}`,
    canonicalUrl: `https://example.com/${id}`,
    title: `Article ${id}`,
    content,
    contentHash: contentHash(content),
    observedAt: new Date().toISOString(),
    coverage: "fulltext" as const,
    missing: [],
  });
  const first = await database.claimJob(45);
  assert.ok(first);
  const original = [
    article("a", "Article A body"),
    article("b", "Article B body"),
  ];
  const result = await database.completeItems(first, original);
  assert.equal(result.itemCount, 2);
  assert.equal(
    (await database.changes(device.tenantId, 0n, 100)).rows.length,
    2,
  );
  const run = async (items: typeof original) => {
    await json(`/v1/follows/${followed.follow.id}/refresh`, {
      method: "POST",
      headers: bearer(device.token, {
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
      }),
      body: "{}",
    });
    const job = await database.claimJob(45);
    assert.ok(job);
    return database.completeItems(job, items);
  };
  await run(original.toReversed());
  assert.equal(
    (await database.changes(device.tenantId, 0n, 100)).rows.length,
    2,
    "reordering cannot create duplicates",
  );
  await run([article("a", "Article A revised"), article("c", "Article C new")]);
  const changes = await database.changes(device.tenantId, 0n, 100);
  assert.equal(changes.rows.length, 4);
  assert.equal(
    changes.rows.filter((row) => row.change_type === "item.revised").length,
    1,
  );
  const empty = await run([]);
  const response = JobResponseSchema.parse(
    (await json(`/v1/jobs/${empty.id}`, { headers: bearer(device.token) }))
      .body,
  );
  assert.equal(response.job.status, "succeeded");
  if (response.job.status === "succeeded")
    assert.equal(response.job.itemCount, 0);
  assert.equal(
    (await database.changes(device.tenantId, 0n, 100)).rows.length,
    4,
    "missing entries are not deleted",
  );
});

test("server reading summarizes only supplied source revisions and reuses unchanged results", async () => {
  const { ReadingWorker } = await import("../../src/reading.js");
  const { ReadingResponseSchema } = await import("@ytriple/source-contract");
  const device = await pair();
  await json("/v1/follows", {
    method: "POST",
    headers: bearer(device.token, {
      "Content-Type": "application/json",
      "Idempotency-Key": "reading-follow",
    }),
    body: JSON.stringify({
      source: { kind: "public-url", url: "https://example.com/research" },
      category: "Research",
    }),
  });
  const job = await database.claimJob(45);
  assert.ok(job);
  const content =
    "A real stored revision, represented here by deterministic test content.";
  await database.completeItems(job, [
    {
      externalItemKey: "feed:reading",
      canonicalUrl: "https://example.com/article",
      title: "Stored research",
      content,
      contentHash: contentHash(content),
      observedAt: new Date().toISOString(),
      coverage: "metadata",
      missing: ["fulltext"],
    },
  ]);
  let calls = 0;
  const worker = new ReadingWorker(
    database,
    async (input) => {
      calls++;
      assert.equal(input.items[0]!.coverage, "metadata");
      assert.equal(input.items[0]!.excerpt, content);
      return {
        title: "研究线索",
        summary: "只能据已取得的摘要形成初步判断。",
        points: [
          {
            title: "需要核查的线索",
            detail: "应回原文进一步验证。",
            sourceIds: [input.items[0]!.itemId],
          },
        ],
        caveats: ["尚未取得全文"],
      };
    },
    "deterministic-test-model",
  );
  await worker.refresh();
  await worker.refresh();
  assert.equal(calls, 1);
  const response = await json("/v1/reading", { headers: bearer(device.token) });
  const reading = ReadingResponseSchema.parse(response.body);
  assert.equal(reading.topics.length, 1);
  assert.equal(reading.topics[0]!.evidence[0]!.coverage, "metadata");
  assert.equal((await json("/v1/reading")).response.status, 401);
  const invalid = new ReadingWorker(
    database,
    async () => ({
      title: "Invalid",
      summary: "Invalid result",
      points: [
        {
          title: "Bad claim",
          detail: "Cites an unprovided source.",
          sourceIds: ["outside"],
        },
      ],
      caveats: [],
    }),
    "different-model",
  );
  await invalid.refresh();
  const after = ReadingResponseSchema.parse(
    (await json("/v1/reading", { headers: bearer(device.token) })).body,
  );
  assert.equal(
    after.topics[0]!.id,
    reading.topics[0]!.id,
    "a failed replacement preserves prior evidence",
  );
});
