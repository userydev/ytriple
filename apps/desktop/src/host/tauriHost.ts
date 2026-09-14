import type { TaskRuntime } from "@ytriple/core";
import { defaultModelBinding, defaultProviderConfigs } from "@ytriple/providers";
import { createDesktopSession } from "../session.js";
import type {
  ClockPort,
  FileContent,
  FileEntry,
  FsPort,
  HttpPort,
  HttpRequestInit,
  HttpResponseData,
  OutputPort,
  SearchResult,
  SearchPort,
  SecretPort,
  TextMatch,
  YtripleConfig,
} from "@ytriple/shared";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { CreateRuntimeInput, DesktopHost, DesktopSettings, HistoryRecord } from "./types.js";

/**
 * Tauri host.
 *
 * Every capability is a Rust command; the renderer holds no credential and no
 * file handle. The one subtlety is `SecretPort`: it hands core an opaque
 * placeholder instead of a key, and the Rust HTTP command swaps in the real
 * value from the OS keychain just before the request leaves the process. That
 * is how "credentials never enter the renderer" survives a provider adapter
 * that has to write an Authorization header.
 */
export const SECRET_PLACEHOLDER_PREFIX = "ytriple-secret-ref:";

export function secretPlaceholder(credentialRef: string): string {
  return `${SECRET_PLACEHOLDER_PREFIX}${credentialRef}`;
}

function tauriHttpPort(): HttpPort {
  return {
    async request(init: HttpRequestInit) {
      return invoke<HttpResponseData>("http_request", { request: init });
    },
  };
}

function tauriSecretPort(): SecretPort {
  return {
    async resolve(credentialRef) {
      const known = await invoke<boolean>("credential_exists", { credentialRef });
      if (!known) {
        throw new Error(
          `No credential stored for "${credentialRef}". Add it in Settings; it is kept in the OS keychain.`,
        );
      }
      // Deliberately not the key: the Rust side substitutes it on the way out.
      return secretPlaceholder(credentialRef);
    },
  };
}

function tauriFsPort(root: string): FsPort {
  return {
    rootLabel: root,
    listFiles: (request) => invoke<FileEntry[]>("workspace_list", { root, request }),
    readFile: (request) => invoke<FileContent>("workspace_read", { root, request }),
    searchText: (request) => invoke<TextMatch[]>("workspace_search", { root, request }),
  };
}

function tauriOutputPort(): OutputPort {
  return {
    writeDocument: (request) => invoke<{ path: string }>("output_write", { request }),
    revealOutput: (taskId) => invoke<void>("output_reveal", { taskId }),
  };
}

function tauriSearchPort(): SearchPort {
  return {
    search: (request) => invoke<SearchResult[]>("web_search", { request }),
  };
}

function systemClock(): ClockPort {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
  };
}

export function createTauriHost(): DesktopHost {
  const http = tauriHttpPort();
  const secrets = tauriSecretPort();
  // Resolved at startup: a host with no search backend must not offer a
  // SearchPort, so the runtime reports the capability gap instead of seeing an
  // empty result set that looks like a successful search.
  let searchConfigured = false;

  return {
    info: {
      kind: "tauri",
      label: "Desktop",
      canChooseWorkspace: true,
      canRevealOutput: true,
      secureCredentialStorage: true,
    },
    async loadConfig() {
      // The catalog is shared data, not something the shell has to know about;
      // Rust only persists whatever the user changed.
      searchConfigured = await invoke<boolean>("search_configured");
      const stored = await invoke<YtripleConfig | null>("store_get", { key: "providers" });
      if (stored && stored.providers.length > 0) return stored;

      const providers = defaultProviderConfigs();
      return { providers, defaultModel: defaultModelBinding(providers) };
    },
    loadSettings: () => invoke<DesktopSettings | undefined>("store_get", { key: "settings" }),
    saveSettings: (settings) => invoke<void>("store_put", { key: "settings", value: settings }),
    listHistory: () => invoke<HistoryRecord[]>("history_list"),
    saveHistory: (record) => invoke<void>("history_put", { record }),
    revealOutput: (taskId) => invoke<void>("output_reveal", { taskId }),
    async chooseWorkspace() {
      const selected = await open({ directory: true, multiple: false });
      return typeof selected === "string" ? selected : undefined;
    },
    credentialStatus: (refs) =>
      invoke<Record<string, boolean>>("credential_status", { credentialRefs: refs }),
    saveCredential: (credentialRef, value) =>
      invoke<void>("credential_set", { credentialRef, value }),
    createRuntime(input: CreateRuntimeInput): TaskRuntime {
      // Ports are assembled in one place, `createDesktopSession`, so the shell
      // and the demo host cannot drift into different wiring.
      return createDesktopSession(input.taskId, {
        config: input.config,
        team: input.team,
        http,
        secrets,
        output: tauriOutputPort(),
        clock: systemClock(),
        user: input.user,
        ...(searchConfigured ? { search: tauriSearchPort() } : {}),
        capabilityOverrides: { streaming: false },
        ...(input.workspaceRoot ? { fs: tauriFsPort(input.workspaceRoot) } : {}),
      }).runtime;
    },
  };
}

/** True when the page is running inside the Tauri shell. */
export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
