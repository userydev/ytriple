import { database, assertRuntimeRole } from "./db.ts";
import { coreAuthorization } from "./auth.ts";
import { Workspaces } from "./workspaces.ts";
import { createApp } from "./app.ts";
const databaseUrl = process.env.DATABASE_URL,
  coreUrl = process.env.YCORE_BASE_URL;
if (!databaseUrl || !coreUrl)
  throw Error("DATABASE_URL and YCORE_BASE_URL required");
const authorize = coreAuthorization(coreUrl),
  db = database(databaseUrl);
try {
  await assertRuntimeRole(db);
  const app = createApp(new Workspaces(db), authorize, true);
  await app.listen({
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 4320),
  });
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      await app.close();
      await db.end();
      process.exit(0);
    });
} catch {
  await db.end();
  throw Error(
    "Product service failed to start; verify database role and configuration",
  );
}
