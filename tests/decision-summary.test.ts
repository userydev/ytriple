import test from "node:test";
import assert from "node:assert/strict";
import { decisionExcerpt } from "../src/workbench/decision-summary.js";

test("a meeting report retains the conclusion, evidence, tradeoff and decision without mechanical shortening", () => {
  const report = `## 结论\n\n推荐先把已有工作流打通，再增加外部来源。\n\n## 关键依据\n\n${"现有流程能够覆盖核心任务，但需要减少中断。".repeat(24)}\n\n## 取舍\n\n先做稳定性会延后来源数量，但能降低反复返工。\n\n## 需要决定\n\n请确认优先本地资料闭环还是更多平台。\n\n[完整数据](artifact:report-1)`;
  assert.ok(report.length > 380);
  assert.deepEqual(decisionExcerpt(report), { text: report, detailed: false });
});

test("long report excerpts keep parent conclusions, nested risks and reference links", () => {
  const report = `# 团队汇报\n\n## 结论\n\n建议先验证离线可用性。\n\n### 风险\n\n同步成本还需要测量，见[研究依据][paper]。\n\n## 关键依据\n\n已有三次样本测试。\n\n## 待确认\n\n是否接受第一版只做前台运行。\n\n## 附录\n\n${"逐项原始记录，只在完整文档查阅。".repeat(250)}\n\n[paper]: https://example.com/evidence`;
  const result = decisionExcerpt(report);
  assert.equal(result.detailed, true);
  assert.match(result.text, /建议先验证离线可用性/);
  assert.match(result.text, /同步成本还需要测量/);
  assert.match(result.text, /已有三次样本测试/);
  assert.match(result.text, /是否接受第一版只做前台运行/);
  assert.match(result.text, /\[paper\]: https:\/\/example.com\/evidence/);
  assert.doesNotMatch(result.text, /逐项原始记录/);
});

test("decision section budgets keep multiline math with blank lines whole or omit the entire formula", () => {
  const appendix = "\n\n## 附录\n\n" + "完整记录留在详情。".repeat(400);
  const formula = "$$\na=b\n\nc=d+e\n$$";
  const included = decisionExcerpt(
    `## 结论\n\n模型关系如下。\n\n${formula}\n\n可以继续验证。${appendix}`,
  );
  assert.equal(included.detailed, true);
  assert.ok(included.text.includes(formula));
  assert.match(included.text, /可以继续验证/);
  const oversized = `$$\na=b\n\n${"x_{n+1}=x_n+1; ".repeat(90)}\n$$`;
  const omitted = decisionExcerpt(
    `## 结论\n\n建议先验证边界条件。\n\n${oversized}\n\n### 风险\n\n输入范围仍待确认。${appendix}`,
  );
  assert.match(omitted.text, /建议先验证边界条件/);
  assert.match(omitted.text, /输入范围仍待确认/);
  assert.doesNotMatch(
    omitted.text,
    /\$\$|a=b|x_\{n\+1\}/,
    "the opening lines of an oversized formula must not leak into the excerpt",
  );
});

test("fallback excerpts also treat an oversized blank-line formula as one block", () => {
  const formula = `$$\na=b\n\n${"q_{k+1}=q_k+2; ".repeat(180)}\n$$`;
  const result = decisionExcerpt(
    `数学说明采用以下符号。\n\n${formula}\n\n${"其他详情。".repeat(100)}`,
  );
  assert.equal(result.detailed, true);
  assert.equal(result.text, "数学说明采用以下符号。");
});

test("TeX normalization and extraction share offsets while retaining nested sections and references", () => {
  const appendix = "\n\n## 附录\n\n" + "原始计算步骤。".repeat(500);
  const report =
    String.raw`## 结论

先验证 \(x+y=z\)，引用[计算记录][calculation]。

\[
\begin{aligned}
a &= b+c \\
d &= e+f
\end{aligned}
\]

### 风险

边界条件尚需确认。

[calculation]: https://example.com/calculation` + appendix;
  const result = decisionExcerpt(report);
  assert.equal(result.detailed, true);
  assert.match(
    result.text,
    /先验证 \$x\+y=z\$，引用\[计算记录\]\[calculation\]。/,
  );
  assert.ok(
    result.text.includes(
      "$$\n\\begin{aligned}\na &= b+c \\\\\nd &= e+f\n\\end{aligned}\n$$",
    ),
  );
  assert.match(result.text, /### 风险\n\n边界条件尚需确认。/);
  assert.match(
    result.text,
    /\[calculation\]: https:\/\/example.com\/calculation/,
  );
  assert.doesNotMatch(result.text, /原始计算步骤/);
});
