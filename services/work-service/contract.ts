/** Public service contract. Upstream URLs and credentials are server configuration only. */
export interface WorkLoginRequest {
  username: string;
  password: string;
  deviceName: string;
}
export interface WorkLoginResponse {
  token: string;
  expiresAt: string;
  user: { id: string; username: string };
  device: { id: string; name: string };
}
export interface WorkDevice {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
}
export interface WorkModel {
  id: string;
  object: "model";
  name: string;
  owned_by: "work-service";
  provider: "openai" | "gemini";
  capabilities: { text: true; tools: boolean; streaming: true };
  streamingMode: "buffered";
}
export interface WorkAccount {
  user: { id: string; username: string };
  entitlement: {
    plan: string;
    active: boolean;
    expiresAt?: string;
    modelIds: string[];
    tokenLimit: number;
    maxConcurrent: number;
  };
  usage: {
    usedTokens: number;
    reservedTokens: number;
    remainingTokens: number;
    unknownRequests: number;
  };
}
export interface WorkMaterial {
  id: string;
  title: string;
  text: string;
  hash?: string;
  coverage?: string;
}
export interface WorkMethod {
  id: string;
  name: string;
  version: string;
  hash: string;
  instructions: string;
}
export type WorkSchedule =
  | { kind: "once" }
  | { kind: "change" }
  | {
      kind: "time";
      cadence: "interval";
      everyMinutes: number;
      timezone: string;
    }
  | {
      kind: "time";
      cadence: "daily" | "weekly";
      time: string;
      weekday?: number;
      timezone: string;
    }
  | { kind: "after_node"; delayMinutes: number; timezone: string };
export interface WorkJobInput {
  requestId: string;
  model: string;
  title: string;
  goal: string;
  materials: WorkMaterial[];
  skills?: WorkMethod[];
  schedule?: WorkSchedule;
  limits?: { maxRuns: number; maxTokens: number };
  origin?: { taskId?: string; routineId?: string; version?: number };
}
export interface WorkJobUpdate {
  requestId: string;
  expectedVersion: number;
  materials?: WorkMaterial[];
  goal?: string;
  skills?: WorkMethod[];
  schedule?: WorkSchedule;
  limits?: { maxRuns: number; maxTokens: number };
  node?: { occurredAt: string; evidence: string; actual: true };
  action?: "pause" | "resume";
}
export interface WorkJobRun {
  id: string;
  version: number;
  startedAt: string;
  finishedAt?: string;
  state:
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "uncertain"
    | "unchanged";
  inputHash: string;
  result?: string;
  tokens?: number;
  error?: string;
  meaningful: boolean;
}
export interface WorkJob {
  id: string;
  title: string;
  model: string;
  goal: string;
  materials: WorkMaterial[];
  skills: WorkMethod[];
  origin?: WorkJobInput["origin"];
  version: number;
  schedule: WorkSchedule;
  limits: { maxRuns: number; maxTokens: number };
  state:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "waiting"
    | "paused"
    | "uncertain";
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string;
  runCount: number;
  tokens: number;
  runs: WorkJobRun[];
  result?: string;
  lastInputHash?: string;
  lastError?: string;
  node?: { id: string; occurredAt: string; evidence: string };
  consumedNodeId?: string;
}

/* Bearer authentication is required except GET /health and POST /v1/auth/login.
 * POST /v1/auth/login -> WorkLoginResponse; POST /v1/auth/logout -> {ok:true}
 * GET /v1/account -> WorkAccount; GET /v1/devices -> {devices:WorkDevice[]}
 * DELETE /v1/devices/:id -> {ok:true}; GET /v1/models -> {object:'list',data:WorkModel[]}
 * POST /v1/chat/completions -> OpenAI ChatCompletion or buffered SSE with real tool_calls and usage.
 * Optional Idempotency-Key header caches exact chat responses; unknown prior requests return 409.
 * POST /v1/jobs (WorkJobInput) -> {job:WorkJob}; GET /v1/jobs -> {jobs:WorkJob[]}
 * GET /v1/jobs/:id -> {job:WorkJob}; PATCH /v1/jobs/:id (WorkJobUpdate) -> {job:WorkJob}
 * POST /v1/jobs/:id/cancel {requestId:string} -> {job:WorkJob}
 * GET /v1/export -> account, jobs and usage metadata (no credentials or session tokens).
 * DELETE /v1/data {confirm:'delete-my-data'} cancels work and removes jobs/chat content.
 * Numeric usage totals remain to enforce administrator-provisioned quota; no payment is implied.
 */
