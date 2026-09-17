import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
  symlink,
  stat,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/core/store";
import { ProjectFiles } from "../src/core/project-files";
import { LocalDirectories } from "../src/core/local-directories";
import { Runtime } from "../src/core/runtime";
import type { Draft } from "../src/core/types";
import type { Model, Prompt } from "../src/core/ycore";
async function fixture() {
  const home = await realpath(
    await mkdtemp(join(tmpdir(), "ytriple-project-files-")),
  );
  const root = join(home, "Code/sample");
  for (const path of [
    "AI",
    "Code/sample/src",
    "Code/sample/tests",
    "Code/sample/docs",
    "Code/sample/node_modules",
  ])
    await mkdir(join(home, path), { recursive: true });
  await writeFile(
    join(root, "README.md"),
    "# Example\nThe function doubles the input.",
  );
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "example", scripts: { test: "DO_NOT_EXECUTE" } }),
  );
  await writeFile(
    join(root, "src/main.ts"),
    "export const twice = (n:number) => n * 2;",
  );
  await writeFile(
    join(root, "tests/main.test.ts"),
    "assert.equal(twice(2), 4);",
  );
  await writeFile(
    join(root, "docs/limits.md"),
    "Only finite numbers are documented.",
  );
  await writeFile(join(root, ".env"), "SECRET=never-read");
  await writeFile(
    join(root, "node_modules/ignored.ts"),
    "private dependency data",
  );
  const store = new Store(join(home, "db")),
    dirs = new LocalDirectories(store);
  await dirs.discover(home);
  const project = await dirs.importProject(root);
  return {
    home,
    root,
    store,
    dirs,
    project,
    files: new ProjectFiles(store),
    close: async () => {
      store.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
const reference = (m: { id: string; version: number; title: string }) => ({
  materialId: m.id,
  version: m.version,
  label: m.title,
});
class Capture implements Model {
  prompts: Prompt[] = [];
  async *stream(p: Prompt, key: string) {
    this.prompts.push(p);
    yield { type: "run.started" as const, run_id: key };
    yield {
      type: "text.delta" as const,
      run_id: key,
      text: "源码实现乘二；测试文件存在断言，但没有执行证据。",
    };
    yield { type: "run.completed" as const, run_id: key };
  }
}
function send(runtime: Runtime, draft: Draft) {
  return runtime.submit({
    key: randomUUID(),
    context: draft.id,
    text: draft.text,
    refs: draft.refs,
    recipient: draft.recipient,
    projectId: draft.projectId,
    outputMode: draft.outputMode,
  });
}
test("inventory differentiates source/config/test/docs and exclusions without reading unread content or executing commands", async () => {
  const f = await fixture();
  try {
    const i = await f.files.inspect(f.project.id);
    assert.equal(
      i.entries.find((e) => e.path === "src/main.ts")?.kind,
      "source",
    );
    assert.equal(
      i.entries.find((e) => e.path === "tests/main.test.ts")?.kind,
      "test",
    );
    assert.equal(
      i.entries.find((e) => e.path === "package.json")?.kind,
      "configuration",
    );
    assert.equal(
      i.entries.find((e) => e.path === "README.md")?.kind,
      "documentation",
    );
    assert.equal(i.entries.find((e) => e.path === ".env")?.state, "excluded");
    assert.equal(i.entries.find((e) => e.path === ".env")?.reason, "凭据或秘密文件");
    assert.ok(
      i.entries.some(
        (e) => e.path === "node_modules/" && e.state === "excluded",
      ),
    );
    assert.equal(f.store.snapshot().materials.length, 0);
    assert.equal(f.store.snapshot().runs.length, 0);
    assert.ok(!JSON.stringify(i).includes("never-read"));
  } finally {
    await f.close();
  }
});
test("capture versions actual file bodies; refresh hashes content even when size and timestamp are unchanged", async () => {
  const f = await fixture();
  try {
    await f.files.inspect(f.project.id);
    const [first] = await f.files.capture(f.project.id, ["src/main.ts"]);
    assert.equal(first.version, 1);
    assert.equal(first.body, "export const twice = (n:number) => n * 2;");
    assert.equal(
      (await f.files.capture(f.project.id, ["src/main.ts"]))[0].version,
      1,
    );
    const info = await stat(join(f.root, "src/main.ts"));
    await writeFile(
      join(f.root, "src/main.ts"),
      "export const twice = (n:number) => n * 3;",
    );
    await utimes(join(f.root, "src/main.ts"), info.atime, info.mtime);
    assert.equal(
      (await f.files.inspect(f.project.id)).entries.find(
        (e) => e.path === "src/main.ts",
      )?.state,
      "changed",
    );
    const [second] = await f.files.capture(f.project.id, ["src/main.ts"]);
    assert.equal(second.version, 2);
    assert.equal(first.id, second.id);
    assert.equal(f.store.material(reference(first)).body, first.body);
    await rm(join(f.root, "src/main.ts"));
    const i = await f.files.inspect(f.project.id);
    assert.equal(
      i.entries.find((e) => e.path === "src/main.ts")?.state,
      "missing",
    );
    assert.equal(f.store.material(reference(second)).body, second.body);
  } finally {
    await f.close();
  }
});
test("mixed failed capture is atomic and rejects credentials, binary, large files and symlink escape", async () => {
  const f = await fixture();
  try {
    await symlink(join(f.home, "AI"), join(f.root, "escape"));
    await writeFile(join(f.home, "AI/outside.ts"), "not authorized");
    await symlink(join(f.root, "README.md"), join(f.root, "linked.md"));
    await writeFile(join(f.root, "binary.ts"), Buffer.from([0, 255]));
    await writeFile(join(f.root, "large.ts"), "x".repeat(128001));
    await writeFile(
      join(f.root, "ordinary.txt"),
      "-----BEGIN PRIVATE KEY-----\nprivate content",
    );
    for (const path of [
      ".env",
      "escape/outside.ts",
      "linked.md",
      "binary.ts",
      "large.ts",
      "ordinary.txt",
      "../AI/outside.ts",
    ])
      await assert.rejects(f.files.capture(f.project.id, ["README.md", path]));
    assert.equal(f.store.snapshot().materials.length, 0);
    assert.equal(
      await readFile(join(f.root, "README.md"), "utf8"),
      "# Example\nThe function doubles the input.",
    );
  } finally {
    await f.close();
  }
});
test("team reading uses selected source snapshots and versions, preserves drafts and continues same project work across batches", async () => {
  const f = await fixture();
  try {
    const materials = await f.files.capture(f.project.id, [
      "src/main.ts",
      "tests/main.test.ts",
    ]);
    const context = `new:project-reading:${f.project.id}`;
    f.store.saveDraft({
      id: context,
      text: "特别关注边界条件。",
      refs: [],
      recipient: null,
      projectId: f.project.id,
    });
    const draft = f.files.prepare(f.project.id, materials.map(reference));
    assert.ok(draft.text.startsWith("特别关注边界条件。"));
    assert.equal(f.store.snapshot().runs.length, 0);
    const model = new Capture(),
      runtime = new Runtime(f.store, () => model);
    const first = send(runtime, draft);
    await runtime.settled(first.workId);
    assert.equal(f.store.snapshot().works[0].title, "理解项目 · sample");
    assert.ok(
      model.prompts[0].messages[1].content.includes("src/main.ts / 版本:v1"),
    );
    assert.ok(model.prompts[0].messages[1].content.includes(materials[0].body));
    assert.ok(!model.prompts[0].messages[1].content.includes("never-read"));
    assert.ok(!model.prompts[0].messages[1].content.includes("DO_NOT_EXECUTE"));
    const [doc] = await f.files.capture(f.project.id, ["README.md"]);
    const second = f.files.prepare(f.project.id, [reference(doc)]);
    assert.equal(second.id, first.workId);
    send(runtime, second);
    await runtime.settled(first.workId);
    assert.equal(f.store.snapshot().works.length, 1);
    assert.equal(f.store.snapshot().runs.length, 2);
    assert.equal(f.store.snapshot().versions.length, 2);
    const reopened = new Store(join(f.home, "db"));
    try {
      assert.equal(
        new ProjectFiles(reopened).prepare(f.project.id, [reference(doc)]).id,
        first.workId,
      );
      assert.equal(
        reopened.material(reference(materials[0])).body,
        materials[0].body,
      );
    } finally {
      reopened.close();
    }
  } finally {
    await f.close();
  }
});
test("cross-project paths and relinked roots cannot reuse stale inspection or old file authority", async () => {
  const f = await fixture();
  try {
    const [m] = await f.files.capture(f.project.id, ["README.md"]);
    const otherRoot = join(f.home, "Code/other");
    await mkdir(otherRoot);
    await writeFile(join(otherRoot, "README.md"), "Other project");
    const other = await f.dirs.importProject(otherRoot);
    assert.throws(() => f.files.prepare(other.id, [reference(m)]), /不属于/);
    const replacement = join(f.home, "Code/replacement");
    await mkdir(replacement);
    await f.dirs.linkProject(f.project.id, replacement);
    assert.throws(
      () => f.files.prepare(f.project.id, [reference(m)]),
      /不属于/,
    );
    const inventory = await f.files.inspect(f.project.id);
    assert.equal(inventory.root, replacement);
    assert.equal(inventory.entries.length, 0);
    assert.equal(f.store.material(reference(m)).body, m.body);
  } finally {
    await f.close();
  }
});
test("partial directory coverage is explicit and never turns an unvisited saved file into a deletion", async () => {
  const f = await fixture();
  try {
    const deep = "a/".repeat(14);
    await mkdir(join(f.root, deep), { recursive: true });
    await writeFile(join(f.root, deep, "deep.ts"), "export const deep=true;");
    await f.files.capture(f.project.id, [deep + "deep.ts"]);
    const prior = {
      projectId: f.project.id,
      root: f.root,
      inspectedAt: new Date().toISOString(),
      entries: [
        {
          path: deep + "deep.ts",
          kind: "source",
          state: "captured",
          reference: reference(f.store.snapshot().materials[0]),
        },
      ],
      limited: false,
      notes: [],
    };
    f.store.put("project-inspection", f.project.id, prior);
    const next = await f.files.inspect(f.project.id);
    assert.equal(next.limited, true);
    assert.ok(next.notes.some((n) => n.includes("未列出")));
    assert.ok(
      !next.entries.some(
        (e) => e.path === deep + "deep.ts" && e.state === "missing",
      ),
    );
  } finally {
    await f.close();
  }
});
