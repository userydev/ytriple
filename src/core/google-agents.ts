import {
  Usage,
  type Model,
  type ModelRequest,
  type ModelResponse,
} from "@openai/agents";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ModelProfile } from "../shared/types.js";
import { safeModelError, type KeyReader } from "./models.js";

export interface GoogleAgentOptions {
  onProgress?: (summary: string) => void;
  onCancel?: (confirmed: boolean) => void;
  onReport?: (text: string, interactionId: string) => Promise<void>;
  loadInteraction?: (inputHash: string) => string | undefined;
  saveInteraction?: (id: string, inputHash: string) => void;
  fetch?: typeof fetch;
  pollMs?: number;
}
type Interaction = {
  id: string;
  status: string;
  steps?: unknown[];
  outputs?: unknown[];
  usage?: Record<string, number>;
};
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
const items = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

/** Only final public model output is included. Thought/signature/tool argument payloads stay private. */
export function googleAgentReport(value: Interaction): string {
  const steps = items(value.steps)
    .map(record)
    .filter((step) => step.type === "model_output");
  const content = steps.length
    ? items(steps.at(-1)!.content)
    : items(value.outputs);
  const parts = content
    .map(record)
    .filter((part) => part.type === "text" && typeof part.text === "string");
  const report = parts
    .map((part) => part.text as string)
    .join("\n\n")
    .trim();
  if (!report) return "";
  const citations = new Map<string, string>();
  for (const part of parts)
    for (const annotation of items(part.annotations)
      .map(record)
      .slice(0, 100)) {
      if (
        annotation.type !== "url_citation" ||
        typeof annotation.url !== "string"
      )
        continue;
      try {
        const url = new URL(annotation.url);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password
        )
          continue;
        const label = (
          typeof annotation.title === "string" ? annotation.title : url.hostname
        )
          .slice(0, 200)
          .replace(/[\[\]\\\n\r]/g, " ");
        citations.set(
          url.href,
          `- [${label}](${url.href.replace(/[()<>]/g, (c) => "%" + c.charCodeAt(0).toString(16))})`,
        );
      } catch {
        /* Invalid citation URLs are not promoted to clickable references. */
      }
    }
  return (
    report +
    (citations.size
      ? "\n\n## 资料出处（Google 返回）\n\n" +
        [...citations.values()].join("\n")
      : "")
  );
}
export function googleAgentInput(request: ModelRequest): string {
  if (typeof request.input === "string") return request.input;
  return request.input
    .flatMap((item) => {
      const message = record(item);
      if (
        !["user", "assistant", "system", "developer"].includes(
          String(message.role),
        )
      )
        return [];
      const content =
        typeof message.content === "string"
          ? message.content
          : items(message.content)
              .map(record)
              .filter(
                (part) =>
                  ["input_text", "output_text", "text"].includes(
                    String(part.type),
                  ) && typeof part.text === "string",
              )
              .map((part) => part.text)
              .join("\n");
      return content ? [`${message.role}: ${content}`] : [];
    })
    .join("\n\n");
}
export async function createGoogleAgentModel(
  profile: ModelProfile,
  readKey: KeyReader,
  options: GoogleAgentOptions = {},
): Promise<Model> {
  if (
    profile.provider !== "gemini" ||
    profile.protocol !== "google" ||
    profile.execution !== "google-agent"
  )
    throw new Error("专项 Agent 需要 Google Interactions 连接。");
  const base = new URL(
    profile.baseURL || "https://generativelanguage.googleapis.com/v1beta",
  );
  if (
    base.protocol !== "https:" ||
    base.hostname !== "generativelanguage.googleapis.com" ||
    !/^\/v1(?:beta)?\/?$/.test(base.pathname) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error(
      "Google 专项 Agent 请使用官方 https://generativelanguage.googleapis.com/v1beta 地址。",
    );
  const key = await readKey(profile);
  if (!key) throw new Error(`${profile.name} 未找到密钥。`);
  const endpoint = `${base.href.replace(/\/$/, "")}/interactions`;
  const requestJSON = async (
    suffix: string,
    method: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Interaction> => {
    try {
      const response = await (options.fetch ?? fetch)(endpoint + suffix, {
        method,
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": key,
          "Api-Revision": "2026-05-20",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        // Never include provider bodies: errors can echo the prompt or authentication material.
        const error = Object.assign(
          new Error(
            `Google Agent 请求失败（HTTP ${response.status}）。请核对接口权限、模型和额度。`,
          ),
          { status: response.status },
        );
        await response.body?.cancel();
        throw error;
      }
      const raw: unknown = await response.json();
      const value = record(raw);
      if (
        typeof value.id !== "string" ||
        !/^[A-Za-z0-9_-]{1,2048}$/.test(value.id) ||
        typeof value.status !== "string"
      )
        throw new Error("Google Agent 返回了无法识别的任务状态。");
      return value as unknown as Interaction;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw new Error(safeModelError(error, key));
    }
  };
  const getResponse = async (request: ModelRequest): Promise<ModelResponse> => {
    const signal = request.signal;
    signal?.throwIfAborted();
    const input = googleAgentInput(request);
    if (!input.trim()) throw new Error("专项 Agent 没有收到工作目标。");
    const hash = createHash("sha256")
      .update(
        JSON.stringify([profile.modelId, input, request.systemInstructions]),
      )
      .digest("hex");
    let id = options.loadInteraction?.(hash);
    let result: Interaction | undefined;
    let terminal = false;
    const seen = new Set<string>();
    try {
      if (id) {
        result = await requestJSON(
          `/${encodeURIComponent(id)}`,
          "GET",
          undefined,
          signal,
        );
        if (["cancelled", "failed"].includes(result.status)) {
          result = undefined;
          id = undefined;
        }
      }
      if (!result) {
        // Creation is intentionally never retried: an uncertain network response may already have started work remotely.
        result = await requestJSON(
          "",
          "POST",
          {
            agent: profile.modelId,
            background: true,
            input: `${request.systemInstructions ?? ""}\n你在 Google 托管环境执行。无法直接操作 ytriple 本地文件或调用其本地工具；交付公开成果文本，由工作台保存。\n\n${input}\n\n请把最终成果全文放在回复中，以 Markdown 输出；不要仅返回远端文件路径。`,
            ...(profile.modelId.startsWith("antigravity")
              ? { environment: "remote" }
              : {
                  agent_config: { type: "deep-research", visualization: "off" },
                }),
          },
          signal,
        );
        id = result.id;
        options.saveInteraction?.(id, hash);
      }
      options.onProgress?.(`${profile.name}已接收任务，正在处理。`);
      while (true) {
        signal?.throwIfAborted();
        if (result.status === "completed") {
          terminal = true;
          break;
        }
        if (
          ["failed", "cancelled", "requires_action"].includes(result.status)
        ) {
          terminal = result.status !== "requires_action";
          throw new Error(
            result.status === "requires_action"
              ? "专项 Agent 请求了尚未接入的外部操作，已停止本次运行。"
              : `专项 Agent ${result.status === "cancelled" ? "已取消" : "执行失败"}，本地记录已保留。`,
          );
        }
        if (
          !["in_progress", "running", "queued", "pending"].includes(
            result.status,
          )
        )
          throw new Error("专项 Agent 返回未知状态，已停止轮询。");
        for (const step of items(result.steps).map(record)) {
          // Public activity categories only, never arbitrary arguments, thought text or provider metadata.
          const labels: Record<string, string> = {
            google_search_call: "正在检索公开资料",
            url_context_call: "正在阅读网页依据",
            code_execution_call: "正在远端核算与整理",
            model_output: "正在整理研究成果",
          };
          const label = labels[String(step.type)];
          const token = `${step.type}:${typeof step.id === "string" ? step.id : ""}`;
          if (label && !seen.has(token)) {
            seen.add(token);
            options.onProgress?.(label);
          }
        }
        await delay(options.pollMs ?? 5000, undefined, { signal });
        result = await requestJSON(
          `/${encodeURIComponent(id!)}`,
          "GET",
          undefined,
          signal,
        );
      }
      const content = googleAgentReport(result);
      if (!content)
        throw new Error("专项 Agent 已结束，但没有返回可保存的文本成果。");
      signal?.throwIfAborted();
      await options.onReport?.(content, result.id);
      const usage = result.usage ?? {};
      return {
        responseId: result.id,
        usage: new Usage({
          requests: 1,
          inputTokens: usage.total_input_tokens ?? 0,
          outputTokens: usage.total_output_tokens ?? 0,
          totalTokens: usage.total_tokens ?? 0,
        }),
        output: [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: content }],
          },
        ],
      };
    } catch (error) {
      if (id && !terminal) {
        try {
          const cancelled = await requestJSON(
            `/${encodeURIComponent(id)}/cancel`,
            "POST",
          );
          const confirmed = ["cancelled", "completed"].includes(
            cancelled.status,
          );
          options.onProgress?.(
            confirmed
              ? "Google 端执行已结束。"
              : "已请求远端取消，仍需确认最终状态。",
          );
          options.onCancel?.(confirmed);
        } catch {
          options.onProgress?.(
            "本地已停止等待；远端取消尚未确认，可继续任务核对状态。",
          );
          options.onCancel?.(false);
        }
      }
      throw error;
    }
  };
  return {
    getResponse,
    async *getStreamedResponse(request) {
      const response = await getResponse(request);
      yield {
        type: "response_done",
        response: {
          id: response.responseId ?? "",
          usage: response.usage,
          output: response.output as Extract<
            import("@openai/agents").ResponseStreamEvent,
            { type: "response_done" }
          >["response"]["output"],
        },
      };
    },
  };
}
