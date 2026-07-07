import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createArkResponsesProvider } from "../src/runtime/arkResponsesProvider";
import { runPrdTask } from "../src/runtime/taskRuntime";

interface CliArgs {
  input?: string;
  inputFile?: string;
  workspaceRoot?: string;
  outputRoot: string;
}

async function main() {
  await loadLocalEnv();

  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.ARK_API_KEY;
  const model = process.env.ARK_MODEL || "doubao-seed-2-1-pro-260628";

  if (!apiKey) {
    throw new Error("ARK_API_KEY is required. Export it in your shell before running this command.");
  }

  const userInput = args.inputFile
    ? await readFile(resolve(args.inputFile), "utf8")
    : args.input;

  if (!userInput?.trim()) {
    throw new Error('Provide a PRD idea with --input "..." or --input-file ./brief.md');
  }

  if (args.workspaceRoot && !existsSync(resolve(args.workspaceRoot))) {
    throw new Error(`Workspace does not exist: ${args.workspaceRoot}`);
  }

  await mkdir(resolve(args.outputRoot), { recursive: true });

  const provider = createArkResponsesProvider({
    apiKey,
    model,
    baseUrl: process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3",
    enableWebSearch: process.env.ARK_ENABLE_WEB_SEARCH !== "false",
    webSearchMaxKeyword: Number(process.env.ARK_WEB_SEARCH_MAX_KEYWORD || "2"),
    webSearchLimit: Number(process.env.ARK_WEB_SEARCH_LIMIT || "5"),
  });

  const result = await runPrdTask({
    userInput,
    workspaceRoot: args.workspaceRoot ? resolve(args.workspaceRoot) : undefined,
    outputRoot: resolve(args.outputRoot),
    provider,
    webSearch: async () => ({ results: [] }),
    onStatusChange: (status) => {
      process.stderr.write(`[yTriple] ${status}\n`);
    },
  });

  process.stdout.write(
    JSON.stringify(
      {
        taskId: result.task.taskId,
        status: result.task.status,
        artifactsDir: result.task.artifactsDir,
        files: result.deliveryPackage.files.map((file) => file.filename),
      },
      null,
      2,
    ),
  );
  process.stdout.write("\n");
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    outputRoot: process.cwd(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];

    if (token === "--input") {
      args.input = requiredValue(token, next);
      index += 1;
    } else if (token === "--input-file") {
      args.inputFile = requiredValue(token, next);
      index += 1;
    } else if (token === "--workspace-root") {
      args.workspaceRoot = requiredValue(token, next);
      index += 1;
    } else if (token === "--output-root") {
      args.outputRoot = requiredValue(token, next);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }

  return args;
}

function requiredValue(flag: string, value?: string) {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

async function loadLocalEnv() {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) {
    return;
  }

  const content = await readFile(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex < 1) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim().replace(/^["']|["']$/g, "");
    process.env[key] ??= value;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
