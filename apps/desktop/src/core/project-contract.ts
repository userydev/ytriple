import { z } from "zod";
import type { ProjectBrief, ProjectStandard } from "./types";
const id = z.string().min(1).max(300);
export const projectReferenceSchema = z
  .object({
    materialId: id,
    version: z.number().int().positive(),
    label: z.string().max(500),
    excerpt: z.string().min(1).max(12000).optional(),
  })
  .strict();
export const briefInputSchema = z
  .object({
    projectId: id,
    expectedRevision: z.number().int().nonnegative(),
    goal: z.string().trim().min(1).max(8000),
    refs: z.array(projectReferenceSchema).max(12),
  })
  .strict();
export const standardInputSchema = z
  .object({
    id: id.optional(),
    projectId: id,
    expectedRevision: z.number().int().nonnegative(),
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(8000),
    deliveryId: id.nullable(),
    enabled: z.boolean(),
    source: z
      .object({
        versionId: id,
        excerpt: z.string().min(1).max(8000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export function latestStandards(
  standards: ProjectStandard[],
  projectId: string,
) {
  const byId = new Map<string, ProjectStandard>();
  for (const s of standards)
    if (
      s.projectId === projectId &&
      s.revision > (byId.get(s.id)?.revision ?? 0)
    )
      byId.set(s.id, s);
  return [...byId.values()];
}
export function latestBrief(briefs: ProjectBrief[], projectId: string) {
  return briefs
    .filter((b) => b.projectId === projectId)
    .reduce<ProjectBrief | undefined>(
      (last, b) => (!last || b.revision > last.revision ? b : last),
      undefined,
    );
}
