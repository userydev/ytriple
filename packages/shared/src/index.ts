export { SHARED_PACKAGE_VERSION } from "./version.js";

export type {
  JsonSchema,
  JsonSchemaType,
  NamedJsonSchema,
  SchemaViolation,
} from "./jsonSchema.js";
export { describeSchema, parseJsonPayload, validateAgainstSchema } from "./jsonSchema.js";

export type {
  AgentDefinition,
  AgentId,
  ModelBinding,
  RoleProfile,
  TaskId,
  TeamDefinition,
  TeamWorkflow,
} from "./team.js";
export { contributorsOf, findAgent, orchestratorOf } from "./team.js";

export type {
  AgentAnswer,
  AgentContribution,
  AgentQuestion,
  SessionAuthorKind,
  SessionMessage,
  SourceNote,
  TaskBrief,
  TaskStatus,
  TokenUsage,
} from "./task.js";
export { EMPTY_TOKEN_USAGE, addUsage, totalTokens } from "./task.js";

export type {
  RuntimeEvent,
  RuntimeEventBody,
  RuntimeEventListener,
  RuntimeEventType,
} from "./events.js";
export { formatEvent, isEventOfType } from "./events.js";

export type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderKind,
  ProviderRequest,
  ProviderRequestMetadata,
  ProviderResponse,
} from "./provider.js";
export { PROVIDER_KINDS, ProviderError } from "./provider.js";

export type {
  ClockPort,
  HttpPort,
  HttpRequestInit,
  HttpResponseData,
  IdPort,
  LoggerPort,
  OutputFsPort,
  OutputWriteResult,
  SearchPort,
  SearchQuery,
  SecretsPort,
  UserPort,
  WorkspaceFileMeta,
  WorkspaceFsPort,
  WorkspaceListOptions,
} from "./ports.js";
export { noopLogger } from "./ports.js";

export type {
  ProviderConfig,
  RuntimeLimits,
  SecretRef,
  SecretRefKind,
  SubAgentPolicy,
  WorkspacePolicy,
  YtripleConfig,
} from "./config.js";
export {
  DEFAULT_RUNTIME_LIMITS,
  DEFAULT_SUBAGENT_POLICY,
  DEFAULT_WORKSPACE_POLICY,
  findProviderConfig,
  redactSecrets,
  resolveLimits,
  resolveSubAgentPolicy,
  resolveWorkspacePolicy,
} from "./config.js";
