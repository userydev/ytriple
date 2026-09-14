import { describe, expect, it } from "vitest";
import {
  CONTEXT_PRIORITY,
  ContextOverflowError,
  assembleContext,
  estimateTokens,
  type ContextSection,
} from "./contextBudget.js";

function section(id: string, priority: number, size: number): ContextSection {
  return { id, priority, content: `${id}:`.padEnd(size, "x") };
}

const sections: ContextSection[] = [
  section("brief", CONTEXT_PRIORITY.briefAndMemberTask, 400),
  section("role", CONTEXT_PRIORITY.roleAndTools, 400),
  section("chat:recent", CONTEXT_PRIORITY.recentChat, 400),
  section("workspace", CONTEXT_PRIORITY.workspaceSummaries, 400),
  section("chat:earlier", CONTEXT_PRIORITY.earlyChat, 400),
  section("search", CONTEXT_PRIORITY.rawSearchResults, 400),
];

describe("assembleContext", () => {
  it("keeps everything when it fits", () => {
    const assembled = assembleContext(sections, { maxTokens: 10_000, charsPerToken: 4 });
    expect(assembled.droppedSectionIds).toEqual([]);
    expect(assembled.degradations).toEqual([]);
    expect(assembled.text).toContain("brief:");
    expect(assembled.text).toContain("search:");
  });

  it("drops in priority order, lowest priority first", () => {
    // Each section is ~100 tokens; a 250-token budget leaves room for two.
    const assembled = assembleContext(sections, { maxTokens: 250, charsPerToken: 4 });
    expect(assembled.droppedSectionIds).toEqual([
      "search",
      "chat:earlier",
      "workspace",
      "chat:recent",
    ]);
    expect(assembled.text).toContain("brief:");
    expect(assembled.text).toContain("role:");
  });

  it("reports the trim as a single degradation", () => {
    const assembled = assembleContext(sections, { maxTokens: 250, charsPerToken: 4 });
    expect(assembled.degradations).toEqual([
      {
        kind: "context_overflow",
        from: "full_context",
        to: "trimmed_context",
        detail: "dropped search, chat:earlier, workspace, chat:recent to fit 250 context tokens",
      },
    ]);
  });

  it("orders output by priority regardless of input order", () => {
    const shuffled = [sections[3]!, sections[0]!, sections[2]!];
    const assembled = assembleContext(shuffled, { maxTokens: 10_000, charsPerToken: 4 });
    expect(assembled.text.indexOf("brief:")).toBeLessThan(assembled.text.indexOf("chat:recent:"));
    expect(assembled.text.indexOf("chat:recent:")).toBeLessThan(assembled.text.indexOf("workspace:"));
  });

  it("fails rather than dropping the brief", () => {
    expect(() =>
      assembleContext([section("brief", CONTEXT_PRIORITY.briefAndMemberTask, 4_000)], {
        maxTokens: 100,
        charsPerToken: 4,
      }),
    ).toThrowError(ContextOverflowError);
  });

  it("ignores empty sections", () => {
    const assembled = assembleContext(
      [...sections, { id: "empty", priority: 9, content: "   " }],
      { maxTokens: 10_000, charsPerToken: 4 },
    );
    expect(assembled.text).not.toContain("empty");
  });
});

describe("estimateTokens", () => {
  it("scales with the configured characters per token", () => {
    expect(estimateTokens("x".repeat(40), 4)).toBe(10);
    expect(estimateTokens("x".repeat(40), 8)).toBe(5);
  });
});
