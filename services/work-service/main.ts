import { WorkServer } from "./server.js";
import { upstreamModelSchema } from "./provider.js";
import { z } from "zod";
import {
  mkdirSync,
  openSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  closeSync,
} from "node:fs";
import path from "node:path";

const directory = path.resolve(
  process.env.WORK_DATA_DIR ?? ".local/work-service",
);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const lock = path.join(directory, "server.lock");
try {
  const pid = Number(readFileSync(lock, "utf8"));
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch {
    /* A previous service process exited. */
  }
  if (alive)
    throw new Error("该资料目录已有服务进程，不能同时启动多个执行器。");
  unlinkSync(lock);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const descriptor = openSync(lock, "wx", 0o600);
writeFileSync(descriptor, String(process.pid));
closeSync(descriptor);
const models = z
  .array(upstreamModelSchema)
  .min(1)
  .parse(JSON.parse(process.env.WORK_MODELS_JSON ?? "[]"));
const service = new WorkServer({
  directory,
  models,
  allowHttpUpstream: process.env.WORK_ALLOW_HTTP_UPSTREAM === "1",
});
const port = Number(process.env.WORK_PORT ?? 8788),
  host = process.env.WORK_HOST ?? "127.0.0.1";
await service.listen(port, host);
process.stdout.write(`ytriple work-service listening on ${host}:${port}\n`);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void service.close().finally(() => {
      unlinkSync(lock);
      process.exit(0);
    });
  });
