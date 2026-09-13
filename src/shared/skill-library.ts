import { z } from "zod";
const text = (max: number) => z.string().trim().max(max);
const id = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const mutation = { requestId: z.uuid() };
const member = z.enum(["coordinator", "cto", "researcher", "editor"]);
export const skillDependencySchema = z
  .object({
    name: text(160).min(1),
    status: z.enum(["unknown", "available", "missing"]),
    evidence: text(2000),
  })
  .strict()
  .refine(
    (dependency) =>
      dependency.status !== "available" || Boolean(dependency.evidence),
    "确认依赖可用时请记录依据",
  );
const editable = {
  name: text(160).min(1),
  description: text(2000).min(1),
  instructions: z.string().min(1).max(40000),
  dependencies: z.array(skillDependencySchema).max(30).default([]),
  allowedMembers: z
    .array(member)
    .max(4)
    .default(["coordinator", "cto", "researcher", "editor"]),
};
export const skillCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("skill.importText"),
      ...mutation,
      name: text(160).optional(),
      description: text(2000).optional(),
      content: z.string().min(1).max(40000),
      originURL: text(2000)
        .refine((value) => {
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
        }, "来源必须是 http 或 https 链接")
        .optional(),
    })
    .strict(),
  z.object({ type: z.literal("skill.importLocal"), ...mutation }).strict(),
  z
    .object({
      type: z.literal("skill.importURL"),
      ...mutation,
      url: text(2000)
        .min(1)
        .refine((value) => {
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
        }, "请提供不含凭据的公开 http 或 https 链接"),
    })
    .strict(),
  z
    .object({
      type: z.literal("skill.copy"),
      ...mutation,
      skillId: id,
      name: text(160).min(1),
      expectedHash: hash,
    })
    .strict(),
  z
    .object({
      type: z.literal("skill.edit"),
      ...mutation,
      skillId: id,
      expectedRevision: z.number().int().min(1),
      input: z.object(editable).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("skill.activateVersion"),
      ...mutation,
      skillId: id,
      expectedRevision: z.number().int().min(1),
      versionHash: hash,
    })
    .strict(),
  z
    .object({
      type: z.literal("skill.setMembers"),
      ...mutation,
      skillId: id,
      expectedRevision: z.number().int().min(0),
      expectedHash: hash,
      allowedMembers: z.array(member).max(4),
    })
    .strict(),
  z
    .object({
      type: z.literal("skill.feedback"),
      ...mutation,
      skillId: id,
      versionHash: hash,
      outcome: z.enum(["useful", "failed", "correction"]),
      conditions: text(4000).min(1),
      observation: text(6000).min(1),
      evidence: text(6000).min(1),
      taskId: text(100).optional(),
      artifactId: text(100).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("skill.extract"),
      ...mutation,
      taskId: text(100).min(1),
      artifactId: text(100).min(1),
      expectedHash: hash,
      instruction: text(6000).default(""),
    })
    .strict(),
  z
    .object({
      type: z.literal("skill.fromArtifact"),
      ...mutation,
      taskId: text(100).min(1),
      artifactId: text(100).min(1),
      expectedHash: hash,
      name: text(160).optional(),
      description: text(2000).optional(),
    })
    .strict(),
]);
export type SkillCommand = z.infer<typeof skillCommandSchema>;
export type SkillInternalCommand = {
  type: "skill.importLocal.path";
  requestId: string;
  selectedPath: string;
};
