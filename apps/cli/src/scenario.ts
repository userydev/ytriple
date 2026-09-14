import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ProviderCapabilities, SourceNote, ToolCall, TokenUsage } from "@ytriple/shared";
import type { ProviderRecording } from "@ytriple/providers";

/**
 * A scenario is a recorded run: the model responses captured once, stored as
 * readable payloads, and replayed verbatim. It is what lets `npm test` and CI
 * exercise a complete task with no API key and no network.
 */
export interface ScenarioEntry {
  key: string;
  agentId: string;
  phase: string;
  /** Serialised into the model's reply. */
  payload?: Record<string, unknown>;
  text?: string;
  toolCalls?: ToolCall[];
  sources?: SourceNote[];
  usage?: TokenUsage;
}

export interface Scenario {
  name: string;
  description: string;
  userInput: string;
  title?: string;
  answers: Record<string, string>;
  capabilities: ProviderCapabilities;
  entries: ScenarioEntry[];
}

const SCENARIOS: Record<string, string> = {
  demo: "../fixtures/prd-demo.scenario.json",
};

export function scenarioNames(): string[] {
  return Object.keys(SCENARIOS);
}

export async function loadScenario(name: string): Promise<Scenario> {
  const relativePath = SCENARIOS[name];
  if (!relativePath) {
    throw new Error(`Unknown scenario "${name}". Available: ${scenarioNames().join(", ")}`);
  }

  const path = fileURLToPath(new URL(relativePath, import.meta.url));
  return JSON.parse(await readFile(path, "utf8")) as Scenario;
}

export function scenarioToRecording(scenario: Scenario): ProviderRecording {
  return {
    providerId: "recorded",
    adapterId: "openai_compatible",
    capabilities: scenario.capabilities,
    entries: scenario.entries.map((entry) => ({
      key: entry.key,
      agentId: entry.agentId,
      phase: entry.phase,
      result: {
        text: entry.text ?? (entry.payload ? JSON.stringify(entry.payload) : ""),
        toolCalls: entry.toolCalls ?? [],
        usage: entry.usage ?? { inputTokens: 0, outputTokens: 0 },
        ...(entry.sources ? { sources: entry.sources } : {}),
        degradations: [],
      },
    })),
  };
}
