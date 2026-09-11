import { randomBytes } from "node:crypto";
import {
  Agent,
  OpenAIChatCompletionsModel,
  Runner,
  setTracingDisabled,
  tool,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type ResponseStreamEvent,
} from "@openai/agents";
import { aisdk } from "@openai/agents-extensions/ai-sdk";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import OpenAI from "openai";
import { z } from "zod";
import type { ModelProfile } from "../shared/types.js";

// The Agents SDK normally exports traces to OpenAI, independently of the model provider.
setTracingDisabled(true);

export type KeyReader = (
  profile: ModelProfile,
) => string | undefined | Promise<string | undefined>;
export type ModelFactory = (
  profile: ModelProfile,
  readKey: KeyReader,
) => Model | Promise<Model>;
export const REQUEST_TIMEOUT_MS = 120_000;

export function safeModelError(error: unknown, secret?: string): string {
  const value = error as
    | {
        name?: string;
        message?: string;
        status?: number;
        statusCode?: number;
        code?: string;
      }
    | undefined;
  const status = value?.status ?? value?.statusCode;
  if (
    /CodingPlan[\s\S]*(?:subscription|expired)|(?:subscription|expired)[\s\S]*CodingPlan/i.test(
      value?.message ?? "",
    )
  )
    return "当前密钥没有可用的 Coding Plan 订阅，无法使用该套餐接口。请核对账号订阅与模型配置。";
  if (status === 401 || status === 403)
    return `模型认证或权限失败（HTTP ${status}），请检查当前配置。`;
  if (status === 404)
    return "找不到模型或 API 地址（HTTP 404），请核对模型 ID 和协议。";
  if (status === 429)
    return "模型服务限流或额度不足（HTTP 429），可稍后继续或更换配置。";
  if (status && status >= 500)
    return `模型服务暂时异常（HTTP ${status}），工作记录已保留。`;
  if (
    value?.name === "TimeoutError" ||
    value?.name === "APIConnectionTimeoutError"
  )
    return "单次模型请求超时，工作记录已保留，可以继续。";
  if (value?.name === "AbortError") return "工作已暂停。";
  // Never surface SDK error objects: they may carry request headers and response bodies.
  let message = value?.message ?? "模型请求失败，请检查配置或稍后继续。";
  if (secret) message = message.split(secret).join("[已隐藏]");
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [已隐藏]")
    .replace(/account\s*\([^)]*\)/gi, "account [已隐藏]")
    .replace(/\bRequest\s+id\s*:\s*\S+/gi, "")
    .replace(/(?:sk-|AIza)[A-Za-z0-9_-]{12,}/g, "[已隐藏]")
    .replace(/([?&](?:key|api_key|token)=)[^&\s]+/gi, "$1[已隐藏]")
    .slice(0, 350);
}

export function validateProfile(profile: ModelProfile): void {
  if (!profile.modelId.trim())
    throw new Error(`${profile.name} 尚未填写模型 ID。`);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(profile.apiKeyEnv))
    throw new Error("密钥环境变量名称无效。");
  if (profile.protocol === "openai" && !profile.baseURL.trim())
    throw new Error(`${profile.name} 需要明确的 OpenAI 兼容 API 地址。`);
  if (profile.baseURL) {
    const url = new URL(profile.baseURL);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        "API 地址必须为不含密钥、查询参数或账号信息的 HTTP(S) 地址。",
      );
    if (
      profile.protocol === "openai" &&
      /\/(anthropic|messages)(\/|$)/i.test(url.pathname)
    )
      throw new Error(
        "此地址使用 Anthropic 协议，请填写对应的 OpenAI 兼容地址。",
      );
    if (
      profile.provider === "ark" &&
      profile.modelId === "ark-code-latest" &&
      url.hostname === "ark.cn-beijing.volces.com" &&
      /^\/api\/v3\/?$/.test(url.pathname)
    )
      throw new Error(
        "ark-code-latest 属于 Coding Plan，应配 https://ark.cn-beijing.volces.com/api/coding/v3。通用 /api/v3 需使用账号已开通的推理模型 ID。",
      );
  }
  if (profile.provider === "gemini" && profile.protocol !== "google")
    throw new Error("Gemini 配置使用 Google 原生协议。");
}

/** Independent clients prevent parallel members from sharing a mutable global API key. */
export async function createConfiguredModel(
  profile: ModelProfile,
  readKey: KeyReader,
): Promise<Model> {
  validateProfile(profile);
  const key = await readKey(profile);
  if (!key) throw new Error(`${profile.name} 未找到密钥，请在模型设置中配置。`);
  const inner =
    profile.protocol === "google"
      ? aisdk(
          createGoogleGenerativeAI({
            apiKey: key,
            ...(profile.baseURL ? { baseURL: profile.baseURL } : {}),
          })(profile.modelId),
        )
      : new OpenAIChatCompletionsModel(
          new OpenAI({
            apiKey: key,
            baseURL: profile.baseURL,
            maxRetries: 0,
            timeout: REQUEST_TIMEOUT_MS,
          }),
          profile.modelId,
          { strictFeatureValidation: true },
        );
  return {
    async getResponse(request) {
      try {
        return await inner.getResponse(request);
      } catch (error) {
        if (request.signal?.aborted) throw request.signal.reason;
        throw new Error(safeModelError(error, key));
      }
    },
    async *getStreamedResponse(request) {
      try {
        yield* inner.getStreamedResponse(request);
      } catch (error) {
        if (request.signal?.aborted) throw request.signal.reason;
        throw new Error(safeModelError(error, key));
      }
    },
  };
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("已暂停", "AbortError");
}
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError(signal));
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

/** A per-request deadline, with an explicit full-response fallback for non-stream providers. */
export function guardedModel(
  getModel: () => Promise<Model>,
  options: {
    beforeRequest?: () => void;
    afterResponse?: (response: ModelResponse) => void;
    timeoutMs?: number;
    streaming?: boolean;
  } = {},
): Model {
  const requestContext = (request: ModelRequest) => {
    options.beforeRequest?.();
    const timer = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
    return {
      ...request,
      signal: request.signal ? AbortSignal.any([request.signal, timer]) : timer,
    };
  };
  return {
    async getResponse(request) {
      const bounded = requestContext(request);
      const model = await raceAbort(getModel(), bounded.signal);
      const response = await raceAbort(
        model.getResponse(bounded),
        bounded.signal,
      );
      options.beforeRequest?.();
      options.afterResponse?.(response);
      return response;
    },
    async *getStreamedResponse(request) {
      const bounded = requestContext(request);
      const model = await raceAbort(getModel(), bounded.signal);
      if (options.streaming === false) {
        const response = await raceAbort(
          model.getResponse(bounded),
          bounded.signal,
        );
        options.beforeRequest?.();
        options.afterResponse?.(response);
        // ModelResponse's public alias also permits input messages; a terminal model event cannot.
        const output = response.output.filter(
          (item) => !("role" in item) || item.role === "assistant",
        ) as Extract<
          ResponseStreamEvent,
          { type: "response_done" }
        >["response"]["output"];
        yield {
          type: "response_done",
          response: {
            id: response.responseId ?? "",
            usage: response.usage,
            output,
          },
        };
        return;
      }
      const iterator = model
        .getStreamedResponse(bounded)
        [Symbol.asyncIterator]();
      try {
        while (true) {
          const next = await raceAbort(iterator.next(), bounded.signal);
          options.beforeRequest?.();
          if (next.done) break;
          yield next.value;
        }
      } finally {
        // An uncooperative provider must not prevent pause from returning.
        void iterator.return?.().catch(() => undefined);
      }
    },
  };
}

export interface ProbeResult {
  capabilities: { text: boolean; tools: boolean; streaming: boolean };
  text?: string;
  error?: string;
}

/** Synthetic integration checks. No task history, source files, or user documents are sent. */
export async function probeProfile(
  profile: ModelProfile,
  readKey: KeyReader,
  options: {
    modelFactory?: ModelFactory;
    timeoutMs?: number;
  } = {},
): Promise<ProbeResult> {
  const capabilities = { text: false, tools: false, streaming: false };
  const problems: string[] = [];
  let model: Model;
  try {
    model = guardedModel(
      () =>
        Promise.resolve(
          (options.modelFactory ?? createConfiguredModel)(profile, readKey),
        ),
      { timeoutMs: options.timeoutMs ?? 45_000 },
    );
  } catch (error) {
    return { capabilities, error: safeModelError(error) };
  }
  const runner = new Runner({ tracingDisabled: true });
  try {
    const agent = new Agent({
      name: "connection_probe",
      model,
      instructions:
        "This is a synthetic connection test. Follow the user instruction exactly.",
    });
    const response = await runner.run(agent, "Reply with exactly TEXT_OK.", {
      maxTurns: 2,
    });
    capabilities.text = String(response.finalOutput).includes("TEXT_OK");
    if (!capabilities.text) problems.push("文本探针未返回预期内容");
  } catch (error) {
    return { capabilities, error: safeModelError(error) };
  }
  if (!capabilities.text) return { capabilities, error: problems.join("；") };
  const proof = `proof_${randomBytes(8).toString("hex")}`;
  let called = false;
  const proofTool = tool({
    name: "read_probe_token",
    description: "Get the proof token for this synthetic test.",
    parameters: z.object({}),
    execute: async () => {
      called = true;
      return proof;
    },
  });
  try {
    const agent = new Agent({
      name: "tool_probe",
      model,
      tools: [proofTool],
      instructions:
        "Call read_probe_token once. Then reply with the exact token returned by the tool. Never invent a token.",
    });
    const response = await runner.run(agent, "Run the synthetic tool test.", {
      maxTurns: 3,
    });
    capabilities.tools = called && String(response.finalOutput).includes(proof);
    if (!capabilities.tools) problems.push("未完成真实工具调用及结果回读");
  } catch (error) {
    problems.push(`工具：${safeModelError(error)}`);
  }
  try {
    const agent = new Agent({
      name: "stream_probe",
      model,
      instructions: "Follow the user instruction exactly.",
    });
    const response = await runner.run(agent, "Reply with exactly STREAM_OK.", {
      stream: true,
      maxTurns: 2,
    });
    let delta = "";
    for await (const event of response)
      if (
        event.type === "raw_model_stream_event" &&
        event.data.type === "output_text_delta"
      )
        delta += event.data.delta;
    await response.completed;
    capabilities.streaming =
      delta.includes("STREAM_OK") &&
      String(response.finalOutput).includes("STREAM_OK");
    if (!capabilities.streaming) problems.push("没有收到可用的流式文本增量");
  } catch (error) {
    problems.push(`流式：${safeModelError(error)}`);
  }
  return {
    capabilities,
    text: "合成文本、真实工具回读和流式探针已执行。",
    ...(problems.length ? { error: problems.join("；") } : {}),
  };
}
