export interface ParsedArgs {
  flags: Set<string>;
  values: Map<string, string>;
  positionals: string[];
}

const VALUE_FLAGS = new Set([
  "scenario",
  "input",
  "input-file",
  "config",
  "workspace",
  "out",
  "answers",
  "task-id",
  "record",
  "title",
]);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const withoutDashes = token.slice(2);
    const equals = withoutDashes.indexOf("=");
    if (equals >= 0) {
      values.set(withoutDashes.slice(0, equals), withoutDashes.slice(equals + 1));
      continue;
    }
    if (VALUE_FLAGS.has(withoutDashes)) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`--${withoutDashes} needs a value`);
      }
      values.set(withoutDashes, next);
      index += 1;
      continue;
    }
    flags.add(withoutDashes);
  }

  return { flags, values, positionals };
}

export const USAGE = `ytriple harness — run a full task without a UI

  npm run harness -- --scenario demo --out ./tmp
  npm run harness -- --input "an idea" --workspace . --out ./tmp
  npm run harness -- --preflight --probe

Run options
  --scenario <name>   replay a recorded run; needs no API key and no network
  --input <text>      the product idea to work on
  --input-file <path> read the idea from a file
  --config <path>     provider configuration JSON (defaults to the built-in providers)
  --workspace <dir>   expose a directory read-only to the team
  --out <dir>         where ytriple-outputs/<task-id>/prd.md is written (default: cwd)
  --answers <path>    JSON map of agentId or questionId to answer, for a scripted run
  --task-id <id>      fix the task id (default: derived from the clock)
  --title <text>      title for the generated document
  --record <path>     capture the run as a replayable scenario recording

Other options
  --preflight         run the configuration self-check and exit
  --probe             let --preflight make one live call per provider
  --json              print the event stream as JSON lines
  --verbose           include model usage events and debug logs
  --help              show this message
`;
