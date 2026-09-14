import type {
  ChatMessage,
  Degradation,
  GenerateRequest,
  GenerateResult,
  HttpPort,
  ModelConfig,
  ProviderAdapter,
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

export interface OpenAiCompatibleAdapterOptions {
  providerId: string;
  baseUrl: string;
  apiKey?: string;
  http: HttpPort;
  extraHeaders?: Record<string, string>;
}

/**
 * `/chat/completions`. One transport covers DeepSeek, OpenRouter, Ark's
 * compatible endpoint, vLLM and Ollama; they differ only by base URL, model id
 * and capability overrides.
 */
export function createOpenAiCompatibleAdapter(
  options: OpenAiCompatibleAdapterOptions,
): ProviderAdapter {
  const { providerId, baseUrl, apiKey, http } = options;
  const baseline = baselineFor("openai_compatible");

  const adapter: ProviderAdapter = {
    adapterId: "openai_compatible",
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
        messages: [
          { role: "system", content: structured.system },
          ...request.messages.map(toOpenAiMessage),
        ],
        stream: false,
      };

      if (request.temperature !== undefined) body.temperature = request.temperature;
      const maxOutputTokens = request.maxOutputTokens ?? request.model.capabilities?.maxOutputTokens;
      if (maxOutputTokens !== undefined) body.max_tokens = maxOutputTokens;

      if (request.responseSchema) {
        if (structured.mode === "json_schema") {
          body.response_format = {
            type: "json_schema",
            json_schema: {
              name: request.responseSchema.name,
              strict: true,
              schema: request.responseSchema.schema,
            },
          };
        } else if (structured.mode === "json_mode") {
          body.response_format = { type: "json_object" };
        }
      }

      if (request.tools && request.tools.length > 0) {
        body.tools = request.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        }));
        body.tool_choice = "auto";
      }

      const payload = await postJson(http, {
        providerId,
        url: `${trimTrailingSlash(baseUrl)}/chat/completions`,
        headers: {
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          ...options.extraHeaders,
        },
        body,
      });

      const message = readRecord(readArray(payload, "choices")[0], "message");
      const text = readString(message, "content") ?? "";
      const parsedToolCalls = extractToolCalls(message);
      const limited = limitToolCalls(parsedToolCalls, capabilities);
      degradations.push(...limited.degradations);

      if (text.length === 0 && limited.toolCalls.length === 0) {
        throw new ProviderError(`${providerId} returned neither content nor tool calls`, {
          providerId,
          code: "unknown",
        });
      }

      return {
        text,
        toolCalls: limited.toolCalls,
        usage: {
          inputTokens: readNumber(readRecord(payload, "usage"), "prompt_tokens") ?? 0,
          outputTokens: readNumber(readRecord(payload, "usage"), "completion_tokens") ?? 0,
        },
        degradations,
      };
    },
  };

  return adapter;
}

function toOpenAiMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }
  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.toolCallId,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

function extractToolCalls(message: Record<string, unknown> | undefined): ToolCall[] {
  return readArray(message, "tool_calls").flatMap((entry, index): ToolCall[] => {
    const fn = readRecord(entry, "function");
    const name = fn ? readString(fn, "name") : undefined;
    if (!name) return [];
    return [
      {
        toolCallId: readString(entry, "id") ?? `call_${index}`,
        name,
        arguments: parseToolArguments(fn ? fn.arguments : undefined),
      },
    ];
  });
}

export function modelWithCapabilities(
  modelId: string,
  displayName: string,
  capabilities: ModelConfig["capabilities"],
): ModelConfig {
  return { modelId, displayName, ...(capabilities ? { capabilities } : {}) };
}
