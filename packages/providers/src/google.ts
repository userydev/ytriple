import type {
  ChatMessage,
  Degradation,
  GenerateRequest,
  GenerateResult,
  HttpPort,
  JsonSchema,
  ProviderAdapter,
  SourceNote,
  ToolCall,
} from "@ytriple/shared";
import { ProviderError } from "@ytriple/shared";
import {
  assertToolCallingSupported,
  limitToolCalls,
  planNativeWebSearch,
  planStructuredOutput,
  postJson,
  readArray,
  readNumber,
  readRecord,
  readString,
  resolveCapabilities,
  trimTrailingSlash,
} from "./adapterSupport.js";
import { baselineFor } from "./capabilities.js";
import { runHealthCheck } from "./healthCheck.js";

export const GOOGLE_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export interface GoogleAdapterOptions {
  providerId: string;
  baseUrl?: string;
  apiKey: string;
  http: HttpPort;
}

/**
 * Gemini `generateContent`.
 *
 * Grounding cannot be combined with a response schema or with function
 * declarations, so a grounded call gives both up and reports the two
 * degradations rather than quietly losing structure or tools.
 */
export function createGoogleAdapter(options: GoogleAdapterOptions): ProviderAdapter {
  const { providerId, apiKey, http, baseUrl = GOOGLE_DEFAULT_BASE_URL } = options;
  const baseline = baselineFor("google");

  const adapter: ProviderAdapter = {
    adapterId: "google",
    providerId,
    describe: (model) => resolveCapabilities(baseline, model),
    healthCheck: (model) => runHealthCheck(adapter, model),
    async generate(request: GenerateRequest): Promise<GenerateResult> {
      const capabilities = resolveCapabilities(baseline, request.model);
      assertToolCallingSupported(request, capabilities, providerId);

      const nativeSearch = planNativeWebSearch(request, capabilities);
      const grounded = nativeSearch.enabled;
      const structured = planStructuredOutput(request, capabilities, {
        nativeSchemaAvailable: !grounded,
        nativeUnavailableReason:
          "Gemini cannot combine search grounding with a response schema; the schema moved into the prompt for this grounded call",
      });

      const degradations: Degradation[] = [
        ...nativeSearch.degradations,
        ...structured.degradations,
      ];

      const generationConfig: Record<string, unknown> = {};
      if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
      const maxOutputTokens = request.maxOutputTokens ?? request.model.capabilities?.maxOutputTokens;
      if (maxOutputTokens !== undefined) generationConfig.maxOutputTokens = maxOutputTokens;
      if (structured.mode === "json_schema" && request.responseSchema) {
        generationConfig.responseMimeType = "application/json";
        generationConfig.responseSchema = toGeminiSchema(request.responseSchema.schema);
      }

      const body: Record<string, unknown> = {
        systemInstruction: { parts: [{ text: structured.system }] },
        contents: request.messages.map(toGeminiContent),
      };
      if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

      const hasFunctionTools = Boolean(request.tools && request.tools.length > 0);
      if (grounded) {
        body.tools = [{ google_search: {} }];
        if (hasFunctionTools) {
          degradations.push({
            kind: "tool_calling",
            from: "function_tools",
            to: "search_only",
            detail:
              "Gemini cannot expose function declarations during a grounded call; tools are suspended for this turn",
          });
        }
      } else if (hasFunctionTools) {
        body.tools = [
          {
            functionDeclarations: (request.tools ?? []).map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: toGeminiSchema(tool.parameters),
            })),
          },
        ];
      }

      const payload = await postJson(http, {
        providerId,
        url: `${trimTrailingSlash(baseUrl)}/models/${encodeURIComponent(
          request.model.modelId,
        )}:generateContent`,
        headers: { "x-goog-api-key": apiKey },
        body,
      });

      const candidate = readArray(payload, "candidates")[0];
      const parts = readArray(readRecord(candidate, "content"), "parts");
      const text = parts
        .map((part) => readString(part, "text") ?? "")
        .join("")
        .trim();
      const limited = limitToolCalls(extractToolCalls(parts), capabilities);
      degradations.push(...limited.degradations);

      if (text.length === 0 && limited.toolCalls.length === 0) {
        throw new ProviderError(`${providerId} returned no candidate text or function call`, {
          providerId,
          code: "unknown",
        });
      }

      const sources = extractSources(candidate);
      return {
        text,
        toolCalls: limited.toolCalls,
        usage: {
          inputTokens: readNumber(readRecord(payload, "usageMetadata"), "promptTokenCount") ?? 0,
          outputTokens:
            readNumber(readRecord(payload, "usageMetadata"), "candidatesTokenCount") ?? 0,
        },
        ...(sources.length > 0 ? { sources } : {}),
        degradations,
      };
    },
  };

  return adapter;
}

function toGeminiContent(message: ChatMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "user",
      parts: [
        {
          functionResponse: {
            name: message.name ?? message.toolCallId ?? "tool",
            response: { result: message.content },
          },
        },
      ],
    };
  }
  return {
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.content }],
  };
}

function extractToolCalls(parts: unknown[]): ToolCall[] {
  return parts.flatMap((part, index): ToolCall[] => {
    const call = readRecord(part, "functionCall");
    const name = call ? readString(call, "name") : undefined;
    if (!call || !name) return [];
    const args = call.args;
    return [
      {
        toolCallId: `call_${index}`,
        name,
        arguments:
          typeof args === "object" && args !== null && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : {},
      },
    ];
  });
}

function extractSources(candidate: unknown): SourceNote[] {
  const chunks = readArray(readRecord(candidate, "groundingMetadata"), "groundingChunks");
  const sources: SourceNote[] = [];
  const seen = new Set<string>();

  for (const chunk of chunks) {
    const web = readRecord(chunk, "web");
    const url = web ? readString(web, "uri") : undefined;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sources.push({
      title: (web ? readString(web, "title") : undefined) ?? url,
      url,
      origin: "native_provider_search",
    });
  }

  return sources;
}

/** Gemini expects OpenAPI-flavoured schemas: uppercase types, no extras. */
export function toGeminiSchema(schema: JsonSchema): Record<string, unknown> {
  const result: Record<string, unknown> = { type: schema.type.toUpperCase() };
  if (schema.description) result.description = schema.description;
  if (schema.enum) result.enum = [...schema.enum];
  if (schema.items) result.items = toGeminiSchema(schema.items);
  if (schema.properties) {
    result.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, toGeminiSchema(value)]),
    );
    result.propertyOrdering = Object.keys(schema.properties);
  }
  if (schema.required) result.required = [...schema.required];
  if (schema.minItems !== undefined) result.minItems = schema.minItems;
  if (schema.maxItems !== undefined) result.maxItems = schema.maxItems;
  return result;
}
