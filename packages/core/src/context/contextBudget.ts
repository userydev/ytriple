import type { Degradation } from "@ytriple/shared";

/**
 * Context-overflow chain.
 *
 * When an assembled prompt exceeds the model's context window, sections are
 * dropped in a fixed priority order, lowest value last. The brief and the
 * member's own task are never dropped: if they alone overflow, the call fails
 * rather than silently losing the dispatch instructions.
 */
export const CONTEXT_PRIORITY = {
  briefAndMemberTask: 0,
  roleAndTools: 1,
  recentChat: 2,
  workspaceSummaries: 3,
  earlyChat: 4,
  rawSearchResults: 5,
} as const;

export interface ContextSection {
  id: string;
  priority: number;
  content: string;
}

export interface AssembleContextOptions {
  maxTokens: number;
  charsPerToken: number;
}

export interface AssembledContext {
  text: string;
  tokens: number;
  droppedSectionIds: string[];
  degradations: Degradation[];
}

export function estimateTokens(text: string, charsPerToken: number): number {
  return Math.ceil(text.length / Math.max(1, charsPerToken));
}

export class ContextOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextOverflowError";
  }
}

export function assembleContext(
  sections: readonly ContextSection[],
  options: AssembleContextOptions,
): AssembledContext {
  const kept = sections.filter((section) => section.content.trim().length > 0);
  const dropped: string[] = [];

  const render = (entries: readonly ContextSection[]) =>
    entries
      .slice()
      .sort((left, right) => left.priority - right.priority)
      .map((section) => section.content)
      .join("\n\n");

  let remaining = [...kept];
  let text = render(remaining);
  let tokens = estimateTokens(text, options.charsPerToken);

  while (tokens > options.maxTokens) {
    const trimmable = remaining
      .filter((section) => section.priority > CONTEXT_PRIORITY.briefAndMemberTask)
      .sort((left, right) => right.priority - left.priority)[0];

    if (!trimmable) {
      throw new ContextOverflowError(
        `The task brief alone needs ~${tokens} tokens but the model allows ${options.maxTokens}. Bind a larger-context model to this agent.`,
      );
    }

    remaining = remaining.filter((section) => section.id !== trimmable.id);
    dropped.push(trimmable.id);
    text = render(remaining);
    tokens = estimateTokens(text, options.charsPerToken);
  }

  return {
    text,
    tokens,
    droppedSectionIds: dropped,
    degradations:
      dropped.length === 0
        ? []
        : [
            {
              kind: "context_overflow",
              from: "full_context",
              to: "trimmed_context",
              detail: `dropped ${dropped.join(", ")} to fit ${options.maxTokens} context tokens`,
            },
          ],
  };
}
