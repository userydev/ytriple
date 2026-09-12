import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkbenchService } from "../src/core/service.js";
import { ProjectFiles } from "../src/core/project-files.js";
import type { Snapshot } from "../src/shared/types.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function setup(t: TestContext) {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "ytriple-browser-reply-"),
  );
  const codeRoot = path.join(temporary, "Code"),
    projectRoot = path.join(codeRoot, "demo");
  await fs.mkdir(path.join(projectRoot, "docs"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "src"));
  await fs.writeFile(path.join(projectRoot, "README.md"), "Synthetic project");
  await fs.writeFile(
    path.join(projectRoot, "docs", "note.md"),
    "# First directory\n\nPublic synthetic note.",
  );
  await fs.writeFile(
    path.join(projectRoot, "src", "app.ts"),
    'export const demo = "second directory";',
  );
  const broadcasts: Snapshot[] = [];
  const service = new WorkbenchService(
    path.join(temporary, "data"),
    () => undefined,
    (snapshot) => broadcasts.push(snapshot),
  );
  service.store.setConfig("settings", {
    ...service.store.settings(),
    aiRoot: path.join(temporary, "AI"),
    codeRoot,
    workspaceRoot: path.join(temporary, "work"),
    projectMonitoring: false,
  });
  t.after(async () => {
    await service.close();
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const snapshot = await service.initialize();
  const project = snapshot.projects.find(
    (item) => item.devPath === projectRoot,
  )!;
  assert.ok(project);
  return { temporary, project, service, broadcasts };
}

test("concurrent project directories return their own entries while broadcasts retain the latest request", async (t) => {
  const { project, service, broadcasts } = await setup(t);
  const entered = gate(),
    held = gate();
  const original = ProjectFiles.prototype.browse;
  t.mock.method(
    ProjectFiles.prototype,
    "browse",
    async function (
      this: ProjectFiles,
      ...args: Parameters<ProjectFiles["browse"]>
    ) {
      const result = await original.apply(this, args);
      if (args[3] === "docs") {
        entered.release();
        await held.promise;
      }
      return result;
    },
  );
  const first = service.execute({
    type: "project.browse",
    projectId: project.id,
    path: "docs",
  });
  await entered.promise;
  const second = await service.execute({
    type: "project.browse",
    projectId: project.id,
    path: "src",
  });
  held.release();
  const earlierReply = await first;
  assert.equal(earlierReply.projectBrowser?.directory, "docs");
  assert.deepEqual(
    earlierReply.projectBrowser?.entries.map((entry) => entry.name),
    ["note.md"],
  );
  assert.equal(second.projectBrowser?.directory, "src");
  assert.deepEqual(
    second.projectBrowser?.entries.map((entry) => entry.name),
    ["app.ts"],
  );
  assert.equal((await service.snapshot()).projectBrowser?.directory, "src");
  assert.ok(broadcasts.length >= 2);
  assert.ok(
    broadcasts.every(
      (snapshot) => snapshot.projectBrowser?.directory === "src",
    ),
  );
});

test("a delayed file read returns its document without replacing the current shared directory", async (t) => {
  const { project, service, broadcasts } = await setup(t);
  const entered = gate(),
    held = gate();
  const original = ProjectFiles.prototype.read;
  t.mock.method(
    ProjectFiles.prototype,
    "read",
    async function (
      this: ProjectFiles,
      ...args: Parameters<ProjectFiles["read"]>
    ) {
      const result = await original.apply(this, args);
      entered.release();
      await held.promise;
      return result;
    },
  );
  const first = service.execute({
    type: "project.read",
    projectId: project.id,
    path: "docs/note.md",
  });
  await entered.promise;
  await service.execute({
    type: "project.browse",
    projectId: project.id,
    path: "src",
  });
  held.release();
  const reply = await first;
  assert.equal(reply.projectBrowser?.preview?.path, "docs/note.md");
  assert.match(
    reply.projectBrowser?.preview?.content ?? "",
    /Public synthetic note/,
  );
  assert.equal((await service.snapshot()).projectBrowser?.directory, "src");
  assert.equal((await service.snapshot()).projectBrowser?.preview, undefined);
  assert.ok(
    broadcasts.every(
      (snapshot) => snapshot.projectBrowser?.preview === undefined,
    ),
  );
});

test("changing the configured project roots clears previews and rejects old in-flight file replies", async (t) => {
  const { temporary, project, service } = await setup(t);
  await service.execute({
    type: "project.read",
    projectId: project.id,
    path: "README.md",
  });
  assert.ok((await service.snapshot()).projectBrowser?.preview);
  const entered = gate(),
    held = gate();
  const original = ProjectFiles.prototype.read;
  t.mock.method(
    ProjectFiles.prototype,
    "read",
    async function (
      this: ProjectFiles,
      ...args: Parameters<ProjectFiles["read"]>
    ) {
      const result = await original.apply(this, args);
      entered.release();
      await held.promise;
      return result;
    },
  );
  const pending = service.execute({
    type: "project.read",
    projectId: project.id,
    path: "docs/note.md",
  });
  await entered.promise;
  const otherRoot = path.join(temporary, "OtherCode");
  await fs.mkdir(otherRoot);
  const changed = await service.execute({
    type: "settings.save",
    settings: { ...service.store.settings(), codeRoot: otherRoot },
  });
  assert.equal(changed.projectBrowser, undefined);
  const rejected = assert.rejects(pending, /项目目录设置已变化/);
  held.release();
  await rejected;
  assert.equal((await service.snapshot()).projectBrowser, undefined);
});
