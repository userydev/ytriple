import { spawn } from "node:child_process";
const build = spawn(process.execPath, ["scripts/build.mjs"], {
  stdio: "inherit",
});
const code = await new Promise((resolve) => build.on("exit", resolve));
if (code) process.exit(Number(code));
const electron = (await import("electron")).default;
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ["."], { stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGINT", () => child.kill("SIGINT"));
