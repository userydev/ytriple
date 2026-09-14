import type { ProviderCapabilities, SearchPort, SourceNote } from "@ytriple/shared";
import { TOOL_NAMES } from "./toolNames.js";
import type { ToolDefinition, ToolResult } from "./types.js";

export type WebSearchStrategy = "native_provider" | "search_port" | "unavailable";

export interface WebSearchStrategyInput {
  capabilities: ProviderCapabilities;
  searchPort?: SearchPort | undefined;
  /** Provider-level switch from the user's configuration. */
  nativeSearchEnabled: boolean;
}

/**
 * Web research fallback chain:
 *
 * 1. the bound provider can ground its own answer -> let it, and harvest the
 *    citations it returns;
 * 2. otherwise a standalone SearchPort runs the query and the results are fed
 *    back as observations;
 * 3. otherwise research continues without sources, which the runtime reports as
 *    a degraded capability rather than hiding.
 */
export function resolveWebSearchStrategy(input: WebSearchStrategyInput): WebSearchStrategy {
  if (input.capabilities.nativeWebSearch && input.nativeSearchEnabled) return "native_provider";
  if (input.searchPort) return "search_port";
  return "unavailable";
}

export interface WebSearchToolOptions {
  strategy: WebSearchStrategy;
  searchPort?: SearchPort | undefined;
  maxResults: number;
  /** Called when the strategy defers the search to the provider's own call. */
  onNativeSearchRequested(query: string): void;
  onSourcesFound(sources: SourceNote[]): void;
}

export function createWebSearchTool(options: WebSearchToolOptions): ToolDefinition {
  return {
    name: TOOL_NAMES.webSearch,
    description: "Light web research. Returns sources you must cite.",
    parameters: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        max_results: { type: "integer" },
      },
    },
    async execute(args, context): Promise<ToolResult> {
      const query = args.query?.trim();
      if (!query) {
        return { ok: false, summary: "web_search needs a query", detail: "web_search needs a query" };
      }

      if (options.strategy === "native_provider") {
        options.onNativeSearchRequested(query);
        return {
          ok: true,
          summary: `native provider search queued: ${query}`,
          detail: [
            `The bound model searches the web itself, so "${query}" will be run during your next answer.`,
            "Cite the sources the model returns; do not invent URLs.",
          ].join("\n"),
        };
      }

      if (options.strategy === "unavailable" || !options.searchPort) {
        context.emit({
          type: "capability_degraded",
          agentId: context.agentId,
          capability: "web_search",
          detail: `No native provider search and no SearchPort configured; "${query}" could not run.`,
        });
        return {
          ok: false,
          summary: "web search unavailable",
          detail: [
            `Web search is not available in this run, so "${query}" returned nothing.`,
            "Continue from what you already know, mark unverified claims as assumptions, and add the missing verification to open questions.",
          ].join("\n"),
        };
      }

      try {
        const results = await options.searchPort.search({
          query,
          maxResults: args.max_results ?? options.maxResults,
        });
        if (results.length === 0) {
          return {
            ok: true,
            summary: `no results for "${query}"`,
            detail: `Search for "${query}" returned no results. Treat related claims as assumptions.`,
          };
        }

        const sources: SourceNote[] = results.map((result) => ({
          ...result,
          origin: "search_port",
        }));
        options.onSourcesFound(sources);

        return {
          ok: true,
          summary: `${sources.length} source(s) for "${query}"`,
          detail: [
            `Search results for "${query}":`,
            ...sources.map(
              (source, index) =>
                `${index + 1}. ${source.title} — ${source.url}${source.snippet ? `\n   ${source.snippet}` : ""}`,
            ),
          ].join("\n"),
          sources,
        };
      } catch (error) {
        // Search failure is recoverable: the run continues with the gap recorded.
        const message = error instanceof Error ? error.message : "unknown error";
        context.emit({
          type: "capability_degraded",
          agentId: context.agentId,
          capability: "web_search",
          detail: `Search failed for "${query}": ${message}`,
        });
        return {
          ok: false,
          summary: `search failed for "${query}"`,
          detail: `Search for "${query}" failed (${message}). Record the missing verification as an open question.`,
        };
      }
    },
  };
}
