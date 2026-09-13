import { createHash, randomUUID } from "node:crypto";
import {
  ContentHashSchema,
  CoverageSchema,
  StableIdSchema,
  HttpUrlSchema,
  MAX_ITEM_CONTENT_BYTES,
  type FollowOrigin,
  type FollowState,
  type SourceApiError,
} from "@ytriple/source-contract";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { ChangeNotifier } from "../change-notifier.js";
import { initialMigration } from "./migrations/001-initial.js";
import { jobLeaseTokenMigration } from "./migrations/002-job-lease-token.js";
import { observationRevisionMigration } from "./migrations/003-observation-revisions.js";
import { jobErrorRetryabilityMigration } from "./migrations/004-job-error-retryability.js";
import { changeNotificationsMigration } from "./migrations/005-change-notifications.js";
import { sourceFollowsMigration } from "./migrations/006-source-follows.js";
import { immutableFollowDeliveriesMigration } from "./migrations/007-immutable-follow-deliveries.js";
import { feedItemsMigration } from "./migrations/008-feed-items.js";
import { readingTopicsMigration } from "./migrations/009-reading-topics.js";
import { publicationTimeMigration } from "./migrations/010-publication-time.js";
import { editorialMigration } from "./migrations/011-editorial.js";
import { editorialPresentationMigration } from "./migrations/012-editorial-presentation.js";
import { editorialEditionMigration } from "./migrations/013-editorial-edition.js";

const migrations = [
  initialMigration,
  jobLeaseTokenMigration,
  observationRevisionMigration,
  jobErrorRetryabilityMigration,
  changeNotificationsMigration,
  sourceFollowsMigration,
  immutableFollowDeliveriesMigration,
  feedItemsMigration,
  readingTopicsMigration,
  publicationTimeMigration,
  editorialMigration,
  editorialPresentationMigration,
  editorialEditionMigration,
] as const;

export type AuthenticatedDevice = {
  tenantId: string;
  principalId: string;
  deviceId: string;
  scopes: string[];
};

export type StoredSource = {
  id: string;
  url: string;
  version: number;
};

export type StoredJob = {
  id: string;
  tenantId: string;
  sourceId: string;
  sourceURL?: string;
  status: "queued" | "running" | "succeeded" | "failed";
  attempt: number;
  maxAttempts: number;
  /** Internal fencing token. It is never serialized by the public API. */
  leaseToken?: string;
  itemId?: string;
  revisionId?: string;
  itemCount?: number;
  followId?: string;
  error?: { code: string; message: string; retryable: boolean };
  createdAt: string;
  updatedAt: string;
};

export type StoredRecommendedSource = {
  id: string;
  name: string;
  category: string;
  description: string;
  url: string;
  refreshIntervalMinutes: number;
  enabledByDefault: boolean;
};

export type StoredSourceFollow = {
  id: string;
  sourceId: string;
  origin: FollowOrigin;
  recommendedSourceId?: string;
  name: string;
  category: string;
  url: string;
  state: FollowState;
  refreshIntervalMinutes: number;
  createdAt: string;
  updatedAt: string;
  nextRefreshAt?: string;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastError?: SourceApiError;
};

export type CreateStoredFollowInput = {
  target:
    | { kind: "public-url"; url: string }
    | { kind: "recommended"; recommendedSourceId: string };
  name?: string;
  category?: string;
  refreshIntervalMinutes?: number;
};

export type NormalizedPublicItem = {
  publishedAt?: string;
  externalItemKey?: string;
  canonicalUrl: string;
  title: string;
  content: string;
  observedAt: string;
  contentHash: string;
  coverage: "fulltext" | "metadata";
  missing: string[];
};

type StoredWrite = { status: number; body: unknown };

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const iso = (value: string | Date) => new Date(value).toISOString();

async function one<T extends QueryResultRow>(
  client: Pool | PoolClient,
  text: string,
  values: unknown[] = [],
): Promise<T> {
  const result = await client.query<T>(text, values);
  if (result.rowCount !== 1) throw new Error("数据库返回了意外的记录数量。");
  return result.rows[0]!;
}

function jobFromRow(row: Record<string, unknown>): StoredJob {
  const errorCode = row.error_code as string | null;
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    sourceId: String(row.source_id),
    sourceURL:
      typeof row.normalized_url === "string" ? row.normalized_url : undefined,
    status: row.status as StoredJob["status"],
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    leaseToken:
      typeof row.lease_token === "string" ? row.lease_token : undefined,
    itemId: row.item_id ? String(row.item_id) : undefined,
    itemCount: row.item_count == null ? undefined : Number(row.item_count),
    revisionId: row.revision_id ? String(row.revision_id) : undefined,
    followId: row.follow_id ? String(row.follow_id) : undefined,
    error: errorCode
      ? {
          code: errorCode,
          message: String(row.error_message || "信息源刷新失败。"),
          retryable: Boolean(row.error_retryable),
        }
      : undefined,
    createdAt: iso(row.created_at as string | Date),
    updatedAt: iso(row.updated_at as string | Date),
  };
}

function recommendedSourceFromRow(
  row: Record<string, unknown>,
): StoredRecommendedSource {
  return {
    id: String(row.id),
    name: String(row.name),
    category: String(row.category),
    description: String(row.description),
    url: String(row.normalized_url),
    refreshIntervalMinutes: Number(row.refresh_interval_minutes),
    enabledByDefault: Boolean(row.enabled_by_default),
  };
}

function sourceFollowFromRow(row: Record<string, unknown>): StoredSourceFollow {
  const errorCode = row.last_error_code;
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    origin: row.origin as FollowOrigin,
    recommendedSourceId: row.recommended_source_id
      ? String(row.recommended_source_id)
      : undefined,
    name: String(row.name),
    category: String(row.category),
    url: String(row.normalized_url),
    state: row.state as FollowState,
    refreshIntervalMinutes: Number(row.refresh_interval_minutes),
    createdAt: iso(row.created_at as string | Date),
    updatedAt: iso(row.updated_at as string | Date),
    nextRefreshAt: row.next_refresh_at
      ? iso(row.next_refresh_at as string | Date)
      : undefined,
    lastAttemptAt: row.last_attempt_at
      ? iso(row.last_attempt_at as string | Date)
      : undefined,
    lastSuccessAt: row.last_success_at
      ? iso(row.last_success_at as string | Date)
      : undefined,
    lastError: errorCode
      ? {
          code: String(errorCode) as SourceApiError["code"],
          message: String(row.last_error_message || "信息源刷新失败。"),
          retryable: Boolean(row.last_error_retryable),
        }
      : undefined,
  };
}

export class SourceDatabase {
  readonly pool: Pool;
  private readonly changeNotifier: ChangeNotifier;
  private instanceId?: string;

  constructor(databaseURL: string) {
    this.pool = new Pool({
      connectionString: databaseURL,
      max: Number(process.env.SOURCE_DATABASE_POOL_SIZE || 10),
      statement_timeout: 30_000,
      application_name: "ytriple-source-service",
    });
    this.changeNotifier = new ChangeNotifier(databaseURL);
  }

  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(937463821)");
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migration (
          version integer PRIMARY KEY,
          name text NOT NULL,
          checksum char(64),
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        "ALTER TABLE schema_migration ADD COLUMN IF NOT EXISTS checksum char(64)",
      );
      const newest = await one<{ version: number | null }>(
        client,
        "SELECT max(version) AS version FROM schema_migration",
      );
      if (
        newest.version !== null &&
        newest.version > migrations.at(-1)!.version
      )
        throw new Error("数据库版本高于当前信息源服务可支持的版本。");
      for (const migration of migrations) {
        const checksum = hash(migration.sql);
        const applied = await client.query<{
          version: number;
          name: string;
          checksum: string | null;
        }>(
          "SELECT version, name, checksum FROM schema_migration WHERE version = $1",
          [migration.version],
        );
        if (applied.rowCount) {
          const row = applied.rows[0]!;
          if (row.name !== migration.name)
            throw new Error(
              `迁移 ${migration.version} 的名称与已应用记录不一致。`,
            );
          if (row.checksum && row.checksum !== checksum)
            throw new Error(`迁移 ${migration.version} 的内容已被修改。`);
          if (!row.checksum)
            await client.query(
              "UPDATE schema_migration SET checksum = $2 WHERE version = $1",
              [migration.version, checksum],
            );
        } else {
          await client.query(migration.sql);
          await client.query(
            "INSERT INTO schema_migration(version, name, checksum) VALUES ($1, $2, $3)",
            [migration.version, migration.name, checksum],
          );
        }
      }
      const preferred = randomUUID();
      const instance = await one<{ id: string }>(
        client,
        `INSERT INTO service_instance(singleton, id)
         VALUES (true, $1)
         ON CONFLICT (singleton) DO UPDATE SET singleton = EXCLUDED.singleton
         RETURNING id`,
        [preferred],
      );
      this.instanceId = instance.id;
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      await client
        .query("SELECT pg_advisory_unlock(937463821)")
        .catch(() => {});
      client.release();
    }
  }

  async serverInstanceId(): Promise<string> {
    if (this.instanceId) return this.instanceId;
    const row = await one<{ id: string }>(
      this.pool,
      "SELECT id FROM service_instance WHERE singleton = true",
    );
    this.instanceId = row.id;
    return row.id;
  }

  async ready(): Promise<boolean> {
    try {
      const result = await one<{
        count: string;
        valid: boolean;
        newest: number | null;
        objects_ready: boolean;
      }>(
        this.pool,
        `SELECT count(*) FILTER (WHERE version = ANY($1::integer[])),
                bool_and(checksum IS NOT NULL) AS valid,
                max(version) AS newest,
                to_regclass('service_instance') IS NOT NULL
                  AND to_regclass('device') IS NOT NULL
                  AND to_regclass('source') IS NOT NULL
                  AND to_regclass('fetch_run') IS NOT NULL
                  AND to_regclass('item_revision') IS NOT NULL
                  AND to_regclass('delivery_change') IS NOT NULL
                  AND to_regclass('recommended_source') IS NOT NULL
                  AND to_regclass('source_follow') IS NOT NULL AS objects_ready
         FROM schema_migration`,
        [migrations.map(({ version }) => version)],
      );
      return (
        Number(result.count) === migrations.length &&
        result.valid &&
        result.newest === migrations.at(-1)!.version &&
        result.objects_ready
      );
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.changeNotifier.close();
    await this.pool.end();
  }

  subscribeToChanges(
    tenantId: string,
    listener: () => void,
  ): Promise<() => void> {
    return this.changeNotifier.subscribe(tenantId, listener);
  }

  async pairDevice(input: {
    idempotencyKey: string;
    requestHash: string;
    deviceName: string;
    tokenForDevice: (deviceId: string) => string;
    scopes: string[];
  }): Promise<{
    tenantId: string;
    deviceId: string;
    token: string;
    scopes: string[];
  }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`pair:${input.idempotencyKey}`],
      );
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        ["pair:bootstrap-identity"],
      );
      const prior = await client.query<{
        request_hash: string;
        device_id: string;
        tenant_id: string;
        scopes: string[];
        token_hash: string;
      }>(
        `SELECT p.request_hash, p.device_id, d.tenant_id, d.scopes, d.token_hash
         FROM pairing_request p
         JOIN device d ON d.id = p.device_id
         WHERE p.idempotency_key = $1`,
        [input.idempotencyKey],
      );
      if (prior.rowCount) {
        const row = prior.rows[0]!;
        if (row.request_hash !== input.requestHash)
          throw new IdempotencyConflictError();
        const token = input.tokenForDevice(row.device_id);
        if (hash(token) !== row.token_hash)
          throw new PairingReplayExpiredError();
        await client.query("COMMIT");
        return {
          tenantId: row.tenant_id,
          deviceId: row.device_id,
          token,
          scopes: row.scopes,
        };
      }

      const identity = await client.query<{
        tenant_id: string;
        principal_id: string;
      }>(
        "SELECT tenant_id, principal_id FROM bootstrap_identity WHERE singleton = true",
      );
      let owner = identity.rows[0];
      if (!owner) {
        const tenantId = randomUUID();
        const principalId = randomUUID();
        await client.query("INSERT INTO tenant(id) VALUES ($1)", [tenantId]);
        await client.query(
          "INSERT INTO principal(id, tenant_id, kind) VALUES ($1, $2, 'self-host-owner')",
          [principalId, tenantId],
        );
        await client.query(
          "INSERT INTO bootstrap_identity(singleton, tenant_id, principal_id) VALUES (true, $1, $2)",
          [tenantId, principalId],
        );
        owner = { tenant_id: tenantId, principal_id: principalId };
      }
      const deviceId = randomUUID();
      const token = input.tokenForDevice(deviceId);
      await client.query(
        `INSERT INTO device(id, tenant_id, principal_id, name, token_hash, scopes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          deviceId,
          owner.tenant_id,
          owner.principal_id,
          input.deviceName,
          hash(token),
          input.scopes,
        ],
      );
      await client.query(
        `INSERT INTO pairing_request(idempotency_key, request_hash, device_id)
         VALUES ($1, $2, $3)`,
        [input.idempotencyKey, input.requestHash, deviceId],
      );
      await client.query("COMMIT");
      return {
        tenantId: owner.tenant_id,
        deviceId,
        token,
        scopes: input.scopes,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async authenticate(token: string): Promise<AuthenticatedDevice | undefined> {
    const result = await this.pool.query<{
      tenant_id: string;
      principal_id: string;
      id: string;
      scopes: string[];
    }>(
      `UPDATE device
       SET last_seen_at = now()
       WHERE token_hash = $1 AND revoked_at IS NULL
       RETURNING tenant_id, principal_id, id, scopes`,
      [hash(token)],
    );
    const row = result.rows[0];
    return row
      ? {
          tenantId: row.tenant_id,
          principalId: row.principal_id,
          deviceId: row.id,
          scopes: row.scopes,
        }
      : undefined;
  }

  async configureRecommendedSources(
    sources: Array<{
      id: string;
      name: string;
      category: string;
      description: string;
      url: string;
      refreshIntervalMinutes: number;
      enabledByDefault: boolean;
    }>,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        ["recommended-source-catalog"],
      );
      await client.query(
        "UPDATE recommended_source SET active = false, enabled_by_default = false, updated_at = now()",
      );
      for (const source of sources)
        await client.query(
          `INSERT INTO recommended_source(
             id, name, category, description, kind, normalized_url,
             refresh_interval_minutes, enabled_by_default, active
           ) VALUES ($1, $2, $3, $4, 'public-url', $5, $6, $7, true)
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name,
             category = EXCLUDED.category,
             description = EXCLUDED.description,
             normalized_url = EXCLUDED.normalized_url,
             refresh_interval_minutes = EXCLUDED.refresh_interval_minutes,
             enabled_by_default = EXCLUDED.enabled_by_default,
             active = true,
             updated_at = now()`,
          [
            source.id,
            source.name,
            source.category,
            source.description,
            source.url,
            source.refreshIntervalMinutes,
            source.enabledByDefault,
          ],
        );
      await client.query(
        `UPDATE source_follow f SET
           state = 'paused', next_refresh_at = NULL, updated_at = now()
         WHERE f.origin = 'recommended'
           AND NOT EXISTS (
             SELECT 1 FROM recommended_source r
             WHERE r.id = f.recommended_source_id AND r.active
           )`,
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async recommendedSources(): Promise<StoredRecommendedSource[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT id, name, category, description, normalized_url,
              refresh_interval_minutes, enabled_by_default
       FROM recommended_source
       WHERE active
       ORDER BY name, id`,
    );
    return result.rows.map(recommendedSourceFromRow);
  }

  async ensureDefaultRecommendedFollows(tenantId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`${tenantId}:recommended-source-defaults`],
      );
      const recommendations = await client.query<Record<string, unknown>>(
        `SELECT id, name, category, normalized_url, refresh_interval_minutes
         FROM recommended_source
         WHERE active AND enabled_by_default
         ORDER BY id`,
      );
      for (const recommendation of recommendations.rows) {
        const source = await one<{ id: string }>(
          client,
          `INSERT INTO source(id, tenant_id, connector_id, kind, normalized_url)
           VALUES ($1, $2, 'public-url', 'public-url', $3)
           ON CONFLICT (tenant_id, kind, normalized_url)
           DO UPDATE SET updated_at = source.updated_at
           RETURNING id`,
          [randomUUID(), tenantId, recommendation.normalized_url],
        );
        const follow = await client.query<{ id: string }>(
          `INSERT INTO source_follow(
             id, tenant_id, source_id, origin, recommended_source_id,
             name, category, state, refresh_interval_minutes, next_refresh_at
           ) VALUES ($1, $2, $3, 'recommended', $4, $5, $6, 'active', $7,
                     clock_timestamp() + ($7::integer * interval '1 minute'))
           ON CONFLICT (tenant_id, recommended_source_id)
             WHERE origin = 'recommended'
           DO NOTHING
           RETURNING id`,
          [
            randomUUID(),
            tenantId,
            source.id,
            recommendation.id,
            recommendation.name,
            recommendation.category,
            recommendation.refresh_interval_minutes,
          ],
        );
        if (follow.rowCount)
          await client.query(
            `INSERT INTO fetch_run(
               id, tenant_id, source_id, follow_id, trigger_kind, status
             ) VALUES ($1, $2, $3, $4, 'created', 'queued')
             ON CONFLICT (follow_id)
               WHERE follow_id IS NOT NULL AND status IN ('queued', 'running')
             DO NOTHING`,
            [randomUUID(), tenantId, source.id, follow.rows[0]!.id],
          );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async ensureDefaultRecommendedFollowsForAllTenants(): Promise<void> {
    const tenants = await this.pool.query<{ id: string }>(
      "SELECT id FROM tenant ORDER BY id",
    );
    for (const tenant of tenants.rows)
      await this.ensureDefaultRecommendedFollows(tenant.id);
  }

  async sourceFollows(tenantId: string): Promise<StoredSourceFollow[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT f.*, s.normalized_url
       FROM source_follow f
       JOIN source s ON s.tenant_id = f.tenant_id AND s.id = f.source_id
       WHERE f.tenant_id = $1
       ORDER BY CASE f.origin WHEN 'recommended' THEN 0 ELSE 1 END,
                f.name, f.id`,
      [tenantId],
    );
    return result.rows.map(sourceFollowFromRow);
  }

  async createSourceFollow(
    tenantId: string,
    input: CreateStoredFollowInput,
    idempotencyKey: string,
    requestHash: string,
    responseFor: (follow: StoredSourceFollow, job: StoredJob) => unknown,
  ): Promise<StoredWrite> {
    return this.idempotentWrite(
      tenantId,
      idempotencyKey,
      "source.follow.create",
      requestHash,
      async (client) => {
        let origin: FollowOrigin = "user";
        let recommendedSourceId: string | undefined;
        let url: string;
        let name: string;
        let category: string;
        let refreshIntervalMinutes: number;
        if (input.target.kind === "recommended") {
          const recommendation = await client.query<Record<string, unknown>>(
            `SELECT id, name, category, normalized_url, refresh_interval_minutes
             FROM recommended_source WHERE id = $1 AND active`,
            [input.target.recommendedSourceId],
          );
          const row = recommendation.rows[0];
          if (!row) throw new NotFoundError();
          origin = "recommended";
          recommendedSourceId = String(row.id);
          url = String(row.normalized_url);
          name = input.name || String(row.name);
          category = input.category || String(row.category);
          refreshIntervalMinutes =
            input.refreshIntervalMinutes ||
            Number(row.refresh_interval_minutes);
        } else {
          url = input.target.url;
          name = input.name || new URL(url).hostname;
          category = input.category || "用户指定";
          refreshIntervalMinutes = input.refreshIntervalMinutes || 60;
        }
        const source = await one<{ id: string }>(
          client,
          `INSERT INTO source(id, tenant_id, connector_id, kind, normalized_url)
           VALUES ($1, $2, 'public-url', 'public-url', $3)
           ON CONFLICT (tenant_id, kind, normalized_url)
           DO UPDATE SET updated_at = source.updated_at
           RETURNING id`,
          [randomUUID(), tenantId, url],
        );
        const insertValues = [
          randomUUID(),
          tenantId,
          source.id,
          origin,
          recommendedSourceId || null,
          name,
          category,
          refreshIntervalMinutes,
        ];
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO source_follow(
             id, tenant_id, source_id, origin, recommended_source_id,
             name, category, state, refresh_interval_minutes, next_refresh_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8,
                     clock_timestamp() + ($8::integer * interval '1 minute'))
           ${
             origin === "recommended"
               ? "ON CONFLICT (tenant_id, recommended_source_id) WHERE origin = 'recommended' DO NOTHING"
               : "ON CONFLICT (tenant_id, source_id) WHERE origin = 'user' DO NOTHING"
           }
           RETURNING id`,
          insertValues,
        );
        let followId = inserted.rows[0]?.id;
        if (!followId) {
          const existing = await one<{ id: string }>(
            client,
            origin === "recommended"
              ? `SELECT id FROM source_follow
                 WHERE tenant_id = $1 AND origin = 'recommended'
                   AND recommended_source_id = $2`
              : `SELECT id FROM source_follow
                 WHERE tenant_id = $1 AND origin = 'user' AND source_id = $2`,
            [tenantId, recommendedSourceId || source.id],
          );
          followId = existing.id;
          await client.query(
            `UPDATE source_follow SET
               state = 'active',
               next_refresh_at = COALESCE(next_refresh_at, clock_timestamp()),
               updated_at = now()
             WHERE tenant_id = $1 AND id = $2`,
            [tenantId, followId],
          );
        }
        const follow = await one<Record<string, unknown>>(
          client,
          `SELECT f.*, s.normalized_url
           FROM source_follow f
           JOIN source s
             ON s.tenant_id = f.tenant_id AND s.id = f.source_id
           WHERE f.tenant_id = $1 AND f.id = $2`,
          [tenantId, followId],
        );
        const jobInsert = await client.query<Record<string, unknown>>(
          `INSERT INTO fetch_run(
             id, tenant_id, source_id, follow_id, trigger_kind, status
           ) VALUES ($1, $2, $3, $4, 'created', 'queued')
           ON CONFLICT (follow_id)
             WHERE follow_id IS NOT NULL AND status IN ('queued', 'running')
           DO NOTHING
           RETURNING *`,
          [randomUUID(), tenantId, source.id, follow.id],
        );
        const jobRow =
          jobInsert.rows[0] ||
          (await one<Record<string, unknown>>(
            client,
            `SELECT * FROM fetch_run
               WHERE tenant_id = $1 AND follow_id = $2
                 AND status IN ('queued', 'running')
               ORDER BY created_at LIMIT 1`,
            [tenantId, follow.id],
          ));
        const storedFollow = sourceFollowFromRow(follow);
        const storedJob = jobFromRow(jobRow);
        return {
          status: 202,
          body: responseFor(storedFollow, storedJob),
        };
      },
    );
  }

  async updateSourceFollow(
    tenantId: string,
    followId: string,
    input: {
      name?: string;
      category?: string;
      state?: FollowState;
      refreshIntervalMinutes?: number;
    },
    idempotencyKey: string,
    requestHash: string,
    responseFor: (follow: StoredSourceFollow) => unknown,
  ): Promise<StoredWrite> {
    return this.idempotentWrite(
      tenantId,
      idempotencyKey,
      `source.follow.update:${followId}`,
      requestHash,
      async (client) => {
        const updated = await client.query<Record<string, unknown>>(
          `UPDATE source_follow f SET
             name = COALESCE($3, f.name),
             category = COALESCE($4, f.category),
             state = COALESCE($5, f.state),
             refresh_interval_minutes = COALESCE($6, f.refresh_interval_minutes),
             next_refresh_at = CASE
               WHEN COALESCE($5, f.state) = 'paused' THEN NULL
               WHEN $5 = 'active' AND f.state = 'paused' THEN clock_timestamp()
               WHEN $6 IS NOT NULL THEN
                 clock_timestamp() + ($6::integer * interval '1 minute')
               ELSE f.next_refresh_at
             END,
             updated_at = now()
           FROM source s
           WHERE f.tenant_id = $1 AND f.id = $2
             AND s.tenant_id = f.tenant_id AND s.id = f.source_id
           RETURNING f.*, s.normalized_url`,
          [
            tenantId,
            followId,
            input.name || null,
            input.category || null,
            input.state || null,
            input.refreshIntervalMinutes || null,
          ],
        );
        const row = updated.rows[0];
        if (!row) throw new NotFoundError();
        if (input.state === "paused")
          await client.query(
            `DELETE FROM fetch_run
             WHERE tenant_id = $1 AND follow_id = $2 AND status = 'queued'
               AND trigger_kind IN ('created', 'scheduled')`,
            [tenantId, followId],
          );
        const follow = sourceFollowFromRow(row);
        return { status: 200, body: responseFor(follow) };
      },
    );
  }

  async enqueueFollowRefresh(
    tenantId: string,
    followId: string,
    idempotencyKey: string,
    requestHash: string,
    responseFor: (follow: StoredSourceFollow, job: StoredJob) => unknown,
  ): Promise<StoredWrite> {
    return this.idempotentWrite(
      tenantId,
      idempotencyKey,
      `source.follow.refresh:${followId}`,
      requestHash,
      async (client) => {
        const follow = await client.query<Record<string, unknown>>(
          `SELECT f.*, s.normalized_url
           FROM source_follow f
           JOIN source s
             ON s.tenant_id = f.tenant_id AND s.id = f.source_id
           WHERE f.tenant_id = $1 AND f.id = $2`,
          [tenantId, followId],
        );
        const row = follow.rows[0];
        if (!row) throw new NotFoundError();
        const inserted = await client.query<Record<string, unknown>>(
          `INSERT INTO fetch_run(
             id, tenant_id, source_id, follow_id, trigger_kind, status
           ) VALUES ($1, $2, $3, $4, 'manual', 'queued')
           ON CONFLICT (follow_id)
             WHERE follow_id IS NOT NULL AND status IN ('queued', 'running')
           DO NOTHING RETURNING *`,
          [randomUUID(), tenantId, row.source_id, followId],
        );
        const job =
          inserted.rows[0] ||
          (await one<Record<string, unknown>>(
            client,
            `SELECT * FROM fetch_run
             WHERE tenant_id = $1 AND follow_id = $2
               AND status IN ('queued', 'running')
             ORDER BY created_at LIMIT 1`,
            [tenantId, followId],
          ));
        return {
          status: 202,
          body: responseFor(sourceFollowFromRow(row), jobFromRow(job)),
        };
      },
    );
  }

  async deleteSourceFollow(
    tenantId: string,
    followId: string,
    idempotencyKey: string,
    requestHash: string,
    responseFor: () => unknown,
  ): Promise<StoredWrite> {
    return this.idempotentWrite(
      tenantId,
      idempotencyKey,
      `source.follow.delete:${followId}`,
      requestHash,
      async (client) => {
        const follow = await client.query<{ origin: FollowOrigin }>(
          `SELECT origin FROM source_follow
           WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
          [tenantId, followId],
        );
        const row = follow.rows[0];
        if (!row) throw new NotFoundError();
        if (row.origin === "recommended")
          throw new ConflictError("服务器推荐来源可以暂停，但不能删除。");
        await client.query(
          `DELETE FROM fetch_run
           WHERE tenant_id = $1 AND follow_id = $2 AND status = 'queued'`,
          [tenantId, followId],
        );
        await client.query(
          "DELETE FROM source_follow WHERE tenant_id = $1 AND id = $2",
          [tenantId, followId],
        );
        return { status: 200, body: responseFor() };
      },
    );
  }

  async scheduleDueFollows(limit = 50): Promise<number> {
    const client = await this.pool.connect();
    let scheduled = 0;
    try {
      await client.query("BEGIN");
      const due = await client.query<{
        id: string;
        tenant_id: string;
        source_id: string;
        refresh_interval_minutes: number;
      }>(
        `SELECT id, tenant_id, source_id, refresh_interval_minutes
         FROM source_follow
         WHERE state = 'active' AND next_refresh_at <= clock_timestamp()
         ORDER BY next_refresh_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT $1`,
        [limit],
      );
      for (const follow of due.rows) {
        const result = await client.query(
          `INSERT INTO fetch_run(
             id, tenant_id, source_id, follow_id, trigger_kind, status
           ) VALUES ($1, $2, $3, $4, 'scheduled', 'queued')
           ON CONFLICT (follow_id)
             WHERE follow_id IS NOT NULL AND status IN ('queued', 'running')
           DO NOTHING`,
          [randomUUID(), follow.tenant_id, follow.source_id, follow.id],
        );
        scheduled += result.rowCount || 0;
        await client.query(
          `UPDATE source_follow SET
             next_refresh_at = clock_timestamp()
               + ($3::integer * interval '1 minute'),
             updated_at = now()
           WHERE tenant_id = $1 AND id = $2`,
          [follow.tenant_id, follow.id, follow.refresh_interval_minutes],
        );
      }
      await client.query("COMMIT");
      return scheduled;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  private async idempotentWrite(
    tenantId: string,
    key: string,
    operation: string,
    requestHash: string,
    create: (client: PoolClient) => Promise<StoredWrite>,
  ): Promise<StoredWrite> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`${tenantId}:${key}`],
      );
      const prior = await client.query<{
        operation: string;
        request_hash: string;
        response_status: number;
        response_body: unknown;
      }>(
        `SELECT operation, request_hash, response_status, response_body
         FROM idempotency_request
         WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenantId, key],
      );
      if (prior.rowCount) {
        const row = prior.rows[0]!;
        if (row.operation !== operation || row.request_hash !== requestHash)
          throw new IdempotencyConflictError();
        await client.query("COMMIT");
        return { status: row.response_status, body: row.response_body };
      }
      const result = await create(client);
      await client.query(
        `INSERT INTO idempotency_request(
           tenant_id, idempotency_key, operation, request_hash,
           response_status, response_body
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          tenantId,
          key,
          operation,
          requestHash,
          result.status,
          JSON.stringify(result.body),
        ],
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async upsertURLSource(
    tenantId: string,
    url: string,
    idempotencyKey: string,
    requestHash: string,
    responseFor: (source: StoredSource, job: StoredJob) => unknown,
  ): Promise<StoredWrite> {
    return this.idempotentWrite(
      tenantId,
      idempotencyKey,
      "source.url.upsert",
      requestHash,
      async (client) => {
        const source = await one<{
          id: string;
          normalized_url: string;
          version: number;
        }>(
          client,
          `INSERT INTO source(id, tenant_id, connector_id, kind, normalized_url)
           VALUES ($1, $2, 'public-url', 'public-url', $3)
           ON CONFLICT (tenant_id, kind, normalized_url)
           DO UPDATE SET updated_at = source.updated_at
           RETURNING id, normalized_url, version`,
          [randomUUID(), tenantId, url],
        );
        const jobId = randomUUID();
        const job = await one<Record<string, unknown>>(
          client,
          `INSERT INTO fetch_run(id, tenant_id, source_id, status)
           VALUES ($1, $2, $3, 'queued')
           RETURNING *`,
          [jobId, tenantId, source.id],
        );
        const storedSource = {
          id: source.id,
          url: source.normalized_url,
          version: source.version,
        };
        const storedJob = jobFromRow(job);
        return {
          status: 202,
          body: responseFor(storedSource, storedJob),
        };
      },
    );
  }

  async enqueueRefresh(
    tenantId: string,
    sourceId: string,
    idempotencyKey: string,
    requestHash: string,
    responseFor: (job: StoredJob) => unknown,
  ): Promise<StoredWrite> {
    return this.idempotentWrite(
      tenantId,
      idempotencyKey,
      `source.refresh:${sourceId}`,
      requestHash,
      async (client) => {
        const exists = await client.query(
          "SELECT 1 FROM source WHERE tenant_id = $1 AND id = $2",
          [tenantId, sourceId],
        );
        if (!exists.rowCount) throw new NotFoundError();
        const job = await one<Record<string, unknown>>(
          client,
          `INSERT INTO fetch_run(id, tenant_id, source_id, status)
           VALUES ($1, $2, $3, 'queued') RETURNING *`,
          [randomUUID(), tenantId, sourceId],
        );
        const stored = jobFromRow(job);
        return { status: 202, body: responseFor(stored) };
      },
    );
  }

  async job(tenantId: string, jobId: string): Promise<StoredJob | undefined> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT f.* FROM fetch_run f
       WHERE f.tenant_id = $1 AND f.id = $2`,
      [tenantId, jobId],
    );
    return result.rows[0] ? jobFromRow(result.rows[0]) : undefined;
  }

  async claimJob(leaseSeconds = 45): Promise<StoredJob | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const expired = await client.query<{
        follow_id: string | null;
        status: StoredJob["status"];
      }>(
        `UPDATE fetch_run SET
           status = CASE WHEN attempt >= max_attempts THEN 'failed' ELSE 'queued' END,
           error_code = CASE WHEN attempt >= max_attempts THEN 'SOURCE_WORKER_LOST' ELSE error_code END,
           error_message = CASE WHEN attempt >= max_attempts THEN '刷新进程中断且已达到重试上限。' ELSE error_message END,
           error_retryable = CASE WHEN attempt >= max_attempts THEN false ELSE error_retryable END,
           locked_until = NULL,
           lease_token = NULL,
           updated_at = now()
         WHERE status = 'running' AND locked_until < clock_timestamp()
         RETURNING follow_id, status`,
      );
      for (const lost of expired.rows)
        if (lost.follow_id && lost.status === "failed")
          await client.query(
            `UPDATE source_follow SET
               last_error_code = 'SOURCE_WORKER_LOST',
               last_error_message = '刷新进程中断且已达到重试上限。',
               last_error_retryable = false,
               updated_at = now()
             WHERE id = $1`,
            [lost.follow_id],
          );
      const result = await client.query<Record<string, unknown>>(
        `WITH candidate AS (
           SELECT id FROM fetch_run
           WHERE status = 'queued' AND run_after <= clock_timestamp()
           ORDER BY run_after, created_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE fetch_run f SET
           status = 'running',
           attempt = attempt + 1,
           locked_until = clock_timestamp() + ($1 * interval '1 second'),
           lease_token = $2,
           updated_at = now(),
           error_code = NULL,
           error_message = NULL,
           error_retryable = NULL
         FROM candidate
         WHERE f.id = candidate.id
         RETURNING f.*`,
        [leaseSeconds, randomUUID()],
      );
      if (!result.rowCount) {
        await client.query("COMMIT");
        return undefined;
      }
      const row = result.rows[0]!;
      const source = await one<{ normalized_url: string }>(
        client,
        "SELECT normalized_url FROM source WHERE tenant_id = $1 AND id = $2",
        [row.tenant_id, row.source_id],
      );
      if (row.follow_id)
        await client.query(
          `UPDATE source_follow SET last_attempt_at = now(), updated_at = now()
           WHERE tenant_id = $1 AND id = $2`,
          [row.tenant_id, row.follow_id],
        );
      await client.query("COMMIT");
      return jobFromRow({ ...row, normalized_url: source.normalized_url });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async failJob(
    job: StoredJob,
    error: { code: string; message: string; retryable: boolean },
  ): Promise<boolean> {
    if (!job.leaseToken) return false;
    const retry = error.retryable && job.attempt < job.maxAttempts;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ follow_id: string | null }>(
        `UPDATE fetch_run SET
           status = $3,
           run_after = CASE WHEN $3 = 'queued'
             THEN now() + (LEAST(30, power(2, attempt)) * interval '1 second')
             ELSE run_after END,
           locked_until = NULL,
           lease_token = NULL,
           error_code = $4,
           error_message = $5,
           error_retryable = $6,
           updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND status = 'running'
           AND attempt = $7 AND lease_token = $8
           AND locked_until > clock_timestamp()
         RETURNING follow_id`,
        [
          job.tenantId,
          job.id,
          retry ? "queued" : "failed",
          error.code,
          error.message,
          error.retryable,
          job.attempt,
          job.leaseToken,
        ],
      );
      const followId = result.rows[0]?.follow_id;
      if (followId && !retry)
        await client.query(
          `UPDATE source_follow SET
             last_error_code = $2,
             last_error_message = $3,
             last_error_retryable = $4,
             updated_at = now()
           WHERE id = $1`,
          [followId, error.code, error.message, error.retryable],
        );
      await client.query("COMMIT");
      return result.rowCount === 1;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async renewJobLease(job: StoredJob, leaseSeconds = 45): Promise<boolean> {
    if (!job.leaseToken) return false;
    const result = await this.pool.query(
      `UPDATE fetch_run SET
         locked_until = clock_timestamp() + ($5 * interval '1 second'),
         updated_at = now()
       WHERE tenant_id = $1 AND id = $2 AND status = 'running'
         AND attempt = $3 AND lease_token = $4
         AND locked_until > clock_timestamp()`,
      [job.tenantId, job.id, job.attempt, job.leaseToken, leaseSeconds],
    );
    return result.rowCount === 1;
  }

  async completeJob(
    job: StoredJob,
    item: NormalizedPublicItem,
  ): Promise<StoredJob> {
    return this.completeItems(job, [item]);
  }

  async completeItems(
    job: StoredJob,
    items: NormalizedPublicItem[],
  ): Promise<StoredJob> {
    if (
      items.length > 40 ||
      new Set(items.map((item) => item.externalItemKey ?? "page")).size !==
        items.length
    )
      throw new Error("连接器返回的条目数量或身份无效。");
    for (const item of items)
      if (
        !StableIdSchema.safeParse(item.externalItemKey ?? "page").success ||
        !CoverageSchema.safeParse(item.coverage).success ||
        !Number.isFinite(Date.parse(item.observedAt)) ||
        (item.publishedAt !== undefined &&
          !Number.isFinite(Date.parse(item.publishedAt))) ||
        !HttpUrlSchema.safeParse(item.canonicalUrl).success ||
        !item.title.trim() ||
        item.title.length > 500 ||
        !item.content.trim() ||
        Buffer.byteLength(item.content) > MAX_ITEM_CONTENT_BYTES ||
        !ContentHashSchema.safeParse(item.contentHash).success ||
        hash(item.content) !== item.contentHash
      )
        throw new Error("连接器返回的条目不符合修订契约。");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (!job.leaseToken) throw new JobLeaseLostError();
      // Lock the follow before the run, matching deleteSourceFollow's lock
      // order. If an unfollow committed while the connector was fetching,
      // its running job now has follow_id = NULL and must not emit Radar data.
      const lockedFollow = job.followId
        ? await client.query<{ id: string }>(
            `SELECT id FROM source_follow
             WHERE tenant_id = $1 AND id = $2
             FOR UPDATE`,
            [job.tenantId, job.followId],
          )
        : undefined;
      const lease = await client.query<{ follow_id: string | null }>(
        `SELECT follow_id FROM fetch_run
         WHERE tenant_id = $1 AND id = $2 AND status = 'running'
           AND attempt = $3 AND lease_token = $4
           AND locked_until > clock_timestamp()
         FOR UPDATE`,
        [job.tenantId, job.id, job.attempt, job.leaseToken],
      );
      if (!lease.rowCount) throw new JobLeaseLostError();
      const currentFollowId = lease.rows[0]!.follow_id;
      const deliveryFollowId =
        currentFollowId && lockedFollow?.rows[0]?.id === currentFollowId
          ? currentFollowId
          : undefined;
      // Changes for one tenant must be assigned and committed in the same order.
      // PostgreSQL sequences alone do not provide commit ordering, so without
      // this lock a cursor could advance past an earlier uncommitted change.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`${job.tenantId}:delivery-change-order`],
      );
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`${job.tenantId}:source-item:${job.sourceId}`],
      );
      let resultItemId: string | undefined;
      let resultRevisionId: string | undefined;
      for (const item of items) {
        const externalItemKey = item.externalItemKey ?? "page";
        const existingItem = await client.query<{
          id: string;
          canonical_url: string;
          title: string;
          latest_revision_id: string | null;
          latest_content_hash: string | null;
          latest_observed_at: string | Date | null;
          latest_coverage: string | null;
          published_at: string | Date | null;
          latest_missing: unknown;
        }>(
          `SELECT i.id, i.canonical_url, i.title, i.latest_revision_id,
                r.content_hash AS latest_content_hash,
                r.observed_at AS latest_observed_at,
                r.published_at,
                r.coverage AS latest_coverage,
                r.missing AS latest_missing
         FROM source_item i
         LEFT JOIN item_revision r
           ON r.tenant_id = i.tenant_id AND r.id = i.latest_revision_id
         WHERE i.tenant_id = $1 AND i.source_id = $2
           AND i.external_item_key = $3
         FOR UPDATE OF i`,
          [job.tenantId, job.sourceId, externalItemKey],
        );
        const currentItem = existingItem.rows[0];
        const itemId = currentItem?.id || randomUUID();
        if (!existingItem.rowCount)
          await client.query(
            `INSERT INTO source_item(
             id, tenant_id, source_id, external_item_key, canonical_url, title
           ) VALUES ($1, $2, $3, $6, $4, $5)`,
            [
              itemId,
              job.tenantId,
              job.sourceId,
              item.canonicalUrl,
              item.title,
              externalItemKey,
            ],
          );
        const contentChanged =
          !currentItem || currentItem.latest_content_hash !== item.contentHash;
        const metadataChanged =
          !currentItem ||
          currentItem.canonical_url !== item.canonicalUrl ||
          currentItem.title !== item.title;
        const changed =
          contentChanged ||
          metadataChanged ||
          currentItem?.latest_coverage !== item.coverage ||
          (currentItem?.published_at
            ? iso(currentItem.published_at)
            : undefined) !== item.publishedAt ||
          JSON.stringify(currentItem?.latest_missing) !==
            JSON.stringify(item.missing);
        const revisionId = changed
          ? randomUUID()
          : currentItem.latest_revision_id!;
        const priorDelivery = deliveryFollowId
          ? await one<{ has_prior: boolean; revision_delivered: boolean }>(
              client,
              `SELECT
               EXISTS(
                 SELECT 1 FROM delivery_change
                 WHERE tenant_id = $1 AND follow_id = $2 AND item_id = $3
               ) AS has_prior,
               EXISTS(
                 SELECT 1 FROM delivery_change
                 WHERE tenant_id = $1 AND follow_id = $2 AND revision_id = $4
               ) AS revision_delivered`,
              [job.tenantId, deliveryFollowId, itemId, revisionId],
            )
          : undefined;
        if (changed) {
          await client.query(
            `INSERT INTO item_revision(
             id, tenant_id, item_id, observed_at, content_hash,
             coverage, missing, content, published_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
            [
              revisionId,
              job.tenantId,
              itemId,
              item.observedAt,
              item.contentHash,
              item.coverage,
              JSON.stringify(item.missing),
              item.content,
              item.publishedAt ?? null,
            ],
          );
        }
        if (deliveryFollowId && !priorDelivery?.revision_delivered)
          await client.query(
            `INSERT INTO delivery_change(
             tenant_id, change_type, source_id, follow_id, item_id, revision_id,
             observed_at, content_hash, coverage, missing
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
            [
              job.tenantId,
              priorDelivery?.has_prior ? "item.revised" : "item.created",
              job.sourceId,
              deliveryFollowId,
              itemId,
              revisionId,
              changed ? item.observedAt : currentItem.latest_observed_at,
              changed ? item.contentHash : currentItem.latest_content_hash,
              changed ? item.coverage : currentItem.latest_coverage,
              JSON.stringify(
                changed ? item.missing : currentItem.latest_missing || [],
              ),
            ],
          );
        await client.query(
          `UPDATE source_item SET
           canonical_url = $3, title = $4, latest_revision_id = $5, updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
          [job.tenantId, itemId, item.canonicalUrl, item.title, revisionId],
        );
        resultItemId ??= itemId;
        resultRevisionId ??= revisionId;
      }
      const completed = await one<Record<string, unknown>>(
        client,
        `UPDATE fetch_run SET
         status = 'succeeded', item_id = $3, revision_id = $4, item_count = $7,
           locked_until = NULL, lease_token = NULL,
           error_code = NULL, error_message = NULL, error_retryable = NULL,
           updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND status = 'running'
           AND attempt = $5 AND lease_token = $6
         RETURNING *`,
        [
          job.tenantId,
          job.id,
          resultItemId ?? null,
          resultRevisionId ?? null,
          job.attempt,
          job.leaseToken,
          items.length,
        ],
      );
      if (deliveryFollowId)
        await client.query(
          `UPDATE source_follow SET
             last_success_at = $3,
             last_error_code = NULL,
             last_error_message = NULL,
             last_error_retryable = NULL,
             updated_at = now()
           WHERE tenant_id = $1 AND id = $2`,
          [
            job.tenantId,
            deliveryFollowId,
            items[0]?.observedAt ?? new Date().toISOString(),
          ],
        );
      await client.query("COMMIT");
      return jobFromRow(completed);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async changes(
    tenantId: string,
    after: bigint,
    limit: number,
  ): Promise<{ rows: Array<Record<string, unknown>>; hasMore: boolean }> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM delivery_change
       WHERE tenant_id = $1 AND sequence > $2
       ORDER BY sequence ASC LIMIT $3`,
      [tenantId, after.toString(), limit + 1],
    );
    return {
      rows: result.rows.slice(0, limit),
      hasMore: result.rows.length > limit,
    };
  }

  async revision(
    tenantId: string,
    itemId: string,
    revisionId: string,
  ): Promise<Record<string, unknown> | undefined> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT
         i.id AS item_id, i.source_id, i.external_item_key,
         i.canonical_url, i.title,
         r.id AS revision_id, r.observed_at, r.published_at, r.content_hash,
         r.coverage, r.missing, r.content
       FROM source_item i
       JOIN item_revision r
         ON r.tenant_id = i.tenant_id AND r.item_id = i.id
       WHERE i.tenant_id = $1 AND i.id = $2 AND r.id = $3`,
      [tenantId, itemId, revisionId],
    );
    return result.rows[0];
  }
}

export class IdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_CONFLICT";
  constructor() {
    super("同一个 Idempotency-Key 不能用于不同的写入请求。");
  }
}

export class NotFoundError extends Error {
  readonly code = "NOT_FOUND";
  constructor() {
    super("请求的资源不存在。");
  }
}

export class ConflictError extends Error {
  readonly code = "CONFLICT";
  constructor(message = "请求与当前资源状态冲突。") {
    super(message);
  }
}

export class JobLeaseLostError extends Error {
  readonly code = "SOURCE_WORKER_LEASE_LOST";
  constructor() {
    super("刷新作业的 worker 租约已失效。");
  }
}

export class PairingReplayExpiredError extends Error {
  readonly code = "PAIRING_REPLAY_EXPIRED";
  constructor() {
    super("配对令牌签名已轮换，请使用新的幂等键重新配对。");
  }
}

export const requestDigest = (value: unknown) => hash(JSON.stringify(value));
