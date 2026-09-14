import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { stdin, stdout } from "node:process";
import type {
  AgentAnswer,
  AgentQuestion,
  ClockPort,
  FileContent,
  FileEntry,
  FsPort,
  HttpPort,
  LoggerPort,
  OutputPort,
  SecretPort,
  TextMatch,
  UserPort,
} from "@ytriple/shared";
import { assertSafePathSegment, matchesAnyGlob } from "@ytriple/core";

/**
 * Node implementations of the ports core needs. All host knowledge lives here;
 * core sees only the interfaces.
 */

const ALWAYS_SKIPPED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  "target",
  ".venv",
  "__pycache__",
]);

export interface NodeFsPortOptions {
  root: string;
  maxFileBytes?: number;
}

/**
 * Read-only workspace rooted at one directory the user chose. Every path is
 * resolved through `realpath` before the containment check so a symlink cannot
 * be used to read outside the root.
 */
export function createNodeFsPort(options: NodeFsPortOptions): FsPort {
  const root = resolve(options.root);
  const maxFileBytes = options.maxFileBytes ?? 200_000;

  const toRelative = (absolute: string) => relative(root, absolute).split(sep).join("/");

  const resolveInsideRoot = async (relativePath: string): Promise<string> => {
    if (isAbsolute(relativePath) || relativePath.split("/").includes("..")) {
      throw new Error(`path "${relativePath}" must be relative to the workspace root`);
    }
    const absolute = resolve(root, relativePath);
    const realRoot = await realpath(root);
    const realTarget = await realpath(absolute);
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
      throw new Error(`path "${relativePath}" resolves outside the workspace root`);
    }
    return realTarget;
  };

  const walk = async (
    directory: string,
    include: readonly string[] | undefined,
    exclude: readonly string[] | undefined,
    limit: number,
    collected: FileEntry[],
  ): Promise<void> => {
    if (collected.length >= limit) return;

    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (collected.length >= limit) return;
      const absolute = join(directory, entry.name);
      const path = toRelative(absolute);

      if (entry.isDirectory()) {
        if (ALWAYS_SKIPPED_DIRECTORIES.has(entry.name)) continue;
        if (exclude && matchesAnyGlob(exclude, `${path}/`)) continue;
        await walk(absolute, include, exclude, limit, collected);
        continue;
      }
      if (!entry.isFile()) continue;
      if (exclude && matchesAnyGlob(exclude, path)) continue;
      if (include && include.length > 0 && !matchesAnyGlob(include, path)) continue;

      const info = await stat(absolute);
      collected.push({ path, sizeBytes: info.size });
    }
  };

  return {
    rootLabel: root,
    async listFiles(request) {
      const collected: FileEntry[] = [];
      await walk(
        root,
        request.includeGlobs,
        request.excludeGlobs,
        request.maxResults ?? 500,
        collected,
      );
      return collected;
    },
    async readFile(request): Promise<FileContent> {
      const absolute = await resolveInsideRoot(request.path);
      const raw = await readFile(absolute, "utf8");
      const lines = raw.split("\n");
      const startLine = Math.max(1, request.startLine ?? 1);
      const endLine = Math.min(lines.length, request.endLine ?? lines.length);

      let content = lines.slice(startLine - 1, endLine).join("\n");
      let truncated = startLine > 1 || endLine < lines.length;
      const limit = request.maxBytes ?? maxFileBytes;
      if (content.length > limit) {
        content = content.slice(0, limit);
        truncated = true;
      }

      return { path: request.path, content, startLine, endLine, truncated };
    },
    async searchText(request): Promise<TextMatch[]> {
      const files: FileEntry[] = [];
      await walk(root, request.includeGlobs, request.excludeGlobs, 500, files);

      const needle = request.query.toLowerCase();
      const matches: TextMatch[] = [];
      const limit = request.maxResults ?? 50;

      for (const file of files) {
        if (matches.length >= limit) break;
        let raw: string;
        try {
          raw = await readFile(resolve(root, file.path), "utf8");
        } catch {
          continue;
        }
        const lines = raw.split("\n");
        for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
          const line = lines[index]!;
          if (line.toLowerCase().includes(needle)) {
            matches.push({ path: file.path, line: index + 1, snippet: line.slice(0, 300) });
          }
        }
      }

      return matches;
    },
  };
}

export interface NodeOutputPortOptions {
  /** Documents land in `<outputRoot>/ytriple-outputs/<taskId>/`. */
  outputRoot: string;
}

/** The only write channel. Refuses to overwrite an existing deliverable. */
export function createNodeOutputPort(options: NodeOutputPortOptions): OutputPort & {
  directoryFor(taskId: string): string;
} {
  const directoryFor = (taskId: string) => {
    // Defence in depth: core checks this too, but a host must never resolve an
    // unvalidated id into a path.
    assertSafePathSegment(taskId, "taskId");
    return resolve(options.outputRoot, "ytriple-outputs", taskId);
  };

  return {
    directoryFor,
    async writeDocument(request) {
      const directory = directoryFor(request.taskId);
      assertSafePathSegment(request.filename, "filename");
      const path = join(directory, request.filename);
      if (existsSync(path)) {
        throw new Error(`${path} already exists; yTriple never overwrites an output`);
      }
      await mkdir(directory, { recursive: true });
      await writeFile(path, request.content, "utf8");
      return { path };
    },
    async revealOutput() {
      // Nothing to reveal in a headless run; the desktop host opens the folder.
    },
  };
}

export function createNodeHttpPort(): HttpPort {
  return {
    async request(init) {
      const controller = new AbortController();
      const timeout = init.timeoutMs
        ? setTimeout(() => controller.abort(), init.timeoutMs)
        : undefined;

      try {
        const response = await fetch(init.url, {
          method: init.method,
          headers: init.headers,
          ...(init.body === undefined ? {} : { body: init.body }),
          signal: controller.signal,
        });
        return {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body: await response.text(),
        };
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    },
  };
}

/** Environment-backed secrets. The desktop host uses the system keyring instead. */
export function createEnvSecretPort(env: NodeJS.ProcessEnv): SecretPort {
  return {
    async resolve(credentialRef) {
      const value = env[credentialRef];
      if (!value) {
        throw new Error(`environment variable ${credentialRef} is not set`);
      }
      return value;
    },
  };
}

export function createSystemClock(): ClockPort {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  };
}

export function createConsoleLogger(verbose: boolean): LoggerPort {
  return {
    log(level, event, fields) {
      if (!verbose && level === "debug") return;
      process.stderr.write(`${level} ${event} ${JSON.stringify(fields)}\n`);
    },
  };
}

/** Prompts on the terminal; the desktop host puts the questions in the chat. */
export function createStdinUserPort(): UserPort {
  return {
    async askQuestions(questions) {
      const rl = createInterface({ input: stdin, output: stdout });
      try {
        const answers: AgentAnswer[] = [];
        for (const question of questions) {
          const text = await rl.question(
            `\n${question.agentDisplayName} asks: ${question.question}\n  (${question.reason})\n> `,
          );
          answers.push({ questionId: question.questionId, text });
        }
        return answers;
      } finally {
        rl.close();
      }
    },
  };
}

/**
 * Non-interactive answers, keyed by agentId or question id. Anything unmatched
 * gets the fallback, so a scripted run never blocks.
 */
export function createFileUserPort(
  answers: Record<string, string>,
  fallback = "No extra detail. Proceed on your best assumption and record it.",
): UserPort & { readonly asked: AgentQuestion[] } {
  const asked: AgentQuestion[] = [];
  return {
    asked,
    async askQuestions(questions) {
      asked.push(...questions);
      return questions.map((question) => ({
        questionId: question.questionId,
        text: answers[question.questionId] ?? answers[question.agentId] ?? fallback,
      }));
    },
  };
}
