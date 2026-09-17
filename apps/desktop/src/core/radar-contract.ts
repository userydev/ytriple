import { z } from "zod";
import type { RadarWatch, RadarAutoCheck } from "./radar-watch-contract";
import type { Reference, RunStatus } from "./types";

export const topicInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    revision: z.number().int().nonnegative(),
    title: z.string().trim().min(1).max(120),
    focus: z.string().trim().max(2000),
    feedIds: z
      .array(z.string().uuid())
      .max(5)
      .refine((a) => new Set(a).size === a.length, "订阅只需选择一次")
      .optional(),
    feedLimit: z.number().int().min(1).max(18).optional(),
    sources: z
      .array(
        z
          .object({
            materialId: z.string().min(1).max(300),
            policy: z.enum(["auto", "keep", "exclude"]),
            reason: z.string().trim().max(500),
          })
          .strict(),
      )
      .min(0)
      .max(18)
      .refine(
        (a) => new Set(a.map((s) => s.materialId)).size === a.length,
        "同一材料只需选择一次",
      ),
  })
  .strict()
  .refine((t) => t.sources.length || t.feedIds?.length, "请选择材料或持续订阅");
export type TopicInput = z.infer<typeof topicInputSchema>;
export type RadarTopic = Omit<TopicInput, "id"> & {
  id: string;
  updatedAt: string;
};
export type RadarSource = {
  key: string;
  reference: Reference;
  title: string;
  coverage: string;
  url?: string;
  policy: "auto" | "keep" | "exclude";
  reason: string;
  duplicateOf?: string;
  body: string;
};
export const insightSchema = z
  .object({
    changed: z.boolean(),
    title: z.string().trim().min(1).max(160),
    summary: z.string().trim().min(1).max(1200),
    sections: z
      .array(
        z
          .object({
            heading: z.string().trim().min(1).max(160),
            body: z.string().trim().min(1).max(6000),
            sources: z.array(z.string()).min(1).max(18),
          })
          .strict(),
      )
      .max(8),
    changes: z.array(z.string().trim().min(1).max(1000)).max(8),
    limitations: z.array(z.string().trim().min(1).max(1000)).min(1).max(8),
    screening: z
      .array(
        z
          .object({
            source: z.string(),
            keep: z.boolean(),
            reason: z.string().trim().min(1).max(600),
          })
          .strict(),
      )
      .max(18),
  })
  .strict();
export type Insight = z.infer<typeof insightSchema>;
export type RadarEdition = {
  id: string;
  topicId: string;
  topicRevision: number;
  number: number;
  previousId: string | null;
  jobId: string;
  createdAt: string;
  insight: Insight;
  sources: RadarSource[];
  materialId: string;
};
export type RadarJob = {
  modelIdentity?: import("./model-contract").ModelIdentity;
  recovery?: "remote" | "local";
  abandonedAt?: string;
  automatic?: { watchId: string; watchRevision: number; checkId: string };
  supply?: {
    feedIds: string[];
    available: number;
    included: number;
    omitted: number;
    notes: string[];
  };
  id: string;
  topic: RadarTopic;
  fingerprint: string;
  previousId: string | null;
  sources: RadarSource[];
  status: RunStatus;
  body: string;
  remoteId: string | null;
  serviceScope?: string;
  error: string | null;
  summary?: string;
  createdAt: string;
};
export type RadarReading = {
  id: string;
  saved: boolean;
  read: boolean;
  scroll: number;
};
export type RadarSnapshot = {
  watches: RadarWatch[];
  checks: RadarAutoCheck[];
  topics: RadarTopic[];
  editions: RadarEdition[];
  jobs: RadarJob[];
  reading: RadarReading[];
};

export function coverageLabel(value: string) {
  return (
    (
      {
        title_only: "仅标题",
        summary: "来源摘要",
        feed_content: "来源节选 · 非全文",
        feed_excerpt: "来源节选 · 非全文",
        local_text: "本地文本",
        link_only: "仅链接 · 未读正文",
        artifact: "成果正文",
        process_snapshot: "公开过程快照",
        project_file: "项目文件快照",
        radar: "议题解读",
      } as Record<string, string>
    )[value] ?? value
  );
}
