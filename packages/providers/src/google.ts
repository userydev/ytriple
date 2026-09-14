import type {
  HttpPort,
  JsonSchema,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderRequest,
  ProviderResponse,
  SourceNote,
} from "@ytriple/shared";
import { ProviderError } from "@ytriple/shared";
import { postJson, readArray, readNumber, readRecord, readString } from "./http.js";
import { appendSchemaInstruction } from "./schemaPrompt.js";

export interface GoogleProviderOptions {
  providerId: string;
  model: string;
  baseUrl?: string;
  apiKey: string;
  capabilities: ProviderCapabilities;
  http: HttpPort;
}

export const GOOGLE_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Gemini `generateContent`.
 *
 * Search grounding and `responseSchema` cannot be combined in one request, so a
 * grounded call falls back to a prompt-injected schema and reports
 * `structuredOutputMode: "text_only"`. The runtime turns that report into a
 * `capability_degraded` event instead of silently losing structure.
 */
export function createGoogleProvider(options: GoogleProviderOptions): ProviderAdapter {
  const {
    providerId,
    model,
    apiKey,
    capabilities,
    http,
    baseUrl = GOOGLE_DEFAULT_BASE_URL,
  } = options;

  return {
    providerId,
    kind: "google",
    model,
    capabilities,
    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      const grounded = Boolean(request.webSearch?.enabled) && capabilities.nativeWebSearch;
      const usesNativeSchema =
        Boolean(request.responseSchema) &&
        capabilities.structuredOutput === "json_schema" &&
        !grounded;

      const system =
        request.responseSchema && !usesNativeSchema
          ? appendSchemaInstruction(request.system, request.responseSchema)
          : request.system;

      const generationConfig: Record<string, unknown> = {};
      if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
      if (request.maxOutputTokens !== undefined) {
        generationConfig.maxOutputTokens = request.maxOutputTokens;
      }
      if (usesNativeSchema && request.responseSchema) {
        generationConfig.responseMimeType = "application/json";
        generationConfig.responseSchema = toGeminiSchema(request.responseSchema.schema);
      }

      const body: Record<string, unknown> = {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: request.user }] }],
      };
      if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;
      if (grounded) body.tools = [{ google_search: {} }];

      const payload = await postJson(http, {
        providerId,
        url: `${trimTrailingSlash(baseUrl)}/models/${encodeURIComponent(model)}:generateContent`,
        headers: { "x-goog-api-key": apiKey },
        body,
      });

      const candidate = readArray(payload, "candidates")[0];
      const sources = extractSources(candidate);

      return {
        text: extractText(candidate, providerId),
        usage: {
          promptTokens: readNumber(readRecord(payload, "usageMetadata"), "promptTokenCount") ?? 0,
          completionTokens:
            readNumber(readRecord(payload, "usageMetadata"), "candidatesTokenCount") ?? 0,
        },
        ...(sources.length > 0 ? { sources } : {}),
        structuredOutputMode: request.responseSchema
          ? usesNativeSchema
            ? "json_schema"
            : "text_only"
          : "text_only",
      };
    },
  };
}

function extractText(candidate: unknown, providerId: string): string {
  const parts = readArray(readRecord(candidate, "content"), "parts");
  const text = parts
    .map((part) => readString(part, "text") ?? "")
    .filter((value) => value.length > 0)
    .join("");
  if (text.length > 0) return text;
  throw new ProviderError(`${providerId} returned no candidate text`, { providerId });
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

/**
 * Gemini expects OpenAPI-flavoured schemas: uppercase type names, no
 * `additionalProperties`.
 */
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

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
