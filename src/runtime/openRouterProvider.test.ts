import { describe, expect, it, vi } from "vitest";
import { createOpenRouterProvider } from "./openRouterProvider";

describe("OpenRouter provider adapter", () => {
  it("calls OpenRouter through one structured JSON entrypoint", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({ task_type: "prd", confidence: "medium" }),
            },
          },
        ],
      }),
    })) as unknown as typeof fetch;

    const provider = createOpenRouterProvider({
      apiKey: "test-key",
      model: "openai/gpt-4.1-mini",
      fetchImpl: fetchMock,
    });

    const result = await provider.generateJson({
      role: "conductor",
      system: "Return JSON only.",
      user: "Draft a PRD.",
    });

    expect(result).toEqual({ task_type: "prd", confidence: "medium" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        }),
      }),
    );
  });
});
