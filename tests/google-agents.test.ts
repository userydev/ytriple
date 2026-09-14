import test from "node:test";
import assert from "node:assert/strict";
import { Agent, Runner } from "@openai/agents";
import type { ModelProfile } from "../src/shared/types.js";
import {
  createGoogleAgentModel,
  googleAgentReport,
  googleAgentInput,
} from "../src/core/google-agents.js";
const profile: ModelProfile = {
  id: "synthetic-research",
  name: "Research",
  provider: "gemini",
  protocol: "google",
  execution: "google-agent",
  baseURL: "https://generativelanguage.googleapis.com/v1beta",
  modelId: "deep-research-preview-04-2026",
  apiKeyEnv: "TEST",
  hasKey: true,
  status: "untested",
};
const reply = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
test("hosted research polls the agent endpoint, forwards no local tools, and persists only public report", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const progress: string[] = [];
  let report = "",
    saved = "";
  const model = await createGoogleAgentModel(profile, () => "test-secret", {
    pollMs: 1,
    onProgress: (s) => progress.push(s),
    saveInteraction: (id) => {
      saved = id;
    },
    onReport: async (s) => {
      report = s;
    },
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return calls.length === 1
        ? reply({
            id: "i_1",
            status: "in_progress",
            steps: [
              { type: "thought", text: "PRIVATE" },
              {
                type: "google_search_call",
                id: "s_1",
                arguments: { secret: "NEVER" },
              },
            ],
          })
        : reply({
            id: "i_1",
            status: "completed",
            steps: [
              { type: "thought", text: "PRIVATE" },
              {
                type: "model_output",
                content: [
                  { type: "text", text: "# Report\nPublic answer" },
                  { type: "thought", text: "PRIVATE" },
                ],
              },
            ],
            usage: {
              total_input_tokens: 10,
              total_output_tokens: 8,
              total_tokens: 18,
            },
          });
    },
  });
  const result = await new Runner({ tracingDisabled: true }).run(
    new Agent({ name: "research", model }),
    "Synthetic goal",
  );
  assert.equal(String(result.finalOutput), "# Report\nPublic answer");
  assert.equal(report, String(result.finalOutput));
  assert.equal(saved, "i_1");
  const body = JSON.parse(String(calls[0]!.init!.body));
  assert.equal(body.agent, profile.modelId);
  assert.equal(body.background, true);
  assert.equal(body.model, undefined);
  assert.equal(body.system_instruction, undefined);
  assert.equal(body.tools, undefined);
  assert.ok(!JSON.stringify(progress).includes("PRIVATE"));
  assert.ok(!JSON.stringify(progress).includes("NEVER"));
  assert.equal(
    calls[1]!.url,
    "https://generativelanguage.googleapis.com/v1beta/interactions/i_1",
  );
});
test("pause cancels a remote running interaction; completed checkpoint reuses GET without POST", async () => {
  const controller = new AbortController();
  const methods: string[] = [];
  const model = await createGoogleAgentModel(profile, () => "secret", {
    pollMs: 100,
    onProgress: (s) => {
      if (s.includes("已接收")) controller.abort();
    },
    fetch: async (_url, init) => {
      methods.push(init?.method ?? "");
      return reply({
        id: "i_cancel",
        status: methods.length === 1 ? "in_progress" : "cancelled",
      });
    },
  });
  await assert.rejects(
    new Runner({ tracingDisabled: true }).run(
      new Agent({ name: "probe", model }),
      "synthetic",
      { signal: controller.signal },
    ),
  );
  assert.deepEqual(methods, ["POST", "POST"]);
  let calls = 0;
  let reportCalls = 0;
  const restored = await createGoogleAgentModel(profile, () => "secret", {
    loadInteraction: () => "i_done",
    onReport: async () => {
      reportCalls++;
    },
    fetch: async (_url, init) => {
      calls++;
      assert.equal(init?.method, "GET");
      return reply({
        id: "i_done",
        status: "completed",
        steps: [
          {
            type: "model_output",
            content: [{ type: "text", text: "saved report" }],
          },
        ],
      });
    },
  });
  const result = await new Runner({ tracingDisabled: true }).run(
    new Agent({ name: "restored", model: restored }),
    "synthetic",
  );
  assert.equal(result.finalOutput, "saved report");
  assert.equal(calls, 1);
  assert.equal(reportCalls, 1);
});
test("Google adapter excludes private fields, rejects credential forwarding, and never retries uncertain creation", async () => {
  assert.equal(
    googleAgentReport({
      id: "x",
      status: "completed",
      steps: [
        { type: "thought", content: [{ type: "text", text: "PRIVATE" }] },
      ],
    }),
    "",
  );
  assert.equal(
    googleAgentInput({
      input: [
        {
          type: "reasoning",
          content: [{ type: "input_text", text: "PRIVATE" }],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: "PUBLIC" }],
          providerData: { secret: "PRIVATE" },
        },
      ],
    } as never),
    "user: PUBLIC",
  );
  await assert.rejects(
    createGoogleAgentModel(
      { ...profile, baseURL: "https://example.com/v1beta" },
      () => "secret",
    ),
    /官方/,
  );
  let calls = 0;
  const model = await createGoogleAgentModel(profile, () => "secret", {
    fetch: async () => {
      calls++;
      throw new Error("failed secret");
    },
  });
  await assert.rejects(
    new Runner({ tracingDisabled: true }).run(
      new Agent({ name: "probe", model }),
      "synthetic",
    ),
    (error) => error instanceof Error && !error.message.includes("secret"),
  );
  assert.equal(calls, 1);
});

test("public URL citation annotations are retained without hidden metadata or unsafe links", () => {
  const result = googleAgentReport({
    id: "i",
    status: "completed",
    steps: [
      {
        type: "model_output",
        content: [
          {
            type: "text",
            text: "Report",
            annotations: [
              {
                type: "url_citation",
                url: "https://example.com/proof",
                title: "Source",
                privateData: "SECRET",
              },
              {
                type: "url_citation",
                url: "javascript:alert(1)",
                title: "Bad",
              },
              { type: "file_citation", document_uri: "/home/private.txt" },
            ],
          },
        ],
      },
    ],
  });
  assert.ok(result.includes("[Source](https://example.com/proof)"));
  assert.ok(!result.includes("SECRET"));
  assert.ok(!result.includes("javascript:"));
  assert.ok(!result.includes("/home/private"));
});

test("Google public progress preserves supplied summaries, search evidence and retrieval status without raw thoughts", async () => {
  const { googleAgentProgress } = await import("../src/core/google-agents.js");
  const entries = googleAgentProgress({
    id: "public",
    status: "in_progress",
    steps: [
      {
        type: "thought",
        text: "PRIVATE_RAW_THOUGHT",
        signature: "PRIVATE_SIGNATURE",
        summary: [
          {
            type: "text",
            text: "先比较官方方法，再核对基准数据。",
            privateData: "PRIVATE_METADATA",
          },
        ],
      },
      { type: "thought", text: "PRIVATE_ONLY_NO_SUMMARY" },
      {
        type: "google_search_call",
        arguments: {
          query: "official evaluation methods",
          credentials: "PRIVATE_SEARCH_METADATA",
        },
      },
      {
        type: "google_search_result",
        result: [
          {
            title: "Search hit",
            url: "https://example.com/found",
            snippet: "A search excerpt.",
            hidden: "PRIVATE_RESULT",
          },
          { url: "javascript:alert(1)" },
          { url: "https://user:password@example.com" },
        ],
      },
      {
        type: "url_context_call",
        arguments: {
          urls: ["https://example.com/requested"],
          hidden: "PRIVATE_ARGUMENTS",
        },
      },
      {
        type: "url_context_result",
        result: [
          {
            url: "https://example.com/read",
            status: "success",
            snippet: "Read excerpt",
          },
          { url: "https://example.com/blocked", status: "paywall" },
          { url: "https://example.com/unknown" },
        ],
      },
      {
        type: "model_output",
        content: [
          {
            type: "text",
            text: "Final prose",
            annotations: [
              {
                type: "url_citation",
                url: "https://example.com/cited",
                title: "Citation",
              },
            ],
          },
        ],
      },
    ],
  });
  assert.equal(
    entries.filter((entry) => entry.details.progressKind === "analysis").length,
    1,
  );
  assert.equal(entries[0].details.detail, "先比较官方方法，再核对基准数据。");
  const sources = entries.flatMap((entry) => entry.details.webSources ?? []);
  assert.deepEqual(
    sources.map((source) => source.status),
    ["searched", "requested", "read", "unavailable", "cited", "cited"],
  );
  assert.deepEqual(
    entries.find((entry) => entry.details.queries)?.details.queries,
    ["official evaluation methods"],
  );
  assert.doesNotMatch(JSON.stringify(entries), /PRIVATE_|javascript:|password/);
});

test("hosted polling retains final-step-only public findings and sources and deduplicates unchanged snapshots", async () => {
  const progress: unknown[] = [];
  let calls = 0;
  const model = await createGoogleAgentModel(profile, () => "test-secret", {
    pollMs: 1,
    onProgress: (summary, detail) => {
      if (detail) progress.push({ summary, detail });
    },
    fetch: async (_url, init) => {
      calls++;
      if (calls === 1)
        assert.equal(
          JSON.parse(String(init?.body)).agent_config.thinking_summaries,
          "auto",
        );
      return reply({
        id: "final-source",
        status: calls >= 3 ? "completed" : "in_progress",
        steps: [
          {
            type: "thought",
            summary: [{ type: "text", text: "检查可比性。" }],
          },
          ...(calls >= 3
            ? [
                {
                  type: "url_context_result",
                  result: [
                    {
                      title: "Verified",
                      url: "https://example.com/final",
                      status: "success",
                    },
                  ],
                },
                {
                  type: "model_output",
                  content: [{ type: "text", text: "Final public report" }],
                },
              ]
            : []),
        ],
      });
    },
  });
  const result = await new Runner({ tracingDisabled: true }).run(
    new Agent({ name: "public-progress", model }),
    "synthetic public task",
  );
  assert.equal(result.finalOutput, "Final public report");
  assert.equal(
    progress.length,
    2,
    "the repeated thought summary is emitted once, and final-only sources survive",
  );
  assert.match(JSON.stringify(progress), /example.com\/final/);
});
