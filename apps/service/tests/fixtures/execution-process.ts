import pg from "pg";
import { randomUUID } from "node:crypto";
import { DurableRuntime } from "../../src/durable-runtime.ts";
import { ExecutionLeases } from "../../src/execution-lease.ts";

// Test-only child process. Fixed isolated database, no model provider or credentials.
const [workspaceId, subject, userId] = process.argv.slice(2);
const db = new pg.Pool({
  connectionString:
    "postgresql://ytriple_runtime:local-test-only@127.0.0.1:55441/ytriple_test",
});
const host = await DurableRuntime.open(
  new ExecutionLeases(db),
  {
    id: subject,
    user_id: userId,
    product_id: "ytriple",
    authentication: "supabase",
    scopes: ["product:access"],
  },
  workspaceId,
  {
    scope: "fixture:remote:ytriple",
    recovery: "remote",
    async lookupByKey() {
      throw Error("This fixture only starts a call");
    },
    async *stream(_prompt, key) {
      yield { type: "run.started", run_id: key };
      // Resumption after yield means the receiving runtime committed run.started.
      process.send?.({ type: "calling", key });
      await new Promise<void>(() => {});
    },
  },
);
const run = await host.submit({
  key: randomUUID(),
  context: "new",
  text: "进程退出恢复测试",
  refs: [],
  recipient: null,
  projectId: null,
});
process.send?.({ type: "accepted", runId: run.id, workId: run.workId });
// Keep IPC open while the parent exercises abrupt process termination.
process.on("message", () => {});
