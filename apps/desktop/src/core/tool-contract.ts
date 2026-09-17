import { z } from "zod";
export const toolKey = z.enum(["builtin.calculate@1", "builtin.material@1"]);
export type ToolKey = z.infer<typeof toolKey>;
export const toolCatalog = [
  {
    key: "builtin.calculate@1" as const,
    name: "数值计算",
    description:
      "根据明确数字做四则运算或变化百分比；不验证数字来源或实际效果。",
    input:
      '{"operation":"add|subtract|multiply|divide|percent_change","values":[60,75]}；add/multiply 接受 2–32 个数字，其他恰好两个；percent_change=(第二个-第一个)/第一个×100。',
  },
  {
    key: "builtin.material@1" as const,
    name: "材料查阅",
    description:
      "只查阅本任务分配的准确材料版本或选段，不打开磁盘、链接或其他工作。",
    input:
      '{"mode":"read","reference":1,"start":0,"maxChars":2000}，或 {"mode":"find","reference":1,"text":"字面检索词","maxMatches":5}；reference 是本任务材料一基序号，start 为选中范围内从 0 开始的 UTF-16 位置，单次最多 6000 字符。',
  },
];
const number = z.number().finite().min(-1e12).max(1e12);
export const toolRequestSchema = z.discriminatedUnion("key", [
  z
    .object({
      key: z.literal("builtin.calculate@1"),
      purpose: z.string().trim().min(1).max(500),
      input: z
        .object({
          operation: z.enum([
            "add",
            "subtract",
            "multiply",
            "divide",
            "percent_change",
          ]),
          values: z.array(number).min(2).max(32),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      key: z.literal("builtin.material@1"),
      purpose: z.string().trim().min(1).max(500),
      input: z.discriminatedUnion("mode", [
        z
          .object({
            mode: z.literal("read"),
            reference: z.number().int().min(1).max(100),
            start: z.number().int().min(0).max(1e7),
            maxChars: z.number().int().min(1).max(6000),
          })
          .strict(),
        z
          .object({
            mode: z.literal("find"),
            reference: z.number().int().min(1).max(100),
            text: z.string().min(1).max(200),
            maxMatches: z.number().int().min(1).max(10),
          })
          .strict(),
      ]),
    })
    .strict(),
]);
export type ToolRequest = z.infer<typeof toolRequestSchema>;
export const calculationOutput = z
  .object({
    result: z.number().finite(),
    unit: z.string(),
    precision: z.string(),
    evidence: z.string(),
  })
  .strict();
const source = z
  .object({
    materialId: z.string(),
    version: z.number().int().positive(),
    title: z.string(),
    coverage: z.string(),
    selection: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    length: z.number().int().nonnegative(),
  })
  .strict();
export const materialOutput = z.union([
  z
    .object({
      source,
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
      text: z.string(),
      more: z.boolean(),
    })
    .strict(),
  z
    .object({
      source,
      matches: z
        .array(
          z
            .object({
              start: z.number().int().nonnegative(),
              end: z.number().int().nonnegative(),
              text: z.string(),
            })
            .strict(),
        )
        .max(10),
      more: z.boolean(),
      interpretation: z.string(),
    })
    .strict(),
]);
export type ToolReceipt = {
  id: string;
  runId: string;
  contributionId: string;
  memberId: string;
  fingerprint: string;
  request: ToolRequest;
  status: "succeeded" | "failed";
  output: string;
  createdAt: string;
};
export type ToolPolicy = { keys: ToolKey[]; maxCalls: number };
export function parseToolRequest(body: string): ToolRequest | null {
  if (/^\s*```(?:json)?\s*\{\s*"ytriple_tool"\s*:/.test(body))
    throw Error("工具请求必须使用独立 JSON 对象，未执行代码围栏中的请求");
  let value: unknown;
  try {
    value = JSON.parse(body.trim());
  } catch {
    if (/^\s*\{\s*"ytriple_tool"\s*:/.test(body))
      throw Error("工具请求不完整，未执行");
    return null;
  }
  if (!value || typeof value !== "object" || !("ytriple_tool" in value))
    return null;
  return z.object({ ytriple_tool: toolRequestSchema }).strict().parse(value)
    .ytriple_tool;
}
export function captureTools(team: {
  members: { toolKeys?: ToolKey[] }[];
}): ToolPolicy {
  return {
    keys: [...new Set(team.members.flatMap((m) => m.toolKeys ?? []))],
    maxCalls: 8,
  };
}
export function memberTools(
  run: { tools?: ToolPolicy },
  member: { toolKeys?: ToolKey[] },
) {
  return toolCatalog.filter(
    (t) => run.tools?.keys.includes(t.key) && member.toolKeys?.includes(t.key),
  );
}
export function toolRecordText(receipt: ToolReceipt) {
  const name =
    toolCatalog.find((t) => t.key === receipt.request.key)?.name ??
    receipt.request.key;
  return `工具：${name}（${receipt.request.key}）\n用途：${receipt.request.purpose}\n状态：${receipt.status === "succeeded" ? "执行完成" : "执行失败"}\n输入：${JSON.stringify(receipt.request.input)}\n实际返回：\n${receipt.output}\n\n这是实际工具记录，不是成员公开分析，也不证明来源主张或使用效果。`;
}
