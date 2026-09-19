import { directProfile } from "./model-contract";
import { skillDefinition } from "./skill-contract";
import { radarWatchInput } from "./radar-watch-contract";
import { scheduleInput } from "./schedule-contract";
import { outcomeInput, readinessInput } from "./outcome-contract";
import { briefInputSchema, standardInputSchema } from "./project-contract";
import { initializationInput } from "./project-initialization";
import { layoutSchema, viewSchema } from "./view";
import { z } from "zod";
import { workspaceContextSchema } from "./workspace-context";
import { teamSchema, workflowSchema } from "./configuration";
import { radarViewSchema, topicInputSchema } from "./radar-contract";
const id = z.string().min(1).max(300),
  text = z.string().max(64000);
const reference = z
  .object({
    materialId: id,
    version: z.number().int().positive(),
    label: z.string().max(500),
    excerpt: z.string().max(32000).optional(),
  })
  .strict();
const refs = z.array(reference).max(20);
const outputMode = z
  .enum(["result", "explanation", "summary", "review", "readiness", "method"])
  .optional();
export const commandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("account-sign-in"),
      baseUrl: z.string().url().max(2048),
      email: z.string().trim().email().max(320),
      password: z.string().min(1).max(4096),
    })
    .strict(),
  z.object({ type: z.literal("account-sign-out") }).strict(),
  z.object({ type: z.literal("account-refresh") }).strict(),
  z.object({ type: z.literal("read-member-template-license") }).strict(),
  z.object({
    type: z.literal("model-save"),
    profile: directProfile,
    token: z.string().max(4096),
    noKey: z.boolean(),
  }),
  z.object({
    type: z.literal("model-select"),
    mode: z.enum(["service", "direct"]),
  }),
  z.object({ type: z.literal("model-test") }),
  z.object({ type: z.literal("abandon-local-run"), runId: id }),
  z.object({ type: z.literal("abandon-local-radar"), jobId: id }),
  z.object({ type: z.literal("workspace-info") }),
  z.object({ type: z.literal("workspace-export") }),
  z.object({ type: z.literal("workspace-inspect") }),
  z.object({
    type: z.literal("workspace-restore"),
    previewId: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
  }),
  z.object({
    type: z.literal("workspace-switch"),
    id: z.union([z.literal("primary"), z.string().uuid()]),
  }),
  z.object({ type: z.literal("radar-watch-save"), input: radarWatchInput }),
  z.object({
    type: z.literal("feed-preview"),
    url: z.string().url().max(4096),
  }),
  z.object({
    type: z.literal("feed-add"),
    previewId: id,
    name: z.string().trim().min(1).max(120),
    intervalMinutes: z.number().int().min(30).max(10080),
    enabled: z.boolean(),
  }),
  z.object({
    type: z.literal("feed-update"),
    id,
    revision: z.number().int().positive(),
    patch: z
      .object({
        name: z.string().trim().min(1).max(120),
        intervalMinutes: z.number().int().min(30).max(10080),
        enabled: z.boolean(),
        archived: z.boolean(),
      })
      .strict(),
  }),
  z.object({ type: z.literal("feed-refresh"), id }),
  z.object({ type: z.literal("feed-stop"), id }),
  z.object({ type: z.literal("schedule-save"), input: scheduleInput }),
  z.object({
    type: z.literal("schedule-enabled"),
    id,
    revision: z.number().int().positive(),
    enabled: z.boolean(),
  }),
  z.object({
    type: z.literal("schedule-now"),
    id,
    revision: z.number().int().positive(),
    key: z.string().uuid(),
  }),
  z.object({ type: z.literal("schedule-stop"), occurrenceId: id }),
  z.object({
    type: z.literal("prepare-method-trial"),
    versionId: id,
    projectId: id.nullable(),
  }),
  z.object({
    type: z.literal("adopt-method"),
    key: id,
    trialRunId: id,
    reason: z.string().trim().min(1).max(1000),
  }),
  z.object({ type: z.literal("skill-state"), id, enabled: z.boolean() }),
  z.object({ type: z.literal("skill-copy"), key: id }),
  z.object({
    type: z.literal("skill-save"),
    definition: skillDefinition,
    key: id.optional(),
  }),
  z.object({ type: z.literal("skill-import") }),
  z.object({ type: z.literal("skill-export"), key: id }),
  z.object({ type: z.literal("skill-inspect"), key: id }),
  z.object({ type: z.literal("record-outcome"), input: outcomeInput }),
  z.object({ type: z.literal("prepare-readiness"), input: readinessInput }),
  z.object({
    type: z.literal("withdraw-outcome"),
    id,
    reason: z.string().trim().min(1).max(2000),
  }),
  z.object({ type: z.literal("inspect-local-system") }),
  z.object({ type: z.literal("preview-local-system") }),
  z.object({ type: z.literal("execute-local-system"), planId: id }),
  z.object({
    type: z.literal("initialization-form"),
    projectId: id,
    form: z
      .object({
        versionId: z.string().max(300),
        slug: z.string().max(48),
        series: z.enum(["x", "y", "z"]),
      })
      .strict()
      .optional(),
  }),
  z.object({
    type: z.literal("preview-initialization"),
    input: initializationInput,
  }),
  z.object({ type: z.literal("execute-initialization"), planId: id }),
  z.object({ type: z.literal("read-initialization"), planId: id }),
  z.object({
    type: z.literal("choose-suggestion-document"),
    projectId: id,
    mode: z.enum(["existing", "new"]),
  }),
  z.object({
    type: z.literal("preview-project-suggestion"),
    projectId: id,
    versionId: id,
    excerpt: z.string().min(1).max(32000).optional(),
  }),
  z.object({ type: z.literal("publish-project-suggestion"), previewId: id }),
  z.object({ type: z.literal("reveal-suggestion-document"), projectId: id }),
  z.object({ type: z.literal("inspect-project-files"), projectId: id }),
  z.object({
    type: z.literal("read-project-files"),
    projectId: id,
    paths: z.array(z.string().min(1).max(1000)).min(1).max(20),
  }),
  z.object({ type: z.literal("prepare-project-reading"), projectId: id, refs }),
  z.object({
    type: z.literal("choose-local-root"),
    kind: z.enum(["ai", "code"]),
  }),
  z.object({ type: z.literal("refresh-local-directories") }),
  z.object({
    type: z.literal("reveal-local-root"),
    kind: z.enum(["ai", "code"]),
  }),
  z.object({
    type: z.literal("choose-project-directory"),
    projectId: id.optional(),
  }),
  z.object({
    type: z.literal("import-local-project"),
    path: z.string().min(1).max(4096),
  }),
  z.object({ type: z.literal("reveal-project-directory"), projectId: id }),
  z.object({
    type: z.literal("reveal-local-asset"),
    path: z.string().min(1).max(4096),
  }),
  z.object({ type: z.literal("project-brief"), brief: briefInputSchema }),
  z.object({
    type: z.literal("project-standard"),
    standard: standardInputSchema,
  }),
  z.object({ type: z.literal("radar-topic"), topic: topicInputSchema }),
  z.object({
    type: z.literal("radar-refresh"),
    topicId: id,
    retry: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("radar-organize"),
    topicId: id,
    retry: z.boolean().optional(),
  }),
  z.object({ type: z.literal("radar-stop"), jobId: id }),
  z.object({ type: z.literal("radar-reconcile"), jobId: id }),
  z.object({ type: z.literal("radar-reference"), editionId: id }),
  z
    .object({
      type: z.literal("radar-reading"),
      editionId: id.optional(),
      materialId: id.optional(),
      version: z.number().int().positive().optional(),
      patch: z
        .object({
          saved: z.boolean().optional(),
          read: z.boolean().optional(),
          scroll: z.number().min(0).max(10000000).optional(),
          pinSavedVersion: z.boolean().optional(),
        })
        .strict(),
    })
    .strict()
    .refine(
      (value) => Boolean(value.editionId) !== Boolean(value.materialId),
      "阅读状态需要解读或材料之一",
    )
    .refine(
      (value) => !value.materialId || value.version,
      "材料阅读需要准确版本",
    ),
  z.object({ type: z.literal("radar-view"), view: radarViewSchema }).strict(),
  z
    .object({
      type: z.literal("radar-archive-topic"),
      id,
      revision: z.number().int().positive(),
      archived: z.boolean(),
    })
    .strict(),
  z.object({ type: z.literal("snapshot") }),
  z.object({
    type: z.literal("decision-draft"),
    decisionId: id,
    revision: z.number().int().positive(),
    draftRevision: z.number().int().nonnegative(),
    text,
  }),
  z.object({
    type: z.literal("answer-decision"),
    decisionId: id,
    revision: z.number().int().positive(),
    draftRevision: z.number().int().nonnegative(),
    key: z.string().uuid(),
    text,
  }),
  z.object({
    type: z.literal("prepare-revision"),
    workId: id,
    versionId: id,
    excerpt: z.string().min(1).max(32000).optional(),
    candidateId: id.optional(),
  }),
  z.object({
    type: z.literal("prepare-process"),
    workId: id,
    versionId: id.optional(),
    mode: z.enum(["explanation", "summary", "review", "method"]),
    runId: id.optional(),
    contributionIds: z.array(id).min(1).max(30).optional(),
    excerpt: z.string().min(1).max(12000).optional(),
  }),
  z.object({
    type: z.literal("export-process"),
    workId: id,
    versionId: id.optional(),
    mode: z.enum(["explanation", "summary", "review", "method"]),
    runId: id.optional(),
    contributionIds: z.array(id).min(1).max(30).optional(),
    excerpt: z.string().min(1).max(12000).optional(),
  }),
  z.object({
    type: z.literal("prepare-workflow-candidate"),
    sourceVersionId: id,
  }),
  z.object({
    type: z.literal("save-workflow-candidate"),
    candidateId: id,
    teamKey: id.optional(),
  }),
  z.object({ type: z.literal("dismiss-candidate"), candidateId: id }),
  z.object({
    type: z.literal("work-state"),
    workId: id,
    action: z.enum(["complete", "reopen", "archive", "restore"]),
  }),
  z.object({ type: z.literal("layout"), layout: layoutSchema }),
  z.object({ type: z.literal("view"), view: viewSchema }),
  z.object({ type: z.literal("save-team"), team: teamSchema }),
  z.object({ type: z.literal("save-workflow"), workflow: workflowSchema }),
  z.object({
    type: z.literal("select-configuration"),
    workId: id.nullable(),
    teamKey: id,
    workflowKey: id,
  }),
  z.object({
    type: z.literal("update-work"),
    workId: id,
    title: z.string().trim().min(1).max(200),
    projectId: id.nullable(),
    deliveryId: id.nullable(),
  }),
  z.object({
    type: z.literal("clear-adoption"),
    deliveryId: id,
    expectedVersionId: id,
  }),
  z.object({ type: z.literal("sync") }),
  z.object({ type: z.literal("prepare-workspace-chat"), context: id, text,
    workspaceContext: workspaceContextSchema.optional() }),
  z.object({ type: z.literal("workspace-action-apply"), id }),
  z.object({ type: z.literal("workspace-action-dismiss"), id }),
  z.object({ type: z.literal("workspace-action-undo"), id }),
  z.object({ type: z.literal("workspace-policy"), direct: z.boolean() }),
  z.object({ type: z.literal("connect") }),
  z.object({
    type: z.literal("configure"),
    baseUrl: z.string().url(),
    token: z.string().max(4096),
  }),
  z.object({
    type: z.literal("draft"),
    workspaceContext: workspaceContextSchema.optional(),
    skillKeys: z.array(id).max(4).optional(),
    outputMode,
    id,
    text,
    refs,
    recipient: id.nullable(),
    projectId: id.nullable(),
  }),
  z.object({
    type: z.literal("submit"),
    workspaceContext: workspaceContextSchema.optional(),
    skillKeys: z.array(id).max(4).optional(),
    outputMode,
    key: z.string().uuid(),
    context: id,
    text,
    refs,
    recipient: id.nullable(),
    projectId: id.nullable(),
    deliveryId: id.nullable().optional(),
  }),
  z.object({
    type: z.literal("project"),
    name: z.string().min(1).max(200),
    goal: text,
    kind: z.enum(["software", "media"]),
  }),
  z.object({
    type: z.literal("delivery"),
    projectId: id,
    title: z.string().min(1).max(200),
  }),
  z.object({ type: z.literal("stop"), workId: id }),
  z.object({ type: z.literal("resume"), workId: id }),
  z.object({ type: z.literal("withdraw"), runId: id }),
  z.object({ type: z.literal("begin-queue-edit"), runId: id }),
  z.object({
    type: z.literal("queue-draft"),
    runId: id,
    revision: z.number().int().min(0),
    draft: z.object({ text, refs, recipient: id.nullable() }),
  }),
  z.object({
    type: z.literal("apply-queue-edit"),
    runId: id,
    revision: z.number().int().min(0),
  }),
  z.object({
    type: z.literal("discard-queue-edit"),
    runId: id,
    revision: z.number().int().min(0),
  }),
  z.object({
    type: z.literal("retry-import"),
    materialId: id,
    version: z.number().int().positive(),
  }),
  z.object({ type: z.literal("reconcile"), runId: id }),
  z.object({ type: z.literal("import") }),
  z.object({ type: z.literal("link"), url: z.string().url() }),
  z.object({ type: z.literal("adopt"), deliveryId: id, versionId: id }),
  z.object({ type: z.literal("export"), versionId: id }),
  z.object({
    type: z.literal("reference"),
    versionId: id,
    excerpt: z.string().max(32000).optional(),
  }),
  z.object({
    type: z.literal("asset"),
    reference,
    label: z.string().min(1).max(500),
  }),
  z.object({ type: z.literal("asset-export"), assetId: id }),
  z.object({ type: z.literal("asset-files"), assetId: id }),
  z.object({ type: z.literal("asset-use"), assetId: id }),
  z.object({ type: z.literal("asset-restore") }),
  z.object({ type: z.literal("archive"), workId: id }),
]);
export type Command = z.infer<typeof commandSchema>;
