import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  JobResponseSchema,
  PairResponseSchema,
  SourceFollowJobResponseSchema,
} from "@ytriple/source-contract";
import { WorkbenchService } from "../../src/core/service.js";
import { HttpSourceGateway } from "../../src/core/source-gateway.js";
import type { RemoteSourceIdentity } from "../../src/shared/types.js";
import {
  createSourceApi,
  type SourceApi,
} from "../../services/source-service/src/api.js";
import type { SourceServiceConfig } from "../../services/source-service/src/config.js";
import { SourceDatabase } from "../../services/source-service/src/store/database.js";
import { SourceWorker } from "../../services/source-service/src/worker.js";

const databaseURL = process.env.SOURCE_TEST_DATABASE_URL;

const config: SourceServiceConfig = {
  databaseURL: databaseURL ?? "postgresql://integration-test-not-running",
  host: "127.0.0.1",
  port: 47321,
  bootstrapToken: "workbench-integration-bootstrap",
  tokenSecret: "workbench-integration-device-token-secret",
  cursorSecret: "workbench-integration-cursor-secret-000",
  pairingEnabled: true,
  workerPollMs: 25,
};

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function responseJSON(url: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    redirect: "error",
    headers: { Accept: "application/json", ...init.headers },
  });
  return { response, body: await response.json() };
}

function bearer(token: string, extra: Record<string, string> = {}) {
  return { Authorization: `Bearer ${token}`, ...extra };
}

async function waitFor<T>(
  inspect: () => T | undefined,
  description: string,
): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = inspect();
    if (result !== undefined) return result;
    await delay(20);
  }
  throw new Error(`等待超时：${description}`);
}

async function closeWithin(service: WorkbenchService): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      service.close(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("WorkbenchService close 因信息源长连接挂起。")),
          2_000,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function radarWithRevisions(
  service: WorkbenchService,
  expected: number,
  sourceId: string,
  identity: RemoteSourceIdentity,
) {
  const item = service.store
    .radarItems(identity)
    .find((candidate) => candidate.sourceId === sourceId);
  return item?.revisionCount === expected ? item : undefined;
}

function recordingFetch(records: Array<{ url: string; cursor?: string }>) {
  const wrapped: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (url.pathname === "/v1/changes/stream") {
      const headers = new Headers(init?.headers);
      records.push({
        url: url.href,
        cursor:
          headers.get("Last-Event-ID") ??
          url.searchParams.get("cursor") ??
          undefined,
      });
    }
    return fetch(input, init);
  };
  return wrapped;
}

if (!databaseURL) throw new Error("SOURCE_TEST_DATABASE_URL 未设置。");

test("真实服务推送进入 Radar，离线修订在重开后补收且不重复", async () => {
  const localRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "ytriple-push-e2e-"),
  );
  const dataPath = path.join(localRoot, "data");
  const database = new SourceDatabase(databaseURL);
  let api: SourceApi | undefined;
  let desktop: WorkbenchService | undefined;

  try {
    await database.migrate();
    await database.pool.query("TRUNCATE tenant RESTART IDENTITY CASCADE");
    api = await createSourceApi(database, config, {
      streamHeartbeatMs: 50,
      streamFallbackPollMs: 60_000,
      streamBackpressureTimeoutMs: 1_000,
    });
    await new Promise<void>((resolve, reject) => {
      api!.server.once("error", reject);
      api!.server.listen(0, "127.0.0.1", resolve);
    });
    const address = api.server.address() as AddressInfo;
    const baseURL = `http://127.0.0.1:${address.port}`;

    const pairedRaw = await responseJSON(`${baseURL}/v1/pairing/bootstrap`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "workbench-push-device",
      },
      body: JSON.stringify({
        deviceName: "Workbench push E2E",
        bootstrapToken: config.bootstrapToken,
      }),
    });
    assert.equal(pairedRaw.response.status, 201);
    const paired = PairResponseSchema.parse(pairedRaw.body);
    const identity: RemoteSourceIdentity = {
      serverInstanceId: paired.meta.serverInstanceId,
      tenantId: paired.tenantId,
    };

    let content = "First server-pushed article revision for the workbench.";
    let title = "Server pushed article";
    const worker = new SourceWorker(database, {
      fetcher: async (url) => ({
        canonicalUrl: url,
        title,
        content,
        observedAt: new Date().toISOString(),
        contentHash: hash(content),
        coverage: "fulltext",
        missing: [],
      }),
    });

    const openDesktop = async (fetchImpl: typeof globalThis.fetch) => {
      const service = new WorkbenchService(
        dataPath,
        () => undefined,
        () => {},
        {
          sourceGateway: new HttpSourceGateway({
            baseURL,
            token: paired.token,
            tenantId: paired.tenantId,
            fetch: fetchImpl,
            timeoutMs: 5_000,
            streamReconnectMs: 10,
            streamMaxReconnectMs: 50,
          }),
        },
      );
      service.store.setConfig("settings", {
        ...service.store.settings(),
        aiRoot: path.join(localRoot, "AI"),
        codeRoot: path.join(localRoot, "Code"),
        workspaceRoot: path.join(localRoot, "workspaces"),
        projectMonitoring: false,
      });
      await service.initialize();
      return service;
    };

    const followRaw = await responseJSON(`${baseURL}/v1/follows`, {
      method: "POST",
      headers: bearer(paired.token, {
        "Content-Type": "application/json",
        "Idempotency-Key": "workbench-push-follow",
      }),
      body: JSON.stringify({
        source: {
          kind: "public-url",
          url: "https://example.com/pushed-article",
        },
        name: "Workbench 用户关注",
        category: "测试来源",
        refreshIntervalMinutes: 30,
      }),
    });
    assert.equal(followRaw.response.status, 202);
    const followed = SourceFollowJobResponseSchema.parse(followRaw.body);
    assert.equal(followed.follow.origin, "user");
    assert.equal(followed.job.status, "queued");

    desktop = await openDesktop(fetch);
    await waitFor(
      () =>
        desktop!.store
          .radarFollows(identity)
          .find((candidate) => candidate.id === followed.follow.id),
      "桌面同步真实关注记录",
    );
    assert.equal(await worker.processOne(), true);

    const firstRadarItem = await waitFor(
      () => radarWithRevisions(desktop!, 1, followed.follow.sourceId, identity),
      "首个服务端修订进入 Radar",
    );
    assert.equal(firstRadarItem.content, content);
    assert.equal(firstRadarItem.sourceId, followed.follow.sourceId);
    assert.equal(firstRadarItem.origin, "user");
    assert.equal(firstRadarItem.category, "测试来源");
    assert.equal(desktop.store.tasks().length, 0);
    const firstRevisionId = firstRadarItem.latestRevisionId;
    assert.ok(firstRevisionId);
    const firstCursor = desktop.store.remoteSourceCursor(identity);
    assert.ok(firstCursor);

    await closeWithin(desktop);
    desktop = undefined;

    content = `${content} This revision was committed while the desktop was closed.`;
    title = "Server pushed article, revised offline";
    const refreshRaw = await responseJSON(
      `${baseURL}/v1/follows/${followed.follow.id}/refresh`,
      {
        method: "POST",
        headers: bearer(paired.token, {
          "Content-Type": "application/json",
          "Idempotency-Key": "workbench-push-offline-refresh",
        }),
        body: "{}",
      },
    );
    assert.equal(refreshRaw.response.status, 202);
    const refresh = SourceFollowJobResponseSchema.parse(refreshRaw.body).job;
    assert.equal(refresh.status, "queued");
    assert.equal(await worker.processOne(), true);
    const refreshedRaw = await responseJSON(
      `${baseURL}/v1/jobs/${refresh.id}`,
      {
        headers: bearer(paired.token),
      },
    );
    assert.equal(refreshedRaw.response.status, 200);
    const refreshed = JobResponseSchema.parse(refreshedRaw.body).job;
    assert.equal(refreshed.status, "succeeded");

    const resumeRequests: Array<{ url: string; cursor?: string }> = [];
    desktop = await openDesktop(recordingFetch(resumeRequests));
    const resumedRequest = await waitFor(
      () => resumeRequests.find((request) => request.cursor === firstCursor),
      "重开时携带持久游标",
    );
    assert.equal(new URL(resumedRequest.url).pathname, "/v1/changes/stream");

    const resumedRadarItem = await waitFor(
      () => radarWithRevisions(desktop!, 2, followed.follow.sourceId, identity),
      "重开后补收离线修订",
    );
    assert.notEqual(resumedRadarItem.latestRevisionId, firstRevisionId);
    assert.equal(resumedRadarItem.latestRevisionId, refreshed.revisionId);
    assert.equal(resumedRadarItem.content, content);
    const secondCursor = desktop.store.remoteSourceCursor(identity);
    assert.ok(secondCursor);
    assert.notEqual(secondCursor, firstCursor);

    await closeWithin(desktop);
    desktop = undefined;

    const replayRequests: Array<{ url: string; cursor?: string }> = [];
    desktop = await openDesktop(recordingFetch(replayRequests));
    await waitFor(
      () => replayRequests.find((request) => request.cursor === secondCursor),
      "再次重开时沿用最新游标",
    );
    await delay(150);
    const replayedRadarItem = radarWithRevisions(
      desktop,
      2,
      followed.follow.sourceId,
      identity,
    );
    assert.ok(replayedRadarItem);
    assert.equal(replayedRadarItem.latestRevisionId, refreshed.revisionId);

    await closeWithin(desktop);
    desktop = undefined;
  } finally {
    if (desktop) await desktop.close().catch(() => undefined);
    if (api) await api.close().catch(() => undefined);
    await database.close().catch(() => undefined);
    await fs.rm(localRoot, { recursive: true, force: true });
  }
});
