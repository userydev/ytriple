import { z } from "zod";
import type { RunStatus, Team, Workflow } from "./types";
import type { SkillVersion } from "./skill-contract";
import type { Run } from "./types";

const reference = z
  .object({
    materialId: z.string().min(1).max(300),
    version: z.number().int().positive(),
    label: z.string().max(500),
    excerpt: z.string().min(1).max(32000).optional(),
  })
  .strict();
export const scheduleInput = z
  .object({
    id: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative(),
    name: z.string().trim().min(1).max(120),
    workId: z.string().min(1).max(300).nullable(),
    projectId: z.string().min(1).max(300).nullable(),
    text: z.string().trim().min(1).max(16000),
    refs: z.array(reference).max(20),
    recipient: z.string().min(1).max(300).nullable(),
    skillKeys: z.array(z.string().min(1).max(300)).max(4),
    outputMode: z.enum([
      "result",
      "explanation",
      "summary",
      "review",
      "readiness",
      "method",
    ]),
    firstAt: z.string().datetime(),
    intervalHours: z.number().int().min(1).max(8760).nullable(),
    timezone: z
      .string()
      .min(1)
      .max(100)
      .refine((zone) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: zone });
          return true;
        } catch {
          return false;
        }
      }, "请选择有效时区"),
    followLatest: z.boolean(),
    maxModelCalls: z.number().int().min(1).max(32),
    enabled: z.boolean(),
  })
  .strict();
export type ScheduleInput = z.infer<typeof scheduleInput>;
export type Schedule = Omit<ScheduleInput, "expectedRevision" | "workId"> & {
  workId: string;
  revision: number;
  nextAt: string | null;
  issue: string | null;
  pauseReason?: string;
  createdAt: string;
  updatedAt: string;
  requestHash: string;
  authorizationHash: string;
  serviceScope: string;
  team: Team;
  workflow: Workflow;
  skills: SkillVersion[];
};
export type ScheduleOccurrence = {
  id: string;
  scheduleId: string;
  revision: number;
  dueAt: string;
  checkedAt: string;
  trigger: "clock" | "manual";
  state: "submitted" | "unchanged" | "busy" | "missed" | "blocked";
  detail: string;
  runId: string | null;
  inputHash?: string;
  missedCount?: number;
};
export type ScheduledRun = {
  scheduleId: string;
  revision: number;
  occurrenceId: string;
  maxModelCalls: number;
};
export type ModelCall = {
  id: string;
  runId: string;
  key: string;
  createdAt: string;
  remoteId?: string;
  state: "attempted" | "completed" | "failed" | "cancelled";
};
export const occurrenceLabels: Record<
  ScheduleOccurrence["state"] | RunStatus,
  string
> = {
  submitted: "已提交",
  unchanged: "无新输入",
  busy: "工作未空闲",
  missed: "错过触发",
  blocked: "需处理",
  queued: "待运行",
  running: "运行中",
  waiting: "待答复",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已停止",
  unknown: "待核对",
};
export function scheduleProblem(
  schedule: Schedule,
  occurrences: ScheduleOccurrence[],
  runs: Run[],
) {
  if (schedule.issue) return schedule.issue;
  const last = occurrences
    .filter((o) => o.scheduleId === schedule.id && o.runId)
    .at(-1);
  const run = runs.find((r) => r.id === last?.runId);
  return run && ["failed", "unknown", "waiting"].includes(run.status)
    ? (run.error ?? occurrenceLabels[run.status])
    : null;
}
