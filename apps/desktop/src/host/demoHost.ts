import { createFakeOutputPort, type TaskRuntime } from "@ytriple/core";
import {
  DEMO_SCENARIO,
  createReplayAdapter,
  scenarioToRecording,
} from "@ytriple/providers";
import type { ClockPort, HttpPort, SecretPort, YtripleConfig } from "@ytriple/shared";
import { createDesktopSession } from "../session.js";
import type { CreateRuntimeInput, DesktopHost, DesktopSettings, HistoryRecord } from "./types.js";

/**
 * Browser host for the recorded demo.
 *
 * It runs the real `@ytriple/core` runtime against a recorded provider, so the
 * event stream, the question round, dispatch and the merge are genuine; only
 * the model replies are replayed. It exists so the UI can be exercised and
 * reviewed without a Rust toolchain or an API key, and it says so in the
 * header rather than pretending to be the desktop app.
 */
export const DEMO_CONFIG: YtripleConfig = {
  providers: [
    {
      providerId: "recorded",
      adapterId: "openai_compatible",
      displayName: "Recorded session",
      baseUrl: "https://recorded.invalid/v1",
      credentialRef: "RECORDED_DEMO",
      models: [
        {
          modelId: "recorded",
          displayName: "Replayed responses",
          capabilities: DEMO_SCENARIO.capabilities,
        },
      ],
    },
  ],
  defaultModel: { providerId: "recorded", modelId: "recorded" },
};

export function demoUserInput(): string {
  return DEMO_SCENARIO.userInput;
}

export function demoAnswerFor(agentId: string): string {
  return DEMO_SCENARIO.answers[agentId] ?? "";
}

/** The demo never leaves the page; these exist only to satisfy the bridge. */
const unreachableHttp: HttpPort = {
  async request() {
    throw new Error("the demo host replays a recording and never makes a request");
  },
};

const unreachableSecrets: SecretPort = {
  async resolve() {
    throw new Error("the demo host has no credentials because it sends nothing");
  },
};

function browserClock(): ClockPort {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
  };
}

export function createDemoHost(): DesktopHost {
  const settingsKey = "ytriple.demo.settings";
  const historyKey = "ytriple.demo.history";
  const output = createFakeOutputPort("ytriple-outputs");

  const read = <T>(key: string): T | undefined => {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  };

  return {
    info: {
      kind: "demo",
      label: "Demo host (browser)",
      canChooseWorkspace: false,
      canRevealOutput: false,
      secureCredentialStorage: false,
      replayNotice:
        "Model replies are replayed from a recorded session. Orchestration, events and the generated document are produced by the real runtime.",
    },
    async loadConfig() {
      return DEMO_CONFIG;
    },
    async loadSettings() {
      return read<DesktopSettings>(settingsKey);
    },
    async saveSettings(settings) {
      window.localStorage.setItem(settingsKey, JSON.stringify(settings));
    },
    async listHistory() {
      return read<HistoryRecord[]>(historyKey) ?? [];
    },
    async saveHistory(record) {
      const history = read<HistoryRecord[]>(historyKey) ?? [];
      window.localStorage.setItem(
        historyKey,
        JSON.stringify([record, ...history.filter((entry) => entry.taskId !== record.taskId)]),
      );
    },
    async revealOutput() {
      // Nothing to reveal in a browser; the Tauri host opens the folder.
    },
    async chooseWorkspace() {
      return undefined;
    },
    async credentialStatus(refs) {
      return Object.fromEntries(refs.map((ref) => [ref, true]));
    },
    async saveCredential() {
      // The demo host has no credential store; nothing is ever sent anywhere.
    },
    createRuntime(input: CreateRuntimeInput): TaskRuntime {
      const adapter = createReplayAdapter(scenarioToRecording(DEMO_SCENARIO));

      // Same session builder as the Tauri host; only the ports differ.
      return createDesktopSession(input.taskId, {
        config: input.config,
        team: input.team,
        http: unreachableHttp,
        secrets: unreachableSecrets,
        output,
        clock: browserClock(),
        user: input.user,
        capabilityOverrides: {
          // A browser cannot read the disk or reach a model on localhost.
          workspaceRead: false,
          localModels: false,
          streaming: false,
        },
        resolveBinding: async () => ({
          adapter,
          model: { modelId: "recorded", displayName: "Replayed responses" },
        }),
      }).runtime;
    },
  };
}
