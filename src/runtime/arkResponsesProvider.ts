import type { ProviderAdapter, ProviderGenerateJsonInput } from "./types";

export interface ArkResponsesProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  enableWebSearch?: boolean;
  webSearchMaxKeyword?: number;
  webSearchLimit?: number;
  fetchImpl?: typeof fetch;
}

export function createArkResponsesProvider({
  apiKey,
  model,
  baseUrl = "https://ark.cn-beijing.volces.com/api/v3",
  enableWebSearch = false,
  webSearchMaxKeyword = 2,
  webSearchLimit = 5,
  fetchImpl = fetch,
}: ArkResponsesProviderOptions): ProviderAdapter {
  return {
    async generateJson(input: ProviderGenerateJsonInput) {
      const response = await fetchImpl(`${baseUrl}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildArkResponsesBody(input, {
          model,
          enableWebSearch,
          webSearchMaxKeyword,
          webSearchLimit,
        })),
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error(
            "Ark authentication failed. Check that ARK_API_KEY is a regular Ark API key for the configured ARK_BASE_URL.",
          );
        }
        throw new Error(`Ark Responses request failed with status ${response.status}`);
      }

      const payload = await response.json();
      return JSON.parse(stripJsonFence(extractOutputText(payload)));
    },
  };
}

interface ArkBodyOptions {
  model: string;
  enableWebSearch: boolean;
  webSearchMaxKeyword: number;
  webSearchLimit: number;
}

function buildArkResponsesBody(input: ProviderGenerateJsonInput, options: ArkBodyOptions) {
  const body: Record<string, unknown> = {
    model: input.model ?? options.model,
    stream: false,
    input: [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ],
    text: {
      format: input.schema
        ? {
            type: "json_schema",
            name: input.schema.name,
            strict: true,
            schema: input.schema.schema,
          }
        : { type: "json_object" },
    },
  };

  if (options.enableWebSearch && input.role === "researcher") {
    body.tools = [
      {
        type: "web_search",
        max_keyword: options.webSearchMaxKeyword,
        limit: options.webSearchLimit,
      },
    ];
  }

  return body;
}

function extractOutputText(payload: unknown) {
  if (isRecord(payload) && typeof payload.output_text === "string") {
    return payload.output_text;
  }

  if (isRecord(payload) && Array.isArray(payload.output)) {
    for (const outputItem of payload.output) {
      if (!isRecord(outputItem) || !Array.isArray(outputItem.content)) {
        continue;
      }

      for (const contentItem of outputItem.content) {
        if (isRecord(contentItem) && typeof contentItem.text === "string") {
          return contentItem.text;
        }
      }
    }
  }

  throw new Error("Ark Responses payload did not include JSON output text.");
}

function stripJsonFence(content: string) {
  return content
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
