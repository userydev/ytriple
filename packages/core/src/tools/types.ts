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
  /** Fed back to the model as an observation. */
  detail: string;
  sources?: SourceNote[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** Documented for the model's plan step; arguments are validated on execute. */
  parameters: JsonSchema;
  execute(args: ToolArgs, context: ToolContext): Promise<ToolResult>;
}

/**
 * Tool arguments are a flat, schema-friendly bag. Keeping them flat lets the
 * plan step be expressed in one strict JSON schema that every provider,
 * including JSON-mode-only ones, can produce reliably.
 */
export interface ToolArgs {
  query?: string;
  path?: string;
  purpose?: string;
  instructions?: string;
  tools?: string;
  max_results?: number;
  start_line?: number;
  end_line?: number;
  max_tokens?: number;
}

export function toolFailure(summary: string, detail = summary): ToolResult {
  return { ok: false, summary, detail };
}
