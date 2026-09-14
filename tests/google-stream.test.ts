import test from "node:test";
import assert from "node:assert/strict";
import { Agent, Runner } from "@openai/agents";
import type { ModelProfile } from "../src/shared/types.js";
import {
  createGoogleAgentModel,
  googleAgentProgress,
} from "../src/core/google-agents.js";

const profile: ModelProfile = {
  id: "synthetic-stream",
  name: "Research",
  provider: "gemini",
  protocol: "google",
  execution: "google-agent",
  modelId: "deep-research-preview-04-2026",
  baseURL: "https://generativelanguage.googleapis.com/v1beta",
  apiKeyEnv: "SYNTHETIC",
  hasKey: true,
  status: "untested",
};
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
const frame = (event: unknown, id?: string) =>
  `${id ? `id: ${id}\r\n` : ""}data: ${JSON.stringify(event)}\r\n\r\n`;
const event = (
  event_type: string,
  event_id: string,
  fields: Record<string, unknown> = {},
) => ({ event_type, event_id, ...fields });
const created = (id: string) =>
  event("interaction.created", "e0", {
    interaction: { id, status: "in_progress" },
  });
const completed = (id: string) =>
  event("interaction.completed", "end", {
    interaction: { id, status: "completed" },
  });
const final = (id: string) =>
  json({
    id,
    status: "completed",
    steps: [
      {
        type: "model_output",
        content: [{ type: "text", text: "Canonical public report" }],
      },
    ],
  });
function stream(text: string, fail = false, onCancel?: () => void) {
  const bytes = new TextEncoder().encode(text);
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < bytes.length) {
          // Split JSON, CRLF and multibyte characters across HTTP chunks.
          controller.enqueue(bytes.slice(index, index + 7));
          index += 7;
        } else if (fail) controller.error(new Error("PRIVATE_TRANSPORT_BODY"));
        else controller.close();
      },
      cancel() {
        onCancel?.();
      },
    }),
    { headers: { "content-type": "text/event-stream; charset=utf-8" } },
  );
}
const run = async (
  model: Awaited<ReturnType<typeof createGoogleAgentModel>>,
  signal?: AbortSignal,
) =>
  new Runner({ tracingDisabled: true }).run(
    new Agent({ name: "Synthetic research", model }),
    "Synthetic public question",
    { signal },
  );

test("Deep Research SSE publishes public summaries and source evidence before completion; canonical report is saved once", async () => {
  const progress: ReturnType<typeof googleAgentProgress> = [];
  const calls: { method?: string; url: string; body?: unknown }[] = [];
  let saved = "",
    reports = 0;
  const summary = event("step.delta", "summary-1", {
    index: 0,
    delta: {
      type: "thought_summary",
      content: {
        type: "text",
        text: "先比较官方方法，核对并发写入的限制。",
        privateData: "PRIVATE_METADATA",
      },
    },
  });
  const model = await createGoogleAgentModel(profile, () => "SYNTHETIC_KEY", {
    pollMs: 1,
    saveInteraction: (id) => {
      saved = id;
    },
    onProgress: (summary, details) => {
      if (details) {
        assert.equal(saved, "i_stream");
        assert.equal(
          calls.length,
          1,
          "public progress must arrive before final canonical GET",
        );
        progress.push({ summary, details });
      }
    },
    onReport: async (text, id) => {
      reports++;
      assert.equal(text, "Canonical public report");
      assert.equal(id, saved);
    },
    fetch: async (url, init) => {
      calls.push({
        url: String(url),
        method: init?.method,
        body: init?.body && JSON.parse(String(init.body)),
      });
      if (calls.length > 1) return final("i_stream");
      return stream(
        ": keepalive\r\n\r\n" +
          [
            created("i_stream"),
            event("step.start", "private-start", {
              index: 0,
              step: {
                type: "thought",
                text: "PRIVATE_RAW",
                signature: "PRIVATE_SIGNATURE",
              },
            }),
            summary,
            summary,
            event("step.delta", "private-delta", {
              index: 0,
              delta: {
                type: "thought_signature",
                signature: "PRIVATE_SIGNATURE",
              },
            }),
            event("step.delta", "legacy-summary", {
              index: 1,
              delta: {
                type: "thought",
                text: "公开摘要：对照文档说明与限制。",
                signature: "PRIVATE_SIGNATURE",
              },
            }),
            event("step.stop", "legacy-stop", { index: 1 }),
            event("step.delta", "search", {
              index: 2,
              delta: {
                type: "google_search_call",
                arguments: {
                  queries: ["site:sqlite.org WAL concurrency"],
                  privateData: "PRIVATE_ARGUMENT",
                },
              },
            }),
            event("step.delta", "search-result", {
              index: 3,
              delta: {
                type: "google_search_result",
                result: [
                  {
                    url: "https://sqlite.org/wal.html",
                    title: "WAL",
                    snippet: "Public search excerpt",
                    privateData: "PRIVATE_SOURCE",
                  },
                ],
                search_suggestions: "PRIVATE_HTML",
              },
            }),
            event("step.delta", "url-call", {
              index: 4,
              delta: {
                type: "url_context_call",
                arguments: {
                  urls: [
                    "https://sqlite.org/wal.html",
                    "javascript:PRIVATE_UNSAFE",
                  ],
                },
              },
            }),
            event("step.delta", "url-result", {
              index: 5,
              delta: {
                type: "url_context_result",
                result: [
                  { url: "https://sqlite.org/wal.html", status: "success" },
                  { url: "https://example.com/locked", status: "paywall" },
                ],
              },
            }),
            event("step.delta", "not-report", {
              index: 6,
              delta: { type: "text", text: "Do not archive partial output" },
            }),
            completed("i_stream"),
          ]
            .map((value) => frame(value))
            .join(""),
      );
    },
  });
  const result = await run(model);
  assert.equal(result.finalOutput, "Canonical public report");
  assert.equal(reports, 1);
  assert.equal((calls[0]!.body as Record<string, unknown>).stream, true);
  assert.equal(
    (calls[0]!.body as { agent_config: { thinking_summaries: string } })
      .agent_config.thinking_summaries,
    "auto",
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    ["POST", "GET"],
  );
  assert.equal(
    progress.filter((entry) => entry.details.progressKind === "analysis")
      .length,
    2,
  );
  assert.ok(
    progress.some((entry) =>
      entry.details.queries?.includes("site:sqlite.org WAL concurrency"),
    ),
  );
  assert.ok(
    progress.some((entry) =>
      entry.details.webSources?.some((source) => source.status === "read"),
    ),
  );
  assert.ok(
    progress.some((entry) =>
      entry.details.webSources?.some(
        (source) => source.status === "unavailable",
      ),
    ),
  );
  assert.doesNotMatch(JSON.stringify(progress), /PRIVATE|partial output/);
});

test("a dropped SSE resumes the checkpoint and cursor through GET without creating another paid interaction", async () => {
  const calls: { url: string; method?: string }[] = [],
    progress: string[] = [];
  let saves = 0,
    reports = 0;
  const publicEvent = event("step.delta", "cursor with / chars", {
    index: 0,
    delta: {
      type: "thought_summary",
      content: { type: "text", text: "先核对官方定义。" },
    },
  });
  const model = await createGoogleAgentModel(profile, () => "key", {
    pollMs: 1,
    saveInteraction: () => {
      saves++;
    },
    onProgress: (summary) => progress.push(summary),
    onReport: async () => {
      reports++;
    },
    fetch: async (url, init) => {
      calls.push({ url: String(url), method: init?.method });
      if (calls.length === 1)
        return stream(frame(created("i_resume")) + frame(publicEvent), true);
      if (calls.length === 2)
        return json({ id: "i_resume", status: "in_progress" });
      if (calls.length === 3) {
        const parsed = new URL(String(url));
        assert.equal(parsed.searchParams.get("stream"), "true");
        assert.equal(
          parsed.searchParams.get("last_event_id"),
          "cursor with / chars",
        );
        return stream(
          frame(publicEvent) +
            frame(
              event("step.delta", "next", {
                index: 1,
                delta: {
                  type: "thought_summary",
                  content: { type: "text", text: "已完成来源对照。" },
                },
              }),
            ) +
            frame(completed("i_resume")),
        );
      }
      return final("i_resume");
    },
  });
  await run(model);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["POST", "GET", "GET", "GET"],
  );
  assert.equal(saves, 1);
  assert.equal(reports, 1);
  assert.equal(
    progress.filter((text) => text === "先核对官方定义。").length,
    1,
  );
  assert.ok(progress.includes("已完成来源对照。"));
  assert.doesNotMatch(JSON.stringify(progress), /PRIVATE/);
});

test("pausing an active progress stream closes its reader and cancels the checkpointed interaction", async () => {
  const controller = new AbortController(),
    calls: string[] = [];
  let checkpoint = "",
    cancelled = false,
    readerClosed = false,
    reports = 0;
  const model = await createGoogleAgentModel(profile, () => "key", {
    saveInteraction: (id) => {
      checkpoint = id;
    },
    onReport: async () => {
      reports++;
    },
    onProgress: (summary, details) => {
      if (details?.progressKind === "analysis") controller.abort();
    },
    onCancel: (confirmed) => {
      cancelled = confirmed;
    },
    fetch: async (url) => {
      calls.push(String(url));
      if (String(url).endsWith("/cancel"))
        return json({ id: "i_cancel_stream", status: "cancelled" });
      return stream(
        frame(created("i_cancel_stream")) +
          frame(
            event("step.delta", "public", {
              index: 0,
              delta: {
                type: "thought_summary",
                content: { type: "text", text: "准备核对公开资料。" },
              },
            }),
          ) +
          frame(completed("i_cancel_stream")),
        false,
        () => {
          readerClosed = true;
        },
      );
    },
  });
  await assert.rejects(run(model, controller.signal));
  assert.equal(checkpoint, "i_cancel_stream");
  assert.equal(cancelled, true);
  assert.equal(readerClosed, true);
  assert.equal(reports, 0);
  assert.equal(calls.length, 2);
  assert.ok(calls[1]!.endsWith("/i_cancel_stream/cancel"));
});

test("repeated stream failures fall back to polling the same interaction", async () => {
  const calls: string[] = [];
  let reports = 0;
  const model = await createGoogleAgentModel(profile, () => "key", {
    pollMs: 1,
    onReport: async () => {
      reports++;
    },
    fetch: async (url, init) => {
      calls.push(`${init?.method} ${url}`);
      if (calls.length === 1) return stream(frame(created("i_fallback")), true);
      if (calls.length === 2 || calls.length === 4)
        return json({ id: "i_fallback", status: "in_progress" });
      if (calls.length === 3) return stream(": disconnect\n\n", true);
      return final("i_fallback");
    },
  });
  await run(model);
  assert.equal(calls.length, 5);
  assert.equal(calls.filter((call) => call.startsWith("POST")).length, 1);
  assert.ok(calls[2]!.includes("stream=true"));
  assert.ok(!calls[4]!.includes("stream=true"));
  assert.equal(reports, 1);
});

test("an uncertain stream before an interaction ID is never retried and never exposes its error body", async () => {
  let calls = 0;
  const model = await createGoogleAgentModel(
    profile,
    () => "PRIVATE_TRANSPORT_BODY",
    {
      fetch: async () => {
        calls++;
        return stream("", true);
      },
    },
  );
  await assert.rejects(
    run(model),
    (error) =>
      error instanceof Error &&
      !error.message.includes("PRIVATE_TRANSPORT_BODY"),
  );
  assert.equal(calls, 1);
});

test("an existing running checkpoint can reconnect its event stream without a new POST", async () => {
  const calls: { method?: string; url: string }[] = [];
  const model = await createGoogleAgentModel(profile, () => "key", {
    pollMs: 1,
    loadInteraction: () => "i_existing",
    saveInteraction: () =>
      assert.fail("existing interaction must keep its checkpoint"),
    fetch: async (url, init) => {
      calls.push({ url: String(url), method: init?.method });
      if (calls.length === 1)
        return json({ id: "i_existing", status: "in_progress" });
      if (calls.length === 2) return stream(frame(completed("i_existing")));
      return final("i_existing");
    },
  });
  await run(model);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["GET", "GET", "GET"],
  );
  assert.equal(new URL(calls[1]!.url).searchParams.get("stream"), "true");
});

test("legacy outputs keep explicit public summary arrays and deduplicate repeated citations", () => {
  const progress = googleAgentProgress({
    id: "legacy",
    status: "completed",
    outputs: [
      {
        type: "thought",
        text: "PRIVATE_RAW",
        summary: [{ type: "text", text: "可公开的方法说明。" }],
      },
      {
        type: "text",
        text: "Report",
        annotations: Array.from({ length: 12 }, () => ({
          type: "url_citation",
          url: "https://sqlite.org/wal.html",
          title: "WAL",
        })),
      },
    ],
  });
  assert.equal(
    progress.filter((entry) => entry.details.progressKind === "analysis")
      .length,
    1,
  );
  assert.equal(
    progress.find((entry) => entry.details.progressKind === "source")?.details
      .webSources?.length,
    1,
  );
  assert.doesNotMatch(JSON.stringify(progress), /PRIVATE/);
});

test("active stream rotations reset the failure count and keep resuming via GET even after multiple interruptions", async () => {
  const calls: { url: string; method?: string }[] = [],
    progress: string[] = [];
  let reports = 0;
  const summary = (index: number) =>
    event("step.delta", `active-${index}`, {
      index,
      delta: {
        type: "thought_summary",
        content: { type: "text", text: `公开分析阶段 ${index}。` },
      },
    });
  const model = await createGoogleAgentModel(profile, () => "key", {
    pollMs: 1,
    onProgress: (text) => progress.push(text),
    onReport: async () => {
      reports++;
    },
    fetch: async (url, init) => {
      calls.push({ url: String(url), method: init?.method });
      if (calls.length === 1)
        return stream(frame(created("i_active")) + frame(summary(1)), true);
      if (calls.length === 2 || calls.length === 4)
        return json({ id: "i_active", status: "in_progress" });
      if (calls.length === 3) return stream(frame(summary(2)), true);
      if (calls.length === 5) {
        const parsed = new URL(String(url));
        assert.equal(
          parsed.searchParams.get("stream"),
          "true",
          "active earlier rotations must not cumulatively force polling",
        );
        assert.equal(parsed.searchParams.get("last_event_id"), "active-2");
        return stream(frame(summary(3)) + frame(completed("i_active")));
      }
      return final("i_active");
    },
  });
  await run(model);
  assert.equal(calls.length, 6);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["POST", "GET", "GET", "GET", "GET", "GET"],
  );
  assert.equal(
    progress.filter((text) => text.startsWith("公开分析阶段")).length,
    3,
  );
  assert.equal(reports, 1);
});

test("canonical aggregate summaries omit already streamed full blocks while retaining new content with identical headings", async () => {
  const details: string[] = [];
  const heading = "方法说明".repeat(100);
  const earlier = `${heading}\n\n先比较文档中的锁定约束。`;
  const newer = `${heading}\n\n补充：需要区分实验性扩展与标准 WAL 行为。`;
  let calls = 0;
  const model = await createGoogleAgentModel(profile, () => "key", {
    onProgress: (_summary, detail) => {
      if (detail?.progressKind === "analysis") details.push(detail.detail!);
    },
    fetch: async () => {
      calls++;
      if (calls === 1)
        return stream(
          frame(created("i_aggregate")) +
            frame(
              event("step.delta", "first", {
                index: 0,
                delta: {
                  type: "thought_summary",
                  content: { type: "text", text: earlier },
                },
              }),
            ) +
            frame(completed("i_aggregate")),
        );
      return json({
        id: "i_aggregate",
        status: "completed",
        steps: [
          {
            type: "thought",
            text: "PRIVATE",
            summary: [
              { type: "text", text: earlier },
              { type: "text", text: `${earlier}\n\n${newer}` },
            ],
          },
          {
            type: "model_output",
            content: [{ type: "text", text: "Canonical public report" }],
          },
        ],
      });
    },
  });
  await run(model);
  assert.deepEqual(
    details,
    [earlier, newer],
    "compare complete details, never the 320-character display title",
  );
});

test("SSE event names, frame IDs and multiline data work without event_type fields", async () => {
  const progress: string[] = [];
  let calls = 0;
  const model = await createGoogleAgentModel(profile, () => "key", {
    onProgress: (text) => progress.push(text),
    fetch: async () => {
      if (++calls > 1) return final("i_multiline");
      return stream(
        frame(created("i_multiline")) +
          'event: step.delta\r\nid: multiline-summary\r\ndata: {"index": 0,\r\ndata: "delta": {"type": "thought_summary", "content": {"type": "text", "text": "跨片段中文公开摘要。"}}}\r\n\r\n' +
          frame(completed("i_multiline")),
      );
    },
  });
  await run(model);
  assert.ok(progress.includes("跨片段中文公开摘要。"));
  assert.equal(calls, 2);
});

test("the Deep Research auto-summary exception does not expose ordinary thought text from another hosted agent", async () => {
  const progress: string[] = [];
  let calls = 0;
  const model = await createGoogleAgentModel(
    { ...profile, modelId: "antigravity-test" },
    () => "key",
    {
      onProgress: (text) => progress.push(text),
      fetch: async (_url, init) => {
        if (++calls > 1) return final("i_other");
        assert.equal(JSON.parse(String(init?.body)).stream, undefined);
        return stream(
          frame(created("i_other")) +
            frame(
              event("step.delta", "private", {
                index: 0,
                delta: { type: "thought", text: "PRIVATE_RAW_THOUGHT" },
              }),
            ) +
            frame(event("step.stop", "stop", { index: 0 })) +
            frame(completed("i_other")),
        );
      },
    },
  );
  await run(model);
  assert.doesNotMatch(JSON.stringify(progress), /PRIVATE/);
});
