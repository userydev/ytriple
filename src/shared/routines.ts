import { z } from "zod";
import type { SkillDefinition } from "./skills.js";
import type { MemberId, TaskKind } from "./types.js";

const zone = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }, "请选择有效的时区。");
const wallTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const routineScheduleSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("time"),
      cadence: z.enum(["daily", "weekly", "interval"]),
      timezone: zone,
      time: wallTime.optional(),
      weekday: z.number().int().min(0).max(6).optional(),
      everyMinutes: z.number().int().min(5).max(525600).optional(),
    })
    .strict()
    .superRefine((schedule, context) => {
      if (
        schedule.cadence === "interval"
          ? !schedule.everyMinutes
          : !schedule.time
      )
        context.addIssue({ code: "custom", message: "请设置执行时间或间隔。" });
      if (schedule.cadence === "weekly" && schedule.weekday === undefined)
        context.addIssue({ code: "custom", message: "每周执行需要选择星期。" });
    }),
  z
    .object({
      kind: z.literal("change"),
      pollMinutes: z.number().int().min(1).max(1440),
      timezone: zone,
    })
    .strict(),
  z
    .object({
      kind: z.literal("after_node"),
      node: z.literal("published"),
      delayMinutes: z.number().int().min(0).max(525600),
      timezone: zone,
    })
    .strict(),
]);
export type RoutineSchedule = z.infer<typeof routineScheduleSchema>;
export const routineLimitsSchema = z
  .object({
    maxRuns: z.number().int().min(1).max(10000),
    maxTokens: z.number().int().min(1).max(100000000),
  })
  .strict();
export type RoutineLimits = z.infer<typeof routineLimitsSchema>;
const templateId = z.enum([
  "project-changes",
  "saved-digest",
  "column-prep",
  "post-review",
  "asset-check",
]);
const requestId = z.string().trim().min(1).max(160);
const id = z.string().trim().min(1).max(160);
export const routineCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("routine.create"),
      requestId,
      taskId: id,
      title: z.string().trim().min(1).max(160).optional(),
      templateId: templateId.optional(),
      schedule: routineScheduleSchema,
      limits: routineLimitsSchema.optional(),
      libraryIds: z.array(id).max(100).optional(),
      watchTaskSources: z.boolean().optional(),
      location: z.literal("client").optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("routine.edit"),
      requestId,
      routineId: id,
      expectedVersion: z.number().int().min(1),
      title: z.string().trim().min(1).max(160).optional(),
      schedule: routineScheduleSchema.optional(),
      limits: routineLimitsSchema.optional(),
      libraryIds: z.array(id).max(100).optional(),
      watchTaskSources: z.boolean().optional(),
    })
    .strict(),
  ...(
    ["routine.run", "routine.pause", "routine.resume", "routine.stop"] as const
  ).map((type) =>
    z.object({ type: z.literal(type), requestId, routineId: id }).strict(),
  ),
  z
    .object({
      type: z.literal("routine.recordNode"),
      requestId,
      routineId: id,
      occurredAt: z.iso.datetime({ offset: true }),
      evidence: z.string().trim().min(1).max(2000),
      actual: z.literal(true),
    })
    .strict(),
]);
export type RoutineCommand = z.infer<typeof routineCommandSchema>;
export type RoutineState =
  "active" | "paused" | "running" | "waiting" | "failed" | "stopped";
export interface RoutineRun {
  id: string;
  startedAt: string;
  finishedAt?: string;
  trigger: "schedule" | "change" | "node" | "manual";
  state:
    | "running"
    | "completed"
    | "unchanged"
    | "failed"
    | "interrupted"
    | "waiting";
  inputFingerprint: string;
  version: number;
  skillHashes: string[];
  tokens: number;
  usageKnown: boolean;
  sourceIds: string[];
  artifactIds: string[];
  summary: string;
  meaningful: boolean;
}
export interface Routine {
  id: string;
  title: string;
  taskId: string;
  workTaskId?: string;
  projectId?: string;
  templateId?: z.infer<typeof templateId>;
  version: number;
  state: RoutineState;
  goal: string;
  kind: TaskKind;
  member: MemberId;
  teamMode?: "software" | "media";
  schedule: RoutineSchedule;
  limits: RoutineLimits;
  location: "client" | "server";
  scope: {
    taskSources: boolean;
    sourceIds: string[];
    libraryIds: string[];
    aiRoot: string;
    workspace: string;
  };
  skills: SkillDefinition[];
  permissionVersion: string;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string;
  lastCheckedAt?: string;
  lastInputFingerprint?: string;
  consumedNodeId?: string;
  node?: {
    id: string;
    occurredAt: string;
    evidence: string;
    recordedAt: string;
  };
  runCount: number;
  tokens: number;
  usageKnown: boolean;
  runs: RoutineRun[];
  lastError?: string;
  /** Hidden output IDs mapped to stable deliverables in the original task. */
  outputs: Record<
    string,
    { artifactId: string; hash: string; sourceHash: string }
  >;
}
export const ROUTINE_TEMPLATES = [
  {
    id: "project-changes" as const,
    name: "项目变化",
    description: "消化原项目新增或修订资料，说明影响与待决定事项。",
    goal: "检查本轮项目资料相对上次输入的变化，说明对目标的影响、证据和需要处理的具体事项。",
  },
  {
    id: "saved-digest" as const,
    name: "收藏消化",
    description: "阅读选定收藏的新版本和反馈，补充原说明。",
    goal: "消化选定收藏的新版本和反馈；区分新增、补充、重复、冲突，更新原有说明。",
  },
  {
    id: "column-prep" as const,
    name: "栏目准备",
    description: "把新增材料整理成栏目选题和可制作的准备稿。",
    goal: "根据新增资料准备本栏目选题和脚本方向，说明事实依据、角度、素材缺口与制作条件。",
  },
  {
    id: "post-review" as const,
    name: "发布后复盘",
    description: "在真实发布节点之后，依据实际反馈复盘。",
    goal: "基于真实发布后已提供的反馈复盘内容，区分观察与推断，提出可核查的改进；没有反馈时指出缺口。",
  },
  {
    id: "asset-check" as const,
    name: "资产检查",
    description: "检查选定资产的新版本、反馈和适用条件。",
    goal: "检查选定资产的变化与反馈，识别失效结论、适用条件和待修订项；不要把方法加载或声明当成验证成功。",
  },
];
export interface RoutineSnapshot {
  items: Routine[];
  templates: typeof ROUTINE_TEMPLATES;
  execution: {
    location: "client";
    availability: "while-client-running";
    notice: string;
  };
}
