import type { ProviderAdapter, ProviderGenerateJsonInput } from "./types";

export interface OpenRouterProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export function createOpenRouterProvider({
  apiKey,
  model,
  baseUrl = "https://openrouter.ai/api/v1",
  fetchImpl = fetch,
}: OpenRouterProviderOptions): ProviderAdapter {
  return {
    async generateJson(input: ProviderGenerateJsonInput) {
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: input.model ?? model,
          messages: [
            { role: "system", content: input.system },
            { role: "user", content: input.user },
          ],
          response_format: { type: "json_object" },
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenRouter request failed with status ${response.status}`);
      }

      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new Error("OpenRouter response did not include message content.");
      }

      return JSON.parse(stripJsonFence(content));
    },
  };
}

function stripJsonFence(content: string) {
  return content
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "");
}
