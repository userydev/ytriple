import { z } from "zod";
import { toolKey } from "./tool-contract";
import type { Team, Workflow, Snapshot, Work } from "./types";
const name = z
  .string()
  .trim()
  .min(1, "请填写名称")
  .max(200, "名称不能超过 200 个字符");
const memberId = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const teamSchema = z
  .object({
    id: memberId,
    version: z.number().int().positive(),
    name,
    members: z
      .array(
        z
          .object({
            id: memberId,
            name,
            skillKeys: z.array(z.string().min(1).max(300)).max(8).optional(),
            toolKeys: z
              .array(toolKey)
              .max(2)
              .refine(
                (keys) => new Set(keys).size === keys.length,
                "工具不能重复",
              )
              .optional(),
            instruction: z
              .string()
              .trim()
              .min(1, "请填写成员职责与约束")
              .max(8000, "成员职责不能超过 8000 个字符"),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict()
  .refine(
    (t) => new Set(t.members.map((m) => m.id)).size === t.members.length,
    "成员标识不能重复",
  );
export const workflowSchema = z
  .object({
    id: memberId,
    version: z.number().int().positive(),
    name,
    delegation: z
      .object({
        maxTasks: z.number().int().min(1).max(8),
        maxDepth: z.number().int().min(1).max(3),
      })
      .strict()
      .optional(),
    stages: z
      .array(
        z
          .object({
            role: memberId,
            objective: z
              .string()
              .trim()
              .min(1, "请填写每一步的目标")
              .max(8000, "步骤目标不能超过 8000 个字符"),
            result: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict()
  .refine(
    (w) => w.stages.every((s, i) => !s.result || i === w.stages.length - 1),
    "只有最后一步可以形成成果；前面的输出作为公开贡献",
  );
export const versionKey = (config: Team | Workflow) =>
  `${config.id}@${config.version}`;
export function checkCompatibility(team: Team, workflow: Workflow) {
  const t = teamSchema.safeParse(team),
    w = workflowSchema.safeParse(workflow);
  if (!t.success) throw Error(t.error.issues[0].message);
  if (!w.success) throw Error(w.error.issues[0].message);
  const missing = workflow.stages.filter(
    (s) => !team.members.some((m) => m.id === s.role),
  );
  if (missing.length)
    throw Error("流程需要团队中不存在的成员，请在协作流程中重新选择负责成员");
}

export function configurationForSnapshot(data: Snapshot, work?: Work) {
  const previous = work
    ? data.runs.filter((r) => r.workId === work.id).at(-1)
    : undefined;
  return {
    team:
      data.teams.find((t) => versionKey(t) === work?.teamKey) ??
      previous?.team ??
      data.team,
    workflow:
      data.workflows.find((w) => versionKey(w) === work?.workflowKey) ??
      previous?.workflow ??
      data.workflow,
  };
}
