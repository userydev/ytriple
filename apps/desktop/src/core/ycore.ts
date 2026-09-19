import { createHash } from "node:crypto";
import { z } from "zod";
import { feedReadResult } from "./feed-contract";
import { Store } from "./store";
import type { Material, Source } from "./types";
const documentSchema = z.object({
  id: z.string(),
  revision: z.number().int().positive(),
  url: z.string(),
  publisher: z.string().nullable(),
  published_at: z.string().nullable(),
  discovered_at: z.string(),
  updated_at: z.string(),
  topics: z.array(z.string()),
  content: z.object({
    title: z.string(),
    summary: z.string().nullable(),
    body: z.string().nullable(),
    format: z.enum(["text", "html"]),
    coverage: z.enum(["title_only", "summary", "feed_content"]),
    full_article: z.literal(false),
  }),
  provenance: z.array(
    z.object({
      source_id: z.string(),
      adapter: z.string(),
      upstream_id: z.string().nullable(),
      discovered_at: z.string(),
      raw_ref: z.string(),
    }),
  ),
  content_hash: z.string(),
  visibility: z.literal("public"),
  image: z
    .object({
      url: z.string().url(),
      origin: z.enum(["enclosure", "media", "content"]),
      credit: z.string().nullable().optional(),
    })
    .optional(),
});
const derivedSchema = z.object({
  document_id: z.string(),
  revision: z.number().int().positive(),
  content_hash: z.string(),
  processor_version: z.string(),
  status: z.enum(["ready", "insufficient", "failed"]),
  title_zh: z.string().nullable(),
  digest: z.string().nullable(),
  keypoints: z.array(
    z.object({ text: z.string(), quote: z.string() }).strict(),
  ),
  coverage: z.string(),
  model: z.string().nullable(),
  processed_at: z.string().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  input: z
    .object({
      chars: z.number().int().nonnegative(),
      truncated: z.boolean(),
    })
    .nullable()
    .optional(),
});
const refSchema = z.object({
  id: z.string(),
  revision: z.number().int().positive(),
});
const userIdentity = z.object({
  id: z.string().min(1).max(200),
  user_id: z.string().uuid(),
  product_id: z.string(),
  authentication: z.literal("supabase"),
});
export function managedServiceScope(baseUrl: string, subject: string) {
  return createHash("sha256")
    .update(baseUrl.replace(/\/$/, "") + "\0managed\0" + subject)
    .digest("hex");
}
export type Prompt = {
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  refs: { id: string; revision: number }[];
  taskId: string;
};
export type StreamEvent = {
  type: "run.started" | "text.delta" | "run.completed" | "run.failed";
  run_id: string;
  text?: string;
  error?: { code: string; message: string };
};
export function isUncertainExecution(code: string | undefined) {
  return code === "EXECUTION_LOST" || code === "PROVIDER_ERROR";
}
export interface Model {
  readonly identity?: import("./model-contract").ModelIdentity;
  readonly recovery?: "remote" | "local";
  readonly scope?: string;
  lookupByKey?(key: string): Promise<{
    id: string;
    status: string;
    result: unknown;
    error: { message: string } | null;
  }>;
  lookup?(id: string): Promise<{
    status: string;
    result: unknown;
    error: { message: string } | null;
  }>;
  stream(
    prompt: Prompt,
    key: string,
    signal: AbortSignal,
  ): AsyncGenerator<StreamEvent>;
}
export class ServiceError extends Error {
  constructor(
    public code: string,
    message: string,
    public runId?: string,
  ) {
    super(message);
  }
}
export class YCore implements Model {
  readonly identity: import("./model-contract").ModelIdentity;
  private readonly clientScope: string;
  private user?: {
    id: string;
    providerUserId?: string;
    product: string;
    scope: string;
    verifiedToken: string;
    accessToken: (signal?: AbortSignal) => Promise<string>;
  };
  get scope() {
    return this.user?.scope ?? this.clientScope;
  }

  /** Managed sessions are verified before use; a refreshed token must retain
   * the same service subject before any private read or billable request. */
  static async forUser(
    baseUrl: string,
    product: string,
    accessToken: (signal?: AbortSignal) => Promise<string>,
    fetcher: typeof fetch = fetch,
    providerUserId?: string,
  ) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(product)) throw Error("产品标识无效");
    const token = await accessToken();
    const service = new YCore(baseUrl, token, fetcher);
    const identity = await service.verifyUser(
      token,
      product,
      undefined,
      providerUserId,
    );
    service.user = {
      id: identity.id,
      providerUserId,
      product,
      verifiedToken: token,
      accessToken,
      scope: managedServiceScope(baseUrl, identity.id),
    };
    return service;
  }
  constructor(
    readonly baseUrl: string,
    private token: string,
    private fetcher: typeof fetch = fetch,
  ) {
    const url = new URL(baseUrl);
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      )
    )
      throw Error("服务地址需要 HTTPS，本机隧道可使用 HTTP");
    if (url.username || url.password || url.search || url.hash)
      throw Error("服务地址不能包含凭据或查询参数");
    this.identity = {
      kind: "service",
      label: "ycore 共享模型",
      endpoint: baseUrl,
    };
    this.clientScope = createHash("sha256")
      .update(baseUrl.replace(/\/$/, "") + "\0" + token)
      .digest("hex");
  }
  async request(path: string, init: RequestInit = {}) {
    let token = this.token;
    if (this.user) {
      token = await this.user.accessToken(init.signal ?? undefined);
      init.signal?.throwIfAborted();
      if (token !== this.user.verifiedToken) {
        const current = await this.verifyUser(
          token,
          this.user.product,
          init.signal ?? undefined,
          this.user.providerUserId,
        );
        if (current.id !== this.user.id)
          throw new ServiceError(
            "ACCOUNT_CHANGED",
            "当前账号已变化，请回到原账号接续；未发送本次工作请求",
          );
        this.user.verifiedToken = token;
      }
    }
    return this.send(path, token, this.user?.product, init);
  }
  private async verifyUser(
    token: string,
    product: string,
    signal?: AbortSignal,
    providerUserId?: string,
  ) {
    const identity = userIdentity.parse(
      await (
        await this.send("/v1/identity", token, product, { signal })
      ).json(),
    );
    if (identity.product_id !== product)
      throw new ServiceError("ACCOUNT_CHANGED", "服务返回的产品身份不匹配");
    if (providerUserId && identity.user_id !== providerUserId)
      throw new ServiceError("ACCOUNT_CHANGED", "服务返回的账号身份不匹配");
    return identity;
  }
  private async send(
    path: string,
    token: string,
    product: string | undefined,
    init: RequestInit,
  ) {
    if (!token || token.length > 16384 || /\s/.test(token))
      throw new ServiceError("UNAUTHORIZED", "登录状态不可用，请重新登录");
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("Content-Type", "application/json");
    if (product) headers.set("X-YCore-Product", product);
    else headers.delete("X-YCore-Product");
    const response = await this.fetcher(
      this.baseUrl.replace(/\/$/, "") + path,
      {
        ...init,
        redirect: "error",
        headers,
        signal: init.signal ?? AbortSignal.timeout(15000),
      },
    );
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as {
        error?: { code?: string; message?: string; run_id?: string };
      };
      throw new ServiceError(
        data.error?.code ?? "HTTP_ERROR",
        data.error?.message ?? `服务请求失败 (${response.status})`,
        data.error?.run_id,
      );
    }
    if (response.headers.get("X-YCore-Contract") !== "0.1.0")
      throw new ServiceError("CONTRACT_MISMATCH", "服务协议版本不兼容");
    return response;
  }
  async capabilities() {
    return (await this.request("/v1/capabilities")).json() as Promise<{
      processing?: {
        available: boolean;
        model: string | null;
        processor_version: string | null;
      };
      [key: string]: unknown;
    }>;
  }
  async processDerived(
    items: { id: string; revision: number }[],
    retry = false,
  ) {
    return z
      .object({ data: z.array(derivedSchema) })
      .parse(
        await (
          await this.request("/v1/derived/process", {
            method: "POST",
            body: JSON.stringify({ items, retry }),
            signal: AbortSignal.timeout(120000),
          })
        ).json(),
      ).data;
  }
  associateDerived(
    store: Store,
    records: z.infer<typeof derivedSchema>[],
  ) {
    for (const record of records) {
      for (const material of store.all<Material>("material")) {
        if (
          material.upstream?.id !== record.document_id ||
          material.upstream.revision !== record.revision
        )
          continue;
        store.put("material", `${material.id}@${material.version}`, {
          ...material,
          derived: {
            processorVersion: record.processor_version,
            status: record.status,
            titleZh: record.title_zh,
            digest: record.digest,
            keypoints: record.keypoints,
            coverage: record.coverage,
            model: record.model,
            processedAt: record.processed_at,
            contentHash: record.content_hash,
            revision: record.revision,
            error: record.error,
            input: record.input ?? null,
          },
        });
      }
    }
  }
  async readFeed(url: string, signal?: AbortSignal) {
    try {
      return feedReadResult.parse(
        await (
          await this.request("/v1/feeds/read", {
            method: "POST",
            body: JSON.stringify({ url }),
            signal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
              : AbortSignal.timeout(30000),
          })
        ).json(),
      );
    } catch (error) {
      if (error instanceof ServiceError) {
        const messages: Record<string, string> = {
          NOT_FOUND: "当前服务版本尚未提供个人订阅读取，请更新 ycore 后重试",
          NOT_A_FEED:
            "这是普通网页，请填写 RSS 或 Atom 订阅地址；网页尚未作为正文读取",
          FEED_PARSE_FAILED: "订阅格式无法解析，已有材料保持不变",
          SOURCE_URL_REJECTED:
            "仅支持不含凭据的公开 HTTPS 订阅，不支持本机或私有网络地址",
          SOURCE_UNAVAILABLE: "来源暂不可达或需要登录，请稍后刷新",
          SOURCE_TOO_LARGE: "订阅响应超过读取范围（2 MiB）",
          FEED_READ_LIMIT: "来源读取较频繁，请稍后刷新",
        };
        if (messages[error.code]) throw Error(messages[error.code]);
      }
      throw error;
    }
  }
  async run(id: string) {
    return (await this.request("/v1/ai/runs/" + encodeURIComponent(id))).json();
  }
  async lookup(id: string) {
    return z
      .object({
        status: z.string(),
        result: z.unknown(),
        error: z.object({ message: z.string() }).nullable(),
      })
      .parse(await this.run(id));
  }
  async lookupByKey(key: string) {
    return z
      .object({
        id: z.string().uuid(),
        status: z.string(),
        result: z.unknown(),
        error: z.object({ message: z.string() }).nullable(),
      })
      .parse(
        await (
          await this.request("/v1/ai/runs/by-key/" + encodeURIComponent(key))
        ).json(),
      );
  }
  async createJson(
    prompt: Prompt,
    key: string,
    outputSchema: Record<string, unknown>,
  ) {
    return (
      await this.request("/v1/ai/runs", {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: JSON.stringify({
          mode: "json",
          model_profile: "default",
          task_id: prompt.taskId,
          messages: prompt.messages,
          document_refs: prompt.refs,
          max_output_tokens: 1024,
          output_schema: outputSchema,
        }),
      })
    ).json();
  }
  async *stream(
    prompt: Prompt,
    key: string,
    signal: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const response = await this.request("/v1/ai/runs", {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify({
        mode: "stream",
        model_profile: "default",
        task_id: prompt.taskId,
        messages: prompt.messages,
        document_refs: prompt.refs,
        max_output_tokens: 4096,
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]),
    });
    if (
      !response.headers.get("content-type")?.includes("text/event-stream") ||
      !response.body
    )
      throw new ServiceError("INVALID_STREAM", "服务没有返回有效数据流");
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let buffer = "",
      runId: string | undefined,
      terminal = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += done
          ? decoder.decode()
          : decoder.decode(value, { stream: true });
        if (done && buffer.trim()) buffer += "\n\n";
        let match: RegExpExecArray | null;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          const lines = frame.split(/\r?\n/);
          const type = lines
            .find((l) => l.startsWith("event:"))
            ?.slice(6)
            .trim();
          const data = lines
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart())
            .join("\n");
          if (!type || !data) continue;
          if (
            ![
              "run.started",
              "text.delta",
              "run.completed",
              "run.failed",
            ].includes(type)
          )
            continue;
          let parsed: {
            run_id: string;
            text?: string;
            error?: { code: string; message: string };
          };
          try {
            parsed = z
              .object({
                run_id: z.string(),
                text: z.string().optional(),
                error: z
                  .object({ code: z.string(), message: z.string() })
                  .passthrough()
                  .optional(),
              })
              .parse(JSON.parse(data));
          } catch {
            throw new ServiceError(
              "INVALID_STREAM",
              "服务返回的事件格式无效；请核对原运行",
              runId,
            );
          }
          if (runId && runId !== parsed.run_id)
            throw new ServiceError(
              "INVALID_STREAM",
              "数据流的运行标识发生变化",
              runId,
            );
          runId = parsed.run_id;
          if (terminal)
            throw new ServiceError(
              "INVALID_STREAM",
              "终态后收到额外输出",
              runId,
            );
          if (type === "text.delta" && parsed.text === undefined)
            throw new ServiceError("INVALID_STREAM", "输出片段缺少正文", runId);
          terminal = type === "run.completed" || type === "run.failed";
          yield { ...parsed, type: type as StreamEvent["type"] };
        }
        if (done) break;
      }
      if (!terminal)
        throw new ServiceError(
          "STREAM_INTERRUPTED",
          "连接中断，尚未确认完成；请核对原运行",
          runId,
        );
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  async sync(store: Store) {
    const save = (raw: z.infer<typeof documentSchema>) => {
      const id = `ycore:${this.scope}:${raw.id}`;
      const body = raw.content.body ?? raw.content.summary ?? raw.content.title;
      const existing = store.get<Material>("material", `${id}@${raw.revision}`);
      const m: Material = {
        id,
        version: raw.revision,
        title: raw.content.title,
        body:
          raw.content.format === "html"
            ? body.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ")
            : body,
        coverage: raw.content.coverage,
        url: raw.url,
        upstream: {
          scope: this.scope,
          id: raw.id,
          revision: raw.revision,
          publisher: raw.publisher,
          publishedAt: raw.published_at,
          discoveredAt: raw.discovered_at,
          updatedAt: raw.updated_at,
          topics: raw.topics,
          provenance: raw.provenance.map((entry) => ({
            sourceId: entry.source_id,
            adapter: entry.adapter,
            upstreamId: entry.upstream_id,
            discoveredAt: entry.discovered_at,
            rawRef: entry.raw_ref,
          })),
          contentHash: raw.content_hash,
          fullArticle: raw.content.full_article,
        },
        createdAt: raw.published_at ?? raw.discovered_at,
        ...(raw.image
          ? {
              image: {
                url: raw.image.url,
                origin: raw.image.origin,
                credit: raw.image.credit ?? null,
              },
            }
          : {}),
        ...(existing?.derived &&
        existing.derived.contentHash === raw.content_hash &&
        existing.derived.revision === raw.revision
          ? { derived: existing.derived }
          : {}),
      };
      store.put("material", `${id}@${m.version}`, m);
    };
    const key = `sync:${this.scope}`;
    let cursor = store.get<string>("meta", key);
    const sources = z
      .object({
        data: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            status: z.string(),
            last_error: z.string().nullable(),
          }),
        ),
      })
      .parse(await (await this.request("/v1/sources")).json());
    store.put<Source[]>("meta", "sources", sources.data);
    const snapshot = async () => {
      let next: string | null = null;
      let sync: string | undefined;
      do {
        const p = z
          .object({
            data: z.array(documentSchema),
            next_cursor: z.string().nullable(),
            sync_cursor: z.string(),
          })
          .parse(
            await (
              await this.request(
                "/v1/documents?limit=50" +
                  (next ? "&cursor=" + encodeURIComponent(next) : ""),
              )
            ).json(),
          );
        store.transaction(() => p.data.forEach(save));
        sync ??= p.sync_cursor;
        next = p.next_cursor;
      } while (next);
      cursor = sync!;
      store.put("meta", key, cursor);
    };
    const increments = async () => {
      let more = true;
      while (more) {
        if (!cursor) throw Error("材料增量游标缺失");
        const p = z
          .object({
            data: z.array(
              z.object({
                sequence: z.string(),
                operation: z.literal("upsert"),
                document: documentSchema,
              }),
            ),
            next_cursor: z.string(),
            has_more: z.boolean(),
          })
          .parse(
            await (
              await this.request(
                "/v1/changes?limit=50&cursor=" + encodeURIComponent(cursor),
              )
            ).json(),
          );
        store.transaction(() => {
          p.data.forEach((c) => save(c.document));
          store.put("meta", key, p.next_cursor);
        });
        cursor = p.next_cursor;
        more = p.has_more;
      }
    };
    if (!cursor) await snapshot();
    try {
      await increments();
    } catch (e) {
      if (e instanceof ServiceError && e.code === "CURSOR_EXPIRED") {
        store.remove("meta", key);
        cursor = undefined;
        await snapshot();
        await increments();
      } else {
        throw e;
      }
    }
    return store
      .all<Material>("material")
      .filter((m) => m.upstream?.scope === this.scope).length;
  }
}
