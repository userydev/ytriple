import { normalizeTeamSettings } from "../shared/member-settings.js";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import type {
  AppSettings,
  LibraryEntry,
  LibraryFeedback,
  ModelProfile,
  RadarDigest,
  RadarDigestPublicationInput,
  RadarDigestionRun,
  RadarDisposition,
  RadarEvent,
  RadarFollow,
  RadarItem,
  RadarRecommendedSource,
  RemoteSourceDeliveryPage,
  RemoteSourceIdentity,
  Source,
  Task,
  TaskEvent,
} from "../shared/types.js";

export const now = () => new Date().toISOString();
export const uid = () => randomUUID();

const LEGACY_SOURCE_INBOX_TITLE = "信息源收件箱";
const LEGACY_SOURCE_INBOX_GOAL =
  "接收信息源服务同步的资料，并由团队筛选、理解和整理为可复用内容。";
const RADAR_IDENTITY_CONFIG_KEY = "radar.source_identity";

function radarItemId(identity: RemoteSourceIdentity, itemId: string): string {
  return `radar_${createHash("sha256")
    .update(`${identity.serverInstanceId}\0${identity.tenantId}\0${itemId}`)
    .digest("hex")}`;
}

function sameStoredSource(left: Source, right: Source): boolean {
  if (left.library || right.library)
    return (
      !!left.library &&
      !!right.library &&
      !left.library.supersededAt &&
      !right.library.supersededAt &&
      left.library.root === right.library.root &&
      left.library.entryId === right.library.entryId &&
      left.library.hash === right.library.hash &&
      left.library.feedbackRevision === right.library.feedbackRevision &&
      left.library.selection === right.library.selection
    );
  if (left.remote || right.remote)
    return (
      !!left.remote &&
      !!right.remote &&
      left.remote.serverInstanceId === right.remote.serverInstanceId &&
      left.remote.tenantId === right.remote.tenantId &&
      left.remote.sourceId === right.remote.sourceId &&
      left.remote.itemId === right.remote.itemId &&
      left.remote.revisionId === right.remote.revisionId
    );
  return left.location === right.location && left.text === right.text;
}

function stableJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJSON(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function requireDigestText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label}不能为空。`);
  return normalized;
}

function digestionRecordId(prefix: string, operationId: string, index: number) {
  return `${prefix}_${createHash("sha256")
    .update(`${operationId}\0${index}`)
    .digest("hex")}`;
}

function isSourceCoverageLevel(value: unknown): boolean {
  return (
    value === "listing" ||
    value === "metadata" ||
    value === "fulltext" ||
    value === "transcript" ||
    value === "vision"
  );
}

interface SourceReadRange {
  start: number;
  end: number;
  totalCharacters: number;
}

function recordedSourceReads(
  task: Task,
  goalVersion: number,
): Map<string, SourceReadRange[]> {
  const reads = new Map<string, SourceReadRange[]>();
  for (const event of task.events) {
    const data = event.data;
    if (
      event.goalVersion !== goalVersion ||
      event.type !== "tool_completed" ||
      data?.tool !== "read_source" ||
      typeof data.sourceId !== "string" ||
      !Number.isInteger(data.readStart) ||
      !Number.isInteger(data.readEnd) ||
      !Number.isInteger(data.totalCharacters)
    )
      continue;
    const range = {
      start: data.readStart as number,
      end: data.readEnd as number,
      totalCharacters: data.totalCharacters as number,
    };
    if (
      range.start < 0 ||
      range.end <= range.start ||
      range.totalCharacters < range.end
    )
      continue;
    const sourceReads = reads.get(data.sourceId) ?? [];
    sourceReads.push(range);
    reads.set(data.sourceId, sourceReads);
  }
  return reads;
}

function sourceReadState(
  reads: Map<string, SourceReadRange[]>,
  sourceId: string,
  totalCharacters: number,
): { nonEmpty: boolean; full: boolean; readCharacters: number } {
  const ranges = (reads.get(sourceId) ?? [])
    .filter(
      (range) =>
        range.totalCharacters === totalCharacters &&
        range.start >= 0 &&
        range.end > range.start &&
        range.end <= totalCharacters,
    )
    .sort((left, right) => left.start - right.start || left.end - right.end);
  if (!ranges.length)
    return { nonEmpty: false, full: false, readCharacters: 0 };
  let coveredStart = ranges[0]!.start;
  let coveredEnd = ranges[0]!.end;
  let readCharacters = 0;
  for (const range of ranges.slice(1)) {
    if (range.start > coveredEnd) {
      readCharacters += coveredEnd - coveredStart;
      coveredStart = range.start;
      coveredEnd = range.end;
    } else coveredEnd = Math.max(coveredEnd, range.end);
  }
  readCharacters += coveredEnd - coveredStart;
  const full =
    totalCharacters > 0 &&
    ranges[0]!.start === 0 &&
    ranges.reduce((cursor, range) => {
      if (range.start > cursor) return cursor;
      return Math.max(cursor, range.end);
    }, 0) >= totalCharacters;
  return { nonEmpty: true, full, readCharacters };
}

export class Store {
  readonly db: DatabaseSync;
  constructor(readonly dataPath: string) {
    mkdirSync(dataPath, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(dataPath, "workbench.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deleted_task_ids (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS checkpoints (task_id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS library_entries (id TEXT PRIMARY KEY, root TEXT NOT NULL, collection_key TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(root, collection_key));
      CREATE TABLE IF NOT EXISTS library_feedback (id TEXT PRIMARY KEY, root TEXT NOT NULL, entry_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS library_feedback_entry ON library_feedback(root, entry_id);
      CREATE TABLE IF NOT EXISTS library_operations (id TEXT PRIMARY KEY, root TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS remote_source_revisions (
        server_instance_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        body TEXT NOT NULL,
        received_at TEXT NOT NULL,
        PRIMARY KEY(server_instance_id, tenant_id, item_id, revision_id)
      );
      CREATE TABLE IF NOT EXISTS remote_source_cursors (
        server_instance_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        cursor TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(server_instance_id, tenant_id)
      );
      CREATE TABLE IF NOT EXISTS remote_source_inboxes (
        server_instance_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        task_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        PRIMARY KEY(server_instance_id, tenant_id)
      );
      CREATE TABLE IF NOT EXISTS radar_items (
        radar_id TEXT NOT NULL UNIQUE,
        server_instance_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        follow_id TEXT,
        item_id TEXT NOT NULL,
        latest_revision_id TEXT NOT NULL,
        first_received_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        read_at TEXT,
        archived_at TEXT,
        origin TEXT NOT NULL DEFAULT 'server',
        source_title TEXT,
        category TEXT,
        PRIMARY KEY(server_instance_id, tenant_id, item_id)
      );
      CREATE TABLE IF NOT EXISTS radar_follows (
        server_instance_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        follow_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        body TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY(server_instance_id, tenant_id, follow_id)
      );
      CREATE TABLE IF NOT EXISTS radar_recommended_sources (
        server_instance_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        recommended_source_id TEXT NOT NULL,
        body TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY(server_instance_id, tenant_id, recommended_source_id)
      );
      CREATE TABLE IF NOT EXISTS radar_events (
        id TEXT PRIMARY KEY,
        server_instance_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS digest_runs (
        id TEXT PRIMARY KEY,
        server_instance_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        task_id TEXT NOT NULL UNIQUE,
        goal_version INTEGER NOT NULL,
        state TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        published_at TEXT
      );
      CREATE INDEX IF NOT EXISTS digest_runs_identity
        ON digest_runs(server_instance_id, tenant_id, created_at);
      CREATE TABLE IF NOT EXISTS digests (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        server_instance_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        body TEXT NOT NULL,
        published_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS digests_identity
        ON digests(server_instance_id, tenant_id, published_at);
      CREATE TABLE IF NOT EXISTS dispositions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        server_instance_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        body TEXT NOT NULL,
        published_at TEXT NOT NULL,
        UNIQUE(run_id, source_id)
      );
      CREATE INDEX IF NOT EXISTS dispositions_identity
        ON dispositions(server_instance_id, tenant_id, published_at);
      CREATE TABLE IF NOT EXISTS publications (
        operation_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL,
        goal_version INTEGER NOT NULL,
        input_hash TEXT NOT NULL,
        body TEXT NOT NULL,
        published_at TEXT NOT NULL
      );`);
    this.migrateRadarItemIds();
    for (const task of this.tasks()) {
      let changed = false;
      // A deletion in earlier versions now has the same permanent meaning.
      // Archived conversations remain recoverable; independent files and Lib stay intact.
      if (task.deletedAt) {
        this.deleteTask(task.id);
        continue;
      }
      if (task.status === "running" || task.status === "waiting") {
        task.status = "paused";
        task.events.push({
          id: uid(),
          type: "recovered",
          summary: "上次工作中断。已保留成果与记录，可以继续。",
          createdAt: now(),
          goalVersion: task.goalVersion,
        });
        changed = true;
      }
      if (changed) this.saveTask(task);
      for (const source of task.sources) this.recordRemoteRevision(source);
    }
    this.migrateLegacySourceInboxes();
  }
  private migrateRadarItemIds(): void {
    const columns = this.db.prepare("PRAGMA table_info(radar_items)").all() as {
      name: string;
    }[];
    const names = new Set(columns.map((column) => column.name));
    if (
      !names.has("radar_id") ||
      !names.has("origin") ||
      !names.has("source_title") ||
      !names.has("category") ||
      !names.has("follow_id")
    ) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (!names.has("radar_id")) {
          this.db.exec("ALTER TABLE radar_items ADD COLUMN radar_id TEXT");
          const rows = this.db
            .prepare(
              `SELECT server_instance_id, tenant_id, item_id FROM radar_items`,
            )
            .all() as {
            server_instance_id: string;
            tenant_id: string;
            item_id: string;
          }[];
          for (const row of rows)
            this.db
              .prepare(
                `UPDATE radar_items SET radar_id=?
                 WHERE server_instance_id=? AND tenant_id=? AND item_id=?`,
              )
              .run(
                radarItemId(
                  {
                    serverInstanceId: row.server_instance_id,
                    tenantId: row.tenant_id,
                  },
                  row.item_id,
                ),
                row.server_instance_id,
                row.tenant_id,
                row.item_id,
              );
        }
        if (!names.has("origin"))
          this.db.exec(
            "ALTER TABLE radar_items ADD COLUMN origin TEXT NOT NULL DEFAULT 'server'",
          );
        if (!names.has("source_title"))
          this.db.exec("ALTER TABLE radar_items ADD COLUMN source_title TEXT");
        if (!names.has("category"))
          this.db.exec("ALTER TABLE radar_items ADD COLUMN category TEXT");
        if (!names.has("follow_id"))
          this.db.exec("ALTER TABLE radar_items ADD COLUMN follow_id TEXT");
        this.db.exec(
          "CREATE UNIQUE INDEX IF NOT EXISTS radar_items_radar_id ON radar_items(radar_id)",
        );
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }
  hasTask(id: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM tasks WHERE id=?").get(id));
  }
  /** Remove conversation records atomically; independently saved files and Lib entries remain. */
  deleteTask(id: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT OR IGNORE INTO deleted_task_ids(id) VALUES(?)")
        .run(id);
      this.db.prepare("DELETE FROM checkpoints WHERE task_id=?").run(id);
      this.db.prepare("DELETE FROM operations WHERE task_id=?").run(id);
      this.db
        .prepare("DELETE FROM remote_source_inboxes WHERE task_id=?")
        .run(id);
      this.db.prepare("DELETE FROM tasks WHERE id=?").run(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  tasks(): Task[] {
    return (
      this.db.prepare("SELECT body FROM tasks").all() as { body: string }[]
    )
      .map((row) => JSON.parse(row.body) as Task)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  task(id: string): Task {
    const row = this.db.prepare("SELECT body FROM tasks WHERE id=?").get(id) as
      { body: string } | undefined;
    if (!row) throw new Error("找不到这项工作。");
    return JSON.parse(row.body) as Task;
  }
  saveTask(task: Task): void {
    if (
      this.db.prepare("SELECT 1 FROM deleted_task_ids WHERE id=?").get(task.id)
    )
      throw new Error("这项工作已永久删除，不能重新写入。");
    const stored = structuredClone(task);
    for (const artifact of stored.artifacts) {
      delete artifact.content;
      delete artifact.readError;
    }
    stored.updatedAt = now();
    this.db
      .prepare(
        "INSERT INTO tasks(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(task.id, JSON.stringify(stored));
  }
  updateTask(id: string, update: (task: Task) => void): Task {
    const task = this.task(id);
    update(task);
    this.saveTask(task);
    return task;
  }
  hasTaskSource(id: string, source: Source): boolean {
    return this.task(id).sources.some((entry) =>
      sameStoredSource(entry, source),
    );
  }
  private insertRemoteRevision(source: Source): boolean {
    const remote = source.remote;
    if (!remote?.tenantId) return false;
    if (
      createHash("sha256").update(source.text).digest("hex") !==
      remote.contentHash
    )
      throw new Error("远端资料正文与内容哈希不一致。");
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO remote_source_revisions(
           server_instance_id, tenant_id, source_id, item_id, revision_id,
           body, received_at
         ) VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        remote.serverInstanceId,
        remote.tenantId,
        remote.sourceId,
        remote.itemId,
        remote.revisionId,
        JSON.stringify(source),
        now(),
      );
    if (Number(result.changes) === 1) return true;
    const row = this.db
      .prepare(
        `SELECT body FROM remote_source_revisions
         WHERE server_instance_id=? AND tenant_id=?
           AND item_id=? AND revision_id=?`,
      )
      .get(
        remote.serverInstanceId,
        remote.tenantId,
        remote.itemId,
        remote.revisionId,
      ) as { body: string } | undefined;
    let existing: Source;
    try {
      if (!row) throw new Error("missing revision");
      existing = JSON.parse(row.body) as Source;
    } catch {
      throw new Error("本机远端修订记录已损坏。");
    }
    if (
      !sameStoredSource(existing, source) ||
      existing.text !== source.text ||
      existing.remote?.contentHash !== remote.contentHash ||
      existing.remote?.observedAt !== remote.observedAt ||
      existing.remote?.coverageLevel !== remote.coverageLevel ||
      JSON.stringify(existing.remote?.missing) !==
        JSON.stringify(remote.missing)
    )
      throw new Error("同一远端 revision 返回了冲突内容，已拒绝推进游标。");
    return false;
  }
  private upsertRadarItem(
    source: Source,
    receivedAt = now(),
  ): "item.received" | "item.revised" | undefined {
    const remote = source.remote;
    if (!remote?.tenantId)
      throw new Error("Radar 只能接收带完整远端身份的资料。");
    const identity: RemoteSourceIdentity = {
      serverInstanceId: remote.serverInstanceId,
      tenantId: remote.tenantId,
    };
    const follows = this.radarFollows(identity);
    const follow = remote.followId
      ? follows.find((candidate) => candidate.id === remote.followId)
      : (follows.find(
          (candidate) =>
            candidate.sourceId === remote.sourceId &&
            candidate.origin === "user",
        ) ??
        follows.find((candidate) => candidate.sourceId === remote.sourceId));
    const existing = this.db
      .prepare(
        `SELECT latest_revision_id FROM radar_items
         WHERE server_instance_id=? AND tenant_id=? AND item_id=?`,
      )
      .get(remote.serverInstanceId, remote.tenantId, remote.itemId) as
      { latest_revision_id: string } | undefined;
    const incomingFollowId = follow?.id ?? remote.followId;
    const incomingOrigin = follow?.origin ?? "server";
    if (existing) {
      this.promoteRadarItemFollow(
        identity,
        remote.itemId,
        incomingFollowId,
        incomingOrigin,
        follow?.name,
        follow?.category,
      );
      if (existing.latest_revision_id === remote.revisionId) return undefined;
      this.db
        .prepare(
          `UPDATE radar_items
           SET source_id=?, latest_revision_id=?, received_at=?,
               read_at=NULL, archived_at=NULL
           WHERE server_instance_id=? AND tenant_id=? AND item_id=?`,
        )
        .run(
          remote.sourceId,
          remote.revisionId,
          receivedAt,
          identity.serverInstanceId,
          identity.tenantId,
          remote.itemId,
        );
      return "item.revised";
    }
    this.db
      .prepare(
        `INSERT INTO radar_items(
           radar_id, server_instance_id, tenant_id, source_id, follow_id, item_id,
           latest_revision_id, first_received_at, received_at, read_at,
           archived_at, origin, source_title, category
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        radarItemId(
          {
            serverInstanceId: remote.serverInstanceId,
            tenantId: remote.tenantId,
          },
          remote.itemId,
        ),
        remote.serverInstanceId,
        remote.tenantId,
        remote.sourceId,
        incomingFollowId ?? null,
        remote.itemId,
        remote.revisionId,
        receivedAt,
        receivedAt,
        null,
        null,
        incomingOrigin,
        follow?.name ?? null,
        follow?.category ?? null,
      );
    return "item.received";
  }
  private promoteRadarItemFollow(
    identity: RemoteSourceIdentity,
    itemId: string,
    followId: string | undefined,
    origin: RadarItem["origin"],
    sourceTitle?: string,
    category?: string,
  ): void {
    this.db
      .prepare(
        `UPDATE radar_items
         SET follow_id=?, origin=?,
             source_title=COALESCE(?, source_title),
             category=COALESCE(?, category)
         WHERE server_instance_id=? AND tenant_id=? AND item_id=?
           AND (
             follow_id IS NULL OR follow_id=? OR origin='server' OR
             (origin='recommended' AND ?='user')
           )`,
      )
      .run(
        followId ?? null,
        origin,
        sourceTitle ?? null,
        category ?? null,
        identity.serverInstanceId,
        identity.tenantId,
        itemId,
        followId ?? null,
        origin,
      );
  }
  private migrateLegacySourceInboxes(): void {
    const rows = this.db
      .prepare(
        `SELECT server_instance_id, tenant_id, task_id
         FROM remote_source_inboxes`,
      )
      .all() as {
      server_instance_id: string;
      tenant_id: string;
      task_id: string;
    }[];
    for (const row of rows) {
      if (!this.hasTask(row.task_id)) {
        this.db
          .prepare("DELETE FROM remote_source_inboxes WHERE task_id=?")
          .run(row.task_id);
        continue;
      }
      const task = this.task(row.task_id);
      const untouched =
        task.title === LEGACY_SOURCE_INBOX_TITLE &&
        task.goal === LEGACY_SOURCE_INBOX_GOAL &&
        task.kind === "research" &&
        task.member === "coordinator" &&
        task.status === "idle" &&
        !task.projectId &&
        !task.profileId &&
        !task.archivedAt &&
        task.messages.length === 1 &&
        task.messages[0]?.role === "user" &&
        task.messages[0].content === LEGACY_SOURCE_INBOX_GOAL &&
        task.artifacts.length === 0 &&
        task.sources.every(
          (source) =>
            source.remote?.serverInstanceId === row.server_instance_id &&
            source.remote.tenantId === row.tenant_id,
        ) &&
        task.events.every((event) => event.type === "source.received");
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (untouched) {
          for (const source of task.sources) {
            this.insertRemoteRevision(source);
            this.upsertRadarItem(source, source.addedAt);
          }
          this.db
            .prepare("INSERT OR IGNORE INTO deleted_task_ids(id) VALUES(?)")
            .run(task.id);
          this.db
            .prepare("DELETE FROM checkpoints WHERE task_id=?")
            .run(task.id);
          this.db
            .prepare("DELETE FROM operations WHERE task_id=?")
            .run(task.id);
          this.db.prepare("DELETE FROM tasks WHERE id=?").run(task.id);
        }
        // Modified legacy inboxes remain as ordinary user-owned tasks, but no
        // future delivery is routed into them.
        this.db
          .prepare("DELETE FROM remote_source_inboxes WHERE task_id=?")
          .run(task.id);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }
  recordRemoteRevision(source: Source): void {
    this.insertRemoteRevision(source);
  }
  hasRemoteRevision(source: Source): boolean {
    const remote = source.remote;
    if (!remote?.tenantId) return false;
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM remote_source_revisions
           WHERE server_instance_id=? AND tenant_id=?
             AND item_id=? AND revision_id=?`,
        )
        .get(
          remote.serverInstanceId,
          remote.tenantId,
          remote.itemId,
          remote.revisionId,
        ),
    );
  }
  remoteSourceCursor(identity: RemoteSourceIdentity): string | undefined {
    const row = this.db
      .prepare(
        `SELECT cursor FROM remote_source_cursors
         WHERE server_instance_id=? AND tenant_id=?`,
      )
      .get(identity.serverInstanceId, identity.tenantId) as
      { cursor: string } | undefined;
    return row?.cursor;
  }
  radarIdentity(): RemoteSourceIdentity | undefined {
    const row = this.db
      .prepare("SELECT body FROM config WHERE key=?")
      .get(RADAR_IDENTITY_CONFIG_KEY) as { body: string } | undefined;
    if (!row) return undefined;
    try {
      const value = JSON.parse(row.body) as Partial<RemoteSourceIdentity>;
      if (
        typeof value.serverInstanceId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          value.serverInstanceId,
        ) ||
        typeof value.tenantId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value.tenantId)
      )
        return undefined;
      return {
        serverInstanceId: value.serverInstanceId,
        tenantId: value.tenantId,
      };
    } catch {
      return undefined;
    }
  }
  saveRadarIdentity(identity: RemoteSourceIdentity): void {
    this.setConfig(RADAR_IDENTITY_CONFIG_KEY, identity);
  }
  commitTaskSource(id: string, source: Source): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const task = this.task(id);
      this.insertRemoteRevision(source);
      if (task.sources.some((entry) => sameStoredSource(entry, source))) {
        this.db.exec("COMMIT");
        return false;
      }
      task.goalVersion++;
      task.sources.push(source);
      task.status = "idle";
      task.error = undefined;
      task.events.push({
        id: uid(),
        type: "source.imported",
        summary: `已导入资料：${source.title}`,
        goalVersion: task.goalVersion,
        createdAt: now(),
      });
      this.saveTask(task);
      this.db.prepare("DELETE FROM checkpoints WHERE task_id=?").run(id);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  commitRemoteSourcePage(page: RemoteSourceDeliveryPage): { added: number } {
    for (const source of page.sources) {
      const remote = source.remote;
      if (
        !remote ||
        remote.serverInstanceId !== page.serverInstanceId ||
        remote.tenantId !== page.tenantId
      )
        throw new Error("远端资料与同步页的服务身份不一致。");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let added = 0;
      for (const source of page.sources) {
        this.insertRemoteRevision(source);
        const eventType = this.upsertRadarItem(source);
        if (eventType) {
          added++;
          this.appendRadarEvent(page, {
            id: uid(),
            type: eventType,
            summary:
              eventType === "item.received"
                ? `Radar 收到：${source.title}`
                : `Radar 更新：${source.title}`,
            createdAt: now(),
            itemId: radarItemId(page, source.remote!.itemId),
          });
        }
      }
      this.db
        .prepare(
          `INSERT INTO remote_source_cursors(
             server_instance_id, tenant_id, cursor, updated_at
           ) VALUES(?,?,?,?)
           ON CONFLICT(server_instance_id, tenant_id)
           DO UPDATE SET cursor=excluded.cursor, updated_at=excluded.updated_at`,
        )
        .run(page.serverInstanceId, page.tenantId, page.nextCursor, now());
      this.saveRadarIdentity(page);
      this.db.exec("COMMIT");
      return { added };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  appendRadarEvent(identity: RemoteSourceIdentity, event: RadarEvent): void {
    this.db
      .prepare(
        `INSERT INTO radar_events(
           id, server_instance_id, tenant_id, body, created_at
         ) VALUES(?,?,?,?,?)`,
      )
      .run(
        event.id,
        identity.serverInstanceId,
        identity.tenantId,
        JSON.stringify(event),
        event.createdAt,
      );
  }
  radarEvents(identity: RemoteSourceIdentity): RadarEvent[] {
    const rows = this.db
      .prepare(
        `SELECT body FROM radar_events
         WHERE server_instance_id=? AND tenant_id=?
         ORDER BY created_at DESC, rowid DESC LIMIT 200`,
      )
      .all(identity.serverInstanceId, identity.tenantId) as { body: string }[];
    return rows.map((row) => JSON.parse(row.body) as RadarEvent);
  }
  replaceRadarCatalog(
    identity: RemoteSourceIdentity,
    follows: RadarFollow[],
    recommendedSources: RadarRecommendedSource[],
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "DELETE FROM radar_follows WHERE server_instance_id=? AND tenant_id=?",
        )
        .run(identity.serverInstanceId, identity.tenantId);
      this.db
        .prepare(
          `DELETE FROM radar_recommended_sources
           WHERE server_instance_id=? AND tenant_id=?`,
        )
        .run(identity.serverInstanceId, identity.tenantId);
      for (const follow of follows) this.insertRadarFollow(identity, follow);
      for (const source of recommendedSources)
        this.db
          .prepare(
            `INSERT INTO radar_recommended_sources(
               server_instance_id, tenant_id, recommended_source_id,
               body, fetched_at
             ) VALUES(?,?,?,?,?)`,
          )
          .run(
            identity.serverInstanceId,
            identity.tenantId,
            source.id,
            JSON.stringify(source),
            now(),
          );
      this.saveRadarIdentity(identity);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  saveRadarFollow(identity: RemoteSourceIdentity, follow: RadarFollow): void {
    this.insertRadarFollow(identity, follow);
  }
  private insertRadarFollow(
    identity: RemoteSourceIdentity,
    follow: RadarFollow,
  ): void {
    this.db
      .prepare(
        `INSERT INTO radar_follows(
           server_instance_id, tenant_id, follow_id, source_id, body, fetched_at
         ) VALUES(?,?,?,?,?,?)
         ON CONFLICT(server_instance_id, tenant_id, follow_id) DO UPDATE SET
           source_id=excluded.source_id,
           body=excluded.body,
           fetched_at=excluded.fetched_at`,
      )
      .run(
        identity.serverInstanceId,
        identity.tenantId,
        follow.id,
        follow.sourceId,
        JSON.stringify(follow),
        now(),
      );
    const items = this.db
      .prepare(
        `SELECT item_id FROM radar_items
         WHERE server_instance_id=? AND tenant_id=? AND source_id=?`,
      )
      .all(identity.serverInstanceId, identity.tenantId, follow.sourceId) as {
      item_id: string;
    }[];
    for (const item of items)
      this.promoteRadarItemFollow(
        identity,
        item.item_id,
        follow.id,
        follow.origin,
        follow.name,
        follow.category,
      );
  }
  removeRadarFollow(identity: RemoteSourceIdentity, followId: string): void {
    this.db
      .prepare(
        `DELETE FROM radar_follows
         WHERE server_instance_id=? AND tenant_id=? AND follow_id=?`,
      )
      .run(identity.serverInstanceId, identity.tenantId, followId);
  }
  radarFollows(identity: RemoteSourceIdentity): RadarFollow[] {
    const rows = this.db
      .prepare(
        `SELECT body FROM radar_follows
         WHERE server_instance_id=? AND tenant_id=?
         ORDER BY fetched_at DESC`,
      )
      .all(identity.serverInstanceId, identity.tenantId) as { body: string }[];
    return rows.map((row) => JSON.parse(row.body) as RadarFollow);
  }
  radarRecommendedSources(
    identity: RemoteSourceIdentity,
  ): RadarRecommendedSource[] {
    const rows = this.db
      .prepare(
        `SELECT body FROM radar_recommended_sources
         WHERE server_instance_id=? AND tenant_id=?
         ORDER BY fetched_at DESC`,
      )
      .all(identity.serverInstanceId, identity.tenantId) as { body: string }[];
    return rows.map((row) => JSON.parse(row.body) as RadarRecommendedSource);
  }
  radarLastSyncAt(identity: RemoteSourceIdentity): string | undefined {
    const row = this.db
      .prepare(
        `SELECT MAX(updated_at) AS updated_at FROM remote_source_cursors
         WHERE server_instance_id=? AND tenant_id=?`,
      )
      .get(identity.serverInstanceId, identity.tenantId) as
      { updated_at: string | null } | undefined;
    return row?.updated_at ?? undefined;
  }
  radarItems(identity: RemoteSourceIdentity): RadarItem[] {
    const rows = this.db
      .prepare(
        `SELECT i.radar_id, i.server_instance_id, i.tenant_id, i.source_id,
                i.follow_id, i.item_id,
                i.latest_revision_id, i.received_at, i.read_at, i.archived_at,
                i.origin, i.source_title, i.category,
                r.body,
                (SELECT COUNT(*) FROM remote_source_revisions rr
                  WHERE rr.server_instance_id=i.server_instance_id
                    AND rr.tenant_id=i.tenant_id
                    AND rr.item_id=i.item_id) AS revision_count
         FROM radar_items i
         JOIN remote_source_revisions r
           ON r.server_instance_id=i.server_instance_id
          AND r.tenant_id=i.tenant_id
          AND r.item_id=i.item_id
          AND r.revision_id=i.latest_revision_id
         WHERE i.server_instance_id=? AND i.tenant_id=?
         ORDER BY i.received_at DESC`,
      )
      .all(identity.serverInstanceId, identity.tenantId) as {
      server_instance_id: string;
      radar_id: string;
      tenant_id: string;
      source_id: string;
      follow_id: string | null;
      item_id: string;
      latest_revision_id: string;
      received_at: string;
      read_at: string | null;
      archived_at: string | null;
      origin: string;
      source_title: string | null;
      category: string | null;
      body: string;
      revision_count: number;
    }[];
    const follows = this.radarFollows(identity);
    const recommended = this.radarRecommendedSources(identity);
    const followBySource = new Map<string, RadarFollow>();
    for (const follow of follows) {
      const existing = followBySource.get(follow.sourceId);
      if (!existing || follow.origin === "user")
        followBySource.set(follow.sourceId, follow);
    }
    const followById = new Map(follows.map((follow) => [follow.id, follow]));
    const recommendedById = new Map(
      recommended.map((source) => [source.id, source]),
    );
    const references = new Map<
      string,
      { taskIds: string[]; sourceAssetIds: string[] }
    >();
    for (const task of this.tasks()) {
      if (task.surface === "background") continue;
      for (const source of task.sources) {
        const remote = source.remote;
        if (!remote?.tenantId) continue;
        const key = `${remote.serverInstanceId}\0${remote.tenantId}\0${remote.itemId}`;
        const entry = references.get(key) ?? {
          taskIds: [],
          sourceAssetIds: [],
        };
        if (!entry.taskIds.includes(task.id)) entry.taskIds.push(task.id);
        if (!entry.sourceAssetIds.includes(source.id))
          entry.sourceAssetIds.push(source.id);
        references.set(key, entry);
      }
    }
    return rows.map((row) => {
      let source: Source;
      try {
        source = JSON.parse(row.body) as Source;
      } catch {
        throw new Error("Radar 本机条目已损坏。");
      }
      const remote = source.remote;
      if (!remote) throw new Error("Radar 本机条目缺少远端身份。");
      const follow =
        (row.follow_id ? followById.get(row.follow_id) : undefined) ??
        followBySource.get(row.source_id);
      const recommendation = follow?.recommendedSourceId
        ? recommendedById.get(follow.recommendedSourceId)
        : undefined;
      let fallbackTitle = "服务器推送";
      try {
        fallbackTitle = new URL(source.location).hostname;
      } catch {
        // Retain the neutral source name for malformed legacy locations.
      }
      const refs = references.get(
        `${row.server_instance_id}\0${row.tenant_id}\0${row.item_id}`,
      ) ?? { taskIds: [], sourceAssetIds: [] };
      return {
        id: row.radar_id,
        serverInstanceId: row.server_instance_id,
        tenantId: row.tenant_id,
        sourceId: row.source_id,
        remoteItemId: row.item_id,
        followId: row.follow_id ?? follow?.id,
        origin:
          row.origin === "user" || row.origin === "recommended"
            ? row.origin
            : (follow?.origin ?? "server"),
        sourceTitle:
          row.source_title ||
          follow?.name ||
          recommendation?.name ||
          fallbackTitle,
        category: row.category || follow?.category || recommendation?.category,
        title: source.title,
        url: source.location,
        excerpt: source.text.replace(/\s+/g, " ").trim().slice(0, 420),
        content: source.text,
        receivedAt: row.received_at,
        observedAt: remote.observedAt,
        publishedAt: remote.publishedAt,
        latestRevisionId: row.latest_revision_id,
        contentHash: remote.contentHash,
        coverageLevel: remote.coverageLevel,
        missing: [...remote.missing],
        revisionCount: Number(row.revision_count),
        isUpdated: Number(row.revision_count) > 1,
        readAt: row.read_at ?? undefined,
        archivedAt: row.archived_at ?? undefined,
        ...refs,
      };
    });
  }
  pendingRadarItems(identity: RemoteSourceIdentity): RadarItem[] {
    const handled = new Set<string>();
    for (const run of this.radarDigestions(identity)) {
      // A removed, unfinished background task must not strand its inputs.
      if (run.state === "pending" && !this.hasTask(run.taskId)) continue;
      for (const item of run.items)
        handled.add(`${item.radarItemId}\0${item.revisionId}`);
    }
    return this.radarItems(identity).filter(
      (item) =>
        !item.archivedAt &&
        !handled.has(`${item.id}\0${item.latestRevisionId}`),
    );
  }
  radarDigestions(identity: RemoteSourceIdentity): RadarDigestionRun[] {
    const rows = this.db
      .prepare(
        `SELECT body FROM digest_runs
         WHERE server_instance_id=? AND tenant_id=?
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(identity.serverInstanceId, identity.tenantId) as { body: string }[];
    return rows.map((row) => {
      try {
        return JSON.parse(row.body) as RadarDigestionRun;
      } catch {
        throw new Error("Radar 消化任务记录已损坏。");
      }
    });
  }
  radarDigests(identity: RemoteSourceIdentity): RadarDigest[] {
    const rows = this.db
      .prepare(
        `SELECT body FROM digests
         WHERE server_instance_id=? AND tenant_id=?
         ORDER BY published_at DESC, rowid DESC`,
      )
      .all(identity.serverInstanceId, identity.tenantId) as { body: string }[];
    return rows.map((row) => {
      try {
        return JSON.parse(row.body) as RadarDigest;
      } catch {
        throw new Error("Radar 主题理解记录已损坏。");
      }
    });
  }
  radarDispositions(identity: RemoteSourceIdentity): RadarDisposition[] {
    const rows = this.db
      .prepare(
        `SELECT body FROM dispositions
         WHERE server_instance_id=? AND tenant_id=?
         ORDER BY published_at DESC, rowid DESC`,
      )
      .all(identity.serverInstanceId, identity.tenantId) as { body: string }[];
    return rows.map((row) => {
      try {
        return JSON.parse(row.body) as RadarDisposition;
      } catch {
        throw new Error("Radar 筛选判断记录已损坏。");
      }
    });
  }
  radarSource(itemId: string): Source {
    const rows = this.db
      .prepare(
        `SELECT r.body FROM radar_items i
         JOIN remote_source_revisions r
           ON r.server_instance_id=i.server_instance_id
          AND r.tenant_id=i.tenant_id
          AND r.item_id=i.item_id
          AND r.revision_id=i.latest_revision_id
         WHERE i.radar_id=?`,
      )
      .all(itemId) as { body: string }[];
    if (rows.length !== 1)
      throw new Error(
        rows.length ? "Radar 条目身份不唯一。" : "找不到 Radar 条目。",
      );
    try {
      return JSON.parse(rows[0]!.body) as Source;
    } catch {
      throw new Error("Radar 本机条目已损坏。");
    }
  }
  radarSourceRevision(
    identity: RemoteSourceIdentity,
    remoteItemId: string,
    revisionId: string,
  ): Source | undefined {
    const row = this.db
      .prepare(
        `SELECT source_id, body FROM remote_source_revisions
         WHERE server_instance_id=? AND tenant_id=?
           AND item_id=? AND revision_id=?`,
      )
      .get(
        identity.serverInstanceId,
        identity.tenantId,
        remoteItemId,
        revisionId,
      ) as { source_id: string; body: string } | undefined;
    if (!row) return undefined;
    let source: Source;
    try {
      source = JSON.parse(row.body) as Source;
    } catch {
      throw new Error("Radar 本机修订记录已损坏。");
    }
    const remote = source.remote;
    if (
      !remote ||
      typeof source.id !== "string" ||
      typeof source.title !== "string" ||
      typeof source.location !== "string" ||
      typeof source.text !== "string" ||
      remote.serverInstanceId !== identity.serverInstanceId ||
      remote.tenantId !== identity.tenantId ||
      remote.sourceId !== row.source_id ||
      remote.itemId !== remoteItemId ||
      remote.revisionId !== revisionId ||
      typeof remote.observedAt !== "string" ||
      !isSourceCoverageLevel(remote.coverageLevel) ||
      !Array.isArray(remote.missing) ||
      remote.missing.some((value) => typeof value !== "string")
    )
      throw new Error("Radar 本机修订身份与索引不一致。");
    if (
      createHash("sha256").update(source.text).digest("hex") !==
      remote.contentHash
    )
      throw new Error("Radar 本机修订正文与内容哈希不一致。");
    return source;
  }
  radarSources(itemIds: string[]): Source[] {
    return [...new Set(itemIds)].map((itemId) => this.radarSource(itemId));
  }
  setRadarItemRead(itemId: string, read: boolean): void {
    this.updateRadarItemField(itemId, "read_at", read ? now() : null);
  }
  setRadarItemArchived(itemId: string, archived: boolean): void {
    this.updateRadarItemField(itemId, "archived_at", archived ? now() : null);
  }
  private updateRadarItemField(
    itemId: string,
    field: "read_at" | "archived_at",
    value: string | null,
  ): void {
    const count = this.db
      .prepare("SELECT COUNT(*) AS count FROM radar_items WHERE radar_id=?")
      .get(itemId) as { count: number };
    if (Number(count.count) !== 1)
      throw new Error(
        count.count ? "Radar 条目身份不唯一。" : "找不到 Radar 条目。",
      );
    this.db
      .prepare(`UPDATE radar_items SET ${field}=? WHERE radar_id=?`)
      .run(value, itemId);
  }
  commitRadarSourcesToTask(taskId: string, sources: Source[]): number {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const task = this.task(taskId);
      if (task.archivedAt)
        throw new Error("请先恢复这项工作，再加入 Radar 资料。");
      const novel = sources.filter(
        (source, index) =>
          sources.findIndex((candidate) =>
            sameStoredSource(candidate, source),
          ) === index &&
          !task.sources.some((candidate) =>
            sameStoredSource(candidate, source),
          ),
      );
      if (novel.length) {
        task.goalVersion++;
        task.sources.push(...novel);
        task.status = "idle";
        task.error = undefined;
        for (const source of novel) {
          this.insertRemoteRevision(source);
          task.events.push({
            id: uid(),
            type: "radar.material_added",
            summary: `已从 Radar 加入资料：${source.title}`,
            goalVersion: task.goalVersion,
            createdAt: now(),
            data: {
              itemId: source.remote?.itemId,
              revisionId: source.remote?.revisionId,
            },
          });
        }
        this.saveTask(task);
        this.db.prepare("DELETE FROM checkpoints WHERE task_id=?").run(taskId);
      }
      this.db.exec("COMMIT");
      return novel.length;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  createTaskFromRadar(
    task: Task,
    sources: Source[],
    digestion?: {
      identity: RemoteSourceIdentity;
      itemIds: string[];
      retryOfRunId?: string;
      contextSources?: RadarDigestionRun["contextSources"];
    },
  ): RadarDigestionRun | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.hasTask(task.id)) throw new Error("这项工作已经存在。");
      const unique = sources.filter(
        (source, index) =>
          sources.findIndex((candidate) =>
            sameStoredSource(candidate, source),
          ) === index,
      );
      let run: RadarDigestionRun | undefined;
      if (digestion) {
        const itemIds = [...new Set(digestion.itemIds)];
        if (!itemIds.length) throw new Error("请选择需要消化的 Radar 条目。");
        if (itemIds.length !== digestion.itemIds.length)
          throw new Error("Radar 消化条目不能重复。");
        if (unique.length !== itemIds.length)
          throw new Error("Radar 条目与任务资料数量不一致。");
        const items: RadarDigestionRun["items"] = [];
        const usedSourceIds = new Set<string>();
        for (const radarItemId of itemIds) {
          const current = this.radarSource(radarItemId);
          const remote = current.remote;
          if (
            !remote?.tenantId ||
            remote.serverInstanceId !== digestion.identity.serverInstanceId ||
            remote.tenantId !== digestion.identity.tenantId
          )
            throw new Error("Radar 条目不属于当前信息源身份。");
          const source = unique.find((candidate) =>
            sameStoredSource(candidate, current),
          );
          if (!source)
            throw new Error("Radar 条目已更新，请按最新修订重新发起消化。");
          if (usedSourceIds.has(source.id))
            throw new Error("Radar 任务资料 ID 不能重复。");
          usedSourceIds.add(source.id);
          items.push({
            radarItemId,
            sourceId: source.id,
            remoteItemId: remote.itemId,
            revisionId: remote.revisionId,
            contentHash: remote.contentHash,
          });
        }
        const previousSources = task.sources.filter(
          (source, index, all) =>
            all.findIndex((candidate) =>
              sameStoredSource(candidate, source),
            ) === index &&
            !unique.some((candidate) => sameStoredSource(candidate, source)),
        );
        task.sources = [...unique, ...previousSources];
        if (
          new Set(task.sources.map((source) => source.id)).size !==
          task.sources.length
        )
          throw new Error("任务资料 ID 不能重复。");
        const contextSources = digestion.contextSources ?? [];
        if (
          new Set(contextSources.map((source) => source.sourceId)).size !==
          contextSources.length
        )
          throw new Error("Radar 对照资料映射不能重复。");
        const contextById = new Map(
          contextSources.map((source) => [source.sourceId, source]),
        );
        for (const source of previousSources)
          if (!contextById.has(source.id))
            throw new Error("Radar 对照资料缺少来源映射。");
        for (const context of contextSources) {
          if (usedSourceIds.has(context.sourceId))
            throw new Error("Radar 原始证据不能同时作为对照资料。");
          if (!previousSources.some((source) => source.id === context.sourceId))
            throw new Error("Radar 对照资料不在消化任务中。");
          requireDigestText(context.referenceId, "Radar 对照资料引用");
          if (
            context.version !== undefined &&
            (!Number.isInteger(context.version) || context.version < 1)
          )
            throw new Error("Radar 对照资料版本无效。");
          if (context.hash !== undefined)
            requireDigestText(context.hash, "Radar 对照资料哈希");
        }
        const selectedRevisionKeys = new Set(
          items.map((item) => `${item.radarItemId}\0${item.revisionId}`),
        );
        let retryTarget: RadarDigestionRun | undefined;
        if (digestion.retryOfRunId) {
          const previousRow = this.db
            .prepare("SELECT body FROM digest_runs WHERE id=?")
            .get(digestion.retryOfRunId) as { body: string } | undefined;
          if (!previousRow)
            throw new Error("找不到需要重试的 Radar 消化任务。");
          let previous: RadarDigestionRun;
          try {
            previous = JSON.parse(previousRow.body) as RadarDigestionRun;
          } catch {
            throw new Error("Radar 消化任务记录已损坏。");
          }
          if (
            previous.serverInstanceId !== digestion.identity.serverInstanceId ||
            previous.tenantId !== digestion.identity.tenantId
          )
            throw new Error("不能跨信息源身份重试 Radar 消化任务。");
          if (previous.state !== "pending")
            throw new Error("已经发布的 Radar 消化任务不能重试。");
          if (!this.hasTask(previous.taskId))
            throw new Error("需要重试的 Radar 后台任务已经不存在。");
          const previousTask = this.task(previous.taskId);
          if (
            previousTask.status !== "failed" &&
            previousTask.status !== "completed"
          )
            throw new Error(
              "只有失败或已结束但未发布的 Radar 消化任务可以重试。",
            );
          const previousRevisionKeys = new Set(
            previous.items.map(
              (item) => `${item.radarItemId}\0${item.revisionId}`,
            ),
          );
          if (
            [...selectedRevisionKeys].some(
              (key) => !previousRevisionKeys.has(key),
            )
          )
            throw new Error("重试条目与原 Radar 消化任务的锁定修订不一致。");
          retryTarget = previous;
        }

        for (const previous of this.radarDigestions(digestion.identity)) {
          if (
            !previous.items.some((item) =>
              selectedRevisionKeys.has(
                `${item.radarItemId}\0${item.revisionId}`,
              ),
            )
          )
            continue;
          if (previous.state === "published")
            throw new Error("所选 Radar 修订已经形成主题理解，无需重复消化。");
          if (previous.id === retryTarget?.id) continue;
          if (!this.hasTask(previous.taskId)) continue;
          const previousTask = this.task(previous.taskId);
          if (
            previousTask.status !== "failed" &&
            previousTask.status !== "completed"
          )
            throw new Error("所选 Radar 修订已有团队消化任务正在处理。");
          if (!retryTarget)
            throw new Error(
              "所选 Radar 修订上次消化未发布，请使用明确的重试操作。",
            );
        }
        const createdAt = now();
        run = {
          id: uid(),
          taskId: task.id,
          goalVersion: task.goalVersion,
          serverInstanceId: digestion.identity.serverInstanceId,
          tenantId: digestion.identity.tenantId,
          state: "pending",
          createdAt,
          ...(digestion.retryOfRunId
            ? { retryOfRunId: digestion.retryOfRunId }
            : {}),
          items,
          contextSources: contextSources.map((source) => ({ ...source })),
        };
        task.surface = "background";
        task.events.push({
          id: uid(),
          type: "radar.digest_requested",
          summary: `已将 ${items.length} 条 Radar 信号交给团队消化。`,
          goalVersion: task.goalVersion,
          createdAt,
          data: {
            runId: run.id,
            sourceIds: items.map((item) => item.sourceId),
          },
        });
      } else task.sources = unique;
      for (const source of task.sources) this.insertRemoteRevision(source);
      for (const source of unique)
        task.events.push({
          id: uid(),
          type: "radar.material_added",
          summary: `已从 Radar 加入资料：${source.title}`,
          goalVersion: task.goalVersion,
          createdAt: now(),
          data: {
            itemId: source.remote?.itemId,
            revisionId: source.remote?.revisionId,
          },
        });
      this.saveTask(task);
      if (run)
        this.db
          .prepare(
            `INSERT INTO digest_runs(
               id, server_instance_id, tenant_id, task_id, goal_version,
               state, body, created_at, published_at
             ) VALUES(?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            run.id,
            run.serverInstanceId,
            run.tenantId,
            run.taskId,
            run.goalVersion,
            run.state,
            JSON.stringify(run),
            run.createdAt,
            null,
          );
      this.db.exec("COMMIT");
      return run;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  publishRadarDigest(
    taskId: string,
    goalVersion: number,
    operationId: string,
    input: RadarDigestPublicationInput,
  ): { digests: RadarDigest[]; dispositions: RadarDisposition[] } {
    requireDigestText(taskId, "Radar 消化任务 ID");
    requireDigestText(operationId, "Radar 发布操作 ID");
    requireDigestText(input.runId, "Radar 消化运行 ID");
    if (!Number.isInteger(goalVersion) || goalVersion < 1)
      throw new Error("Radar 消化目标版本无效。");
    const inputHash = createHash("sha256")
      .update(stableJSON(input))
      .digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previousPublication = this.db
        .prepare(
          `SELECT run_id, task_id, goal_version, input_hash, body
           FROM publications WHERE operation_id=?`,
        )
        .get(operationId) as
        | {
            run_id: string;
            task_id: string;
            goal_version: number;
            input_hash: string;
            body: string;
          }
        | undefined;
      if (previousPublication) {
        if (
          previousPublication.run_id !== input.runId ||
          previousPublication.task_id !== taskId ||
          Number(previousPublication.goal_version) !== goalVersion ||
          previousPublication.input_hash !== inputHash
        )
          throw new Error("Radar 发布操作 ID 已用于不同内容。");
        let result: {
          digests: RadarDigest[];
          dispositions: RadarDisposition[];
        };
        try {
          result = JSON.parse(previousPublication.body) as typeof result;
        } catch {
          throw new Error("Radar 发布记录已损坏。");
        }
        this.db.exec("COMMIT");
        return result;
      }

      const runRow = this.db
        .prepare("SELECT body FROM digest_runs WHERE id=?")
        .get(input.runId) as { body: string } | undefined;
      if (!runRow) throw new Error("找不到 Radar 消化任务。");
      let run: RadarDigestionRun;
      try {
        run = JSON.parse(runRow.body) as RadarDigestionRun;
      } catch {
        throw new Error("Radar 消化任务记录已损坏。");
      }
      if (run.taskId !== taskId)
        throw new Error("Radar 消化任务与当前工作不一致。");
      if (run.goalVersion !== goalVersion)
        throw new Error("Radar 消化任务的目标版本已变化。");
      if (run.state !== "pending") throw new Error("Radar 消化结果已经发布。");
      const task = this.task(taskId);
      if (task.goalVersion !== goalVersion)
        throw new Error("任务目标已变化，不能发布旧的 Radar 判断。");
      if (task.surface !== "background")
        throw new Error("Radar 消化结果只能由后台团队任务发布。");

      const locks = new Map<string, RadarDigestionRun["items"][number]>();
      for (const item of run.items) {
        if (locks.has(item.sourceId))
          throw new Error("Radar 消化任务的证据锁已损坏。");
        locks.set(item.sourceId, item);
        const source = task.sources.find(
          (candidate) => candidate.id === item.sourceId,
        );
        if (
          !source?.remote ||
          source.remote.serverInstanceId !== run.serverInstanceId ||
          source.remote.tenantId !== run.tenantId ||
          source.remote.itemId !== item.remoteItemId ||
          source.remote.revisionId !== item.revisionId ||
          source.remote.contentHash !== item.contentHash
        )
          throw new Error("Radar 任务中的证据已偏离锁定修订。");
      }
      if (!locks.size) throw new Error("Radar 消化任务没有锁定证据。");

      const contextById = new Map(
        run.contextSources.map((source) => [source.sourceId, source]),
      );
      if (contextById.size !== run.contextSources.length)
        throw new Error("Radar 消化任务的对照资料映射已损坏。");
      for (const sourceId of contextById.keys())
        if (!task.sources.some((source) => source.id === sourceId))
          throw new Error("Radar 消化任务缺少已映射的对照资料。");

      const sourceReads = recordedSourceReads(task, goalVersion);
      const evidenceSourceIds = new Set<string>();
      const dispositionSourceIds = new Set<string>();
      const publishedAt = now();
      const digests: RadarDigest[] = input.themes.map((theme, index) => {
        const title = requireDigestText(theme.title, "Radar 主题标题");
        const summary = requireDigestText(theme.summary, "Radar 主题理解");
        const whyItMatters = requireDigestText(
          theme.whyItMatters,
          "Radar 主题价值说明",
        );
        if (!theme.evidence.length)
          throw new Error("Radar 主题至少需要一条锁定证据。");
        const evidenceKeys = new Set<string>();
        const evidence = theme.evidence.map((reference) => {
          const lock = locks.get(reference.sourceId);
          if (!lock) throw new Error("Radar 主题引用了未锁定的证据。");
          if (reference.revisionId !== lock.revisionId)
            throw new Error("Radar 主题引用的证据修订与锁定值不一致。");
          const key = `${reference.sourceId}\0${reference.revisionId}`;
          if (evidenceKeys.has(key))
            throw new Error("Radar 主题中的同一证据不能重复引用。");
          evidenceKeys.add(key);
          evidenceSourceIds.add(reference.sourceId);
          return {
            sourceId: reference.sourceId,
            revisionId: reference.revisionId,
            ...(reference.note
              ? { note: requireDigestText(reference.note, "Radar 证据说明") }
              : {}),
          };
        });
        const contextIds = new Set<string>();
        const context = (theme.context ?? []).map((reference) => {
          if (!contextById.has(reference.sourceId))
            throw new Error("Radar 主题引用了未映射的对照资料。");
          const contextSource = task.sources.find(
            (source) => source.id === reference.sourceId,
          );
          if (
            !contextSource ||
            !sourceReadState(
              sourceReads,
              reference.sourceId,
              contextSource.text.length,
            ).nonEmpty
          )
            throw new Error("Radar 主题引用的对照资料尚未读到非空正文。");
          if (contextIds.has(reference.sourceId))
            throw new Error("Radar 主题中的同一对照资料不能重复引用。");
          contextIds.add(reference.sourceId);
          if (
            !["new", "supports", "extends", "repeats", "conflicts"].includes(
              reference.relation,
            )
          )
            throw new Error("Radar 对照关系无效。");
          return {
            sourceId: reference.sourceId,
            relation: reference.relation,
            note: requireDigestText(reference.note, "Radar 对照说明"),
          };
        });
        const cleanList = (values: string[] | undefined, label: string) => [
          ...new Set(
            (values ?? []).map((value) => requireDigestText(value, label)),
          ),
        ];
        return {
          id: digestionRecordId("radar_digest", operationId, index),
          runId: run.id,
          taskId,
          goalVersion,
          serverInstanceId: run.serverInstanceId,
          tenantId: run.tenantId,
          title,
          summary,
          whyItMatters,
          topics: cleanList(theme.topics, "Radar 主题标签"),
          evidence,
          context,
          disagreements: cleanList(theme.disagreements, "Radar 分歧"),
          gaps: cleanList(theme.gaps, "Radar 信息缺口"),
          publishedAt,
        };
      });
      const dispositions: RadarDisposition[] = input.dispositions.map(
        (disposition, index) => {
          if (!locks.has(disposition.sourceId))
            throw new Error("Radar 筛选判断引用了未锁定的资料。");
          if (
            ![
              "duplicate",
              "outdated",
              "low_value",
              "irrelevant",
              "incomplete",
              "deferred",
            ].includes(disposition.kind)
          )
            throw new Error("Radar 筛选判断类型无效。");
          if (dispositionSourceIds.has(disposition.sourceId))
            throw new Error("同一 Radar 资料不能重复给出筛选判断。");
          dispositionSourceIds.add(disposition.sourceId);
          return {
            id: digestionRecordId("radar_disposition", operationId, index),
            runId: run.id,
            taskId,
            goalVersion,
            serverInstanceId: run.serverInstanceId,
            tenantId: run.tenantId,
            sourceId: disposition.sourceId,
            kind: disposition.kind,
            reason: requireDigestText(disposition.reason, "Radar 筛选判断理由"),
            publishedAt,
          };
        },
      );
      for (const sourceId of locks.keys()) {
        if (
          evidenceSourceIds.has(sourceId) &&
          dispositionSourceIds.has(sourceId)
        )
          throw new Error("同一 Radar 资料不能既作为主题证据又被过滤。");
        if (
          !evidenceSourceIds.has(sourceId) &&
          !dispositionSourceIds.has(sourceId)
        )
          throw new Error("每条 Radar 资料都必须进入主题或给出筛选理由。");
        const source = task.sources.find((entry) => entry.id === sourceId);
        if (!source) throw new Error("Radar 任务缺少锁定资料正文。");
        const readState = sourceReadState(
          sourceReads,
          sourceId,
          source.text.length,
        );
        if (!readState.nonEmpty)
          throw new Error("Radar 锁定资料尚未读到非空正文。");
        const disposition = input.dispositions.find(
          (entry) => entry.sourceId === sourceId,
        );
        const mayRemainPartial =
          disposition?.kind === "incomplete" ||
          disposition?.kind === "deferred";
        if (!mayRemainPartial && !readState.full)
          throw new Error(
            `Radar 资料 ${sourceId} 只读取了 ${readState.readCharacters}/${source.text.length} 个字符；作为主题证据或确定性筛选判断前必须完整分页读取。`,
          );
      }

      for (const digest of digests)
        this.db
          .prepare(
            `INSERT INTO digests(
               id, run_id, task_id, server_instance_id, tenant_id,
               body, published_at
             ) VALUES(?,?,?,?,?,?,?)`,
          )
          .run(
            digest.id,
            digest.runId,
            digest.taskId,
            digest.serverInstanceId,
            digest.tenantId,
            JSON.stringify(digest),
            digest.publishedAt,
          );
      for (const disposition of dispositions)
        this.db
          .prepare(
            `INSERT INTO dispositions(
               id, run_id, task_id, server_instance_id, tenant_id,
               source_id, body, published_at
             ) VALUES(?,?,?,?,?,?,?,?)`,
          )
          .run(
            disposition.id,
            disposition.runId,
            disposition.taskId,
            disposition.serverInstanceId,
            disposition.tenantId,
            disposition.sourceId,
            JSON.stringify(disposition),
            disposition.publishedAt,
          );
      const result = { digests, dispositions };
      this.db
        .prepare(
          `INSERT INTO publications(
             operation_id, run_id, task_id, goal_version, input_hash,
             body, published_at
           ) VALUES(?,?,?,?,?,?,?)`,
        )
        .run(
          operationId,
          run.id,
          taskId,
          goalVersion,
          inputHash,
          JSON.stringify(result),
          publishedAt,
        );
      const publishedRun: RadarDigestionRun = {
        ...run,
        state: "published",
        publishedAt,
      };
      this.db
        .prepare(
          `UPDATE digest_runs
           SET state='published', body=?, published_at=?
           WHERE id=? AND state='pending'`,
        )
        .run(JSON.stringify(publishedRun), publishedAt, run.id);
      const markPublishedRevisionRead = this.db.prepare(
        `UPDATE radar_items
         SET read_at=COALESCE(read_at, ?)
         WHERE radar_id=?
           AND server_instance_id=?
           AND tenant_id=?
           AND latest_revision_id=?`,
      );
      for (const item of run.items)
        markPublishedRevisionRead.run(
          publishedAt,
          item.radarItemId,
          run.serverInstanceId,
          run.tenantId,
          item.revisionId,
        );
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  event(id: string, event: Omit<TaskEvent, "id" | "createdAt">): void {
    this.updateTask(id, (task) => {
      task.events.push({ ...event, id: uid(), createdAt: now() });
    });
  }
  config<T>(key: string, fallback: () => T): T {
    const row = this.db
      .prepare("SELECT body FROM config WHERE key=?")
      .get(key) as { body: string } | undefined;
    if (row) return JSON.parse(row.body) as T;
    const value = fallback();
    this.setConfig(key, value);
    return value;
  }
  setConfig(key: string, value: unknown): void {
    this.db
      .prepare(
        "INSERT INTO config(key,body) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body",
      )
      .run(key, JSON.stringify(value));
  }
  settings(): AppSettings {
    const settings = this.config<AppSettings>("settings", () => {
      const aiRoot = path.join(os.homedir(), "AI");
      const profiles = this.profiles();
      const first =
        profiles.find((p) => p.hasKey && p.modelId) ??
        profiles.find((p) => p.hasKey) ??
        profiles[0]!;
      return {
        aiRoot,
        codeRoot: path.join(os.homedir(), "Code"),
        workspaceRoot: path.join(aiRoot, "knowledge", "workspaces"),
        defaultProfileId: first.id,
        memberProfiles: {
          coordinator: first.id,
          cto: first.id,
          researcher: first.id,
        },
      };
    });
    return {
      ...settings,
      memberSettings: normalizeTeamSettings(settings.memberSettings),
      projectMonitoring: settings.projectMonitoring !== false,
    };
  }
  profiles(): ModelProfile[] {
    return this.config("profiles", () => [
      {
        id: "gemini",
        name: "Gemini",
        provider: "gemini",
        protocol: "google",
        baseURL: "",
        modelId: process.env.GEMINI_MODEL ?? "gemini-3.8-flash",
        apiKeyEnv: process.env.GEMINI_API_KEY
          ? "GEMINI_API_KEY"
          : "GOOGLE_API_KEY",
        hasKey: Boolean(
          process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
        ),
        status: "untested",
      },
      {
        id: "deepseek",
        name: "DeepSeek",
        provider: "deepseek",
        protocol: "openai",
        baseURL: "https://api.deepseek.com/v1",
        modelId: process.env.DEEPSEEK_MODEL ?? "",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        hasKey: Boolean(process.env.DEEPSEEK_API_KEY),
        status: "unconfigured",
      },
      {
        id: "ark",
        name: "Ark",
        provider: "ark",
        protocol: "openai",
        baseURL: process.env.VOLCENGINE_ARK_BASE_URL ?? "",
        modelId: process.env.VOLCENGINE_ARK_MODEL ?? "",
        apiKeyEnv: "VOLCENGINE_ARK_API_KEY",
        hasKey: Boolean(process.env.VOLCENGINE_ARK_API_KEY),
        status: "untested",
      },
    ]);
  }
  checkpoint<T>(id: string): T | undefined {
    const row = this.db
      .prepare("SELECT body FROM checkpoints WHERE task_id=?")
      .get(id) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as T) : undefined;
  }
  saveCheckpoint(id: string, checkpoint: unknown | null): void {
    if (checkpoint === null)
      this.db.prepare("DELETE FROM checkpoints WHERE task_id=?").run(id);
    else {
      this.task(id);
      this.db
        .prepare(
          "INSERT INTO checkpoints(task_id,body) VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET body=excluded.body",
        )
        .run(id, JSON.stringify(checkpoint));
    }
  }
  operation(id: string, taskId: string, data: unknown): void {
    this.task(taskId);
    this.db
      .prepare(
        "INSERT INTO operations(id,task_id,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(id, taskId, JSON.stringify(data));
  }
  getOperation(
    id: string,
  ): { taskId: string; data: Record<string, unknown> } | undefined {
    const row = this.db
      .prepare("SELECT task_id,body FROM operations WHERE id=?")
      .get(id) as { task_id: string; body: string } | undefined;
    return row
      ? { taskId: row.task_id, data: JSON.parse(row.body) }
      : undefined;
  }
  operations(): {
    id: string;
    taskId: string;
    data: Record<string, unknown>;
  }[] {
    return (
      this.db.prepare("SELECT * FROM operations").all() as {
        id: string;
        task_id: string;
        body: string;
      }[]
    ).map((r) => ({ id: r.id, taskId: r.task_id, data: JSON.parse(r.body) }));
  }
  close(): void {
    this.db.close();
  }

  library(root: string): LibraryEntry[] {
    const rows = this.db
      .prepare("SELECT body FROM library_entries WHERE root=?")
      .all(path.resolve(root)) as { body: string }[];
    return rows
      .map((row) => JSON.parse(row.body) as LibraryEntry)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  libraryEntry(root: string, id: string): LibraryEntry {
    const row = this.db
      .prepare("SELECT body FROM library_entries WHERE root=? AND id=?")
      .get(path.resolve(root), id) as { body: string } | undefined;
    if (!row) throw new Error("当前 AI 目录中找不到这项收藏。");
    return JSON.parse(row.body) as LibraryEntry;
  }
  collectedEntry(
    root: string,
    collectionKey: string,
  ): LibraryEntry | undefined {
    const row = this.db
      .prepare(
        "SELECT body FROM library_entries WHERE root=? AND collection_key=?",
      )
      .get(path.resolve(root), collectionKey) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as LibraryEntry) : undefined;
  }
  saveLibrary(root: string, entry: LibraryEntry, collectionKey: string): void {
    const stored = structuredClone(entry);
    delete stored.content;
    delete stored.readError;
    delete stored.previewURL;
    delete stored.feedback;
    delete stored.feedbackRevision;
    delete stored.externalChange;
    this.db
      .prepare(
        "INSERT INTO library_entries(id,root,collection_key,body) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body WHERE library_entries.root=excluded.root AND library_entries.collection_key=excluded.collection_key",
      )
      .run(
        stored.id,
        path.resolve(root),
        collectionKey,
        JSON.stringify(stored),
      );
  }
  libraryFeedback(root: string, entryId: string): LibraryFeedback[] {
    return (
      this.db
        .prepare(
          "SELECT body FROM library_feedback WHERE root=? AND entry_id=? ORDER BY rowid",
        )
        .all(path.resolve(root), entryId) as { body: string }[]
    ).map((row) => JSON.parse(row.body) as LibraryFeedback);
  }
  appendLibraryFeedback(root: string, feedback: LibraryFeedback): void {
    this.libraryEntry(root, feedback.entryId);
    this.db
      .prepare(
        "INSERT INTO library_feedback(id,root,entry_id,body) VALUES(?,?,?,?)",
      )
      .run(
        feedback.id,
        path.resolve(root),
        feedback.entryId,
        JSON.stringify(feedback),
      );
  }
  libraryOperation(
    id: string,
    root: string,
    data: Record<string, unknown>,
  ): void {
    this.db
      .prepare(
        "INSERT INTO library_operations(id,root,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body WHERE library_operations.root=excluded.root",
      )
      .run(id, path.resolve(root), JSON.stringify(data));
  }
  libraryOperations(
    root: string,
  ): { id: string; data: Record<string, unknown> }[] {
    const rows = this.db
      .prepare("SELECT id,body FROM library_operations WHERE root=?")
      .all(path.resolve(root)) as { id: string; body: string }[];
    return rows.map((row) => ({ id: row.id, data: JSON.parse(row.body) }));
  }
}
