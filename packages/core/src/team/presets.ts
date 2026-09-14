import type { AgentDefinition, TeamDefinition } from "@ytriple/shared";
import { TOOL_NAMES } from "../tools/toolNames.js";
import { isRoleAllowedForSlot, requireRole, type RoleSlotKind } from "./roleLibrary.js";

/**
 * Teams are data. `prd.default` reproduces the familiar three-person workshop,
 * but nothing in the runtime assumes three members or these particular roles.
 */
export const DEFAULT_TEAM_ID = "prd.default";

const READ_ONLY_WORKSPACE_TOOLS = [
  TOOL_NAMES.listWorkspaceFiles,
  TOOL_NAMES.readWorkspaceFile,
  TOOL_NAMES.searchWorkspaceText,
] as const;

export function createDefaultTeam(): TeamDefinition {
  return {
    teamId: DEFAULT_TEAM_ID,
    name: "PRD Workshop",
    description:
      "Conductor plus a researcher and a product reviewer. One shared conversation, one prd.md.",
    orchestratorId: "conductor",
    workflow: "intake_brief_dispatch_merge",
    members: [
      {
        agentId: "conductor",
        displayName: "Conductor",
        role: requireRole("agents-orchestrator"),
        tools: [...READ_ONLY_WORKSPACE_TOOLS, TOOL_NAMES.createOutputDocument],
        canSpawnSubAgents: false,
        maxSubAgentDepth: 0,
      },
      {
        agentId: "researcher",
        displayName: "Researcher",
        role: requireRole("product-trend-researcher"),
        tools: [...READ_ONLY_WORKSPACE_TOOLS, TOOL_NAMES.webSearch, TOOL_NAMES.spawnSubAgent],
        canSpawnSubAgents: true,
        maxSubAgentDepth: 1,
      },
      {
        agentId: "specialist",
        displayName: "Specialist",
        role: requireRole("product-manager"),
        tools: [...READ_ONLY_WORKSPACE_TOOLS],
        canSpawnSubAgents: false,
        maxSubAgentDepth: 0,
      },
    ],
  };
}

export interface RoleSelection {
  agentId: string;
  slot: RoleSlotKind;
  roleId: string;
}

/**
 * Task-level role selection. The workflow, the member count and the output
 * contract are unaffected; only the bound profile changes.
 */
export function applyRoleSelection(
  team: TeamDefinition,
  selections: readonly RoleSelection[],
): TeamDefinition {
  const members = team.members.map((member): AgentDefinition => {
    const selection = selections.find((entry) => entry.agentId === member.agentId);
    if (!selection) return member;

    if (!isRoleAllowedForSlot(selection.slot, selection.roleId)) {
      throw new Error(
        `Role "${selection.roleId}" is not on the curated allowlist for the ${selection.slot} slot`,
      );
    }
    if (selection.slot === "orchestrator" && member.agentId !== team.orchestratorId) {
      throw new Error(`Agent ${member.agentId} is not the orchestrator of team ${team.teamId}`);
    }

    const role = requireRole(selection.roleId);
    return { ...member, role, displayName: member.displayName };
  });

  return { ...team, members };
}

export function validateTeam(team: TeamDefinition): void {
  if (team.members.length === 0) {
    throw new Error(`Team ${team.teamId} has no members`);
  }
  if (!team.members.some((member) => member.agentId === team.orchestratorId)) {
    throw new Error(`Team ${team.teamId} has no member matching orchestratorId ${team.orchestratorId}`);
  }

  const seen = new Set<string>();
  for (const member of team.members) {
    if (seen.has(member.agentId)) {
      throw new Error(`Team ${team.teamId} has duplicate agentId ${member.agentId}`);
    }
    seen.add(member.agentId);

    if (member.canSpawnSubAgents && member.maxSubAgentDepth < 1) {
      throw new Error(
        `Agent ${member.agentId} may spawn sub-agents but has maxSubAgentDepth ${member.maxSubAgentDepth}`,
      );
    }
    if (member.tools.includes(TOOL_NAMES.spawnSubAgent) && !member.canSpawnSubAgents) {
      throw new Error(
        `Agent ${member.agentId} lists ${TOOL_NAMES.spawnSubAgent} but canSpawnSubAgents is false`,
      );
    }
  }

  const orchestrator = team.members.find((member) => member.agentId === team.orchestratorId);
  if (orchestrator && !orchestrator.tools.includes(TOOL_NAMES.createOutputDocument)) {
    throw new Error(
      `Orchestrator ${team.orchestratorId} must hold ${TOOL_NAMES.createOutputDocument}; it owns the single output contract`,
    );
  }
}
