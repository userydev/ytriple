import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { database } from "../src/db.ts";
export async function migrate(url: string) {
  const db = database(url);
  try {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('ytriple-migrations'))",
      );
      await client.query(`CREATE SCHEMA IF NOT EXISTS ytriple_migrations;
        REVOKE ALL ON SCHEMA ytriple_migrations FROM PUBLIC;
        CREATE TABLE IF NOT EXISTS ytriple_migrations.applied(name text PRIMARY KEY)`);
      await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ytriple_migrations FROM PUBLIC;
        DO $$ DECLARE client_role text; BEGIN
          FOREACH client_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=client_role) THEN
              EXECUTE format('REVOKE ALL ON SCHEMA ytriple_migrations FROM %I',client_role);
              EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA ytriple_migrations FROM %I',client_role);
            END IF;
          END LOOP;
        END $$;`);
      const directory = new URL(
        "../../../supabase/migrations/",
        import.meta.url,
      );
      for (const name of (await readdir(directory))
        .filter((f) => /^\d+_[a-z_]+\.sql$/.test(f))
        .sort()) {
        if (
          (
            await client.query(
              "SELECT 1 FROM ytriple_migrations.applied WHERE name=$1",
              [name],
            )
          ).rowCount
        )
          continue;
        await client.query(await readFile(new URL(name, directory), "utf8"));
        await client.query(
          "INSERT INTO ytriple_migrations.applied VALUES($1)",
          [name],
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } finally {
    await db.end();
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url)
    throw Error("MIGRATION_DATABASE_URL required; runtime must not migrate");
  await migrate(url);
  console.log("ytriple private schema migrations applied.");
}
