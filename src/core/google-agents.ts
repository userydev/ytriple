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
import {
  safePublicURL,
  type PublicProgressDetails,
  type PublicWebSource,
} from "../shared/progress.js";

export interface GoogleAgentOptions {
  onProgress?: (summary: string, details?: PublicProgressDetails) => void;
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

const publicText = (value: unknown, limit: number) =>
  typeof value === "string"
    ? value
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
        .trim()
        .slice(0, limit)
    : "";
function publicSource(
  value: unknown,
  status: PublicWebSource["status"],
): PublicWebSource | undefined {
  const data = record(value),
    url = safePublicURL(data.url);
  if (!url) return undefined;
  return {
    url,
    title: publicText(data.title, 200) || new URL(url).hostname,
    status,
    ...(publicText(data.snippet, 1600)
      ? { snippet: publicText(data.snippet, 1600) }
      : {}),
  };
}
const uniqueSources = (sources: PublicWebSource[]) => [
  ...new Map(sources.map((source) => [source.url, source])).values(),
];
/** Google documents ThoughtStep.summary as public summaries. Never read thought.text, signatures or arbitrary arguments. */
export function googleAgentProgress(
  value: Interaction,
): { summary: string; details: PublicProgressDetails }[] {
  const progress: { summary: string; details: PublicProgressDetails }[] = [];
  const steps = items(value.steps).map(record);
  if (!steps.some((step) => step.type === "thought"))
    steps.push(
      ...items(value.outputs)
        .map(record)
        .filter(
          (part) => part.type === "thought" && Array.isArray(part.summary),
        ),
    );
  if (
    !steps.some((step) => step.type === "model_output") &&
    items(value.outputs).length
  )
    steps.push({ type: "model_output", content: value.outputs });
  for (const step of steps) {
    if (step.type === "thought") {
      const summaries = items(step.summary)
        .map(record)
        .filter((part) => part.type === "text")
        .map((part) => publicText(part.text, 6000))
        .filter(Boolean);
      for (const detail of summaries)
        progress.push({
          summary: detail.split(/\n\s*\n/)[0].slice(0, 320),
          details: { progressKind: "analysis", detail },
        });
    } else if (step.type === "google_search_call") {
      const arguments_ = record(step.arguments);
      const queries = [
        ...new Set(
          [
            publicText(arguments_.query, 1000),
            ...items(arguments_.queries)
              .slice(0, 20)
              .map((query) => publicText(query, 1000)),
          ].filter(Boolean),
        ),
      ];
      progress.push({
        summary: queries.length
          ? `检索：${queries.join("；").slice(0, 140)}`
          : "正在检索公开资料",
        details: {
          progressKind: "search",
          ...(queries.length ? { queries } : {}),
        },
      });
    } else if (step.type === "google_search_result") {
      const webSources = items(step.result)
        .slice(0, 100)
        .map((item) =>
          publicSource(
            item,
            step.is_error === true ? "unavailable" : "searched",
          ),
        )
        .filter((source): source is PublicWebSource => Boolean(source));
      if (webSources.length)
        progress.push({
          summary: `获得 ${webSources.length} 项搜索结果`,
          details: { progressKind: "source", webSources },
        });
    } else if (step.type === "url_context_call") {
      const webSources = items(record(step.arguments).urls)
        .slice(0, 100)
        .map((url) => publicSource({ url }, "requested"))
        .filter((source): source is PublicWebSource => Boolean(source));
      progress.push({
        summary: "正在读取网页依据",
        details: { progressKind: "source", webSources },
      });
    } else if (step.type === "url_context_result") {
      const webSources = items(step.result)
        .slice(0, 100)
        .map((item) => {
          const source = record(item);
          return publicSource(
            source,
            step.is_error === true ||
              ["error", "paywall", "unsafe"].includes(String(source.status))
              ? "unavailable"
              : source.status === "success"
                ? "read"
                : "cited",
          );
        })
        .filter((source): source is PublicWebSource => Boolean(source));
      if (webSources.length)
        progress.push({
          summary: "网页核查结果已返回",
          details: { progressKind: "source", webSources },
        });
    } else if (step.type === "model_output") {
      const webSources = uniqueSources(
        items(step.content)
          .map(record)
          .filter((part) => part.type === "text")
          .flatMap((part) =>
            items(part.annotations)
              .map(record)
              .filter((annotation) => annotation.type === "url_citation")
              .map((annotation) => publicSource(annotation, "cited")),
          )
          .filter((source): source is PublicWebSource => Boolean(source))
          .slice(0, 100),
      );
      if (webSources.length)
        progress.push({
          summary: `报告包含 ${webSources.length} 项网页引用`,
          details: { progressKind: "source", webSources },
        });
    } else if (step.type === "code_execution_call")
      progress.push({
        summary: "正在远端核算与整理",
        details: { progressKind: "status" },
      });
  }
  return progress;
}

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

/** Incremental SSE decoding with bounded frames; no raw frame/body is returned in an error. */
async function readGoogleEvents(
  response: Response,
  signal: AbortSignal,
  onEvent: (
    event: Record<string, unknown>,
    eventId?: string,
    eventName?: string,
  ) => boolean | void,
) {
  if (!response.body) throw new Error("Google 进度流没有返回正文。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "",
    data = "",
    eventId: string | undefined,
    eventName: string | undefined;
  let frameSize = 0,
    stopped = false;
  const emit = () => {
    if (data.trim() && data.trim() !== "[DONE]") {
      let value: unknown;
      try {
        value = JSON.parse(data);
      } catch {
        throw new Error("Google 进度流返回了无法解析的事件。");
      }
      stopped = onEvent(record(value), eventId, eventName) === true;
    }
    data = "";
    eventId = undefined;
    eventName = undefined;
    frameSize = 0;
  };
  const line = (input: string) => {
    const value = input.endsWith("\r") ? input.slice(0, -1) : input;
    if (!value) {
      emit();
      return;
    }
    if (value.startsWith(":")) return;
    frameSize += value.length;
    if (frameSize > 1_000_000)
      throw new Error("Google 单条进度事件过大，改为核对任务状态。");
    const separator = value.indexOf(":"),
      field = separator < 0 ? value : value.slice(0, separator);
    const content =
      separator < 0 ? "" : value.slice(separator + 1).replace(/^ /, "");
    if (field === "data") data += (data ? "\n" : "") + content;
    else if (field === "event") eventName = content.slice(0, 100);
    else if (
      field === "id" &&
      content.length <= 2048 &&
      !content.includes("\0")
    )
      eventId = content;
  };
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (!stopped) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      if (buffer.length > 1_000_000)
        throw new Error("Google 进度流片段过大，改为核对任务状态。");
      let newline;
      while (!stopped && (newline = buffer.indexOf("\n")) >= 0) {
        line(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
      if (chunk.done && !stopped) {
        if (buffer) line(buffer);
        if (!stopped) emit();
        break;
      }
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
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
  const requestHTTP = async (
    suffix: string,
    method: string,
    body?: unknown,
    signal?: AbortSignal,
    stream = false,
  ) => {
    try {
      const httpSignal = signal
        ? AbortSignal.any([
            signal,
            AbortSignal.timeout(stream ? 60_000 : 30_000),
          ])
        : AbortSignal.timeout(stream ? 60_000 : 30_000);
      const response = await (options.fetch ?? fetch)(endpoint + suffix, {
        method,
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": key,
          "Api-Revision": "2026-05-20",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: httpSignal,
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
      return { response, signal: httpSignal };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw new Error(safeModelError(error, key));
    }
  };
  const parseInteraction = (raw: unknown): Interaction => {
    const value = record(raw);
    if (
      typeof value.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,2048}$/.test(value.id) ||
      typeof value.status !== "string"
    )
      throw new Error("Google Agent 返回了无法识别的任务状态。");
    return value as unknown as Interaction;
  };
  const readInteraction = async (response: Response, signal?: AbortSignal) => {
    try {
      return parseInteraction(await response.json());
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof SyntaxError)
        throw new Error("Google Agent 返回了无法解析的任务状态。");
      throw new Error(safeModelError(error, key));
    }
  };
  const requestJSON = async (
    suffix: string,
    method: string,
    body?: unknown,
    signal?: AbortSignal,
  ) => {
    const received = await requestHTTP(suffix, method, body, signal);
    return readInteraction(received.response, signal);
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
    const publishedAnalysis = new Set<string>();
    // Only Deep Research explicitly enables Google's public auto-summary stream.
    // Other hosted agents retain their existing polling contract.
    const publicAutoSummaries = profile.modelId.startsWith("deep-research");
    let streaming = publicAutoSummaries,
      streamFailures = 0;
    let lastEventId: string | undefined,
      announced = false,
      callbackFailure: unknown;
    const seenEvents = new Set<string>();
    let streamActivity = 0;
    const pendingSummaries = new Map<number, string>();
    const publish = (
      progress: ReturnType<typeof googleAgentProgress>[number],
    ) => {
      if (
        progress.details.progressKind === "analysis" &&
        progress.details.detail
      ) {
        let detail = progress.details.detail;
        // Canonical snapshots can concatenate previously streamed summary items. Remove
        // exact, complete blocks only; an identical heading never suppresses new analysis.
        for (const previous of publishedAnalysis) {
          let start = detail.indexOf(previous);
          while (start >= 0) {
            const before = detail.slice(0, start),
              after = detail.slice(start + previous.length);
            if (
              (!before || /\n[ \t]*\n\s*$/.test(before)) &&
              (!after || /^\s*\n[ \t]*\n/.test(after))
            ) {
              detail = before + after;
              start = detail.indexOf(previous, before.length);
            } else start = detail.indexOf(previous, start + previous.length);
          }
        }
        detail = detail.trim();
        if (!detail) return;
        progress = {
          summary: detail.split(/\n\s*\n/)[0].slice(0, 320),
          details: { ...progress.details, detail },
        };
      }
      const token = createHash("sha256")
        .update(JSON.stringify(progress))
        .digest("hex");
      if (seen.has(token)) return;
      try {
        options.onProgress?.(progress.summary, progress.details);
      } catch (error) {
        callbackFailure = error;
        throw error;
      }
      seen.add(token);
      if (
        progress.details.progressKind === "analysis" &&
        progress.details.detail
      )
        publishedAnalysis.add(progress.details.detail);
    };
    const publishSteps = (steps: unknown[]) => {
      for (const progress of googleAgentProgress({
        id: id ?? "pending",
        status: "in_progress",
        steps,
      }))
        publish(progress);
    };
    const announce = () => {
      if (announced) return;
      try {
        options.onProgress?.(`${profile.name}已接收任务，正在处理。`);
      } catch (error) {
        callbackFailure = error;
        throw error;
      }
      announced = true;
    };
    const adopt = (value: Interaction) => {
      if (id && value.id !== id)
        throw new Error("Google 进度流的任务标识不一致。");
      const isNew = !id;
      id = value.id;
      result = value;
      // Persist before callbacks: a pause during the first event must still cancel this interaction.
      if (isNew) {
        try {
          options.saveInteraction?.(id, hash);
        } catch (error) {
          callbackFailure = error;
          throw error;
        }
      }
      announce();
    };
    const flushSummary = (index: number) => {
      const text = pendingSummaries.get(index);
      if (!text) return;
      pendingSummaries.delete(index);
      publishSteps([{ type: "thought", summary: [{ type: "text", text }] }]);
    };
    const flushSummaries = () => {
      for (const index of pendingSummaries.keys()) flushSummary(index);
    };
    const onStreamEvent = (
      event: Record<string, unknown>,
      frameId?: string,
      eventName?: string,
    ) => {
      const token =
        typeof event.event_id === "string" ? event.event_id : frameId;
      if (token && token.length <= 2048 && !/[\u0000-\u001f]/.test(token)) {
        lastEventId = token;
        if (seenEvents.has(token)) return;
        if (seenEvents.size >= 20_000) seenEvents.clear();
        seenEvents.add(token);
      }
      const type = event.event_type ?? eventName;
      if (type === "interaction.created") {
        adopt(parseInteraction(event.interaction));
        return;
      }
      if (!id) return;
      if (
        ["interaction.status_update", "interaction.completed"].includes(
          String(type),
        )
      ) {
        const value = record(event.interaction);
        const eventInteractionId = value.id ?? event.interaction_id;
        if (eventInteractionId !== undefined && eventInteractionId !== id)
          throw new Error("Google 进度流的任务标识不一致。");
        const status =
          value.status ??
          event.status ??
          (type === "interaction.completed" ? "completed" : undefined);
        if (typeof status === "string") result = { id, status };
        if (
          ["completed", "failed", "cancelled", "requires_action"].includes(
            String(status),
          )
        ) {
          flushSummaries();
          return true;
        }
      } else if (type === "error" || type === "interaction.error") {
        // Provider error payloads can echo private inputs. Recover through a canonical GET instead.
        throw new Error("Google 进度流中断，正在核对远端状态。");
      } else if (type === "step.start") {
        publishSteps([event.step]);
      } else if (type === "step.stop") {
        flushSummary(typeof event.index === "number" ? event.index : -1);
      } else if (type === "step.delta") {
        const delta = record(event.delta),
          index = typeof event.index === "number" ? event.index : -1;
        // Actual new step increments prove the connection was active, including output
        // still being assembled. Heartbeats and replayed event IDs do not count.
        if (
          [
            "thought_summary",
            "text",
            "image",
            "google_search_call",
            "google_search_result",
            "url_context_call",
            "url_context_result",
            "code_execution_call",
          ].includes(String(delta.type)) ||
          (publicAutoSummaries && delta.type === "thought")
        )
          streamActivity++;
        if (delta.type === "thought_summary") {
          // Interactions API: a new public summary item, not a raw thought/signature delta.
          const content = record(delta.content);
          if (content.type === "text")
            publishSteps([{ type: "thought", summary: [content] }]);
        } else if (
          publicAutoSummaries &&
          delta.type === "thought" &&
          typeof delta.text === "string"
        ) {
          // Deep Research's documented auto-summary SSE dialect. This exception is local to
          // step.delta in a stream requested with thinking_summaries:auto; ThoughtStep.text stays excluded.
          const text =
            (pendingSummaries.get(index) ?? "") +
            delta.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
          pendingSummaries.set(index, text.slice(0, 6000));
          if (
            text.length >= 6000 ||
            (text.length >= 120 && /(?:\n\s*\n|[.!?。！？]\s*)$/.test(text))
          )
            flushSummary(index);
        } else if (
          [
            "google_search_call",
            "google_search_result",
            "url_context_call",
            "url_context_result",
            "code_execution_call",
          ].includes(String(delta.type))
        ) {
          publishSteps([delta]);
        } else if (delta.type === "text_annotation_delta") {
          const annotation = record(delta.annotation);
          if (annotation.type === "url_citation")
            publishSteps([
              {
                type: "model_output",
                content: [{ type: "text", annotations: [annotation] }],
              },
            ]);
        }
        // Final text/image deltas and thought signatures are neither progress nor archived output.
      }
    };
    const receive = async (
      received: Awaited<ReturnType<typeof requestHTTP>>,
    ) => {
      if (
        !received.response.headers
          .get("content-type")
          ?.includes("text/event-stream")
      ) {
        streaming = false;
        adopt(await readInteraction(received.response, signal));
        return;
      }
      const activityBefore = streamActivity;
      try {
        await readGoogleEvents(
          received.response,
          received.signal,
          onStreamEvent,
        );
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (callbackFailure !== undefined)
          throw new Error(safeModelError(error, key));
        if (!id)
          throw new Error(
            "Google 进度流在返回任务标识前中断；为避免重复执行，未重新创建任务。",
          );
      }
      // A bounded HTTP stream deliberately rotates after 60s. A connection that
      // delivered new steps is healthy; do not cumulatively downgrade long research.
      streamFailures = streamActivity > activityBefore ? 0 : streamFailures + 1;
      if (streamFailures >= 2) streaming = false;
      if (!id)
        throw new Error(
          "Google 进度流未返回任务标识；为避免重复执行，未重新创建任务。",
        );
      // A terminal stream event can contain metadata only. GET is also the recovery path
      // after a dropped stream; canonical final text is archived exactly once below.
      adopt(
        await requestJSON(
          `/${encodeURIComponent(id)}`,
          "GET",
          undefined,
          signal,
        ),
      );
    };
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
        } else announce();
      }
      if (!result) {
        // Creation is intentionally never retried: an uncertain network response may already have started work remotely.
        await receive(
          await requestHTTP(
            "",
            "POST",
            {
              agent: profile.modelId,
              background: true,
              ...(streaming ? { stream: true } : {}),
              input: `${request.systemInstructions ?? ""}\n你在 Google 托管环境执行。无法直接操作 ytriple 本地文件或调用其本地工具；交付公开成果文本，由工作台保存。\n\n${input}\n\n请把最终成果全文放在回复中，以 Markdown 输出；不要仅返回远端文件路径。`,
              ...(profile.modelId.startsWith("antigravity")
                ? { environment: "remote" }
                : {
                    agent_config: {
                      type: "deep-research",
                      visualization: "off",
                      thinking_summaries: "auto",
                    },
                  }),
            },
            signal,
            streaming,
          ),
        );
      }
      while (true) {
        signal?.throwIfAborted();
        if (!result) throw new Error("Google Agent 未返回可核对的任务状态。");
        // The final poll can contain summaries and sources that never appeared in earlier snapshots.
        for (const progress of googleAgentProgress(result)) publish(progress);
        if (result.status === "completed") {
          flushSummaries();
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
        await delay(options.pollMs ?? 5000, undefined, { signal });
        if (streaming) {
          const query = new URLSearchParams({
            stream: "true",
            ...(lastEventId ? { last_event_id: lastEventId } : {}),
          });
          try {
            await receive(
              await requestHTTP(
                `/${encodeURIComponent(id!)}?${query}`,
                "GET",
                undefined,
                signal,
                true,
              ),
            );
          } catch (error) {
            if (signal?.aborted || callbackFailure !== undefined) throw error;
            // Unsupported/temporarily unavailable streaming still permits the same saved job to finish.
            streaming = false;
            result = await requestJSON(
              `/${encodeURIComponent(id!)}`,
              "GET",
              undefined,
              signal,
            );
          }
        } else
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
