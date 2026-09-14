import type { NamedJsonSchema, RuntimeEventBody } from "@ytriple/shared";
import { DEFAULT_RUNTIME_LIMITS, ProviderError } from "@ytriple/shared";
import { describe, expect, it } from "vitest";
import { CONTEXT_PRIORITY } from "../context/contextBudget.js";
import { createScriptedProviderAdapter } from "../testing/fakes.js";
import { createModelCaller, type ModelCallOptions } from "./modelCall.js";

const schema: NamedJsonSchema = {
  name: "answer",
  schema: {
    type: "object",
    required: ["summary"],
    properties: { summary: { type: "string" } },
  },
};

function optionsFor(overrides: Partial<ModelCallOptions> = {}): ModelCallOptions {
  return {
    agentId: "member-a",
    phase: "member_work",
    round: 0,
    binding: { providerId: "p", modelId: "m" },
    systemSections: [
      { id: "brief", priority: CONTEXT_PRIORITY.briefAndMemberTask, content: "the brief" },
    ],
    messages: [{ role: "user", content: "go" }],
    schema,
    ...overrides,
  };
}

function callerFor(
  handlers: Parameters<typeof createScriptedProviderAdapter>[0]["handlers"],
  capabilities?: Parameters<typeof createScriptedProviderAdapter>[0]["capabilities"],
) {
  const events: RuntimeEventBody[] = [];
  const adapter = createScriptedProviderAdapter({
    handlers,
    ...(capabilities ? { capabilities } : {}),
  });
  const caller = createModelCaller({
    resolveBinding: async () => ({ adapter, model: { modelId: "m", displayName: "M" } }),
    limits: DEFAULT_RUNTIME_LIMITS,
    emit: (body) => events.push(body),
  });
  return { caller, events, adapter };
}

describe("structured output repair", () => {
  it("returns the validated value on a clean first answer", async () => {
    const { caller, events } = callerFor({ member_work: () => ({ summary: "ok" }) });

    const outcome = await caller.call(optionsFor());
    expect(outcome.value).toEqual({ summary: "ok" });
    expect(events.filter((event) => event.type === "degradation")).toHaveLength(0);
    expect(events.filter((event) => event.type === "model_usage")).toHaveLength(1);
  });

  it("re-asks with the validation errors and reports the repair", async () => {
    let attempt = 0;
    const { caller, events, adapter } = callerFor({
      member_work: () => {
        attempt += 1;
        return attempt === 1 ? { wrong: true } : { summary: "repaired" };
      },
    });

    const outcome = await caller.call(optionsFor());

    expect(outcome.value).toEqual({ summary: "repaired" });
    expect(adapter.requests).toHaveLength(2);
    expect(adapter.requests[1]?.messages.at(-1)?.content).toContain(
      "$.summary: required property is missing",
    );
    expect(events.find((event) => event.type === "degradation")).toMatchObject({
      degradation: { kind: "structured_output", to: "repair_attempt_1" },
    });
  });

  it("gives up with schema_violation after the retry budget", async () => {
    const { caller, adapter } = callerFor({ member_work: () => ({ wrong: true }) });

    const error = (await caller.call(optionsFor()).catch((caught: unknown) => caught)) as ProviderError;
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.code).toBe("schema_violation");
    expect(adapter.requests).toHaveLength(DEFAULT_RUNTIME_LIMITS.maxSchemaRepairAttempts + 1);
  });

  it("accepts JSON wrapped in prose or fences", async () => {
    const { caller } = callerFor({
      member_work: () => '```json\n{"summary":"fenced"}\n```',
    });
    expect((await caller.call(optionsFor())).value).toEqual({ summary: "fenced" });
  });
});

describe("degradation reporting", () => {
  it("bubbles every degradation the adapter reports", async () => {
    const { caller, events } = callerFor({
      member_work: () => ({
        text: '{"summary":"ok"}',
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        degradations: [
          {
            kind: "native_web_search",
            from: "native",
            to: "search_port",
            detail: "model cannot ground",
          },
        ],
      }),
    });

    await caller.call(optionsFor());
    expect(events.filter((event) => event.type === "degradation")).toEqual([
      {
        type: "degradation",
        agentId: "member-a",
        degradation: {
          kind: "native_web_search",
          from: "native",
          to: "search_port",
          detail: "model cannot ground",
        },
      },
    ]);
  });

  it("reports a context trim before the call goes out", async () => {
    const { caller, events } = callerFor(
      { member_work: () => ({ summary: "ok" }) },
      { maxContextTokens: 400, maxOutputTokens: 100 },
    );

    await caller.call(
      optionsFor({
        systemSections: [
          { id: "brief", priority: CONTEXT_PRIORITY.briefAndMemberTask, content: "brief" },
          {
            id: "search",
            priority: CONTEXT_PRIORITY.rawSearchResults,
            content: "x".repeat(4_000),
          },
        ],
      }),
    );

    expect(events.find((event) => event.type === "degradation")).toMatchObject({
      degradation: { kind: "context_overflow", detail: expect.stringContaining("dropped search") },
    });
  });
});

describe("provider failures", () => {
  it("trims harder and retries once on a provider context_overflow", async () => {
    let attempt = 0;
    const { caller, adapter } = callerFor({
      member_work: () => {
        attempt += 1;
        if (attempt === 1) {
          throw new ProviderError("too long", { providerId: "p", code: "context_overflow" });
        }
        return { summary: "second try" };
      },
    });

    expect((await caller.call(optionsFor())).value).toEqual({ summary: "second try" });
    expect(adapter.requests).toHaveLength(2);
  });

  it("propagates a blocking provider error untouched", async () => {
    const { caller } = callerFor({
      member_work: () => {
        throw new ProviderError("bad key", { providerId: "p", code: "auth_failed" });
      },
    });

    const error = (await caller.call(optionsFor()).catch((caught: unknown) => caught)) as ProviderError;
    expect(error.code).toBe("auth_failed");
    expect(error.retryable).toBe(false);
  });
});

describe("tool calls", () => {
  it("returns tool calls without demanding a schema answer", async () => {
    const { caller } = callerFor({
      member_work: () => ({
        text: "",
        toolCalls: [{ toolCallId: "c1", name: "web_search", arguments: { query: "x" } }],
        usage: { inputTokens: 1, outputTokens: 1 },
        degradations: [],
      }),
    });

    const outcome = await caller.call(optionsFor());
    expect(outcome.value).toBeUndefined();
    expect(outcome.toolCalls).toHaveLength(1);
  });
});
