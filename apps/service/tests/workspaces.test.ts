import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import pg from "pg";
import { createApp } from "../src/app.ts";
import { coreAuthorization } from "../src/auth.ts";
import { Workspaces, hydrate } from "../src/workspaces.ts";
import { ExecutionLeases } from "../src/execution-lease.ts";
import { DurableRuntime } from "../src/durable-runtime.ts";
import type { Identity } from "../src/auth.ts";
import type { Model } from "../../desktop/src/core/ycore.ts";
import type {
  SubmitInput,
  Run,
  ArtifactVersion,
} from "../../desktop/src/core/types.ts";
import { transaction, assertRuntimeRole } from "../src/db.ts";
import { migrate } from "../scripts/migrate.ts";
import { defaultTeam, defaultWorkflow } from "../../desktop/src/core/types.ts";
import { versionKey } from "../../desktop/src/core/configuration.ts";
import { protocolModel } from "../../desktop/tests/team-response.ts";

// This suite never accepts DATABASE_URL: it can only touch its dedicated loopback fixture.
const ownerUrl =
  "postgresql://ytriple_owner:local-test-only@127.0.0.1:55441/ytriple_test";
const runtimeUrl =
  "postgresql://ytriple_runtime:local-test-only@127.0.0.1:55441/ytriple_test";
const owner = new pg.Pool({ connectionString: ownerUrl });
let db: pg.Pool,
  app: ReturnType<typeof createApp>,
  origin: string,
  providerOrigin: string;
const users = { alpha: randomUUID(), beta: randomUUID() };
let blocked = false,
  authorizations = 0;
const provider = createServer((req, res) => {
  assert.equal(req.url, "/v1/identity");
  assert.equal(req.headers["x-ycore-product"], "ytriple");
  authorizations++;
  const key = req.headers.authorization?.slice(7) as keyof typeof users;
  if (!users[key] || blocked) {
    res.writeHead(401);
    res.end("{}");
    return;
  }
  res.writeHead(200, {
    "Content-Type": "application/json",
    "X-YCore-Contract": "0.1.0",
  });
  res.end(
    JSON.stringify({
      id: "user:fixture:" + users[key] + ":ytriple",
      user_id: users[key],
      product_id: "ytriple",
      authentication: "supabase",
      scopes: ["product:access"],
    }),
  );
});
const subject = (user: keyof typeof users) =>
  "user:fixture:" + users[user] + ":ytriple";
const identity = (user: keyof typeof users = "alpha"): Identity => ({
  id: subject(user),
  user_id: users[user],
  product_id: "ytriple",
  authentication: "supabase",
  scopes: ["product:access"],
});
async function start() {
  db = new pg.Pool({ connectionString: runtimeUrl, max: 4 });
  await assertRuntimeRole(db);
  app = createApp(new Workspaces(db), coreAuthorization(providerOrigin));
  origin = await app.listen({ host: "127.0.0.1", port: 0 });
}
before(async () => {
  await owner.query(`DO $$ DECLARE role_name text; BEGIN
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
        EXECUTE format('CREATE ROLE %I NOLOGIN',role_name);
      END IF;
    END LOOP;
  END $$;
  ALTER DEFAULT PRIVILEGES FOR ROLE ytriple_owner GRANT SELECT ON TABLES TO anon,authenticated,service_role;
  ALTER DEFAULT PRIVILEGES FOR ROLE ytriple_owner GRANT USAGE ON SCHEMAS TO anon,authenticated,service_role;`);
  await migrate(ownerUrl);
  await owner.query(
    "ALTER ROLE ytriple_runtime LOGIN PASSWORD 'local-test-only'",
  );
  await owner.query("TRUNCATE ytriple.command_receipts,ytriple.workspaces");
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  providerOrigin = "http://127.0.0.1:" + address.port;
  await start();
});
after(async () => {
  await app?.close();
  await db?.end();
  await owner.end();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
});
async function request(
  user: string | null,
  path: string,
  body?: object,
  extra: Record<string, string> = {},
) {
  const response = await fetch(origin + path, {
    method: body ? "POST" : "GET",
    headers: {
      ...(user ? { Authorization: "Bearer " + user } : {}),
      "Content-Type": "application/json",
      ...extra,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
    redirect: "error",
  });
  assert.equal(response.headers.get("X-Ytriple-Contract"), "0.1.0");
  assert.equal(response.headers.get("cache-control"), "no-store");
  return { status: response.status, body: (await response.json()) as any };
}
async function space(user = "alpha", name = "Fixture workspace") {
  const response = await request(user, "/v1/workspaces", {
    key: randomUUID(),
    name,
  });
  assert.equal(response.status, 200);
  return response.body.workspace;
}
const command = (
  key = randomUUID(),
  name = "First project",
  expectedRevision = 0,
) => ({
  key,
  expectedRevision,
  command: {
    type: "create-project",
    name,
    goal: "Fixture goal",
    kind: "software",
  },
});

test("private workspace creation is idempotent and no caller-supplied identity grants access", async () => {
  assert.equal(
    (
      await request(null, "/v1/workspaces", undefined, {
        "X-Ytriple-Subject": subject("alpha"),
      })
    ).status,
    401,
  );
  const body = { key: randomUUID(), name: "Persistent private space" };
  const [a, b] = await Promise.all([
    request("alpha", "/v1/workspaces", body),
    request("alpha", "/v1/workspaces", body),
  ]);
  assert.equal(a.status, 200);
  assert.deepEqual(a.body, b.body);
  assert.equal(
    (await request("alpha", "/v1/workspaces", { ...body, name: "different" }))
      .status,
    409,
  );
  const id = a.body.workspace.id;
  assert.equal((await request("beta", "/v1/workspaces/" + id)).status, 404);
  assert.equal(
    (await request("beta", "/v1/workspaces/" + id + "/commands", command()))
      .status,
    404,
  );
  assert.equal(
    (
      await request("alpha", "/v1/workspaces", {
        ...body,
        owner_subject: subject("beta"),
      })
    ).status,
    400,
  );
  const snapshot = await request("alpha", "/v1/workspaces/" + id);
  assert.deepEqual(snapshot.body.data.localRoots, {
    aiPath: null,
    codePath: null,
  });
  assert.ok(snapshot.body.data.teams.length);
  assert.ok(snapshot.body.data.workflows.length);
  assert.equal(JSON.stringify(snapshot.body).includes("access_token"), false);
});

test("same revision from two devices commits once; replay and receipt lookup return the original result", async () => {
  const s = await space(),
    path = "/v1/workspaces/" + s.id + "/commands";
  const one = command(),
    two = command(randomUUID(), "Other device's project");
  const results = await Promise.all([
    request("alpha", path, one),
    request("alpha", path, two),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const index = results.findIndex((r) => r.status === 200),
    winner = [one, two][index],
    success = results[index];
  assert.equal(results[1 - index].body.error.code, "REVISION_CONFLICT");
  assert.equal(results[1 - index].body.error.currentRevision, 1);
  assert.deepEqual((await request("alpha", path, winner)).body, success.body);
  assert.deepEqual(
    (await request("alpha", path + "/" + winner.key)).body,
    success.body,
  );
  assert.equal((await request("beta", path + "/" + winner.key)).status, 404);
  assert.equal(
    (
      await request("alpha", path, {
        ...winner,
        command: { ...winner.command, name: "changed" },
      })
    ).body.error.code,
    "IDEMPOTENCY_CONFLICT",
  );
  const snapshot = await request("alpha", "/v1/workspaces/" + s.id);
  assert.equal(snapshot.body.data.projects.length, 1);
  assert.equal(snapshot.body.workspace.revision, 1);
});

test("domain ownership, configuration versions and explicit text upload use the existing core transactionally", async () => {
  const s = await space(),
    other = await space(),
    path = "/v1/workspaces/" + s.id + "/commands";
  const project = (await request("alpha", path, command())).body.result;
  const failed = await request(
    "alpha",
    "/v1/workspaces/" + other.id + "/commands",
    {
      key: randomUUID(),
      expectedRevision: 0,
      command: {
        type: "create-delivery",
        projectId: project.id,
        title: "Cross-space",
      },
    },
  );
  assert.equal(failed.body.error.code, "COMMAND_REJECTED");
  assert.equal(
    (await request("alpha", "/v1/workspaces/" + other.id)).body.workspace
      .revision,
    0,
  );
  const material = (
    await request("alpha", path, {
      key: randomUUID(),
      expectedRevision: 1,
      command: {
        type: "add-text-material",
        title: "Explicitly uploaded fixture",
        body: "Only this selected text",
      },
    })
  ).body.result;
  assert.equal(material.coverage, "uploaded_text");
  const brief = await request("alpha", path, {
    key: randomUUID(),
    expectedRevision: 2,
    command: {
      type: "project-brief",
      brief: {
        projectId: project.id,
        expectedRevision: 0,
        goal: "Refined goal",
        refs: [{ materialId: material.id, version: 1, label: "Selected text" }],
      },
    },
  });
  assert.equal(brief.status, 200);
  assert.equal(brief.body.result.revision, 1);
  const saved = await request("alpha", path, {
    key: randomUUID(),
    expectedRevision: 3,
    command: { type: "save-team", team: defaultTeam },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.result.version, defaultTeam.version + 1);
  for (const type of [
    "configure",
    "choose-file",
    "read-project-file",
    "execute-initialization",
    "submit",
  ]) {
    assert.equal(
      (
        await request("alpha", path, {
          key: randomUUID(),
          expectedRevision: 4,
          command: { type, path: "/etc/passwd" },
        })
      ).status,
      400,
    );
  }
  const snapshot = await request("alpha", "/v1/workspaces/" + s.id);
  assert.equal(snapshot.body.workspace.revision, 4);
  assert.equal(snapshot.body.data.materials[0].body, "Only this selected text");
  assert.deepEqual(snapshot.body.data.localRoots, {
    aiPath: null,
    codePath: null,
  });
});

test("restart restores committed objects and command receipts; revoked identity cannot fetch a prior result", async () => {
  const s = await space(),
    input = command(),
    path = "/v1/workspaces/" + s.id + "/commands";
  const first = await request("alpha", path, input);
  await app.close();
  await db.end();
  await start();
  const before = authorizations;
  assert.deepEqual(
    (await request("alpha", path + "/" + input.key)).body,
    first.body,
  );
  assert.deepEqual((await request("alpha", path, input)).body, first.body);
  assert.equal(
    (await request("alpha", "/v1/workspaces/" + s.id)).body.data.projects[0].id,
    first.body.result.id,
  );
  assert.equal(authorizations - before, 3);
  blocked = true;
  try {
    assert.equal((await request("alpha", path + "/" + input.key)).status, 401);
  } finally {
    blocked = false;
  }
});

test("rejected text and oversized commands leave the workspace and idempotency ledger unchanged", async () => {
  const s = await space(),
    path = "/v1/workspaces/" + s.id + "/commands";
  for (const name of ["name\u0000", "name\ud800"]) {
    const input = command(randomUUID(), name);
    assert.equal((await request("alpha", path, input)).status, 400);
    assert.equal((await request("alpha", path + "/" + input.key)).status, 404);
  }
  const large = await request("alpha", path, {
    key: randomUUID(),
    expectedRevision: 0,
    command: {
      type: "add-text-material",
      title: "too large",
      body: "文".repeat(100000),
    },
  });
  assert.equal(large.status, 413);
  assert.equal(
    (await request("alpha", "/v1/workspaces/" + s.id)).body.workspace.revision,
    0,
  );
});

test("runtime RLS hides other accounts without app filters and transaction context never leaks across pooled reuse", async () => {
  const a = await space("alpha"),
    b = await space("beta");
  const pool = new pg.Pool({ connectionString: runtimeUrl, max: 1 });
  try {
    assert.equal(
      (await pool.query("SELECT id FROM ytriple.workspaces")).rowCount,
      0,
    );
    const rows = await transaction(pool, subject("alpha"), (client) =>
      client.query("SELECT id FROM ytriple.workspaces"),
    );
    assert.ok(rows.rows.some((r) => r.id === a.id));
    assert.ok(!rows.rows.some((r) => r.id === b.id));
    assert.equal(
      (await pool.query("SELECT id FROM ytriple.workspaces")).rowCount,
      0,
    );
    await assert.rejects(
      transaction(pool, subject("alpha"), async (c) => {
        await c.query("SELECT 1");
        throw Error("rollback fixture");
      }),
    );
    assert.equal(
      (await pool.query("SELECT id FROM ytriple.workspaces")).rowCount,
      0,
    );
    await assert.rejects(
      transaction(pool, subject("alpha"), (c) =>
        c.query("UPDATE ytriple.workspaces SET owner_subject=$1 WHERE id=$2", [
          subject("beta"),
          a.id,
        ]),
      ),
      { code: "42501" },
    );
    await assert.rejects(
      transaction(pool, subject("alpha"), (c) =>
        c.query("DELETE FROM ytriple.command_receipts"),
      ),
      { code: "42501" },
    );
    assert.equal(
      (
        await transaction(pool, subject("alpha"), (c) =>
          c.query("UPDATE ytriple.workspaces SET name='blocked' WHERE id=$1", [
            b.id,
          ]),
        )
      ).rowCount,
      0,
    );
    await assert.rejects(assertRuntimeRole(owner), /restricted/);
    await assertRuntimeRole(pool);
    const tables =
      await owner.query(`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid
      WHERE n.nspname='ytriple' AND c.relkind='r'`);
    assert.equal(tables.rowCount, 2);
    assert.ok(
      tables.rows.every((r) => r.relrowsecurity && r.relforcerowsecurity),
    );
    const grants = await owner.query(
      `SELECT 1 FROM information_schema.table_privileges WHERE table_schema='ytriple' AND grantee IN ('PUBLIC','anon','authenticated','service_role')`,
    );
    assert.equal(grants.rowCount, 0);
    const schemaGrants = await owner.query(`SELECT 1 FROM pg_roles
      WHERE rolname IN ('anon','authenticated','service_role')
      AND has_schema_privilege(rolname,'ytriple','USAGE')`);
    assert.equal(schemaGrants.rowCount, 0);
  } finally {
    await pool.end();
  }
});

test("a database failure while saving the receipt rolls back the domain mutation and allows an exact retry", async () => {
  const s = await space(),
    input = command(),
    path = "/v1/workspaces/" + s.id + "/commands";
  // Fixed isolated *_test database only; the constraint simulates a failure after UPDATE state.
  await owner.query(
    `ALTER TABLE ytriple.command_receipts ADD CONSTRAINT fixture_receipt_failure CHECK (key <> '${input.key}'::uuid)`,
  );
  try {
    const failed = await request("alpha", path, input);
    assert.equal(failed.status, 500);
    assert.equal(failed.body.error.code, "INTERNAL_ERROR");
    const snapshot = await request("alpha", "/v1/workspaces/" + s.id);
    assert.equal(snapshot.body.workspace.revision, 0);
    assert.equal(snapshot.body.data.projects.length, 0);
    assert.equal((await request("alpha", path + "/" + input.key)).status, 404);
  } finally {
    await owner.query(
      "ALTER TABLE ytriple.command_receipts DROP CONSTRAINT fixture_receipt_failure",
    );
  }
  assert.equal((await request("alpha", path, input)).status, 200);
  assert.equal(
    (await request("alpha", "/v1/workspaces/" + s.id)).body.data.projects
      .length,
    1,
  );
});

const submission = (): SubmitInput => ({
  key: randomUUID(),
  context: "new",
  text: "形成有依据的测试说明",
  refs: [],
  recipient: null,
  projectId: null,
});
async function serialSpace() {
  const s = await space();
  const selected = await request("alpha", `/v1/workspaces/${s.id}/commands`, {
    key: randomUUID(),
    expectedRevision: 0,
    command: {
      type: "select-configuration",
      workId: null,
      teamKey: versionKey(defaultTeam),
      workflowKey: versionKey(defaultWorkflow),
    },
  });
  assert.equal(selected.status, 200);
  return s;
}
// Match the final response contract while preserving raw intermediate controls.
const remoteFixture = (stream: Model["stream"]): Model => protocolModel({
  scope: "fixture:remote:ytriple",
  recovery: "remote",
  stream,
  async lookupByKey(key) {
    return {
      id: key,
      status: "succeeded",
      result: { text: "已完成的原远端结果" },
      error: null,
    };
  },
});
async function expire(workspaceId: string) {
  await owner.query(
    "UPDATE ytriple.workspaces SET execution_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [workspaceId],
  );
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("competing workers have one lease; expiration fences renew/checkpoint/release and private commands", async () => {
  const s = await space(),
    leases = new ExecutionLeases(db);
  await assert.rejects(leases.acquire(identity("beta"), s.id), {
    code: "NOT_FOUND",
  });
  const attempts = await Promise.allSettled([
    leases.acquire(identity(), s.id),
    leases.acquire(identity(), s.id),
  ]);
  assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 1);
  const winner = attempts.find(
    (r) => r.status === "fulfilled",
  )! as PromiseFulfilledResult<Awaited<ReturnType<typeof leases.acquire>>>;
  const first = winner.value;
  const store = hydrate(first.state);
  try {
    await assert.rejects(leases.acquire(identity(), s.id), {
      code: "SPACE_EXECUTING",
    });
    const blocked = await request(
      "alpha",
      `/v1/workspaces/${s.id}/commands`,
      command(),
    );
    assert.equal(blocked.body.error.code, "SPACE_EXECUTING");
    await leases.renew(first.lease);
    await expire(s.id);
    await assert.rejects(leases.renew(first.lease), { code: "EXECUTION_LOST" });
    await assert.rejects(
      leases.checkpoint(first.lease, first.revision, store),
      { code: "EXECUTION_LOST" },
    );
    const second = await leases.acquire(identity(), s.id);
    assert.ok(BigInt(second.lease.epoch) > BigInt(first.lease.epoch));
    assert.notEqual(second.lease.token, first.lease.token);
    assert.equal(await leases.release(first.lease), false);
    await assert.rejects(
      leases.checkpoint(first.lease, first.revision, store),
      { code: "EXECUTION_LOST" },
    );
    const revision = await leases.checkpoint(
      second.lease,
      second.revision,
      store,
    );
    assert.equal(revision, second.revision + 1);
    await assert.rejects(
      leases.checkpoint(second.lease, second.revision, store),
      { code: "EXECUTION_LOST" },
    );
    assert.equal(await leases.release(second.lease), true);
    const input = command(randomUUID(), "After release", revision);
    const accepted = await request(
      "alpha",
      `/v1/workspaces/${s.id}/commands`,
      input,
    );
    assert.equal(accepted.status, 200);
    // Original receipts remain readable and repeatable, even during a later lease.
    const third = await leases.acquire(identity(), s.id);
    try {
      const replay = await request(
        "alpha",
        `/v1/workspaces/${s.id}/commands`,
        input,
      );
      assert.equal(replay.status, 200);
      assert.deepEqual(replay.body, accepted.body);
    } finally {
      await leases.release(third.lease);
    }
  } finally {
    store.close();
    await leases.release(first.lease);
  }
});

test("shared team runtime checkpoints every call identity before the model and restores its result without replay", async () => {
  const s = await serialSpace(),
    leases = new ExecutionLeases(db);
  let calls = 0;
  const model = remoteFixture(async function* (_prompt, key) {
    calls++;
    const persisted = (
      await owner.query("SELECT state FROM ytriple.workspaces WHERE id=$1", [
        s.id,
      ])
    ).rows[0].state;
    const rows = persisted.entities.map((r: any) => ({
      kind: r.kind,
      data: JSON.parse(r.data),
    }));
    assert.equal(persisted.submissions.length, 1);
    assert.ok(
      rows.some(
        (r: any) =>
          r.kind === "contribution" &&
          r.data.remoteKey === key &&
          r.data.status === "running",
      ),
    );
    yield { type: "run.started", run_id: key };
    yield { type: "text.delta", run_id: key, text: "测试成果，仅用于链路验收" };
    yield { type: "run.completed", run_id: key };
  });
  const host = await DurableRuntime.open(leases, identity(), s.id, model);
  const input = submission();
  let run: Run;
  try {
    run = await host.submit(input);
    await host.settled(run.workId);
    assert.equal(calls, 3);
    assert.equal(host.store.require<Run>("run", run.id).status, "succeeded");
    assert.equal((await host.submit(input)).id, run.id);
    await host.settled(run.workId);
    assert.equal(calls, 3);
  } finally {
    await host.close();
  }
  // Multiple shutdown signals join the same finished close operation.
  assert.equal(host.close(), host.close());
  await host.close();
  const reopened = await DurableRuntime.open(leases, identity(), s.id, model);
  try {
    assert.equal(
      reopened.store.require<Run>("run", run!.id).status,
      "succeeded",
    );
    assert.equal(reopened.store.all<ArtifactVersion>("version").length, 1);
    assert.equal((await reopened.submit(input)).id, run!.id);
    await reopened.settled(run!.workId);
    assert.equal(calls, 3);
  } finally {
    await reopened.close();
  }
});

test("failure to commit a submission stops execution before any external model call", async () => {
  const s = await serialSpace(),
    leases = new ExecutionLeases(db);
  let calls = 0;
  const model = remoteFixture(async function* (_prompt, key) {
    calls++;
    yield { type: "run.completed", run_id: key };
  });
  const host = await DurableRuntime.open(leases, identity(), s.id, model);
  const before = (await request("alpha", `/v1/workspaces/${s.id}`)).body;
  await owner.query(
    `ALTER TABLE ytriple.workspaces ADD CONSTRAINT fixture_checkpoint_failure CHECK (id <> '${s.id}'::uuid OR revision <= ${before.workspace.revision})`,
  );
  try {
    await assert.rejects(host.submit(submission()));
    const workId = host.store.all<any>("work")[0].id;
    await assert.rejects(host.settled(workId));
    assert.equal(calls, 0);
    const after = (await request("alpha", `/v1/workspaces/${s.id}`)).body;
    assert.equal(after.workspace.revision, before.workspace.revision);
    assert.equal(after.data.runs.length, 0);
  } finally {
    await owner.query(
      "ALTER TABLE ytriple.workspaces DROP CONSTRAINT fixture_checkpoint_failure",
    );
    await host.close().catch(() => {});
  }
});

test("takeover recovers an uncertain call by its original key, rejects late output and resumes only remaining stages", async () => {
  const s = await serialSpace(),
    leases = new ExecutionLeases(db);
  const started = gate(),
    finishOld = gate();
  let oldCalls = 0,
    newCalls = 0,
    lookedUp = "";
  const oldModel = remoteFixture(async function* (_prompt, key) {
    oldCalls++;
    yield { type: "run.started", run_id: key };
    started.resolve();
    await finishOld.promise; // Deliberately ignores abort to model a delayed network callback.
    yield { type: "text.delta", run_id: key, text: "迟到结果不能覆盖" };
    yield { type: "run.completed", run_id: key };
  });
  const first = await DurableRuntime.open(leases, identity(), s.id, oldModel);
  let second: DurableRuntime | undefined;
  try {
    const input = submission(),
      run = await first.submit(input);
    await started.promise;
    const originalKey = first.store.all<any>("contribution")[0].remoteKey;
    await expire(s.id);
    const nextModel = remoteFixture(async function* (_prompt, key) {
      newCalls++;
      assert.notEqual(key, originalKey);
      yield { type: "run.started", run_id: key };
      yield { type: "text.delta", run_id: key, text: "接续成果，保留原贡献" };
      yield { type: "run.completed", run_id: key };
    });
    nextModel.lookupByKey = async (key) => {
      lookedUp = key;
      return {
        id: key,
        status: "succeeded",
        result: { text: "原请求已经完成" },
        error: null,
      };
    };
    nextModel.lookup = async (id) => nextModel.lookupByKey!(id);
    second = await DurableRuntime.open(leases, identity(), s.id, nextModel);
    assert.equal(second.store.require<Run>("run", run.id).status, "unknown");
    assert.equal(newCalls, 0);
    finishOld.resolve();
    await assert.rejects(first.settled(run.workId));
    assert.equal(second.store.all<ArtifactVersion>("version").length, 0);
    await second.reconcile(run.id);
    assert.equal(lookedUp, originalKey);
    assert.equal(newCalls, 0);
    await second.resume(run.workId);
    await second.settled(run.workId);
    assert.equal(oldCalls, 1);
    assert.equal(newCalls, 2);
    const snapshot = (await request("alpha", `/v1/workspaces/${s.id}`)).body
      .data;
    assert.equal(
      snapshot.runs.find((r: any) => r.id === run.id).status,
      "succeeded",
    );
    assert.equal(snapshot.versions.length, 1);
    assert.ok(!JSON.stringify(snapshot).includes("迟到结果不能覆盖"));
  } finally {
    finishOld.resolve();
    await first.close().catch(() => {});
    await second?.close();
  }
});

test("adaptive delegation persists captured prompts and nested relationships before each remote request", async () => {
  const s = await space(),
    leases = new ExecutionLeases(db);
  let calls = 0;
  const model = remoteFixture(async function* (prompt, key) {
    calls++;
    const data = (
      await owner.query("SELECT state FROM ytriple.workspaces WHERE id=$1", [
        s.id,
      ])
    ).rows[0].state;
    const rows = data.entities.map((r: any) => ({
      kind: r.kind,
      data: JSON.parse(r.data),
    }));
    assert.ok(
      rows.some(
        (r: any) =>
          r.kind === "model-input" &&
          r.data.remoteKey === key &&
          r.data.prompt.taskId === prompt.taskId,
      ),
    );
    const depth = (prompt.taskId.match(/:d:/g) ?? []).length;
    const body =
      depth === 0 && prompt.taskId.endsWith(":t0:a0")
        ? JSON.stringify({
            ytriple_delegate: {
              memberId: "researcher",
              objective: "核对已知限制",
              context: "只使用已知资料",
              references: [],
            },
          })
        : depth === 1
          ? "无外部资料，不能声称已经调查。"
          : "负责人吸收返回，保留依据限制。";
    yield { type: "run.started", run_id: key };
    yield { type: "text.delta", run_id: key, text: body };
    yield { type: "run.completed", run_id: key };
  });
  const host = await DurableRuntime.open(leases, identity(), s.id, model);
  try {
    const run = await host.submit(submission());
    await host.settled(run.workId);
    assert.equal(host.store.require<Run>("run", run.id).status, "succeeded");
    assert.equal(calls, 3);
    const snapshot = (await request("alpha", `/v1/workspaces/${s.id}`)).body
      .data;
    assert.equal(snapshot.works.length, 1);
    assert.equal(snapshot.versions.length, 1);
    assert.ok(snapshot.contributions.some((c: any) => c.task?.depth === 1));
    assert.ok(snapshot.contributions.some((c: any) => c.task?.returnedFrom));
  } finally {
    await host.close();
  }
});

test("a pending decision survives execution host restart and its answer is committed before continuation", async () => {
  const s = await space(),
    leases = new ExecutionLeases(db);
  let calls = 0;
  const model = remoteFixture(async function* (_prompt, key) {
    calls++;
    if (calls > 1) {
      const persisted = (
        await owner.query("SELECT state FROM ytriple.workspaces WHERE id=$1", [
          s.id,
        ])
      ).rows[0].state;
      assert.ok(
        persisted.entities.some((r: any) => r.kind === "decision-answer"),
      );
    }
    const text =
      calls === 1
        ? JSON.stringify({
            ytriple_decision: {
              question: "采用哪个交付范围？",
              reason: "目标存在取舍",
              impact: "只影响当前工作",
              options: [
                { label: "简版", detail: "先验证主线" },
                { label: "完整版", detail: "包括补充分析" },
              ],
            },
          })
        : "根据已提交答复形成简版成果。";
    yield { type: "run.started", run_id: key };
    yield { type: "text.delta", run_id: key, text };
    yield { type: "run.completed", run_id: key };
  });
  const first = await DurableRuntime.open(leases, identity(), s.id, model);
  let run: Run;
  try {
    run = await first.submit(submission());
    await first.settled(run.workId);
    assert.equal(first.store.require<Run>("run", run.id).status, "waiting");
  } finally {
    await first.close();
  }
  const next = await DurableRuntime.open(leases, identity(), s.id, model);
  try {
    assert.equal(calls, 1);
    const decision = next.store.all<any>("decision")[0];
    const answer = {
      decisionId: decision.id,
      revision: decision.revision,
      draftRevision: decision.draftRevision,
      key: randomUUID(),
      text: "简版",
    };
    await next.answerDecision(answer);
    await next.settled(run!.workId);
    assert.equal(next.store.require<Run>("run", run!.id).status, "succeeded");
    assert.equal(calls, 2);
    await next.answerDecision(answer);
    await next.settled(run!.workId);
    assert.equal(calls, 2);
    assert.equal(next.store.all<ArtifactVersion>("version").length, 1);
  } finally {
    await next.close();
  }
});

test("a killed worker process leaves a durable original call which the replacement reconciles without replay", async () => {
  const s = await serialSpace();
  const child = fork(
    new URL("./fixtures/execution-process.ts", import.meta.url),
    [s.id, subject("alpha"), users.alpha],
    {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { PATH: process.env.PATH },
    },
  );
  let diagnostics = "";
  child.stderr?.on("data", (chunk) => {
    diagnostics += String(chunk).slice(0, 4000);
  });
  const exit = once(child, "exit");
  let accepted: { runId: string; workId: string } | undefined,
    originalKey = "";
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            Error("Fixture process did not persist a call: " + diagnostics),
          ),
        10000,
      );
      child.on("message", (message: any) => {
        if (message.type === "accepted") accepted = message;
        if (message.type === "calling") originalKey = message.key;
        if (accepted && originalKey) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        if (!accepted || !originalKey) reject(Error(diagnostics));
      });
    });
    child.kill("SIGKILL");
    const [, signal] = await exit;
    assert.equal(signal, "SIGKILL");
    const before = (await request("alpha", `/v1/workspaces/${s.id}`)).body.data;
    assert.equal(
      before.runs.find((r: any) => r.id === accepted!.runId).status,
      "running",
    );
    assert.ok(
      before.contributions.some(
        (c: any) => c.remoteKey === originalKey && c.remoteId === originalKey,
      ),
    );
    const leases = new ExecutionLeases(db);
    await assert.rejects(leases.acquire(identity(), s.id), {
      code: "SPACE_EXECUTING",
    });
    await expire(s.id); // Advance only this isolated fixture's lease; no wall-clock sleep.
    let calls = 0,
      lookups = 0;
    const model = remoteFixture(async function* (_prompt, key) {
      assert.notEqual(key, originalKey);
      calls++;
      yield { type: "run.started", run_id: key };
      yield { type: "text.delta", run_id: key, text: "进程接管后的测试成果" };
      yield { type: "run.completed", run_id: key };
    });
    model.lookup = async (id) => {
      assert.equal(id, originalKey);
      lookups++;
      return {
        status: "succeeded",
        result: { text: "被中断客户端的原请求已完成" },
        error: null,
      };
    };
    const replacement = await DurableRuntime.open(
      leases,
      identity(),
      s.id,
      model,
    );
    try {
      assert.equal(
        replacement.store.require<Run>("run", accepted!.runId).status,
        "unknown",
      );
      assert.equal(calls, 0);
      await replacement.reconcile(accepted!.runId);
      assert.equal(lookups, 1);
      await replacement.resume(accepted!.workId);
      await replacement.settled(accepted!.workId);
      assert.equal(calls, 2);
      assert.equal(
        replacement.store.require<Run>("run", accepted!.runId).status,
        "succeeded",
      );
      assert.equal(replacement.store.all<ArtifactVersion>("version").length, 1);
    } finally {
      await replacement.close();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await exit;
  }
});
