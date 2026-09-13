import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  projectContextDocuments,
  projectDiscussionGoal,
} from "../src/shared/project-context.js";
import { ProjectFiles } from "../src/core/project-files.js";
import type { ProjectInfo } from "../src/shared/types.js";
async function fixture(
  run: (input: {
    project: ProjectInfo;
    codeRoot: string;
    temporary: string;
    files: ProjectFiles;
  }) => Promise<void>,
) {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "ytriple-project-context-"),
  );
  const codeRoot = path.join(temporary, "Code"),
    root = path.join(codeRoot, "series", "sample"),
    devPath = path.join(root, "sample-dev");
  await fs.mkdir(path.join(devPath, "docs"), { recursive: true });
  const project: ProjectInfo = {
    id: "sample",
    name: "Sample",
    series: "series",
    root,
    devPath,
    documents: {},
  };
  try {
    await run({ project, codeRoot, temporary, files: new ProjectFiles() });
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

test("registered product, entry, plan and development are actual independent inputs, not a silently capped manifest list", async () =>
  fixture(async ({ project, codeRoot, files }) => {
    project.documents = {
      product: path.join(project.devPath, "docs/product.md"),
      entry: path.join(project.devPath, "README.md"),
      plan: path.join(project.devPath, "docs/plan.md"),
      development: path.join(project.devPath, "docs/development.md"),
    };
    const bodies = [
      "PRODUCT-GOAL",
      "ENTRY-CONTEXT",
      "PLAN-NEXT",
      "DEVELOPMENT-OPEN-ISSUES",
    ];
    for (const [index, file] of Object.values(project.documents).entries())
      await fs.writeFile(file!, bodies[index]!);
    const documents = projectContextDocuments(project);
    assert.equal(
      documents.length,
      4,
      "each separately registered document can contain unique constraints or incomplete work",
    );
    const loaded = [];
    for (const document of documents) {
      const result = await files.read(
        project,
        codeRoot,
        document.worktreePath,
        document.path,
      );
      assert.equal(result.error, undefined);
      loaded.push(result.preview?.content);
    }
    assert.deepEqual(loaded, bodies);
  }));

test("a project-root document is eligible only when that root is an actual allowed worktree", async () =>
  fixture(async ({ project, codeRoot, files }) => {
    project.documents = { product: path.join(project.root, "PRODUCT.md") };
    await fs.writeFile(project.documents.product!, "ROOT-PRODUCT-BOUNDARY");
    assert.deepEqual(
      projectContextDocuments(project),
      [],
      "the project root is not implicitly a permitted worktree",
    );
    project.observation = {
      state: "ready",
      checkedAt: new Date().toISOString(),
      worktrees: [{ path: project.root, state: "ready" }],
      documents: [],
      issues: [],
      fingerprint: "observed-root",
    };
    const [document] = projectContextDocuments(project);
    assert.ok(
      document,
      "registered project-root product text is an intended input",
    );
    const read = await files.read(
      project,
      codeRoot,
      document.worktreePath,
      document.path,
    );
    assert.equal(
      read.error,
      undefined,
      "the context selector and validated reader must agree on a registered document's scope",
    );
    assert.equal(read.preview?.content, "ROOT-PRODUCT-BOUNDARY");
  }));

test("registered context cannot escape to sibling projects, dot paths, traversal or unregistered files", async () =>
  fixture(async ({ project, codeRoot, temporary, files }) => {
    const outside = path.join(temporary, "outside.md");
    await fs.writeFile(outside, "OUTSIDE_PRIVATE_MARKER");
    await fs.writeFile(
      path.join(project.devPath, "unregistered.md"),
      "UNREGISTERED_MARKER",
    );
    for (const filename of [
      path.join(`${project.root}-other`, "product.md"),
      `${project.devPath}/docs/../../../../outside.md`,
      `${project.devPath}/.private/secret.md`,
      outside,
    ]) {
      project.documents = { product: filename };
      assert.deepEqual(projectContextDocuments(project), [], filename);
    }
    for (const filename of [
      "credentials/token.md",
      "docs/api-key.md",
      "docs/bad\\name.md",
      "docs/control\u0001.md",
    ]) {
      project.documents = { product: path.join(project.devPath, filename) };
      for (const selected of projectContextDocuments(project)) {
        const read = await files.read(
          project,
          codeRoot,
          selected.worktreePath,
          selected.path,
        );
        assert.equal(read.preview?.content, undefined);
        assert.ok(read.error);
      }
    }
    project.documents = {};
    assert.deepEqual(
      projectContextDocuments(project),
      [],
      "finding a project never auto-traverses it for material",
    );
  }));

test("a file can disappear after a present observation without an old preview being reused", async () =>
  fixture(async ({ project, codeRoot, files }) => {
    const filename = path.join(project.devPath, "docs/product.md");
    project.documents = { product: filename };
    project.observation = {
      state: "ready",
      checkedAt: new Date().toISOString(),
      worktrees: [],
      documents: [{ name: "product", path: filename, state: "present" }],
      issues: [],
      fingerprint: "observed",
    };
    await fs.writeFile(filename, "OLD-PREVIEW-MARKER");
    const selected = projectContextDocuments(project)[0]!;
    const before = await files.read(
      project,
      codeRoot,
      selected.worktreePath,
      selected.path,
    );
    assert.equal(before.preview?.content, "OLD-PREVIEW-MARKER");
    await fs.rm(filename);
    const after = await files.read(
      project,
      codeRoot,
      selected.worktreePath,
      selected.path,
    );
    assert.ok(after.error);
    assert.equal(after.preview, undefined);
    project.observation.documents[0]!.state = "missing";
    assert.deepEqual(projectContextDocuments(project), []);
    project.observation.documents[0]!.state = "error";
    assert.deepEqual(projectContextDocuments(project), []);
  }));

test("a registered symlink or hardlink does not gain access to external material", async () =>
  fixture(async ({ project, codeRoot, temporary, files }) => {
    const outside = path.join(temporary, "outside.md");
    await fs.writeFile(outside, "PRIVATE-LINK-MARKER");
    const symbolic = path.join(project.devPath, "docs/product.md"),
      hard = path.join(project.devPath, "docs/plan.md");
    await fs.symlink(outside, symbolic);
    await fs.link(outside, hard);
    project.documents = { product: symbolic, plan: hard };
    for (const document of projectContextDocuments(project)) {
      const read = await files.read(
        project,
        codeRoot,
        document.worktreePath,
        document.path,
      );
      assert.ok(read.error);
      assert.equal(read.preview, undefined);
      assert.doesNotMatch(JSON.stringify(read), /PRIVATE-LINK-MARKER/);
    }
  }));

test("large formal documents preserve the actual truncation boundary and missing context is never described as read", async () =>
  fixture(async ({ project, codeRoot, files }) => {
    project.documents = {
      product: path.join(project.devPath, "docs/product.md"),
    };
    await fs.writeFile(
      project.documents.product!,
      "实际产品正文。".repeat(40_000) + "UNREAD-TAIL",
    );
    const selected = projectContextDocuments(project)[0]!;
    const read = await files.read(
      project,
      codeRoot,
      selected.worktreePath,
      selected.path,
    );
    assert.equal(read.error, undefined);
    assert.equal(read.preview?.truncated, true);
    assert.doesNotMatch(read.preview?.content ?? "", /UNREAD-TAIL/);
    assert.ok(Buffer.byteLength(read.preview?.content ?? "") <= 192 * 1024);
    const goal = projectDiscussionGoal(
      { ...project, documents: {} },
      "指出尚未证实的进展",
    );
    assert.match(goal, /指出尚未证实的进展/);
    assert.match(goal, /没有读取或无法验证/);
    assert.doesNotMatch(
      goal,
      /已完成阅读|已核实项目完成|实际产品正文|UNREAD-TAIL/,
    );
  }));

test("nested registered worktrees use the longest containing scope that the real reader accepts", async () =>
  fixture(async ({ project, codeRoot, files }) => {
    const nested = path.join(project.devPath, "parallel");
    await fs.mkdir(nested);
    project.observation = {
      state: "ready",
      checkedAt: new Date().toISOString(),
      worktrees: [
        { path: project.root, state: "ready" },
        { path: nested, state: "ready" },
      ],
      documents: [],
      issues: [],
      fingerprint: "nested",
    };
    project.documents = {
      product: path.join(nested, "PRODUCT.md"),
      entry: path.join(project.devPath, "README.md"),
    };
    await fs.writeFile(project.documents.product!, "NESTED-PRODUCT");
    await fs.writeFile(project.documents.entry!, "MAIN-ENTRY");
    const docs = projectContextDocuments(project);
    assert.equal(docs[0]!.worktreePath, nested);
    assert.equal(docs[1]!.worktreePath, project.devPath);
    for (const doc of docs) {
      const read = await files.read(
        project,
        codeRoot,
        doc.worktreePath,
        doc.path,
      );
      assert.equal(read.error, undefined);
      assert.equal(read.preview?.path, doc.path);
    }
  }));
