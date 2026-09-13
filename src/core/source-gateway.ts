import { createHash, randomUUID } from "node:crypto";
import {
  CapabilitiesResponseSchema,
  ChangeStreamEventSchema,
  CreateSourceFollowRequestSchema,
  DeleteSourceFollowResponseSchema,
  ErrorResponseSchema,
  JobResponseSchema,
  MAX_ITEM_CONTENT_BYTES,
  RecommendedSourcesResponseSchema,
  ReadingResponseSchema,
  EditorialResponseSchema,
  EditorialRevisionResponseSchema,
  EditorialCorrectionResponseSchema,
  type EditorialResponse,
  type EditorialRevision,
  type EditorialCorrection,
  type EditorialCorrectionRequest,
  type ReadingTopic,
  RevisionResponseSchema,
  SourceFollowJobResponseSchema,
  SourceFollowResponseSchema,
  SourceFollowsResponseSchema,
  UpdateSourceFollowRequestSchema,
  UrlSourceUpsertRequestSchema,
  UrlSourceUpsertResponseSchema,
  type Change,
  type Job,
  type RecommendedSource,
  type RevisionResponse,
  type SourceFollow as ApiSourceFollow,
} from "@ytriple/source-contract";
import type {
  RadarFollow,
  RadarFollowState,
  RadarRecommendedSource,
  RemoteSourceDeliveryPage,
  RemoteSourceIdentity,
  Source,
} from "../shared/types.js";

export interface SourceReceiveSink {
  cursorFor(identity: RemoteSourceIdentity): string | undefined;
  commit(page: RemoteSourceDeliveryPage): Promise<void>;
  reportStatus?(
    state: "connecting" | "online" | "offline",
    identity?: RemoteSourceIdentity,
  ): void;
  reportError?(message: string): void;
}

export interface RadarCatalog extends RemoteSourceIdentity {
  follows: RadarFollow[];
  recommendedSources: RadarRecommendedSource[];
  readingTopics?: ReadingTopic[];
  editorial?: Omit<EditorialResponse, "meta">;
}

export type CreateRadarFollowInput =
  | {
      url: string;
      name?: string;
      refreshIntervalMinutes?: number;
    }
  | {
      recommendedSourceId: string;
      name?: string;
      refreshIntervalMinutes?: number;
    };

export interface SourceGateway {
  addURL(url: string): Promise<Source>;
  radarCatalog?(): Promise<RadarCatalog>;
  editorialRevision?(
    issueId: string,
    revisionId: string,
  ): Promise<RemoteSourceIdentity & { revision: EditorialRevision }>;
  correctEditorial?(
    issueId: string,
    input: EditorialCorrectionRequest,
    requestId: string,
  ): Promise<RemoteSourceIdentity & { correction: EditorialCorrection }>;
  follow?(input: CreateRadarFollowInput): Promise<RadarFollow>;
  setFollowState?(
    followId: string,
    state: RadarFollowState,
  ): Promise<RadarFollow>;
  refreshFollow?(followId: string): Promise<RadarFollow>;
  unfollow?(followId: string): Promise<void>;
  startReceiving?(sink: SourceReceiveSink): void;
  close?(): Promise<void> | void;
}

export interface HttpSourceGatewayOptions {
  baseURL: string;
  token: string;
  tenantId?: string;
  fetch?: typeof globalThis.fetch;
  pollIntervalMs?: number;
  timeoutMs?: number;
  streamReconnectMs?: number;
  streamMaxReconnectMs?: number;
}

type Parser<T> = { parse(value: unknown): T };
const MAX_SERVICE_RESPONSE_BYTES = MAX_ITEM_CONTENT_BYTES * 6 + 256 * 1024;
const MAX_SSE_EVENT_BYTES = 512 * 1024;

class SourceResponseReadError extends Error {}

function isDevelopmentHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}

export class HttpSourceGateway implements SourceGateway {
  private readonly baseURL: string;
  private readonly token: string;
  private readonly tenantId?: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly streamReconnectMs: number;
  private readonly streamMaxReconnectMs: number;
  private readonly active = new Set<AbortController>();
  private streamController?: AbortController;
  private stream?: Promise<void>;
  private closed = false;
  private supportsReadingTopics = false;
  private supportsEditorial = false;

  constructor(options: HttpSourceGatewayOptions) {
    let base: URL;
    try {
      base = new URL(options.baseURL);
    } catch {
      throw new Error("信息源服务地址无效。");
    }
    if (
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      (base.protocol !== "https:" &&
        !(base.protocol === "http:" && isDevelopmentHost(base.hostname)))
    )
      throw new Error(
        "信息源服务必须使用 HTTPS；本机开发可使用 localhost HTTP。",
      );
    const token = options.token.trim();
    if (!token) throw new Error("信息源服务设备令牌为空。");
    this.baseURL = base.href.replace(/\/+$/, "");
    this.token = token;
    this.tenantId = options.tenantId?.trim() || undefined;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.pollIntervalMs = Math.max(0, options.pollIntervalMs ?? 250);
    const timeoutMs = options.timeoutMs ?? 300_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 900_000)
      throw new Error("信息源服务超时配置必须在 1 秒到 15 分钟之间。");
    this.timeoutMs = Math.floor(timeoutMs);
    const streamReconnectMs = options.streamReconnectMs ?? 1_000;
    const streamMaxReconnectMs = options.streamMaxReconnectMs ?? 30_000;
    if (
      !Number.isFinite(streamReconnectMs) ||
      streamReconnectMs < 0 ||
      streamReconnectMs > 60_000 ||
      !Number.isFinite(streamMaxReconnectMs) ||
      streamMaxReconnectMs < streamReconnectMs ||
      streamMaxReconnectMs > 300_000
    )
      throw new Error("信息源服务重连间隔配置无效。");
    this.streamReconnectMs = Math.floor(streamReconnectMs);
    this.streamMaxReconnectMs = Math.floor(streamMaxReconnectMs);
  }

  async addURL(url: string): Promise<Source> {
    if (this.closed) throw new Error("信息源服务连接已关闭。");
    const controller = new AbortController();
    this.active.add(controller);
    const timer = setTimeout(
      () => controller.abort(new DOMException("请求超时", "TimeoutError")),
      this.timeoutMs,
    );
    timer.unref?.();
    try {
      const request = UrlSourceUpsertRequestSchema.parse({ url });
      const capabilities = await this.request(
        "/v1/capabilities",
        { method: "GET" },
        CapabilitiesResponseSchema,
        controller.signal,
      );
      if (!capabilities.capabilities.publicUrl)
        throw new Error("信息源服务不支持公开 URL 读取。");
      if (this.tenantId && this.tenantId !== capabilities.tenantId)
        throw new Error("信息源服务的租户身份与本机配置不一致。");
      const upsert = await this.request(
        "/v1/sources/url",
        {
          method: "PUT",
          headers: { "Idempotency-Key": randomUUID() },
          body: JSON.stringify(request),
        },
        UrlSourceUpsertResponseSchema,
        controller.signal,
      );
      const serverInstanceId = upsert.meta.serverInstanceId;
      if (serverInstanceId !== capabilities.meta.serverInstanceId)
        throw new Error("信息源服务实例在请求期间发生变化，请重试。");
      let job = upsert.job;
      const jobId = job.id;
      while (job.status === "queued" || job.status === "running") {
        await this.pause(controller.signal);
        const response = await this.request(
          `/v1/jobs/${encodeURIComponent(job.id)}`,
          { method: "GET" },
          JobResponseSchema,
          controller.signal,
        );
        if (response.meta.serverInstanceId !== serverInstanceId)
          throw new Error("信息源服务实例在请求期间发生变化，请重试。");
        if (
          response.job.id !== jobId ||
          response.job.sourceId !== upsert.source.id
        )
          throw new Error("信息源服务返回了不一致的来源任务。");
        job = response.job;
      }
      if (job.status === "failed")
        throw new Error(`信息源服务未能读取网页：${job.error.message}`);
      if (job.sourceId !== upsert.source.id)
        throw new Error("信息源服务返回了不一致的来源任务。");
      if (!job.itemId || !job.revisionId)
        throw new Error("来源暂时没有可读取的条目。");
      const response = await this.request(
        `/v1/items/${encodeURIComponent(job.itemId)}/revisions/${encodeURIComponent(job.revisionId)}`,
        { method: "GET" },
        RevisionResponseSchema,
        controller.signal,
      );
      if (response.meta.serverInstanceId !== serverInstanceId)
        throw new Error("信息源服务实例在请求期间发生变化，请重试。");
      if (
        response.item.id !== job.itemId ||
        response.item.sourceId !== upsert.source.id ||
        response.revision.id !== job.revisionId ||
        response.revision.itemId !== response.item.id
      )
        throw new Error("信息源服务返回了不一致的条目修订。");
      return this.sourceFromRevision(
        response,
        {
          serverInstanceId,
          tenantId: capabilities.tenantId,
        },
        new Date().toISOString(),
      );
    } catch (error) {
      if (controller.signal.aborted)
        throw new Error(
          controller.signal.reason instanceof DOMException &&
            controller.signal.reason.name === "AbortError"
            ? "信息源服务请求已停止。"
            : "信息源服务请求超时。",
        );
      throw new Error(this.safeMessage(error));
    } finally {
      clearTimeout(timer);
      this.active.delete(controller);
    }
  }

  async radarCatalog(): Promise<RadarCatalog> {
    return this.runOperation((signal) => this.radarCatalogWithin(signal));
  }

  async follow(input: CreateRadarFollowInput): Promise<RadarFollow> {
    return this.runOperation(async (signal) => {
      const identity = await this.radarIdentity(signal);
      const body = CreateSourceFollowRequestSchema.parse({
        source:
          "url" in input
            ? { kind: "public-url", url: input.url }
            : {
                kind: "recommended",
                recommendedSourceId: input.recommendedSourceId,
              },
        name: input.name,
        refreshIntervalMinutes: input.refreshIntervalMinutes,
      });
      const response = await this.request(
        "/v1/follows",
        {
          method: "POST",
          headers: { "Idempotency-Key": randomUUID() },
          body: JSON.stringify(body),
        },
        SourceFollowJobResponseSchema,
        signal,
      );
      this.assertInstance(response.meta.serverInstanceId, identity);
      await this.waitForJob(response.job, identity, signal);
      return this.fetchFollow(response.follow.id, identity, signal);
    });
  }

  async setFollowState(
    followId: string,
    state: RadarFollowState,
  ): Promise<RadarFollow> {
    return this.runOperation(async (signal) => {
      const identity = await this.radarIdentity(signal);
      const body = UpdateSourceFollowRequestSchema.parse({ state });
      const response = await this.request(
        `/v1/follows/${encodeURIComponent(followId)}`,
        {
          method: "PATCH",
          headers: { "Idempotency-Key": randomUUID() },
          body: JSON.stringify(body),
        },
        SourceFollowResponseSchema,
        signal,
      );
      this.assertInstance(response.meta.serverInstanceId, identity);
      if (response.follow.id !== followId)
        throw new Error("信息源服务返回了不一致的关注记录。");
      return this.mapFollow(response.follow);
    });
  }

  async refreshFollow(followId: string): Promise<RadarFollow> {
    return this.runOperation(async (signal) => {
      const identity = await this.radarIdentity(signal);
      const response = await this.request(
        `/v1/follows/${encodeURIComponent(followId)}/refresh`,
        {
          method: "POST",
          headers: { "Idempotency-Key": randomUUID() },
          body: JSON.stringify({}),
        },
        SourceFollowJobResponseSchema,
        signal,
      );
      this.assertInstance(response.meta.serverInstanceId, identity);
      if (response.follow.id !== followId)
        throw new Error("信息源服务返回了不一致的关注记录。");
      await this.waitForJob(response.job, identity, signal);
      return this.fetchFollow(followId, identity, signal);
    });
  }

  async unfollow(followId: string): Promise<void> {
    await this.runOperation(async (signal) => {
      const identity = await this.radarIdentity(signal);
      const response = await this.request(
        `/v1/follows/${encodeURIComponent(followId)}`,
        {
          method: "DELETE",
          headers: { "Idempotency-Key": randomUUID() },
        },
        DeleteSourceFollowResponseSchema,
        signal,
      );
      this.assertInstance(response.meta.serverInstanceId, identity);
      if (response.followId !== followId)
        throw new Error("信息源服务返回了不一致的取消关注结果。");
    });
  }

  async editorialRevision(issueId: string, revisionId: string) {
    return this.runOperation(async (signal) => {
      const identity = await this.radarIdentity(signal);
      if (!this.supportsEditorial)
        throw new Error("信息源服务尚未提供分析栏目。");
      const response = await this.request(
        `/v1/editorial/${encodeURIComponent(issueId)}/revisions/${encodeURIComponent(revisionId)}`,
        { method: "GET" },
        EditorialRevisionResponseSchema,
        signal,
      );
      this.assertInstance(response.meta.serverInstanceId, identity);
      if (
        response.revision.issueId !== issueId ||
        response.revision.id !== revisionId
      )
        throw new Error("服务返回的解读版本不一致。");
      return { ...identity, revision: response.revision };
    });
  }
  async correctEditorial(
    issueId: string,
    input: EditorialCorrectionRequest,
    requestId: string,
  ) {
    return this.runOperation(async (signal) => {
      const identity = await this.radarIdentity(signal);
      if (!this.supportsEditorial)
        throw new Error("信息源服务尚未提供解读纠正。");
      const response = await this.request(
        `/v1/editorial/${encodeURIComponent(issueId)}/corrections`,
        {
          method: "POST",
          headers: { "Idempotency-Key": requestId },
          body: JSON.stringify(input),
        },
        EditorialCorrectionResponseSchema,
        signal,
      );
      this.assertInstance(response.meta.serverInstanceId, identity);
      if (
        response.correction.issueId !== issueId ||
        response.correction.revisionId !== input.revisionId ||
        response.correction.text !== input.text
      )
        throw new Error("服务返回的纠正记录不一致。");
      return { ...identity, correction: response.correction };
    });
  }

  private async radarCatalogWithin(signal: AbortSignal): Promise<RadarCatalog> {
    const identity = await this.radarIdentity(signal);
    const [follows, recommended, reading, editorial] = await Promise.all([
      this.request(
        "/v1/follows",
        { method: "GET" },
        SourceFollowsResponseSchema,
        signal,
      ),
      this.request(
        "/v1/recommended-sources",
        { method: "GET" },
        RecommendedSourcesResponseSchema,
        signal,
      ),
      this.supportsReadingTopics && !this.supportsEditorial
        ? this.request(
            "/v1/reading",
            { method: "GET" },
            ReadingResponseSchema,
            signal,
          )
        : undefined,
      this.supportsEditorial
        ? this.request(
            "/v1/editorial",
            { method: "GET" },
            EditorialResponseSchema,
            signal,
          )
        : undefined,
    ]);
    this.assertInstance(follows.meta.serverInstanceId, identity);
    this.assertInstance(recommended.meta.serverInstanceId, identity);
    if (reading) this.assertInstance(reading.meta.serverInstanceId, identity);
    if (editorial)
      this.assertInstance(editorial.meta.serverInstanceId, identity);
    return {
      ...identity,
      follows: follows.follows.map((follow) => this.mapFollow(follow)),
      recommendedSources: recommended.sources.map((source) =>
        this.mapRecommendedSource(source),
      ),
      readingTopics: reading?.topics,
      editorial: editorial
        ? {
            issues: editorial.issues,
            status: editorial.status,
            edition: editorial.edition,
          }
        : undefined,
    };
  }

  private async radarIdentity(
    signal: AbortSignal,
  ): Promise<RemoteSourceIdentity> {
    const capabilities = await this.request(
      "/v1/capabilities",
      { method: "GET" },
      CapabilitiesResponseSchema,
      signal,
    );
    if (
      capabilities.capabilities.sourceFollows !== true ||
      capabilities.capabilities.recommendedSources !== true
    )
      throw new Error("信息源服务尚不支持 Radar 来源关注。");
    if (this.tenantId && this.tenantId !== capabilities.tenantId)
      throw new Error("信息源服务的租户身份与本机配置不一致。");
    this.supportsEditorial = capabilities.capabilities.editorial === true;
    this.supportsReadingTopics =
      capabilities.capabilities.readingTopics === true;
    return {
      serverInstanceId: capabilities.meta.serverInstanceId,
      tenantId: capabilities.tenantId,
    };
  }

  private async fetchFollow(
    followId: string,
    identity: RemoteSourceIdentity,
    signal: AbortSignal,
  ): Promise<RadarFollow> {
    const response = await this.request(
      "/v1/follows",
      { method: "GET" },
      SourceFollowsResponseSchema,
      signal,
    );
    this.assertInstance(response.meta.serverInstanceId, identity);
    const follow = response.follows.find(
      (candidate) => candidate.id === followId,
    );
    if (!follow) throw new Error("信息源关注记录在刷新后不存在。");
    return this.mapFollow(follow);
  }

  private async waitForJob(
    initial: Job,
    identity: RemoteSourceIdentity,
    signal: AbortSignal,
  ): Promise<void> {
    let job = initial;
    while (job.status === "queued" || job.status === "running") {
      await this.pause(signal);
      const response = await this.request(
        `/v1/jobs/${encodeURIComponent(job.id)}`,
        { method: "GET" },
        JobResponseSchema,
        signal,
      );
      this.assertInstance(response.meta.serverInstanceId, identity);
      if (response.job.id !== job.id)
        throw new Error("信息源服务返回了不一致的刷新任务。");
      job = response.job;
    }
    if (job.status === "failed")
      throw new Error(`信息源刷新失败：${job.error.message}`);
  }

  private mapFollow(follow: ApiSourceFollow): RadarFollow {
    return {
      id: follow.id,
      sourceId: follow.sourceId,
      origin: follow.origin,
      recommendedSourceId: follow.recommendedSourceId,
      name: follow.name,
      category: follow.category,
      url: follow.url,
      state: follow.state,
      refreshIntervalMinutes: follow.refreshIntervalMinutes,
      createdAt: follow.createdAt,
      updatedAt: follow.updatedAt,
      nextRefreshAt: follow.nextRefreshAt,
      lastAttemptAt: follow.lastAttemptAt,
      lastSuccessAt: follow.lastSuccessAt,
      lastError: follow.lastError?.message,
    };
  }

  private mapRecommendedSource(
    source: RecommendedSource,
  ): RadarRecommendedSource {
    return {
      id: source.id,
      name: source.name,
      description: source.description,
      category: source.category,
      url: source.url,
      defaultRefreshIntervalMinutes: source.refreshIntervalMinutes,
      enabledByDefault: source.enabledByDefault,
    };
  }

  private assertInstance(
    serverInstanceId: string,
    identity: RemoteSourceIdentity,
  ): void {
    if (serverInstanceId !== identity.serverInstanceId)
      throw new Error("信息源服务实例在请求期间发生变化，请重试。");
  }

  private async runOperation<T>(
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.closed) throw new Error("信息源服务连接已关闭。");
    const controller = new AbortController();
    this.active.add(controller);
    const timer = setTimeout(
      () => controller.abort(new DOMException("请求超时", "TimeoutError")),
      this.timeoutMs,
    );
    timer.unref?.();
    try {
      return await work(controller.signal);
    } catch (error) {
      if (controller.signal.aborted)
        throw new Error(
          controller.signal.reason instanceof DOMException &&
            controller.signal.reason.name === "AbortError"
            ? "信息源服务请求已停止。"
            : "信息源服务请求超时。",
        );
      throw new Error(this.safeMessage(error));
    } finally {
      clearTimeout(timer);
      this.active.delete(controller);
    }
  }

  startReceiving(sink: SourceReceiveSink): void {
    if (this.closed) throw new Error("信息源服务连接已关闭。");
    if (this.stream) return;
    const controller = new AbortController();
    sink.reportStatus?.("connecting");
    this.streamController = controller;
    this.stream = this.receiveLoop(sink, controller.signal)
      .catch((error) => {
        if (!controller.signal.aborted)
          sink.reportError?.(this.safeMessage(error));
      })
      .finally(() => {
        if (this.streamController === controller)
          this.streamController = undefined;
        this.stream = undefined;
      });
  }

  private async receiveLoop(
    sink: SourceReceiveSink,
    signal: AbortSignal,
  ): Promise<void> {
    let reconnectMs = this.streamReconnectMs;
    while (!signal.aborted) {
      try {
        await this.receiveConnection(sink, signal, () => {
          reconnectMs = this.streamReconnectMs;
        });
      } catch (error) {
        if (signal.aborted) return;
        try {
          sink.reportStatus?.("offline");
          sink.reportError?.(this.safeMessage(error));
        } catch {
          // Error reporting must never stop cursor recovery.
        }
        await this.reconnectPause(signal, reconnectMs);
        reconnectMs = Math.min(
          this.streamMaxReconnectMs,
          Math.max(this.streamReconnectMs, reconnectMs * 2 || 1),
        );
      }
    }
  }

  private async receiveConnection(
    sink: SourceReceiveSink,
    signal: AbortSignal,
    onProgress: () => void,
  ): Promise<void> {
    const capabilities = await this.boundedRequest(
      "/v1/capabilities",
      { method: "GET" },
      CapabilitiesResponseSchema,
      signal,
    );
    if (
      !capabilities.capabilities.changes ||
      !capabilities.capabilities.itemRevisions ||
      capabilities.capabilities.changeStream !== true
    )
      throw new Error("信息源服务不支持变更推送或修订读取。");
    if (this.tenantId && this.tenantId !== capabilities.tenantId)
      throw new Error("信息源服务的租户身份与本机配置不一致。");
    const identity: RemoteSourceIdentity = {
      serverInstanceId: capabilities.meta.serverInstanceId,
      tenantId: capabilities.tenantId,
    };
    let cursor = sink.cursorFor(identity);
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const opened = await this.openStream(
      `/v1/changes/stream${query}`,
      cursor,
      signal,
    );
    try {
      if (!opened.response.ok) {
        let detail = `HTTP ${opened.response.status}`;
        try {
          const parsed = ErrorResponseSchema.safeParse(
            await this.readJSON(opened.response),
          );
          if (parsed.success)
            detail = `${parsed.data.error.code}: ${parsed.data.error.message}`;
        } catch {
          // Keep the bounded status; never surface arbitrary stream response text.
        }
        throw new Error(`信息源推送连接失败（${detail}）。`);
      }
      const contentType = opened.response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (contentType !== "text/event-stream")
        throw new Error("信息源推送协议不兼容，请升级服务或桌面应用。");
      sink.reportStatus?.("online", identity);
      await this.consumeSSE(
        opened.response,
        signal,
        async (event, data, id) => {
          if (event === "heartbeat" || !data) return;
          let value: unknown;
          try {
            value = JSON.parse(data);
          } catch {
            throw new Error("信息源推送包含无效 JSON。");
          }
          if (event === "error") {
            const failure = ErrorResponseSchema.safeParse(value);
            throw new Error(
              failure.success
                ? `信息源推送失败（${failure.data.error.code}: ${failure.data.error.message}）。`
                : "信息源推送返回了无效错误。",
            );
          }
          if (event !== "change")
            throw new Error("信息源推送包含未知事件类型。");
          const parsed = ChangeStreamEventSchema.safeParse(value);
          if (!parsed.success)
            throw new Error("信息源推送协议不兼容，请升级服务或桌面应用。");
          const frame = parsed.data;
          if (frame.meta.serverInstanceId !== identity.serverInstanceId)
            throw new Error("信息源服务实例在推送期间发生变化，将重新连接。");
          if (id !== frame.cursor)
            throw new Error("信息源推送事件 ID 与恢复游标不一致。");
          if (frame.cursor === cursor)
            throw new Error("信息源推送未推进变更游标。");
          if (
            frame.change.kind !== "item.created" &&
            frame.change.kind !== "item.revised"
          )
            throw new Error("桌面尚不支持这种信息源变更，未推进游标。");
          const sources = [
            await this.sourceForChange(frame.change, identity, signal),
          ];
          await sink.commit({ ...identity, nextCursor: frame.cursor, sources });
          cursor = frame.cursor;
          onProgress();
        },
      );
      if (!signal.aborted) throw new Error("信息源推送连接已断开。");
    } finally {
      opened.release();
    }
  }

  private async sourceForChange(
    change: Change,
    identity: RemoteSourceIdentity,
    signal: AbortSignal,
  ): Promise<Source> {
    if (
      !change.itemId ||
      !change.revisionId ||
      !change.observedAt ||
      !change.contentHash ||
      !change.coverage ||
      !change.missing
    )
      throw new Error("信息源条目变更缺少修订身份。");
    const response = await this.boundedRequest(
      `/v1/items/${encodeURIComponent(change.itemId)}/revisions/${encodeURIComponent(change.revisionId)}`,
      { method: "GET" },
      RevisionResponseSchema,
      signal,
    );
    if (
      response.meta.serverInstanceId !== identity.serverInstanceId ||
      response.item.id !== change.itemId ||
      response.item.sourceId !== change.sourceId ||
      response.revision.id !== change.revisionId ||
      response.revision.itemId !== change.itemId ||
      response.revision.observedAt !== change.observedAt ||
      response.revision.contentHash !== change.contentHash ||
      response.revision.coverage !== change.coverage ||
      JSON.stringify(response.revision.missing) !==
        JSON.stringify(change.missing)
    )
      throw new Error("信息源推送与远端修订不一致。");
    return this.sourceFromRevision(
      response,
      identity,
      change.occurredAt,
      change.followId,
    );
  }

  private sourceFromRevision(
    response: RevisionResponse,
    identity: RemoteSourceIdentity,
    addedAt: string,
    followId?: string,
  ): Source {
    if (
      !response.revision.content.trim() ||
      Buffer.byteLength(response.revision.content) > MAX_ITEM_CONTENT_BYTES
    )
      throw new Error("信息源服务返回的网页正文为空或超过 2 MB。");
    if (
      createHash("sha256").update(response.revision.content).digest("hex") !==
      response.revision.contentHash
    )
      throw new Error("信息源服务返回的网页正文与内容哈希不一致。");
    return {
      id: randomUUID(),
      title: response.item.title,
      type: "url",
      location: response.item.canonicalUrl,
      text: response.revision.content,
      addedAt,
      coverage: response.revision.missing.length
        ? `网页正文（${response.revision.coverage}）；缺失：${response.revision.missing.join("、")}`
        : `网页正文（${response.revision.coverage}）`,
      remote: {
        ...identity,
        sourceId: response.item.sourceId,
        ...(followId ? { followId } : {}),
        itemId: response.item.id,
        revisionId: response.revision.id,
        contentHash: response.revision.contentHash,
        observedAt: response.revision.observedAt,
        ...(response.revision.publishedAt
          ? { publishedAt: response.revision.publishedAt }
          : {}),
        coverageLevel: response.revision.coverage,
        missing: [...response.revision.missing],
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.active)
      controller.abort(new DOMException("信息源请求已停止", "AbortError"));
    this.streamController?.abort(
      new DOMException("信息源接收已停止", "AbortError"),
    );
    await this.stream;
  }

  private async boundedRequest<T>(
    path: string,
    init: RequestInit,
    schema: Parser<T>,
    parent: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort(parent.reason);
    if (parent.aborted) abort();
    else parent.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new DOMException("请求超时", "TimeoutError")),
      this.timeoutMs,
    );
    timer.unref?.();
    try {
      return await this.request(path, init, schema, controller.signal);
    } finally {
      clearTimeout(timer);
      parent.removeEventListener("abort", abort);
    }
  }

  private async openStream(
    path: string,
    cursor: string | undefined,
    parent: AbortSignal,
  ): Promise<{ response: Response; release(): void }> {
    const controller = new AbortController();
    const abort = () => controller.abort(parent.reason);
    if (parent.aborted) abort();
    else parent.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new DOMException("连接超时", "TimeoutError")),
      this.timeoutMs,
    );
    timer.unref?.();
    try {
      const response = await this.fetch(`${this.baseURL}${path}`, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "text/event-stream",
          Authorization: `Bearer ${this.token}`,
          "Cache-Control": "no-cache",
          ...(cursor ? { "Last-Event-ID": cursor } : {}),
        },
      });
      clearTimeout(timer);
      let released = false;
      return {
        response,
        release: () => {
          if (released) return;
          released = true;
          parent.removeEventListener("abort", abort);
          if (!controller.signal.aborted)
            controller.abort(
              new DOMException("信息源推送连接已释放", "AbortError"),
            );
        },
      };
    } catch (error) {
      clearTimeout(timer);
      parent.removeEventListener("abort", abort);
      if (
        !parent.aborted &&
        controller.signal.reason instanceof DOMException &&
        controller.signal.reason.name === "TimeoutError"
      )
        throw new Error("信息源推送连接超时。");
      throw error;
    }
  }

  private async consumeSSE(
    response: Response,
    signal: AbortSignal,
    consume: (event: string, data: string, id?: string) => Promise<void>,
  ): Promise<void> {
    if (!response.body) throw new Error("信息源推送响应为空。");
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "";
    const abort = () => {
      void reader.cancel(signal.reason).catch(() => undefined);
    };
    signal.addEventListener("abort", abort, { once: true });
    const dispatch = async (block: string) => {
      if (Buffer.byteLength(block) > MAX_SSE_EVENT_BYTES)
        throw new Error("信息源推送事件过大。");
      let event = "message";
      let id: string | undefined;
      const data: string[] = [];
      for (let line of block.split(/\r?\n/)) {
        if (line.charCodeAt(0) === 0xfeff) line = line.slice(1);
        if (!line || line.startsWith(":")) continue;
        const separator = line.indexOf(":");
        const field = separator < 0 ? line : line.slice(0, separator);
        let value = separator < 0 ? "" : line.slice(separator + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") event = value || "message";
        else if (field === "id") id = value;
        else if (field === "data") data.push(value);
      }
      if (data.length) await consume(event, data.join("\n"), id);
    };
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        while (true) {
          const boundary = /\r?\n\r?\n/.exec(buffer);
          if (!boundary || boundary.index === undefined) break;
          const block = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          await dispatch(block);
        }
        if (Buffer.byteLength(buffer) > MAX_SSE_EVENT_BYTES)
          throw new Error("信息源推送事件过大。");
      }
      buffer += decoder.decode();
      if (!signal.aborted && buffer.trim()) await dispatch(buffer);
    } finally {
      signal.removeEventListener("abort", abort);
      reader.releaseLock();
    }
  }

  private reconnectPause(
    signal: AbortSignal,
    milliseconds: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const timer = setTimeout(done, milliseconds);
      timer.unref?.();
      const aborted = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
        reject(signal.reason);
      };
      function done() {
        signal.removeEventListener("abort", aborted);
        resolve();
      }
      signal.addEventListener("abort", aborted, { once: true });
    });
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    schema: Parser<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const request = {
      ...init,
      signal,
      redirect: "error" as const,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    };
    let response: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await this.fetch(`${this.baseURL}${path}`, request);
        break;
      } catch (error) {
        if (signal.aborted) throw new Error("信息源服务请求超时。");
        const safeToReplay =
          init.method === "GET" ||
          new Headers(init.headers).has("Idempotency-Key");
        if (attempt || !safeToReplay) throw error;
        await this.pause(signal);
      }
    }
    if (!response) throw new Error("信息源服务没有返回响应。");
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const parsed = ErrorResponseSchema.safeParse(
          await this.readJSON(response),
        );
        if (parsed.success)
          detail = `${parsed.data.error.code}: ${parsed.data.error.message}`;
      } catch {
        // Keep the bounded HTTP status; never surface arbitrary response text.
      }
      throw new Error(`信息源服务请求失败（${detail}）。`);
    }
    let value: unknown;
    try {
      value = await this.readJSON(response);
    } catch (error) {
      if (error instanceof SourceResponseReadError) throw error;
      throw new Error("信息源服务返回了无法读取的响应。");
    }
    try {
      return schema.parse(value);
    } catch {
      throw new Error("信息源服务协议不兼容，请升级服务或桌面应用。");
    }
  }

  private async readJSON(response: Response): Promise<unknown> {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_SERVICE_RESPONSE_BYTES)
      throw new SourceResponseReadError("信息源服务响应过大。");
    if (!response.body)
      throw new SourceResponseReadError("信息源服务响应为空。");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_SERVICE_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new SourceResponseReadError("信息源服务响应过大。");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    try {
      return JSON.parse(
        Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
          "utf8",
        ),
      );
    } catch {
      throw new SourceResponseReadError("信息源服务返回了无法读取的响应。");
    }
  }

  private pause(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const timer = setTimeout(done, this.pollIntervalMs);
      const aborted = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
        reject(signal.reason);
      };
      function done() {
        signal.removeEventListener("abort", aborted);
        resolve();
      }
      signal.addEventListener("abort", aborted, { once: true });
    });
  }

  private safeMessage(error: unknown): string {
    let message =
      error instanceof Error ? error.message : "信息源服务请求未完成。";
    message = message
      .split(this.token)
      .join("[已隐藏令牌]")
      .replace(/Bearer\s+\S+/gi, "Bearer [已隐藏令牌]");
    return message.slice(0, 700);
  }
}
