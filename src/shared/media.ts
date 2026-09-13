import { z } from "zod";

const id = z.uuid();
const text = (limit: number) => z.string().trim().max(limit);
const optionalURL = text(2000).refine((value) => {
  if (!value) return true;
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}, "请输入不含登录凭据的 http 或 https 链接");
const day = text(10).refine((value) => {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}, "请输入有效日期");
export const mediaMaterialSchema = z
  .object({
    id,
    title: text(160).min(1),
    relation: z.enum(["own", "reference"]),
    url: optionalURL.default(""),
    text: text(120000).default(""),
    usageRights: z.enum(["unknown", "owned", "licensed"]).default("unknown"),
  })
  .strict()
  .refine((item) => Boolean(item.url || item.text), "请提供链接或文本");
export type MediaMaterial = z.infer<typeof mediaMaterialSchema>;
export const mediaAccountSchema = z
  .object({
    id,
    label: text(120).min(1),
    relation: z.enum(["own", "reference"]),
    url: optionalURL.refine(Boolean, "请提供账号链接"),
  })
  .strict();
export type MediaAccount = z.infer<typeof mediaAccountSchema>;
export const mediaChannelInputSchema = z
  .object({
    name: text(160).min(1),
    goal: text(6000).min(1),
    audience: text(4000).default(""),
    productionConditions: text(6000).default(""),
    expressionStandards: text(6000).default(""),
    accounts: z.array(mediaAccountSchema).max(30).default([]),
    materials: z.array(mediaMaterialSchema).max(50).default([]),
  })
  .strict();
export type MediaChannelInput = z.infer<typeof mediaChannelInputSchema>;
export const mediaVariantSchema = z
  .object({
    id,
    platform: text(100).min(1),
    language: text(80).min(1),
    versionLabel: text(100).min(1),
    basedOnId: id.optional(),
  })
  .strict();
export type MediaVariant = z.infer<typeof mediaVariantSchema>;
export const mediaWorkInputSchema = z
  .object({
    title: text(160).min(1),
    angle: text(8000).default(""),
    format: text(160).default(""),
    targetDate: day.default(""),
    variants: z.array(mediaVariantSchema).min(1).max(30),
    materials: z.array(mediaMaterialSchema).max(50).default([]),
  })
  .strict();
export type MediaWorkInput = z.infer<typeof mediaWorkInputSchema>;
export const MEDIA_STAGES = {
  topic: "选题评估",
  research: "补充研究",
  script: "研究与脚本",
  production: "制作说明",
  publish: "发布准备",
  review: "作品复盘",
} as const;
export type MediaStage = keyof typeof MEDIA_STAGES;
export const mediaArtifactReferenceSchema = z
  .object({
    taskId: id,
    artifactId: id,
    version: z.number().int().positive(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type MediaArtifactReference = z.infer<
  typeof mediaArtifactReferenceSchema
>;
export type MediaFeedback = {
  id: string;
  kind: "comments" | "report" | "finished-work";
  title: string;
  text: string;
  url: string;
  observedAt: string;
  addedAt: string;
  range: "provided-text" | "link-only";
};
export type MediaPublication = {
  id: string;
  variantId: string;
  url: string;
  publishedAt: string;
  recordedAt: string;
};
export type MediaTaskLink = {
  taskId: string;
  stage: MediaStage;
  channelRevision: number;
  workRevision: number;
  createdAt: string;
  requestId: string;
  artifacts?: MediaArtifactReference[];
};
export interface MediaChannel extends MediaChannelInput {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  documentPath: string;
  documentHash: string;
  taskLinks: MediaTaskLink[];
}
export interface MediaWork extends MediaWorkInput {
  id: string;
  channelId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  documentPath: string;
  documentHash: string;
  publications: MediaPublication[];
  feedback: MediaFeedback[];
  taskLinks: MediaTaskLink[];
}
export interface MediaSnapshot {
  revision: number;
  root: string;
  channels: MediaChannel[];
  works: MediaWork[];
}
const mutation = { requestId: id };
export const mediaCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("media.channel.save"),
      ...mutation,
      channelId: id.optional(),
      expectedRevision: z.number().int().min(0),
      input: mediaChannelInputSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("media.work.save"),
      ...mutation,
      channelId: id,
      workId: id.optional(),
      expectedRevision: z.number().int().min(0),
      input: mediaWorkInputSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("media.work.publish"),
      ...mutation,
      workId: id,
      expectedRevision: z.number().int().min(1),
      variantId: id,
      url: optionalURL.refine(Boolean, "请提供实际发布链接"),
      publishedAt: z
        .union([z.literal(""), z.iso.datetime({ offset: true })])
        .default(""),
    })
    .strict(),
  z
    .object({
      type: z.literal("media.feedback.add"),
      ...mutation,
      workId: id,
      expectedRevision: z.number().int().min(1),
      input: z
        .object({
          kind: z.enum(["comments", "report", "finished-work"]),
          title: text(160).min(1),
          text: text(120000).default(""),
          url: optionalURL.default(""),
          observedAt: day.default(""),
        })
        .strict()
        .refine(
          (value) => Boolean(value.text || value.url),
          "请提供实际报告、评论正文或链接",
        ),
    })
    .strict(),
  z
    .object({
      type: z.literal("media.work.start"),
      ...mutation,
      channelId: id,
      workId: id.optional(),
      expectedRevision: z.number().int().min(1),
      stage: z.enum([
        "topic",
        "research",
        "script",
        "production",
        "publish",
        "review",
      ]),
      instruction: text(12000).default(""),
      materialIds: z.array(id).max(100).default([]),
      feedbackIds: z.array(id).max(100).default([]),
      artifacts: z.array(mediaArtifactReferenceSchema).max(24).optional(),
    })
    .strict(),
]);
export type MediaCommand = z.infer<typeof mediaCommandSchema>;
