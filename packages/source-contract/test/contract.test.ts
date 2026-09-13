import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ApiErrorResponseSchema,
  CAPABILITY_NAMES,
  CapabilitiesResponseSchema,
  CHANGE_STREAM_EVENT_NAME,
  CHANGE_KINDS,
  ChangeStreamEventSchema,
  ChangeStreamQuerySchema,
  ChangesPageSchema,
  ChangesQuerySchema,
  ContentHashSchema,
  COVERAGES,
  CoverageSchema,
  CreateSourceFollowRequestSchema,
  CursorSchema,
  DeleteSourceFollowResponseSchema,
  ErrorResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  IdempotencyKeySchema,
  JOB_STATUSES,
  JobResponseSchema,
  LAST_EVENT_ID_HEADER,
  PairRequestSchema,
  PairResponseSchema,
  ReadingResponseSchema,
  PROTOCOL_VERSION,
  RecommendedSourcesResponseSchema,
  RefreshSourceRequestSchema,
  RevisionResponseSchema,
  SOURCE_API_ERROR_CODES,
  SOURCE_API_PATHS,
  SOURCE_API_SCOPES,
  SOURCE_SCOPES,
  SourceFollowJobResponseSchema,
  SourceFollowResponseSchema,
  SourceFollowsResponseSchema,
  UpdateSourceFollowRequestSchema,
  UpsertURLSourceRequestSchema,
  UpsertURLSourceResponseSchema,
} from "../src/index.js";

const meta = {
  protocolVersion: PROTOCOL_VERSION,
  serverInstanceId: "123e4567-e89b-42d3-a456-426614174000",
};
const timestamp = "2026-09-12T10:30:00.000Z";
const hash = "a".repeat(64);
const queuedJob = {
  id: "job_01",
  status: "queued" as const,
  sourceId: "source_01",
  createdAt: timestamp,
  updatedAt: timestamp,
};
const succeededJob = {
  ...queuedJob,
  status: "succeeded" as const,
  itemId: "item_01",
  revisionId: "revision_01",
};
const revisionResponse = {
  meta,
  item: {
    id: "item_01",
    sourceId: "source_01",
    canonicalUrl: "https://example.test/articles/one",
    title: "A deterministic article",
  },
  revision: {
    id: "revision_01",
    itemId: "item_01",
    observedAt: timestamp,
    contentHash: hash,
    coverage: "fulltext" as const,
    missing: [],
    content: "Fixture body",
  },
};

test("pairing and capabilities accept valid fixtures and additive future fields", () => {
  const pairRequest = PairRequestSchema.safeParse({
    deviceName: "Y's Mac",
    bootstrapToken: "one-time-bootstrap-token",
    futureRequestField: true,
  });
  assert.equal(pairRequest.success, true);

  const pairResponse = PairResponseSchema.safeParse({
    meta: { ...meta, futureMetaField: "accepted" },
    tenantId: "tenant_01",
    deviceId: "device_01",
    token: "opaque-device-token",
    scopes: ["sources:read", "sources:write", "refreshes:write"],
    futureResponseField: { version: 2 },
  });
  assert.equal(pairResponse.success, true);

  const capabilities = CapabilitiesResponseSchema.parse({
    meta,
    tenantId: "tenant_01",
    capabilities: Object.fromEntries(
      CAPABILITY_NAMES.map((name) => [name, true]),
    ),
    scopes: SOURCE_SCOPES,
    futureCapabilityEnvelope: "accepted",
  });
  assert.equal(capabilities.capabilities.publicUrl, true);
  assert.deepEqual(SOURCE_SCOPES, SOURCE_API_SCOPES);
});

test("pairing rejects invalid core identity, bounds, and scopes", () => {
  assert.equal(
    PairRequestSchema.safeParse({ deviceName: "", bootstrapToken: "x" })
      .success,
    false,
  );
  assert.equal(
    PairRequestSchema.safeParse({
      deviceName: "x".repeat(121),
      bootstrapToken: "x",
    }).success,
    false,
  );
  assert.equal(
    PairRequestSchema.safeParse({
      deviceName: "device",
      bootstrapToken: "x".repeat(513),
    }).success,
    false,
  );
  assert.equal(
    PairResponseSchema.safeParse({
      meta: { ...meta, serverInstanceId: "not-a-uuid" },
      tenantId: "tenant_01",
      deviceId: "device_01",
      token: "token",
      scopes: ["sources:read"],
    }).success,
    false,
  );
  assert.equal(
    PairResponseSchema.safeParse({
      meta,
      tenantId: "tenant_01",
      deviceId: "device_01",
      token: "token",
      scopes: ["sources:read", "sources:read"],
    }).success,
    false,
  );
  assert.equal(
    PairResponseSchema.safeParse({
      meta,
      tenantId: "tenant_01",
      deviceId: "device_01",
      token: "token",
      scopes: ["admin"],
    }).success,
    false,
  );
});

test("URL upsert, empty refresh, and job state fixtures enforce stable fields", () => {
  assert.equal(
    UpsertURLSourceRequestSchema.safeParse({
      url: "https://example.test/articles/one",
      futureOption: true,
    }).success,
    true,
  );
  for (const url of [
    "file:///etc/passwd",
    "https://user:secret@example.test/article",
    "https://example.test/article?access_token=secret",
    "https://example.test/article?X-Amz-Signature=secret",
    "not a URL",
  ])
    assert.equal(
      UpsertURLSourceRequestSchema.safeParse({ url }).success,
      false,
      url,
    );

  assert.equal(RefreshSourceRequestSchema.safeParse({}).success, true);
  assert.equal(
    RefreshSourceRequestSchema.safeParse({ futureOption: true }).success,
    true,
  );

  const upsert = UpsertURLSourceResponseSchema.parse({
    meta,
    source: {
      id: "source_01",
      url: "https://example.test/articles/one",
      version: 1,
      futureSourceField: true,
    },
    job: queuedJob,
    futureResponseField: true,
  });
  assert.equal(upsert.source.id, queuedJob.sourceId);

  assert.equal(
    UpsertURLSourceResponseSchema.safeParse({
      meta,
      source: {
        id: "source_other",
        url: "https://example.test/articles/one",
        version: 1,
      },
      job: queuedJob,
    }).success,
    false,
  );
  assert.equal(
    JobResponseSchema.safeParse({ meta, job: succeededJob }).success,
    true,
  );
  assert.equal(
    JobResponseSchema.safeParse({
      meta,
      job: {
        ...queuedJob,
        status: "succeeded",
      },
    }).success,
    false,
  );
  assert.equal(
    JobResponseSchema.safeParse({
      meta,
      job: {
        ...queuedJob,
        status: "failed",
      },
    }).success,
    false,
  );
  assert.equal(
    JobResponseSchema.safeParse({
      meta,
      job: {
        ...queuedJob,
        status: "paused",
      },
    }).success,
    false,
  );
});

test("feed completion and reading remain additive without allowing ambiguous results", () => {
  const empty = {
    meta,
    job: { ...queuedJob, status: "succeeded", itemCount: 0 },
  };
  assert.equal(JobResponseSchema.safeParse(empty).success, true);
  assert.equal(
    JobResponseSchema.safeParse({
      ...empty,
      job: { ...empty.job, itemId: "unexpected" },
    }).success,
    false,
  );
  assert.equal(
    JobResponseSchema.safeParse({
      ...empty,
      job: { ...empty.job, itemCount: 2 },
    }).success,
    false,
  );
  assert.equal(
    JobResponseSchema.safeParse({
      meta,
      job: { ...succeededJob, itemCount: 2 },
    }).success,
    true,
  );
  assert.equal(
    RevisionResponseSchema.safeParse({
      ...revisionResponse,
      revision: { ...revisionResponse.revision, publishedAt: timestamp },
    }).success,
    true,
  );
  const reading = {
    meta,
    topics: [
      {
        id: "reading-01",
        title: "A sourced topic",
        category: "Tools",
        summary: "Actual supplied observations.",
        generatedAt: timestamp,
        model: "fixture",
        inputHash: hash,
        points: [
          {
            title: "One supported point",
            detail: "The observed change.",
            sourceIds: ["item_01"],
          },
        ],
        caveats: [],
        evidence: [
          {
            itemId: "item_01",
            revisionId: "revision_01",
            title: "Source",
            url: "https://example.com/source",
            coverage: "metadata",
            excerpt: "A limited summary.",
          },
        ],
        futureTopicField: true,
      },
    ],
  };
  assert.equal(ReadingResponseSchema.safeParse(reading).success, true);
  assert.equal(
    ReadingResponseSchema.safeParse({
      ...reading,
      topics: [{ ...reading.topics[0], evidence: [] }],
    }).success,
    false,
  );
});

test("recommended and user follows preserve origin, category, schedule, and status", () => {
  const follow = {
    id: "follow_01",
    sourceId: "source_01",
    origin: "recommended" as const,
    recommendedSourceId: "openai-agents-js-changelog",
    name: "OpenAI Agents JS 更新",
    category: "开发工具",
    url: "https://raw.githubusercontent.com/openai/openai-agents-js/main/packages/agents/CHANGELOG.md",
    state: "active" as const,
    refreshIntervalMinutes: 360,
    createdAt: timestamp,
    updatedAt: timestamp,
    nextRefreshAt: timestamp,
    lastError: {
      code: "SOURCE_TIMEOUT" as const,
      message: "上次刷新超时。",
      retryable: true,
    },
  };
  assert.equal(
    RecommendedSourcesResponseSchema.safeParse({
      meta,
      sources: [
        {
          id: follow.recommendedSourceId,
          name: follow.name,
          category: follow.category,
          description: "OpenAI 官方仓库发布的 SDK 变更记录。",
          url: follow.url,
          refreshIntervalMinutes: 360,
          enabledByDefault: true,
        },
      ],
    }).success,
    true,
  );
  assert.equal(
    CreateSourceFollowRequestSchema.safeParse({
      source: { kind: "public-url", url: "https://example.test/feed" },
      name: "用户关注",
      category: "研究",
      refreshIntervalMinutes: 30,
    }).success,
    true,
  );
  assert.equal(
    CreateSourceFollowRequestSchema.safeParse({
      source: {
        kind: "recommended",
        recommendedSourceId: follow.recommendedSourceId,
      },
    }).success,
    true,
  );
  assert.equal(
    CreateSourceFollowRequestSchema.safeParse({
      source: { kind: "public-url", url: "file:///tmp/feed" },
    }).success,
    false,
  );
  assert.equal(UpdateSourceFollowRequestSchema.safeParse({}).success, false);
  assert.equal(
    UpdateSourceFollowRequestSchema.safeParse({ state: "paused" }).success,
    true,
  );
  assert.equal(
    SourceFollowsResponseSchema.safeParse({ meta, follows: [follow] }).success,
    true,
  );
  assert.equal(
    SourceFollowResponseSchema.safeParse({ meta, follow }).success,
    true,
  );
  assert.equal(
    SourceFollowJobResponseSchema.safeParse({ meta, follow, job: queuedJob })
      .success,
    true,
  );
  assert.equal(
    SourceFollowJobResponseSchema.safeParse({
      meta,
      follow,
      job: { ...queuedJob, sourceId: "source_other" },
    }).success,
    false,
  );
  assert.equal(
    DeleteSourceFollowResponseSchema.safeParse({
      meta,
      followId: follow.id,
      deleted: true,
    }).success,
    true,
  );
  assert.equal(
    SourceFollowResponseSchema.safeParse({
      meta,
      follow: {
        ...follow,
        origin: "user",
        recommendedSourceId: follow.recommendedSourceId,
      },
    }).success,
    false,
  );
});

test("changes require signed cursors and revision identity on item events", () => {
  const cursor = "eyJzZXF1ZW5jZSI6MX0.c2lnbmF0dXJl";
  assert.equal(CursorSchema.safeParse(cursor).success, true);
  assert.deepEqual(ChangesQuerySchema.parse({ cursor, limit: "20" }), {
    cursor,
    limit: 20,
  });
  for (const invalid of ["", "unsigned", "a.b.c", "a+.b", "a. b"])
    assert.equal(CursorSchema.safeParse(invalid).success, false, invalid);

  const itemChange = {
    id: "change_01",
    kind: "item.created" as const,
    sourceId: "source_01",
    itemId: "item_01",
    revisionId: "revision_01",
    observedAt: timestamp,
    contentHash: hash,
    coverage: "fulltext" as const,
    missing: [],
    occurredAt: timestamp,
  };
  assert.equal(
    ChangesPageSchema.safeParse({
      meta,
      changes: [{ ...itemChange, futureChangeField: true }],
      nextCursor: cursor,
      hasMore: false,
      futurePageField: true,
    }).success,
    true,
  );
  for (const missing of [
    "itemId",
    "revisionId",
    "observedAt",
    "contentHash",
    "coverage",
    "missing",
  ]) {
    const broken = { ...itemChange } as Record<string, unknown>;
    delete broken[missing];
    assert.equal(
      ChangesPageSchema.safeParse({
        meta,
        changes: [broken],
        nextCursor: cursor,
        hasMore: false,
      }).success,
      false,
      missing,
    );
  }
  assert.equal(
    ChangesPageSchema.safeParse({
      meta,
      changes: [{ ...itemChange, kind: "item.unknown" }],
      nextCursor: cursor,
      hasMore: false,
    }).success,
    false,
  );
  for (const coverage of COVERAGES)
    assert.equal(
      ChangesPageSchema.safeParse({
        meta,
        changes: [{ ...itemChange, coverage }],
        nextCursor: cursor,
        hasMore: false,
      }).success,
      true,
      coverage,
    );
  assert.equal(
    ChangesPageSchema.safeParse({
      meta,
      changes: [{ ...itemChange, coverage: "summary" }],
      nextCursor: cursor,
      hasMore: false,
    }).success,
    false,
  );
});

test("SSE change events carry the same signed cursor in a typed envelope", () => {
  const cursor = "eyJzZXF1ZW5jZSI6MX0.c2lnbmF0dXJl";
  const change = {
    id: "change_01",
    kind: "item.created" as const,
    sourceId: "source_01",
    itemId: "item_01",
    revisionId: "revision_01",
    observedAt: timestamp,
    contentHash: hash,
    coverage: "fulltext" as const,
    missing: [],
    occurredAt: timestamp,
  };
  assert.deepEqual(ChangeStreamQuerySchema.parse({ cursor }), { cursor });
  assert.equal(
    ChangeStreamEventSchema.safeParse({ meta, cursor, change }).success,
    true,
  );
  assert.equal(
    ChangeStreamEventSchema.safeParse({ meta, cursor: "unsigned", change })
      .success,
    false,
  );
  assert.equal(CHANGE_STREAM_EVENT_NAME, "change");
  assert.equal(LAST_EVENT_ID_HEADER, "Last-Event-ID");
});

test("revision fixtures validate immutable hashes, coverage, and item linkage", () => {
  assert.equal(
    RevisionResponseSchema.safeParse({
      ...revisionResponse,
      futureResponseField: true,
      revision: {
        ...revisionResponse.revision,
        futureRevisionField: true,
      },
    }).success,
    true,
  );
  assert.equal(ContentHashSchema.safeParse(hash).success, true);
  for (const contentHash of ["a".repeat(63), "A".repeat(64), `sha256:${hash}`])
    assert.equal(ContentHashSchema.safeParse(contentHash).success, false);
  for (const coverage of COVERAGES) {
    assert.equal(CoverageSchema.safeParse(coverage).success, true, coverage);
    assert.equal(
      RevisionResponseSchema.safeParse({
        ...revisionResponse,
        revision: { ...revisionResponse.revision, coverage },
      }).success,
      true,
      coverage,
    );
  }
  for (const coverage of ["summary", "", "FULLTEXT"])
    assert.equal(CoverageSchema.safeParse(coverage).success, false, coverage);
  assert.equal(
    RevisionResponseSchema.safeParse({
      ...revisionResponse,
      revision: { ...revisionResponse.revision, observedAt: "yesterday" },
    }).success,
    false,
  );
  assert.equal(
    RevisionResponseSchema.safeParse({
      ...revisionResponse,
      revision: { ...revisionResponse.revision, itemId: "item_other" },
    }).success,
    false,
  );
});

test("stable error codes and idempotency keys reject ambiguous values", () => {
  const error = {
    meta,
    error: {
      code: "SOURCE_URL_BLOCKED",
      message: "The URL does not resolve to a public address.",
      retryable: false,
    },
  };
  assert.equal(ErrorResponseSchema.safeParse(error).success, true);
  assert.equal(ApiErrorResponseSchema.safeParse(error).success, true);
  for (const code of SOURCE_API_ERROR_CODES)
    assert.equal(
      ErrorResponseSchema.safeParse({
        ...error,
        error: { ...error.error, code },
      }).success,
      true,
      code,
    );
  assert.equal(
    ErrorResponseSchema.safeParse({
      ...error,
      error: { ...error.error, code: "RAW_CONNECTOR_EXCEPTION" },
    }).success,
    false,
  );
  assert.equal(
    IdempotencyKeySchema.safeParse("device-01:request-01").success,
    true,
  );
  for (const key of ["", "contains space", "x".repeat(257)])
    assert.equal(IdempotencyKeySchema.safeParse(key).success, false, key);
});

test("checked-in OpenAPI exposes the same paths, enums, hashes, and cursors", async () => {
  const raw = await readFile(
    new URL("../openapi/source-v1.yaml", import.meta.url),
    "utf8",
  );
  assert.match(raw, /"openapi": "3\.1\.0"/);
  for (const path of Object.values(SOURCE_API_PATHS))
    assert.ok(raw.includes(`"${path}"`), path);
  assert.ok(raw.includes(`"const": "${PROTOCOL_VERSION}"`));
  for (const value of [
    ...SOURCE_API_SCOPES,
    ...JOB_STATUSES,
    ...CHANGE_KINDS,
    ...COVERAGES,
    ...SOURCE_API_ERROR_CODES,
  ])
    assert.ok(raw.includes(`"${value}"`), value);
  assert.ok(raw.includes('"pattern": "^[a-f0-9]{64}$"'));
  assert.ok(raw.includes('"pattern": "^[A-Za-z0-9_-]+\\\\.[A-Za-z0-9_-]+$"'));
  assert.ok(raw.includes(`"name": "${IDEMPOTENCY_KEY_HEADER}"`));
  assert.ok(raw.includes(`"name": "${LAST_EVENT_ID_HEADER}"`));
  assert.ok(raw.includes('"text/event-stream"'));
  assert.ok(raw.includes('"$ref": "#/components/schemas/ChangeStreamEvent"'));
  assert.equal(
    raw.match(/"\$ref": "#\/components\/schemas\/Coverage"/g)?.length,
    2,
  );
  assert.equal(raw.includes('"additionalProperties": false'), false);
  assert.equal(
    raw.match(/#\/components\/parameters\/IdempotencyKey/g)?.length,
    7,
  );
  const section = (start: string, end: string) =>
    raw.slice(raw.indexOf(`"${start}"`), raw.indexOf(`"${end}"`));
  const capabilities = section(
    SOURCE_API_PATHS.capabilities,
    SOURCE_API_PATHS.pair,
  );
  assert.ok(capabilities.includes('"security": [{ "DeviceToken": [] }]'));
  const urlUpsert = section(
    SOURCE_API_PATHS.urlSource,
    SOURCE_API_PATHS.refreshes,
  );
  assert.ok(urlUpsert.includes('"202":'));
  assert.equal(urlUpsert.includes('"200":'), false);
  const changes = section(SOURCE_API_PATHS.changes, SOURCE_API_PATHS.revision);
  assert.equal(changes.includes('"409":'), false);
  assert.equal(
    raw.match(/"schema": \{ "\$ref": "#\/components\/schemas\/Uuid" \}/g)
      ?.length,
    5,
  );
});
