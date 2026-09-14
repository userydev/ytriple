import type {
  HttpPort,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderKind,
  ProviderRequest,
  ProviderResponse,
} from "@ytriple/shared";
import { ProviderError } from "@ytriple/shared";
import { postJson, readArray, readNumber, readRecord, readString } from "./http.js";
import { appendSchemaInstruction } from "./schemaPrompt.js";

export interface OpenAiCompatibleOptions {
  providerId: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  capabilities: ProviderCapabilities;
  http: HttpPort;
  /** Reported as the provider kind; `deepseek` reuses this transport. */
  kind?: ProviderKind;
  extraHeaders?: Record<string, string>;
}

/**
 * `/chat/completions` transport shared by DeepSeek, OpenRouter, Ark's
 * OpenAI-compatible mode, vLLM and Ollama.
 */
export function createOpenAiCompatibleProvider(
  options: OpenAiCompatibleOptions,
): ProviderAdapter {
  const {
    providerId,
    model,
    baseUrl,
    apiKey,
    capabilities,
    http,
    kind = "openai_compatible",
  } = options;

  return {
    providerId,
    kind,
    model,
    capabilities,
    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      const mode = capabilities.structuredOutput;
      const usesNativeSchema = Boolean(request.responseSchema) && mode === "json_schema";
      const system =
        request.responseSchema && !usesNativeSchema
          ? appendSchemaInstruction(request.system, request.responseSchema)
          : request.system;

      const body: Record<string, unknown> = {
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: request.user },
        ],
        stream: false,
      };
      if (request.temperature !== undefined) body.temperature = request.temperature;
      if (request.maxOutputTokens !== undefined) body.max_tokens = request.maxOutputTokens;

      if (request.responseSchema) {
        if (usesNativeSchema) {
          body.response_format = {
            type: "json_schema",
            json_schema: {
              name: request.responseSchema.name,
              strict: true,
              schema: request.responseSchema.schema,
            },
          };
        } else if (mode === "json_object") {
          body.response_format = { type: "json_object" };
        }
      }

      const payload = await postJson(http, {
        providerId,
        url: `${trimTrailingSlash(baseUrl)}/chat/completions`,
        headers: { authorization: `Bearer ${apiKey}`, ...options.extraHeaders },
        body,
      });

      return {
        text: extractContent(payload, providerId),
        usage: {
          promptTokens: readNumber(readRecord(payload, "usage"), "prompt_tokens") ?? 0,
          completionTokens: readNumber(readRecord(payload, "usage"), "completion_tokens") ?? 0,
        },
        structuredOutputMode: request.responseSchema
          ? usesNativeSchema
            ? "json_schema"
            : mode
          : "text_only",
      };
    },
  };
}

function extractContent(payload: Record<string, unknown>, providerId: string): string {
  const choice = readArray(payload, "choices")[0];
  const content = readString(readRecord(choice, "message"), "content");
  if (typeof content === "string" && content.length > 0) return content;
  throw new ProviderError(`${providerId} returned no message content`, { providerId });
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
