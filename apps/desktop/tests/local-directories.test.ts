import { test } from "node:test";
import assert from "node:assert/strict";
import {
  realpath,
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { LocalDirectories } from "../src/core/local-directories";
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "ytriple-roots-")));
  await mkdir(join(home, "AI/system"), { recursive: true });
  await mkdir(join(home, "Code/y/example/dev/.git"), { recursive: true });
  const store = new Store(join(home, "workbench.sqlite"));
  const dirs = new LocalDirectories(store);
  await dirs.discover(home);
  return {
    home,
    store,
    dirs,
    close: async () => {
      store.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
test("existing AI/Code discovery persists roots and project association without reading project files", async () => {
  const f = await fixture();
  try {
    const path = join(f.home, "Code/y/example/dev");
    await writeFile(join(path, "private.txt"), "Do not import this content");
    const inventory = await f.dirs.refresh();
    assert.equal(inventory.projects.length, 1);
    assert.equal(inventory.projects[0].path, path);
    const project = await f.dirs.importProject(path);
    assert.equal((await f.dirs.importProject(path)).id, project.id);
    assert.equal(f.store.snapshot().projects.length, 1);
    assert.equal(f.store.snapshot().materials.length, 0);
    assert.equal(f.store.snapshot().runs.length, 0);
    assert.equal(
      await readFile(join(path, "private.txt"), "utf8"),
      "Do not import this content",
    );
    const second = new Store(join(f.home, "workbench.sqlite"));
    try {
      const d = new LocalDirectories(second);
      await d.discover("/nonexistent-home");
      assert.equal(d.roots().aiPath, join(f.home, "AI"));
      assert.equal(second.snapshot().projects[0].directory, path);
    } finally {
      second.close();
    }
  } finally {
    await f.close();
  }
});
test("root and project containment rejects nesting, outside paths and symlink escapes", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.dirs.setRoot("ai", join(f.home, "Code/y")),
      /独立目录/,
    );
    await assert.rejects(f.dirs.setRoot("code", join(f.home, "missing")));
    await symlink(join(f.home, "AI"), join(f.home, "Code/escape"));
    await assert.rejects(
      f.dirs.importProject(join(f.home, "Code/escape")),
      /不在/,
    );
    await assert.rejects(
      f.dirs.importProject(join(f.home, "Code")),
      /具体项目/,
    );
    const path = join(f.home, "Code/y/example/dev"),
      p = await f.dirs.importProject(path),
      other = f.store.createProject("Other", "", "media");
    await assert.rejects(f.dirs.linkProject(other.id, path), /已经关联/);
    assert.equal((await f.dirs.linkProject(p.id, path)).directory, path);
    await writeFile(join(f.home, "Code/file"), "not a folder");
    await assert.rejects(
      f.dirs.validatedDirectory("code", join(f.home, "Code/file")),
      /不再是文件夹/,
    );
    assert.equal((await f.dirs.refresh()).projects.length, 1);
  } finally {
    await f.close();
  }
});
test("asset catalogs are bounded data only, missing assets visible and outside paths unavailable", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.home, "AI/resources/workflow"), { recursive: true });
    await symlink(join(f.home, "Code"), join(f.home, "AI/escape"));
    await writeFile(
      join(f.home, "AI/system/resources.json"),
      JSON.stringify({
        resources: [
          {
            id: "workflow",
            title: "Workflow",
            type: "workflow",
            path: "resources/workflow",
            command: "touch SHOULD_NOT_EXIST",
          },
          { id: "missing", title: "Missing", path: "resources/missing" },
          { id: "outside", title: "Outside", path: "../Code" },
          { id: "escape", title: "Escape", path: "escape" },
        ],
      }),
    );
    await writeFile(join(f.home, "AI/system/knowledge.json"), "malformed");
    const inv = await f.dirs.refresh();
    assert.equal(inv.assets.length, 3);
    assert.equal(inv.assets[0].available, true);
    assert.equal(inv.assets[1].available, false);
    assert.equal(inv.assets[2].available, false);
    assert.ok(inv.notes.some((n) => n.includes("目录外")));
    assert.ok(inv.notes.some((n) => n.includes("knowledge.json")));
    assert.equal(f.store.snapshot().materials.length, 0);
    await assert.rejects(readFile(join(f.home, "SHOULD_NOT_EXIST")));
  } finally {
    await f.close();
  }
});
test("changing roots preserves project identity but prevents opening an old out-of-root folder", async () => {
  const f = await fixture();
  try {
    const project = await f.dirs.importProject(
      join(f.home, "Code/y/example/dev"),
    );
    await mkdir(join(f.home, "OtherCode"));
    await f.dirs.setRoot("code", join(f.home, "OtherCode"));
    assert.equal(f.store.snapshot().projects[0].directory, project.directory);
    assert.equal(f.store.snapshot().localInventory, null);
    await assert.rejects(
      f.dirs.validatedDirectory("code", project.directory!),
      /不在/,
    );
    await rm(join(f.home, "AI"), { recursive: true });
    const inv = await f.dirs.refresh();
    assert.equal(inv.roots.find((r) => r.kind === "ai")?.available, false);
    assert.equal(inv.roots.find((r) => r.kind === "code")?.available, true);
  } finally {
    await f.close();
  }
});
