import { z } from "zod";
import { topicInputSchema, type RadarTopic } from "./radar-contract";
import { scheduleInput } from "./schedule-contract";
import { radarWatchInput } from "./radar-watch-contract";
import { workspaceContextSchema, type WorkspaceContext } from "./workspace-context";

const scheduleProposalInput = scheduleInput
  .omit({ id: true })
  .extend({ id: z.string().uuid().optional() })
  .strict();

export const workspaceActionRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("radar-topic"), topic: topicInputSchema }).strict(),
  z.object({ kind: z.literal("schedule"), input: scheduleProposalInput }).strict(),
  z
    .object({
      kind: z.literal("schedule-enabled"),
      id: z.string().uuid(),
      revision: z.number().int().positive(),
      enabled: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal("radar-watch"), input: radarWatchInput }).strict(),
]);

export type WorkspaceActionRequest = z.infer<
  typeof workspaceActionRequestSchema
>;
export type WorkspaceAction =
  | { kind: "radar-topic"; topic: z.infer<typeof topicInputSchema> }
  | { kind: "schedule"; input: z.infer<typeof scheduleInput> }
  | {
      kind: "schedule-enabled";
      id: string;
      revision: number;
      enabled: boolean;
    }
  | { kind: "radar-watch"; input: z.infer<typeof radarWatchInput> };

export type WorkspaceActionResult = {
  kind: "radar-topic" | "schedule" | "radar-watch";
  id: string;
  revision: number;
};

export type WorkspaceActionReversal =
  | {
      kind: "archive-created-radar-topic";
      id: string;
      expectedRevision: number;
    }
  | {
      kind: "restore-radar-topic";
      topic: RadarTopic;
      expectedRevision: number;
    }
  | {
      kind: "restore-schedule-enabled";
      id: string;
      expectedRevision: number;
      expectedUpdatedAt: string;
      enabled: boolean;
    }
  | {
      kind: "restore-schedule";
      input: z.infer<typeof scheduleInput>;
      expectedUpdatedAt: string;
    }
  | {
      kind: "restore-radar-watch";
      input: z.infer<typeof radarWatchInput>;
      nextAt: string | null;
    };

export type WorkspaceActionProposal = {
  id: string;
  runId: string;
  workId: string;
  contributionId: string;
  memberId: string;
  status: "pending" | "applied" | "dismissed" | "undone";
  execution: "direct" | "confirmation";
  action: WorkspaceAction;
  summary: string;
  fingerprint: string;
  serviceScope: string | null;
  context: WorkspaceContext | null;
  createdAt: string;
  expiresAt: string;
  appliedAt?: string;
  dismissedAt?: string;
  undoneAt?: string;
  result?: WorkspaceActionResult;
  undo?: { available: boolean; reason?: string };
  reversal?: WorkspaceActionReversal;
};

export const workspaceToolInputSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("inspect"),
      query: z.string().trim().min(1).max(120).optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("act"),
      action: workspaceActionRequestSchema,
    })
    .strict(),
]);
export type WorkspaceToolInput = z.infer<typeof workspaceToolInputSchema>;

export const workspaceActionProposalSchema: z.ZodType<WorkspaceActionProposal> =
  z
    .object({
      id: z.string(),
      runId: z.string(),
      workId: z.string(),
      contributionId: z.string(),
      memberId: z.string(),
      status: z.enum(["pending", "applied", "dismissed", "undone"]),
      execution: z.enum(["direct", "confirmation"]),
      action: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("radar-topic"), topic: topicInputSchema }).strict(),
        z.object({ kind: z.literal("schedule"), input: scheduleInput }).strict(),
        z
          .object({
            kind: z.literal("schedule-enabled"),
            id: z.string().uuid(),
            revision: z.number().int().positive(),
            enabled: z.boolean(),
          })
          .strict(),
        z.object({ kind: z.literal("radar-watch"), input: radarWatchInput }).strict(),
      ]),
      summary: z.string().min(1).max(1000),
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      serviceScope: z.string().nullable(),
      context: workspaceContextSchema.nullable(),
      createdAt: z.string().datetime(),
      expiresAt: z.string().datetime(),
      appliedAt: z.string().datetime().optional(),
      dismissedAt: z.string().datetime().optional(),
      undoneAt: z.string().datetime().optional(),
      result: z
        .object({
          kind: z.enum(["radar-topic", "schedule", "radar-watch"]),
          id: z.string(),
          revision: z.number().int().positive(),
        })
        .strict()
        .optional(),
      undo: z
        .object({ available: z.boolean(), reason: z.string().optional() })
        .strict()
        .optional(),
      reversal: z
        .discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("archive-created-radar-topic"),
              id: z.string().uuid(),
              expectedRevision: z.number().int().positive(),
            })
            .strict(),
          z
            .object({
              kind: z.literal("restore-radar-topic"),
              topic: topicInputSchema.safeExtend({
                id: z.string().uuid(),
                updatedAt: z.string().datetime(),
              }),
              expectedRevision: z.number().int().positive(),
            })
            .strict(),
          z
            .object({
              kind: z.literal("restore-schedule-enabled"),
              id: z.string().uuid(),
              expectedRevision: z.number().int().positive(),
              expectedUpdatedAt: z.string().datetime(),
              enabled: z.boolean(),
            })
            .strict(),
          z
            .object({
              kind: z.literal("restore-schedule"),
              input: scheduleInput,
              expectedUpdatedAt: z.string().datetime(),
            })
            .strict(),
          z
            .object({
              kind: z.literal("restore-radar-watch"),
              input: radarWatchInput,
              nextAt: z.string().datetime().nullable(),
            })
            .strict(),
        ])
        .optional(),
    })
    .strict() as z.ZodType<WorkspaceActionProposal>;
