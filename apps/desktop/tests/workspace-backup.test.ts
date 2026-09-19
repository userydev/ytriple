import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rm,
  readdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { legacyFinish } from "./team-response";
import { WorkspaceBackups } from "../src/core/workspace-backup";
import { Skills } from "../src/core/skills";
import { Assets } from "../src/core/assets";
import { LocalSystem } from "../src/core/local-system";
import { ProjectInitialization } from "../src/core/project-initialization";
import { ProjectSuggestions } from "../src/core/project-suggestions";
import type { SubmitInput } from "../src/core/types";
const digest = (data: unknown) =>
  createHash("sha256").update(JSON.stringify(data)).digest("hex");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ytriple-backup-"));
  const store = new Store(join(root, "workbench.sqlite"));
  store.initializeConfiguration();
  new Skills(store).initialize();
  const roots = { aiPath: join(root, "AI"), codePath: join(root, "Code") };
  await mkdir(roots.aiPath);
  await mkdir(roots.codePath);
  await writeFile(join(roots.aiPath, "untouched.md"), "external asset");
  await writeFile(join(root, "service.json"), "SECRET-NOT-IN-BACKUP");
  store.put("meta", "local-roots", roots);
  const p = store.createProject("备份试验", "精确保留引用", "software");
  const d = store.createDelivery(p.id, "交付");
  const m = store.addMaterial("知识", "旧材料正文");
  store.put("material", `${m.id}@2`, { ...m, version: 2, body: "第二版材料" });
  const refs = [
    { materialId: m.id, version: 1, label: m.title, excerpt: "旧材料" },
  ];
  const input: SubmitInput = {
    key: randomUUID(),
    context: "new",
    text: "整理资料",
    refs,
    recipient: null,
    projectId: p.id,
    deliveryId: d.id,
  };
  const r = store.submit(input);
  store.setRun(r.id, { status: "running" });
  const v = legacyFinish(store,r.id, "成果第一版", true)!;
  store.adopt(d.id, v.id);
  const r2 = store.submit({
    ...input,
    key: randomUUID(),
    context: r.workId,
    text: "AI 修订",
  });
  store.setRun(r2.id, { status: "running" });
  const v2 = legacyFinish(store,r2.id, "成果第二版", true)!;
  store.saveDraft({
    id: r.workId,
    text: "未发送，请保留旧版本依据",
    refs,
    recipient: null,
    projectId: p.id,
  });
  new Assets(store).save(refs[0], "可复用选段");
  const backups = new WorkspaceBackups(root),
    file = join(root, "snapshot.ytriple-backup");
  return {
    root,
    store,
    roots,
    backups,
    file,
    input,
    r,
    v,
    v2,
    d,
    m,
    close: async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("workspace backup preserves exact versions, adoption, drafts, references and submission identity in a separate space", async () => {
  const f = await fixture();
  let recovered: Store | undefined;
  try {
    const before = f.store.exportState();
    await f.backups.export(f.store, f.file);
    const encoded = await readFile(f.file, "utf8");
    assert.ok(!encoded.includes("SECRET-NOT-IN-BACKUP"));
    const preview = await f.backups.inspect(f.file);
    assert.equal(preview.counts.version, 2);
    const space = await f.backups.restore(preview.id, "核对空间", f.roots);
    assert.equal(
      (await f.backups.restore(preview.id, "重复请求", f.roots)).id,
      space.id,
    );
    recovered = new Store(join(f.root, "spaces", space.id, "workbench.sqlite"));
    for (const row of before.entities.filter((row) =>
      [
        "version",
        "draft",
        "delivery",
        "material",
        "asset",
        "run",
        "team",
        "workflow",
        "skill",
      ].includes(row.kind),
    ))
      assert.deepEqual(recovered.get(row.kind, row.id), JSON.parse(row.data));
    assert.deepEqual(recovered.exportState().submissions, before.submissions);
    assert.equal(recovered.submit(f.input).id, f.r.id);
    assert.equal(recovered.require<any>("work", f.r.workId).queuePaused, true);
    assert.deepEqual(f.store.exportState(), before);
    assert.equal(
      await readFile(join(f.roots.aiPath, "untouched.md"), "utf8"),
      "external asset",
    );
    assert.ok(
      !(await readdir(join(f.root, "spaces", space.id))).includes(
        "service.json",
      ),
    );
    await f.backups.select(space.id);
    assert.equal((await f.backups.info()).currentName, "核对空间");
    assert.equal(
      await new WorkspaceBackups(f.root).currentDirectory(),
      join(f.root, "spaces", space.id),
    );
    await f.backups.select("primary");
    assert.equal(await f.backups.currentDirectory(), f.root);
    const another = await f.backups.inspect(f.file);
    const copy = await f.backups.restore(another.id, "第二份", f.roots);
    assert.notEqual(copy.id, space.id);
    assert.equal((await f.backups.info()).spaces.length, 3);
  } finally {
    recovered?.close();
    await f.close();
  }
});

test("restore pauses automatic work, disarms external write previews and keeps interrupted calls recoverable", async () => {
  const f = await fixture();
  let recovered: Store | undefined;
  try {
    const pending = f.store.submit({
      ...f.input,
      key: randomUUID(),
      context: f.r.workId,
      text: "进行中",
    });
    f.store.setRun(pending.id, { status: "running" });
    const topicId = randomUUID(),
      feedId = randomUUID(),
      scheduleId = randomUUID();
    f.store.put("radar-topic", topicId, {
      id: topicId,
      revision: 1,
      title: "观测",
      focus: "资料",
      sources: [{ materialId: f.m.id, policy: "auto", reason: "" }],
      updatedAt: new Date().toISOString(),
    });
    f.store.put("feed", feedId, {
      id: feedId,
      name: "订阅",
      url: "https://example.com/rss",
      revision: 1,
      enabled: true,
      archived: false,
      nextAt: new Date().toISOString(),
    });
    f.store.put("radar-watch", topicId, {
      id: topicId,
      revision: 1,
      topicRevision: 1,
      enabled: true,
      nextAt: new Date().toISOString(),
    });
    f.store.put("schedule", scheduleId, {
      id: scheduleId,
      revision: 1,
      workId: f.r.workId,
      name: "定时",
      refs: [],
      enabled: true,
      team: pending.team,
      workflow: pending.workflow,
      skills: [],
      nextAt: new Date().toISOString(),
    });
    for (const kind of [
      "initialization",
      "local-system-plan",
      "suggestion-preview",
    ])
      f.store.put(kind, "old-plan", { id: "old-plan", status: "preview" });
    f.store.put("local-source", f.m.id, {
      path: join(f.roots.aiPath, "untouched.md"),
    });
    f.store.put("feed-preview", "preview", {
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    await f.backups.export(f.store, f.file);
    const preview = await f.backups.inspect(f.file),
      space = await f.backups.restore(preview.id, "恢复", {
        aiPath: null,
        codePath: null,
      });
    recovered = new Store(join(f.root, "spaces", space.id, "workbench.sqlite"));
    for (const kind of ["schedule", "feed", "radar-watch"])
      for (const value of recovered.all<any>(kind)) {
        assert.equal(value.enabled, false);
        assert.equal(value.nextAt, null);
      }
    assert.equal(recovered.require<any>("run", pending.id).status, "unknown");
    assert.equal(
      recovered.require<any>("local-source", f.m.id).needsRelink,
      true,
    );
    assert.deepEqual(recovered.get("meta", "local-roots"), {
      aiPath: null,
      codePath: null,
    });
    assert.equal(
      recovered.require<any>("feed-preview", "preview").expiresAt,
      "2000-01-01T00:00:00.000Z",
    );
    await assert.rejects(
      new LocalSystem(recovered).execute("old-plan"),
      /重新生成预览/,
    );
    await assert.rejects(
      new ProjectInitialization(recovered).execute("old-plan"),
      /重新生成预览/,
    );
    await assert.rejects(
      new ProjectSuggestions(recovered).publish("old-plan"),
      /重新生成预览/,
    );
    assert.equal(f.store.require<any>("run", pending.id).status, "running");
  } finally {
    recovered?.close();
    await f.close();
  }
});

test("backup rejects damaged, future, duplicate and dangling-reference payloads even with recalculated checksum", async () => {
  const f = await fixture();
  try {
    await f.backups.export(f.store, f.file);
    const original = JSON.parse(await readFile(f.file, "utf8"));
    const write = async (value: any) => {
      await writeFile(f.file, JSON.stringify(value));
    };
    await write({ ...original, schema: 999 });
    await assert.rejects(f.backups.inspect(f.file), /版本/);
    await write({ ...original, sha256: "0".repeat(64) });
    await assert.rejects(f.backups.inspect(f.file), /校验失败/);
    for (const change of [
      (data: any) => data.entities.push(data.entities[0]),
      (data: any) => {
        data.entities = data.entities.filter(
          (r: any) => !(r.kind === "material" && r.id === `${f.m.id}@1`),
        );
      },
      (data: any) =>
        data.entities.push({ kind: "unsupported-record", id: "1", data: "{}" }),
    ]) {
      const value = structuredClone(original);
      change(value.payload);
      value.sha256 = digest(value.payload);
      await write(value);
      await assert.rejects(f.backups.inspect(f.file));
    }
    await writeFile(f.file, "{truncated");
    await assert.rejects(f.backups.inspect(f.file), /有效/);
    assert.equal((await f.backups.info()).spaces.length, 1);
  } finally {
    await f.close();
  }
});

test("restore checks preview identity and refuses files changed after inspection; export never overwrites a file", async () => {
  const f = await fixture();
  try {
    await f.backups.export(f.store, f.file);
    const original = await readFile(f.file, "utf8");
    await assert.rejects(f.backups.export(f.store, f.file));
    assert.equal(await readFile(f.file, "utf8"), original);
    const preview = await f.backups.inspect(f.file);
    await writeFile(f.file, original + "\n");
    await assert.rejects(
      f.backups.restore(preview.id, "恢复", f.roots),
      /预览后发生变化/,
    );
    await assert.rejects(
      f.backups.restore(randomUUID(), "恢复", f.roots),
      /预览已过期/,
    );
    assert.ok(!(await readdir(f.root)).some((name) => name.endsWith(".tmp")));
  } finally {
    await f.close();
  }
});

test("space selection rejects traversal and symlinks, and a broken selector recovers the original without deleting evidence", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.backups.select("../escape"));
    await writeFile(join(f.root, "active-space.json"), "broken");
    assert.equal(await f.backups.currentDirectory(), f.root);
    assert.match((await f.backups.info()).startupError!, /原工作空间/);
    assert.equal(
      await readFile(join(f.root, "active-space.json"), "utf8"),
      "broken",
    );
    await f.backups.select("primary");
    assert.equal((await f.backups.info()).startupError, undefined);
    await f.backups.export(f.store, f.file);
    const preview = await f.backups.inspect(f.file);
    await symlink(f.roots.aiPath, join(f.root, "spaces"));
    await assert.rejects(
      f.backups.restore(preview.id, "恢复", f.roots),
      /符号链接/,
    );
    assert.deepEqual(await readdir(f.roots.aiPath), ["untouched.md"]);
  } finally {
    await f.close();
  }
});

test("store restore is transactional and rejects a populated destination", () => {
  const store = new Store(":memory:");
  try {
    assert.throws(() =>
      store.restoreState({
        entities: [
          { kind: "meta", id: "x", data: "1" },
          { kind: "meta", id: "x", data: "2" },
        ],
        submissions: [],
      }),
    );
    assert.equal(store.exportState().entities.length, 0);
    store.put("meta", "keep", "existing");
    assert.throws(
      () => store.restoreState({ entities: [], submissions: [] }),
      /新的空工作空间/,
    );
    assert.equal(store.get("meta", "keep"), "existing");
  } finally {
    store.close();
  }
});
