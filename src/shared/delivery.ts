import { z } from "zod";

export const DELIVERY_STATUS = {
  draft: "草案",
  confirmed: "已确认",
  ready: "可交接",
  handed_off: "已交接",
  used: "已使用",
  verified: "已验证",
  revision_needed: "待修订",
} as const;
export type DeliveryStatus = keyof typeof DELIVERY_STATUS;
export type FeedbackDecision = "pending" | "accepted" | "rejected" | "deferred";
export const FEEDBACK_DECISION = {
  pending: "待判断",
  accepted: "已采纳",
  rejected: "已拒绝",
  deferred: "已暂缓",
} as const;
export interface DeliverySpec {
  recipient: string;
  goal: string;
  criteria: string;
  missing: string;
  plannedDate?: string;
}
export interface DeliveryEvidence {
  receipt?: string;
  usage?: string;
  conditions?: string;
  observations?: string;
}
export interface DeliverySource {
  id: string;
  title: string;
  location: string;
  coverage: string;
  hash: string;
}
export interface DeliveryFeedback {
  id: string;
  kind: "text" | "url" | "report";
  quote: string;
  location?: string;
  observedAt: string;
  coverage: string;
  addedAt: string;
  decision: FeedbackDecision;
  decisionNote?: string;
  decidedAt?: string;
}
export interface DeliveryWork {
  id: string;
  taskId: string;
  kind: "readiness" | "feedback";
  createdAt: string;
  artifactHash: string;
  deliveryRevision?: number;
  sourceIds: string[];
  feedbackIds: string[];
  status?: string;
  error?: string;
}
export interface DeliveryRecord extends DeliverySpec {
  id: string;
  revision: number;
  taskId: string;
  projectId?: string;
  artifactId: string;
  artifactTitle: string;
  artifactVersion: number;
  artifactHash: string;
  goalVersion: number;
  content: string;
  format: "md" | "html";
  sources: DeliverySource[];
  status: DeliveryStatus;
  createdAt: string;
  updatedAt: string;
  history: {
    status: DeliveryStatus;
    recordedAt: string;
    evidence: DeliveryEvidence;
    note?: string;
  }[];
  works: DeliveryWork[];
  feedback: DeliveryFeedback[];
  exports: {
    artifactId: string;
    path: string;
    hash: string;
    createdAt: string;
  }[];
  writebacks: { feedbackId: string; path: string; writtenAt: string }[];
  sourceChanged?: boolean;
  sourceMissing?: boolean;
}
export interface DeliverySnapshot {
  records: DeliveryRecord[];
}

const id = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9_-]+$/);
const request = { requestId: z.uuid() };
const reference = {
  ...request,
  deliveryId: id,
  expectedRevision: z.number().int().positive(),
};
const short = z.string().trim().min(1).max(1000);
const prose = z.string().trim().min(1).max(20000);
const spec = z
  .object({
    recipient: short,
    goal: prose,
    criteria: prose,
    missing: z.string().trim().max(20000),
    plannedDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((date) => {
        const parsed = new Date(date + "T00:00:00Z");
        return (
          Number.isFinite(parsed.getTime()) &&
          parsed.toISOString().slice(0, 10) === date
        );
      })
      .optional(),
  })
  .strict();
const publicURL = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    const name = url.hostname.toLowerCase();
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !name.includes(":") &&
      !/^\d+(?:\.\d+){3}$/.test(name) &&
      name.includes(".") &&
      !/\.(?:localhost|local|internal)$/.test(name)
    );
  }, "请提供公开网页地址；此处不自动读取网页。");
export const deliveryCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("delivery.register"),
      ...request,
      taskId: id,
      artifactId: id,
      expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
      spec,
    })
    .strict(),
  z.object({ type: z.literal("delivery.update"), ...reference, spec }).strict(),
  z
    .object({
      type: z.literal("delivery.status"),
      ...reference,
      status: z.enum([
        "draft",
        "confirmed",
        "ready",
        "handed_off",
        "used",
        "verified",
        "revision_needed",
      ]),
      evidence: z
        .object({
          receipt: prose.optional(),
          usage: prose.optional(),
          conditions: prose.optional(),
          observations: prose.optional(),
        })
        .strict(),
      note: z.string().trim().max(20000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("delivery.check"),
      ...reference,
      sourceIds: z.array(id).max(30),
    })
    .strict(),
  z.object({ type: z.literal("delivery.export"), ...reference }).strict(),
  z
    .object({
      type: z.literal("delivery.addFeedback"),
      ...reference,
      kind: z.enum(["text", "url", "report"]),
      quote: prose,
      location: publicURL.optional(),
      reportSourceId: id.optional(),
      observedAt: z.string().datetime({ offset: true }),
      coverage: short,
    })
    .strict(),
  z
    .object({
      type: z.literal("delivery.reviewFeedback"),
      ...reference,
      feedbackIds: z.array(id).min(1).max(50),
    })
    .strict(),
  z
    .object({
      type: z.literal("delivery.decideFeedback"),
      ...reference,
      feedbackId: id,
      decision: z.enum(["accepted", "rejected", "deferred"]),
      note: prose,
    })
    .strict(),
  z
    .object({
      type: z.literal("delivery.writeFeedback"),
      ...reference,
      feedbackId: id,
    })
    .strict(),
]);
export type DeliveryCommand = z.infer<typeof deliveryCommandSchema>;

/** Portable input is validated before any restored records or files become visible. */
export const deliveryRecordSchema = z
  .object({
    ...spec.shape,
    id,
    revision: z.number().int().positive(),
    taskId: id,
    projectId: id.optional(),
    artifactId: id,
    artifactTitle: z.string(),
    artifactVersion: z.number().int().positive(),
    artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
    goalVersion: z.number().int().positive(),
    content: z.string().max(1_500_000),
    format: z.enum(["md", "html"]),
    status: z.enum([
      "draft",
      "confirmed",
      "ready",
      "handed_off",
      "used",
      "verified",
      "revision_needed",
    ]),
    createdAt: z.string(),
    updatedAt: z.string(),
    sources: z.array(
      z
        .object({
          id,
          title: z.string(),
          location: z.string(),
          coverage: z.string(),
          hash: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ),
    history: z.array(
      z
        .object({
          status: z.enum([
            "draft",
            "confirmed",
            "ready",
            "handed_off",
            "used",
            "verified",
            "revision_needed",
          ]),
          recordedAt: z.string(),
          evidence: z
            .object({
              receipt: z.string().optional(),
              usage: z.string().optional(),
              conditions: z.string().optional(),
              observations: z.string().optional(),
            })
            .strict(),
          note: z.string().optional(),
        })
        .strict(),
    ),
    works: z.array(
      z
        .object({
          id,
          taskId: id,
          kind: z.enum(["readiness", "feedback"]),
          createdAt: z.string(),
          artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
          deliveryRevision: z.number().int().positive().optional(),
          sourceIds: z.array(id),
          feedbackIds: z.array(id),
          status: z.string().optional(),
          error: z.string().optional(),
        })
        .strict(),
    ),
    feedback: z.array(
      z
        .object({
          id,
          kind: z.enum(["text", "url", "report"]),
          quote: z.string(),
          location: z.string().optional(),
          observedAt: z.string(),
          coverage: z.string(),
          addedAt: z.string(),
          decision: z.enum(["pending", "accepted", "rejected", "deferred"]),
          decisionNote: z.string().optional(),
          decidedAt: z.string().optional(),
        })
        .strict(),
    ),
    exports: z.array(
      z
        .object({
          artifactId: id,
          path: z.string(),
          hash: z.string().regex(/^[a-f0-9]{64}$/),
          createdAt: z.string(),
        })
        .strict(),
    ),
    writebacks: z.array(
      z
        .object({ feedbackId: id, path: z.string(), writtenAt: z.string() })
        .strict(),
    ),
  })
  .strict();
