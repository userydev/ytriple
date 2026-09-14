import type { ProviderRequest } from "@ytriple/shared";
import { describe, expect, it } from "vitest";
import { capabilitiesFor } from "./capabilities.js";
import {
  createJsonScriptedProvider,
  createRecordingProvider,
  createReplayProvider,
  recordingKey,
  type ProviderRecording,
} from "./testing.js";

function requestFor(phase: string, round = 0, agentId = "researcher"): ProviderRequest {
  return {
    system: "system",
    user: "user",
    metadata: { agentId, phase, round },
  };
}

describe("scripted provider", () => {
  it("answers per phase and records the requests it saw", async () => {
    const provider = createJsonScriptedProvider({
      plan: () => ({ tool_calls: [] }),
      synthesis: () => ({ summary: "done" }),
    });

    expect((await provider.complete(requestFor("plan"))).text).toBe('{"tool_calls":[]}');
    expect((await provider.complete(requestFor("synthesis"))).text).toBe('{"summary":"done"}');
    expect(provider.requests.map((request) => request.metadata.phase)).toEqual([
      "plan",
      "synthesis",
    ]);
  });

  it("fails loudly on an unscripted phase", async () => {
    const provider = createJsonScriptedProvider({ plan: () => ({}) });
    await expect(provider.complete(requestFor("merge"))).rejects.toThrowError(
      /No scripted handler for phase "merge" \(known: plan\)/,
    );
  });
});

describe("record then replay", () => {
  const recording: ProviderRecording = {
    providerId: "ark-default",
    kind: "ark",
    model: "doubao-seed-1-6",
    capabilities: capabilitiesFor("ark"),
    entries: [
      {
        key: recordingKey({ agentId: "researcher", phase: "synthesis", round: 0 }),
        phase: "synthesis",
        agentId: "researcher",
        response: { text: '{"summary":"from recording"}', usage: { promptTokens: 1, completionTokens: 1 } },
      },
    ],
  };

  it("replays an exact key", async () => {
    const provider = createReplayProvider(recording);
    expect((await provider.complete(requestFor("synthesis"))).text).toBe(
      '{"summary":"from recording"}',
    );
  });

  it("falls back to the next unused entry of the same agent and phase", async () => {
    const provider = createReplayProvider(recording);
    expect((await provider.complete(requestFor("synthesis", 3))).text).toBe(
      '{"summary":"from recording"}',
    );
  });

  it("reports the available keys when nothing matches", async () => {
    const provider = createReplayProvider(recording, { allowPhaseFallback: false });
    await expect(provider.complete(requestFor("merge", 0, "conductor"))).rejects.toThrowError(
      /Recording has no entry for "conductor#-#merge#0". Available keys: researcher#-#synthesis#0/,
    );
  });

  it("captures a live run into a replayable recording", async () => {
    const inner = createJsonScriptedProvider({ synthesis: () => ({ summary: "live" }) });
    const recorder = createRecordingProvider({ inner });

    await recorder.complete(requestFor("synthesis"));
    const replayed = createReplayProvider(recorder.recording);

    expect(recorder.recording.entries[0]?.key).toBe("researcher#-#synthesis#0");
    expect((await replayed.complete(requestFor("synthesis"))).text).toBe('{"summary":"live"}');
  });

  it("keys sub-agent calls separately from their parent", () => {
    expect(recordingKey({ agentId: "researcher", phase: "plan", round: 1, subAgentId: "sub-1" })).toBe(
      "researcher#sub-1#plan#1",
    );
  });
});
