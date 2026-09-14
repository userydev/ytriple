import type {
  ChatMessage,
  Degradation,
  GenerateRequest,
  GenerateResult,
  HttpPort,
  ProviderAdapter,
  SourceNote,
  ToolCall,
} from "@ytriple/shared";
import { ProviderError } from "@ytriple/shared";
import {
  assertToolCallingSupported,
  limitToolCalls,
  parseToolArguments,
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

export const ARK_DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";

export interface ArkAdapterOptions {
  providerId: string;
  baseUrl?: string;
  apiKey: string;
  http: HttpPort;
  webSearchMaxKeyword?: number;
}

/**
 * Volcengine Ark Responses API. Its own shape, so its own family. It is the one
 * adapter that can combine native web search with a strict response schema in a
 * single call — a capability fact, not a reason for the runtime to know its
 * name.
 */
export function createArkAdapter(options: ArkAdapterOptions): ProviderAdapter {
  const {
    providerId,
    apiKey,
    http,
    baseUrl = ARK_DEFAULT_BASE_URL,
    webSearchMaxKeyword = 2,
  } = options;
  const baseline = baselineFor("ark");

  const adapter: ProviderAdapter = {
    adapterId: "ark",
    providerId,
    describe: (model) => resolveCapabilities(baseline, model),
    healthCheck: (model) => runHealthCheck(adapter, model),
    async generate(request: GenerateRequest): Promise<GenerateResult> {
      const capabilities = resolveCapabilities(baseline, request.model);
      assertToolCallingSupported(request, capabilities, providerId);

      const structured = planStructuredOutput(request, capabilities);
      const nativeSearch = planNativeWebSearch(request, capabilities);
      const degradations: Degradation[] = [
        ...structured.degradations,
        ...nativeSearch.degradations,
      ];

      const body: Record<string, unknown> = {
        model: request.model.modelId,
        stream: false,
        input: [
          { role: "system", content: structured.system },
          ...request.messages.map(toArkInput),
        ],
      };

      if (request.temperature !== undefined) body.temperature = request.temperature;
      const maxOutputTokens = request.maxOutputTokens ?? request.model.capabilities?.maxOutputTokens;
      if (maxOutputTokens !== undefined) body.max_output_tokens = maxOutputTokens;

      if (request.responseSchema) {
        body.text = {
          format:
            structured.mode === "json_schema"
              ? {
                  type: "json_schema",
                  name: request.responseSchema.name,
                  strict: true,
                  schema: request.responseSchema.schema,
                }
              : { type: "json_object" },
        };
      }

      const tools: Array<Record<string, unknown>> = [];
      if (nativeSearch.enabled) {
        tools.push({ type: "web_search", max_keyword: webSearchMaxKeyword, limit: 5 });
      }
      for (const tool of request.tools ?? []) {
        tools.push({
          type: "function",
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        });
      }
      if (tools.length > 0) body.tools = tools;

      const payload = await postJson(http, {
        providerId,
        url: `${trimTrailingSlash(baseUrl)}/responses`,
        headers: { authorization: `Bearer ${apiKey}` },
        body,
      });

      const parsedToolCalls = extractToolCalls(payload);
      const limited = limitToolCalls(parsedToolCalls, capabilities);
      degradations.push(...limited.degradations);

      const text = extractOutputText(payload);
      if (text === undefined && limited.toolCalls.length === 0) {
        throw new ProviderError(`${providerId} response contained no output text or tool call`, {
          providerId,
          code: "unknown",
        });
      }

      const sources = extractSources(payload);
      return {
        text: text ?? "",
        toolCalls: limited.toolCalls,
        usage: {
          inputTokens: readNumber(readRecord(payload, "usage"), "input_tokens") ?? 0,
          outputTokens: readNumber(readRecord(payload, "usage"), "output_tokens") ?? 0,
        },
        ...(sources.length > 0 ? { sources } : {}),
        degradations,
      };
    },
  };

  return adapter;
}

function toArkInput(message: ChatMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      type: "function_call_output",
      call_id: message.toolCallId,
      output: message.content,
    };
  }
  return { role: message.role, content: message.content };
}

function extractToolCalls(payload: Record<string, unknown>): ToolCall[] {
  return readArray(payload, "output").flatMap((item, index): ToolCall[] => {
    if (readString(item, "type") !== "function_call") return [];
    const name = readString(item, "name");
    if (!name) return [];
    return [
      {
        toolCallId: readString(item, "call_id") ?? `call_${index}`,
        name,
        arguments: parseToolArguments(
          typeof item === "object" && item !== null
            ? (item as Record<string, unknown>).arguments
            : undefined,
        ),
      },
    ];
  });
}

function extractOutputText(payload: Record<string, unknown>): string | undefined {
  const direct = readString(payload, "output_text");
  if (direct) return direct;

  for (const item of readArray(payload, "output")) {
    for (const contentItem of readArray(item, "content")) {
      const text = readString(contentItem, "text");
      if (text) return text;
    }
  }
  return undefined;
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
