import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { Store } from "../../desktop/src/core/store.ts";
import { Skills } from "../../desktop/src/core/skills.ts";
import {
  workspaceData,
  type WorkspaceData,
} from "../../desktop/src/core/backup-contract.ts";
import { transaction } from "./db.ts";
import { ServiceError } from "./errors.ts";
import { commandRequest, execute, type CommandRequest } from "./commands.ts";
import type { Identity } from "./auth.ts";
import { validText } from "./text.ts";
export const createRequest = z
  .object({ key: z.string().uuid(), name: z.string().trim().min(1).max(120) })
  .strict()
  .refine(validText, "Text contains unsupported characters");
const metadata = (row: any) => ({
  id: row.id as string,
  name: row.name as string,
  revision: row.revision as number,
  createdAt: new Date(row.created_at).toISOString(),
  updatedAt: new Date(row.updated_at).toISOString(),
});
export type Space = ReturnType<typeof metadata>;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => JSON.stringify(key) + ":" + canonical(value))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export function state(store: Store): WorkspaceData {
  const value = store.exportState();
  if (Buffer.byteLength(JSON.stringify(value)) > 60 * 1024 * 1024)
    throw new ServiceError(
      "SPACE_FULL",
      "工作空间达到当前容量限制，请先导出并整理资料",
      413,
    );
  return workspaceData.parse(value);
}
export function hydrate(value: unknown) {
  const parsed = workspaceData.safeParse(value);
  if (!parsed.success)
    throw new ServiceError(
      "STORED_STATE_INVALID",
      "空间资料需要核对，请保留现有记录",
      500,
    );
  const store = new Store(":memory:");
  try {
    store.restoreState(parsed.data);
    return store;
  } catch (error) {
    store.close();
    throw error;
  }
}
export class Workspaces {
  constructor(readonly db: pg.Pool) {}
  async list(identity: Identity) {
    return transaction(this.db, identity.id, async (client) => {
      const result = await client.query(
        `SELECT id,name,revision,created_at,updated_at FROM ytriple.workspaces
        WHERE owner_subject=$1 ORDER BY created_at,id LIMIT 50`,
        [identity.id],
      );
      return result.rows.map(metadata);
    });
  }
  async create(identity: Identity, raw: z.infer<typeof createRequest>) {
    const input = createRequest.parse(raw),
      fingerprint = hash(input);
    return transaction(this.db, identity.id, async (client) => {
      // Serialize account-local creation keys and the workspace count, including concurrent devices.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        ["ytriple-create:" + identity.id],
      );
      const old = await client.query(
        "SELECT * FROM ytriple.workspaces WHERE owner_subject=$1 AND create_key=$2",
        [identity.id, input.key],
      );
      if (old.rowCount) {
        if (old.rows[0].create_hash !== fingerprint)
          throw new ServiceError(
            "IDEMPOTENCY_CONFLICT",
            "创建请求标识已用于其他内容",
            409,
          );
        return metadata(old.rows[0]);
      }
      if (
        Number(
          (
            await client.query(
              "SELECT count(*) FROM ytriple.workspaces WHERE owner_subject=$1",
              [identity.id],
            )
          ).rows[0].count,
        ) >= 50
      )
        throw new ServiceError(
          "SPACE_LIMIT",
          "当前账号已达到 50 个服务空间上限",
          409,
        );
      const store = new Store(":memory:");
      let initial: WorkspaceData;
      try {
        store.initializeConfiguration();
        new Skills(store).initialize();
        initial = state(store);
      } finally {
        store.close();
      }
      const result = await client.query(
        `INSERT INTO ytriple.workspaces(id,owner_subject,name,create_key,create_hash,state)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,revision,created_at,updated_at`,
        [
          randomUUID(),
          identity.id,
          input.name,
          input.key,
          fingerprint,
          JSON.stringify(initial),
        ],
      );
      return metadata(result.rows[0]);
    });
  }
  private async require(
    client: pg.PoolClient,
    subject: string,
    id: string,
    lock = false,
  ) {
    const result = await client.query(
      "SELECT *, execution_until > clock_timestamp() AS execution_active FROM ytriple.workspaces WHERE id=$1 AND owner_subject=$2" +
        (lock ? " FOR UPDATE" : ""),
      [id, subject],
    );
    if (!result.rowCount)
      throw new ServiceError("NOT_FOUND", "工作空间不存在或不可访问", 404);
    if (result.rows[0].state_format !== 1)
      throw new ServiceError(
        "FORMAT_UNSUPPORTED",
        "需要升级服务以读取此空间",
        409,
      );
    return result.rows[0];
  }
  async read(identity: Identity, id: string) {
    return transaction(this.db, identity.id, async (client) => {
      const row = await this.require(client, identity.id, id),
        store = hydrate(row.state);
      try {
        return { workspace: metadata(row), data: store.snapshot() };
      } finally {
        store.close();
      }
    });
  }
  async receipt(identity: Identity, id: string, key: string) {
    return transaction(this.db, identity.id, async (client) => {
      await this.require(client, identity.id, id);
      const result = await client.query(
        "SELECT response FROM ytriple.command_receipts WHERE workspace_id=$1 AND owner_subject=$2 AND key=$3",
        [id, identity.id, key],
      );
      if (!result.rowCount)
        throw new ServiceError("NOT_FOUND", "没有找到该请求的完成记录", 404);
      return result.rows[0].response;
    });
  }
  async command(identity: Identity, id: string, raw: CommandRequest) {
    const input = commandRequest.parse(raw),
      fingerprint = hash(input);
    return transaction(this.db, identity.id, async (client) => {
      const row = await this.require(client, identity.id, id, true);
      const receipt = await client.query(
        "SELECT input_hash,response FROM ytriple.command_receipts WHERE workspace_id=$1 AND owner_subject=$2 AND key=$3",
        [id, identity.id, input.key],
      );
      if (receipt.rowCount) {
        if (receipt.rows[0].input_hash !== fingerprint)
          throw new ServiceError(
            "IDEMPOTENCY_CONFLICT",
            "同一请求标识不能提交不同内容",
            409,
          );
        return receipt.rows[0].response;
      }
      if (row.execution_active)
        throw new ServiceError(
          "SPACE_EXECUTING",
          "空间正在执行工作，请保留输入并稍后提交",
          409,
        );
      if (row.revision !== input.expectedRevision)
        throw new ServiceError(
          "REVISION_CONFLICT",
          "空间已变化，请保留当前输入并重新读取后再提交",
          409,
          { currentRevision: row.revision },
        );
      const store = hydrate(row.state);
      try {
        const result = execute(store, input.command);
        const updated = await client.query(
          `UPDATE ytriple.workspaces SET state=$3,revision=revision+1,updated_at=clock_timestamp()
          WHERE id=$1 AND owner_subject=$2 RETURNING id,name,revision,created_at,updated_at`,
          [id, identity.id, JSON.stringify(state(store))],
        );
        const response = { workspace: metadata(updated.rows[0]), result };
        await client.query(
          `INSERT INTO ytriple.command_receipts(workspace_id,owner_subject,key,input_hash,revision,response)
          VALUES($1,$2,$3,$4,$5,$6)`,
          [
            id,
            identity.id,
            input.key,
            fingerprint,
            response.workspace.revision,
            JSON.stringify(response),
          ],
        );
        return response;
      } finally {
        store.close();
      }
    });
  }
}
