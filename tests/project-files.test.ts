import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ProjectFiles } from "../src/core/project-files.js";
import type { ProjectInfo } from "../src/shared/types.js";
import { projectDocumentLink } from "../src/shared/project-files.js";

test("project document links remain inside the selected worktree", () => {
  assert.equal(
    projectDocumentLink("../README.md#intro", "docs/product.md"),
    "README.md",
  );
  assert.equal(
    projectDocumentLink("docs/%E7%AC%94%E8%AE%B0.md", "README.md"),
    "docs/笔记.md",
  );
  for (const href of [
    "../../outside.md",
    "https://example.com/file.md",
    "file:///tmp/private.txt",
    "/etc/passwd",
    "//host/private.txt",
    "%2fetc/passwd",
    "%2e%2e/%2e%2e/private.txt",
    "..\\private.txt",
    "%zz",
  ])
    assert.equal(projectDocumentLink(href, "docs/product.md"), null, href);
});

async function fixture(
  run: (value: {
    files: ProjectFiles;
    project: ProjectInfo;
    codeRoot: string;
    temporary: string;
  }) => Promise<void>,
) {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "ytriple-file-browser-"),
  );
  const codeRoot = path.join(temporary, "Code"),
    root = path.join(codeRoot, "y", "demo"),
    devPath = path.join(root, "demo-dev");
  await fs.mkdir(path.join(devPath, "docs"), { recursive: true });
  const project: ProjectInfo = {
    id: "demo",
    name: "Demo",
    series: "y",
    root,
    devPath,
    documents: {},
  };
  try {
    await run({ files: new ProjectFiles(), project, codeRoot, temporary });
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

test("project browser lazily lists directories and previews original markdown or code without executing it", async () =>
  fixture(async ({ files, project, codeRoot }) => {
    await fs.writeFile(
      path.join(project.devPath, "README.md"),
      "# 项目\n\n公开正文 $x^2$\n",
    );
    await fs.writeFile(
      path.join(project.devPath, "docs", "script.html"),
      '<script>throw new Error("must not execute")</script>',
    );
    const listing = await files.browse(project, codeRoot);
    assert.equal(listing.error, undefined);
    assert.deepEqual(
      listing.entries.map((entry) => [entry.name, entry.kind]),
      [
        ["docs", "directory"],
        ["README.md", "file"],
      ],
    );
    assert.equal(listing.preview, undefined);
    const md = await files.read(project, codeRoot, undefined, "README.md");
    assert.equal(md.preview?.format, "markdown");
    assert.equal(md.preview?.content, "# 项目\n\n公开正文 $x^2$\n");
    assert.equal(md.preview?.truncated, false);
    const html = await files.read(
      project,
      codeRoot,
      undefined,
      "docs/script.html",
    );
    assert.equal(html.directory, "docs");
    assert.equal(html.preview?.format, "text");
    assert.match(html.preview?.content ?? "", /<script>/);
  }));

test("project browser excludes hidden, credential and dependency paths in listings and direct reads", async () =>
  fixture(async ({ files, project, codeRoot }) => {
    for (const name of [
      ".env",
      ".env.local",
      "api-key.json",
      "credentials.json",
      "secrets.yaml",
      "keys.enc.json",
      "server.pem",
    ])
      await fs.writeFile(path.join(project.devPath, name), "PRIVATE");
    for (const name of [".git", "node_modules", "dist"]) {
      await fs.mkdir(path.join(project.devPath, name));
      await fs.writeFile(
        path.join(project.devPath, name, "private.txt"),
        "PRIVATE",
      );
    }
    assert.deepEqual(
      (await files.browse(project, codeRoot)).entries.map(
        (entry) => entry.name,
      ),
      ["docs"],
    );
    for (const file of [
      ".env",
      "keys.enc.json",
      "secrets.yaml",
      "node_modules/private.txt",
      ".git/private.txt",
    ]) {
      const state = await files.read(project, codeRoot, undefined, file);
      assert.ok(state.error, file);
      assert.equal(state.preview, undefined);
    }
  }));

test("project browser refuses traversal, unknown worktrees and projects outside Code", async () =>
  fixture(async ({ files, project, codeRoot, temporary }) => {
    const outside = path.join(temporary, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "text.md"), "OUTSIDE");
    for (const file of [
      "../outside/text.md",
      "/etc/passwd",
      "docs/../README.md",
      "docs\\secret.md",
    ])
      assert.ok((await files.read(project, codeRoot, undefined, file)).error);
    assert.ok((await files.read(project, codeRoot, outside, "text.md")).error);
    assert.ok(
      (
        await files.read(
          { ...project, root: outside, devPath: outside },
          codeRoot,
          undefined,
          "text.md",
        )
      ).error,
    );
    const sibling = path.join(project.root, "demo-task");
    await fs.mkdir(sibling);
    assert.ok((await files.browse(project, codeRoot, sibling)).error);
    const registered = {
      ...project,
      observation: {
        state: "ready" as const,
        checkedAt: new Date().toISOString(),
        fingerprint: "test",
        issues: [],
        documents: [],
        worktrees: [{ path: sibling, state: "ready" as const }],
      },
    };
    assert.equal(
      (await files.browse(registered, codeRoot, sibling)).error,
      undefined,
    );
  }));

test("project browser refuses symlink files, symlink ancestors and hardlinks", async () =>
  fixture(async ({ files, project, codeRoot, temporary }) => {
    const outside = path.join(temporary, "private.txt");
    await fs.writeFile(outside, "PRIVATE");
    await fs.symlink(outside, path.join(project.devPath, "linked.txt"));
    await fs.symlink(temporary, path.join(project.devPath, "linked-folder"));
    await fs.link(outside, path.join(project.devPath, "hardlink.txt"));
    assert.ok(
      (await files.read(project, codeRoot, undefined, "linked.txt")).error,
    );
    assert.ok(
      (
        await files.read(
          project,
          codeRoot,
          undefined,
          "linked-folder/private.txt",
        )
      ).error,
    );
    assert.ok(
      (await files.read(project, codeRoot, undefined, "hardlink.txt")).error,
    );
    assert.equal(
      (await files.browse(project, codeRoot)).entries.some((entry) =>
        entry.name.startsWith("linked"),
      ),
      false,
    );
  }));

test("project browser reports unsupported, binary, missing and bounded large text previews", async () =>
  fixture(async ({ files, project, codeRoot }) => {
    await fs.writeFile(
      path.join(project.devPath, "book.pdf"),
      "%PDF fake fixture",
    );
    await fs.writeFile(
      path.join(project.devPath, "binary.txt"),
      Buffer.from([0, 1, 2, 3]),
    );
    await fs.writeFile(
      path.join(project.devPath, "large.md"),
      "知识".repeat(50000),
    );
    const unsupported = await files.read(
      project,
      codeRoot,
      undefined,
      "book.pdf",
    );
    assert.equal(unsupported.preview?.format, "unsupported");
    assert.equal(unsupported.preview?.content, undefined);
    assert.match(unsupported.preview?.reason ?? "", /此格式/);
    const binary = await files.read(project, codeRoot, undefined, "binary.txt");
    assert.equal(binary.preview?.format, "unsupported");
    assert.equal(binary.preview?.content, undefined);
    const large = await files.read(project, codeRoot, undefined, "large.md");
    assert.equal(large.preview?.truncated, true);
    assert.ok(Buffer.byteLength(large.preview?.content ?? "") <= 192 * 1024);
    assert.ok(!large.preview?.content?.includes("�"));
    assert.ok(
      (await files.read(project, codeRoot, undefined, "missing.md")).error,
    );
  }));

test("project browser bounds directory enumeration and exposes truncation", async () =>
  fixture(async ({ files, project, codeRoot }) => {
    await Promise.all(
      Array.from({ length: 420 }, (_, index) =>
        fs.writeFile(path.join(project.devPath, `note-${index}.md`), ""),
      ),
    );
    const state = await files.browse(project, codeRoot);
    assert.equal(state.truncated, true);
    assert.equal(state.entries.length, 400);
  }));
