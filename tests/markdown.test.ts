import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/workbench/common.js";
import { normalizeMathDelimiters } from "../src/shared/markdown.js";
const render = (content: string) =>
  renderToStaticMarkup(
    createElement(Markdown, { children: content, dispatch: async () => null }),
  );

test("table line breaks render without enabling raw HTML or rewriting code examples", () => {
  const html = render(
    "| 方案 | 内容 |\n| --- | --- |\n| A | 第一行<br>第二行 |\n\n`<br>`\n\n<script>unsafe()</script>",
  );
  assert.match(html, /第一行<br\/>\n第二行/);
  assert.match(html, /<code>&lt;br&gt;<\/code>/);
  assert.doesNotMatch(html, /<script>/);
});

test("Markdown renders model and standard TeX delimiters as accessible inline and display mathematics", () => {
  const html = render(String.raw`Inline $x^2$ and \(\frac{a}{b}\).

$$
\sum_{i=1}^{n} i = \frac{n(n+1)}{2}
$$

\[
E = mc^2
\]`);
  assert.equal((html.match(/class="katex"/g) ?? []).length, 4);
  assert.equal((html.match(/class="katex-display"/g) ?? []).length, 2);
  assert.match(html, /<math /);
  assert.doesNotMatch(html, /katex-error/);
});

test("math normalization preserves code fences, inline code, escapes, indented code and incomplete formulas", () => {
  const content = [
    String.raw`Use \(x\) and $\left[ x \right]$.`,
    "Inline: `\\(unchanged\\)`",
    "```js",
    String.raw`const example = "\[unchanged\]";`,
    "```",
    "~~~text",
    String.raw`\(also unchanged\)`,
    "~~~",
    String.raw`    \(indented\)`,
    String.raw`Escaped: \\(text\\)`,
    String.raw`Unclosed: \(x + 1`,
  ].join("\n");
  const normalized = normalizeMathDelimiters(content);
  assert.ok(normalized.startsWith(String.raw`Use $x$ and $\left[ x \right]$.`));
  assert.match(normalized, /const example = "\\\[unchanged\\\]"/);
  assert.ok(normalized.includes(String.raw`    \(indented\)`));
  assert.ok(normalized.includes(String.raw`Escaped: \\(text\\)`));
  assert.ok(normalized.includes(String.raw`Unclosed: \(x + 1`));
  assert.ok(normalized.includes(String.raw`\(also unchanged\)`));
});

test("invalid math stays readable and untrusted math or HTML cannot create active links or scripts", () => {
  const html = render(String.raw`$\frac{1$

<script>window.secret()</script>

$\href{javascript:alert(1)}{unsafe}$`);
  assert.match(html, /katex-error/);
  assert.doesNotMatch(html, /<script|href="javascript:/);
});

test("headings, footnotes, tables and code use document navigation and overflow containers", () => {
  const html = render(
    "[Go](#结论)\n\n# 结论\n\n# 结论\n\n| A | B |\n| --- | --- |\n| cell | value |\n\n```ts\nconst x = 1;\n```\n\nA note[^a].\n\n[^a]: Footnote",
  );
  assert.match(html, /id="结论"/);
  assert.match(html, /id="结论-1"/);
  assert.match(html, /markdown-table-scroll/);
  assert.match(html, /<pre><code class="language-ts">/);
  assert.match(html, /footnotes/);
  assert.match(html, /href="#%E7%BB%93%E8%AE%BA"/);
  assert.match(html, /id="user-content-fnref-a"/);
});

test("math normalization leaves nested code blocks and link destinations byte-for-byte intact", () => {
  const markdown = [
    "> ```txt",
    String.raw`> \[not math\]`,
    "> ```",
    "",
    "- Item",
    "",
    "  ```txt",
    String.raw`  \(not math\)`,
    "  ```",
    "",
    String.raw`[source](https://example.com/\(literal\))`,
    "",
    String.raw`Actual \(x+y\).`,
  ].join("\n");
  assert.equal(
    normalizeMathDelimiters(markdown),
    markdown.replace(String.raw`Actual \(x+y\).`, "Actual $x+y$."),
  );
});
