import type {
  HttpPort,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderRequest,
  ProviderResponse,
  SourceNote,
} from "@ytriple/shared";
import { ProviderError } from "@ytriple/shared";
import { postJson, readArray, readNumber, readRecord, readString } from "./http.js";
import { appendSchemaInstruction } from "./schemaPrompt.js";

export interface ArkProviderOptions {
  providerId: string;
  model: string;
  baseUrl?: string;
  apiKey: string;
  capabilities: ProviderCapabilities;
  http: HttpPort;
  webSearchMaxKeyword?: number;
}

export const ARK_DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";

/**
 * Volcengine Ark Responses API. Unlike Gemini, Ark combines its native
 * `web_search` tool with strict `json_schema` output in a single call, so a
 * grounded request keeps structured output.
 */
export function createArkProvider(options: ArkProviderOptions): ProviderAdapter {
  const {
    providerId,
    model,
    apiKey,
    capabilities,
    http,
    baseUrl = ARK_DEFAULT_BASE_URL,
    webSearchMaxKeyword = 2,
  } = options;

  return {
    providerId,
    kind: "ark",
    model,
    capabilities,
    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      const usesNativeSchema =
        Boolean(request.responseSchema) && capabilities.structuredOutput === "json_schema";
      const system =
        request.responseSchema && !usesNativeSchema
          ? appendSchemaInstruction(request.system, request.responseSchema)
          : request.system;

      const body: Record<string, unknown> = {
        model,
        stream: false,
        input: [
          { role: "system", content: system },
          { role: "user", content: request.user },
        ],
      };

      if (request.temperature !== undefined) body.temperature = request.temperature;
      if (request.maxOutputTokens !== undefined) body.max_output_tokens = request.maxOutputTokens;

      if (request.responseSchema) {
        body.text = {
          format: usesNativeSchema
            ? {
                type: "json_schema",
                name: request.responseSchema.name,
                strict: true,
                schema: request.responseSchema.schema,
              }
            : { type: "json_object" },
        };
      }

      if (request.webSearch?.enabled && capabilities.nativeWebSearch) {
        body.tools = [
          {
            type: "web_search",
            max_keyword: webSearchMaxKeyword,
            limit: request.webSearch.maxResults ?? 5,
          },
        ];
      }

      const payload = await postJson(http, {
        providerId,
        url: `${trimTrailingSlash(baseUrl)}/responses`,
        headers: { authorization: `Bearer ${apiKey}` },
        body,
      });

      const sources = extractSources(payload);
      return {
        text: extractOutputText(payload, providerId),
        usage: {
          promptTokens: readNumber(readRecord(payload, "usage"), "input_tokens") ?? 0,
          completionTokens: readNumber(readRecord(payload, "usage"), "output_tokens") ?? 0,
        },
        ...(sources.length > 0 ? { sources } : {}),
        structuredOutputMode: request.responseSchema
          ? usesNativeSchema
            ? "json_schema"
            : "json_object"
          : "text_only",
      };
    },
  };
}

function extractOutputText(payload: Record<string, unknown>, providerId: string): string {
  const direct = readString(payload, "output_text");
  if (direct) return direct;

  for (const item of readArray(payload, "output")) {
    for (const contentItem of readArray(item, "content")) {
      const text = readString(contentItem, "text");
      if (text) return text;
    }
  }

  throw new ProviderError(`${providerId} response contained no output text`, { providerId });
}

function extractSources(payload: Record<string, unknown>): SourceNote[] {
  const sources: SourceNote[] = [];
  const seen = new Set<string>();

  for (const item of readArray(payload, "output")) {
    for (const contentItem of readArray(item, "content")) {
      for (const annotation of readArray(contentItem, "annotations")) {
        const url = readString(annotation, "url");
        if (!url || seen.has(url)) continue;
        seen.add(url);
        const snippet = readString(annotation, "snippet");
        sources.push({
          title: readString(annotation, "title") ?? url,
          url,
          ...(snippet ? { snippet } : {}),
          origin: "native_provider_search",
        });
      }
    }
  }

  return sources;
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
