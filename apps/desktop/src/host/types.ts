import type { TaskRuntime } from "@ytriple/core";
import type { ModelBinding, TeamDefinition, UserPort, YtripleConfig } from "@ytriple/shared";

/**
 * The seam between the React app and whatever is hosting it.
 *
 * The Tauri host talks to Rust commands; the demo host runs entirely in the
 * browser against a recorded provider. Both build the runtime the same way, so
 * the UI never learns which one it is running on beyond what `HostInfo` says.
 */
export interface HostInfo {
  kind: "tauri" | "demo";
  label: string;
  /** A folder picker exists. */
  canChooseWorkspace: boolean;
  canRevealOutput: boolean;
  /** Credentials live in the OS keychain rather than in this process. */
  secureCredentialStorage: boolean;
  /** Set on the demo host so the UI can say the models are replayed. */
  replayNotice?: string;
}

export interface DesktopSettings {
  defaultModel: ModelBinding;
  /** agentId -> roleId, within the curated catalog. */
  agentRoles: Record<string, string>;
  /** agentId -> model binding, overriding the team default. */
  agentModels: Record<string, ModelBinding>;
  workspaceRoot?: string;
}

export interface HistoryRecord {
  taskId: string;
  title: string;
  createdAt: number;
  status: string;
  prdPath?: string;
  prdMarkdown?: string;
  eventCount: number;
  memberIds: string[];
}

export interface CreateRuntimeInput {
  taskId: string;
  team: TeamDefinition;
  config: YtripleConfig;
  user: UserPort;
  workspaceRoot?: string | undefined;
}

export interface DesktopHost {
  readonly info: HostInfo;
  loadConfig(): Promise<YtripleConfig>;
  loadSettings(): Promise<DesktopSettings | undefined>;
  saveSettings(settings: DesktopSettings): Promise<void>;
  listHistory(): Promise<HistoryRecord[]>;
  saveHistory(record: HistoryRecord): Promise<void>;
  revealOutput(taskId: string): Promise<void>;
  chooseWorkspace(): Promise<string | undefined>;
  /** Which credential refs resolve, without ever returning their values. */
  credentialStatus(refs: string[]): Promise<Record<string, boolean>>;
  saveCredential(ref: string, value: string): Promise<void>;
  createRuntime(input: CreateRuntimeInput): TaskRuntime;
}
