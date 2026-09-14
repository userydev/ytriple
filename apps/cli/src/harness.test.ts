import { mkdtemp, readFile, readdir, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEMO_SCENARIO, scenarioToRecording } from "@ytriple/providers";
import { parseArgs } from "./args.js";
import { runHarness, type HarnessIo } from "./main.js";
import { createNodeFsPort, createNodeOutputPort } from "./nodePorts.js";


function collectingIo(): HarnessIo & { readonly text: string } {
  const chunks: string[] = [];
  return {
    write: (text) => chunks.push(text),
    isInteractive: false,
    get text() {
      return chunks.join("");
    },
  };
}

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe("parseArgs", () => {
  it("reads values, equals form and bare flags", () => {
    const args = parseArgs(["--scenario", "demo", "--out=/tmp/x", "--verbose"]);
    expect(args.values.get("scenario")).toBe("demo");
    expect(args.values.get("out")).toBe("/tmp/x");
    expect(args.flags.has("verbose")).toBe(true);
  });

  it("refuses a value flag with no value", () => {
    expect(() => parseArgs(["--input", "--verbose"])).toThrowError(/--input needs a value/);
  });
});

describe("the demo scenario", () => {
  it("runs a whole task offline and writes exactly one deliverable", async () => {
    const out = await tempDir("ytriple-harness-");
    const io = collectingIo();

    const outcome = await runHarness(
      ["--scenario", "demo", "--out", out, "--task-id", "demo-task"],
      io,
      {},
    );

    expect(outcome.exitCode).toBe(0);
    expect(outcome.result?.status).toBe("completed");

    const written = await readdir(join(out, "ytriple-outputs", "demo-task"));
    expect(written).toEqual(["prd.md"]);

    const markdown = await readFile(join(out, "ytriple-outputs", "demo-task", "prd.md"), "utf8");
    for (const heading of [
      "## Product Summary",
      "## Problem / Background",
      "## Target Users",
      "## Core Scenario",
      "## V1 Scope",
      "## Non-goals",
      "## Functional Requirements",
      "## UX / Interaction Requirements",
      "## Success Criteria",
      "## Assumptions and Open Questions",
      "## Source Notes",
    ]) {
      expect(markdown).toContain(heading);
    }
  });

  it("streams the real event sequence to stdout", async () => {
    const out = await tempDir("ytriple-harness-");
    const io = collectingIo();

    await runHarness(["--scenario", "demo", "--out", out], io, {});

    expect(io.text).toContain("[status] chatting");
    expect(io.text).toContain("[status] agent_questioning");
    expect(io.text).toContain("[brief]");
    expect(io.text).toContain("dispatched:");
    expect(io.text).toContain("[artifact] prd.md ->");
    expect(io.text).toContain("[status] completed");
    expect(io.text).toContain("contributions  researcher:research_contribution");
  });

  it("emits one JSON line per event with --json", async () => {
    const out = await tempDir("ytriple-harness-");
    const io = collectingIo();

    const outcome = await runHarness(["--scenario", "demo", "--out", out, "--json"], io, {});
    const lines = io.text
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as { seq: number; body: { type: string } });

    expect(lines[0]?.body.type).toBe("task_status");
    expect(lines.map((line) => line.seq)).toEqual(lines.map((_, index) => index));
    expect(outcome.result?.events).toHaveLength(lines.length);
  });

  it("keeps the recorded scenario in step with the runtime's phases", async () => {
    const recording = scenarioToRecording(DEMO_SCENARIO);
    const out = await tempDir("ytriple-harness-");

    const outcome = await runHarness(["--scenario", "demo", "--out", out], collectingIo(), {});

    // Every recorded response was consumed: no phase silently fell back.
    expect(outcome.result?.events.filter((event) => event.body.type === "error")).toEqual([]);
    expect(recording.entries.map((entry) => entry.key)).toContain("conductor#-#merge#0");
  });
});

describe("harness input handling", () => {
  it("explains itself when there is nothing to work on", async () => {
    const io = collectingIo();
    const outcome = await runHarness(["--out", "/tmp"], io, {});

    expect(outcome.exitCode).toBe(2);
    expect(io.text).toContain("pass --input, --input-file or --scenario");
  });

  it("prints usage for --help", async () => {
    const io = collectingIo();
    expect((await runHarness(["--help"], io, {})).exitCode).toBe(0);
    expect(io.text).toContain("ytriple harness");
  });
});

describe("preflight", () => {
  it("fails when no credential is present and names the missing variable", async () => {
    const io = collectingIo();
    const outcome = await runHarness(["--preflight"], io, {});

    expect(outcome.exitCode).toBe(1);
    expect(io.text).toContain("ARK_API_KEY");
    expect(io.text).toContain("Configuration self-check: FAIL");
  });

  it("passes with credentials present and never prints their value", async () => {
    const io = collectingIo();
    const outcome = await runHarness(["--preflight"], io, {
      ARK_API_KEY: "ark-secret-value",
      GOOGLE_API_KEY: "google-secret-value",
      DEEPSEEK_API_KEY: "deepseek-secret-value",
    });

    expect(outcome.exitCode).toBe(0);
    expect(io.text).not.toContain("ark-secret-value");
    expect(io.text).toContain("value not logged");
  });
});

describe("node fs port", () => {
  it("lists and reads inside the root while honouring the exclude globs", async () => {
    const root = await tempDir("ytriple-ws-");
    await mkdir(join(root, "docs"), { recursive: true });
    await mkdir(join(root, "node_modules", "left-pad"), { recursive: true });
    await writeFile(join(root, "docs", "idea.md"), "line one\nline two\nline three");
    await writeFile(join(root, "node_modules", "left-pad", "index.js"), "noise");

    const fs = createNodeFsPort({ root });
    const files = await fs.listFiles({ includeGlobs: ["**/*.md"], excludeGlobs: ["node_modules/**"] });

    expect(files.map((file) => file.path)).toEqual(["docs/idea.md"]);

    const content = await fs.readFile({ path: "docs/idea.md", startLine: 2, endLine: 2 });
    expect(content.content).toBe("line two");
    expect(content.truncated).toBe(true);

    const matches = await fs.searchText({ query: "line three" });
    expect(matches).toEqual([{ path: "docs/idea.md", line: 3, snippet: "line three" }]);
  });

  it("refuses a path that climbs out of the root", async () => {
    const root = await tempDir("ytriple-ws-");
    const fs = createNodeFsPort({ root });
    await expect(fs.readFile({ path: "../escape.md" })).rejects.toThrowError(
      /must be relative to the workspace root/,
    );
  });

  it("refuses a symlink that points outside the root", async () => {
    const root = await tempDir("ytriple-ws-");
    const outside = await tempDir("ytriple-outside-");
    await writeFile(join(outside, "secret.md"), "secrets");
    await symlink(join(outside, "secret.md"), join(root, "link.md"));

    const fs = createNodeFsPort({ root });
    await expect(fs.readFile({ path: "link.md" })).rejects.toThrowError(
      /resolves outside the workspace root/,
    );
  });
});

describe("node output port", () => {
  it("writes one document per task and never overwrites it", async () => {
    const outputRoot = await tempDir("ytriple-out-");
    const output = createNodeOutputPort({ outputRoot });

    const written = await output.writeDocument({
      taskId: "task-1",
      filename: "prd.md",
      content: "# PRD",
    });
    expect(written.path).toBe(join(outputRoot, "ytriple-outputs", "task-1", "prd.md"));

    await expect(
      output.writeDocument({ taskId: "task-1", filename: "prd.md", content: "# again" }),
    ).rejects.toThrowError(/never overwrites an output/);
  });
});
