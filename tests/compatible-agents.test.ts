import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import OpenAI from "openai";
import {
  Agent,
  Runner,
  OpenAIChatCompletionsModel,
  setTracingDisabled,
  tool,
} from "@openai/agents";
import { z } from "zod";
import { bufferedCompatibleModel } from "../src/core/compatible-agents.js";

setTracingDisabled(true);

test("buffered compatible Agent preserves exact provider tool metadata across real read and artifact-write rounds", async (t) => {
  let requests = 0;
  const artifacts: string[] = [];
  const signatures = [
    "opaque-synthetic-read-signature",
    "opaque-synthetic-write-signature",
  ];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString());
    requests++;
    assert.equal(input.stream, false);
    const calls = input.messages.flatMap(
      (message: { tool_calls?: unknown[] }) => message.tool_calls ?? [],
    );
    if (requests >= 2) {
      assert.equal(
        calls[0].extra_content.google.thought_signature,
        signatures[0],
      );
      assert.equal(
        input.messages.find(
          (message: { role: string }) => message.role === "tool",
        ).content,
        "ORCHID 42",
      );
    }
    if (requests >= 3)
      assert.equal(
        calls[1].extra_content.google.thought_signature,
        signatures[1],
      );
    const name = requests === 1 ? "read_source" : "write_artifact";
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        id: `completion-${requests}`,
        object: "chat.completion",
        created: 1,
        model: "generic-service-model",
        choices: [
          {
            index: 0,
            message:
              requests < 3
                ? {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: `call-${requests}`,
                        type: "function",
                        function: {
                          name,
                          arguments:
                            requests === 1
                              ? "{}"
                              : JSON.stringify({ content: "ORCHID 42" }),
                        },
                        extra_content: {
                          google: {
                            thought_signature: signatures[requests - 1],
                          },
                        },
                      },
                    ],
                  }
                : { role: "assistant", content: "已保存 ORCHID 42" },
            finish_reason: requests < 3 ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const model = bufferedCompatibleModel(
    new OpenAIChatCompletionsModel(
      new OpenAI({
        apiKey: "synthetic-key",
        baseURL: `http://127.0.0.1:${address.port}/v1`,
        maxRetries: 0,
      }),
      "generic-service-model",
    ),
  );
  const agent = new Agent({
    name: "compatible-agent",
    model,
    tools: [
      tool({
        name: "read_source",
        description: "Read synthetic material",
        parameters: z.object({}),
        execute: async () => "ORCHID 42",
      }),
      tool({
        name: "write_artifact",
        description: "Save actual tool input",
        parameters: z.object({ content: z.string() }),
        execute: async ({ content }) => {
          artifacts.push(content);
          return "saved";
        },
      }),
    ],
  });
  const result = await new Runner({ tracingDisabled: true }).run(
    agent,
    "Read and save supplied material.",
    { stream: true, maxTurns: 4 },
  );
  const types: string[] = [];
  for await (const event of result)
    if (event.type === "raw_model_stream_event") types.push(event.data.type);
  await result.completed;
  assert.equal(result.finalOutput, "已保存 ORCHID 42");
  assert.deepEqual(artifacts, ["ORCHID 42"]);
  assert.deepEqual(types, ["response_done", "response_done", "response_done"]);
  assert.equal(requests, 3);
  const serialized = JSON.stringify(result.state);
  for (const signature of signatures) assert.ok(serialized.includes(signature));
});

test("buffered compatibility aborts before dispatch and never retries an uncertain response", async () => {
  let calls = 0;
  const failure = new Error("synthetic unknown upstream result");
  const model = bufferedCompatibleModel({
    getResponse: async () => {
      calls++;
      throw failure;
    },
    async *getStreamedResponse() {
      throw new Error("stream must not be used");
    },
  });
  const request = {
    input: "synthetic",
    systemInstructions: "",
    tools: [],
    handoffs: [],
    outputType: "text" as const,
    modelSettings: {},
    tracing: false as const,
  };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(async () => {
    for await (const event of model.getStreamedResponse({
      ...request,
      signal: controller.signal,
    }))
      void event;
  }, /abort/i);
  assert.equal(calls, 0);
  await assert.rejects(
    async () => {
      for await (const event of model.getStreamedResponse(request)) void event;
    },
    (error) => error === failure,
  );
  assert.equal(calls, 1);
});
