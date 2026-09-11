import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type {
  AppSettings,
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
      CREATE TABLE IF NOT EXISTS checkpoints (task_id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, body TEXT NOT NULL);`);
    for (const task of this.tasks()) {
      if (task.status === "running" || task.status === "waiting") {
        task.status = "paused";
        task.events.push({
          id: uid(),
          type: "recovered",
          summary: "上次工作中断。已保留成果与记录，可以继续。",
          createdAt: now(),
          goalVersion: task.goalVersion,
        });
        this.saveTask(task);
      }
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
    return this.config("settings", () => {
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
    else
      this.db
        .prepare(
          "INSERT INTO checkpoints(task_id,body) VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET body=excluded.body",
        )
        .run(id, JSON.stringify(checkpoint));
  }
  operation(id: string, taskId: string, data: unknown): void {
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
}
