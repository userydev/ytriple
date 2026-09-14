import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderKind,
  ProviderRequest,
  ProviderRequestMetadata,
  ProviderResponse,
} from "@ytriple/shared";
import { ProviderError } from "@ytriple/shared";
import { capabilitiesFor } from "./capabilities.js";

/**
 * Deterministic, offline provider doubles.
 *
 * `scripted` answers from a function, `replay` answers from a recording, and
 * `recording` wraps a live adapter so a real run can be captured once and then
 * replayed forever without a network or an API key.
 */

export interface ScriptedProviderOptions {
  providerId?: string;
  kind?: ProviderKind;
  model?: string;
  capabilities?: Partial<ProviderCapabilities>;
  respond: (request: ProviderRequest) => ProviderResponse | Promise<ProviderResponse>;
}

export function createScriptedProvider(options: ScriptedProviderOptions): ProviderAdapter & {
  readonly requests: ProviderRequest[];
} {
  const requests: ProviderRequest[] = [];
  const kind = options.kind ?? "openai_compatible";

  return {
    providerId: options.providerId ?? "scripted",
    kind,
    model: options.model ?? "scripted-model",
    capabilities: capabilitiesFor(kind, options.capabilities),
    requests,
    async complete(request) {
      requests.push(request);
      return options.respond(request);
    },
  };
}

/** Convenience wrapper: reply with a JSON payload per phase. */
export function createJsonScriptedProvider(
  handlers: Record<string, (request: ProviderRequest) => unknown>,
  options: Omit<ScriptedProviderOptions, "respond"> = {},
): ProviderAdapter & { readonly requests: ProviderRequest[] } {
  return createScriptedProvider({
    ...options,
    respond(request) {
      const handler = handlers[request.metadata.phase];
      if (!handler) {
        throw new ProviderError(
          `No scripted handler for phase "${request.metadata.phase}" (known: ${Object.keys(handlers).join(", ")})`,
          { providerId: options.providerId ?? "scripted" },
        );
      }
      const payload = handler(request);
      const text = typeof payload === "string" ? payload : JSON.stringify(payload);
      return {
        text,
        usage: {
          promptTokens: estimateTokens(`${request.system}\n${request.user}`),
          completionTokens: estimateTokens(text),
        },
      };
    },
  });
}

export interface ProviderRecordingEntry {
  key: string;
  phase: string;
  agentId: string;
  response: ProviderResponse;
}

export interface ProviderRecording {
  providerId: string;
  kind: ProviderKind;
  model: string;
  capabilities: ProviderCapabilities;
  entries: ProviderRecordingEntry[];
}

/**
 * Recording keys stay stable across runs because the runtime uses injected
 * deterministic clock and id ports when recording.
 */
export function recordingKey(metadata: ProviderRequestMetadata): string {
  return [metadata.agentId, metadata.subAgentId ?? "-", metadata.phase, metadata.round].join("#");
}

export interface ReplayProviderOptions {
  /**
   * When an exact key is missing, fall back to the first unused entry for the
   * same agent and phase. Keeps hand-authored fixtures usable while the
   * runtime's round counts evolve.
   */
  allowPhaseFallback?: boolean;
}

export function createReplayProvider(
  recording: ProviderRecording,
  options: ReplayProviderOptions = {},
): ProviderAdapter {
  const allowPhaseFallback = options.allowPhaseFallback ?? true;
  const consumed = new Set<number>();

  return {
    providerId: recording.providerId,
    kind: recording.kind,
    model: recording.model,
    capabilities: recording.capabilities,
    async complete(request) {
      const key = recordingKey(request.metadata);

      const exactIndex = recording.entries.findIndex(
        (entry, index) => entry.key === key && !consumed.has(index),
      );
      if (exactIndex >= 0) {
        consumed.add(exactIndex);
        return recording.entries[exactIndex]!.response;
      }

      if (allowPhaseFallback) {
        const phaseIndex = recording.entries.findIndex(
          (entry, index) =>
            !consumed.has(index) &&
            entry.phase === request.metadata.phase &&
            entry.agentId === request.metadata.agentId,
        );
        if (phaseIndex >= 0) {
          consumed.add(phaseIndex);
          return recording.entries[phaseIndex]!.response;
        }
      }

      throw new ProviderError(
        `Recording has no entry for "${key}". Available keys: ${recording.entries
          .map((entry) => entry.key)
          .join(", ")}`,
        { providerId: recording.providerId },
      );
    },
  };
}

export interface RecordingProviderOptions {
  inner: ProviderAdapter;
  onEntry?: (entry: ProviderRecordingEntry) => void;
}

/** Wraps a live adapter and accumulates a replayable recording. */
export function createRecordingProvider(options: RecordingProviderOptions): ProviderAdapter & {
  readonly recording: ProviderRecording;
} {
  const { inner } = options;
  const recording: ProviderRecording = {
    providerId: inner.providerId,
    kind: inner.kind,
    model: inner.model,
    capabilities: inner.capabilities,
    entries: [],
  };

  return {
    providerId: inner.providerId,
    kind: inner.kind,
    model: inner.model,
    capabilities: inner.capabilities,
    recording,
    async complete(request) {
      const response = await inner.complete(request);
      const entry: ProviderRecordingEntry = {
        key: recordingKey(request.metadata),
        phase: request.metadata.phase,
        agentId: request.metadata.agentId,
        response,
      };
      recording.entries.push(entry);
      options.onEntry?.(entry);
      return response;
    },
  };
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
