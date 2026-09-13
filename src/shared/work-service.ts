import { z } from "zod";
import type {
  WorkAccount,
  WorkDevice,
  WorkJob,
  WorkModel,
} from "../../services/work-service/contract.js";
export const serviceURL = z
  .string()
  .url()
  .max(2000)
  .transform((value) => value.replace(/\/+$/, ""))
  .refine((value) => {
    const u = new URL(value);
    return (
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      u.pathname === "/" &&
      (u.protocol === "https:" ||
        (u.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)))
    );
  }, "请输入 HTTPS 服务地址；本机服务也可使用 http://127.0.0.1:端口。");
const id = z.string().min(1).max(160),
  requestId = z.uuid();
const selected = z
  .array(id)
  .max(100)
  .refine(
    (values) => new Set(values).size === values.length,
    "不能重复选择同一项。",
  );
const timezone = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }, "时区无效。");
const scheduleFields = {
  schedule: z
    .enum(["once", "change", "daily", "weekly", "interval", "after_node"])
    .default("once"),
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .optional(),
  timezone: timezone.optional(),
  weekday: z.number().int().min(0).max(6).optional(),
  everyMinutes: z.number().int().min(5).max(525600).optional(),
  delayMinutes: z.number().int().min(0).max(525600).optional(),
};
export const workServiceCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("service.login"),
      baseURL: serviceURL,
      username: z.string().trim().min(1).max(160),
      password: z.string().min(1).max(4096),
      deviceName: z.string().trim().min(1).max(160),
    })
    .strict(),
  z.object({ type: z.literal("service.logout") }).strict(),
  z.object({ type: z.literal("service.refresh") }).strict(),
  z.object({ type: z.literal("service.model.select"), modelId: id }).strict(),
  z.object({ type: z.literal("service.device.revoke"), deviceId: id }).strict(),
  z.object({ type: z.literal("service.export") }).strict(),
  z
    .object({
      type: z.literal("service.clearData"),
      confirm: z.literal("delete-my-data"),
    })
    .strict(),
  z
    .object({
      type: z.literal("service.job.create"),
      requestId,
      taskId: id,
      modelId: id,
      sourceIds: selected,
      skillIds: selected,
      ...scheduleFields,
      maxRuns: z.number().int().min(1).max(1000).default(10),
      maxTokens: z.number().int().min(1).max(10000000).default(100000),
    })
    .strict(),
  z
    .object({
      type: z.literal("service.job.update"),
      requestId,
      jobId: id,
      expectedVersion: z.number().int().positive(),
      action: z.enum(["pause", "resume"]).optional(),
      taskId: id.optional(),
      sourceIds: selected.optional(),
      maxRuns: z.number().int().min(1).max(1000).optional(),
      maxTokens: z.number().int().min(1).max(10000000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("service.job.node"),
      requestId,
      jobId: id,
      expectedVersion: z.number().int().positive(),
      occurredAt: z.iso.datetime({ offset: true }),
      evidence: z.string().trim().min(1).max(2000),
    })
    .strict(),
  z
    .object({ type: z.literal("service.job.cancel"), requestId, jobId: id })
    .strict(),
  z
    .object({ type: z.literal("service.job.collect"), requestId, jobId: id })
    .strict(),
]);
export type WorkServiceCommand = z.infer<typeof workServiceCommandSchema>;
export interface WorkServiceSnapshot {
  state: "unconfigured" | "connected" | "offline";
  baseURL?: string;
  account?: WorkAccount;
  devices: WorkDevice[];
  models: WorkModel[];
  jobs: WorkJob[];
  error?: string;
  refreshedAt?: string;
  exports: { path: string; createdAt: string }[];
  collected: Record<
    string,
    { taskId: string; artifactId: string; runId: string; artifactHash?: string }
  >;
  submissions?: Record<
    string,
    {
      taskId: string;
      goalVersion: number;
      sourceHashes: Record<string, string>;
      skillHashes: Record<string, string>;
    }
  >;
}

// Parse public service data before it can reach storage, filesystem actions or React.
const publicId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,159}$/),
  timestamp = z.iso.datetime({ offset: true }),
  count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const usage = z.object({
  usedTokens: count,
  reservedTokens: count,
  remainingTokens: count,
  unknownRequests: count,
});
export const workAccountSchema = z.object({
  user: z.object({ id: publicId, username: z.string().min(1).max(160) }),
  entitlement: z.object({
    plan: z.string().min(1).max(160),
    active: z.boolean(),
    expiresAt: timestamp.optional(),
    modelIds: z.array(id).max(1000),
    tokenLimit: count,
    maxConcurrent: z.number().int().min(1).max(1000),
  }),
  usage,
});
export const workDeviceSchema = z.object({
  id: publicId,
  name: z.string().min(1).max(160),
  createdAt: timestamp,
  lastSeenAt: timestamp,
  expiresAt: timestamp,
  current: z.boolean(),
});
export const workModelSchema = z.object({
  id: publicId,
  object: z.literal("model"),
  name: z.string().min(1).max(160),
  owned_by: z.literal("work-service"),
  provider: z.enum(["openai", "gemini"]),
  capabilities: z.object({
    text: z.literal(true),
    tools: z.boolean(),
    streaming: z.literal(true),
  }),
  streamingMode: z.literal("buffered"),
});
const publicMaterial = z.object({
  id: publicId,
  title: z.string().max(160),
  text: z.string().max(400000),
  hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  coverage: z.string().max(1000).optional(),
});
const publicMethod = z.object({
  id: publicId,
  name: z.string().max(160),
  version: z.string().max(60),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  instructions: z.string().min(1).max(40000),
});
const publicSchedule = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("once") }),
    z.object({ kind: z.literal("change") }),
    z.object({
      kind: z.literal("time"),
      cadence: z.enum(["daily", "weekly", "interval"]),
      timezone,
      time: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
        .optional(),
      weekday: z.number().int().min(0).max(6).optional(),
      everyMinutes: z.number().int().min(5).max(525600).optional(),
    }),
    z.object({
      kind: z.literal("after_node"),
      timezone,
      delayMinutes: z.number().int().min(0).max(525600),
    }),
  ])
  .superRefine((schedule, context) => {
    if (
      schedule.kind === "time" &&
      ((schedule.cadence === "interval"
        ? schedule.everyMinutes === undefined
        : !schedule.time) ||
        (schedule.cadence === "weekly" && schedule.weekday === undefined))
    )
      context.addIssue({
        code: "custom",
        message: "远端安排缺少必要的时间字段。",
      });
  });
export const workJobSchema = z.object({
  id: publicId,
  title: z.string().min(1).max(160),
  model: publicId,
  goal: z.string().min(1).max(40000),
  materials: z.array(publicMaterial).max(100),
  skills: z.array(publicMethod).max(12),
  origin: z
    .object({
      taskId: publicId.optional(),
      routineId: publicId.optional(),
      version: z.number().int().positive().optional(),
    })
    .optional(),
  version: z.number().int().positive(),
  schedule: publicSchedule,
  limits: z.object({
    maxRuns: z.number().int().min(1).max(10000),
    maxTokens: z.number().int().min(1).max(100000000),
  }),
  state: z.enum([
    "queued",
    "running",
    "completed",
    "failed",
    "cancelled",
    "waiting",
    "paused",
    "uncertain",
  ]),
  createdAt: timestamp,
  updatedAt: timestamp,
  nextRunAt: timestamp.optional(),
  runCount: count,
  tokens: count,
  runs: z
    .array(
      z.object({
        id: publicId,
        version: z.number().int().positive(),
        startedAt: timestamp,
        finishedAt: timestamp.optional(),
        state: z.enum([
          "running",
          "completed",
          "failed",
          "cancelled",
          "uncertain",
          "unchanged",
        ]),
        inputHash: z.string().max(160),
        result: z.string().max(2000000).optional(),
        tokens: count.optional(),
        error: z.string().max(4000).optional(),
        meaningful: z.boolean(),
      }),
    )
    .max(200),
  result: z.string().max(2000000).optional(),
  lastInputHash: z.string().max(160).optional(),
  lastError: z.string().max(4000).optional(),
  node: z
    .object({
      id: publicId,
      occurredAt: timestamp,
      evidence: z.string().max(2000),
    })
    .optional(),
  consumedNodeId: publicId.optional(),
});
export const workExportSchema = z.object({
  exportedAt: timestamp,
  account: workAccountSchema,
  jobs: z.array(workJobSchema).max(1000),
  usage: z
    .array(
      z.object({
        request_id: z.string().max(200),
        model: publicId,
        state: z.enum(["pending", "completed", "unknown"]),
        reserved: count,
        tokens: count.nullable(),
        created_at: timestamp,
      }),
    )
    .max(100000),
});
