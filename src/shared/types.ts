import type { ReadingTopic } from "@ytriple/source-contract";
import type { ProjectBrowserState } from "./project-files.js";
import type { MemberSettingsMap } from "./member-settings.js";
import type { ProjectObservation, ProjectDiscoveryState } from "./projects.js";
export type MemberId = "coordinator" | "cto" | "researcher";
export type TaskStatus =
  "idle" | "running" | "waiting" | "paused" | "failed" | "completed";
export type TaskKind = "research" | "project" | "learning" | "brainstorm";
export type WindowKind = "main" | "evidence" | "artifact";
export interface ModelProfile {
  id: string;
  name: string;
  provider: "gemini" | "deepseek" | "ark" | "compatible";
  protocol: "google" | "openai";
  execution?: "model" | "google-agent";
  baseURL: string;
  modelId: string;
  apiKeyEnv: string;
  hasKey: boolean;
  status: "unconfigured" | "untested" | "ready" | "failed";
  lastError?: string;
  testedAt?: string;
  capabilities?: { text: boolean; tools: boolean; streaming: boolean };
}
export interface AppSettings {
  aiRoot: string;
  codeRoot: string;
  workspaceRoot: string;
  defaultProfileId: string;
  memberProfiles: Record<MemberId, string>;
  memberSettings?: MemberSettingsMap;
  projectMonitoring?: boolean;
  libraryRecall?: boolean;
}
export type SourceCoverageLevel =
  "listing" | "metadata" | "fulltext" | "transcript" | "vision";
export interface RemoteSourceProvenance {
  publishedAt?: string;
  serverInstanceId: string;
  tenantId?: string;
  sourceId: string;
  /** Follow that caused this Radar delivery; absent for one-shot/legacy sources. */
  followId?: string;
  itemId: string;
  revisionId: string;
  contentHash: string;
  observedAt: string;
  coverageLevel: SourceCoverageLevel;
  missing: string[];
}
export interface Source {
  id: string;
  title: string;
  type: "file" | "url" | "text";
  location: string;
  text: string;
  addedAt: string;
  coverage: string;
  remote?: RemoteSourceProvenance;
  library?: LibrarySourceProvenance;
}
export interface RemoteSourceIdentity {
  serverInstanceId: string;
  tenantId: string;
}
export interface RemoteSourceDeliveryPage extends RemoteSourceIdentity {
  nextCursor: string;
  sources: Source[];
}
export type RadarConnectionState =
  "unconfigured" | "connecting" | "online" | "offline";
export type RadarFollowState = "active" | "paused";
export interface RadarFollow {
  id: string;
  sourceId: string;
  origin: "user" | "recommended";
  recommendedSourceId?: string;
  name: string;
  category: string;
  url: string;
  state: RadarFollowState;
  refreshIntervalMinutes: number;
  createdAt: string;
  updatedAt: string;
  nextRefreshAt?: string;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
}
export interface RadarRecommendedSource {
  id: string;
  name: string;
  description?: string;
  category: string;
  url?: string;
  defaultRefreshIntervalMinutes?: number;
  enabledByDefault?: boolean;
  followed?: boolean;
  followId?: string;
}
export interface RadarItem {
  publishedAt?: string;
  /** Stable local identity derived from service, tenant, and remote item. */
  id: string;
  serverInstanceId: string;
  tenantId: string;
  sourceId: string;
  remoteItemId: string;
  followId?: string;
  origin: "user" | "recommended" | "server";
  sourceTitle: string;
  category?: string;
  title: string;
  url: string;
  excerpt: string;
  content: string;
  receivedAt: string;
  observedAt: string;
  latestRevisionId: string;
  contentHash: string;
  coverageLevel: SourceCoverageLevel;
  missing: string[];
  revisionCount: number;
  isUpdated: boolean;
  readAt?: string;
  archivedAt?: string;
  taskIds: string[];
  sourceAssetIds: string[];
}
export type RadarDispositionKind =
  | "duplicate"
  | "outdated"
  | "low_value"
  | "irrelevant"
  | "incomplete"
  | "deferred";
export type RadarDigestContextRelation =
  "new" | "supports" | "extends" | "repeats" | "conflicts";
export interface RadarDigestionRun {
  id: string;
  taskId: string;
  goalVersion: number;
  serverInstanceId: string;
  tenantId: string;
  state: "pending" | "published";
  /** Snapshot-only projection from the hidden background task. */
  taskStatus?: TaskStatus;
  /** Snapshot-only task failure; persisted digest runs may omit it. */
  error?: string;
  createdAt: string;
  publishedAt?: string;
  retryOfRunId?: string;
  items: {
    radarItemId: string;
    sourceId: string;
    remoteItemId: string;
    revisionId: string;
    contentHash: string;
  }[];
  contextSources: {
    sourceId: string;
    kind: "library" | "task";
    referenceId: string;
    version?: number;
    hash?: string;
  }[];
}
export interface RadarDigest {
  id: string;
  runId: string;
  taskId: string;
  goalVersion: number;
  serverInstanceId: string;
  tenantId: string;
  title: string;
  summary: string;
  whyItMatters: string;
  topics: string[];
  evidence: {
    sourceId: string;
    revisionId: string;
    note?: string;
  }[];
  context: {
    sourceId: string;
    relation: RadarDigestContextRelation;
    note: string;
  }[];
  disagreements: string[];
  gaps: string[];
  publishedAt: string;
}
export interface RadarDisposition {
  id: string;
  runId: string;
  taskId: string;
  goalVersion: number;
  serverInstanceId: string;
  tenantId: string;
  sourceId: string;
  kind: RadarDispositionKind;
  reason: string;
  publishedAt: string;
}
export interface RadarDigestPublicationInput {
  runId: string;
  themes: {
    title: string;
    summary: string;
    whyItMatters: string;
    topics?: string[];
    evidence: {
      sourceId: string;
      revisionId: string;
      note?: string;
    }[];
    context?: {
      sourceId: string;
      relation: RadarDigestContextRelation;
      note: string;
    }[];
    disagreements?: string[];
    gaps?: string[];
  }[];
  dispositions: {
    sourceId: string;
    kind: RadarDispositionKind;
    reason: string;
  }[];
}
export interface RadarEvent {
  id: string;
  type:
    | "item.received"
    | "item.revised"
    | "follow.created"
    | "follow.updated"
    | "follow.removed";
  summary: string;
  createdAt: string;
  itemId?: string;
  followId?: string;
}
export interface RadarEvidenceRevision {
  sourceId: string;
  remoteItemId: string;
  revisionId: string;
  title: string;
  url: string;
  content: string;
  contentHash: string;
  observedAt: string;
  coverageLevel: SourceCoverageLevel;
  missing: string[];
}
export interface RadarSnapshot {
  serviceURL?: string;
  readingTopics?: ReadingTopic[];
  configured: boolean;
  connection: RadarConnectionState;
  follows: RadarFollow[];
  recommendedSources: RadarRecommendedSource[];
  items: RadarItem[];
  digests?: RadarDigest[];
  dispositions?: RadarDisposition[];
  digestions?: RadarDigestionRun[];
  /** Published evidence only, grouped by stable Radar item id and revision id. */
  evidenceRevisions?: Record<string, Record<string, RadarEvidenceRevision>>;
  events?: RadarEvent[];
  unreadCount: number;
  lastSyncAt?: string;
  error?: string;
  digestionError?: string;
}
export interface ArtifactVersion {
  version: number;
  hash: string;
  path: string;
  createdAt: string;
  summary: string;
}
export interface Artifact {
  id: string;
  title: string;
  path: string;
  format: "md" | "html" | "png" | "pptx";
  version: number;
  hash: string;
  goalVersion: number;
  updatedAt: string;
  versions: ArtifactVersion[];
  content?: string;
  readError?: string;
  previewURL?: string;
}
export interface Message {
  id: string;
  role: "user" | "assistant";
  member: MemberId;
  content: string;
  createdAt: string;
  goalVersion: number;
}
export interface TaskEvent {
  id: string;
  type: string;
  member?: MemberId;
  summary: string;
  createdAt: string;
  goalVersion: number;
  data?: Record<string, unknown>;
}
export interface Task {
  id: string;
  projectId?: string;
  archivedAt?: string;
  /** Legacy persisted data only; Store permanently removes these conversation records when opened. */
  deletedAt?: string;
  title: string;
  goal: string;
  goalVersion: number;
  kind: TaskKind;
  surface?: "workspace" | "background";
  member: MemberId;
  profileId?: string;
  workspace: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  events: TaskEvent[];
  sources: Source[];
  artifacts: Artifact[];
  error?: string;
}
export interface SystemIssue {
  code: string;
  message: string;
  path?: string;
}
export interface SystemStatus {
  state: "ready" | "missing" | "incomplete" | "conflict";
  aiRoot: string;
  codeRoot: string;
  policyPath: string;
  issues: SystemIssue[];
  policyText?: string;
}
export interface ProjectInfo {
  registered?: boolean;
  lifecycle?: string;
  manifestPath?: string;
  observation?: ProjectObservation;
  id: string;
  name: string;
  series: string;
  root: string;
  devPath: string;
  documents: Record<string, string | null>;
}
export interface ProjectInput {
  id: string;
  name: string;
  series: "x" | "y" | "z";
  description: string;
  taskId?: string;
}
export interface ProjectInitResult {
  project: ProjectInfo;
  createdPaths: string[];
  checks: string[];
}
export interface LibraryEntry {
  id: string;
  title: string;
  path: string;
  format: Artifact["format"];
  hash: string;
  version: number;
  savedAt: string;
  updatedAt: string;
  tags: string[];
  note: string;
  source: {
    taskId: string;
    taskTitle: string;
    artifactId: string;
    artifactVersion: number;
    artifactHash: string;
    goalVersion: number;
  };
  versions: ArtifactVersion[];
  content?: string;
  readError?: string;
  previewURL?: string;
  /** Feedback is projected from an independent, append-only local ledger. */
  feedback?: LibraryFeedback[];
  feedbackRevision?: number;
  feedbackResolutions?: { feedbackId: string; version: number; hash: string }[];
  externalChange?: boolean;
}
export type LibraryAssessment =
  "unverified" | "needs_review" | "user_reported_useful";
export interface LibraryFeedback {
  id: string;
  entryId: string;
  kind: "correction" | "useful" | "failed";
  note: string;
  purpose: string;
  conditions: string;
  evidence: string;
  targetVersion: number;
  targetHash: string;
  createdAt: string;
  outcome?: {
    taskId: string;
    taskTitle: string;
    sourceId: string;
    artifactId?: string;
    artifactTitle?: string;
    artifactVersion?: number;
    artifactHash?: string;
  };
}
export interface LibrarySourceProvenance {
  root: string;
  entryId: string;
  version: number;
  hash: string;
  feedbackRevision: number;
  feedback: LibraryFeedback[];
  resolvedFeedbackIds: string[];
  assessment: LibraryAssessment;
  selection: "explicit" | "recalled";
  reason: string;
  supersededAt?: string;
}
export interface DesktopState {
  rightMode?: "split" | "evidence" | "artifact";
  ratios?: { main: number; evidence: number };
  expanded?: WindowKind | null;
  revision?: number;
  mode: "single" | "triple";
  taskId: string | null;
  collapsed: Record<WindowKind, boolean>;
  open: Record<WindowKind, boolean>;
}
export interface Snapshot {
  version: string;
  dataPath: string;
  tasks: Task[];
  profiles: ModelProfile[];
  settings: AppSettings;
  system: SystemStatus;
  projects: ProjectInfo[];
  projectDiscovery?: ProjectDiscoveryState;
  projectBrowser?: ProjectBrowserState;
  library?: LibraryEntry[];
  desktop?: DesktopState;
  radar?: RadarSnapshot;
}
export type Command =
  | { type: "radar.connect"; baseURL: string; bootstrapToken?: string }
  | {
      type: "project.browse";
      projectId: string;
      worktreePath?: string;
      path?: string;
    }
  | {
      type: "project.read";
      projectId: string;
      worktreePath?: string;
      path: string;
    }
  | { type: "message.save"; taskId: string; messageId: string }
  | { type: "task.rename"; taskId: string; title: string }
  | { type: "task.archive" | "task.delete" | "task.restore"; taskId: string }
  | { type: "window.rightMode"; mode: "split" | "evidence" | "artifact" }
  | { type: "project.refresh" }
  | { type: "process.save"; taskId: string; member?: MemberId }
  | { type: "window.resize"; main: number; evidence: number }
  | { type: "window.expand"; window: WindowKind | null }
  | { type: "snapshot" }
  | {
      type: "task.create";
      projectId?: string;
      goal: string;
      title?: string;
      kind?: TaskKind;
      member?: MemberId;
      profileId?: string;
    }
  | {
      type: "task.send";
      taskId: string;
      text: string;
      member?: MemberId;
      profileId?: string;
      reviseGoal?: boolean;
    }
  | { type: "task.run"; taskId: string }
  | { type: "task.stop"; taskId: string }
  | { type: "source.addText"; taskId: string; title: string; text: string }
  | { type: "source.addURL"; taskId: string; url: string }
  | { type: "source.import"; taskId: string }
  | {
      type: "radar.follow";
      url?: string;
      recommendedSourceId?: string;
      name?: string;
      refreshIntervalMinutes?: number;
    }
  | {
      type: "radar.setFollowState";
      followId: string;
      state: RadarFollowState;
    }
  | { type: "radar.refresh"; followId?: string }
  | { type: "radar.unfollow"; followId: string }
  | { type: "radar.markRead"; itemId: string; read: boolean }
  | { type: "radar.archive"; itemId: string; archived: boolean }
  | { type: "radar.digest"; itemIds: string[]; retry?: boolean }
  | { type: "radar.addToTask"; itemIds: string[]; taskId: string }
  | {
      type: "radar.createTask";
      itemIds: string[];
      title?: string;
      instruction?: string;
    }
  | {
      type: "artifact.save";
      taskId: string;
      artifactId: string;
      content: string;
      expectedHash: string;
    }
  | {
      type: "artifact.export";
      taskId: string;
      artifactId: string;
      format: "pptx" | "png";
    }
  | {
      type: "library.collect";
      taskId: string;
      artifactId: string;
      expectedHash: string;
      title?: string;
      tags?: string[];
      note?: string;
    }
  | {
      type: "library.save";
      entryId: string;
      content: string;
      expectedHash: string;
      title?: string;
      tags?: string[];
      note?: string;
      resolvedFeedbackIds?: string[];
    }
  | { type: "library.reuse"; entryId: string; taskId: string }
  | {
      type: "library.feedback";
      entryId: string;
      feedbackId: string;
      expectedHash: string;
      expectedVersion: number;
      expectedFeedbackRevision: number;
      kind: LibraryFeedback["kind"];
      note: string;
      purpose: string;
      conditions: string;
      evidence: string;
      taskId?: string;
      sourceId?: string;
      artifactId?: string;
      expectedArtifactHash?: string;
      expectedArtifactVersion?: number;
    }
  | {
      type: "artifact.refine";
      taskId: string;
      artifactId: string;
      instruction: string;
      expectedHash: string;
    }
  | { type: "window.layout"; mode: "single" | "triple"; reset?: boolean }
  | { type: "window.select"; taskId: string | null }
  | { type: "window.collapse"; window: WindowKind; collapsed: boolean }
  | { type: "window.focus"; window: WindowKind }
  | { type: "profile.save"; profile: ModelProfile; apiKey?: string }
  | { type: "profile.probe"; profileId: string }
  | { type: "settings.save"; settings: AppSettings }
  | { type: "system.bootstrap" }
  | { type: "project.initialize"; input: ProjectInput }
  | { type: "window.open"; window: WindowKind; taskId: string }
  | { type: "path.reveal"; path: string }
  | { type: "url.open"; url: string };
export interface WorkbenchAPI {
  invoke(command: Command): Promise<Snapshot>;
  subscribe(listener: (snapshot: Snapshot) => void): () => void;
}
declare global {
  interface Window {
    ytriple: WorkbenchAPI;
  }
}
export const MEMBERS: {
  id: MemberId;
  name: string;
  shortName: string;
  description: string;
}[] = [
  {
    id: "coordinator",
    name: "统筹 · 工作伙伴",
    shortName: "统筹",
    description: "梳理目标，组织协作，收敛成果",
  },
  {
    id: "cto",
    name: "CTO · 产品技术伙伴",
    shortName: "CTO",
    description: "产品判断，项目初始化与技术审视",
  },
  {
    id: "researcher",
    name: "Deep Research · 研究员",
    shortName: "研究员",
    description: "寻找依据，核查材料，扩展理解",
  },
];
