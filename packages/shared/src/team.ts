export type AgentId = string;
export type TaskId = string;

/**
 * A role profile is data, not a code branch. Swapping the profile bound to an
 * agent changes prompts, question scope and execution focus without changing
 * the workflow or the output contract.
 */
export interface RoleProfile {
  roleId: string;
  displayName: string;
  kind: "orchestrator" | "contributor";
  responsibility: string;
  /** Injected verbatim into the system prompt. */
  instructions: readonly string[];
  /** What this role is allowed to ask the user about during intake. */
  questionPolicy: readonly string[];
  /** How this role works once dispatched. */
  executionPolicy: readonly string[];
  /** Section labels a UI should render for this agent's workbench. */
  panelSections: readonly string[];
  /** Provenance in the upstream agency-agents catalog, when derived from it. */
  sourceSlug?: string;
}

export interface ModelBinding {
  providerId: string;
  /** Overrides the provider's default model for this agent. */
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface AgentDefinition {
  agentId: AgentId;
  displayName: string;
  role: RoleProfile;
  /** Inherits the team default binding when omitted. */
  model?: ModelBinding;
  /** Tool allowlist; an agent can never use a tool outside this list. */
  tools: readonly string[];
  canSpawnSubAgents: boolean;
  maxSubAgentDepth: number;
}

export type TeamWorkflow = "intake_brief_dispatch_merge";

export interface TeamDefinition {
  teamId: string;
  name: string;
  description: string;
  /** The member that owns intake, brief, dispatch and merge. */
  orchestratorId: AgentId;
  members: readonly AgentDefinition[];
  workflow: TeamWorkflow;
  defaultModel?: ModelBinding;
}

export function findAgent(team: TeamDefinition, agentId: AgentId): AgentDefinition | undefined {
  return team.members.find((member) => member.agentId === agentId);
}

export function orchestratorOf(team: TeamDefinition): AgentDefinition {
  const orchestrator = findAgent(team, team.orchestratorId);
  if (!orchestrator) {
    throw new Error(`Team ${team.teamId} has no member matching orchestratorId ${team.orchestratorId}`);
  }
  return orchestrator;
}

export function contributorsOf(team: TeamDefinition): AgentDefinition[] {
  return team.members.filter((member) => member.agentId !== team.orchestratorId);
}
