import type { TaskRunResult } from "@ytriple/core";
import type { RuntimeEvent } from "@ytriple/shared";
import { formatEvent } from "@ytriple/shared";

/**
 * The harness is the transport for the event stream: core produces events, this
 * writes them to stdout. A desktop host sends the same events over IPC instead.
 */
export function renderEvent(event: RuntimeEvent, verbose: boolean): string | undefined {
  if (!verbose && event.body.type === "model_usage") return undefined;
  return formatEvent(event);
}

export interface RunSummaryInput {
  status: string;
  events: RuntimeEvent[];
  contributions: Array<{ agentId: string; schemaId: string }>;
  subAgentCount: number;
  usage: { inputTokens: number; outputTokens: number };
  prdPath?: string | undefined;
  error?: string | undefined;
}

export function renderSummary(input: RunSummaryInput): string {
  const degradations = input.events.filter((event) => event.body.type === "degradation").length;
  const errors = input.events.filter((event) => event.body.type === "error").length;

  const lines = [
    "",
    "─".repeat(60),
    `status         ${input.status}`,
    `events         ${input.events.length}`,
    `contributions  ${
      input.contributions.map((entry) => `${entry.agentId}:${entry.schemaId}`).join(", ") || "none"
    }`,
    `sub-agents     ${input.subAgentCount}`,
    `degradations   ${degradations}`,
    `errors         ${errors}`,
    `tokens         ${input.usage.inputTokens} in / ${input.usage.outputTokens} out`,
  ];

  if (input.prdPath) lines.push(`output         ${input.prdPath}`);
  if (input.error) lines.push(`error          ${input.error}`);
  lines.push("─".repeat(60));

  return lines.join("\n");
}

export function summaryFor(result: TaskRunResult): RunSummaryInput {
  return {
    status: result.status,
    events: result.events,
    contributions: result.contributions.map((contribution) => ({
      agentId: contribution.agentId,
      schemaId: contribution.schemaId,
    })),
    subAgentCount: result.subAgentOutcomes.length,
    usage: result.usage,
    prdPath: result.prd?.path,
    error: result.error,
  };
}
