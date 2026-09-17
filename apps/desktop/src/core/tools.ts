import { createHash } from "node:crypto";
import type { Store } from "./store";
import type { Run, Member, Reference } from "./types";
import {
  memberTools,
  toolRequestSchema,
  type ToolReceipt,
  type ToolRequest,
} from "./tool-contract";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
// These adapters are deterministic and have no external effects. External/MCP
// adapters must provide their own authorization and recovery, not reuse this guarantee.
export class LocalTools {
  constructor(private store: Store) {}
  execute(
    run: Run,
    member: Member,
    contributionId: string,
    refs: Reference[],
    raw: ToolRequest,
    signal: AbortSignal,
  ): ToolReceipt {
    if (signal.aborted)
      throw new DOMException("工具执行前已停止", "AbortError");
    const request = toolRequestSchema.parse(raw);
    if (!memberTools(run, member).some((t) => t.key === request.key))
      throw Error("工具不在此成员本轮获准范围内，未执行");
    if (
      !refs.every((ref) =>
        run.refs.some(
          (r) =>
            r.materialId === ref.materialId &&
            r.version === ref.version &&
            r.excerpt === ref.excerpt,
        ),
      )
    )
      throw Error("工具材料超出本轮范围，未执行");
    const owner = this.store.require<import("./types").Contribution>(
      "contribution",
      contributionId,
    );
    if (
      owner.runId !== run.id ||
      owner.memberId !== member.id ||
      owner.status !== "succeeded"
    )
      throw Error("工具请求缺少已完成的成员记录");
    const assigned = owner.task?.refs ?? run.refs;
    if (JSON.stringify(refs) !== JSON.stringify(assigned))
      throw Error("工具材料与该成员的任务范围不一致");
    const fingerprint = hash(
      JSON.stringify({ request, refs, runId: run.id, memberId: member.id }),
    );
    const id = `tool:${contributionId}`;
    return this.store.transaction(() => {
      const existing = this.store.get<ToolReceipt>("tool-call", id);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw Error("同一工具调用的内容或范围已变化");
        return existing;
      }
      const previous = this.store
        .all<ToolReceipt>("tool-call")
        .filter((c) => c.runId === run.id);
      if (previous.length >= (run.tools?.maxCalls ?? 0))
        throw Error("已达到本轮工具执行上限，未执行更多请求");
      if (
        previous.some(
          (c) =>
            c.memberId === member.id &&
            c.request.key === request.key &&
            JSON.stringify(c.request.input) === JSON.stringify(request.input) &&
            c.fingerprint === fingerprint,
        )
      )
        throw Error("成员重复请求相同工具与输入，已停止循环");
      let output: string,
        status: ToolReceipt["status"] = "succeeded";
      try {
        output = this.perform(request, refs);
        if (output.length > 16000)
          throw Error(
            "工具返回超过 16000 字符，请缩小读取范围；未返回截断结果",
          );
      } catch (e) {
        status = "failed";
        const message = e instanceof Error ? e.message : "工具执行失败";
        output =
          message.length > 1000
            ? message.slice(0, 1000) + "（错误说明已截短）"
            : message;
      }
      return this.store.put("tool-call", id, {
        id,
        runId: run.id,
        contributionId,
        memberId: member.id,
        fingerprint,
        request,
        status,
        output,
        createdAt: new Date().toISOString(),
      } satisfies ToolReceipt);
    });
  }
  private perform(request: ToolRequest, refs: Reference[]) {
    if (request.key === "builtin.calculate@1") {
      const { operation, values } = request.input;
      if (!["add", "multiply"].includes(operation) && values.length !== 2)
        throw Error("此运算需要且仅需要两个数值");
      const [a, b] = values;
      if (
        (operation === "divide" && b === 0) ||
        (operation === "percent_change" && a === 0)
      )
        throw Error("分母为零，无法计算；不返回 Infinity 或有效百分比");
      const result =
        operation === "add"
          ? values.reduce((x, y) => x + y, 0)
          : operation === "multiply"
            ? values.reduce((x, y) => x * y, 1)
            : operation === "subtract"
              ? a - b
              : operation === "divide"
                ? a / b
                : ((b - a) / a) * 100;
      if (
        !Number.isFinite(result) ||
        (result === 0 &&
          operation === "multiply" &&
          values.every((v) => v !== 0))
      )
        throw Error("结果超出有限浮点数范围");
      return JSON.stringify(
        {
          result: Number(result.toPrecision(15)),
          unit: operation === "percent_change" ? "%" : "沿用输入约定",
          precision:
            "IEEE-754 数值计算，最多 15 位有效数字；不提供精确财务运算",
          evidence: "仅计算传入数字，不证明测量、归因或效果",
        },
        null,
        2,
      );
    }
    const input = request.input,
      ref = refs[input.reference - 1];
    if (!ref) throw Error("材料序号不在本任务分配范围内");
    const material = this.store.material(ref);
    if (material.readError)
      throw Error(`该版本没有可读正文：${material.readError}`);
    const body = ref.excerpt ?? material.body;
    const source = {
      materialId: ref.materialId,
      version: ref.version,
      title: material.title,
      coverage: material.coverage,
      selection: ref.excerpt !== undefined ? "用户选段" : "该版本已读正文",
      sha256: hash(body),
      length: body.length,
    };
    if (input.mode === "read") {
      if (input.start > body.length) throw Error("读取起点超过选中正文长度");
      const end = Math.min(body.length, input.start + input.maxChars);
      return JSON.stringify(
        {
          source,
          start: input.start,
          end,
          text: body.slice(input.start, end),
          more: end < body.length,
        },
        null,
        2,
      );
    }
    const matches: { start: number; end: number; text: string }[] = [];
    let from = 0,
      index: number;
    while (
      (index = body.indexOf(input.text, from)) !== -1 &&
      matches.length < input.maxMatches
    ) {
      matches.push({
        start: index,
        end: index + input.text.length,
        text: body.slice(
          Math.max(0, index - 120),
          Math.min(body.length, index + input.text.length + 120),
        ),
      });
      from = index + input.text.length;
    }
    return JSON.stringify(
      {
        source,
        matches,
        more: body.indexOf(input.text, from) !== -1,
        interpretation:
          "区分大小写的字面查找；无匹配不证明其他材料也不存在。位置相对于当前选中范围。",
      },
      null,
      2,
    );
  }
}
