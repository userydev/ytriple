import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ProviderAdapter, RuntimeCapabilities, UserPort } from "@ytriple/shared";
import {
  createDefaultTeam,
  createTaskRuntime,
  type TaskRunResult,
  type TaskRuntimePorts,
} from "@ytriple/core";
import {
  createModelRouter,
  createRecordingAdapter,
  createReplayAdapter,
  formatPreflightReport,
  preflightConfig,
  type PreflightReport,
  type ProviderRecording,
} from "@ytriple/providers";
import { USAGE, parseArgs } from "./args.js";
import { loadConfig } from "./config.js";
import {
  createConsoleLogger,
  createEnvSecretPort,
  createFileUserPort,
  createNodeFsPort,
  createNodeHttpPort,
  createNodeOutputPort,
  createStdinUserPort,
  createSystemClock,
} from "./nodePorts.js";
import { renderEvent, renderSummary, summaryFor } from "./render.js";
import { loadScenario, scenarioToRecording } from "./scenario.js";

export interface HarnessIo {
  write(text: string): void;
  isInteractive?: boolean;
}

export interface HarnessOutcome {
  exitCode: number;
  result?: TaskRunResult;
  preflight?: PreflightReport;
}

/**
 * The headless host.
 *
 * It owns exactly what a host is supposed to own: ports, transport and
 * configuration. Every decision about how a task runs lives in
 * `@ytriple/core`, so a run here and a run in the desktop app go through the
 * same code.
 */
export async function runHarness(
  argv: readonly string[],
  io: HarnessIo,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HarnessOutcome> {
  const args = parseArgs(argv);

  if (args.flags.has("help") || (argv.length === 0 && !io.isInteractive)) {
    io.write(USAGE);
    return { exitCode: 0 };
  }

  const config = await loadConfig(args.values.get("config"));
  const http = createNodeHttpPort();
  const secrets = createEnvSecretPort(env);
  const verbose = args.flags.has("verbose");

  if (args.flags.has("preflight")) {
    const report = await preflightConfig(
      config,
      { http, secrets },
      { runHealthChecks: args.flags.has("probe"), now: () => Date.now() },
    );
    io.write(`${formatPreflightReport(report)}\n`);
    return { exitCode: report.status === "fail" ? 1 : 0, preflight: report };
  }

  const scenarioName = args.values.get("scenario");
  const scenario = scenarioName ? await loadScenario(scenarioName) : undefined;

  const userInput =
    args.values.get("input") ??
    (args.values.has("input-file")
      ? await readFile(args.values.get("input-file")!, "utf8")
      : undefined) ??
    scenario?.userInput;

  if (!userInput) {
    io.write("Nothing to work on: pass --input, --input-file or --scenario.\n\n");
    io.write(USAGE);
    return { exitCode: 2 };
  }

  const workspaceRoot = args.values.get("workspace");
  const outputRoot = resolve(args.values.get("out") ?? process.cwd());
  const taskId = args.values.get("task-id") ?? `task-${Date.now().toString(36)}`;

  const output = createNodeOutputPort({ outputRoot });
  const ports: TaskRuntimePorts = {
    output,
    clock: createSystemClock(),
    user: await resolveUserPort(args, io, scenario?.answers),
    logger: createConsoleLogger(verbose),
    ...(workspaceRoot ? { fs: createNodeFsPort({ root: resolve(workspaceRoot) }) } : {}),
  };

  const capabilities: RuntimeCapabilities = {
    workspaceRead: Boolean(workspaceRoot),
    outputWrite: true,
    webSearch: true,
    localModels: true,
    persistentBackgroundRuns: false,
    streaming: false,
  };

  const recordings: ProviderRecording[] = [];
  const resolveBinding = scenario
    ? replayResolver(scenarioToRecording(scenario))
    : liveResolver();

  const runtime = createTaskRuntime({
    taskId,
    team: createDefaultTeam(config.defaultModel),
    config,
    capabilities,
    ports,
    resolveBinding,
  });

  runtime.subscribe((event) => {
    if (args.flags.has("json")) {
      io.write(`${JSON.stringify(event)}\n`);
      return;
    }
    const line = renderEvent(event, verbose);
    if (line) io.write(`${line}\n`);
  });

  const result = await runtime.run({
    userInput: userInput.trim(),
    ...(args.values.has("title") ? { title: args.values.get("title")! } : {}),
    ...(scenario?.title && !args.values.has("title") ? { title: scenario.title } : {}),
  });

  io.write(`${renderSummary(summaryFor(result))}\n`);

  const recordPath = args.values.get("record");
  if (recordPath && recordings[0]) {
    await writeFile(recordPath, `${JSON.stringify(recordings[0], null, 2)}\n`, "utf8");
    io.write(`recording      ${recordPath}\n`);
  }

  return { exitCode: result.status === "completed" ? 0 : 1, result };

  function replayResolver(recording: ProviderRecording) {
    const adapter = createReplayAdapter(recording);
    return async () => ({
      adapter,
      model: { modelId: "recorded", displayName: "Recorded model" },
    });
  }

  function liveResolver() {
    const router = createModelRouter(config, { http, secrets });
    const wrapped = new Map<string, ProviderAdapter>();

    return async (binding: Parameters<typeof router.resolve>[0]) => {
      const resolved = await router.resolve(binding);
      if (!args.values.has("record")) return resolved;

      const key = binding.providerId;
      const existing = wrapped.get(key);
      if (existing) return { adapter: existing, model: resolved.model };

      const recorder = createRecordingAdapter({
        inner: resolved.adapter,
        model: resolved.model,
      });
      wrapped.set(key, recorder);
      recordings.push(recorder.recording);
      return { adapter: recorder, model: resolved.model };
    };
  }
}

async function resolveUserPort(
  args: ReturnType<typeof parseArgs>,
  io: HarnessIo,
  scenarioAnswers: Record<string, string> | undefined,
): Promise<UserPort> {
  const answersPath = args.values.get("answers");
  if (answersPath) {
    const answers = JSON.parse(await readFile(answersPath, "utf8")) as Record<string, string>;
    return createFileUserPort(answers);
  }
  if (scenarioAnswers) return createFileUserPort(scenarioAnswers);
  if (io.isInteractive) return createStdinUserPort();

  // Non-interactive and unscripted: answer once so the run never blocks, and
  // let the orchestrator record the gap as an assumption.
  return createFileUserPort({});
}
