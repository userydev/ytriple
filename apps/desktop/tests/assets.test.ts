import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  realpath,
  readFile,
  writeFile,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { Assets } from "../src/core/assets";
import { LocalDirectories } from "../src/core/local-directories";
import type { ArtifactVersion, Draft } from "../src/core/types";
const ref = (
  m: { id: string; version: number; title: string },
  excerpt?: string,
) => ({
  materialId: m.id,
  version: m.version,
  label: m.title,
  ...(excerpt ? { excerpt } : {}),
});
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "ytriple-assets-")));
  await mkdir(join(home, "AI/knowledge"), { recursive: true });
  await mkdir(join(home, "Code"));
  const store = new Store(join(home, "db"));
  await new LocalDirectories(store).discover(home);
  return {
    home,
    store,
    assets: new Assets(store),
    close: async () => {
      store.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
test("asset export and isolated restore preserve selected text and provenance without overwriting identities or granting project standards", async () => {
  const f = await fixture();
  const target = new Store(":memory:");
  try {
    const project = f.store.createProject("栏目 A", "目标", "media");
    f.store.put("work", "work-a", {
      id: "work-a",
      title: "原工作",
      projectId: project.id,
    });
    const version: ArtifactVersion = {
      id: "v-a",
      artifactId: "artifact-a",
      number: 7,
      workId: "work-a",
      runId: "run-a",
      body: "前文\n选中范围\n私有其他段落",
      createdAt: new Date().toISOString(),
      author: "team",
      parentId: null,
    };
    f.store.put("version", version.id, version);
    const m = {
      id: version.artifactId,
      version: version.number,
      title: "成果 v7",
      body: version.body,
      coverage: "artifact",
      createdAt: version.createdAt,
    };
    f.store.put("material", `${m.id}@${m.version}`, m);
    const a = f.assets.save(ref(m, "选中范围"), "可复用说明 --> 标题");
    const path = join(f.home, "AI/knowledge/notes.md");
    await f.assets.exportFile(a.id, path);
    const text = await readFile(path, "utf8");
    assert.ok(text.endsWith("选中范围"));
    assert.ok(!text.includes("私有其他段落"));
    const sentinel = target.addMaterial("原材料", "保持不变");
    const restored = new Assets(target).restore(text);
    assert.equal(target.material(restored.reference).body, "选中范围");
    assert.equal(restored.importedOrigin?.version, 7);
    assert.equal(restored.importedOrigin?.workTitle, "原工作");
    assert.equal(restored.importedOrigin?.projectName, "栏目 A");
    assert.equal(restored.importedOrigin?.selected, true);
    assert.equal(target.snapshot().projectStandards.length, 0);
    assert.equal(target.snapshot().projects.length, 0);
    assert.equal(target.material(ref(sentinel)).body, "保持不变");
    assert.equal(new Assets(target).restore(text).id, restored.id);
    assert.equal(f.assets.restore(text).id, a.id);
    assert.equal((await f.assets.inspectFiles(a.id))[0].state, "unchanged");
  } finally {
    target.close();
    await f.close();
  }
});
test("external edits and same filename never overwrite a saved version; removed files keep original assets usable", async () => {
  const f = await fixture();
  try {
    const m = f.store.addMaterial("材料", "原内容"),
      a = f.assets.save(ref(m), "材料"),
      path = join(f.home, "AI/knowledge/asset.md");
    await f.assets.exportFile(a.id, path);
    await writeFile(path, "外部修改内容");
    assert.equal((await f.assets.inspectFiles(a.id))[0].state, "changed");
    await assert.rejects(f.assets.exportFile(a.id, path), /已存在/);
    assert.equal(await readFile(path, "utf8"), "外部修改内容");
    const original = f.assets.serialize(a.id);
    assert.throws(() => f.assets.restore(original + "修改"), /外部修改/);
    assert.equal(f.store.material(a.reference).body, "原内容");
    await rm(path);
    assert.equal((await f.assets.inspectFiles(a.id))[0].state, "missing");
    assert.equal(f.assets.prepareUse(a.id).refs[0].materialId, m.id);
  } finally {
    await f.close();
  }
});
test("asset filesystem operations reject root escapes, system writes and pre-existing symlinks", async () => {
  const f = await fixture();
  try {
    const a = f.assets.save(ref(f.store.addMaterial("条目", "正文")), "条目");
    await mkdir(join(f.home, "AI/system"));
    await symlink(join(f.home, "Code"), join(f.home, "AI/escape"));
    await assert.rejects(
      f.assets.exportFile(a.id, join(f.home, "Code/wrong.md")),
      /不在/,
    );
    await assert.rejects(
      f.assets.exportFile(a.id, join(f.home, "AI/escape/wrong.md")),
      /不在/,
    );
    await assert.rejects(
      f.assets.exportFile(a.id, join(f.home, "AI/system/wrong.md")),
      /规则/,
    );
    const outside = join(f.home, "Code/existing.md");
    await writeFile(outside, "原件");
    await symlink(outside, join(f.home, "AI/knowledge/link.md"));
    await assert.rejects(
      f.assets.exportFile(a.id, join(f.home, "AI/knowledge/link.md")),
      /已存在/,
    );
    assert.equal(await readFile(outside, "utf8"), "原件");
  } finally {
    await f.close();
  }
});
test("reuse preserves unsent draft, exact range and other references through restart with no automatic execution", async () => {
  const f = await fixture();
  try {
    const m = f.store.addMaterial("素材", "第一段\n第二段"),
      other = f.store.addMaterial("另一份", "上下文"),
      a = f.assets.save(ref(m, "第一段"), "第一段");
    const first = f.assets.prepareUse(a.id);
    f.store.saveDraft({
      ...first,
      text: "保留我的补充",
      refs: [...first.refs, ref(other)],
      recipient: "reviewer",
    });
    const next = f.assets.prepareUse(a.id);
    assert.equal(next.text, "保留我的补充");
    assert.equal(next.refs.length, 2);
    assert.equal(next.recipient, "reviewer");
    assert.equal(next.refs[0].excerpt, "第一段");
    const second = new Store(join(f.home, "db"));
    try {
      const saved = second.get<Draft>("draft", first.id)!;
      assert.equal(saved.text, next.text);
      assert.deepEqual(saved.refs, next.refs);
      assert.equal(second.snapshot().runs.length, 0);
    } finally {
      second.close();
    }
    assert.equal(
      f.assets.save({ ...ref(m, "第一段"), label: "不同显示名称" }, "别名").id,
      a.id,
    );
    assert.throws(
      () => f.assets.save(ref(m, "不存在的选段"), "错误"),
      /不属于/,
    );
  } finally {
    await f.close();
  }
});
test("invalid and oversized packages fail atomically and imported same-name assets remain separate", async () => {
  const f = await fixture();
  const destination = new Store(":memory:");
  try {
    const a = f.assets.save(ref(f.store.addMaterial("同名", "内容甲")), "同名"),
      b = f.assets.save(ref(f.store.addMaterial("同名", "内容乙")), "同名");
    const imports = new Assets(destination);
    const aa = imports.restore(f.assets.serialize(a.id)),
      bb = imports.restore(f.assets.serialize(b.id));
    assert.notEqual(aa.id, bb.id);
    assert.equal(destination.snapshot().assets.length, 2);
    const before = destination.snapshot().materials.length;
    assert.throws(() => imports.restore("普通文件"), /不是/);
    assert.throws(() => imports.restore("a".repeat(1_000_001)), /超过/);
    assert.throws(
      () => imports.restore("<!-- ytriple-asset-v1 abc -->\n\n内容"),
      /无效/,
    );
    assert.equal(destination.snapshot().materials.length, before);
    const invalid = join(f.home, "AI/invalid.md");
    await writeFile(invalid, Buffer.from([255, 254]));
    await assert.rejects(imports.restoreFile(invalid));
    assert.equal(destination.snapshot().materials.length, before);
  } finally {
    destination.close();
    await f.close();
  }
});
