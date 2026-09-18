import { z } from "zod";
import { workspaceToolInputSchema } from "./workspace-action-contract";
export const toolKey = z.enum([
  "builtin.calculate@1",
  "builtin.material@1",
  "builtin.workspace@1",
]);
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
  {
    key: "builtin.workspace@1" as const,
    name: "工作台",
    description:
      "读取有界的雷达议题、公开来源、定时任务和团队能力；也可提出类型化操作。安全且可逆的当前对象操作可能直接完成，新增授权、周期执行和扩大范围会生成待确认卡，不得声称待确认操作已经完成。",
    input:
      '先用 {"mode":"inspect","query":"可选准确名称"} 取得真实 ID、revision、来源、成员、时区及当前对象 input。操作用 {"mode":"act","action":...}，严格字段如下：\n' +
      '1. 雷达议题：{"kind":"radar-topic","topic":{"id":"编辑时用现有UUID；新建省略","revision":0,"title":"1-120字","focus":"0-2000字","feedIds":["UUID，最多5个"],"feedLimit":8,"sourceIds":["公开来源ID，最多10个"],"keywords":["最多12个，每项1-120字"],"sources":[{"materialId":"材料ID","policy":"auto|keep|exclude","reason":"0-500字"}]}}。新建 revision 必须为0；编辑使用 inspect 的 id/revision；sources/feedIds/sourceIds 至少一类非空；不要提交 archived。\n' +
      '2. 新建或编辑定时任务：{"kind":"schedule","input":{"id":"编辑用现有UUID；新建省略由客户端生成","expectedRevision":0,"name":"1-120字","workId":null,"projectId":null,"text":"1-16000字","refs":[{"materialId":"ID","version":1,"label":"名称","excerpt":"可选固定选段"}],"recipient":null,"skillKeys":[],"outputMode":"result|explanation|summary|review|readiness|method","firstAt":"未来ISO-8601时刻，优先UTC Z，也接受合法时区偏移","intervalHours":null,"timezone":"IANA时区","followLatest":false,"maxModelCalls":4,"enabled":true}}。编辑必须完整复用 inspect.input 后只改目标字段；intervalHours 为 null 表示一次，或1-8760整数；refs最多20、skillKeys最多4、maxModelCalls 1-32。需要用户确认由宿主 pending 卡控制，不能因此把 enabled 改为 false；用户要求按期执行时 enabled=true，只有用户明确要求草稿或暂停时才是 false。缺少明确时间/时区先提待决，不能猜。\n' +
      '3. 启停现有任务：{"kind":"schedule-enabled","id":"现有UUID","revision":1,"enabled":false}。\n' +
      '4. 雷达自动整理：{"kind":"radar-watch","input":{"topicId":"议题UUID","topicRevision":1,"expectedRevision":0,"enabled":true,"intervalMinutes":60,"maxCallsPerDay":4}}；intervalMinutes 30-10080，maxCallsPerDay 1-24；新设置 expectedRevision=0，编辑用 inspect 的 watch revision。所有字段都必须来自用户目标与 inspect 事实；不得编造 ID、revision、时间或已执行状态。',
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
  z
    .object({
      key: z.literal("builtin.workspace@1"),
      purpose: z.string().trim().min(1).max(500),
      input: workspaceToolInputSchema,
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
function conciseToolError(error: z.ZodError) {
  const fields = [
    ...new Set(
      error.issues.slice(0, 3).map((issue) =>
        issue.path.length ? issue.path.join(".") : "请求",
      ),
    ),
  ];
  return `工具请求字段不符合要求：${fields.join("、")}。请按工具说明修正；未执行任何操作`;
}
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
  const parsed = z
    .object({ ytriple_tool: toolRequestSchema })
    .strict()
    .safeParse(value);
  if (!parsed.success) throw Error(conciseToolError(parsed.error));
  return parsed.data.ytriple_tool;
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
  const status =
    receipt.status === "failed"
      ? "执行失败"
      : receipt.request.key === "builtin.workspace@1"
        ? "已记录实际结果；以返回中的 pending/applied 状态为准"
        : "执行完成";
  return `工具：${name}（${receipt.request.key}）\n用途：${receipt.request.purpose}\n状态：${status}\n输入：${JSON.stringify(receipt.request.input)}\n实际返回：\n${receipt.output}\n\n这是实际工具记录，不是成员公开分析，也不证明来源主张或使用效果。`;
}
