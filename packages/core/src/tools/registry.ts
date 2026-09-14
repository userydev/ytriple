import type { AgentDefinition, ToolSpec } from "@ytriple/shared";
import type { ToolContext, ToolDefinition, ToolResult } from "./types.js";

export interface ToolRegistry {
  /** Tools that exist at all in this task, after capability negotiation. */
  available(): ToolDefinition[];
  /** Tools one agent may use: its allowlist intersected with what exists. */
  forAgent(agent: Pick<AgentDefinition, "agentId" | "tools">): ToolDefinition[];
  specsFor(agent: Pick<AgentDefinition, "agentId" | "tools">): ToolSpec[];
  has(name: string): boolean;
  /**
   * Executes a tool on behalf of an allowlist. Calling a tool outside the
   * allowlist is an error, not a degradation.
   */
  execute(
    allowlist: readonly string[],
    name: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult>;
}

export function createToolRegistry(tools: readonly ToolDefinition[]): ToolRegistry {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  const visibleTo = (allowlist: readonly string[]): ToolDefinition[] =>
    allowlist.flatMap((name) => {
      const tool = byName.get(name);
      return tool ? [tool] : [];
    });

  return {
    available: () => [...byName.values()],
    forAgent: (agent) => visibleTo(agent.tools),
    specsFor: (agent) =>
      visibleTo(agent.tools).map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    has: (name) => byName.has(name),
    async execute(allowlist, name, args, context) {
      if (!allowlist.includes(name)) {
        const failure = `Tool "${name}" is not in the allowlist for ${context.agentId} (allowed: ${
          allowlist.join(", ") || "none"
        })`;
        context.emit({
          type: "tool_call",
          agentId: context.agentId,
          ...(context.subAgentId ? { subAgentId: context.subAgentId } : {}),
          tool: name,
          intent: "denied before execution",
          outcome: "denied",
          detail: failure,
        });
        return { ok: false, summary: "tool not allowed", detail: failure };
      }

      const tool = byName.get(name);
      if (!tool) {
        // The tool was filtered out by capability negotiation, so for this task
        // it does not exist. Say so rather than implying a transient failure.
        const failure = `Tool "${name}" is not available in this run; the host did not provide the capability behind it`;
        context.emit({
          type: "tool_call",
          agentId: context.agentId,
          ...(context.subAgentId ? { subAgentId: context.subAgentId } : {}),
          tool: name,
          intent: "unavailable",
          outcome: "denied",
          detail: failure,
        });
        return { ok: false, summary: "tool unavailable", detail: failure };
      }

      try {
        const result = await tool.execute(args, context);
        context.emit({
          type: "tool_call",
          agentId: context.agentId,
          ...(context.subAgentId ? { subAgentId: context.subAgentId } : {}),
          tool: name,
          intent: describeArgs(args),
          outcome: result.ok ? "ok" : "error",
          detail: result.summary,
        });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        context.emit({
          type: "tool_call",
          agentId: context.agentId,
          ...(context.subAgentId ? { subAgentId: context.subAgentId } : {}),
          tool: name,
          intent: describeArgs(args),
          outcome: "error",
          detail: message,
        });
        return { ok: false, summary: `${name} failed`, detail: `${name} failed: ${message}` };
      }
    },
  };
}

function describeArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${truncate(String(value), 60)}`);
  return entries.length > 0 ? entries.join(" ") : "no arguments";
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
