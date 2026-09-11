import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Agent, Runner } from "@openai/agents";
import {
  createConfiguredModel,
  probeProfile,
  safeModelError,
  validateProfile,
} from "../src/core/models.js";
import type { ModelProfile } from "../src/shared/types.js";

function profile(baseURL: string, id = "first"): ModelProfile {
  return {
    id,
    name: id,
    provider: "compatible",
    protocol: "openai",
    baseURL,
    modelId: `${id}-model`,
    apiKeyEnv: "SYNTHETIC_KEY",
    hasKey: true,
    status: "untested",
  };
}

test("compatible profiles use independent ChatCompletions clients and the actual tool/stream probe", async () => {
  const calls: {
    url: string;
    authorization?: string;
    model: string;
    stream?: boolean;
  }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      model: string;
      stream?: boolean;
      messages: { role: string; content: string }[];
      tools?: unknown[];
    };
    calls.push({
      url: request.url!,
      authorization: request.headers.authorization,
      model: body.model,
      stream: body.stream,
    });
    const last = body.messages.at(-1)!;
    const content =
      last.role === "tool"
        ? last.content
        : last.content.includes("TEXT_OK")
          ? "TEXT_OK"
          : last.content.includes("STREAM_OK")
            ? "STREAM_OK"
            : "hello";
    if (body.stream) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const delta of [{ role: "assistant", content: "" }, { content }])
        response.write(
          `data: ${JSON.stringify({ id: "stream-local", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
        );
      response.write(
        `data: ${JSON.stringify({ id: "stream-local", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
      return;
    }
    const useTool = Boolean(body.tools?.length) && last.role !== "tool";
    const message = useTool
      ? {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "local-tool",
              type: "function",
              function: { name: "read_probe_token", arguments: "{}" },
            },
          ],
        }
      : { role: "assistant", content };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "local-response",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [
          { index: 0, message, finish_reason: useTool ? "tool_calls" : "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseURL = `http://127.0.0.1:${address.port}/v1`;
  try {
    const first = profile(baseURL);
    const second = profile(baseURL, "second");
    const runner = new Runner({ tracingDisabled: true });
    await Promise.all(
      [first, second].map(async (p) => {
        const model = await createConfiguredModel(
          p,
          (value) => `${value.id}-secret-for-local-test`,
        );
        await runner.run(new Agent({ name: p.id, model }), "Hello");
      }),
    );
    assert.equal(
      calls.find((call) => call.model === "first-model")?.authorization,
      "Bearer first-secret-for-local-test",
    );
    assert.equal(
      calls.find((call) => call.model === "second-model")?.authorization,
      "Bearer second-secret-for-local-test",
    );
    const probe = await probeProfile(
      first,
      () => "probe-secret-for-local-test",
    );
    assert.deepEqual(
      probe.capabilities,
      { text: true, tools: true, streaming: true },
      probe.error,
    );
    assert.ok(calls.every((call) => call.url === "/v1/chat/completions"));
    assert.ok(calls.some((call) => call.stream));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("rejects Anthropic endpoints as OpenAI and redacts provider error messages", () => {
  assert.throws(
    () => validateProfile(profile("https://example.test/api/anthropic")),
    /Anthropic/,
  );
  assert.throws(
    () => validateProfile(profile("https://example.test/v1?key=hidden")),
    /密钥/,
  );
  assert.equal(
    safeModelError({ status: 401, message: "secret-raw-request" }),
    "模型认证或权限失败（HTTP 401），请检查当前配置。",
  );
  assert.doesNotMatch(
    safeModelError(
      new Error("key=foo Bearer abc-private-token secret-value"),
      "secret-value",
    ),
    /abc-private-token|secret-value/,
  );
  assert.doesNotMatch(
    safeModelError(
      new Error(
        "400 Your account (1234567890) does not have a valid CodingPlan subscription, or your subscription has expired. Request id: hidden",
      ),
    ),
    /1234567890|hidden/,
  );
  assert.match(
    safeModelError(
      new Error(
        "400 Your account (1234567890) does not have a valid CodingPlan subscription, or your subscription has expired.",
      ),
    ),
    /订阅/,
  );
  assert.throws(
    () =>
      validateProfile({
        ...profile("https://ark.cn-beijing.volces.com/api/v3"),
        provider: "ark",
        modelId: "ark-code-latest",
      }),
    /Coding Plan/,
  );
});
