import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import type { WorkAccount, WorkJob } from "./contract.js";

export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export type Entitlement = WorkAccount["entitlement"];
export class WorkStore {
  readonly db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(directory, "work-service.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL, entitlement TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage(id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, model TEXT NOT NULL, state TEXT NOT NULL, reserved INTEGER NOT NULL, tokens INTEGER, result TEXT, created_at TEXT NOT NULL, UNIQUE(owner,request_id));
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, owner TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mutations(owner TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(owner,request_id));
      CREATE TABLE IF NOT EXISTS data_state(owner TEXT PRIMARY KEY, epoch INTEGER NOT NULL, clearing INTEGER NOT NULL);`);
    // A process interruption must not turn a requested deletion into runnable work.
    for (const { owner } of this.db
      .prepare("SELECT owner FROM data_state WHERE clearing=1")
      .all() as { owner: string }[])
      this.finishDataCleanup(owner);
  }
  dataEpoch(owner: string): number {
    return (
      (
        this.db
          .prepare("SELECT epoch FROM data_state WHERE owner=?")
          .get(owner) as { epoch: number } | undefined
      )?.epoch ?? 0
    );
  }
  isDataClearing(owner: string): boolean {
    return (
      (
        this.db
          .prepare("SELECT clearing FROM data_state WHERE owner=?")
          .get(owner) as { clearing: number } | undefined
      )?.clearing === 1
    );
  }
  assertDataAvailable(owner: string, epoch?: number) {
    if (
      this.isDataClearing(owner) ||
      (epoch !== undefined && epoch !== this.dataEpoch(owner))
    )
      throw new HttpError(
        409,
        "账号数据正在清理或已在本次请求期间清理；本次请求不会重新提交，请在清理完成后明确发起新请求。",
      );
  }
  beginDataCleanup(owner: string, epoch: number) {
    this.assertDataAvailable(owner, epoch);
    this.db
      .prepare(
        "INSERT INTO data_state(owner,epoch,clearing) VALUES(?,?,1) ON CONFLICT(owner) DO UPDATE SET epoch=excluded.epoch,clearing=1",
      )
      .run(owner, epoch + 1);
  }
  finishDataCleanup(owner: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM jobs WHERE owner=?").run(owner);
      this.db
        .prepare(
          "UPDATE usage SET result=NULL,state=CASE WHEN state='pending' THEN 'unknown' ELSE state END WHERE owner=?",
        )
        .run(owner);
      this.db
        .prepare("UPDATE mutations SET result='{}' WHERE owner=?")
        .run(owner);
      this.db
        .prepare("UPDATE data_state SET clearing=0 WHERE owner=?")
        .run(owner);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  provision(username: string, password: string, entitlement: Entitlement) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._@+-]{1,119}$/.test(username) ||
      password.length < 12 ||
      password.length > 512
    )
      throw new Error("用户名无效或密码不足 12 位。");
    const salt = randomBytes(16).toString("hex");
    const encoded = `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
    const prior = this.db
      .prepare("SELECT id FROM accounts WHERE username=?")
      .get(username) as { id: string } | undefined;
    const id = prior?.id ?? randomUUID();
    this.db
      .prepare(
        "INSERT INTO accounts(id,username,password,entitlement) VALUES(?,?,?,?) ON CONFLICT(username) DO UPDATE SET password=excluded.password,entitlement=excluded.entitlement",
      )
      .run(id, username, encoded, JSON.stringify(entitlement));
    if (prior) this.db.prepare("DELETE FROM devices WHERE owner=?").run(id);
    return id;
  }
  login(username: string, password: string, deviceName: string) {
    const row = this.db
      .prepare("SELECT id,password FROM accounts WHERE username=?")
      .get(username) as { id: string; password: string } | undefined;
    const [salt, expected] = (
      row?.password ?? `${"0".repeat(32)}:${"0".repeat(128)}`
    ).split(":");
    const valid = timingSafeEqual(
      scryptSync(password, salt!, 64),
      Buffer.from(expected!, "hex"),
    );
    if (!row || !valid) throw new HttpError(401, "账号或密码不正确。");
    const id = randomUUID(),
      token = randomBytes(32).toString("base64url"),
      now = new Date().toISOString(),
      expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
    this.db
      .prepare("INSERT INTO devices VALUES(?,?,?,?,?,?,?)")
      .run(id, row.id, deviceName, digest(token), now, now, expiresAt);
    return {
      token,
      expiresAt,
      user: { id: row.id, username },
      device: { id, name: deviceName },
    };
  }
  authenticate(token: string) {
    const row = this.db
      .prepare("SELECT id,owner,expires_at FROM devices WHERE token_hash=?")
      .get(digest(token)) as
      { id: string; owner: string; expires_at: string } | undefined;
    if (!row || Date.parse(row.expires_at) <= Date.now())
      throw new HttpError(401, "设备登录已失效，请重新登录。");
    this.db
      .prepare("UPDATE devices SET last_seen_at=? WHERE id=?")
      .run(new Date().toISOString(), row.id);
    return row;
  }
  account(owner: string): WorkAccount {
    const row = this.db
      .prepare("SELECT id,username,entitlement FROM accounts WHERE id=?")
      .get(owner) as
      { id: string; username: string; entitlement: string } | undefined;
    if (!row) throw new HttpError(401, "账号不存在。");
    const usage = this.db
      .prepare(
        "SELECT COALESCE(SUM(tokens),0) used,COALESCE(SUM(CASE WHEN state IN ('pending','unknown') THEN reserved ELSE 0 END),0) reserved,SUM(CASE WHEN state='unknown' THEN 1 ELSE 0 END) unknown_count FROM usage WHERE owner=?",
      )
      .get(owner) as { used: number; reserved: number; unknown_count: number };
    const entitlement = JSON.parse(row.entitlement) as Entitlement;
    return {
      user: { id: row.id, username: row.username },
      entitlement,
      usage: {
        usedTokens: usage.used,
        reservedTokens: usage.reserved,
        remainingTokens: Math.max(
          0,
          entitlement.tokenLimit - usage.used - usage.reserved,
        ),
        unknownRequests: usage.unknown_count ?? 0,
      },
    };
  }
  jobs(owner?: string): (WorkJob & { owner: string })[] {
    const rows = (
      owner
        ? this.db
            .prepare("SELECT owner,body FROM jobs WHERE owner=?")
            .all(owner)
        : this.db.prepare("SELECT owner,body FROM jobs").all()
    ) as { owner: string; body: string }[];
    return rows.map((row) => ({ ...JSON.parse(row.body), owner: row.owner }));
  }
  job(owner: string, id: string): WorkJob {
    const row = this.db
      .prepare("SELECT body FROM jobs WHERE id=? AND owner=?")
      .get(id, owner) as { body: string } | undefined;
    if (!row) throw new HttpError(404, "找不到这项委托。");
    return JSON.parse(row.body);
  }
  saveJob(owner: string, job: WorkJob) {
    this.db
      .prepare(
        "INSERT INTO jobs(id,owner,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body WHERE jobs.owner=excluded.owner",
      )
      .run(job.id, owner, JSON.stringify(job));
  }
  mutate<T>(
    owner: string,
    requestId: string,
    input: unknown,
    work: () => T,
  ): T {
    this.assertDataAvailable(owner);
    const fingerprint = digest(input);
    const prior = this.db
      .prepare(
        "SELECT fingerprint,result FROM mutations WHERE owner=? AND request_id=?",
      )
      .get(owner, requestId) as
      { fingerprint: string; result: string } | undefined;
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new HttpError(409, "请求编号已用于不同内容。");
      if (prior.result === "{}")
        throw new HttpError(409, "这项请求的数据已清理，不会重新创建或执行。");
      return JSON.parse(prior.result);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db
        .prepare("INSERT INTO mutations VALUES(?,?,?,?)")
        .run(owner, requestId, fingerprint, JSON.stringify(result));
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
