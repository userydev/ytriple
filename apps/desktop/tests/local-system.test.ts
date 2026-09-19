import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  realpath,
  writeFile,
  readFile,
  rm,
  stat,
  readlink,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Store } from "../src/core/store";
import { legacyFinish } from "./team-response";
import { LocalDirectories } from "../src/core/local-directories";
import { LocalSystem, type LocalSystemPlan } from "../src/core/local-system";
import { ProjectInitialization } from "../src/core/project-initialization";
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "ytriple-system-"))),
    ai = join(home, "AI"),
    code = join(home, "Code");
  await mkdir(ai);
  await mkdir(code);
  await mkdir(join(ai, "knowledge"));
  await writeFile(join(ai, "knowledge/existing.md"), "原有知识");
  await mkdir(join(code, "legacy"));
  await writeFile(join(code, "legacy/README.md"), "原有项目");
  const store = new Store(join(home, "db")),
    dirs = new LocalDirectories(store);
  await dirs.discover(home);
  return {
    home,
    ai,
    code,
    store,
    dirs,
    service: new LocalSystem(store),
    close: async () => {
      store.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
test("empty management system can be previewed and created without moving existing projects/assets, then initialize a real software project", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.service.inspect()).state, "missing");
    const p = await f.service.preview();
    await assert.rejects(stat(join(f.ai, "system")), { code: "ENOENT" });
    const done = await f.service.execute(p.id);
    assert.equal(done.status, "complete");
    assert.equal((await f.service.inspect()).state, "ready");
    assert.equal(
      await readFile(join(f.ai, "knowledge/existing.md"), "utf8"),
      "原有知识",
    );
    assert.equal(
      await readFile(join(f.code, "legacy/README.md"), "utf8"),
      "原有项目",
    );
    assert.equal(
      await readlink(join(f.code, "AGENTS.md")),
      p.links[join(f.code, "AGENTS.md")],
    );
    assert.equal(
      await realpath(join(f.code, "AGENTS.md")),
      join(f.ai, "system/POLICY.md"),
    );
    const project = f.store.createProject("笔记工具", "保存笔记", "software");
    const run = f.store.submit({
      key: randomUUID(),
      context: "new",
      projectId: project.id,
      text: "定义产品",
      refs: [],
      recipient: null,
    });
    f.store.setRun(run.id, { status: "running" });
    legacyFinish(f.store,
      run.id,
      "# 笔记工具\n目标：保存并检索笔记。验收：重启可恢复。",
      true,
    );
    const version = f.store.snapshot().versions[0],
      init = new ProjectInitialization(f.store);
    const plan = await init.preview({
      projectId: project.id,
      versionId: version.id,
      slug: "notes-tool",
      series: "y",
      template: "software-handoff-v1",
    });
    assert.equal((await init.execute(plan.id)).status, "complete");
    assert.equal((await f.service.inspect()).state, "ready");
    assert.equal((await f.service.execute(p.id)).status, "complete");
  } finally {
    await f.close();
  }
});
test("unknown partial rules and pre-existing root entrypoints are not overwritten", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.ai, "system"));
    await writeFile(join(f.ai, "system/custom.json"), "existing");
    await assert.rejects(f.service.preview(), /不明文件/);
    assert.equal(
      await readFile(join(f.ai, "system/custom.json"), "utf8"),
      "existing",
    );
    await rm(join(f.ai, "system/custom.json"));
    await writeFile(join(f.code, "AGENTS.md"), "用户原有规则");
    await assert.rejects(f.service.preview(), /入口规则已存在/);
    await assert.rejects(stat(join(f.ai, "system/POLICY.md")), {
      code: "ENOENT",
    });
    assert.equal(
      await readFile(join(f.code, "AGENTS.md"), "utf8"),
      "用户原有规则",
    );
  } finally {
    await f.close();
  }
});
test("files appearing after preview and root changes invalidate setup before writes", async () => {
  const f = await fixture();
  try {
    const p = await f.service.preview();
    await writeFile(join(f.ai, "AGENTS.md"), "new external rule");
    await assert.rejects(f.service.execute(p.id), /入口规则已存在/);
    await assert.rejects(stat(join(f.ai, "system")), { code: "ENOENT" });
    await rm(join(f.ai, "AGENTS.md"));
    const other = join(f.home, "OtherAI");
    await mkdir(other);
    await f.dirs.setRoot("ai", other);
    await assert.rejects(f.service.execute(p.id), /路径已变化/);
    await assert.rejects(stat(join(other, "system")), { code: "ENOENT" });
  } finally {
    await f.close();
  }
});
test("owned interrupted setup resumes after restart; changed generated files stop without rollback or overwrite", async () => {
  const f = await fixture();
  try {
    const p = await f.service.preview();
    await mkdir(join(f.ai, "system"));
    await writeFile(
      join(f.ai, "system/.ytriple-setup.json"),
      JSON.stringify(
        { id: p.id, aiRoot: p.aiRoot, codeRoot: p.codeRoot },
        null,
        2,
      ) + "\n",
    );
    await writeFile(join(f.ai, "system/POLICY.md"), "external changes");
    f.store.put<LocalSystemPlan>("local-system-plan", p.id, {
      ...p,
      status: "running",
    });
    await assert.rejects(f.service.execute(p.id), /已变化/);
    assert.equal((await f.service.inspect()).state, "attention");
    assert.equal(
      await readFile(join(f.ai, "system/POLICY.md"), "utf8"),
      "external changes",
    );
    await writeFile(
      join(f.ai, "system/POLICY.md"),
      p.files[join(f.ai, "system/POLICY.md")],
    );
    const reopened = new Store(join(f.home, "db"));
    try {
      const service = new LocalSystem(reopened);
      assert.equal((await service.execute(p.id)).status, "complete");
      assert.equal((await service.inspect()).state, "ready");
    } finally {
      reopened.close();
    }
  } finally {
    await f.close();
  }
});
test("symlinked resource directories and competing setup requests cannot redirect or overwrite files", async () => {
  const f = await fixture();
  try {
    const external = join(f.home, "outside");
    await mkdir(external);
    await symlink(external, join(f.ai, "resources"));
    await assert.rejects(f.service.preview(), /符号链接/);
    await rm(join(f.ai, "resources"));
    const a = await f.service.preview(),
      b = await f.service.preview();
    const outcomes = await Promise.allSettled([
      f.service.execute(a.id),
      f.service.execute(b.id),
    ]);
    assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal((await f.service.inspect()).state, "ready");
    assert.equal(
      await readFile(join(f.ai, "system/POLICY.md"), "utf8"),
      a.files[join(f.ai, "system/POLICY.md")],
    );
  } finally {
    await f.close();
  }
});
