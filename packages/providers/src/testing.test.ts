import type { GenerateRequest, ModelConfig } from "@ytriple/shared";
import { describe, expect, it } from "vitest";
import { baselineFor } from "./capabilities.js";
import {
  createJsonScriptedAdapter,
  createRecordingAdapter,
  createReplayAdapter,
  createReplayRouter,
  recordingKey,
  type ProviderRecording,
} from "./testing.js";

const model: ModelConfig = { modelId: "test-model", displayName: "Test" };

function requestFor(phase: string, round = 0, agentId = "member-a"): GenerateRequest {
  return {
    model,
    system: "system",
    messages: [{ role: "user", content: "user" }],
    metadata: { agentId, phase, round },
  };
}

describe("scripted adapter", () => {
  it("answers per phase and records the requests it saw", async () => {
    const adapter = createJsonScriptedAdapter({
      plan: () => ({ reasoning: "look it up" }),
      synthesis: () => ({ summary: "done" }),
    });

    expect((await adapter.generate(requestFor("plan"))).text).toBe('{"reasoning":"look it up"}');
    expect((await adapter.generate(requestFor("synthesis"))).text).toBe('{"summary":"done"}');
    expect(adapter.requests.map((request) => request.metadata.phase)).toEqual(["plan", "synthesis"]);
  });

  it("fails loudly on an unscripted phase", async () => {
    const adapter = createJsonScriptedAdapter({ plan: () => ({}) });
    await expect(adapter.generate(requestFor("merge"))).rejects.toThrowError(
      /No scripted handler for phase "merge" \(known: plan\)/,
    );
  });

  it("can return a full result so a test can script tool calls", async () => {
    const adapter = createJsonScriptedAdapter({
      plan: () => ({
        text: "",
        toolCalls: [{ toolCallId: "c1", name: "web_search", arguments: { query: "x" } }],
        usage: { inputTokens: 1, outputTokens: 1 },
        degradations: [],
      }),
    });

    expect((await adapter.generate(requestFor("plan"))).toolCalls[0]?.name).toBe("web_search");
  });
});

describe("record then replay", () => {
  const recording: ProviderRecording = {
    providerId: "ark-personal",
    adapterId: "ark",
    capabilities: baselineFor("ark"),
    entries: [
      {
        key: recordingKey({ agentId: "member-a", phase: "synthesis", round: 0 }),
        phase: "synthesis",
        agentId: "member-a",
        result: {
          text: '{"summary":"from recording"}',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          degradations: [],
        },
      },
    ],
  };

  it("replays an exact key", async () => {
    const adapter = createReplayAdapter(recording);
    expect((await adapter.generate(requestFor("synthesis"))).text).toBe(
      '{"summary":"from recording"}',
    );
  });

  it("falls back to the next unused entry for the same agent and phase", async () => {
    const adapter = createReplayAdapter(recording);
    expect((await adapter.generate(requestFor("synthesis", 3))).text).toBe(
      '{"summary":"from recording"}',
    );
  });

  it("reports the available keys when nothing matches", async () => {
    const adapter = createReplayAdapter(recording, { allowPhaseFallback: false });
    await expect(adapter.generate(requestFor("merge", 0, "orchestrator"))).rejects.toThrowError(
      /Recording has no entry for "orchestrator#-#merge#0". Available keys: member-a#-#synthesis#0/,
    );
  });

  it("captures a live run into a replayable recording", async () => {
    const inner = createJsonScriptedAdapter({ synthesis: () => ({ summary: "live" }) });
    const recorder = createRecordingAdapter({ inner, model });

    await recorder.generate(requestFor("synthesis"));
    const replayed = createReplayAdapter(recorder.recording);

    expect(recorder.recording.entries[0]?.key).toBe("member-a#-#synthesis#0");
    expect((await replayed.generate(requestFor("synthesis"))).text).toBe('{"summary":"live"}');
  });

  /**
   * A run where members use different providers records one entry set per
   * provider. Replaying only the first put one member's answers in front of
   * another member's model.
   */
  it("routes a multi-provider recording to the right adapter", async () => {
    const second: ProviderRecording = {
      ...recording,
      providerId: "gemini-fast",
      entries: [
        {
          key: recordingKey({ agentId: "member-b", phase: "synthesis", round: 0 }),
          phase: "synthesis",
          agentId: "member-b",
          result: {
            text: '{"summary":"from the second provider"}',
            toolCalls: [],
            usage: { inputTokens: 1, outputTokens: 1 },
            degradations: [],
          },
        },
      ],
    };

    const route = createReplayRouter([recording, second]);

    expect((await route("ark-personal").generate(requestFor("synthesis"))).text).toBe(
      '{"summary":"from recording"}',
    );
    expect(
      (await route("gemini-fast").generate(requestFor("synthesis", 0, "member-b"))).text,
    ).toBe('{"summary":"from the second provider"}');
  });

  it("names the recorded providers when a binding matches none of them", () => {
    const route = createReplayRouter([recording, { ...recording, providerId: "other" }]);
    expect(() => route("missing")).toThrowError(
      /No recording for provider "missing". Recorded providers: ark-personal, other/,
    );
  });

  it("lets a single-provider recording answer any binding", async () => {
    const route = createReplayRouter([recording]);
    expect((await route("renamed-provider").generate(requestFor("synthesis"))).text).toBe(
      '{"summary":"from recording"}',
    );
  });

  it("keys sub-agent calls separately from their parent", () => {
    expect(recordingKey({ agentId: "member-a", phase: "plan", round: 1, subAgentId: "sub-1" })).toBe(
      "member-a#sub-1#plan#1",
    );
  });
});
