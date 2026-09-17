import type { Contribution, Snapshot } from "../core/types";
import type { ToolReceipt } from "../core/tool-contract";
import { calculationOutput, materialOutput } from "../core/tool-contract";
import { References } from "./References";
const operations = {
  add: "求和",
  subtract: "相减",
  multiply: "相乘",
  divide: "相除",
  percent_change: "相对变化",
};
export function ToolEvidence({
  receipt,
  contribution,
  data,
}: {
  receipt: ToolReceipt;
  contribution: Contribution;
  data: Snapshot;
}) {
  let result: unknown;
  try {
    result = JSON.parse(receipt.output);
  } catch {
    result = null;
  }
  const calc = calculationOutput.safeParse(result),
    material = materialOutput.safeParse(result);
  const input = receipt.request.input;
  const refs =
    contribution.task?.refs ??
    data.runs.find((r) => r.id === contribution.runId)?.refs ??
    [];
  const ref =
    receipt.request.key === "builtin.material@1"
      ? refs[receipt.request.input.reference - 1]
      : undefined;
  return (
    <details className="method-provenance">
      <summary>查看工具输入与实际返回</summary>
      {receipt.request.key === "builtin.calculate@1" ? (
        <>
          <p>
            {operations[receipt.request.input.operation]} ·{" "}
            {receipt.request.input.values.join("、")}
          </p>
          {receipt.status === "succeeded" && calc.success ? (
            <p>
              <strong>
                结果：{calc.data.result}
                {calc.data.unit === "%" ? "%" : ""}
              </strong>
            </p>
          ) : (
            <p className="error-inline">
              {receipt.status === "failed"
                ? receipt.output
                : "返回格式无法展示，请核对原始记录。"}
            </p>
          )}
          <small>
            数值计算不能证明输入来自实测，也不能确定原因或调整效果。
          </small>
        </>
      ) : (
        <>
          {ref ? (
            <References data={data} refs={[ref]} disabled onChange={() => {}} />
          ) : null}
          <p>
            {receipt.request.input.mode === "find"
              ? `查找“${receipt.request.input.text}”`
              : `从位置 ${receipt.request.input.start} 读取，最多 ${receipt.request.input.maxChars} 字符`}
          </p>
          {receipt.status === "failed" ? (
            <p className="error-inline">{receipt.output}</p>
          ) : material.success ? (
            <>
              <small>
                {material.data.source.selection} · 版本{" "}
                {material.data.source.version}
              </small>
              {"text" in material.data ? (
                <p className="reference-preview">{material.data.text}</p>
              ) : (
                <>
                  {!material.data.matches.length ? (
                    <p>在本次分配的范围内没有字面匹配。</p>
                  ) : (
                    <ol>
                      {material.data.matches.map((match, index) => (
                        <li key={index}>
                          <small>
                            位置 {match.start}–{match.end}
                          </small>
                          <p className="reference-preview">{match.text}</p>
                        </li>
                      ))}
                    </ol>
                  )}
                </>
              )}
              {material.data.more ? (
                <p className="muted">
                  仍有未展示内容；本次返回不代表已读取全部材料。
                </p>
              ) : null}
            </>
          ) : (
            <p>返回格式无法展示，可展开原始记录核对。</p>
          )}
        </>
      )}
      <details>
        <summary>原始记录与执行时间</summary>
        <small>
          {receipt.request.key} · {new Date(receipt.createdAt).toLocaleString()}
        </small>
        <pre>{JSON.stringify(input, null, 2)}</pre>
        <pre>{receipt.output}</pre>
      </details>
    </details>
  );
}
