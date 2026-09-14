import type { RuntimeEventBody, WorkspacePolicy } from "@ytriple/shared";
import { DEFAULT_WORKSPACE_POLICY } from "@ytriple/shared";
import { describe, expect, it, vi } from "vitest";
import {
  createFailingSearchPort,
  createFakeFsPort,
  createFakeOutputPort,
  createFakeSearchPort,
} from "../testing/fakes.js";
import { createOutputTool } from "./outputTool.js";
import { createToolRegistry } from "./registry.js";
import { TOOL_NAMES } from "./toolNames.js";
import type { ToolContext } from "./types.js";
import { createWebSearchTool, resolveWebSearchStrategy } from "./webSearchTool.js";
import { createWorkspaceTools, isPathAllowed } from "./workspaceTools.js";

const policy: WorkspacePolicy = { ...DEFAULT_WORKSPACE_POLICY, maxFiles: 50, maxFileBytes: 1_000 };

function contextWith(events: RuntimeEventBody[] = []): ToolContext {
  return {
    agentId: "member-a",
    depth: 0,
    emit: (body) => events.push(body),
  };
}

const fs = createFakeFsPort({
  rootLabel: "demo",
  files: {
    "README.md": "# Demo\nA PRD workshop.",
    "docs/product/prd.md": "line one\nline two\nline three\nline four",
    "node_modules/react/index.js": "module.exports = {}",
    "build/output.js": "compiled",
    "src/index.ts": "export const answer = 42;",
    "debug.log": "noise",
  },
});

describe("workspace policy", () => {
  it("excludes build output, dependencies and logs", () => {
    expect(isPathAllowed(policy, "docs/product/prd.md")).toBe(true);
    expect(isPathAllowed(policy, "src/index.ts")).toBe(true);
    expect(isPathAllowed(policy, "node_modules/react/index.js")).toBe(false);
    expect(isPathAllowed(policy, "build/output.js")).toBe(false);
    expect(isPathAllowed(policy, "debug.log")).toBe(false);
  });

  it("rejects any attempt to climb out of the workspace root", () => {
    expect(isPathAllowed(policy, "../secrets.md")).toBe(false);
    expect(isPathAllowed(policy, "docs/../../secrets.md")).toBe(false);
  });
});

describe("workspace tools", () => {
  const [list, read, search] = createWorkspaceTools({ fs, policy });

  it("lists only readable files", async () => {
    const result = await list!.execute({}, contextWith());
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("README.md");
    expect(result.detail).toContain("src/index.ts");
    expect(result.detail).not.toContain("node_modules");
    expect(result.detail).not.toContain("debug.log");
  });

  it("reads a line range", async () => {
    const result = await read!.execute(
      { path: "docs/product/prd.md", start_line: 2, end_line: 3 },
      contextWith(),
    );
    expect(result.summary).toBe("read docs/product/prd.md lines 2-3 (truncated)");
    expect(result.detail).toContain("line two\nline three");
    expect(result.detail).not.toContain("line four");
  });

  it("refuses an excluded path even if the host would serve it", async () => {
    const result = await read!.execute({ path: "node_modules/react/index.js" }, contextWith());
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("excluded by the workspace policy");
  });

  it("treats an unreadable file as recoverable", async () => {
    const result = await read!.execute({ path: "docs/missing.md" }, contextWith());
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("Reading docs/missing.md failed");
  });

  it("returns path and line for every search match", async () => {
    const result = await search!.execute({ query: "PRD" }, contextWith());
    expect(result.detail).toContain("README.md:2");
  });

  it("says so plainly when nothing matches", async () => {
    const result = await search!.execute({ query: "nonexistent-token" }, contextWith());
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("No readable workspace file contains");
  });
});

describe("web search strategy", () => {
  const capabilities = {
    structuredOutput: "json_schema" as const,
    toolCalling: "parallel" as const,
    nativeWebSearch: false,
    streaming: true,
    maxContextTokens: 1_000,
    maxOutputTokens: 100,
    reasoningEffort: false,
    visionInput: false,
    costTier: "cheap" as const,
  };

  it("prefers the model's own grounding when it has it", () => {
    expect(
      resolveWebSearchStrategy({
        capabilities: { ...capabilities, nativeWebSearch: true },
        searchPort: createFakeSearchPort([]),
      }),
    ).toBe("native_provider");
  });

  it("falls back to the SearchPort", () => {
    expect(
      resolveWebSearchStrategy({ capabilities, searchPort: createFakeSearchPort([]) }),
    ).toBe("search_port");
  });

  it("reports unavailable when neither exists", () => {
    expect(resolveWebSearchStrategy({ capabilities, searchPort: undefined })).toBe("unavailable");
  });
});

describe("web search tool", () => {
  it("defers to the model when it grounds natively", async () => {
    const onNativeSearchRequested = vi.fn();
    const tool = createWebSearchTool({
      strategy: "native_provider",
      maxResults: 5,
      onNativeSearchRequested,
      onSourcesFound: () => {},
    });

    const result = await tool.execute({ query: "prd tools" }, contextWith());
    expect(onNativeSearchRequested).toHaveBeenCalledWith("prd tools");
    expect(result.detail).toContain("runs as part of your next answer");
  });

  it("returns citable results from the SearchPort", async () => {
    const found: unknown[] = [];
    const tool = createWebSearchTool({
      strategy: "search_port",
      searchPort: createFakeSearchPort([
        { title: "A guide to PRDs", url: "https://example.com/prd", snippet: "how to" },
      ]),
      maxResults: 5,
      onNativeSearchRequested: () => {},
      onSourcesFound: (sources) => found.push(...sources),
    });

    const result = await tool.execute({ query: "prd" }, contextWith());
    expect(result.ok).toBe(true);
    expect(result.sources?.[0]).toEqual({
      title: "A guide to PRDs",
      url: "https://example.com/prd",
      snippet: "how to",
      origin: "search_port",
    });
    expect(found).toHaveLength(1);
  });

  it("degrades loudly when no search path exists", async () => {
    const events: RuntimeEventBody[] = [];
    const tool = createWebSearchTool({
      strategy: "unavailable",
      maxResults: 5,
      onNativeSearchRequested: () => {},
      onSourcesFound: () => {},
    });

    const result = await tool.execute({ query: "prd" }, contextWith(events));
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("mark unverified claims as assumptions");
    expect(events[0]).toMatchObject({
      type: "degradation",
      degradation: { kind: "web_search_unavailable" },
    });
  });

  it("treats a search backend failure as recoverable and reports it", async () => {
    const events: RuntimeEventBody[] = [];
    const tool = createWebSearchTool({
      strategy: "search_port",
      searchPort: createFailingSearchPort(),
      maxResults: 5,
      onNativeSearchRequested: () => {},
      onSourcesFound: () => {},
    });

    const result = await tool.execute({ query: "prd" }, contextWith(events));
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("search backend unavailable");
    expect(events).toHaveLength(1);
  });
});

describe("output tool", () => {
  it("writes the single deliverable and returns its path", async () => {
    const output = createFakeOutputPort("/out");
    const tool = createOutputTool({ output, taskId: "task-1", primaryDocument: "prd.md" });

    const result = await tool.execute({ content: "# PRD" }, contextWith());
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ path: "/out/task-1/prd.md" });
    expect(output.documents.get("/out/task-1/prd.md")).toBe("# PRD");
  });

  it("never overwrites an existing output", async () => {
    const output = createFakeOutputPort("/out");
    const tool = createOutputTool({ output, taskId: "task-1", primaryDocument: "prd.md" });

    await tool.execute({ content: "# first" }, contextWith());
    const second = await tool.execute({ content: "# second" }, contextWith());

    expect(second.ok).toBe(false);
    expect(second.detail).toContain("already exists");
  });
});

describe("tool registry", () => {
  const output = createFakeOutputPort("/out");
  const registry = createToolRegistry([
    ...createWorkspaceTools({ fs, policy }),
    createOutputTool({ output, taskId: "task-1", primaryDocument: "prd.md" }),
  ]);

  it("shows an agent only the tools on its allowlist", () => {
    const specs = registry.specsFor({
      agentId: "member-a",
      tools: [TOOL_NAMES.readWorkspaceFile, TOOL_NAMES.searchWorkspaceText],
    });
    expect(specs.map((spec) => spec.name)).toEqual([
      TOOL_NAMES.readWorkspaceFile,
      TOOL_NAMES.searchWorkspaceText,
    ]);
  });

  it("refuses a call outside the allowlist instead of degrading", async () => {
    const events: RuntimeEventBody[] = [];
    const result = await registry.execute(
      [TOOL_NAMES.readWorkspaceFile],
      TOOL_NAMES.createOutputDocument,
      { content: "# sneaky" },
      contextWith(events),
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("is not in the allowlist for member-a");
    expect(events[0]).toMatchObject({ type: "tool_call", outcome: "denied" });
    expect(output.documents.size).toBe(0);
  });

  it("says a capability-filtered tool does not exist this run", async () => {
    const bare = createToolRegistry([]);
    const result = await bare.execute(
      [TOOL_NAMES.webSearch],
      TOOL_NAMES.webSearch,
      { query: "x" },
      contextWith(),
    );
    expect(result.detail).toContain("not available in this run");
  });

  it("emits one tool_call event per execution", async () => {
    const events: RuntimeEventBody[] = [];
    await registry.execute(
      [TOOL_NAMES.readWorkspaceFile],
      TOOL_NAMES.readWorkspaceFile,
      { path: "README.md" },
      contextWith(events),
    );
    expect(events).toEqual([
      {
        type: "tool_call",
        agentId: "member-a",
        tool: TOOL_NAMES.readWorkspaceFile,
        intent: "path=README.md",
        outcome: "ok",
        detail: "read README.md lines 1-2",
      },
    ]);
  });
});
