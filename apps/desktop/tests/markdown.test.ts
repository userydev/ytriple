import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "../src/ui/Markdown";
test("generated method tables render as accessible tables while raw HTML and unsafe links remain inert", () => {
  const html = renderToStaticMarkup(
    createElement(Markdown, {
      children:
        "| 步骤 | 完成证据 |\n| --- | --- |\n| 核对 | 真实记录 |\n\n- [ ] 待验证\n\n<script>alert(1)</script>\n\n[bad](javascript:alert%281%29)",
    }),
  );
  assert.match(html, /<table>/);
  assert.match(html, /<th>步骤<\/th>/);
  assert.match(html, /<td>真实记录<\/td>/);
  assert.match(html, /type="checkbox" disabled/);
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes('href="javascript:'));
});
