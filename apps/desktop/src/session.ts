import {
  createDefaultTeam,
  createTaskRuntime,
  type BindingResolver,
  type TaskRuntime,
} from "@ytriple/core";
import { createModelRouter } from "@ytriple/providers";
import type {
  ClockPort,
  FsPort,
  HttpPort,
  OutputPort,
  RuntimeCapabilities,
  SearchPort,
  SecretPort,
  TeamDefinition,
  UserPort,
  YtripleConfig,
} from "@ytriple/shared";

/**
 * The bridge a host supplies, and the one place ports are assembled into a
 * runtime.
 *
 * Both hosts go through here — the Tauri shell and the browser demo — so there
 * is a single answer to "how does this app start a task", and neither host gets
 * to invent its own orchestration wiring.
 */
export interface DesktopBridge {
  config: YtripleConfig;
  http: HttpPort;
  /** System keyring on the desktop. Credentials never reach the renderer. */
  secrets: SecretPort;
  output: OutputPort;
  clock: ClockPort;
  /** Puts the orchestrator's approved questions into the shared chat. */
  user: UserPort;
  /** Present only for a task where the user granted a folder. */
  fs?: FsPort | undefined;
  search?: SearchPort | undefined;
  /** Narrows the defaults, e.g. a browser host that cannot reach local models. */
  capabilityOverrides?: Partial<RuntimeCapabilities> | undefined;
  /** Replaces model routing, e.g. a demo host replaying a recorded session. */
  resolveBinding?: BindingResolver | undefined;
  team?: TeamDefinition | undefined;
}

export interface DesktopSession {
  runtime: TaskRuntime;
  capabilities: RuntimeCapabilities;
  team: TeamDefinition;
}

/**
 * What the host can do, narrowed by what it actually supplied. Core narrows
 * this again against the bound models during capability negotiation.
 */
export function desktopCapabilities(bridge: DesktopBridge): RuntimeCapabilities {
  return {
    workspaceRead: bridge.fs !== undefined,
    outputWrite: true,
    webSearch: true,
    // Only a desktop host can reach a model on localhost.
    localModels: true,
    persistentBackgroundRuns: false,
    streaming: true,
    ...bridge.capabilityOverrides,
  };
}

export function createDesktopSession(taskId: string, bridge: DesktopBridge): DesktopSession {
  const capabilities = desktopCapabilities(bridge);
  const team = bridge.team ?? createDefaultTeam(bridge.config.defaultModel);

  const resolveBinding =
    bridge.resolveBinding ??
    (() => {
      const router = createModelRouter(bridge.config, {
        http: bridge.http,
        secrets: bridge.secrets,
      });
      return router.resolve.bind(router);
    })();

  const runtime = createTaskRuntime({
    taskId,
    team,
    config: bridge.config,
    capabilities,
    ports: {
      output: bridge.output,
      clock: bridge.clock,
      user: bridge.user,
      fs: bridge.fs,
      search: bridge.search,
    },
    resolveBinding,
  });

  return { runtime, capabilities, team };
}
