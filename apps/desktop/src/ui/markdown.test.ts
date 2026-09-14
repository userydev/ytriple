import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "./markdown.js";

describe("parseMarkdown", () => {
  it("reads the shape of a generated PRD", () => {
    const blocks = parseMarkdown(
      [
        "# yTriple PRD",
        "",
        "## Product Summary",
        "",
        "One clean draft.",
        "",
        "## V1 Scope",
        "",
        "- Shared chat",
        "- Task Brief",
        "",
        "## Functional Requirements",
        "",
        "1. **Shared conversation** — one surface",
        "2. **Task Brief** — visible before dispatch",
      ].join("\n"),
    );

    expect(blocks).toEqual([
      { kind: "heading", level: 1, text: "yTriple PRD" },
      { kind: "heading", level: 2, text: "Product Summary" },
      { kind: "paragraph", text: "One clean draft." },
      { kind: "heading", level: 2, text: "V1 Scope" },
      { kind: "bullets", items: ["Shared chat", "Task Brief"] },
      { kind: "heading", level: 2, text: "Functional Requirements" },
      {
        kind: "numbered",
        items: ["**Shared conversation** — one surface", "**Task Brief** — visible before dispatch"],
      },
    ]);
  });

  it("joins wrapped paragraph lines", () => {
    expect(parseMarkdown("first line\nsecond line")).toEqual([
      { kind: "paragraph", text: "first line second line" },
    ]);
  });
});

describe("parseInline", () => {
  it("splits bold and links out of surrounding text", () => {
    expect(parseInline("see **this** and [a source](https://example.com/a) now")).toEqual([
      { kind: "text", text: "see " },
      { kind: "strong", text: "this" },
      { kind: "text", text: " and " },
      { kind: "link", text: "a source", href: "https://example.com/a" },
      { kind: "text", text: " now" },
    ]);
  });

  it("passes plain text through untouched", () => {
    expect(parseInline("nothing special")).toEqual([{ kind: "text", text: "nothing special" }]);
  });
});
