import type {
  AgentDefinition,
  ModelBinding,
  ProviderCapabilities,
  TeamDefinition,
} from "@ytriple/shared";
import { describe, expect, it } from "vitest";
import { DEFAULT_FAKE_MODEL_CAPABILITIES } from "../testing/fakes.js";
import { TOOL_NAMES } from "../tools/toolNames.js";
import { applyRoleSelection, createDefaultTeam } from "./presets.js";
import { curatedRolesFor, isRoleLocked, requireRole, ROLE_CATALOG } from "./roleLibrary.js";
import { assertValidTeam, validateTeam } from "./validation.js";

const binding: ModelBinding = { providerId: "p", modelId: "m" };
const team = createDefaultTeam(binding);

function ruleIds(issues: Array<{ rule: string }>): string[] {
  return issues.map((issue) => issue.rule);
}

function withMembers(members: AgentDefinition[]): TeamDefinition {
  return { ...team, members };
}

function member(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    agentId: "member-a",
    displayName: "Member A",
    role: requireRole("generic-contributor"),
    tools: [],
    canSpawnSubAgents: false,
    ...overrides,
  };
}

const capabilities = (overrides: Partial<ProviderCapabilities> = {}) => () => ({
  ...DEFAULT_FAKE_MODEL_CAPABILITIES,
  ...overrides,
});

describe("prd.default preset", () => {
  it("is valid out of the box", () => {
    expect(validateTeam(team)).toEqual([]);
  });

  it("gives only the orchestrator the output tool", () => {
    for (const entry of team.members) {
      const holdsOutputTool = entry.tools.includes(TOOL_NAMES.createOutputDocument);
      expect(holdsOutputTool).toBe(entry.agentId === team.orchestratorId);
    }
  });

  it("declares a sub-agent budget for every member allowed to spawn", () => {
    for (const entry of team.members) {
      if (entry.canSpawnSubAgents) expect(entry.subAgentBudget).toBeDefined();
    }
  });
});

describe("validateTeam", () => {
  it("rejects an orchestratorId that matches no member", () => {
    expect(ruleIds(validateTeam({ ...team, orchestratorId: "ghost" }))).toContain(
      "orchestrator.exists",
    );
  });

  it("rejects duplicate agent ids", () => {
    expect(ruleIds(validateTeam(withMembers([member(), member()])))).toContain(
      "members.uniqueAgentId",
    );
  });

  it("rejects an empty team", () => {
    expect(ruleIds(validateTeam(withMembers([])))).toContain("members.nonEmpty");
  });

  it("rejects more than six members", () => {
    const members = Array.from({ length: 7 }, (_, index) =>
      member({ agentId: `member-${index}` }),
    );
    expect(ruleIds(validateTeam(withMembers(members)))).toContain("members.maxSize");
  });

  it("rejects a non-orchestrator holding the output tool", () => {
    const members = [
      member({ agentId: "conductor", tools: [TOOL_NAMES.createOutputDocument] }),
      member({ agentId: "member-a", tools: [TOOL_NAMES.createOutputDocument] }),
    ];
    expect(ruleIds(validateTeam(withMembers(members)))).toContain("tools.outputOwnership");
  });

  it("rejects an unknown tool name", () => {
    const members = [
      member({ agentId: "conductor", tools: [TOOL_NAMES.createOutputDocument] }),
      member({ agentId: "member-a", tools: ["delete_everything"] }),
    ];
    expect(ruleIds(validateTeam(withMembers(members)))).toContain("tools.known");
  });

  it("rejects a spawner without a budget", () => {
    const members = [
      member({ agentId: "conductor", tools: [TOOL_NAMES.createOutputDocument] }),
      member({ agentId: "member-a", canSpawnSubAgents: true }),
    ];
    expect(ruleIds(validateTeam(withMembers(members)))).toContain("subAgents.budgetRequired");
  });

  it("rejects a sub-agent depth beyond two", () => {
    const members = [
      member({ agentId: "conductor", tools: [TOOL_NAMES.createOutputDocument] }),
      member({
        agentId: "member-a",
        canSpawnSubAgents: true,
        subAgentBudget: { maxDepth: 3, maxSpawns: 1, maxTokens: 100, maxWallClockMs: 100 },
      }),
    ];
    expect(ruleIds(validateTeam(withMembers(members)))).toContain("subAgents.maxDepth");
  });

  it("rejects the spawn tool without spawn permission", () => {
    const members = [
      member({ agentId: "conductor", tools: [TOOL_NAMES.createOutputDocument] }),
      member({ agentId: "member-a", tools: [TOOL_NAMES.spawnSubAgent] }),
    ];
    expect(ruleIds(validateTeam(withMembers(members)))).toContain("subAgents.permission");
  });

  it("rejects an unregistered workflow", () => {
    expect(
      ruleIds(
        validateTeam({ ...team, workflow: "freeform_graph" as TeamDefinition["workflow"] }),
      ),
    ).toContain("workflow.registered");
  });

  it("rejects a tool-holding member bound to a model that cannot call tools", () => {
    const issues = validateTeam(team, { capabilities: capabilities({ toolCalling: "none" }) });
    expect(ruleIds(issues)).toContain("model.toolCalling");
  });

  it("rejects an orchestrator bound to a model with no structured output", () => {
    const issues = validateTeam(team, {
      capabilities: capabilities({ structuredOutput: "none" }),
    });
    expect(ruleIds(issues)).toContain("model.orchestratorStructuredOutput");
  });

  it("accepts capable models", () => {
    expect(validateTeam(team, { capabilities: capabilities() })).toEqual([]);
  });

  it("assertValidTeam reports every broken rule at once", () => {
    expect(() => assertValidTeam({ ...team, orchestratorId: "ghost" })).toThrowError(
      /\[orchestrator.exists\]/,
    );
  });
});

describe("role catalog", () => {
  it("offers only curated roles per compatibility tag", () => {
    const research = curatedRolesFor("research").map((entry) => entry.roleId);
    expect(research).toContain("product-trend-researcher");
    expect(research).not.toContain("agents-orchestrator");
    expect(ROLE_CATALOG.every((entry) => entry.curated)).toBe(true);
  });

  it("locks orchestrator-compatible roles", () => {
    expect(isRoleLocked("agents-orchestrator")).toBe(true);
    expect(isRoleLocked("product-manager")).toBe(false);
  });

  it("gives every role a declared contribution schema", () => {
    for (const entry of ROLE_CATALOG) {
      expect(requireRole(entry.roleId).outputSchema.name).toMatch(/\w+/);
    }
  });
});

describe("applyRoleSelection", () => {
  it("swaps a member's perspective without touching the workflow or team size", () => {
    const updated = applyRoleSelection(team, [
      { agentId: "researcher", roleId: "competitor-analyst" },
    ]);

    expect(updated.members).toHaveLength(team.members.length);
    expect(updated.workflow).toBe(team.workflow);
    expect(updated.outputContract).toEqual(team.outputContract);
    const researcher = updated.members.find((entry) => entry.agentId === "researcher");
    expect(researcher?.role.roleId).toBe("competitor-analyst");
    expect(researcher?.tools).toEqual(
      team.members.find((entry) => entry.agentId === "researcher")?.tools,
    );
  });

  it("refuses to replace the orchestrator role", () => {
    expect(() =>
      applyRoleSelection(team, [{ agentId: "conductor", roleId: "product-manager" }]),
    ).toThrowError(/locked/);
  });

  it("refuses a role outside the curated catalog", () => {
    expect(() =>
      applyRoleSelection(team, [{ agentId: "researcher", roleId: "agents-orchestrator" }]),
    ).toThrowError(/not curated for a contributor seat/);
  });
});
