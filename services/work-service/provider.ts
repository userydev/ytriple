import { z } from "zod";
import { randomUUID } from "node:crypto";
import { WorkStore, HttpError, digest } from "./store.js";
import type { WorkModel } from "./contract.js";

export const upstreamModelSchema = z
  .object({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(160),
    provider: z.enum(["openai", "gemini"]),
    model: z.string().min(1).max(160),
    baseURL: z.url().optional(),
    apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    tools: z.boolean().default(true),
  })
  .strict();
export type UpstreamModel = z.infer<typeof upstreamModelSchema>;
const content = z.union([
  z.string().max(800000),
  z.array(z.record(z.string(), z.unknown())).max(100),
  z.null(),
]);
export const chatSchema = z
  .object({
    model: z.string().min(1),
    messages: z
      .array(
        z
          .object({
            role: z.enum(["system", "developer", "user", "assistant", "tool"]),
            content: content.optional(),
            name: z.string().optional(),
            tool_call_id: z.string().optional(),
            tool_calls: z.array(z.record(z.string(), z.unknown())).optional(),
          })
          .passthrough(),
      )
      .min(1)
      .max(500),
    tools: z
      .array(
        z
          .object({
            type: z.literal("function"),
            function: z
              .object({
                name: z.string().min(1).max(120),
                description: z.string().optional(),
                parameters: z.record(z.string(), z.unknown()),
                strict: z.boolean().optional(),
              })
              .strict(),
          })
          .strict(),
      )
      .max(100)
      .optional(),
    tool_choice: z
      .union([
        z.enum(["auto", "none", "required"]),
        z.object({
          type: z.literal("function"),
          function: z.object({ name: z.string() }),
        }),
      ])
      .optional(),
    parallel_tool_calls: z.boolean().optional(),
    max_tokens: z.number().int().min(1).max(16000).optional(),
    max_completion_tokens: z.number().int().min(1).max(16000).optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    frequency_penalty: z.number().optional(),
    presence_penalty: z.number().optional(),
    stream: z.boolean().optional(),
    stream_options: z
      .object({ include_usage: z.boolean().optional() })
      .optional(),
    response_format: z.record(z.string(), z.unknown()).optional(),
    reasoning_effort: z.string().optional(),
    user: z.string().optional(),
    store: z.boolean().optional(),
  })
  .strict();
export type ChatInput = z.infer<typeof chatSchema>;
export interface ChatOutput {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: "assistant";
      content?: string | null;
      tool_calls?: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
        [key: string]: unknown;
      }[];
      [key: string]: unknown;
    };
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  [key: string]: unknown;
}

export class ProviderGateway {
  readonly models: UpstreamModel[];
  constructor(
    private readonly store: WorkStore,
    models: UpstreamModel[],
    private readonly options: {
      allowHttp?: boolean;
      readKey?: (name: string) => string | undefined;
      fetch?: typeof fetch;
      timeoutMs?: number;
    } = {},
  ) {
    this.models = z.array(upstreamModelSchema).min(1).parse(models);
    if (new Set(this.models.map((model) => model.id)).size !== models.length)
      throw new Error("服务模型 ID 必须唯一。");
    for (const model of this.models) {
      const url = new URL(this.base(model));
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.protocol !== "https:" &&
          !(options.allowHttp && url.protocol === "http:"))
      )
        throw new Error(
          "模型上游必须是可信 HTTPS 地址，测试 HTTP 需明确启用。",
        );
    }
  }
  private base(model: UpstreamModel) {
    return (
      model.baseURL ??
      (model.provider === "gemini"
        ? "https://generativelanguage.googleapis.com/v1beta/openai"
        : "https://api.openai.com/v1")
    );
  }
  available(owner: string): WorkModel[] {
    const account = this.store.account(owner);
    return this.models
      .filter((model) => account.entitlement.modelIds.includes(model.id))
      .map((model) => ({
        id: model.id,
        object: "model",
        name: model.name,
        owned_by: "work-service",
        provider: model.provider,
        capabilities: { text: true, tools: model.tools, streaming: true },
        streamingMode: "buffered",
      }));
  }
  async complete(
    owner: string,
    raw: unknown,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<ChatOutput> {
    this.store.assertDataAvailable(owner);
    const epoch = this.store.dataEpoch(owner);
    const input = chatSchema.parse(raw),
      fingerprint = digest(input);
    const prior = this.store.db
      .prepare(
        "SELECT state,fingerprint,result FROM usage WHERE owner=? AND request_id=?",
      )
      .get(owner, requestId) as
      { state: string; fingerprint: string; result?: string } | undefined;
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new HttpError(409, "模型请求编号对应的输入已改变。");
      if (prior.state === "completed" && prior.result)
        return JSON.parse(prior.result);
      throw new HttpError(
        409,
        "上次模型请求结果尚未确认，不能自动重复计费调用。",
      );
    }
    const model = this.models.find((model) => model.id === input.model),
      account = this.store.account(owner);
    if (
      !account.entitlement.active ||
      (account.entitlement.expiresAt &&
        Date.parse(account.entitlement.expiresAt) <= Date.now())
    )
      throw new HttpError(403, "当前服务权益未启用或已到期。");
    if (!model || !account.entitlement.modelIds.includes(model.id))
      throw new HttpError(403, "当前账号未开通这个模型。");
    if (input.tools?.length && !model.tools)
      throw new HttpError(400, "这个服务模型没有启用工具调用能力。");
    const key = (this.options.readKey ?? ((name) => process.env[name]))(
      model.apiKeyEnv,
    );
    if (!key) throw new HttpError(503, "服务器尚未配置该模型凭据。");
    const active = this.store.db
      .prepare(
        "SELECT COUNT(*) count FROM usage WHERE owner=? AND state='pending'",
      )
      .get(owner) as { count: number };
    if (active.count >= account.entitlement.maxConcurrent)
      throw new HttpError(429, "已达到当前账号的并发上限。");
    const outputLimit = input.max_completion_tokens ?? input.max_tokens ?? 4096;
    const reserved =
      Buffer.byteLength(JSON.stringify(input.messages)) +
      Buffer.byteLength(JSON.stringify(input.tools ?? [])) +
      outputLimit +
      1024;
    if (reserved > account.usage.remainingTokens)
      throw new HttpError(429, "剩余配额不足以保留本次调用预算。");
    const usageId = randomUUID();
    this.store.db
      .prepare(
        "INSERT INTO usage(id,owner,request_id,fingerprint,model,state,reserved,created_at) VALUES(?,?,?,?,?,'pending',?,?)",
      )
      .run(
        usageId,
        owner,
        requestId,
        fingerprint,
        model.id,
        reserved,
        new Date().toISOString(),
      );
    try {
      const {
        stream: _stream,
        stream_options: _options,
        store: _store,
        ...body
      } = input;
      const response = await (this.options.fetch ?? fetch)(
        `${this.base(model).replace(/\/+$/, "")}/chat/completions`,
        {
          method: "POST",
          redirect: "error",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            ...body,
            model: model.model,
            stream: false,
            ...(model.provider === "openai" ? { store: false } : {}),
            ...(input.max_completion_tokens === undefined &&
            input.max_tokens === undefined
              ? { max_tokens: outputLimit }
              : {}),
          }),
          signal: signal
            ? AbortSignal.any([
                signal,
                AbortSignal.timeout(this.options.timeoutMs ?? 120000),
              ])
            : AbortSignal.timeout(this.options.timeoutMs ?? 120000),
        },
      );
      if (!response.ok)
        throw new HttpError(
          502,
          `上游模型返回 ${response.status}，请求结果未确认为可计量的成功响应。`,
        );
      const result = (await response.json()) as ChatOutput;
      if (
        !Array.isArray(result.choices) ||
        !result.choices.length ||
        !result.choices[0]?.message
      )
        throw new HttpError(502, "上游模型没有返回有效响应。");
      result.model = model.id;
      result.object = "chat.completion";
      const tokens = result.usage?.total_tokens;
      const known =
        typeof tokens === "number" && Number.isInteger(tokens) && tokens >= 0;
      const cleared =
        this.store.isDataClearing(owner) ||
        this.store.dataEpoch(owner) !== epoch;
      this.store.db
        .prepare("UPDATE usage SET state=?,tokens=?,result=? WHERE id=?")
        .run(
          known ? "completed" : "unknown",
          known ? tokens : null,
          cleared ? null : JSON.stringify(result),
          usageId,
        );
      this.store.assertDataAvailable(owner, epoch);
      return result;
    } catch (error) {
      this.store.db
        .prepare(
          "UPDATE usage SET state='unknown' WHERE id=? AND state='pending'",
        )
        .run(usageId);
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        502,
        signal?.aborted
          ? "本地已取消等待；上游是否已计费尚未确认。"
          : "上游连接中断或响应超时；结果和用量尚未确认，不自动重试。",
      );
    }
  }
}
