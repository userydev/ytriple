import { ProviderError, type NamedJsonSchema, type ProviderRequest } from "@ytriple/shared";
import { describe, expect, it } from "vitest";
import { createArkProvider } from "./ark.js";
import { capabilitiesFor } from "./capabilities.js";
import { createGoogleProvider, toGeminiSchema } from "./google.js";
import { createOpenAiCompatibleProvider } from "./openaiCompatible.js";
import { createFakeHttpPort } from "./testSupport.js";

const schema: NamedJsonSchema = {
  name: "contribution",
  schema: {
    type: "object",
    required: ["summary"],
    properties: {
      summary: { type: "string", description: "one sentence" },
      risks: { type: "array", items: { type: "string" } },
    },
  },
};

function requestWith(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    system: "You are the Researcher.",
    user: "Summarise the market.",
    metadata: { agentId: "researcher", phase: "synthesis", round: 0 },
    ...overrides,
  };
}

describe("openai-compatible adapter", () => {
  it("sends a native json_schema response_format when the capability allows it", async () => {
    const http = createFakeHttpPort(() => ({
      body: {
        choices: [{ message: { content: '{"summary":"ok"}' } }],
        usage: { prompt_tokens: 11, completion_tokens: 5 },
      },
    }));

    const provider = createOpenAiCompatibleProvider({
      providerId: "gateway",
      model: "gpt-4o-mini",
      baseUrl: "https://gateway.example/v1/",
      apiKey: "sk-test",
      capabilities: capabilitiesFor("openai_compatible", { structuredOutput: "json_schema" }),
      http,
    });

    const response = await provider.complete(requestWith({ responseSchema: schema }));

    expect(http.calls[0]?.init.url).toBe("https://gateway.example/v1/chat/completions");
    expect(http.calls[0]?.init.headers.authorization).toBe("Bearer sk-test");
    expect(http.lastBody.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "contribution", strict: true, schema: schema.schema },
    });
    expect(response.text).toBe('{"summary":"ok"}');
    expect(response.usage).toEqual({ promptTokens: 11, completionTokens: 5 });
    expect(response.structuredOutputMode).toBe("json_schema");
  });

  it("degrades to JSON mode plus a prompt-injected schema for DeepSeek-class providers", async () => {
    const http = createFakeHttpPort(() => ({
      body: { choices: [{ message: { content: '{"summary":"ok"}' } }] },
    }));

    const provider = createOpenAiCompatibleProvider({
      providerId: "deepseek",
      kind: "deepseek",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-test",
      capabilities: capabilitiesFor("deepseek"),
      http,
    });

    const response = await provider.complete(requestWith({ responseSchema: schema }));
    const messages = http.lastBody.messages as Array<{ role: string; content: string }>;

    expect(http.lastBody.response_format).toEqual({ type: "json_object" });
    expect(messages[0]?.content).toContain('"summary": string');
    expect(response.structuredOutputMode).toBe("json_object");
  });

  it("surfaces an actionable error on an auth failure", async () => {
    const http = createFakeHttpPort(() => ({ status: 401, body: { error: "invalid key" } }));
    const provider = createOpenAiCompatibleProvider({
      providerId: "deepseek",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "nope",
      capabilities: capabilitiesFor("deepseek"),
      http,
    });

    await expect(provider.complete(requestWith())).rejects.toThrowError(
      /deepseek rejected the credentials \(HTTP 401\)/,
    );
    await expect(provider.complete(requestWith())).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("ark adapter", () => {
  it("combines native web_search with strict json_schema output", async () => {
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

    const provider = createArkProvider({
      providerId: "ark",
      model: "doubao-seed-1-6",
      apiKey: "ark-key",
      capabilities: capabilitiesFor("ark"),
      http,
    });

    const response = await provider.complete(
      requestWith({ responseSchema: schema, webSearch: { enabled: true, maxResults: 3 } }),
    );

    expect(http.calls[0]?.init.url).toBe("https://ark.cn-beijing.volces.com/api/v3/responses");
    expect(http.lastBody.tools).toEqual([{ type: "web_search", max_keyword: 2, limit: 3 }]);
    expect(http.lastBody.text).toEqual({
      format: { type: "json_schema", name: "contribution", strict: true, schema: schema.schema },
    });
    expect(response.structuredOutputMode).toBe("json_schema");
    expect(response.sources).toEqual([
      { title: "A", url: "https://example.com/a", snippet: "s", origin: "native_provider_search" },
    ]);
    expect(response.usage).toEqual({ promptTokens: 20, completionTokens: 7 });
  });

  it("omits the search tool when the caller did not request search", async () => {
    const http = createFakeHttpPort(() => ({ body: { output_text: "{}" } }));
    const provider = createArkProvider({
      providerId: "ark",
      model: "doubao-seed-1-6",
      apiKey: "ark-key",
      capabilities: capabilitiesFor("ark"),
      http,
    });

    await provider.complete(requestWith());
    expect(http.lastBody.tools).toBeUndefined();
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

    const provider = createGoogleProvider({
      providerId: "gemini",
      model: "gemini-2.5-flash",
      apiKey: "g-key",
      capabilities: capabilitiesFor("google"),
      http,
    });

    const response = await provider.complete(requestWith({ responseSchema: schema }));
    const generationConfig = http.lastBody.generationConfig as Record<string, unknown>;

    expect(http.calls[0]?.init.headers["x-goog-api-key"]).toBe("g-key");
    expect(http.calls[0]?.init.url).toContain("/models/gemini-2.5-flash:generateContent");
    expect(generationConfig.responseMimeType).toBe("application/json");
    expect(http.lastBody.tools).toBeUndefined();
    expect(response.structuredOutputMode).toBe("json_schema");
  });

  it("trades the response schema for grounding and reports the degradation", async () => {
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

    const provider = createGoogleProvider({
      providerId: "gemini",
      model: "gemini-2.5-flash",
      apiKey: "g-key",
      capabilities: capabilitiesFor("google"),
      http,
    });

    const response = await provider.complete(
      requestWith({ responseSchema: schema, webSearch: { enabled: true } }),
    );
    const generationConfig = (http.lastBody.generationConfig ?? {}) as Record<string, unknown>;
    const systemText = (
      http.lastBody.systemInstruction as { parts: Array<{ text: string }> }
    ).parts[0]?.text;

    expect(http.lastBody.tools).toEqual([{ google_search: {} }]);
    expect(generationConfig.responseSchema).toBeUndefined();
    expect(systemText).toContain('"summary": string');
    expect(response.structuredOutputMode).toBe("text_only");
    expect(response.sources).toEqual([
      { title: "B", url: "https://example.com/b", origin: "native_provider_search" },
    ]);
  });
});

describe("toGeminiSchema", () => {
  it("converts to the OpenAPI-flavoured shape Gemini expects", () => {
    expect(toGeminiSchema(schema.schema)).toEqual({
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
