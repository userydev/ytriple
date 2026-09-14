import type { AgentDefinition } from "@ytriple/shared";
import type { SpawnRequest, SubAgentOutcome, SpawnRejection } from "../subagents/subAgentRunner.js";
import { TOOL_NAMES } from "./toolNames.js";
import {
  readNumberArg,
  readStringArg,
  readStringListArg,
  toolFailure,
  type ToolDefinition,
  type ToolResult,
} from "./types.js";

export interface SpawnSubAgentToolOptions {
  parent: AgentDefinition;
  /** Default slice when the model does not ask for a specific budget. */
  defaultTokenBudget: number;
  run(request: SpawnRequest): Promise<SubAgentOutcome | SpawnRejection>;
  onOutcome(outcome: SubAgentOutcome): void;
}

export function createSpawnSubAgentTool(options: SpawnSubAgentToolOptions): ToolDefinition {
  const inheritable = options.parent.tools.filter((tool) => tool !== TOOL_NAMES.spawnSubAgent);

  return {
    name: TOOL_NAMES.spawnSubAgent,
    description: [
      "Delegate one narrow objective to a temporary sub-agent that reports back to you.",
      `Its tools must be a subset of yours: ${inheritable.join(", ") || "none"}.`,
      "Use it when a side investigation would otherwise crowd out your main task.",
    ].join(" "),
    parameters: {
      type: "object",
      required: ["objective", "instructions"],
      properties: {
        objective: { type: "string", description: "A single objective; not a list" },
        instructions: { type: "string", description: "How the sub-agent should work" },
        tools: {
          type: "array",
          description: `Subset of your own tools: ${inheritable.join(", ") || "none"}`,
          items: { type: "string" },
        },
        max_tokens: { type: "integer", description: "Token slice from your sub-agent budget" },
      },
    },
    async execute(args): Promise<ToolResult> {
      const objective = readStringArg(args, "objective");
      const instructions = readStringArg(args, "instructions");
      if (!objective) return toolFailure(`${TOOL_NAMES.spawnSubAgent} needs an objective`);
      if (!instructions) return toolFailure(`${TOOL_NAMES.spawnSubAgent} needs instructions`);

      const request: SpawnRequest = {
        objective,
        instructions,
        tools: readStringListArg(args, "tools") ?? [],
        maxTokens: Math.trunc(readNumberArg(args, "max_tokens") ?? options.defaultTokenBudget),
      };

      const result = await options.run(request);

      if (!("subAgentId" in result)) {
        // Refusal is explicit and readable; the parent decides how to proceed.
        return toolFailure(
          `spawn refused (${result.reason})`,
          `Sub-agent could not be spawned: ${result.detail}. Continue with your own work and record the gap.`,
        );
      }

      options.onOutcome(result);

      if (result.incomplete) {
        return {
          ok: false,
          summary: `sub-agent ${result.subAgentId} aborted`,
          detail: [
            `Sub-agent ${result.subAgentId} did not finish: ${result.gaps.join("; ")}`,
            "Continue with your own work and record the gap in your contribution.",
          ].join("\n"),
        };
      }

      return {
        ok: true,
        summary: `sub-agent ${result.subAgentId} returned ${result.findings.length} finding(s)`,
        detail: [
          `Sub-agent ${result.subAgentId} reported on "${result.objective}":`,
          result.summary,
          ...result.findings.map((finding) => `- ${finding}`),
          ...(result.gaps.length > 0 ? [`Gaps: ${result.gaps.join("; ")}`] : []),
          "You own this result: adopt it, adopt part of it, or discard it.",
        ].join("\n"),
        ...(result.sources.length > 0 ? { sources: result.sources } : {}),
      };
    },
  };
}
