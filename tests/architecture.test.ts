import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function collectTypeScriptFiles(directory: string): string[] {
  const entries = readdirSync(directory);
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = join(directory, entry);
    if (statSync(absolute).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      files.push(...collectTypeScriptFiles(absolute));
      continue;
    }
    if (entry.endsWith(".ts")) files.push(absolute);
  }
  return files;
}

const IMPORT_PATTERN = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(IMPORT_PATTERN)].map((match) => match[1] ?? "");
}

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

describe("environment-agnostic core", () => {
  const environmentAgnosticPackages = ["packages/core/src", "packages/shared/src"];

  for (const packagePath of environmentAgnosticPackages) {
    it(`${packagePath} imports no host capabilities`, () => {
      const offenders: string[] = [];
      for (const file of collectTypeScriptFiles(join(repoRoot, packagePath))) {
        for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
          const forbidden =
            specifier.startsWith("node:") ||
            specifier.startsWith("@tauri-apps/") ||
            NODE_BUILTINS.has(specifier);
          if (forbidden) {
            offenders.push(`${file.replace(repoRoot, "")} -> ${specifier}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  }

  it("core depends only on shared", () => {
    const manifest: { dependencies?: Record<string, string> } = JSON.parse(
      readFileSync(join(repoRoot, "packages/core/package.json"), "utf8"),
    );
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(["@ytriple/shared"]);
  });

  it("shared has no runtime dependencies", () => {
    const manifest: { dependencies?: Record<string, string> } = JSON.parse(
      readFileSync(join(repoRoot, "packages/shared/package.json"), "utf8"),
    );
    expect(manifest.dependencies ?? {}).toEqual({});
  });
});
