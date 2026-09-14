import type { AgentId, JsonSchema, RuntimeEventBody, SourceNote } from "@ytriple/shared";

export interface ToolContext {
  agentId: AgentId;
  /** Set when the call comes from a spawned sub-agent. */
  subAgentId?: string;
  depth: number;
  emit(body: RuntimeEventBody): void;
}

export interface ToolResult {
  ok: boolean;
  /** One line for the event stream. */
  summary: string;
  /** Fed back to the model as the tool result. */
  detail: string;
  sources?: SourceNote[];
  /** Structured result for the runtime; never shown to the model. */
  data?: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

export function toolFailure(summary: string, detail = summary): ToolResult {
  return { ok: false, summary, detail };
}

export function readStringArg(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function readNumberArg(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = args[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function readStringListArg(
  args: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = args[key];
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return undefined;
}
