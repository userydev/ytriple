import { z } from "zod";
export const feedReadResult = z.object({
  kind: z.literal("feed"),
  title: z.string().max(1000),
  requested_url: z.string().url(),
  resolved_url: z.string().url(),
  fetched_at: z.string().datetime(),
  raw_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  total_items: z.number().int().nonnegative(),
  omitted_items: z.number().int().nonnegative(),
  limit_reason: z.string().nullable(),
  items: z
    .array(
      z.object({
        url: z.string().url(),
        upstream_id: z.string().nullable(),
        title: z.string().max(1000),
        text: z.string().max(131072),
        coverage: z.enum(["title_only", "summary", "feed_content"]),
        full_article: z.literal(false),
        published_at: z.string().datetime().nullable(),
        publisher: z.string().nullable(),
        content_hash: z.string().regex(/^[a-f0-9]{64}$/),
        image: z
          .object({
            url: z.string().url(),
            origin: z.enum(["enclosure", "media", "content"]),
            credit: z.string().max(300).nullable(),
          })
          .strict()
          .optional(),
      }),
    )
    .max(100),
});
export type FeedSnapshot = z.infer<typeof feedReadResult>;
export type FeedSource = {
  id: string;
  name: string;
  url: string;
  serviceScope: string;
  revision: number;
  enabled: boolean;
  intervalMinutes: number;
  archived: boolean;
  nextAt: string | null;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  error: string | null;
  createdAt: string;
};
export type FeedCheck = {
  id: string;
  sourceId: string;
  sourceRevision: number;
  trigger: "add" | "manual" | "clock";
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
  added: number;
  updated: number;
  unchanged: number;
  totalItems: number;
  omittedItems: number;
  note: string | null;
  error: string | null;
  snapshotHash?: string;
  resolvedUrl?: string;
};
export type FeedPreview = {
  id: string;
  scope: string;
  expiresAt: string;
  snapshot: FeedSnapshot;
};
