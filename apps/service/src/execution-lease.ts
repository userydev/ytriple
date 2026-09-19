import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Identity } from "./auth.ts";
import { transaction } from "./db.ts";
import { ServiceError } from "./errors.ts";
import { state } from "./workspaces.ts";
import type { Store } from "../../desktop/src/core/store.ts";
import type { WorkspaceData } from "../../desktop/src/core/backup-contract.ts";

export type Lease = {
  workspaceId: string;
  subject: string;
  token: string;
  // PostgreSQL bigint stays a string; do not lose fencing precision in JavaScript.
  epoch: string;
};
const lost = () =>
  new ServiceError("EXECUTION_LOST", "执行归属已变化，保留原运行等待核对", 409);
function duration(seconds: number) {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300)
    throw Error("Execution lease duration must be 1..300 seconds");
  return seconds;
}
// Internal worker capability. Never expose these methods or lease tokens through HTTP.
export class ExecutionLeases {
  constructor(readonly db: pg.Pool) {}
  async acquire(identity: Identity, workspaceId: string, seconds = 30) {
    duration(seconds);
    return transaction(this.db, identity.id, async (client) => {
      // Lock first, then evaluate the database clock, including after lock contention.
      const found = await client.query(
        "SELECT id FROM ytriple.workspaces WHERE id=$1 AND owner_subject=$2 FOR UPDATE",
        [workspaceId, identity.id],
      );
      if (!found.rowCount)
        throw new ServiceError("NOT_FOUND", "工作空间不存在或不可访问", 404);
      const token = randomUUID();
      const result = await client.query(
        `UPDATE ytriple.workspaces SET execution_token=$3,execution_epoch=execution_epoch+1,
         execution_until=clock_timestamp()+($4 * interval '1 second')
         WHERE id=$1 AND owner_subject=$2 AND (execution_until IS NULL OR execution_until<=clock_timestamp())
         RETURNING state,state_format,revision,execution_epoch`,
        [workspaceId, identity.id, token, seconds],
      );
      if (!result.rowCount)
        throw new ServiceError("SPACE_EXECUTING", "空间已有执行进程", 409);
      const row = result.rows[0];
      if (row.state_format !== 1)
        throw new ServiceError("FORMAT_UNSUPPORTED", "请先升级执行服务", 409);
      return {
        lease: {
          workspaceId,
          subject: identity.id,
          token,
          epoch: row.execution_epoch as string,
        },
        revision: row.revision as number,
        state: row.state as WorkspaceData,
      };
    });
  }
  async renew(lease: Lease, seconds = 30) {
    duration(seconds);
    return transaction(this.db, lease.subject, async (client) => {
      const result = await client.query(
        `UPDATE ytriple.workspaces SET execution_until=clock_timestamp()+($5 * interval '1 second')
         WHERE id=$1 AND owner_subject=$2 AND execution_token=$3 AND execution_epoch=$4
         AND execution_until>clock_timestamp() RETURNING id`,
        [lease.workspaceId, lease.subject, lease.token, lease.epoch, seconds],
      );
      if (!result.rowCount) throw lost();
    });
  }
  async checkpoint(lease: Lease, revision: number, store: Store) {
    // Freeze the snapshot before any async I/O; later model events belong to the next checkpoint.
    const value = JSON.stringify(state(store));
    return transaction(this.db, lease.subject, async (client) => {
      const result = await client.query(
        `UPDATE ytriple.workspaces SET state=$6,revision=revision+1,updated_at=clock_timestamp()
         WHERE id=$1 AND owner_subject=$2 AND execution_token=$3 AND execution_epoch=$4
         AND execution_until>clock_timestamp() AND revision=$5 AND revision<2147483647
         RETURNING revision`,
        [
          lease.workspaceId,
          lease.subject,
          lease.token,
          lease.epoch,
          revision,
          value,
        ],
      );
      if (!result.rowCount) throw lost();
      return result.rows[0].revision as number;
    });
  }
  async release(lease: Lease) {
    return transaction(this.db, lease.subject, async (client) => {
      const result = await client.query(
        `UPDATE ytriple.workspaces SET execution_token=NULL,execution_until=NULL
         WHERE id=$1 AND owner_subject=$2 AND execution_token=$3 AND execution_epoch=$4 RETURNING id`,
        [lease.workspaceId, lease.subject, lease.token, lease.epoch],
      );
      return !!result.rowCount;
    });
  }
}
