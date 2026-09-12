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
}
export interface Source {
  id: string;
  title: string;
  type: "file" | "url" | "text";
  location: string;
  text: string;
  addedAt: string;
  coverage: string;
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
  deletedAt?: string;
  title: string;
  goal: string;
  goalVersion: number;
  kind: TaskKind;
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
}
export type Command =
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
    }
  | { type: "library.reuse"; entryId: string; taskId: string }
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
