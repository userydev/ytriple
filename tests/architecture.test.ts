import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The runtime boundary contract enforced as a test rather than as a convention.
 * These rules are what let the same core run under Tauri, under Node and on a
 * server, and what keeps a second orchestration implementation from appearing.
 */
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const ENVIRONMENT_AGNOSTIC_PACKAGES = ["packages/core/src", "packages/shared/src"];

/**
 * Module scope in core must hold nothing that can change. A `const cache = new
 * Map()` is process-wide mutable state just as much as a `let`, and the earlier
 * rule only looked for `let`, so a compiled-glob cache sat in core unnoticed.
 */
const MODULE_STATE_RULES: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /^(export\s+)?let\s/, why: "module-level let" },
  { pattern: /^(export\s+)?var\s/, why: "module-level var" },
  {
    pattern:
      /^(export\s+)?const\s+\w+\s*(?::(?!\s*(?:Readonly|readonly))[^=]+)?=\s*new\s+(Map|Set|WeakMap|WeakSet)\b/,
    why: "module-level mutable container",
  },
  {
    pattern: /^(export\s+)?const\s+\w+\s*(?::(?!\s*(?:Readonly|readonly))[^=]+)?=\s*\[\s*\]/,
    why: "module-level mutable array",
  },
];

function moduleStateViolation(line: string): string | undefined {
  return MODULE_STATE_RULES.find((rule) => rule.pattern.test(line))?.why;
}

function collectFiles(directory: string, ...extensions: string[]): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const absolute = join(directory, entry);
    if (statSync(absolute).isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry === "dist-web" || entry === "target") {
        continue;
      }
      files.push(...collectFiles(absolute, ...extensions));
      continue;
    }
    if (extensions.some((extension) => entry.endsWith(extension))) files.push(absolute);
  }
  return files;
}

function collectTypeScriptFiles(directory: string): string[] {
  return collectFiles(directory, ".ts", ".tsx");
}

const IMPORT_PATTERN = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

const NODE_BUILTINS = new Set([
  "fs",
  "path",
  "os",
  "url",
  "crypto",
  "child_process",
  "http",
  "https",
  "process",
  "stream",
  "util",
]);

const FORBIDDEN_GLOBALS = [
  { pattern: /\bDate\.now\s*\(/, why: "read the clock through ClockPort" },
  { pattern: /\bnew Date\s*\(\s*\)/, why: "read the clock through ClockPort" },
  { pattern: /\bMath\.random\s*\(/, why: "ids are derived from a per-task counter" },
  { pattern: /\bsetTimeout\s*\(/, why: "wait through ClockPort.sleep" },
  { pattern: /\bsetInterval\s*\(/, why: "core owns no timers" },
  { pattern: /(?<![.\w])fetch\s*\(/, why: "reach the network through HttpPort" },
  { pattern: /\bprocess\.env\b/, why: "core reads no environment" },
  { pattern: /\bwindow\./, why: "core has no browser globals" },
  { pattern: /\bdocument\./, why: "core has no browser globals" },
  { pattern: /\blocalStorage\b/, why: "persist through StoragePort" },
];

describe("environment-agnostic core", () => {
  for (const packagePath of ENVIRONMENT_AGNOSTIC_PACKAGES) {
    const files = collectTypeScriptFiles(join(repoRoot, packagePath));

    it(`${packagePath} imports no host capability`, () => {
      const offenders: string[] = [];
      for (const file of files) {
        const source = readFileSync(file, "utf8");
        for (const match of source.matchAll(IMPORT_PATTERN)) {
          const specifier = match[1] ?? "";
          const forbidden =
            specifier.startsWith("node:") ||
            specifier.startsWith("@tauri-apps/") ||
            NODE_BUILTINS.has(specifier);
          if (forbidden) offenders.push(`${file.replace(repoRoot, "")} -> ${specifier}`);
        }
      }
      expect(offenders).toEqual([]);
    });

    it(`${packagePath} touches no ambient global`, () => {
      const offenders: string[] = [];
      for (const file of files) {
        // Test files may use whatever they need; the shipped source may not.
        if (file.endsWith(".test.ts")) continue;
        const source = readFileSync(file, "utf8");
        for (const { pattern, why } of FORBIDDEN_GLOBALS) {
          if (pattern.test(source)) {
            offenders.push(`${file.replace(repoRoot, "")}: ${pattern.source} (${why})`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  }

  it("core depends only on shared", () => {
    expect(Object.keys(dependenciesOf("packages/core"))).toEqual(["@ytriple/shared"]);
  });

  it("shared has no runtime dependencies", () => {
    expect(dependenciesOf("packages/shared")).toEqual({});
  });

  /**
   * A module-level `const cache = new Map()` is process-wide mutable state just
   * as much as a `let` is, and the earlier version of this rule only looked for
   * `let` — so a compiled-glob cache sat in core unnoticed. The rule now covers
   * mutable containers and top-level `var` too.
   */
  it("core holds no module-level mutable state", () => {
    const offenders: string[] = [];
    for (const file of collectTypeScriptFiles(join(repoRoot, "packages/core/src"))) {
      if (file.endsWith(".test.ts") || file.includes("/testing/")) continue;
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const violated = moduleStateViolation(line);
        if (violated) offenders.push(`${file.replace(repoRoot, "")}: ${violated} — ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the module-level-state rule catches the cache shape it used to miss", () => {
    // Guards the guard, against the real rule rather than a copy of it.
    expect(moduleStateViolation("const cache = new Map<string, RegExp>();")).toBe(
      "module-level mutable container",
    );
    expect(moduleStateViolation("export const seen = new Set();")).toBe(
      "module-level mutable container",
    );
    expect(moduleStateViolation("let counter = 0;")).toBe("module-level let");
    expect(moduleStateViolation("const pending: string[] = [];")).toBe(
      "module-level mutable array",
    );

    // A container whose type forbids mutation is a lookup table, not state.
    expect(moduleStateViolation('const S: ReadonlySet<string> = new Set(["a"]);')).toBeUndefined();
    expect(moduleStateViolation("const ROLES = Object.freeze({});")).toBeUndefined();
    expect(moduleStateViolation("  const local = new Map();")).toBeUndefined();
    expect(moduleStateViolation("const x: readonly string[] = [];")).toBeUndefined();
    // A typed-but-mutable container is still state.
    expect(moduleStateViolation("const c: Map<string, string> = new Map();")).toBe(
      "module-level mutable container",
    );
  });
});

describe("single source of orchestration truth", () => {
  /**
   * A host may call into core and render its events. What it may not do is
   * produce those events itself, implement the workflow, or assemble prompts —
   * that is how a second, competing runtime appears.
   */
  const ORCHESTRATION_MARKERS = [
    { pattern: /intake_brief_dispatch_merge/, why: "implements the workflow" },
    { pattern: /systemSections/, why: "assembles prompts" },
    { pattern: /\bemit\s*\(\s*\{\s*type:/, why: "synthesises runtime events" },
    { pattern: /responseSchema\s*:/, why: "talks to a model directly" },
  ];

  it("keeps orchestration out of every TypeScript host", () => {
    const offenders: string[] = [];
    for (const directory of ["apps/desktop/src", "apps/cli/src"]) {
      for (const file of collectTypeScriptFiles(join(repoRoot, directory))) {
        const source = readFileSync(file, "utf8");
        for (const { pattern, why } of ORCHESTRATION_MARKERS) {
          if (pattern.test(source)) {
            offenders.push(`${file.replace(repoRoot, "")}: ${why}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps orchestration out of the Tauri shell", () => {
    const rustMarkers = [
      /task_brief/i,
      /orchestrat/i,
      /system_prompt/i,
      /agent_definition/i,
      /dispatch/i,
    ];

    let files: string[];
    try {
      files = collectFiles(join(repoRoot, "src-tauri/src"), ".rs");
    } catch {
      return;
    }

    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const marker of rustMarkers) {
        if (marker.test(source)) offenders.push(`${file.replace(repoRoot, "")}: ${marker.source}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("defines the runtime in exactly one place", () => {
    const definitions: string[] = [];
    for (const directory of ["packages", "apps"]) {
      for (const file of collectTypeScriptFiles(join(repoRoot, directory))) {
        if (/export function createTaskRuntime/.test(readFileSync(file, "utf8"))) {
          definitions.push(file.replace(repoRoot, ""));
        }
      }
    }
    expect(definitions).toEqual(["packages/core/src/runtime/taskRuntime.ts"]);
  });

  it("gives FsPort no write method", () => {
    const source = readFileSync(join(repoRoot, "packages/shared/src/ports.ts"), "utf8");
    const fsPort = source.slice(
      source.indexOf("export interface FsPort"),
      source.indexOf("export interface WriteDocumentRequest"),
    );
    expect(fsPort).toContain("listFiles");
    expect(fsPort).not.toMatch(/write|create|delete|mkdir/i);
  });
});

function dependenciesOf(packagePath: string): Record<string, string> {
  const manifest: { dependencies?: Record<string, string> } = JSON.parse(
    readFileSync(join(repoRoot, packagePath, "package.json"), "utf8"),
  );
  return manifest.dependencies ?? {};
}
