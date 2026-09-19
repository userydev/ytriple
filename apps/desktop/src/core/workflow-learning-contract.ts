import { z } from "zod";
import { workflowSchema } from "./configuration";

const stageSchema = workflowSchema.shape.stages.element;

export const workflowCandidateBodySchema = z
  .object({
    ytriple_workflow_candidate: z
      .object({
        name: z.string().trim().min(1).max(200),
        targetWorkflowId: z
          .string()
          .regex(/^[a-zA-Z0-9_-]{1,80}$/),
        executionStrategy: z
          .enum(["fixed-stages", "adaptive-delegation"])
          .optional(),
        delegation: z
          .object({
            maxTasks: z.number().int().min(1).max(8),
            maxDepth: z.number().int().min(1).max(3),
          })
          .strict()
          .optional(),
        stages: z.array(stageSchema).min(1).max(16),
        applicability: z.string().trim().min(1).max(4000),
        unverified: z.array(z.string().trim().min(1).max(500)).max(12),
        sourceNotes: z.string().trim().min(1).max(4000),
      })
      .strict(),
  })
  .strict();

export type WorkflowCandidateBody = z.infer<
  typeof workflowCandidateBodySchema
>["ytriple_workflow_candidate"];

export function parseWorkflowCandidateAnswer(body: string) {
  const trimmed = body.trim();
  const jsonStart = trimmed.indexOf("{");
  if (jsonStart < 0) throw Error("回答中未找到可解析的流程候选 JSON");
  const slice = trimmed.slice(jsonStart);
  let value: unknown;
  try {
    value = JSON.parse(slice);
  } catch {
    throw Error("流程候选 JSON 格式不完整");
  }
  const parsed = workflowCandidateBodySchema.safeParse(value);
  if (!parsed.success)
    throw Error(parsed.error.issues[0]?.message ?? "流程候选字段不符合要求");
  const c = parsed.data.ytriple_workflow_candidate;
  if (c.executionStrategy === "adaptive-delegation" && !c.delegation)
    throw Error("按需委派策略必须包含委派限额");
  if (c.executionStrategy === "fixed-stages" && c.delegation)
    throw Error("固定步骤流程不能附带委派限额");
  const resultStage = c.stages.filter((s) => s.result);
  if (resultStage.length !== 1 || c.stages.at(-1)?.result !== true)
    throw Error("只有最后一步可以形成成果");
  return c;
}
