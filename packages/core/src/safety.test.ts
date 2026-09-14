import { describe, expect, it } from "vitest";
import { renderPrdMarkdown } from "./runtime/prdDocument.js";
import { assertSafePathSegment, isSafeHttpUrl, isSafePathSegment } from "./safety.js";

describe("isSafePathSegment", () => {
  it("accepts ordinary task ids", () => {
    for (const value of ["task-1", "task_2", "ci-run", "2026-09-14-abc", "a.b"]) {
      expect(isSafePathSegment(value), value).toBe(true);
    }
  });

  it("rejects POSIX traversal", () => {
    for (const value of ["..", "../outside", "a/b", "/abs", "./x"]) {
      expect(isSafePathSegment(value), value).toBe(false);
    }
  });

  it("rejects Windows traversal, which a slash-only check would let through", () => {
    for (const value of ["..\\outside", "a\\b", "..\\..\\Windows"]) {
      expect(isSafePathSegment(value), value).toBe(false);
      // The point of the rule: these contain no forward slash at all.
      expect(value.includes("/")).toBe(false);
    }
  });

  it("rejects names Windows would silently rewrite or reserve", () => {
    for (const value of ["task.", "task ", "CON", "nul", "com1", "LPT9"]) {
      expect(isSafePathSegment(value), value).toBe(false);
    }
  });

  it("rejects empty, over-long and null-bearing values", () => {
    expect(isSafePathSegment("")).toBe(false);
    expect(isSafePathSegment("a".repeat(129))).toBe(false);
    expect(isSafePathSegment("a\u0000b")).toBe(false);
  });

  it("assertSafePathSegment names the offending value", () => {
    expect(() => assertSafePathSegment("../outside", "taskId")).toThrowError(
      /taskId must be a single path segment.*"\.\.\/outside"/s,
    );
    expect(() => assertSafePathSegment("task-1", "taskId")).not.toThrow();
  });
});

describe("the PRD never links an unsafe URL", () => {
  const brief = {
    productObject: "p",
    targetUser: "u",
    coreScenario: "c",
    painOrProblem: "p",
    v1Scope: ["a"],
    nonGoals: ["b"],
    successCriteria: ["c"],
    assumptions: ["d"],
    openQuestions: ["e"],
    memberTasks: [],
    contextAvailability: { workspace: false, webSearch: true },
  };

  it("renders a javascript: source as plain text, keeping it visible", () => {
    const markdown = renderPrdMarkdown({
      title: "T",
      brief,
      merge: {},
      sources: [
        { title: "Safe", url: "https://example.com/a", origin: "search_port" },
        { title: "Hostile", url: "javascript:alert(1)", origin: "search_port" },
      ],
    });

    expect(markdown).toContain("[Safe](https://example.com/a)");
    expect(markdown).not.toContain("](javascript:");
    // Still shown, so a reviewer can see what the model returned.
    expect(markdown).toContain("Hostile (unsupported link: javascript:alert(1))");
  });
});

describe("isSafeHttpUrl", () => {
  it("accepts http and https", () => {
    expect(isSafeHttpUrl("https://example.com/a")).toBe(true);
    expect(isSafeHttpUrl("http://localhost:3000/x")).toBe(true);
  });

  it("rejects schemes that execute or embed", () => {
    for (const value of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "  javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "blob:https://example.com/uuid",
    ]) {
      expect(isSafeHttpUrl(value), value).toBe(false);
    }
  });

  it("rejects anything that is not a URL at all", () => {
    for (const value of ["", "not a url", "//example.com", "example.com"]) {
      expect(isSafeHttpUrl(value), value).toBe(false);
    }
  });
});
