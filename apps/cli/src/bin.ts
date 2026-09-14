#!/usr/bin/env node
import { argv, exit, stdin, stdout } from "node:process";
import { runHarness } from "./main.js";

const outcome = await runHarness(
  argv.slice(2),
  {
    write: (text) => stdout.write(text),
    isInteractive: stdin.isTTY === true,
  },
).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  return { exitCode: 1 };
});

exit(outcome.exitCode);
