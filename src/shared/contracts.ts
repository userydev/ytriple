export type Intent = 'discuss' | 'change-goal' | 'revise' | 'explain' | 'summarize' | 'reflect';
export type RunStatus = 'running' | 'stopping' | 'stopped' | 'completed' | 'failed' | 'interrupted' | 'superseded';
export type ArtifactKind = 'deliverable' | 'summary' | 'reflection';
export type EventType = 'plan' | 'delegation' | 'analysis' | 'review' | 'revision' | 'tool' | 'status' | 'usage' | 'error';
export interface Member { id: string; name: string; role: string; instructions: string; model?: string }
export interface TeamConfig { version: number; members: Member[] }
export interface Skill { id: string; name: string; version: string; description: string; instructions: string; enabled: boolean; requires: string[] }
export interface ProviderConfig { kind: 'gemini' | 'openai-compatible'; model: string; baseUrl: string }
export interface RunLimits { maxCalls: number; maxConcurrency: number; timeoutMs: number; maxOutputTokens: number }
export interface AppSettings { provider: ProviderConfig; team: TeamConfig; skills: Skill[]; limits: RunLimits; strategy: 'team-v1'; version: number }
export interface SettingsView extends AppSettings { credential: { configured: boolean; source: 'environment' | 'encrypted' | 'none' }; dataDirectory: string; providerManaged: boolean; executionLocation: 'local' | 'server' }
export interface SettingsUpdate { settings: AppSettings; apiKey?: string; removeKey?: boolean }
export interface Work { id: string; title: string; goal: string; goalRevision: number; createdAt: string; updatedAt: string; archived: boolean }
export interface Material { id: string; workId: string; title: string; content: string; hash: string; createdAt: string }
export interface Reference { kind: 'event' | 'artifact'; id: string; version?: number; quote?: string }
export interface Message { id: string; workId: string; role: 'user' | 'assistant'; content: string; createdAt: string; runId?: string; memberId?: string; reference?: Reference }
export interface Draft { text: string; intent: Intent; targetMemberId?: string; reference?: Reference }
export interface ViewState { focusedPane: 'all' | 'conversation' | 'process' | 'result'; activePane: 'conversation' | 'process' | 'result'; widths: number[]; artifactId?: string; artifactVersion?: number; scroll: Record<string, number>; eventMemberFilter?: string }
export interface ArtifactVersion { version: number; content: string; createdAt: string; runId?: string; baseVersion: number; status: 'current' | 'history' | 'proposal'; note?: string }
export interface Artifact { id: string; workId: string; title: string; kind: ArtifactKind; currentVersion: number; versions: ArtifactVersion[] }
export interface PublicEvent { id: string; workId: string; runId: string; sequence: number; type: EventType; title: string; body: string; createdAt: string; memberId?: string; taskId?: string; parentTaskId?: string; requirement?: string; sourceIds?: string[]; relatedEventIds?: string[]; streaming?: boolean; key?: string; usage?: { calls: number; inputTokens?: number; outputTokens?: number; known: boolean } }
export type EventInput = Omit<PublicEvent, 'id' | 'workId' | 'runId' | 'sequence' | 'createdAt'>;
export interface SubmitRequest { workId: string; prompt: string; intent: Intent; targetMemberId?: string; reference?: Reference }
export interface RunSnapshot { id: string; workId: string; goal: string; goalRevision: number; prompt: string; intent: Intent; targetMemberId?: string; reference?: Reference; referenceContent?: string; createdAt: string; status: RunStatus; finishedAt?: string; error?: string; strategyVersion: string; settings: AppSettings; materials: Material[]; messages: Message[]; baseArtifact?: { id: string; title: string; kind: ArtifactKind; version: number; content: string }; usage: { inputTokens: number; outputTokens: number; calls: number; known: boolean }; contextNote?: string; contextEvents?: PublicEvent[]; contextArtifact?: { id: string; title: string; kind: ArtifactKind; version: number; content: string } }
export interface CoreResult { answer: string; artifact?: { title: string; content: string; kind: ArtifactKind }; changes?: string }
export interface WorkDetail { work: Work; messages: Message[]; runs: RunSnapshot[]; events: PublicEvent[]; artifacts: Artifact[]; materials: Material[]; draft: Draft; view: ViewState }
export interface SaveArtifactRequest { workId: string; artifactId: string; baseVersion: number; content: string }
export interface AppNotification { workId: string; runId?: string }
export interface ConnectionConfig { mode: 'local' | 'server'; serverUrl: string; token?: string }
export interface ConnectionView { mode: 'local' | 'server'; serverUrl: string; configured: boolean }
export interface DesktopApi {
  getConnection(): Promise<ConnectionView>;
  saveConnection(input: ConnectionConfig): Promise<ConnectionView>;
  listWorks(): Promise<Work[]>;
  createWork(input: { title: string; goal: string }): Promise<WorkDetail>;
  getWork(workId: string): Promise<WorkDetail>;
  renameWork(input: { workId: string; title: string }): Promise<void>;
  archiveWork(input: { workId: string; archived: boolean }): Promise<void>;
  submit(input: SubmitRequest): Promise<RunSnapshot>;
  stop(runId: string): Promise<void>;
  saveDraft(input: { workId: string; draft: Draft }): Promise<void>;
  saveView(input: { workId: string; view: Partial<ViewState> }): Promise<void>;
  saveArtifact(input: SaveArtifactRequest): Promise<Artifact>;
  addMaterial(input: { workId: string; title: string; content: string }): Promise<Material>;
  importMaterials(workId: string): Promise<Material[]>;
  getSettings(): Promise<SettingsView>;
  saveSettings(input: SettingsUpdate): Promise<SettingsView>;
  testProvider(): Promise<{ ok: boolean; message: string }>;
  onChanged(listener: (event: AppNotification) => void): () => void;
}
