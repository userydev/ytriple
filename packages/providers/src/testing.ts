import type {
  AdapterId,
  GenerateMetadata,
  GenerateRequest,
  GenerateResult,
  ModelConfig,
  ProviderAdapter,
  ProviderCapabilities,
} from "@ytriple/shared";
import { ProviderError } from "@ytriple/shared";
import { resolveCapabilities } from "./adapterSupport.js";
import { baselineFor } from "./capabilities.js";

/**
 * Deterministic, offline adapter doubles.
 *
 * `scripted` answers from a function, `replay` answers from a recording, and
 * `recording` wraps a live adapter so one real run can be captured and then
 * replayed forever with no key and no network.
 */

export interface ScriptedAdapterOptions {
  providerId?: string;
  adapterId?: AdapterId;
  capabilities?: Partial<ProviderCapabilities>;
  respond: (request: GenerateRequest) => GenerateResult | Promise<GenerateResult>;
}

export interface ScriptedAdapter extends ProviderAdapter {
  readonly requests: GenerateRequest[];
}

export function createScriptedAdapter(options: ScriptedAdapterOptions): ScriptedAdapter {
  const requests: GenerateRequest[] = [];
  const adapterId = options.adapterId ?? "openai_compatible";
  const baseline = { ...baselineFor(adapterId), ...options.capabilities };

  return {
    adapterId,
    providerId: options.providerId ?? "scripted",
    requests,
    describe: (model) => resolveCapabilities(baseline, model),
    async healthCheck() {
      return { reachable: true, detected: baseline, mismatches: [] };
    },
    async generate(request) {
      requests.push(request);
      return options.respond(request);
    },
  };
}

export type PhaseHandler = (request: GenerateRequest) => unknown;

/** Reply with a JSON payload per phase; the most common shape in tests. */
export function createJsonScriptedAdapter(
  handlers: Record<string, PhaseHandler>,
  options: Omit<ScriptedAdapterOptions, "respond"> = {},
): ScriptedAdapter {
  return createScriptedAdapter({
    ...options,
    respond(request) {
      const handler = handlers[request.metadata.phase];
      if (!handler) {
        throw new ProviderError(
          `No scripted handler for phase "${request.metadata.phase}" (known: ${Object.keys(handlers).join(", ")})`,
          { providerId: options.providerId ?? "scripted", code: "unsupported" },
        );
      }
      const payload = handler(request);
      if (isGenerateResult(payload)) return payload;

      const text = typeof payload === "string" ? payload : JSON.stringify(payload);
      return {
        text,
        toolCalls: [],
        usage: {
          inputTokens: estimateTokens(
            `${request.system}${request.messages.map((message) => message.content).join("")}`,
          ),
          outputTokens: estimateTokens(text),
        },
        degradations: [],
      };
    },
  });
}

export interface ProviderRecordingEntry {
  key: string;
  phase: string;
  agentId: string;
  result: GenerateResult;
}

export interface ProviderRecording {
  providerId: string;
  adapterId: AdapterId;
  capabilities: ProviderCapabilities;
  entries: ProviderRecordingEntry[];
}

/**
 * Keys stay stable across runs because the runtime derives ids from a counter
 * and takes time from an injected clock.
 */
export function recordingKey(metadata: GenerateMetadata): string {
  return [metadata.agentId, metadata.subAgentId ?? "-", metadata.phase, metadata.round].join("#");
}

export interface ReplayAdapterOptions {
  /**
   * When an exact key is missing, fall back to the next unused entry for the
   * same agent and phase. Keeps hand-authored fixtures usable as round counts
   * shift.
   */
  allowPhaseFallback?: boolean;
}

export function createReplayAdapter(
  recording: ProviderRecording,
  options: ReplayAdapterOptions = {},
): ProviderAdapter {
  const allowPhaseFallback = options.allowPhaseFallback ?? true;
  const consumed = new Set<number>();

  return {
    adapterId: recording.adapterId,
    providerId: recording.providerId,
    describe: (model) => resolveCapabilities(recording.capabilities, model),
    async healthCheck() {
      return { reachable: true, detected: recording.capabilities, mismatches: [] };
    },
    async generate(request) {
      const key = recordingKey(request.metadata);

      const exact = recording.entries.findIndex(
        (entry, index) => entry.key === key && !consumed.has(index),
      );
      if (exact >= 0) {
        consumed.add(exact);
        return recording.entries[exact]!.result;
      }

      if (allowPhaseFallback) {
        const byPhase = recording.entries.findIndex(
          (entry, index) =>
            !consumed.has(index) &&
            entry.phase === request.metadata.phase &&
            entry.agentId === request.metadata.agentId,
        );
        if (byPhase >= 0) {
          consumed.add(byPhase);
          return recording.entries[byPhase]!.result;
        }
      }

      throw new ProviderError(
        `Recording has no entry for "${key}". Available keys: ${recording.entries
          .map((entry) => entry.key)
          .join(", ")}`,
        { providerId: recording.providerId, code: "unsupported" },
      );
    },
  };
}

export interface RecordingAdapterOptions {
  inner: ProviderAdapter;
  model: ModelConfig;
  onEntry?: (entry: ProviderRecordingEntry) => void;
}

export interface RecordingAdapter extends ProviderAdapter {
  readonly recording: ProviderRecording;
}

/** Wraps a live adapter and accumulates a replayable recording. */
export function createRecordingAdapter(options: RecordingAdapterOptions): RecordingAdapter {
  const { inner } = options;
  const recording: ProviderRecording = {
    providerId: inner.providerId,
    adapterId: inner.adapterId,
    capabilities: inner.describe(options.model),
    entries: [],
  };

  return {
    adapterId: inner.adapterId,
    providerId: inner.providerId,
    recording,
    describe: (model) => inner.describe(model),
    healthCheck: (model) => inner.healthCheck(model),
    async generate(request) {
      const result = await inner.generate(request);
      const entry: ProviderRecordingEntry = {
        key: recordingKey(request.metadata),
        phase: request.metadata.phase,
        agentId: request.metadata.agentId,
        result,
      };
      recording.entries.push(entry);
      options.onEntry?.(entry);
      return result;
    },
  };
}

function isGenerateResult(value: unknown): value is GenerateResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "toolCalls" in value &&
    "usage" in value &&
    "degradations" in value
  );
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
