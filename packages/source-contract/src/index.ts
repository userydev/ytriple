import { z } from "zod";

export const PROTOCOL_VERSION = "1.0" as const;
export const MAX_ITEM_CONTENT_BYTES = 2 * 1024 * 1024;

export const SOURCE_API_SCOPES = [
  "sources:read",
  "sources:write",
  "refreshes:write",
  "content:read",
] as const;

export const CAPABILITY_NAMES = [
  "publicUrl",
  "explicitRefresh",
  "changes",
  "itemRevisions",
  "changeStream",
  "sourceFollows",
  "recommendedSources",
  "rssAtom",
  "readingTopics",
] as const;

export const JOB_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
] as const;

export const CHANGE_KINDS = [
  "item.created",
  "item.revised",
  "source.state_changed",
  "item.tombstoned",
] as const;

export const COVERAGES = [
  "listing",
  "metadata",
  "fulltext",
  "transcript",
  "vision",
] as const;

export const SOURCE_API_ERROR_CODES = [
  "INVALID_REQUEST",
  "INVALID_SOURCE_URL",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "IDEMPOTENCY_KEY_REQUIRED",
  "IDEMPOTENCY_KEY_REUSED",
  "INVALID_CURSOR",
  "CURSOR_INSTANCE_MISMATCH",
  "RATE_LIMITED",
  "SOURCE_URL_BLOCKED",
  "SOURCE_TOO_LARGE",
  "SOURCE_TIMEOUT",
  "SOURCE_REDIRECT_LIMIT",
  "SOURCE_HTTP_ERROR",
  "SOURCE_UNSUPPORTED_CONTENT",
  "SOURCE_CONTENT_UNREADABLE",
  "SOURCE_WORKER_LOST",
  "SOURCE_FETCH_FAILED",
  "INTERNAL_ERROR",
] as const;

export const SOURCE_API_PATHS = {
  health: "/healthz",
  readiness: "/readyz",
  capabilities: "/v1/capabilities",
  pair: "/v1/pairing/bootstrap",
  urlSource: "/v1/sources/url",
  refreshes: "/v1/sources/{sourceId}/refreshes",
  job: "/v1/jobs/{jobId}",
  changes: "/v1/changes",
  changeStream: "/v1/changes/stream",
  revision: "/v1/items/{itemId}/revisions/{revisionId}",
  recommendedSources: "/v1/recommended-sources",
  follows: "/v1/follows",
  follow: "/v1/follows/{followId}",
  followRefresh: "/v1/follows/{followId}/refresh",
  reading: "/v1/reading",
} as const;

export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key" as const;
export const LAST_EVENT_ID_HEADER = "Last-Event-ID" as const;
export const CHANGE_STREAM_EVENT_NAME = "change" as const;

export const ProtocolVersionSchema = z.literal(PROTOCOL_VERSION);
export const UuidSchema = z.string().uuid();
export const StableIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const TimestampSchema = z.string().datetime({ offset: true });
export const ContentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const CursorSchema = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
export const IdempotencyKeySchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\x21-\x7e]+$/);

const sensitiveQueryNames = new Set([
  "access_token",
  "api_key",
  "apikey",
  "auth",
  "authorization",
  "googleaccessid",
  "jwt",
  "key",
  "key-pair-id",
  "policy",
  "sig",
  "signature",
  "token",
  "x-amz-credential",
  "x-amz-security-token",
  "x-amz-signature",
  "x-goog-credential",
  "x-goog-signature",
]);

export function hasSensitiveURLQuery(url: URL): boolean {
  return [...url.searchParams.keys()].some((name) => {
    const normalized = name.toLowerCase();
    return (
      sensitiveQueryNames.has(normalized) ||
      /(?:^|[-_])(token|signature|secret)$/.test(normalized)
    );
  });
}

export const HttpUrlSchema = z
  .string()
  .url()
  .max(4096)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        !url.username &&
        !url.password &&
        !hasSensitiveURLQuery(url)
      );
    } catch {
      return false;
    }
  }, "Expected an HTTP(S) URL without embedded credentials or secret query parameters");

export const SourceApiScopeSchema = z.enum(SOURCE_API_SCOPES);
export const JobStatusSchema = z.enum(JOB_STATUSES);
export const ChangeKindSchema = z.enum(CHANGE_KINDS);
export const CoverageSchema = z.enum(COVERAGES);
export const SourceApiErrorCodeSchema = z.enum(SOURCE_API_ERROR_CODES);

export const ResponseMetaSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  serverInstanceId: UuidSchema,
});

export const HealthResponseSchema = z.object({
  meta: ResponseMetaSchema,
  status: z.literal("ok"),
});

export const ReadinessResponseSchema = z.object({
  meta: ResponseMetaSchema,
  status: z.enum(["ready", "not_ready"]),
});

export const PairRequestSchema = z.object({
  deviceName: z.string().trim().min(1).max(120),
  bootstrapToken: z.string().min(1).max(512),
});

const GrantedScopesSchema = z
  .array(SourceApiScopeSchema)
  .min(1)
  .superRefine((scopes, context) => {
    if (new Set(scopes).size !== scopes.length)
      context.addIssue({
        code: "custom",
        message: "Scopes must not contain duplicates",
      });
  });

export const PairResponseSchema = z.object({
  meta: ResponseMetaSchema,
  tenantId: StableIdSchema,
  deviceId: StableIdSchema,
  token: z.string().min(1).max(4096),
  scopes: GrantedScopesSchema,
});

export const CapabilityFlagsSchema = z.object({
  publicUrl: z.boolean(),
  explicitRefresh: z.boolean(),
  changes: z.boolean(),
  itemRevisions: z.boolean(),
  // Optional so a 1.0 desktop remains compatible with a pre-stream 1.0 server.
  changeStream: z.boolean().optional(),
  // Additive 1.0 capabilities: older desktops ignore them.
  sourceFollows: z.boolean().optional(),
  recommendedSources: z.boolean().optional(),
  rssAtom: z.boolean().optional(),
  readingTopics: z.boolean().optional(),
});

export const CapabilitiesResponseSchema = z.object({
  meta: ResponseMetaSchema,
  tenantId: StableIdSchema,
  capabilities: CapabilityFlagsSchema,
  scopes: z.array(SourceApiScopeSchema),
});

export const ApiErrorSchema = z.object({
  code: SourceApiErrorCodeSchema,
  message: z.string().min(1).max(1000),
  retryable: z.boolean(),
  retryAfterSeconds: z.number().int().nonnegative().optional(),
});

export const ApiErrorResponseSchema = z.object({
  meta: ResponseMetaSchema,
  error: ApiErrorSchema,
});

export const UrlSourceUpsertRequestSchema = z.object({
  url: HttpUrlSchema,
});

export const UrlSourceSchema = z.object({
  id: StableIdSchema,
  url: HttpUrlSchema,
  version: z.number().int().positive(),
});

export const FOLLOW_ORIGINS = ["user", "recommended"] as const;
export const FOLLOW_STATES = ["active", "paused"] as const;
export const FollowOriginSchema = z.enum(FOLLOW_ORIGINS);
export const FollowStateSchema = z.enum(FOLLOW_STATES);
export const RefreshIntervalMinutesSchema = z.number().int().min(5).max(10_080);
export const FollowNameSchema = z.string().trim().min(1).max(200);
export const SourceCategorySchema = z.string().trim().min(1).max(80);

export const RecommendedSourceSchema = z.object({
  id: StableIdSchema,
  name: FollowNameSchema,
  category: SourceCategorySchema,
  description: z.string().trim().min(1).max(500),
  url: HttpUrlSchema,
  refreshIntervalMinutes: RefreshIntervalMinutesSchema,
  enabledByDefault: z.boolean(),
});

export const RecommendedSourcesResponseSchema = z.object({
  meta: ResponseMetaSchema,
  sources: z.array(RecommendedSourceSchema),
});

export const ReadingSummarySchema = z.object({
  title: z.string().min(1).max(160),
  summary: z.string().min(1).max(2000),
  points: z
    .array(
      z.object({
        title: z.string().min(1).max(160),
        detail: z.string().min(1).max(1500),
        sourceIds: z.array(StableIdSchema).min(1).max(12),
      }),
    )
    .min(1)
    .max(6),
  caveats: z.array(z.string().min(1).max(500)).max(6),
});
export const ReadingTopicSchema = ReadingSummarySchema.extend({
  id: StableIdSchema,
  category: SourceCategorySchema,
  generatedAt: TimestampSchema,
  model: z.string().min(1).max(120),
  inputHash: ContentHashSchema,
  evidence: z
    .array(
      z.object({
        itemId: StableIdSchema,
        revisionId: StableIdSchema,
        title: z.string().min(1).max(500),
        url: HttpUrlSchema,
        coverage: CoverageSchema,
        excerpt: z.string().max(8000),
      }),
    )
    .min(1)
    .max(16),
});
export const ReadingResponseSchema = z.object({
  meta: ResponseMetaSchema,
  topics: z.array(ReadingTopicSchema).max(100),
});
export type ReadingTopic = z.infer<typeof ReadingTopicSchema>;

export const SourceFollowSchema = z
  .object({
    id: StableIdSchema,
    sourceId: StableIdSchema,
    origin: FollowOriginSchema,
    recommendedSourceId: StableIdSchema.optional(),
    name: FollowNameSchema,
    category: SourceCategorySchema,
    url: HttpUrlSchema,
    state: FollowStateSchema,
    refreshIntervalMinutes: RefreshIntervalMinutesSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    nextRefreshAt: TimestampSchema.optional(),
    lastAttemptAt: TimestampSchema.optional(),
    lastSuccessAt: TimestampSchema.optional(),
    lastError: ApiErrorSchema.optional(),
  })
  .superRefine((follow, context) => {
    if (follow.origin === "recommended" && !follow.recommendedSourceId)
      context.addIssue({
        code: "custom",
        path: ["recommendedSourceId"],
        message: "A recommended follow requires recommendedSourceId",
      });
    if (follow.origin === "user" && follow.recommendedSourceId)
      context.addIssue({
        code: "custom",
        path: ["recommendedSourceId"],
        message: "A user follow must not include recommendedSourceId",
      });
  });

export const PublicUrlFollowTargetSchema = z.object({
  kind: z.literal("public-url"),
  url: HttpUrlSchema,
});

export const RecommendedFollowTargetSchema = z.object({
  kind: z.literal("recommended"),
  recommendedSourceId: StableIdSchema,
});

export const CreateSourceFollowRequestSchema = z.object({
  source: z.discriminatedUnion("kind", [
    PublicUrlFollowTargetSchema,
    RecommendedFollowTargetSchema,
  ]),
  name: FollowNameSchema.optional(),
  category: SourceCategorySchema.optional(),
  refreshIntervalMinutes: RefreshIntervalMinutesSchema.optional(),
});

export const UpdateSourceFollowRequestSchema = z
  .object({
    name: FollowNameSchema.optional(),
    category: SourceCategorySchema.optional(),
    state: FollowStateSchema.optional(),
    refreshIntervalMinutes: RefreshIntervalMinutesSchema.optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.category !== undefined ||
      value.state !== undefined ||
      value.refreshIntervalMinutes !== undefined,
    "At least one follow field is required",
  );

export const SourceFollowsResponseSchema = z.object({
  meta: ResponseMetaSchema,
  follows: z.array(SourceFollowSchema),
});

export const SourceFollowResponseSchema = z.object({
  meta: ResponseMetaSchema,
  follow: SourceFollowSchema,
});

export const DeleteSourceFollowResponseSchema = z.object({
  meta: ResponseMetaSchema,
  followId: StableIdSchema,
  deleted: z.literal(true),
});

export const RefreshRequestSchema = z.object({});

const JobCommonShape = {
  id: StableIdSchema,
  sourceId: StableIdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
};

export const QueuedJobSchema = z.object({
  ...JobCommonShape,
  status: z.literal("queued"),
  itemId: StableIdSchema.optional(),
  revisionId: StableIdSchema.optional(),
  error: ApiErrorSchema.optional(),
});

export const RunningJobSchema = z.object({
  ...JobCommonShape,
  status: z.literal("running"),
  itemId: StableIdSchema.optional(),
  revisionId: StableIdSchema.optional(),
  error: ApiErrorSchema.optional(),
});

export const SucceededJobSchema = z.object({
  ...JobCommonShape,
  status: z.literal("succeeded"),
  itemId: StableIdSchema.optional(),
  revisionId: StableIdSchema.optional(),
  itemCount: z.number().int().min(0).max(40).optional(),
  error: ApiErrorSchema.optional(),
});

export const FailedJobSchema = z.object({
  ...JobCommonShape,
  status: z.literal("failed"),
  itemId: StableIdSchema.optional(),
  revisionId: StableIdSchema.optional(),
  error: ApiErrorSchema,
});

export const JobSchema = z
  .discriminatedUnion("status", [
    QueuedJobSchema,
    RunningJobSchema,
    SucceededJobSchema,
    FailedJobSchema,
  ])
  .superRefine((job, context) => {
    if (
      job.status === "succeeded" &&
      (job.itemCount === 0
        ? Boolean(job.itemId || job.revisionId)
        : !job.itemId || !job.revisionId)
    )
      context.addIssue({
        code: "custom",
        message:
          "Successful jobs require a result revision unless the feed is empty",
      });
  });

export const JobResponseSchema = z.object({
  meta: ResponseMetaSchema,
  job: JobSchema,
});

export const SourceFollowJobResponseSchema = z
  .object({
    meta: ResponseMetaSchema,
    follow: SourceFollowSchema,
    job: JobSchema,
  })
  .superRefine((response, context) => {
    if (response.follow.sourceId !== response.job.sourceId)
      context.addIssue({
        code: "custom",
        path: ["job", "sourceId"],
        message: "The job must belong to the followed source",
      });
  });

export const UrlSourceUpsertResponseSchema = z
  .object({
    meta: ResponseMetaSchema,
    source: UrlSourceSchema,
    job: JobSchema,
  })
  .superRefine((response, context) => {
    if (response.source.id !== response.job.sourceId)
      context.addIssue({
        code: "custom",
        path: ["job", "sourceId"],
        message: "The job must belong to the returned source",
      });
  });

export const ChangesQuerySchema = z.object({
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const ChangeSchema = z
  .object({
    id: StableIdSchema,
    kind: ChangeKindSchema,
    sourceId: StableIdSchema,
    // New Radar deliveries identify the exact user or recommended follow.
    followId: StableIdSchema.optional(),
    itemId: StableIdSchema.optional(),
    revisionId: StableIdSchema.optional(),
    observedAt: TimestampSchema.optional(),
    contentHash: ContentHashSchema.optional(),
    coverage: CoverageSchema.optional(),
    missing: z.array(z.string().min(1).max(200)).max(100).optional(),
    occurredAt: TimestampSchema,
  })
  .superRefine((change, context) => {
    if (
      (change.kind === "item.created" || change.kind === "item.revised") &&
      (!change.itemId ||
        !change.revisionId ||
        !change.observedAt ||
        !change.contentHash ||
        !change.coverage ||
        !change.missing)
    )
      context.addIssue({
        code: "custom",
        message:
          "Item changes require itemId, revisionId, observedAt, contentHash, coverage, and missing",
      });
    if (change.kind === "item.tombstoned" && !change.itemId)
      context.addIssue({
        code: "custom",
        path: ["itemId"],
        message: "A tombstone requires itemId",
      });
  });

export const ChangesPageSchema = z.object({
  meta: ResponseMetaSchema,
  changes: z.array(ChangeSchema),
  nextCursor: CursorSchema,
  hasMore: z.boolean(),
});

export const ChangesPageResponseSchema = ChangesPageSchema;

export const ChangeStreamQuerySchema = z.object({
  cursor: CursorSchema.optional(),
});

export const ChangeStreamEventSchema = z.object({
  meta: ResponseMetaSchema,
  cursor: CursorSchema,
  change: ChangeSchema,
});

export const SourceItemSchema = z.object({
  id: StableIdSchema,
  sourceId: StableIdSchema,
  // Additive for 1.0 compatibility; new servers always return it.
  externalItemKey: StableIdSchema.optional(),
  canonicalUrl: HttpUrlSchema,
  title: z.string().min(1).max(500),
});

export const ItemRevisionSchema = z.object({
  publishedAt: TimestampSchema.optional(),
  id: StableIdSchema,
  itemId: StableIdSchema,
  observedAt: TimestampSchema,
  contentHash: ContentHashSchema,
  coverage: CoverageSchema,
  missing: z.array(z.string().min(1).max(200)).max(100),
  content: z.string(),
});

export const RevisionResponseSchema = z
  .object({
    meta: ResponseMetaSchema,
    item: SourceItemSchema,
    revision: ItemRevisionSchema,
  })
  .superRefine((response, context) => {
    if (response.item.id !== response.revision.itemId)
      context.addIssue({
        code: "custom",
        path: ["revision", "itemId"],
        message: "The revision must belong to the returned item",
      });
  });

export const ItemRevisionResponseSchema = RevisionResponseSchema;
export const PutUrlSourceRequestSchema = UrlSourceUpsertRequestSchema;
export const PutUrlSourceResponseSchema = UrlSourceUpsertResponseSchema;
export const RefreshSourceRequestSchema = RefreshRequestSchema;
export const UpsertURLSourceRequestSchema = UrlSourceUpsertRequestSchema;
export const UpsertURLSourceResponseSchema = UrlSourceUpsertResponseSchema;
export const ChangesResponseSchema = ChangesPageSchema;
export const ErrorResponseSchema = ApiErrorResponseSchema;
export const SOURCE_SCOPES = SOURCE_API_SCOPES;

export type ProtocolVersion = z.infer<typeof ProtocolVersionSchema>;
export type Uuid = z.infer<typeof UuidSchema>;
export type StableId = z.infer<typeof StableIdSchema>;
export type Timestamp = z.infer<typeof TimestampSchema>;
export type ContentHash = z.infer<typeof ContentHashSchema>;
export type Cursor = z.infer<typeof CursorSchema>;
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;
export type HttpUrl = z.infer<typeof HttpUrlSchema>;
export type SourceApiScope = z.infer<typeof SourceApiScopeSchema>;
export type ResponseMeta = z.infer<typeof ResponseMetaSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>;
export type PairRequest = z.infer<typeof PairRequestSchema>;
export type PairResponse = z.infer<typeof PairResponseSchema>;
export type CapabilityFlags = z.infer<typeof CapabilityFlagsSchema>;
export type CapabilitiesResponse = z.infer<typeof CapabilitiesResponseSchema>;
export type SourceApiErrorCode = z.infer<typeof SourceApiErrorCodeSchema>;
export type SourceApiError = z.infer<typeof ApiErrorSchema>;
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;
export type UrlSourceUpsertRequest = z.infer<
  typeof UrlSourceUpsertRequestSchema
>;
export type UrlSource = z.infer<typeof UrlSourceSchema>;
export type FollowOrigin = z.infer<typeof FollowOriginSchema>;
export type FollowState = z.infer<typeof FollowStateSchema>;
export type RefreshIntervalMinutes = z.infer<
  typeof RefreshIntervalMinutesSchema
>;
export type SourceCategory = z.infer<typeof SourceCategorySchema>;
export type RecommendedSource = z.infer<typeof RecommendedSourceSchema>;
export type RecommendedSourcesResponse = z.infer<
  typeof RecommendedSourcesResponseSchema
>;
export type SourceFollow = z.infer<typeof SourceFollowSchema>;
export type PublicUrlFollowTarget = z.infer<typeof PublicUrlFollowTargetSchema>;
export type RecommendedFollowTarget = z.infer<
  typeof RecommendedFollowTargetSchema
>;
export type CreateSourceFollowRequest = z.infer<
  typeof CreateSourceFollowRequestSchema
>;
export type UpdateSourceFollowRequest = z.infer<
  typeof UpdateSourceFollowRequestSchema
>;
export type SourceFollowsResponse = z.infer<typeof SourceFollowsResponseSchema>;
export type SourceFollowResponse = z.infer<typeof SourceFollowResponseSchema>;
export type SourceFollowJobResponse = z.infer<
  typeof SourceFollowJobResponseSchema
>;
export type DeleteSourceFollowResponse = z.infer<
  typeof DeleteSourceFollowResponseSchema
>;
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;
export type Job = z.infer<typeof JobSchema>;
export type JobResponse = z.infer<typeof JobResponseSchema>;
export type UrlSourceUpsertResponse = z.infer<
  typeof UrlSourceUpsertResponseSchema
>;
export type ChangesQuery = z.infer<typeof ChangesQuerySchema>;
export type ChangeKind = z.infer<typeof ChangeKindSchema>;
export type Coverage = z.infer<typeof CoverageSchema>;
export type Change = z.infer<typeof ChangeSchema>;
export type ChangesPage = z.infer<typeof ChangesPageSchema>;
export type ChangeStreamQuery = z.infer<typeof ChangeStreamQuerySchema>;
export type ChangeStreamEvent = z.infer<typeof ChangeStreamEventSchema>;
export type SourceItem = z.infer<typeof SourceItemSchema>;
export type ItemRevision = z.infer<typeof ItemRevisionSchema>;
export type RevisionResponse = z.infer<typeof RevisionResponseSchema>;
export type UpsertURLSourceRequest = z.infer<
  typeof UpsertURLSourceRequestSchema
>;
export type UpsertURLSourceResponse = z.infer<
  typeof UpsertURLSourceResponseSchema
>;
export type RefreshSourceRequest = z.infer<typeof RefreshSourceRequestSchema>;
export type ChangesResponse = z.infer<typeof ChangesResponseSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
