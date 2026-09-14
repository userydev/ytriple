import { normalizeTeamSettings } from "../shared/member-settings.js";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type {
  AppSettings,
  LibraryEntry,
  ModelProfile,
  Task,
  TaskEvent,
} from "../shared/types.js";

export const now = () => new Date().toISOString();
export const uid = () => randomUUID();
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
      CREATE TABLE IF NOT EXISTS library_operations (id TEXT PRIMARY KEY, root TEXT NOT NULL, body TEXT NOT NULL);`);
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
