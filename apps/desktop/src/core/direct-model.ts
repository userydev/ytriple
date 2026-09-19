import { createHash } from "node:crypto";
import { createParser } from "eventsource-parser";
import { z } from "zod";
import {
  directProfile,
  normalizeEndpoint,
  type DirectProfile,
  type DirectCall,
} from "./model-contract";
import type { Store } from "./store";
import {
  ServiceError,
  type Model,
  type Prompt,
  type StreamEvent,
} from "./ycore";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const chunk = z.object({
  id: z.string().optional(),
  choices: z.array(
    z.object({
      index: z.number().int(),
      delta: z.object({
        content: z.string().nullable().optional(),
        refusal: z.string().nullable().optional(),
        tool_calls: z.unknown().optional(),
        function_call: z.unknown().optional(),
      }),
      finish_reason: z.string().nullable().optional(),
    }),
  ),
});
export class DirectModel implements Model {
  readonly recovery = "local" as const;
  readonly scope: string;
  readonly identity: import("./model-contract").ModelIdentity;
  readonly profile: DirectProfile;
  private active = new Set<string>();
  constructor(
    private store: Store,
    profile: DirectProfile,
    private token: string,
    private fetcher: typeof fetch = fetch,
  ) {
    this.profile = {
      ...directProfile.parse(profile),
      baseUrl: normalizeEndpoint(profile.baseUrl),
    };
    if (/[\r\n]/.test(token) || token.length > 4096)
      throw Error("API Key 格式无效");
    this.identity = {
      kind: "direct",
      label: this.profile.model,
      endpoint: this.profile.baseUrl,
    };
    this.scope = `direct:${hash(JSON.stringify(this.profile) + "\0" + token)}`;
  }
  private id(key: string) {
    return `direct:${hash(this.scope + "\0" + key)}`;
  }
  async lookup(id: string) {
    const call = this.store.require<DirectCall>("direct-call", id);
    if (call.scope !== this.scope)
      throw Error("本地请求属于另一模型连接，请恢复原配置");
    return {
      id: call.id,
      status:
        call.status === "pending"
          ? this.active.has(id)
            ? "running"
            : "unknown"
          : call.status,
      result: call.status === "succeeded" ? { text: call.body } : null,
      error: call.error ? { message: call.error } : null,
    };
  }
  async lookupByKey(key: string) {
    return this.lookup(this.id(key));
  }
  async *stream(
    prompt: Prompt,
    key: string,
    signal: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const id = this.id(key),
      request = {
        model: this.profile.model,
        messages: prompt.messages,
        stream: true,
        n: 1,
        [this.profile.tokenParameter]: this.profile.maxOutputTokens,
      };
    const body = JSON.stringify(request),
      requestHash = hash(body);
    if (Buffer.byteLength(body) > 512 * 1024)
      throw Error("直连请求超过 512 KiB，请缩小材料范围");
    if (signal.aborted) throw new DOMException("发送前已停止", "AbortError");
    let call: DirectCall = this.store.transaction(() => {
      const previous = this.store.get<DirectCall>("direct-call", id);
      if (previous) {
        if (previous.requestHash !== requestHash)
          throw Error("同一请求身份的内容已改变");
        throw new ServiceError(
          "RUN_ALREADY_EXISTS",
          "本地已有提交记录，请核对原结果；不会重发",
          id,
        );
      }
      const now = new Date().toISOString();
      return this.store.put("direct-call", id, {
        id,
        key,
        scope: this.scope,
        requestHash,
        profile: this.profile,
        status: "pending",
        body: "",
        providerId: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      } satisfies DirectCall);
    });
    const save = (patch: Partial<DirectCall>) => {
      call = { ...call, ...patch, updatedAt: new Date().toISOString() };
      this.store.put("direct-call", id, call);
    };
    this.active.add(id);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let submitted = false,
      completed = false;
    try {
      yield { type: "run.started", run_id: id };
      if (signal.aborted) {
        save({ status: "cancelled", error: "发送前已停止" });
        throw new ServiceError("DIRECT_REJECTED", "发送前已停止", id);
      }
      submitted = true;
      const response = await this.fetcher(
        this.profile.baseUrl + "/chat/completions",
        {
          method: "POST",
          redirect: "error",
          headers: {
            "Content-Type": "application/json",
            ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          },
          body,
          signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]),
        },
      );
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const message =
          response.status === 401 || response.status === 403
            ? "模型连接未获授权，请检查 API Key 和权限"
            : response.status === 429
              ? "模型服务限流或额度不足，请检查提供商账户"
              : `模型接口返回 HTTP ${response.status}，请检查地址、模型与兼容参数`;
        throw new ServiceError(
          response.status >= 500 || response.status === 408
            ? "STREAM_INTERRUPTED"
            : "DIRECT_REJECTED",
          message,
          id,
        );
      }
      if (
        !response.body ||
        !response.headers.get("content-type")?.includes("text/event-stream")
      )
        throw Error("模型没有返回兼容文本流");
      reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const frames: string[] = [];
      const parser = createParser({
        onEvent: (event) => frames.push(event.data),
        onError: () => {
          throw Error("模型数据流格式无效");
        },
      });
      let bytes = 0,
        finish: string | null = null,
        doneMarker = false;
      while (true) {
        const next = await reader.read();
        if (next.value) {
          bytes += next.value.byteLength;
          if (bytes > 2 * 1024 * 1024)
            throw Error("模型数据流超过 2 MiB 处理范围");
        }
        parser.feed(
          next.done
            ? decoder.decode()
            : decoder.decode(next.value, { stream: true }),
        );
        while (frames.length) {
          const raw = frames.shift()!;
          if (raw === "[DONE]") {
            doneMarker = true;
            continue;
          }
          if (doneMarker) throw Error("结束标记后收到额外数据");
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            throw Error("模型返回无效 JSON 数据流");
          }
          const value = chunk.safeParse(parsed);
          if (!value.success)
            throw Error("模型数据流不是受支持的 Chat Completions 文本格式");
          if (value.data.id) {
            if (call.providerId && call.providerId !== value.data.id)
              throw Error("模型流的响应身份改变");
            call.providerId = value.data.id;
          }
          if (value.data.choices.length === 0) continue;
          if (
            value.data.choices.length !== 1 ||
            value.data.choices[0].index !== 0
          )
            throw Error("模型返回了多个候选，未作为单一成果使用");
          const choice = value.data.choices[0];
          if (finish) throw Error("完成原因后收到额外候选输出");
          if (choice.delta.tool_calls || choice.delta.function_call)
            throw new ServiceError(
              "DIRECT_INCOMPLETE",
              "当前连接仅支持文本，模型返回了工具调用",
              id,
            );
          if (choice.delta.refusal)
            throw new ServiceError(
              "DIRECT_INCOMPLETE",
              "模型拒绝了这次请求",
              id,
            );
          if (choice.delta.content) {
            call.body += choice.delta.content;
            if (Buffer.byteLength(call.body) > 256000)
              throw Error("模型正文超过 256 KiB 处理范围");
            save({});
            yield {
              type: "text.delta",
              run_id: id,
              text: choice.delta.content,
            };
          }
          if (choice.finish_reason) {
            finish = choice.finish_reason;
            if (finish !== "stop")
              throw new ServiceError(
                "DIRECT_INCOMPLETE",
                finish === "length"
                  ? "模型达到输出上限，部分内容已保留但未作为完整成果"
                  : "模型未正常结束，未生成完整成果",
                id,
              );
          }
        }
        if (next.done || doneMarker) break;
      }
      if (signal.aborted || finish !== "stop")
        throw new ServiceError(
          "STREAM_INTERRUPTED",
          "直连响应未确认完成；不会自动重发",
          id,
        );
      if (!call.body.trim())
        throw new ServiceError("DIRECT_INCOMPLETE", "模型未返回文本内容", id);
      save({ status: "succeeded", error: null });
      completed = true;
      yield { type: "run.completed", run_id: id };
    } catch (error) {
      const definitive =
        error instanceof ServiceError &&
        ["DIRECT_REJECTED", "DIRECT_INCOMPLETE"].includes(error.code);
      const message = definitive
        ? error.message
        : "直连请求结果尚未确认，可能已产生用量；可核对本地记录或结束本地等待，不会自动重发";
      if (call.status !== "cancelled")
        save({
          status: definitive ? "failed" : submitted ? "unknown" : "cancelled",
          error: message,
        });
      throw new ServiceError(
        definitive ? error.code : "STREAM_INTERRUPTED",
        message,
        id,
      );
    } finally {
      if (!completed && call.status === "pending")
        save({ status: "unknown", error: "本地消费中断，远端结果尚未确认" });
      this.active.delete(id);
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
    }
  }
}
