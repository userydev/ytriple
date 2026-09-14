import type { ProviderCapabilities, SearchPort, SourceNote } from "@ytriple/shared";
import { sourceFromSearchResult } from "@ytriple/shared";
import { TOOL_NAMES } from "./toolNames.js";
import { readNumberArg, readStringArg, type ToolDefinition, type ToolResult } from "./types.js";

export type WebSearchStrategy = "native_provider" | "search_port" | "unavailable";

/**
 * The native-search fallback chain, resolved per agent from its bound model's
 * capabilities. Web access is a capability of the model plus the host, never a
 * property of a particular seat in the team: any member holding `web_search`
 * can reach the web if its model or the host can.
 */
export function resolveWebSearchStrategy(input: {
  capabilities: ProviderCapabilities;
  searchPort?: SearchPort | undefined;
}): WebSearchStrategy {
  if (input.capabilities.nativeWebSearch) return "native_provider";
  if (input.searchPort) return "search_port";
  return "unavailable";
}

export interface WebSearchToolOptions {
  strategy: WebSearchStrategy;
  searchPort?: SearchPort | undefined;
  maxResults: number;
  /** Called when the search is deferred to the model's own grounded call. */
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
      const query = readStringArg(args, "query");
      if (!query) {
        return {
          ok: false,
          summary: `${TOOL_NAMES.webSearch} needs a query`,
          detail: `${TOOL_NAMES.webSearch} needs a query`,
        };
      }

      if (options.strategy === "native_provider") {
        options.onNativeSearchRequested(query);
        return {
          ok: true,
          summary: `native provider search queued: ${query}`,
          detail: [
            `Your model searches the web itself, so "${query}" runs as part of your next answer.`,
            "Cite the sources the model returns. Do not invent URLs.",
          ].join("\n"),
        };
      }

      if (options.strategy === "unavailable" || !options.searchPort) {
        context.emit({
          type: "degradation",
          agentId: context.agentId,
          ...(context.subAgentId ? { subAgentId: context.subAgentId } : {}),
          degradation: {
            kind: "web_search_unavailable",
            from: "search_port",
            to: "none",
            detail: `no native search and no SearchPort, so "${query}" could not run`,
          },
        });
        return {
          ok: false,
          summary: "web search unavailable",
          detail: [
            `Web search is not available in this run, so "${query}" returned nothing.`,
            "Continue from what you already know, mark unverified claims as assumptions, and add the missing verification to your open questions.",
          ].join("\n"),
        };
      }

      try {
        const results = await options.searchPort.search({
          query,
          maxResults: readNumberArg(args, "max_results") ?? options.maxResults,
        });

        if (results.length === 0) {
          return {
            ok: true,
            summary: `no results for "${query}"`,
            detail: `Search for "${query}" returned no results. Treat related claims as assumptions.`,
          };
        }

        const sources = results.map(sourceFromSearchResult);
        options.onSourcesFound(sources);

        return {
          ok: true,
          summary: `${sources.length} source(s) for "${query}"`,
          detail: [
            `Search results for "${query}":`,
            ...sources.map(
              (source, index) =>
                `${index + 1}. ${source.title} — ${source.url}${
                  source.snippet ? `\n   ${source.snippet}` : ""
                }`,
            ),
          ].join("\n"),
          sources,
        };
      } catch (error) {
        // Search failure is recoverable: the run continues with the gap recorded.
        const message = error instanceof Error ? error.message : "unknown error";
        context.emit({
          type: "degradation",
          agentId: context.agentId,
          ...(context.subAgentId ? { subAgentId: context.subAgentId } : {}),
          degradation: {
            kind: "web_search_unavailable",
            from: "search_port",
            to: "none",
            detail: `search failed for "${query}": ${message}`,
          },
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
