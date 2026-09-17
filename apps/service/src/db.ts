import pg from "pg";
import { readFileSync } from "node:fs";
export function database(url: string) {
  const target = new URL(url);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname);
  for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert"])
    target.searchParams.delete(key);
  return new pg.Pool({
    connectionString: target.toString(),
    max: 8,
    connectionTimeoutMillis: 8000,
    ssl: local
      ? false
      : {
          rejectUnauthorized: true,
          ...(process.env.DATABASE_CA_FILE
            ? { ca: readFileSync(process.env.DATABASE_CA_FILE, "utf8") }
            : {}),
        },
  });
}
export async function transaction<T>(
  db: pg.Pool,
  subject: string,
  fn: (client: pg.PoolClient) => Promise<T>,
) {
  const client = await db.connect();
  let broken = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('ytriple.subject',$1,true)", [
      subject,
    ]);
    await client.query(
      "SET LOCAL statement_timeout='8s'; SET LOCAL lock_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='15s'",
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      broken = true;
    }
    throw error;
  } finally {
    client.release(broken);
  }
}
export async function assertRuntimeRole(db: pg.Pool) {
  const result =
    await db.query(`SELECT current_user AS name,rolsuper,rolbypassrls,rolcreaterole,
    pg_has_role(current_user,c.nspowner,'MEMBER') AS owns_schema
    FROM pg_roles r CROSS JOIN pg_namespace c WHERE r.rolname=current_user AND c.nspname='ytriple'`);
  const row = result.rows[0];
  if (
    !row ||
    row.name !== "ytriple_runtime" ||
    row.rolsuper ||
    row.rolbypassrls ||
    row.rolcreaterole ||
    row.owns_schema
  )
    throw Error("Service requires the restricted ytriple_runtime role");
}
