import { createDefaultTeam, createTaskRuntime, type TaskRuntime } from "@ytriple/core";
import { createModelRouter } from "@ytriple/providers";
import type {
  ClockPort,
  FsPort,
  HttpPort,
  OutputPort,
  RuntimeCapabilities,
  SearchPort,
  SecretPort,
  UserPort,
  YtripleConfig,
} from "@ytriple/shared";

/**
 * Everything the Tauri layer must supply.
 *
 * `fs` and `search` are optional because the desktop capabilities depend on
 * what the user granted: a task without a chosen folder simply runs without
 * workspace tools, and core is told so through capability negotiation rather
 * than discovering it when a tool fails.
 */
export interface DesktopBridge {
  config: YtripleConfig;
  http: HttpPort;
  /** System keyring. Credentials never reach the renderer. */
  secrets: SecretPort;
  output: OutputPort;
  clock: ClockPort;
  /** Puts the orchestrator's approved questions into the shared chat. */
  user: UserPort;
  /** Present only for a task where the user granted a folder. */
  fs?: FsPort | undefined;
  search?: SearchPort | undefined;
}

export interface DesktopSession {
  runtime: TaskRuntime;
  capabilities: RuntimeCapabilities;
}

export function desktopCapabilities(bridge: DesktopBridge): RuntimeCapabilities {
  return {
    workspaceRead: bridge.fs !== undefined,
    outputWrite: true,
    webSearch: true,
    // Desktop can reach a model on localhost; a server cannot.
    localModels: true,
    persistentBackgroundRuns: false,
    streaming: true,
  };
}

export function createDesktopSession(taskId: string, bridge: DesktopBridge): DesktopSession {
  const capabilities = desktopCapabilities(bridge);
  const router = createModelRouter(bridge.config, {
    http: bridge.http,
    secrets: bridge.secrets,
  });

  const runtime = createTaskRuntime({
    taskId,
    team: createDefaultTeam(bridge.config.defaultModel),
    config: bridge.config,
    capabilities,
    ports: {
      output: bridge.output,
      clock: bridge.clock,
      user: bridge.user,
      fs: bridge.fs,
      search: bridge.search,
    },
    resolveBinding: (binding) => router.resolve(binding),
  });

  return { runtime, capabilities };
}
