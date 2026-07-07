import { describe, expect, it, vi } from "vitest";
import { createArkResponsesProvider } from "./arkResponsesProvider";

describe("Ark Responses provider adapter", () => {
  it("calls Volcengine Ark Responses API with structured JSON output", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({ task_type: "prd", confidence: "medium" }),
              },
            ],
          },
        ],
      }),
    }));

    const provider = createArkResponsesProvider({
      apiKey: "test-key",
      model: "doubao-seed-2-1-pro-260628",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const result = await provider.generateJson({
      role: "conductor",
      system: "Return JSON only.",
      user: "Draft a PRD.",
      schema: {
        name: "conductor_output",
        schema: {
          type: "object",
          properties: {
            task_type: { type: "string" },
            confidence: { type: "string" },
          },
          required: ["task_type", "confidence"],
          additionalProperties: false,
        },
      },
    });

    expect(result).toEqual({ task_type: "prd", confidence: "medium" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://ark.cn-beijing.volces.com/api/v3/responses",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        }),
      }),
    );

    const fetchCalls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const body = JSON.parse(String(fetchCalls[0]?.[1]?.body));
    expect(body).toMatchObject({
      model: "doubao-seed-2-1-pro-260628",
      text: {
        format: {
          type: "json_schema",
          name: "conductor_output",
          strict: true,
        },
      },
    });
    expect(body.input).toEqual([
      { role: "system", content: "Return JSON only." },
      { role: "user", content: "Draft a PRD." },
    ]);
  });

  it("enables Ark built-in Web Search only for the Researcher role", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        output_text: JSON.stringify({ summary: "ok" }),
      }),
    }));

    const provider = createArkResponsesProvider({
      apiKey: "test-key",
      model: "doubao-seed-2-1-pro-260628",
      enableWebSearch: true,
      webSearchMaxKeyword: 2,
      webSearchLimit: 5,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await provider.generateJson({
      role: "researcher",
      system: "Return JSON.",
      user: "Research this.",
    });
    await provider.generateJson({
      role: "specialist",
      system: "Return JSON.",
      user: "Review this.",
    });

    const fetchCalls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const researcherBody = JSON.parse(String(fetchCalls[0]?.[1]?.body));
    const specialistBody = JSON.parse(String(fetchCalls[1]?.[1]?.body));
    expect(researcherBody.tools).toEqual([{ type: "web_search", max_keyword: 2, limit: 5 }]);
    expect(specialistBody.tools).toBeUndefined();
  });
});
