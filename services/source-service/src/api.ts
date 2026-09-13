import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  CapabilitiesResponseSchema,
  ChangeSchema,
  CHANGE_STREAM_EVENT_NAME,
  ChangeStreamEventSchema,
  ChangeStreamQuerySchema,
  ChangesQuerySchema,
  ChangesResponseSchema,
  CreateSourceFollowRequestSchema,
  DeleteSourceFollowResponseSchema,
  ErrorResponseSchema,
  HealthResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  IdempotencyKeySchema,
  JobResponseSchema,
  LAST_EVENT_ID_HEADER,
  PairRequestSchema,
  PairResponseSchema,
  PROTOCOL_VERSION,
  ReadinessResponseSchema,
  ReadingResponseSchema,
  EditorialResponseSchema,
  EditorialRevisionResponseSchema,
  EditorialCorrectionRequestSchema,
  EditorialCorrectionResponseSchema,
  RecommendedSourcesResponseSchema,
  RefreshSourceRequestSchema,
  RevisionResponseSchema,
  SOURCE_SCOPES,
  SourceFollowJobResponseSchema,
  SourceFollowResponseSchema,
  SourceFollowsResponseSchema,
  UpdateSourceFollowRequestSchema,
  UpsertURLSourceRequestSchema,
  UpsertURLSourceResponseSchema,
  UuidSchema,
  type SourceApiErrorCode,
  type SourceApiScope,
} from "@ytriple/source-contract";
import type { SourceServiceConfig } from "./config.js";
import { CursorCodec, CursorError } from "./cursor.js";
import {
  allowAllSourcePolicy,
  type SourcePolicy,
  type SourcePolicyAction,
} from "./policy.js";
import { secretsEqual, tokenForDevice } from "./security.js";
import { encodeSSEEvent, SSEWakeSignal, writeSSE } from "./sse.js";
import {
  IdempotencyConflictError,
  ConflictError,
  NotFoundError,
  PairingReplayExpiredError,
  SourceDatabase,
  requestDigest,
  type AuthenticatedDevice,
  type StoredJob,
} from "./store/database.js";

import {
  editorialFeed,
  editorialVersion,
  correctEditorial,
} from "./editorial-store.js";

const MAX_JSON_BYTES = 64 * 1024;
const STREAM_PAGE_SIZE = 100;
const DEFAULT_STREAM_HEARTBEAT_MS = 15_000;
const DEFAULT_STREAM_FALLBACK_POLL_MS = 30_000;
const DEFAULT_STREAM_BACKPRESSURE_TIMEOUT_MS = 30_000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: SourceApiErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

function serializeJob(job: StoredJob) {
  const common = {
    id: job.id,
    sourceId: job.sourceId,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
  if (job.status === "succeeded")
    return {
      ...common,
      status: "succeeded" as const,
      itemId: job.itemId,
      revisionId: job.revisionId,
      itemCount: job.itemCount,
    };
  if (job.status === "failed")
    return {
      ...common,
      status: "failed" as const,
      itemId: job.itemId,
      revisionId: job.revisionId,
      error: job.error || {
        code: "SOURCE_FETCH_FAILED" as const,
        message: "信息源刷新失败。",
        retryable: false,
      },
    };
  return {
    ...common,
    status: job.status,
    itemId: job.itemId,
    revisionId: job.revisionId,
    error: job.error,
  };
}

function serializeChange(row: Record<string, unknown>) {
  return ChangeSchema.parse({
    id: `change:${String(row.sequence)}`,
    kind: row.change_type,
    sourceId: String(row.source_id),
    followId: row.follow_id ? String(row.follow_id) : undefined,
    itemId: String(row.item_id),
    revisionId: String(row.revision_id),
    observedAt: new Date(row.observed_at as string | Date).toISOString(),
    contentHash: String(row.content_hash),
    coverage: row.coverage,
    missing: row.missing,
    occurredAt: new Date(row.created_at as string | Date).toISOString(),
  });
}

async function readJSON(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_JSON_BYTES)
      throw new HttpError(413, "INVALID_REQUEST", "请求正文超过 64 KiB。");
    chunks.push(bytes);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "INVALID_REQUEST", "请求正文不是有效 JSON。");
  }
}

function sendJSON(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": bytes.byteLength,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(bytes);
}

function idempotencyKey(request: IncomingMessage): string {
  const raw = request.headers[IDEMPOTENCY_KEY_HEADER.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = IdempotencyKeySchema.safeParse(value);
  if (!parsed.success)
    throw new HttpError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "写入请求必须提供有效的 Idempotency-Key。",
    );
  return parsed.data;
}

function canonicalRequestedURL(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.href;
}

function pathUUID(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "INVALID_REQUEST", "资源 ID 无效。");
  }
  const parsed = UuidSchema.safeParse(decoded);
  if (!parsed.success)
    throw new HttpError(400, "INVALID_REQUEST", "资源 ID 无效。");
  return parsed.data;
}

export type SourceApi = {
  server: ReturnType<typeof createServer>;
  close(): Promise<void>;
};

export type SourceApiOptions = {
  policy?: SourcePolicy;
  streamHeartbeatMs?: number;
  streamFallbackPollMs?: number;
  streamBackpressureTimeoutMs?: number;
};

function streamDuration(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const duration = value ?? fallback;
  if (!Number.isInteger(duration) || duration < 10 || duration > 300_000)
    throw new Error(`${name} 必须在 10 毫秒到 5 分钟之间。`);
  return duration;
}

export async function createSourceApi(
  database: SourceDatabase,
  config: SourceServiceConfig,
  options: SourceApiOptions = {},
): Promise<SourceApi> {
  if (config.recommendedSources !== undefined) {
    await database.configureRecommendedSources(
      config.recommendedSources.map((source) => ({
        ...source,
        enabledByDefault:
          config.recommendedDefaultsEnabled === true && source.enabledByDefault,
      })),
    );
    if (config.recommendedDefaultsEnabled === true)
      await database.ensureDefaultRecommendedFollowsForAllTenants();
  }
  const serverInstanceId = await database.serverInstanceId();
  const meta = { protocolVersion: PROTOCOL_VERSION, serverInstanceId } as const;
  const cursorCodec = new CursorCodec(config.cursorSecret, serverInstanceId);
  const policy = options.policy || allowAllSourcePolicy;
  const streamHeartbeatMs = streamDuration(
    options.streamHeartbeatMs,
    DEFAULT_STREAM_HEARTBEAT_MS,
    "SSE 心跳间隔",
  );
  const streamFallbackPollMs = streamDuration(
    options.streamFallbackPollMs,
    DEFAULT_STREAM_FALLBACK_POLL_MS,
    "SSE 兜底查询间隔",
  );
  const streamBackpressureTimeoutMs = streamDuration(
    options.streamBackpressureTimeoutMs,
    DEFAULT_STREAM_BACKPRESSURE_TIMEOUT_MS,
    "SSE 背压超时",
  );
  const activeStreams = new Set<AbortController>();
  const activeStreamResponses = new Set<ServerResponse>();
  let isClosing = false;
  let closing: Promise<void> | undefined;

  const authenticate = async (
    request: IncomingMessage,
    scope: SourceApiScope,
  ): Promise<AuthenticatedDevice> => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer "))
      throw new HttpError(401, "UNAUTHORIZED", "需要设备令牌。");
    const device = await database.authenticate(header.slice("Bearer ".length));
    if (!device)
      throw new HttpError(401, "UNAUTHORIZED", "设备令牌无效或已撤销。");
    if (!device.scopes.includes(scope))
      throw new HttpError(403, "FORBIDDEN", "设备没有执行此操作的权限。");
    return device;
  };

  const authorize = async (
    device: AuthenticatedDevice,
    action: SourcePolicyAction,
  ): Promise<void> => {
    if (!(await policy.allows({ ...device, action })))
      throw new HttpError(403, "FORBIDDEN", "当前服务策略不允许此操作。");
  };

  const streamCursor = (
    request: IncomingMessage,
    url: URL,
  ): string | undefined => {
    const rawHeader = request.headers[LAST_EVENT_ID_HEADER.toLowerCase()];
    if (Array.isArray(rawHeader))
      throw new HttpError(400, "INVALID_CURSOR", "SSE 恢复游标无效。");
    // EventSource reconnects to the original URL, so its newer Last-Event-ID
    // must take precedence over the URL's initial cursor.
    const parsed = ChangeStreamQuerySchema.safeParse({
      cursor: rawHeader || url.searchParams.get("cursor") || undefined,
    });
    if (!parsed.success)
      throw new HttpError(400, "INVALID_CURSOR", "SSE 恢复游标无效。");
    return parsed.data.cursor;
  };

  const streamChanges = async (
    request: IncomingMessage,
    response: ServerResponse,
    device: AuthenticatedDevice,
    initialCursor: string | undefined,
  ): Promise<void> => {
    let after = cursorCodec.decode(initialCursor, device.tenantId);
    const controller = new AbortController();
    const wake = new SSEWakeSignal();
    let unsubscribe = () => {};
    const disconnected = () => controller.abort();
    activeStreams.add(controller);
    activeStreamResponses.add(response);
    request.once("aborted", disconnected);
    response.once("close", disconnected);
    try {
      if (isClosing) {
        controller.abort();
        response.destroy();
        return;
      }
      unsubscribe = await database.subscribeToChanges(device.tenantId, () =>
        wake.notify(),
      );
      if (controller.signal.aborted || response.destroyed) return;
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      });
      await writeSSE(
        response,
        ": connected\n\n",
        controller.signal,
        streamBackpressureTimeoutMs,
      );
      let nextHeartbeat = Date.now() + streamHeartbeatMs;
      let nextFallbackPoll = Date.now() + streamFallbackPollMs;
      let shouldQuery = true;

      while (!controller.signal.aborted) {
        if (shouldQuery) {
          // Recheck the replaceable entitlement policy before each delivery
          // batch; notifications themselves never grant access.
          await authorize(device, "source.read");
          const page = await database.changes(
            device.tenantId,
            after,
            STREAM_PAGE_SIZE,
          );
          for (const row of page.rows) {
            if (controller.signal.aborted) break;
            const sequence = BigInt(String(row.sequence));
            const cursor = cursorCodec.encode(device.tenantId, sequence);
            const event = ChangeStreamEventSchema.parse({
              meta,
              cursor,
              change: serializeChange(row),
            });
            await writeSSE(
              response,
              encodeSSEEvent(CHANGE_STREAM_EVENT_NAME, cursor, event),
              controller.signal,
              streamBackpressureTimeoutMs,
            );
            after = sequence;
          }
          if (controller.signal.aborted) break;
          shouldQuery = page.hasMore;
          nextFallbackPoll = Date.now() + streamFallbackPollMs;
          if (shouldQuery) continue;
        }

        const now = Date.now();
        const waitFor = Math.max(
          0,
          Math.min(nextHeartbeat, nextFallbackPoll) - now,
        );
        const woke = await wake.wait(waitFor, controller.signal);
        if (woke === "aborted") break;
        const resumedAt = Date.now();
        if (resumedAt >= nextHeartbeat) {
          await writeSSE(
            response,
            ": heartbeat\n\n",
            controller.signal,
            streamBackpressureTimeoutMs,
          );
          nextHeartbeat = resumedAt + streamHeartbeatMs;
        }
        if (woke === "notified" || resumedAt >= nextFallbackPoll)
          shouldQuery = true;
      }
    } finally {
      unsubscribe();
      activeStreams.delete(controller);
      activeStreamResponses.delete(response);
      request.off("aborted", disconnected);
      response.off("close", disconnected);
      if (!response.destroyed && !response.writableEnded) response.end();
    }
  };

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const url = new URL(request.url || "/", "http://source-service.invalid");

    if (request.method === "GET" && url.pathname === "/healthz") {
      sendJSON(
        response,
        200,
        HealthResponseSchema.parse({ meta, status: "ok" }),
      );
      return;
    }
    if (request.method === "GET" && url.pathname === "/readyz") {
      const ready = await database.ready();
      sendJSON(
        response,
        ready ? 200 : 503,
        ReadinessResponseSchema.parse({
          meta,
          status: ready ? "ready" : "not_ready",
        }),
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/pairing/bootstrap") {
      if (!config.pairingEnabled)
        throw new HttpError(403, "FORBIDDEN", "设备配对已关闭。");
      const key = idempotencyKey(request);
      const parsed = PairRequestSchema.safeParse(await readJSON(request));
      if (!parsed.success)
        throw new HttpError(400, "INVALID_REQUEST", "设备配对参数无效。");
      if (!secretsEqual(parsed.data.bootstrapToken, config.bootstrapToken))
        throw new HttpError(401, "UNAUTHORIZED", "配对凭据无效。");
      const paired = await database.pairDevice({
        idempotencyKey: key,
        requestHash: requestDigest({
          operation: "pairing.bootstrap",
          deviceName: parsed.data.deviceName,
        }),
        deviceName: parsed.data.deviceName,
        tokenForDevice: (deviceId) =>
          tokenForDevice(config.tokenSecret, deviceId),
        scopes: [...SOURCE_SCOPES],
      });
      if (config.recommendedDefaultsEnabled === true)
        await database.ensureDefaultRecommendedFollows(paired.tenantId);
      sendJSON(response, 201, PairResponseSchema.parse({ ...paired, meta }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/capabilities") {
      const device = await authenticate(request, "sources:read");
      await authorize(device, "source.read");
      sendJSON(
        response,
        200,
        CapabilitiesResponseSchema.parse({
          meta,
          tenantId: device.tenantId,
          capabilities: {
            publicUrl: true,
            explicitRefresh: true,
            changes: true,
            itemRevisions: true,
            changeStream: true,
            sourceFollows: true,
            recommendedSources: true,
            rssAtom: true,
            readingTopics: true,
            editorial: true,
          },
          scopes: SOURCE_SCOPES,
        }),
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/editorial") {
      const device = await authenticate(request, "content:read");
      await authorize(device, "content.read");
      sendJSON(
        response,
        200,
        EditorialResponseSchema.parse({
          meta,
          ...(await editorialFeed(database, device.tenantId)),
        }),
      );
      return;
    }
    const editorialRevisionPath = url.pathname.match(
      /^\/v1\/editorial\/([^/]+)\/revisions\/([^/]+)$/,
    );
    if (request.method === "GET" && editorialRevisionPath) {
      const device = await authenticate(request, "content:read");
      await authorize(device, "content.read");
      const revision = await editorialVersion(
        database,
        device.tenantId,
        pathUUID(editorialRevisionPath[1]!),
        pathUUID(editorialRevisionPath[2]!),
      );
      sendJSON(
        response,
        200,
        EditorialRevisionResponseSchema.parse({ meta, revision }),
      );
      return;
    }
    const correctionPath = url.pathname.match(
      /^\/v1\/editorial\/([^/]+)\/corrections$/,
    );
    if (request.method === "POST" && correctionPath) {
      const device = await authenticate(request, "sources:write");
      await authorize(device, "content.correct");
      const key = idempotencyKey(request);
      const parsed = EditorialCorrectionRequestSchema.safeParse(
        await readJSON(request),
      );
      if (!parsed.success)
        throw new HttpError(
          400,
          "INVALID_REQUEST",
          "请填写针对当前解读的纠正（3–3000 字）。",
        );
      const correction = await correctEditorial(
        database,
        device.tenantId,
        pathUUID(correctionPath[1]!),
        parsed.data,
        key,
      );
      sendJSON(
        response,
        201,
        EditorialCorrectionResponseSchema.parse({ meta, correction }),
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/reading") {
      const device = await authenticate(request, "content:read");
      await authorize(device, "content.read");
      const result = await database.pool.query(
        "SELECT body FROM reading_topic WHERE tenant_id=$1 AND body IS NOT NULL ORDER BY category",
        [device.tenantId],
      );
      sendJSON(
        response,
        200,
        ReadingResponseSchema.parse({
          meta,
          topics: result.rows.map((row) => row.body),
        }),
      );
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname === "/v1/recommended-sources"
    ) {
      const device = await authenticate(request, "sources:read");
      await authorize(device, "source.read");
      sendJSON(
        response,
        200,
        RecommendedSourcesResponseSchema.parse({
          meta,
          sources: await database.recommendedSources(),
        }),
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/follows") {
      const device = await authenticate(request, "sources:read");
      await authorize(device, "source.read");
      sendJSON(
        response,
        200,
        SourceFollowsResponseSchema.parse({
          meta,
          follows: await database.sourceFollows(device.tenantId),
        }),
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/follows") {
      const device = await authenticate(request, "sources:write");
      await authorize(device, "source.create");
      const key = idempotencyKey(request);
      const parsed = CreateSourceFollowRequestSchema.safeParse(
        await readJSON(request),
      );
      if (!parsed.success)
        throw new HttpError(400, "INVALID_REQUEST", "来源关注参数无效。");
      const { source: requestedSource, ...followOptions } = parsed.data;
      const target =
        requestedSource.kind === "public-url"
          ? {
              kind: "public-url" as const,
              url: canonicalRequestedURL(requestedSource.url),
            }
          : requestedSource;
      const input = { ...followOptions, target };
      const result = await database.createSourceFollow(
        device.tenantId,
        input,
        key,
        requestDigest({ operation: "source.follow.create", ...input }),
        (follow, job) =>
          SourceFollowJobResponseSchema.parse({
            meta,
            follow,
            job: serializeJob(job),
          }),
      );
      sendJSON(response, result.status, result.body);
      return;
    }

    const followPath = url.pathname.match(/^\/v1\/follows\/([^/]+)$/);
    if (request.method === "PATCH" && followPath) {
      const device = await authenticate(request, "sources:write");
      await authorize(device, "source.create");
      const key = idempotencyKey(request);
      const followId = pathUUID(followPath[1]!);
      const parsed = UpdateSourceFollowRequestSchema.safeParse(
        await readJSON(request),
      );
      if (!parsed.success)
        throw new HttpError(400, "INVALID_REQUEST", "来源关注更新参数无效。");
      const result = await database.updateSourceFollow(
        device.tenantId,
        followId,
        parsed.data,
        key,
        requestDigest({
          operation: "source.follow.update",
          followId,
          input: parsed.data,
        }),
        (follow) => SourceFollowResponseSchema.parse({ meta, follow }),
      );
      sendJSON(response, result.status, result.body);
      return;
    }
    if (request.method === "DELETE" && followPath) {
      const device = await authenticate(request, "sources:write");
      await authorize(device, "source.create");
      const key = idempotencyKey(request);
      const followId = pathUUID(followPath[1]!);
      const result = await database.deleteSourceFollow(
        device.tenantId,
        followId,
        key,
        requestDigest({ operation: "source.follow.delete", followId }),
        () =>
          DeleteSourceFollowResponseSchema.parse({
            meta,
            followId,
            deleted: true,
          }),
      );
      sendJSON(response, result.status, result.body);
      return;
    }

    const followRefresh = url.pathname.match(
      /^\/v1\/follows\/([^/]+)\/refresh$/,
    );
    if (request.method === "POST" && followRefresh) {
      const device = await authenticate(request, "refreshes:write");
      await authorize(device, "source.refresh");
      const key = idempotencyKey(request);
      const followId = pathUUID(followRefresh[1]!);
      const parsed = RefreshSourceRequestSchema.safeParse(
        await readJSON(request),
      );
      if (!parsed.success)
        throw new HttpError(400, "INVALID_REQUEST", "来源刷新参数无效。");
      const result = await database.enqueueFollowRefresh(
        device.tenantId,
        followId,
        key,
        requestDigest({ operation: "source.follow.refresh", followId }),
        (follow, job) =>
          SourceFollowJobResponseSchema.parse({
            meta,
            follow,
            job: serializeJob(job),
          }),
      );
      sendJSON(response, result.status, result.body);
      return;
    }

    if (request.method === "PUT" && url.pathname === "/v1/sources/url") {
      const device = await authenticate(request, "sources:write");
      await authorize(device, "source.create");
      const key = idempotencyKey(request);
      const parsed = UpsertURLSourceRequestSchema.safeParse(
        await readJSON(request),
      );
      if (!parsed.success)
        throw new HttpError(400, "INVALID_REQUEST", "公开 URL 参数无效。");
      const normalizedURL = canonicalRequestedURL(parsed.data.url);
      const result = await database.upsertURLSource(
        device.tenantId,
        normalizedURL,
        key,
        requestDigest({ operation: "source.url.upsert", url: normalizedURL }),
        (source, job) =>
          UpsertURLSourceResponseSchema.parse({
            meta,
            source,
            job: serializeJob(job),
          }),
      );
      sendJSON(response, result.status, result.body);
      return;
    }

    const refresh = url.pathname.match(/^\/v1\/sources\/([^/]+)\/refreshes$/);
    if (request.method === "POST" && refresh) {
      const device = await authenticate(request, "refreshes:write");
      await authorize(device, "source.refresh");
      const key = idempotencyKey(request);
      const parsed = RefreshSourceRequestSchema.safeParse(
        await readJSON(request),
      );
      if (!parsed.success)
        throw new HttpError(400, "INVALID_REQUEST", "刷新参数无效。");
      const sourceId = pathUUID(refresh[1]!);
      const result = await database.enqueueRefresh(
        device.tenantId,
        sourceId,
        key,
        requestDigest({ operation: "source.refresh", sourceId }),
        (job) => JobResponseSchema.parse({ meta, job: serializeJob(job) }),
      );
      sendJSON(response, result.status, result.body);
      return;
    }

    const jobPath = url.pathname.match(/^\/v1\/jobs\/([^/]+)$/);
    if (request.method === "GET" && jobPath) {
      const device = await authenticate(request, "sources:read");
      await authorize(device, "source.read");
      const job = await database.job(device.tenantId, pathUUID(jobPath[1]!));
      if (!job) throw new NotFoundError();
      sendJSON(
        response,
        200,
        JobResponseSchema.parse({ meta, job: serializeJob(job) }),
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/changes/stream") {
      const device = await authenticate(request, "sources:read");
      await authorize(device, "source.read");
      await streamChanges(
        request,
        response,
        device,
        streamCursor(request, url),
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/changes") {
      const device = await authenticate(request, "sources:read");
      await authorize(device, "source.read");
      const parsed = ChangesQuerySchema.safeParse({
        cursor: url.searchParams.get("cursor") || undefined,
        limit: url.searchParams.get("limit") || undefined,
      });
      if (!parsed.success)
        throw new HttpError(400, "INVALID_REQUEST", "同步分页参数无效。");
      const after = cursorCodec.decode(parsed.data.cursor, device.tenantId);
      const page = await database.changes(
        device.tenantId,
        after,
        parsed.data.limit,
      );
      const last = page.rows.at(-1);
      const next = last ? BigInt(String(last.sequence)) : after;
      const body = ChangesResponseSchema.parse({
        meta,
        changes: page.rows.map(serializeChange),
        nextCursor: cursorCodec.encode(device.tenantId, next),
        hasMore: page.hasMore,
      });
      sendJSON(response, 200, body);
      return;
    }

    const revision = url.pathname.match(
      /^\/v1\/items\/([^/]+)\/revisions\/([^/]+)$/,
    );
    if (request.method === "GET" && revision) {
      const device = await authenticate(request, "content:read");
      await authorize(device, "content.read");
      const itemId = pathUUID(revision[1]!);
      const revisionId = pathUUID(revision[2]!);
      const row = await database.revision(device.tenantId, itemId, revisionId);
      if (!row) throw new NotFoundError();
      const body = RevisionResponseSchema.parse({
        meta,
        item: {
          id: String(row.item_id),
          sourceId: String(row.source_id),
          externalItemKey: String(row.external_item_key),
          canonicalUrl: String(row.canonical_url),
          title: String(row.title),
        },
        revision: {
          publishedAt: row.published_at
            ? new Date(row.published_at as string | Date).toISOString()
            : undefined,
          id: String(row.revision_id),
          itemId: String(row.item_id),
          observedAt: new Date(row.observed_at as string | Date).toISOString(),
          contentHash: String(row.content_hash),
          coverage: row.coverage,
          missing: row.missing,
          content: String(row.content),
        },
      });
      sendJSON(response, 200, body);
      return;
    }

    throw new HttpError(404, "NOT_FOUND", "请求的资源不存在。");
  };

  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      const mapped = mapError(error);
      const body = ErrorResponseSchema.parse({
        meta,
        error: {
          code: mapped.code,
          message: mapped.message,
          retryable: mapped.retryable,
        },
      });
      if (!response.headersSent) sendJSON(response, mapped.status, body);
      else response.destroy();
    });
  });

  return {
    server,
    close: () => {
      if (closing) return closing;
      isClosing = true;
      closing = new Promise<void>((resolve, reject) => {
        for (const controller of activeStreams) controller.abort();
        for (const response of activeStreamResponses) response.destroy();
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
      });
      return closing;
    },
  };
}

function mapError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof IdempotencyConflictError)
    return new HttpError(409, "IDEMPOTENCY_KEY_REUSED", error.message);
  if (error instanceof NotFoundError)
    return new HttpError(404, "NOT_FOUND", error.message);
  if (error instanceof ConflictError)
    return new HttpError(409, "CONFLICT", error.message);
  if (error instanceof PairingReplayExpiredError)
    return new HttpError(409, "CONFLICT", error.message);
  if (error instanceof CursorError)
    return new HttpError(400, "INVALID_CURSOR", error.message);
  return new HttpError(500, "INTERNAL_ERROR", "信息源服务内部错误。");
}
