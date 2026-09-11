import { z } from "zod";
import type { Command } from "../shared/types.js";
const text = z.string().min(1).max(40000);
const id = z.string().min(1).max(100);
const member = z.enum(["coordinator", "cto", "researcher"]);
const task = { taskId: id };
const windowKind = z.enum(["main", "evidence", "artifact"]);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const libraryMetadata = {
  title: z.string().min(1).max(200).optional(),
  tags: z.array(z.string().min(1).max(80)).max(30).optional(),
  note: z.string().max(10000).optional(),
};
const profile = z.object({
  id,
  name: z.string().min(1).max(120),
  provider: z.enum(["gemini", "deepseek", "ark", "compatible"]),
  protocol: z.enum(["google", "openai"]),
  baseURL: z.string().max(2000),
  modelId: z.string().max(300),
  apiKeyEnv: z.string().max(150),
  hasKey: z.boolean(),
  status: z.enum(["unconfigured", "untested", "ready", "failed"]),
});
const settings = z.object({
  aiRoot: text,
  codeRoot: text,
  workspaceRoot: text,
  defaultProfileId: id,
  memberProfiles: z.object({ coordinator: id, cto: id, researcher: id }),
});
const schemas = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("window.resize"),
    main: z.number().min(0.2).max(0.8),
    evidence: z.number().min(0.2).max(0.8),
  }),
  z.object({ type: z.literal("window.expand"), window: windowKind.nullable() }),
  z.object({ type: z.literal("snapshot") }),
  z.object({
    type: z.literal("task.create"),
    goal: text,
    title: text.optional(),
    kind: z.enum(["research", "project", "learning", "brainstorm"]).optional(),
    member: member.optional(),
    profileId: z.string().max(100).optional(),
  }),
  z.object({
    type: z.literal("task.send"),
    ...task,
    text,
    member: member.optional(),
    profileId: z.string().max(100).optional(),
    reviseGoal: z.boolean().optional(),
  }),
  z.object({ type: z.literal("task.run"), ...task }),
  z.object({ type: z.literal("task.stop"), ...task }),
  z.object({
    type: z.literal("source.addText"),
    ...task,
    title: text,
    text: z.string().min(1).max(2_000_000),
  }),
  z.object({
    type: z.literal("source.addURL"),
    ...task,
    url: z.string().url().max(8000),
  }),
  z.object({ type: z.literal("source.import"), ...task }),
  z.object({
    type: z.literal("artifact.save"),
    ...task,
    artifactId: id,
    content: z.string().min(1).max(4_000_000),
    expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.object({
    type: z.literal("artifact.export"),
    ...task,
    artifactId: id,
    format: z.enum(["png", "pptx"]),
  }),
  z.object({
    type: z.literal("artifact.refine"),
    ...task,
    artifactId: id,
    instruction: text,
    expectedHash: hash,
  }),
  z.object({
    type: z.literal("library.collect"),
    ...task,
    artifactId: id,
    expectedHash: hash,
    ...libraryMetadata,
  }),
  z.object({
    type: z.literal("library.save"),
    entryId: id,
    content: z.string().min(1).max(4_000_000),
    expectedHash: hash,
    ...libraryMetadata,
  }),
  z.object({ type: z.literal("library.reuse"), entryId: id, ...task }),
  z.object({
    type: z.literal("window.layout"),
    mode: z.enum(["single", "triple"]),
    reset: z.boolean().optional(),
  }),
  z.object({ type: z.literal("window.select"), taskId: id.nullable() }),
  z.object({
    type: z.literal("window.collapse"),
    window: windowKind,
    collapsed: z.boolean(),
  }),
  z.object({ type: z.literal("window.focus"), window: windowKind }),
  z.object({
    type: z.literal("profile.save"),
    profile,
    apiKey: z.string().max(16000).optional(),
  }),
  z.object({ type: z.literal("profile.probe"), profileId: id }),
  z.object({ type: z.literal("settings.save"), settings }),
  z.object({ type: z.literal("system.bootstrap") }),
  z.object({
    type: z.literal("project.initialize"),
    input: z.object({
      id,
      name: text,
      series: z.enum(["x", "y", "z"]),
      description: z.string().min(1).max(150000),
      taskId: id.optional(),
    }),
  }),
  z.object({
    type: z.literal("window.open"),
    window: z.enum(["main", "evidence", "artifact"]),
    ...task,
  }),
  z.object({ type: z.literal("path.reveal"), path: text }),
  z.object({ type: z.literal("url.open"), url: z.string().url().max(8000) }),
]);
export function parseCommand(input: unknown): Command {
  const result = schemas.safeParse(input);
  if (!result.success) throw new Error("操作参数无效，请刷新应用后重试。");
  return result.data;
}
