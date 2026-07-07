import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  listWorkspaceFiles,
  readWorkspaceFile,
  searchWorkspaceText,
} from "./workspace";

async function makeWorkspace() {
  const root = join(tmpdir(), `ytriple-workspace-${crypto.randomUUID()}`);
  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(join(root, "node_modules/pkg"), { recursive: true });
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, "docs", "brief.md"), "Line one\nPRD template signal\nLine three\n");
  await writeFile(join(root, "node_modules/pkg/index.md"), "ignored");
  await writeFile(join(root, ".git/config"), "ignored");
  await writeFile(join(root, "debug.log"), "ignored");
  return root;
}

describe("workspace read layer", () => {
  it("lists only allowed text files with relative paths", async () => {
    const root = await makeWorkspace();

    const result = await listWorkspaceFiles({ workspaceRoot: root });

    expect(result.files.map((file) => file.path)).toEqual(["docs/brief.md"]);
    expect(result.files[0].mimeType).toBe("text/markdown");
  });

  it("reads bounded line ranges and rejects paths outside the workspace", async () => {
    const root = await makeWorkspace();

    await expect(
      readWorkspaceFile({ workspaceRoot: root, path: "../outside.md" }),
    ).rejects.toThrow(/workspace/i);

    const result = await readWorkspaceFile({
      workspaceRoot: root,
      path: "docs/brief.md",
      startLine: 2,
      endLine: 2,
    });

    expect(result).toEqual({
      path: "docs/brief.md",
      content: "PRD template signal\n",
      truncated: false,
    });
  });

  it("returns traceable text search snippets", async () => {
    const root = await makeWorkspace();

    const result = await searchWorkspaceText({
      workspaceRoot: root,
      query: "template",
    });

    expect(result.matches).toEqual([
      {
        path: "docs/brief.md",
        line: 2,
        snippet: "PRD template signal",
      },
    ]);
  });
});
