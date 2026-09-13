import { z } from "zod";

export type AttentionMode = "summary" | "important" | "muted";
export interface AttentionItem {
  id: string;
  fingerprint: string;
  kind: "task" | "routine" | "delivery" | "remote";
  reason: "waiting" | "failed" | "result" | "revision" | "feedback" | "check";
  title: string;
  summary: string;
  importance: "important" | "normal";
  occurredAt: string;
  origin: {
    id: string;
    taskId?: string;
    artifactIds: string[];
    feedbackIds: string[];
    workTaskId?: string;
    remoteJobId?: string;
  };
  state: "open" | "handled" | "snoozed";
  snoozedUntil?: string;
  handledAt?: string;
}
export interface AttentionSnapshot {
  items: AttentionItem[];
  preferences: { revision: number; mode: AttentionMode };
  counts: { open: number; important: number; snoozed: number; handled: number };
  /** Only open items allowed by in-app notification preferences. The list retains all issues. */
  notification: { count: number; fingerprint: string; summary: string };
}

const requestId = z.uuid();
export const attentionCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("attention.resolve"),
      requestId,
      itemId: z.string().min(1).max(300),
      expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      action: z.enum(["handled", "snoozed", "open"]),
      snoozedUntil: z.iso.datetime({ offset: true }).optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if ((value.action === "snoozed") !== !!value.snoozedUntil)
        context.addIssue({
          code: "custom",
          message: "暂缓需要到期时间，其他处理动作不能带暂缓时间。",
        });
    }),
  z
    .object({
      type: z.literal("attention.preferences"),
      requestId,
      expectedRevision: z.number().int().nonnegative(),
      mode: z.enum(["summary", "important", "muted"]),
    })
    .strict(),
]);
export type AttentionCommand = z.infer<typeof attentionCommandSchema>;
