import type { GenerateRequest, ModelConfig, ToolSpec } from "@ytriple/shared";
import { ProviderError } from "@ytriple/shared";
import { describe, expect, it } from "vitest";
import { createArkAdapter } from "./ark.js";
import { createGoogleAdapter, toGeminiSchema } from "./google.js";
import { createOpenAiCompatibleAdapter } from "./openaiCompatible.js";
import { createFakeHttpPort } from "./testSupport.js";

const responseSchema = {
  name: "contribution",
  schema: {
    type: "object" as const,
    required: ["summary"],
    properties: {
      summary: { type: "string" as const, description: "one sentence" },
      risks: { type: "array" as const, items: { type: "string" as const } },
    },
  },
};

const searchTool: ToolSpec = {
  name: "web_search",
  description: "Search the web",
  parameters: { type: "object", required: ["query"], properties: { query: { type: "string" } } },
};

function model(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return { modelId: "test-model", displayName: "Test Model", ...overrides };
}

function requestWith(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    model: model(),
    system: "You are a member of the team.",
    messages: [{ role: "user", content: "Summarise the market." }],
    metadata: { agentId: "member-a", phase: "synthesis", round: 0 },
    ...overrides,
  };
}

describe("openai_compatible adapter", () => {
  it("uses a native json_schema response format when the model declares it", async () => {
    const http = createFakeHttpPort(() => ({
      body: {
        choices: [{ message: { content: '{"summary":"ok"}' } }],
        usage: { prompt_tokens: 11, completion_tokens: 5 },
      },
    }));

    const adapter = createOpenAiCompatibleAdapter({
      providerId: "gateway",
      baseUrl: "https://gateway.example/v1/",
      apiKey: "sk-test",
      http,
    });

    const result = await adapter.generate(
      requestWith({
        model: model({ capabilities: { structuredOutput: "json_schema" } }),
        responseSchema,
      }),
    );

    expect(http.calls[0]?.init.url).toBe("https://gateway.example/v1/chat/completions");
    expect(http.calls[0]?.init.headers.authorization).toBe("Bearer sk-test");
    expect(http.lastBody.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "contribution", strict: true, schema: responseSchema.schema },
    });
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 5 });
    expect(result.degradations).toEqual([]);
  });

  it("degrades to JSON mode with the schema in the prompt and reports it", async () => {
    const http = createFakeHttpPort(() => ({
      body: { choices: [{ message: { content: '{"summary":"ok"}' } }] },
    }));

    const adapter = createOpenAiCompatibleAdapter({
      providerId: "deepseek-personal",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-test",
      http,
    });

    const result = await adapter.generate(requestWith({ responseSchema }));
    const messages = http.lastBody.messages as Array<{ role: string; content: string }>;

    expect(http.lastBody.response_format).toEqual({ type: "json_object" });
    expect(messages[0]?.content).toContain('"summary": string');
    expect(result.degradations).toEqual([
      {
        kind: "structured_output",
        from: "json_schema",
        to: "json_mode",
        detail:
          "model declares structuredOutput=json_mode; schema moved into the prompt and validated locally with repair retries",
      },
    ]);
  });

  it("round-trips native tool calls and tool results", async () => {
    const http = createFakeHttpPort((_init, call) =>
      call === 0
        ? {
            body: {
              choices: [
                {
                  message: {
                    content: "",
                    tool_calls: [
                      {
                        id: "call_1",
                        function: { name: "web_search", arguments: '{"query":"prd tools"}' },
                      },
                    ],
                  },
                },
              ],
            },
          }
        : { body: { choices: [{ message: { content: '{"summary":"done"}' } }] } },
    );

    const adapter = createOpenAiCompatibleAdapter({
      providerId: "gateway",
      baseUrl: "https://gateway.example/v1",
      apiKey: "sk-test",
      http,
    });

    const first = await adapter.generate(requestWith({ tools: [searchTool] }));
    expect(first.toolCalls).toEqual([
      { toolCallId: "call_1", name: "web_search", arguments: { query: "prd tools" } },
    ]);
    expect((http.lastBody.tools as unknown[])[0]).toMatchObject({
      type: "function",
      function: { name: "web_search" },
    });

    await adapter.generate(
      requestWith({
        tools: [searchTool],
        messages: [
          { role: "user", content: "Summarise the market." },
          { role: "assistant", content: "", toolCalls: first.toolCalls },
          { role: "tool", toolCallId: "call_1", name: "web_search", content: "3 sources" },
        ],
      }),
    );

    const messages = http.lastBody.messages as Array<Record<string, unknown>>;
    expect(messages[2]).toMatchObject({ role: "assistant" });
    expect(messages[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: "3 sources" });
  });

  it("keeps only the first tool call for sequential models and reports the trim", async () => {
    const http = createFakeHttpPort(() => ({
      body: {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                { id: "a", function: { name: "web_search", arguments: "{}" } },
                { id: "b", function: { name: "web_search", arguments: "{}" } },
              ],
            },
          },
        ],
      },
    }));

    const adapter = createOpenAiCompatibleAdapter({
      providerId: "gateway",
      baseUrl: "https://gateway.example/v1",
      apiKey: "sk-test",
      http,
    });

    const result = await adapter.generate(requestWith({ tools: [searchTool] }));
    expect(result.toolCalls).toHaveLength(1);
    expect(result.degradations[0]).toMatchObject({ kind: "tool_calling", to: "sequential" });
  });

  it("refuses tools on a model that cannot call them instead of simulating them", async () => {
    const http = createFakeHttpPort(() => ({ body: {} }));
    const adapter = createOpenAiCompatibleAdapter({
      providerId: "ollama-local",
      baseUrl: "http://127.0.0.1:11434/v1",
      http,
    });

    await expect(
      adapter.generate(
        requestWith({ model: model({ capabilities: { toolCalling: "none" } }), tools: [searchTool] }),
      ),
    ).rejects.toThrowError(/declares toolCalling="none".*no prompt-simulated fallback/s);
    expect(http.calls).toHaveLength(0);
  });

  it("classifies an auth failure as a blocking provider error", async () => {
    const http = createFakeHttpPort(() => ({ status: 401, body: { error: "invalid key" } }));
    const adapter = createOpenAiCompatibleAdapter({
      providerId: "deepseek-personal",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "nope",
      http,
    });

    const error = await adapter.generate(requestWith()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe("auth_failed");
    expect((error as ProviderError).retryable).toBe(false);
  });

  it("classifies a context-length rejection as recoverable", async () => {
    const http = createFakeHttpPort(() => ({
      status: 400,
      body: { error: { message: "This model's maximum context length is 64000 tokens" } },
    }));
    const adapter = createOpenAiCompatibleAdapter({
      providerId: "deepseek-personal",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-test",
      http,
    });

    const error = (await adapter.generate(requestWith()).catch((caught: unknown) => caught)) as ProviderError;
    expect(error.code).toBe("context_overflow");
    expect(error.retryable).toBe(true);
  });
});

describe("ark adapter", () => {
  it("combines native web search with a strict schema in one call", async () => {
    const http = createFakeHttpPort(() => ({
      body: {
        output: [
          {
            content: [
              {
                text: '{"summary":"grounded"}',
                annotations: [
                  { url: "https://example.com/a", title: "A", snippet: "s" },
                  { url: "https://example.com/a", title: "duplicate" },
                ],
              },
            ],
          },
        ],
        usage: { input_tokens: 20, output_tokens: 7 },
      },
    }));

    const adapter = createArkAdapter({ providerId: "ark-personal", apiKey: "ark-key", http });
    const result = await adapter.generate(requestWith({ responseSchema, nativeWebSearch: true }));

    expect(http.calls[0]?.init.url).toBe("https://ark.cn-beijing.volces.com/api/v3/responses");
    expect(http.lastBody.tools).toEqual([{ type: "web_search", max_keyword: 2, limit: 5 }]);
    expect(http.lastBody.text).toEqual({
      format: { type: "json_schema", name: "contribution", strict: true, schema: responseSchema.schema },
    });
    expect(result.degradations).toEqual([]);
    expect(result.sources).toEqual([
      { title: "A", url: "https://example.com/a", snippet: "s", origin: "native_provider_search" },
    ]);
  });

  it("reports a degradation when a model without native search is asked to ground", async () => {
    const http = createFakeHttpPort(() => ({ body: { output_text: "{}" } }));
    const adapter = createArkAdapter({ providerId: "ark-personal", apiKey: "ark-key", http });

    const result = await adapter.generate(
      requestWith({
        model: model({ capabilities: { nativeWebSearch: false } }),
        nativeWebSearch: true,
      }),
    );

    expect(http.lastBody.tools).toBeUndefined();
    expect(result.degradations).toEqual([
      {
        kind: "native_web_search",
        from: "native",
        to: "search_port",
        detail: "bound model has no native web search; the runtime must use the SearchPort",
      },
    ]);
  });

  /**
   * A model with no JSON mode was still sent `json_object`, so the degradation
   * it reported ("prompt_only") did not describe the request that went out.
   */
  it("sends no response format at all for a model with no JSON mode", async () => {
    const http = createFakeHttpPort(() => ({ body: { output_text: "{}" } }));
    const adapter = createArkAdapter({ providerId: "ark-personal", apiKey: "ark-key", http });

    const result = await adapter.generate(
      requestWith({
        model: model({ capabilities: { structuredOutput: "none" } }),
        responseSchema,
      }),
    );

    expect(http.lastBody.text).toBeUndefined();
    expect(result.degradations).toEqual([
      {
        kind: "structured_output",
        from: "json_schema",
        to: "prompt_only",
        detail:
          "model declares structuredOutput=none; schema moved into the prompt and validated locally with repair retries",
      },
    ]);
  });

  it("still sends json_object for a model that declares json_mode", async () => {
    const http = createFakeHttpPort(() => ({ body: { output_text: "{}" } }));
    const adapter = createArkAdapter({ providerId: "ark-personal", apiKey: "ark-key", http });

    await adapter.generate(
      requestWith({
        model: model({ capabilities: { structuredOutput: "json_mode" } }),
        responseSchema,
      }),
    );

    expect(http.lastBody.text).toEqual({ format: { type: "json_object" } });
  });

  it("parses function calls and sends tool output back in Ark's shape", async () => {
    const http = createFakeHttpPort(() => ({
      body: {
        output: [
          { type: "function_call", call_id: "c1", name: "web_search", arguments: '{"query":"x"}' },
        ],
      },
    }));
    const adapter = createArkAdapter({ providerId: "ark-personal", apiKey: "ark-key", http });

    const result = await adapter.generate(requestWith({ tools: [searchTool] }));
    expect(result.toolCalls).toEqual([
      { toolCallId: "c1", name: "web_search", arguments: { query: "x" } },
    ]);

    await adapter.generate(
      requestWith({
        messages: [{ role: "tool", toolCallId: "c1", name: "web_search", content: "2 sources" }],
      }),
    );
    expect((http.lastBody.input as unknown[])[1]).toEqual({
      type: "function_call_output",
      call_id: "c1",
      output: "2 sources",
    });
  });
});

describe("google adapter", () => {
  it("uses a native response schema when the call is not grounded", async () => {
    const http = createFakeHttpPort(() => ({
      body: {
        candidates: [{ content: { parts: [{ text: '{"summary":"ok"}' }] } }],
        usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 9 },
      },
    }));

    const adapter = createGoogleAdapter({ providerId: "gemini", apiKey: "g-key", http });
    const result = await adapter.generate(requestWith({ responseSchema }));
    const generationConfig = http.lastBody.generationConfig as Record<string, unknown>;

    expect(http.calls[0]?.init.headers["x-goog-api-key"]).toBe("g-key");
    expect(generationConfig.responseMimeType).toBe("application/json");
    expect(result.degradations).toEqual([]);
  });

  it("trades schema and function tools for grounding, reporting both degradations", async () => {
    const http = createFakeHttpPort(() => ({
      body: {
        candidates: [
          {
            content: { parts: [{ text: '{"summary":"grounded"}' }] },
            groundingMetadata: {
              groundingChunks: [{ web: { uri: "https://example.com/b", title: "B" } }],
            },
          },
        ],
      },
    }));

    const adapter = createGoogleAdapter({ providerId: "gemini", apiKey: "g-key", http });
    const result = await adapter.generate(
      requestWith({ responseSchema, tools: [searchTool], nativeWebSearch: true }),
    );

    const grounded = (http.lastBody.generationConfig ?? {}) as Record<string, unknown>;
    expect(http.lastBody.tools).toEqual([{ google_search: {} }]);
    expect(grounded.responseSchema).toBeUndefined();
    // Grounding rules out the JSON response type too, so the degradation must
    // say prompt_only rather than claiming a json_mode it never set.
    expect(grounded.responseMimeType).toBeUndefined();
    expect(result.degradations.map((entry) => `${entry.kind}:${entry.to}`)).toEqual([
      "structured_output:prompt_only",
      "tool_calling:search_only",
    ]);
    expect(result.sources).toEqual([
      { title: "B", url: "https://example.com/b", origin: "native_provider_search" },
    ]);
  });

  it("sets a JSON response type for a model that declares json_mode", async () => {
    const http = createFakeHttpPort(() => ({
      body: { candidates: [{ content: { parts: [{ text: '{"summary":"ok"}' }] } }] },
    }));

    const adapter = createGoogleAdapter({ providerId: "gemini", apiKey: "g-key", http });
    const result = await adapter.generate(
      requestWith({
        model: model({ capabilities: { structuredOutput: "json_mode" } }),
        responseSchema,
      }),
    );

    const config = http.lastBody.generationConfig as Record<string, unknown>;
    expect(config.responseMimeType).toBe("application/json");
    expect(config.responseSchema).toBeUndefined();
    expect(result.degradations[0]).toMatchObject({ to: "json_mode" });
  });

  it("declares functions and parses functionCall parts when not grounded", async () => {
    const http = createFakeHttpPort(() => ({
      body: {
        candidates: [
          { content: { parts: [{ functionCall: { name: "web_search", args: { query: "x" } } }] } },
        ],
      },
    }));

    const adapter = createGoogleAdapter({ providerId: "gemini", apiKey: "g-key", http });
    const result = await adapter.generate(requestWith({ tools: [searchTool] }));

    expect(http.lastBody.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "web_search",
            description: "Search the web",
            parameters: {
              type: "OBJECT",
              required: ["query"],
              propertyOrdering: ["query"],
              properties: { query: { type: "STRING" } },
            },
          },
        ],
      },
    ]);
    expect(result.toolCalls[0]).toMatchObject({ name: "web_search", arguments: { query: "x" } });
  });
});

describe("toGeminiSchema", () => {
  it("converts to the OpenAPI-flavoured shape Gemini expects", () => {
    expect(toGeminiSchema(responseSchema.schema)).toEqual({
      type: "OBJECT",
      required: ["summary"],
      propertyOrdering: ["summary", "risks"],
      properties: {
        summary: { type: "STRING", description: "one sentence" },
        risks: { type: "ARRAY", items: { type: "STRING" } },
      },
    });
  });
});
