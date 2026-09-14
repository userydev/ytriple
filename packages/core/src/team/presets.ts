import type { AgentDefinition, ModelBinding, TeamDefinition } from "@ytriple/shared";
import { TOOL_NAMES } from "../tools/toolNames.js";
import { isRoleCompatible, requireRole } from "./roleLibrary.js";

export const DEFAULT_TEAM_ID = "prd.default";

/**
 * The one built-in preset. Three members is the shape of `prd.default`, not the
 * shape of the product: orchestration reads `members`, so a two- or five-member
 * team runs the same code.
 */
export function createDefaultTeam(defaultModel: ModelBinding): TeamDefinition {
  return {
    teamId: DEFAULT_TEAM_ID,
    name: "PRD Workshop",
    description: "Turn a vague product idea into a PRD draft worth handing to a developer.",
    orchestratorId: "conductor",
    workflow: "intake_brief_dispatch_merge",
    outputContract: { primaryDocument: "prd.md" },
    defaultModel,
    members: [
      {
        agentId: "conductor",
        displayName: "Conductor",
        role: requireRole("agents-orchestrator"),
        tools: [TOOL_NAMES.createOutputDocument],
        canSpawnSubAgents: false,
      },
      {
        agentId: "researcher",
        displayName: "Researcher",
        role: requireRole("product-trend-researcher"),
        tools: [
          TOOL_NAMES.webSearch,
          TOOL_NAMES.readWorkspaceFile,
          TOOL_NAMES.searchWorkspaceText,
          TOOL_NAMES.spawnSubAgent,
        ],
        canSpawnSubAgents: true,
        subAgentBudget: {
          maxDepth: 1,
          maxSpawns: 2,
          maxTokens: 40_000,
          maxWallClockMs: 120_000,
        },
      },
      {
        agentId: "specialist",
        displayName: "Specialist",
        role: requireRole("product-manager"),
        tools: [
          TOOL_NAMES.listWorkspaceFiles,
          TOOL_NAMES.readWorkspaceFile,
          TOOL_NAMES.searchWorkspaceText,
        ],
        canSpawnSubAgents: false,
      },
    ],
  };
}

export interface RoleSelection {
  agentId: string;
  roleId: string;
}

/**
 * Task-level role selection. Changing a member's perspective must not change
 * the workflow, the team size or the output contract, so only `role` moves.
 */
export function applyRoleSelection(
  team: TeamDefinition,
  selections: readonly RoleSelection[],
): TeamDefinition {
  const members = team.members.map((member): AgentDefinition => {
    const selection = selections.find((entry) => entry.agentId === member.agentId);
    if (!selection) return member;

    const isOrchestrator = member.agentId === team.orchestratorId;
    if (isOrchestrator) {
      throw new Error(
        `Role for ${member.agentId} is locked: orchestrator roles are part of the control plane`,
      );
    }
    if (!isRoleCompatible(selection.roleId, "generic")) {
      throw new Error(
        `Role "${selection.roleId}" is not curated for a contributor seat; pick one from the catalog`,
      );
    }

    return { ...member, role: requireRole(selection.roleId) };
  });

  return { ...team, members };
}
