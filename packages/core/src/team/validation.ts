import type {
  ModelBinding,
  ProviderCapabilities,
  TeamDefinition,
} from "@ytriple/shared";
import { MAX_TEAM_MEMBERS, REGISTERED_WORKFLOWS, modelBindingFor } from "@ytriple/shared";
import { TOOL_NAMES, isKnownTool } from "../tools/toolNames.js";

export interface TeamValidationIssue {
  rule: string;
  message: string;
}

/**
 * Resolves a binding to its capability table. Optional: without it the
 * structural rules still run, which is what a UI wants while editing.
 */
export type CapabilityLookup = (binding: ModelBinding) => ProviderCapabilities | undefined;

export interface ValidateTeamOptions {
  capabilities?: CapabilityLookup;
}

/**
 * Every rule here rejects a team before it can run. A capability mismatch is a
 * configuration error, never something the runtime discovers mid-task.
 */
export function validateTeam(
  team: TeamDefinition,
  options: ValidateTeamOptions = {},
): TeamValidationIssue[] {
  const issues: TeamValidationIssue[] = [];

  if (!REGISTERED_WORKFLOWS.includes(team.workflow)) {
    issues.push({
      rule: "workflow.registered",
      message: `Workflow "${team.workflow}" is not registered. Known: ${REGISTERED_WORKFLOWS.join(", ")}`,
    });
  }

  if (team.members.length === 0) {
    issues.push({ rule: "members.nonEmpty", message: `Team ${team.teamId} has no members` });
  }
  if (team.members.length > MAX_TEAM_MEMBERS) {
    issues.push({
      rule: "members.maxSize",
      message: `Team ${team.teamId} has ${team.members.length} members; the maximum is ${MAX_TEAM_MEMBERS}`,
    });
  }

  const seen = new Set<string>();
  for (const member of team.members) {
    if (seen.has(member.agentId)) {
      issues.push({
        rule: "members.uniqueAgentId",
        message: `Duplicate agentId "${member.agentId}"`,
      });
    }
    seen.add(member.agentId);
  }

  if (!seen.has(team.orchestratorId)) {
    issues.push({
      rule: "orchestrator.exists",
      message: `orchestratorId "${team.orchestratorId}" does not match any member`,
    });
  }

  for (const member of team.members) {
    const isOrchestrator = member.agentId === team.orchestratorId;

    if (!isOrchestrator && member.tools.includes(TOOL_NAMES.createOutputDocument)) {
      issues.push({
        rule: "tools.outputOwnership",
        message: `Member "${member.agentId}" holds ${TOOL_NAMES.createOutputDocument}; only the orchestrator may write the deliverable`,
      });
    }

    for (const tool of member.tools) {
      if (!isKnownTool(tool)) {
        issues.push({
          rule: "tools.known",
          message: `Member "${member.agentId}" lists unknown tool "${tool}"`,
        });
      }
    }

    if (member.canSpawnSubAgents && !member.subAgentBudget) {
      issues.push({
        rule: "subAgents.budgetRequired",
        message: `Member "${member.agentId}" may spawn sub-agents but has no subAgentBudget`,
      });
    }
    if (member.subAgentBudget && member.subAgentBudget.maxDepth > 2) {
      issues.push({
        rule: "subAgents.maxDepth",
        message: `Member "${member.agentId}" declares subAgentBudget.maxDepth ${member.subAgentBudget.maxDepth}; the maximum is 2`,
      });
    }
    if (member.tools.includes(TOOL_NAMES.spawnSubAgent) && !member.canSpawnSubAgents) {
      issues.push({
        rule: "subAgents.permission",
        message: `Member "${member.agentId}" lists ${TOOL_NAMES.spawnSubAgent} but canSpawnSubAgents is false`,
      });
    }

    const capabilities = options.capabilities?.(modelBindingFor(team, member));
    if (!capabilities) continue;

    if (member.tools.length > 0 && capabilities.toolCalling === "none") {
      issues.push({
        rule: "model.toolCalling",
        message: `Member "${member.agentId}" has ${member.tools.length} tool(s) but its model declares toolCalling="none"`,
      });
    }
    if (isOrchestrator && capabilities.structuredOutput === "none") {
      issues.push({
        rule: "model.orchestratorStructuredOutput",
        message: `Orchestrator "${member.agentId}" is bound to a model with structuredOutput="none"; it must produce a reliable Task Brief and merge result`,
      });
    }
  }

  return issues;
}

export function assertValidTeam(team: TeamDefinition, options: ValidateTeamOptions = {}): void {
  const issues = validateTeam(team, options);
  if (issues.length === 0) return;
  throw new Error(
    `Team ${team.teamId} is invalid:\n${issues
      .map((issue) => `  - [${issue.rule}] ${issue.message}`)
      .join("\n")}`,
  );
}
