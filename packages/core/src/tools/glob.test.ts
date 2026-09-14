import { describe, expect, it } from "vitest";
import { matchGlob, matchesAnyGlob, normalizeRelativePath } from "./glob.js";

describe("matchGlob", () => {
  it("matches an extension anywhere with **/", () => {
    expect(matchGlob("**/*.md", "README.md")).toBe(true);
    expect(matchGlob("**/*.md", "docs/product/prd.md")).toBe(true);
    expect(matchGlob("**/*.md", "docs/product/prd.txt")).toBe(false);
  });

  it("matches a whole subtree with a trailing **", () => {
    expect(matchGlob("node_modules/**", "node_modules/react/index.js")).toBe(true);
    expect(matchGlob("node_modules/**", "src/node_modules_helper.ts")).toBe(false);
  });

  it("keeps a single star inside one path segment", () => {
    expect(matchGlob("src/*.ts", "src/index.ts")).toBe(true);
    expect(matchGlob("src/*.ts", "src/nested/index.ts")).toBe(false);
  });

  it("treats dots literally", () => {
    expect(matchGlob(".git/**", ".git/config")).toBe(true);
    expect(matchGlob(".git/**", "xgit/config")).toBe(false);
  });

  it("matches a single character with ?", () => {
    expect(matchGlob("v?.md", "v1.md")).toBe(true);
    expect(matchGlob("v?.md", "v10.md")).toBe(false);
  });
});

describe("matchesAnyGlob", () => {
  it("is true when any pattern matches", () => {
    expect(matchesAnyGlob(["**/*.ts", "**/*.md"], "docs/a.md")).toBe(true);
    expect(matchesAnyGlob(["**/*.ts", "**/*.md"], "docs/a.png")).toBe(false);
  });
});

describe("normalizeRelativePath", () => {
  it("normalises separators and leading markers", () => {
    expect(normalizeRelativePath("./docs\\product\\prd.md")).toBe("docs/product/prd.md");
    expect(normalizeRelativePath("/docs/prd.md")).toBe("docs/prd.md");
  });
});
