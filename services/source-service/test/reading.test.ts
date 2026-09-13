import assert from "node:assert/strict";
import test from "node:test";
import { geminiReadingGenerator, type ReadingInput } from "../src/reading.js";

const input: ReadingInput = {
  tenantId: "private-tenant-routing-id",
  category: "开发工具",
  items: [
    {
      itemId: "item-a",
      revisionId: "revision-a",
      title: "Source title",
      url: "https://example.com/article",
      coverage: "metadata",
      excerpt: "Only the supplied summary.",
    },
  ],
};
const summary = {
  title: "来源主题",
  summary: "可阅读的概述。",
  points: [
    {
      title: "有据可查",
      detail: "源站摘要中可确认的信息。",
      sourceIds: ["item-a"],
    },
  ],
  caveats: ["尚未取得全文。"],
};

test("Gemini reading uses final model output and sends only the provided public material", async () => {
  const generate = geminiReadingGenerator(
    "private-api-key",
    "fixture-model",
    async (_url, request) => {
      const body = JSON.parse(String(request?.body));
      assert.equal(body.store, false);
      assert.equal(body.response_format.mime_type, "application/json");
      assert.match(body.input, /Only the supplied summary/);
      assert.doesNotMatch(
        body.input,
        /private-tenant-routing-id|private-api-key/,
      );
      return Response.json({
        steps: [
          {
            type: "model_output",
            content: [{ type: "thought", text: "Do not expose this" }],
          },
          {
            type: "model_output",
            content: [
              { type: "thought", text: "Do not expose this either" },
              { type: "text", text: JSON.stringify(summary) },
            ],
          },
        ],
      });
    },
  );
  assert.deepEqual(await generate(input), summary);
});

test("Reading rejects absent final text and does not echo provider error bodies", async () => {
  await assert.rejects(
    geminiReadingGenerator("key", "fixture", async () =>
      Response.json({
        steps: [
          {
            type: "model_output",
            content: [{ type: "thought", text: JSON.stringify(summary) }],
          },
        ],
      }),
    )(input),
    /未返回正文/,
  );
  await assert.rejects(
    geminiReadingGenerator(
      "key",
      "fixture",
      async () => new Response("secret provider diagnostics", { status: 403 }),
    )(input),
    (error: Error) =>
      /HTTP 403/.test(error.message) && !error.message.includes("secret"),
  );
});
