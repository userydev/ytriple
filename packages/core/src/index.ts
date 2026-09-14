export { CORE_PACKAGE_VERSION } from "./version.js";

export { assertSafePathSegment, isSafeHttpUrl, isSafePathSegment } from "./safety.js";

export type { IdFactory } from "./ids.js";
export { createIdFactory } from "./ids.js";

export type { EventBus } from "./events/bus.js";
export { createEventBus } from "./events/bus.js";

export type { Session } from "./session/session.js";
export { createSession } from "./session/session.js";

export { AGENCY_AGENTS_SOURCE, ROLE_CATALOG, ROLE_LIBRARY } from "./team/roleLibrary.js";
export {
  curatedRolesFor,
  isRoleCompatible,
  isRoleLocked,
  requireRole,
} from "./team/roleLibrary.js";

export type { RoleSelection } from "./team/presets.js";
export { DEFAULT_TEAM_ID, applyRoleSelection, createDefaultTeam } from "./team/presets.js";

export type {
  CapabilityLookup,
  TeamValidationIssue,
  ValidateTeamOptions,
} from "./team/validation.js";
export { assertValidTeam, validateTeam } from "./team/validation.js";

export type { ToolName } from "./tools/toolNames.js";
export { TOOL_NAMES, WORKSPACE_TOOLS, isKnownTool } from "./tools/toolNames.js";
export {
  createGlobMatcher,
  matchGlob,
  matchesAnyGlob,
  normalizeRelativePath,
} from "./tools/glob.js";

export type { ToolContext, ToolDefinition, ToolResult } from "./tools/types.js";
export type { ToolRegistry } from "./tools/registry.js";
export { createToolRegistry } from "./tools/registry.js";
export { createPathFilter, createWorkspaceTools, isPathAllowed } from "./tools/workspaceTools.js";
export type { WebSearchStrategy } from "./tools/webSearchTool.js";
export { createWebSearchTool, resolveWebSearchStrategy } from "./tools/webSearchTool.js";
export { createOutputTool } from "./tools/outputTool.js";
export { createSpawnSubAgentTool } from "./tools/spawnSubAgentTool.js";

export type {
  AssembledContext,
  ContextSection,
} from "./context/contextBudget.js";
export {
  CONTEXT_PRIORITY,
  ContextOverflowError,
  assembleContext,
  estimateTokens,
} from "./context/contextBudget.js";

export type {
  BindingResolver,
  ModelCallOptions,
  ModelCallOutcome,
  ModelCaller,
  ResolvedBinding,
} from "./agent/modelCall.js";
export { createModelCaller } from "./agent/modelCall.js";

export type { AgentLoopOptions, AgentLoopResult, GroundingFlag } from "./agent/agentLoop.js";
export { runAgentLoop } from "./agent/agentLoop.js";

export type { ChildBudget, SubAgentLedger } from "./subagents/budget.js";
export { SubAgentBudgetError, createSubAgentLedger } from "./subagents/budget.js";
export type {
  SpawnRejection,
  SpawnRequest,
  SubAgentOutcome,
} from "./subagents/subAgentRunner.js";
export { checkSpawnConstraints, runSubAgent } from "./subagents/subAgentRunner.js";

export {
  GENERIC_CONTRIBUTION_SCHEMA,
  RESEARCH_CONTRIBUTION_SCHEMA,
  REVIEW_CONTRIBUTION_SCHEMA,
} from "./schemas/contributionSchemas.js";
export {
  INTAKE_SCHEMA,
  MEMBER_QUESTIONS_SCHEMA,
  MERGE_SCHEMA,
  QUESTION_GATE_SCHEMA,
  SUBAGENT_RESULT_SCHEMA,
  buildBriefSchema,
} from "./schemas/runtimeSchemas.js";

export * from "./testing/fakes.js";

export type { PrdRenderInput } from "./runtime/prdDocument.js";
export { renderPrdMarkdown } from "./runtime/prdDocument.js";

export type {
  TaskRunInput,
  TaskRunResult,
  TaskRuntime,
  TaskRuntimeOptions,
  TaskRuntimePorts,
} from "./runtime/taskRuntime.js";
export { createTaskRuntime, runTask } from "./runtime/taskRuntime.js";
