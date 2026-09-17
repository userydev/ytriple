import { z } from "zod";

export const radarWatchInput = z
  .object({
    topicId: z.string().uuid(),
    topicRevision: z.number().int().positive(),
    expectedRevision: z.number().int().nonnegative(),
    enabled: z.boolean(),
    intervalMinutes: z.number().int().min(30).max(10080),
    maxCallsPerDay: z.number().int().min(1).max(24),
  })
  .strict();
export type RadarWatchInput = z.infer<typeof radarWatchInput>;
export type RadarWatch = {
  id: string;
  revision: number;
  topicRevision: number;
  serviceScope: string;
  enabled: boolean;
  intervalMinutes: number;
  maxCallsPerDay: number;
  nextAt: string | null;
  lastCheckedAt: string | null;
  error: string | null;
};
export const radarCheckLabels = {
  checking: "检查材料",
  running: "正在整理",
  updated: "已有新解读",
  no_change: "没有新增理解",
  unchanged: "材料未变",
  limited: "达到调用上限",
  failed: "整理失败",
  unknown: "原运行待核对",
  interrupted: "检查曾中断",
} as const;
export type RadarAutoCheck = {
  id: string;
  watchId: string;
  watchRevision: number;
  topicRevision: number;
  dueAt: string;
  startedAt: string;
  finishedAt: string | null;
  status: keyof typeof radarCheckLabels;
  jobId: string | null;
  modelSubmitted: boolean;
  error: string | null;
};
