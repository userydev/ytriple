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
  link,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Store } from "../src/core/store";
import { legacyFinish } from "./team-response";
import { LocalDirectories } from "../src/core/local-directories";
import { ProjectSuggestions } from "../src/core/project-suggestions";
import type { ArtifactVersion } from "../src/core/types";

async function fixture() {
  const home = await realpath(
    await mkdtemp(join(tmpdir(), "ytriple-suggestions-")),
  );
  const root = join(home, "Code/sample");
  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(join(home, "AI"));
  const store = new Store(join(home, "db"));
  const dirs = new LocalDirectories(store);
  await dirs.discover(home);
  const project = await dirs.importProject(root);
  const material = store.addMaterial(
    "src/main.ts",
    "return n * 3;",
    "project_file",
  );
  function result(
    body = "建议将倍数统一为 2。\n\n还需执行测试。",
    context = "new",
  ) {
    const run = store.submit({
      key: randomUUID(),
      context,
      projectId: project.id,
      text: "请提出建议",
      recipient: null,
      refs: [{ materialId: material.id, version: 1, label: material.title }],
    });
    store.setRun(run.id, { status: "running" });
    legacyFinish(store, run.id, body, true);
    return store.all<ArtifactVersion>("version").at(-1)!;
  }
  const version = result();
  const suggestions = new ProjectSuggestions(store);
  return {
    home,
    root,
    store,
    dirs,
    project,
    version,
    result,
    suggestions,
    path: join(root, "docs/SUGGESTIONS.md"),
    close: async () => {
      store.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
test("preview does not write; explicit publish preserves existing bytes and exact selected version with evidence", async () => {
  const f = await fixture();
  try {
    const prior = "# 原建议\r\n\r\n- 用户已有判断，不覆盖。\r\n";
    await writeFile(f.path, prior);
    await f.suggestions.bind(f.project.id, f.path, "existing");
    const preview = await f.suggestions.preview(
      f.project.id,
      f.version.id,
      "建议将倍数统一为 2。",
    );
    assert.equal(await readFile(f.path, "utf8"), prior);
    assert.equal(preview.existing, prior);
    const receipt = await f.suggestions.publish(preview.id);
    const written = await readFile(f.path, "utf8");
    assert.equal(written, prior + preview.addition);
    assert.match(written, /src\/main.ts · v1/);
    assert.ok(written.includes(f.version.id));
    assert.ok(!written.includes("还需执行测试。"));
    assert.match(written, /尚不代表已采纳或执行/);
    assert.equal(receipt.versionId, f.version.id);
    assert.equal(f.store.snapshot().runs.length, 1);
    assert.equal(f.store.snapshot().projectStandards.length, 0);
    assert.equal(
      f.store.require<ArtifactVersion>("version", f.version.id).body,
      f.version.body,
    );
  } finally {
    await f.close();
  }
});
test("new binding creates no file; retries and restart recover the same completed entry, later AI revisions append to the same document", async () => {
  const f = await fixture();
  try {
    await f.suggestions.bind(f.project.id, f.path, "new");
    await assert.rejects(stat(f.path), { code: "ENOENT" });
    const p = await f.suggestions.preview(f.project.id, f.version.id);
    await f.suggestions.publish(p.id);
    const once = await readFile(f.path, "utf8");
    const reopened = new Store(join(f.home, "db"));
    try {
      const service = new ProjectSuggestions(reopened);
      const again = await service.publish(p.id);
      assert.equal(await readFile(f.path, "utf8"), once);
      assert.equal(reopened.snapshot().suggestionReceipts.length, 1);
      assert.equal(again.entryId, p.entryId);
    } finally {
      reopened.close();
    }
    const v2 = f.result("新建议：补充零值测试。", f.version.workId);
    const next = await f.suggestions.preview(f.project.id, v2.id);
    await f.suggestions.publish(next.id);
    assert.equal(await readFile(f.path, "utf8"), once + next.addition);
    assert.equal(f.store.snapshot().suggestionReceipts.length, 2);
  } finally {
    await f.close();
  }
});
test("changed, removed and rebound target invalidate previews without overwriting external changes", async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, "已有意见");
    await f.suggestions.bind(f.project.id, f.path, "existing");
    const p = await f.suggestions.preview(f.project.id, f.version.id);
    await writeFile(f.path, "外部新增意见");
    await assert.rejects(f.suggestions.publish(p.id), /已变化/);
    assert.equal(await readFile(f.path, "utf8"), "外部新增意见");
    const fresh = await f.suggestions.preview(f.project.id, f.version.id);
    await rm(f.path);
    await assert.rejects(f.suggestions.publish(fresh.id), /已变化/);
    await assert.rejects(stat(f.path), { code: "ENOENT" });
    const other = join(f.root, "docs/RECOMMENDATIONS.md");
    await f.suggestions.bind(f.project.id, other, "new");
    await assert.rejects(f.suggestions.publish(p.id), /位置已变化/);
    assert.equal(f.store.snapshot().suggestionReceipts.length, 0);
  } finally {
    await f.close();
  }
});
test("scope rejects other projects, relinked roots, non-team results and wrong excerpts", async () => {
  const f = await fixture();
  try {
    await f.suggestions.bind(f.project.id, f.path, "new");
    const otherRoot = join(f.home, "Code/other");
    await mkdir(otherRoot);
    const other = await f.dirs.importProject(otherRoot);
    await f.suggestions.bind(
      other.id,
      join(otherRoot, "SUGGESTIONS.md"),
      "new",
    );
    await assert.rejects(
      f.suggestions.preview(other.id, f.version.id),
      /不属于/,
    );
    await assert.rejects(
      f.suggestions.preview(f.project.id, f.version.id, "错误选段"),
      /选段/,
    );
    f.store.put("version", f.version.id, { ...f.version, author: "user" });
    await assert.rejects(
      f.suggestions.preview(f.project.id, f.version.id),
      /团队/,
    );
    f.store.put("version", f.version.id, f.version);
    const p = await f.suggestions.preview(f.project.id, f.version.id);
    const replacement = join(f.home, "Code/replacement");
    await mkdir(replacement);
    await f.dirs.linkProject(f.project.id, replacement);
    await assert.rejects(f.suggestions.publish(p.id), /目录已变化/);
  } finally {
    await f.close();
  }
});
test("file boundary rejects formal documents, nontext, links and out-of-project paths", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.suggestions.bind(f.project.id, join(f.root, "docs/PRODUCT.md"), "new"),
      /正式方案/,
    );
    await assert.rejects(
      f.suggestions.bind(
        f.project.id,
        join(f.home, "AI/SUGGESTIONS.md"),
        "new",
      ),
      /当前项目/,
    );
    await writeFile(f.path, Buffer.from([0, 1, 2]));
    await assert.rejects(
      f.suggestions.bind(f.project.id, f.path, "existing"),
      /二进制/,
    );
    await rm(f.path);
    await writeFile(join(f.home, "outside.md"), "outside");
    await symlink(join(f.home, "outside.md"), f.path);
    await assert.rejects(
      f.suggestions.bind(f.project.id, f.path, "existing"),
      /链接/,
    );
    await rm(f.path);
    await link(join(f.home, "outside.md"), f.path);
    await assert.rejects(
      f.suggestions.bind(f.project.id, f.path, "existing"),
      /链接/,
    );
    await rm(f.path);
    await writeFile(f.path, "x".repeat(1_000_001));
    await assert.rejects(
      f.suggestions.bind(f.project.id, f.path, "existing"),
      /1 MB/,
    );
    await rm(f.path);
    await f.suggestions.bind(f.project.id, f.path, "new");
    const pending = await f.suggestions.preview(f.project.id, f.version.id);
    await symlink(join(f.home, "outside.md"), f.path);
    await assert.rejects(f.suggestions.publish(pending.id), /链接/);
    assert.equal(await readFile(join(f.home, "outside.md"), "utf8"), "outside");
  } finally {
    await f.close();
  }
});
test("competing previews do not overwrite or interleave and an exact completed entry is idempotent after external append", async () => {
  const f = await fixture();
  try {
    await f.suggestions.bind(f.project.id, f.path, "new");
    const a = await f.suggestions.preview(f.project.id, f.version.id);
    const v2 = f.result("第二轮建议", f.version.workId);
    const b = await f.suggestions.preview(f.project.id, v2.id);
    const results = await Promise.allSettled([
      f.suggestions.publish(a.id),
      new ProjectSuggestions(f.store).publish(b.id),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const text = await readFile(f.path, "utf8");
    assert.equal(text, a.addition);
    await writeFile(f.path, text + "\n人工追加\n");
    await f.suggestions.publish(a.id);
    assert.equal(await readFile(f.path, "utf8"), text + "\n人工追加\n");
  } finally {
    await f.close();
  }
});
