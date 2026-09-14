import type { AgentDefinition, RuntimeEventBody, SubAgentBudget } from "@ytriple/shared";
import { describe, expect, it } from "vitest";
import { createModelCaller } from "../agent/modelCall.js";
import { createFakeClock, createScriptedProviderAdapter } from "../testing/fakes.js";
import { createToolRegistry } from "../tools/registry.js";
import { TOOL_NAMES } from "../tools/toolNames.js";
import { requireRole } from "../team/roleLibrary.js";
import { createSubAgentLedger, SubAgentBudgetError } from "./budget.js";
import { checkSpawnConstraints, runSubAgent, type SubAgentDeps } from "./subAgentRunner.js";
import { DEFAULT_RUNTIME_LIMITS } from "@ytriple/shared";

const budget: SubAgentBudget = {
  maxDepth: 1,
  maxSpawns: 2,
  maxTokens: 4_000,
  maxWallClockMs: 60_000,
};

function parentAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    agentId: "researcher",
    displayName: "Researcher",
    role: requireRole("product-trend-researcher"),
    tools: [TOOL_NAMES.webSearch, TOOL_NAMES.readWorkspaceFile, TOOL_NAMES.spawnSubAgent],
    canSpawnSubAgents: true,
    subAgentBudget: budget,
    ...overrides,
  };
}

function ledgerFor(subAgentBudget: SubAgentBudget = budget, now = () => 0) {
  return createSubAgentLedger(subAgentBudget, now);
}

describe("the three spawn constraints", () => {
  it("refuses a member that may not spawn at all", () => {
    const parent = parentAgent({ canSpawnSubAgents: false, ...{ subAgentBudget: undefined } });
    expect(
      checkSpawnConstraints(
        { objective: "o", instructions: "i", tools: [], maxTokens: 100 },
        { parent, parentDepth: 0, ledger: ledgerFor() },
      ),
    ).toEqual({
      reason: "permission_denied",
      detail: "researcher is not allowed to spawn sub-agents",
    });
  });

  it("refuses a spawn deeper than the declared depth", () => {
    expect(
      checkSpawnConstraints(
        { objective: "o", instructions: "i", tools: [], maxTokens: 100 },
        { parent: parentAgent(), parentDepth: 1, ledger: ledgerFor() },
      ),
    ).toEqual({
      reason: "depth_exceeded",
      detail: "spawning at depth 2 exceeds maxDepth 1 for researcher",
    });
  });

  it("refuses a tool the parent does not hold, so escalation is impossible", () => {
    const rejection = checkSpawnConstraints(
      {
        objective: "o",
        instructions: "i",
        tools: [TOOL_NAMES.webSearch, TOOL_NAMES.createOutputDocument],
        maxTokens: 100,
      },
      { parent: parentAgent(), parentDepth: 0, ledger: ledgerFor() },
    );

    expect(rejection?.reason).toBe("tools_not_subset");
    expect(rejection?.detail).toContain(TOOL_NAMES.createOutputDocument);
    expect(rejection?.detail).toContain("only inherit a subset");
  });

  it("refuses when the shared token pool cannot cover the request", () => {
    expect(
      checkSpawnConstraints(
        { objective: "o", instructions: "i", tools: [], maxTokens: 9_000 },
        { parent: parentAgent(), parentDepth: 0, ledger: ledgerFor() },
      ),
    ).toEqual({
      reason: "token_budget_exhausted",
      detail: "requested 9000 tokens but only 4000 of 4000 remain in the shared pool",
    });
  });

  it("refuses once the spawn count is used up", () => {
    const ledger = ledgerFor();
    ledger.openChild("a", 10);
    ledger.openChild("b", 10);

    expect(
      checkSpawnConstraints(
        { objective: "o", instructions: "i", tools: [], maxTokens: 10 },
        { parent: parentAgent(), parentDepth: 0, ledger },
      ),
    ).toMatchObject({ reason: "spawn_limit_reached" });
  });

  it("refuses once the wall clock budget is spent", () => {
    let now = 0;
    const ledger = createSubAgentLedger(budget, () => now);
    now = budget.maxWallClockMs + 1;

    expect(
      checkSpawnConstraints(
        { objective: "o", instructions: "i", tools: [], maxTokens: 10 },
        { parent: parentAgent(), parentDepth: 0, ledger },
      ),
    ).toMatchObject({ reason: "wall_clock_exceeded" });
  });

  it("accepts a request that satisfies all three", () => {
    expect(
      checkSpawnConstraints(
        { objective: "o", instructions: "i", tools: [TOOL_NAMES.webSearch], maxTokens: 1_000 },
        { parent: parentAgent(), parentDepth: 0, ledger: ledgerFor() },
      ),
    ).toBeUndefined();
  });
});

describe("sub-agent ledger", () => {
  it("charges the child and the shared pool together", () => {
    const ledger = ledgerFor();
    const child = ledger.openChild("sub-1", 1_000);

    child.charge({ inputTokens: 100, outputTokens: 50 });
    expect(child.usedTokens).toBe(150);
    expect(ledger.usedTokens).toBe(150);
    expect(ledger.remainingTokens).toBe(3_850);
  });

  it("aborts a child that overruns its own slice", () => {
    const ledger = ledgerFor();
    const child = ledger.openChild("sub-1", 100);

    expect(() => child.charge({ inputTokens: 200, outputTokens: 0 })).toThrowError(
      SubAgentBudgetError,
    );
  });

  it("aborts when the shared pool runs dry across children", () => {
    const ledger = createSubAgentLedger({ ...budget, maxTokens: 300, maxSpawns: 3 }, () => 0);
    ledger.openChild("sub-1", 200).charge({ inputTokens: 200, outputTokens: 0 });
    const second = ledger.openChild("sub-2", 200);

    expect(() => second.charge({ inputTokens: 200, outputTokens: 0 })).toThrowError(
      /shared sub-agent pool of 300 tokens is exhausted/,
    );
  });
});

describe("runSubAgent", () => {
  function depsFor(
    handlers: Record<string, (request: unknown) => unknown>,
    overrides: Partial<SubAgentDeps> = {},
  ): { deps: SubAgentDeps; events: RuntimeEventBody[] } {
    const events: RuntimeEventBody[] = [];
    const clock = createFakeClock();
    const adapter = createScriptedProviderAdapter({ handlers });
    let counter = 0;

    const deps: SubAgentDeps = {
      parent: parentAgent(),
      parentDepth: 0,
      binding: { providerId: "p", modelId: "m" },
      ledger: createSubAgentLedger(budget, () => clock.now()),
      registry: createToolRegistry([]),
      modelCaller: createModelCaller({
        resolveBinding: async () => ({
          adapter,
          model: { modelId: "m", displayName: "M" },
        }),
        limits: DEFAULT_RUNTIME_LIMITS,
        emit: (body) => events.push(body),
      }),
      grounding: { requested: false },
      maxRounds: 1,
      maxToolCallsPerRound: 2,
      emit: (body) => events.push(body),
      nextSubAgentId: () => `researcher.sub-${++counter}`,
      ...overrides,
    };

    return { deps, events };
  }

  it("runs the objective and reports back to the parent only", async () => {
    const { deps, events } = depsFor({
      subagent_work: () => ({
        summary: "Three competing tools exist.",
        findings: ["Tool A focuses on templates", "Tool B focuses on interviews"],
      }),
    });

    const outcome = await runSubAgent(
      { objective: "Map competitors", instructions: "Be brief", tools: [], maxTokens: 2_000 },
      deps,
    );

    expect(outcome).toMatchObject({
      subAgentId: "researcher.sub-1",
      summary: "Three competing tools exist.",
      incomplete: false,
    });

    const types = events.map((event) => event.type);
    expect(types).toContain("subagent_spawned");
    expect(types).toContain("subagent_completed");
    // Sub-agents never produce chat or contribution events of their own.
    expect(types).not.toContain("agent_message");
    expect(types).not.toContain("agent_contribution");
  });

  it("strips the spawn tool from a child that has hit the depth limit", async () => {
    const { deps, events } = depsFor({
      subagent_work: () => ({ summary: "done", findings: [] }),
    });

    await runSubAgent(
      {
        objective: "Map competitors",
        instructions: "Be brief",
        tools: [TOOL_NAMES.webSearch, TOOL_NAMES.spawnSubAgent],
        maxTokens: 2_000,
      },
      deps,
    );

    const spawned = events.find((event) => event.type === "subagent_spawned");
    expect(spawned).toMatchObject({ tools: [TOOL_NAMES.webSearch], depth: 1 });
  });

  it("aborts a child that burns through its slice and hands the parent a gap", async () => {
    const { deps, events } = depsFor({
      subagent_work: () => ({
        text: JSON.stringify({ summary: "partial", findings: ["one"] }),
        toolCalls: [],
        usage: { inputTokens: 1_500, outputTokens: 1_500 },
        degradations: [],
      }),
    });

    const outcome = await runSubAgent(
      { objective: "Map competitors", instructions: "Be brief", tools: [], maxTokens: 500 },
      deps,
    );

    expect(outcome).toMatchObject({ incomplete: true, abortReason: "token_budget_exhausted" });
    expect(events.find((event) => event.type === "subagent_aborted")).toMatchObject({
      reason: "token_budget_exhausted",
    });
  });

  it("returns the rejection instead of spawning when a constraint fails", async () => {
    const { deps, events } = depsFor({ subagent_work: () => ({ summary: "", findings: [] }) });

    const outcome = await runSubAgent(
      {
        objective: "Write the PRD",
        instructions: "go",
        tools: [TOOL_NAMES.createOutputDocument],
        maxTokens: 100,
      },
      deps,
    );

    expect(outcome).toMatchObject({ reason: "tools_not_subset" });
    expect(events).toHaveLength(0);
  });
});
