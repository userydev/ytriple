import type { NamedJsonSchema } from "./jsonSchema.js";

export type AgentId = string;
export type TeamId = string;
export type TaskId = string;

/**
 * How many questions a role may put to the user in one turn, and what those
 * questions are allowed to be about. `forbidden` is what keeps a researcher
 * from drifting into product review and vice versa.
 */
export interface QuestionPolicy {
  scope: readonly string[];
  forbidden: readonly string[];
  maxQuestionsPerTurn: 0 | 1 | 2;
}

/**
 * A reusable persona. A role is a catalog entry; an agent is a seat in one
 * team. The same role may be bound to two agents with different ids.
 */
export interface RoleProfile {
  roleId: string;
  displayName: string;
  sourceSlug?: string;
  /** One sentence, injected into the system prompt. */
  responsibility: string;
  /** The body of the role prompt. */
  instructions: string;
  questionPolicy: QuestionPolicy;
  executionPolicy: readonly string[];
  /** Structured contribution this role returns to the orchestrator. */
  outputSchema: NamedJsonSchema;
  /** Section order for this agent's panel. */
  panelSections: readonly string[];
}

export type RoleCompatibility = "orchestrator" | "research" | "review" | "generic";

export interface RoleCatalogEntry {
  roleId: string;
  sourceSlug: string;
  displayName: string;
  compatibleWith: readonly RoleCompatibility[];
  /** Only curated entries may appear in a selection UI. */
  curated: boolean;
}

export interface ModelBinding {
  providerId: string;
  modelId: string;
  maxOutputTokens?: number;
  reasoningEffort?: "low" | "medium" | "high";
  costCeiling?: { maxTokens: number };
}

export interface SubAgentBudget {
  /** Additional nesting levels allowed below this agent. */
  maxDepth: number;
  /** Spawns this agent may make during one task. */
  maxSpawns: number;
  /** Shared token pool across all of this agent's sub-agents. */
  maxTokens: number;
  maxWallClockMs: number;
}

export interface AgentDefinition {
  agentId: AgentId;
  displayName: string;
  role: RoleProfile;
  /** Falls back to the team default when omitted. */
  model?: ModelBinding;
  /** Tool allowlist. An empty list means a pure-reasoning member. */
  tools: readonly string[];
  canSpawnSubAgents: boolean;
  /** Required when canSpawnSubAgents is true. */
  subAgentBudget?: SubAgentBudget;
}

export type TeamWorkflow = "intake_brief_dispatch_merge";

export const REGISTERED_WORKFLOWS: readonly TeamWorkflow[] = ["intake_brief_dispatch_merge"];

export const MAX_TEAM_MEMBERS = 6;

export interface TeamDefinition {
  teamId: TeamId;
  name: string;
  description: string;
  /** Must match one of `members`. */
  orchestratorId: AgentId;
  members: readonly AgentDefinition[];
  defaultModel: ModelBinding;
  workflow: TeamWorkflow;
  outputContract: { primaryDocument: "prd.md" };
}

export function findAgent(team: TeamDefinition, agentId: AgentId): AgentDefinition | undefined {
  return team.members.find((member) => member.agentId === agentId);
}

export function orchestratorOf(team: TeamDefinition): AgentDefinition {
  const orchestrator = findAgent(team, team.orchestratorId);
  if (!orchestrator) {
    throw new Error(
      `Team ${team.teamId} has no member matching orchestratorId ${team.orchestratorId}`,
    );
  }
  return orchestrator;
}

export function membersOf(team: TeamDefinition): AgentDefinition[] {
  return team.members.filter((member) => member.agentId !== team.orchestratorId);
}

export function displayNamesOf(team: TeamDefinition): Record<AgentId, string> {
  return Object.fromEntries(team.members.map((member) => [member.agentId, member.displayName]));
}

export function modelBindingFor(team: TeamDefinition, agent: AgentDefinition): ModelBinding {
  return agent.model ?? team.defaultModel;
}
