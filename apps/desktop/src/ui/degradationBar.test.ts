import type { Degradation, RuntimeEvent } from "@ytriple/shared";
import { describe, expect, it } from "vitest";
import { createDefaultTeam } from "@ytriple/core";
import { buildTaskView } from "../state/taskView.js";
import { groupDegradations } from "./DegradationBar.js";

const team = createDefaultTeam({ providerId: "p", modelId: "m" });

function degradationEvent(
  seq: number,
  agentId: string,
  degradation: Degradation,
): RuntimeEvent {
  return { taskId: "task-1", seq, at: seq, body: { type: "degradation", agentId, degradation } };
}

/**
 * A grounded Gemini call gives up both its response schema and its function
 * declarations. The user has to be able to see that happened rather than
 * wondering why the answer came back unstructured.
 */
const GEMINI_GROUNDED: Degradation[] = [
  {
    kind: "structured_output",
    from: "json_schema",
    to: "json_mode",
    detail:
      "Gemini cannot combine search grounding with a response schema; the schema moved into the prompt for this grounded call",
  },
  {
    kind: "tool_calling",
    from: "function_tools",
    to: "search_only",
    detail:
      "Gemini cannot expose function declarations during a grounded call; tools are suspended for this turn",
  },
];

describe("groupDegradations", () => {
  it("collapses repeats of the same degradation into one row with a count", () => {
    const repeated = Array.from({ length: 5 }, () => ({
      degradation: GEMINI_GROUNDED[0]!,
      agentId: "researcher",
    }));

    const groups = groupDegradations(repeated);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.count).toBe(5);
    expect(groups[0]?.agentIds).toEqual(["researcher"]);
  });

  it("keeps different degradations apart and lists every agent affected", () => {
    const groups = groupDegradations([
      { degradation: GEMINI_GROUNDED[0]!, agentId: "researcher" },
      { degradation: GEMINI_GROUNDED[1]!, agentId: "researcher" },
      { degradation: GEMINI_GROUNDED[0]!, agentId: "specialist" },
    ]);

    expect(groups.map((group) => group.degradation.kind)).toEqual([
      "structured_output",
      "tool_calling",
    ]);
    expect(groups[0]?.count).toBe(2);
    expect(groups[0]?.agentIds).toEqual(["researcher", "specialist"]);
    expect(groups[1]?.count).toBe(1);
  });

  it("handles a degradation with no agent attached", () => {
    const groups = groupDegradations([{ degradation: GEMINI_GROUNDED[0]! }]);
    expect(groups[0]?.agentIds).toEqual([]);
  });
});

describe("the grounded-Gemini case reaches the UI", () => {
  it("shows both degradations, on the run and on the member", () => {
    const events = GEMINI_GROUNDED.map((degradation, index) =>
      degradationEvent(index, "researcher", degradation),
    );
    const view = buildTaskView(team, "task-1", events);
    const groups = groupDegradations(view.degradations);

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => `${group.degradation.from}→${group.degradation.to}`)).toEqual([
      "json_schema→json_mode",
      "function_tools→search_only",
    ]);

    const researcher = view.members.find((member) => member.agentId === "researcher");
    expect(researcher?.degradations).toHaveLength(2);
    // The detail explains what was traded away, not just that something was.
    expect(researcher?.degradations[1]?.detail).toContain("tools are suspended");
  });

  it("reports nothing when the run degraded nothing", () => {
    expect(groupDegradations(buildTaskView(team, "task-1", []).degradations)).toEqual([]);
  });
});
