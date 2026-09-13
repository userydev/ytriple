import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { WorkbenchService } from "../src/core/service.js";
import { parseCommand } from "../src/desktop/commands.js";
import { hash } from "../src/core/files.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ytriple-feature-"));
  const service = new WorkbenchService(
    path.join(root, "data"),
    () => undefined,
    () => {},
    { autoDigestRadar: false },
  );
  service.store.setConfig("settings", {
    ...service.store.settings(),
    aiRoot: path.join(root, "AI"),
    codeRoot: path.join(root, "Code"),
    workspaceRoot: path.join(root, "work"),
    projectMonitoring: false,
    libraryRecall: false,
  });
  await mkdir(path.join(root, "Code"), { recursive: true });
  await service.initialize();
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await service.close();
    }
  };
  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, service, close };
}
test("project import observes a chosen directory outside Code without moving or registering it and restores stable identity", async (t) => {
  const { root, service, close } = await fixture(t);
  const directory = path.join(root, "existing-project");
  await mkdir(directory);
  await writeFile(
    path.join(directory, "README.md"),
    "# Existing project\nActual user content",
  );
  let snapshot = await service.execute({
    type: "project.import.path",
    path: directory,
  });
  const project = snapshot.projects.find((p) => p.root === directory)!;
  assert.ok(project.imported);
  snapshot = await service.execute({
    type: "project.import.path",
    path: directory,
  });
  assert.equal(snapshot.projects.filter((p) => p.root === directory).length, 1);
  snapshot = await service.execute({
    type: "project.read",
    projectId: project.id,
    path: "README.md",
  });
  assert.match(JSON.stringify(snapshot.projectBrowser), /Actual user content/);
  const escaped = await service.execute({
    type: "project.read",
    projectId: project.id,
    path: "../outside.txt",
  });
  assert.match(JSON.stringify(escaped.projectBrowser), /不在|路径|范围/);
  assert.ok(
    !JSON.stringify(escaped.projectBrowser).includes("Actual user content"),
  );
  assert.equal(
    await readFile(path.join(directory, "README.md"), "utf8"),
    "# Existing project\nActual user content",
  );
  await close();
  const reopened = new WorkbenchService(
    path.join(root, "data"),
    () => undefined,
  );
  t.after(() => reopened.close());
  const restored = await reopened.initialize();
  assert.equal(
    restored.projects.find((p) => p.root === directory)?.id,
    project.id,
  );
  assert.throws(() =>
    parseCommand({ type: "project.import.path", path: directory }),
  );
  assert.throws(() =>
    parseCommand({
      type: "skill.importLocal.path",
      selectedPath: directory,
      requestId: crypto.randomUUID(),
    }),
  );
});
test("concurrent and reopened creation requests yield one durable work and reject a changed payload", async (t) => {
  const { root, service, close } = await fixture(t);
  const command = {
    type: "task.create" as const,
    requestId: "same-delivery-request",
    goal: "one exact goal",
    teamMode: "media" as const,
  };
  const [a, b] = await Promise.all([
    service.execute(command),
    service.execute(command),
  ]);
  assert.equal(a.tasks[0]!.id, b.tasks[0]!.id);
  assert.equal(service.store.tasks().length, 1);
  await assert.rejects(
    service.execute({ ...command, goal: "different" }),
    /不同|其他/,
  );
  await close();
  const reopened = new WorkbenchService(
    path.join(root, "data"),
    () => undefined,
  );
  t.after(() => reopened.close());
  await reopened.initialize();
  await reopened.execute(command);
  assert.equal(reopened.store.tasks().length, 1);
});
test("public URL fallback actually stores normalized body and coverage without requiring service login", async (t) => {
  const { service } = await fixture(t);
  let calls = 0;
  service.options.publicURLFetcher = async () => {
    calls++;
    return {
      canonicalUrl: "https://example.org/story",
      title: "Public article",
      content: "Verified transport fixture",
      contentHash: hash("Verified transport fixture"),
      contentType: "text/plain",
      coverage: "fulltext",
      missing: ["media", "authenticated-content"],
      observedAt: new Date().toISOString(),
    };
  };
  const task = (
    await service.execute({ type: "task.create", goal: "read article" })
  ).tasks[0]!;
  const snapshot = await service.execute({
    type: "source.addURL",
    taskId: task.id,
    url: "https://example.org/story",
  });
  assert.equal(calls, 1);
  assert.equal(
    snapshot.tasks[0]!.sources[0]!.text,
    "Verified transport fixture",
  );
  assert.match(snapshot.tasks[0]!.sources[0]!.coverage, /公开网页文字/);
  await assert.rejects(
    service.execute({
      type: "source.addURL",
      taskId: "nonexistent",
      url: "https://example.org/story",
    }),
  );
  assert.equal(calls, 1);
});
