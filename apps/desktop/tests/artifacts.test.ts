import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { Artifacts } from "../src/core/artifacts";
import { commandSchema } from "../src/core/commands";
import type {
  ArtifactVersion,
  Delivery,
  Draft,
  Run,
  Work,
} from "../src/core/types";
import { Runtime } from "../src/core/runtime";
import type { Model } from "../src/core/ycore";
const request = (context = "new") => ({
  key: randomUUID(),
  context,
  text: "验证成果修订",
  refs: [],
  recipient: null,
  projectId: null,
});
function prepared(store = new Store(":memory:")) {
  const project = store.createProject(
    "隔离测试项目",
    "验证版本与归档",
    "media",
  );
  const delivery = store.createDelivery(project.id, "测试交付");
  const run = store.submit({
    ...request(),
    projectId: project.id,
    deliveryId: delivery.id,
  });
  store.setRun(run.id, { status: "running" });
  const version = store.finish(
    run.id,
    "第一段：保留事实。\n\n第二段：保留限制。",
    true,
  )!;
  store.adopt(delivery.id, version.id);
  return { store, run, version, delivery, artifacts: new Artifacts(store) };
}
test("archiving and restoring preserve identities, references, drafts and adoption while refusing unfinished execution", () => {
  const { store, version, run, delivery, artifacts } = prepared();
  const workId = run.workId;
  store.saveDraft({
    id: workId,
    text: "继续时再发送",
    refs: [],
    recipient: null,
    projectId: delivery.projectId,
  });
  const counts = Object.fromEntries(
    ["work", "run", "version", "draft"].map((k) => [k, store.all(k).length]),
  );
  store.setWorkState(workId, "complete");
  store.setWorkState(workId, "archive");
  assert.ok(store.require<Work>("work", workId).completedAt);
  assert.equal(store.require<Work>("work", workId).archived, true);
  store.setWorkState(workId, "restore");
  assert.ok(store.require<Work>("work", workId).completedAt);
  assert.deepEqual(
    Object.fromEntries(
      Object.keys(counts).map((k) => [k, store.all(k).length]),
    ),
    counts,
  );
  assert.equal(
    store.require<Delivery>("delivery", delivery.id).adoptedVersionId,
    version.id,
  );
  const next = store.submit({
    ...request(workId),
    projectId: delivery.projectId,
  });
  assert.equal(store.require<Work>("work", workId).completedAt, null);
  assert.equal(store.all<any>("work-event").at(-1).action, "reopened-by-send");
  assert.throws(() => store.setWorkState(workId, "archive"), /未结束/);
  store.setRun(next.id, { status: "unknown" });
  assert.throws(() => store.setWorkState(workId, "complete"), /未结束/);
  store.setRun(next.id, { status: "cancelled" });
  store.setWorkState(workId, "archive");
  assert.equal(store.require<Work>("work", workId).archived, true);
  store.close();
});

test("AI revision preserves exact references and unsent text across restart, without creating a run", () => {
  const dir = mkdtempSync(join(tmpdir(), "ytriple-revision-"));
  try {
    const { store, version, run, artifacts, delivery } = prepared(
      new Store(join(dir, "db")),
    );
    store.saveDraft({
      id: run.workId,
      text: "已有要求",
      refs: [],
      recipient: null,
      projectId: delivery.projectId,
    });
    const input = {
      workId: run.workId,
      versionId: version.id,
      excerpt: "第二段：保留限制。",
    };
    artifacts.prepareRevision(input);
    artifacts.prepareRevision(input);
    assert.equal(store.snapshot().runs.length, 1);
    assert.equal(store.snapshot().versions.length, 1);
    assert.throws(
      () => artifacts.prepareRevision({ ...input, excerpt: "不存在" }),
      /选段/,
    );
    const another = prepared(store);
    assert.throws(
      () => artifacts.prepareRevision({ ...input, workId: another.run.workId }),
      /当前工作/,
    );
    store.close();
    const reopened = new Store(join(dir, "db"));
    const draft = reopened.require<Draft>("draft", run.workId);
    assert.ok(draft.text.startsWith("已有要求"));
    assert.equal(draft.text.split("请重新整理").length, 2);
    assert.equal(draft.refs.length, 1);
    assert.equal(draft.refs[0].excerpt, input.excerpt);
    assert.equal(reopened.material(draft.refs[0]).body, version.body);
    assert.equal(
      reopened.require<Delivery>("delivery", delivery.id).adoptedVersionId,
      version.id,
    );
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("concurrent result is preserved and can be referenced for AI revision without manual merging", () => {
  const { store, version, run, artifacts, delivery } = prepared();
  const next = store.submit({
    ...request(run.workId),
    projectId: delivery.projectId,
  });
  store.setRun(next.id, { status: "running" });
  // Simulate an external/newer version arriving after the run captured its base.
  const head = {
    ...version,
    id: randomUUID(),
    parentId: version.id,
    number: 2,
    body: "另一处产生的新成果",
  };
  store.put("version", head.id, head);
  store.finish(next.id, "迟到的生成内容", true);
  assert.equal(store.require<Work>("work", run.workId).queuePaused, true);
  assert.equal(store.snapshot().versions.length, 2);
  assert.throws(() => store.setWorkState(run.workId, "complete"), /待整理/);
  assert.throws(
    () =>
      artifacts.prepareRevision({
        workId: run.workId,
        versionId: version.id,
        candidateId: next.id,
      }),
    /最新/,
  );
  const draft = artifacts.prepareRevision({
    workId: run.workId,
    versionId: head.id,
    candidateId: next.id,
  });
  assert.equal(draft.refs.length, 2);
  assert.equal(store.material(draft.refs[0]).body, head.body);
  assert.equal(store.material(draft.refs[1]).body, "迟到的生成内容");
  assert.equal(store.snapshot().runs.length, 2);
  assert.equal(store.snapshot().versions.length, 2);
  artifacts.dismiss(next.id);
  assert.equal(store.snapshot().candidates[0].body, "迟到的生成内容");
  assert.equal(store.snapshot().candidates[0].status, "dismissed");
  store.setWorkState(run.workId, "complete");
  store.close();
});
test("result editing IPC is unavailable; AI preparation rejects overflow atomically", () => {
  for (const type of [
    "edit",
    "begin-artifact-edit",
    "artifact-draft",
    "publish-artifact-draft",
    "discard-artifact-draft",
  ])
    assert.equal(
      commandSchema.safeParse({ type, versionId: "v", body: "manual" }).success,
      false,
    );
  const { store, version, run, artifacts, delivery } = prepared();
  const draft = {
    id: run.workId,
    text: "x".repeat(64000),
    refs: [],
    recipient: null,
    projectId: delivery.projectId,
  };
  store.saveDraft(draft);
  const count = store.snapshot().materials.length;
  assert.throws(
    () =>
      artifacts.prepareRevision({ workId: run.workId, versionId: version.id }),
    /过长/,
  );
  assert.equal(store.snapshot().materials.length, count);
  assert.equal(store.require<Draft>("draft", run.workId).text, draft.text);
  store.close();
});

test("explicitly sending an AI revision continues the original work and creates a new version without changing adoption", async () => {
  const { store, run, version, delivery, artifacts } = prepared();
  const draft = artifacts.prepareRevision({
    workId: run.workId,
    versionId: version.id,
    excerpt: "第二段：保留限制。",
  });
  let calls = 0;
  const model: Model = {
    async *stream(prompt, key) {
      calls++;
      assert.ok(JSON.stringify(prompt).includes("第二段：保留限制。"));
      yield { type: "run.started", run_id: key };
      yield {
        type: "text.delta",
        run_id: key,
        text: "第一段：保留事实。\n\n第二段：重新整理后仍保留限制。",
      };
      yield { type: "run.completed", run_id: key };
    },
  };
  const runtime = new Runtime(store, () => model);
  assert.equal(calls, 0);
  runtime.submit({
    ...request(run.workId),
    text: draft.text,
    refs: draft.refs,
    projectId: delivery.projectId,
  });
  await runtime.settled(run.workId);
  assert.equal(calls, 3);
  assert.equal(store.snapshot().works.length, 1);
  const revised = store.snapshot().versions.at(-1)!;
  assert.equal(revised.parentId, version.id);
  assert.equal(revised.author, "team");
  assert.equal(revised.number, 2);
  assert.equal(
    store.require<Delivery>("delivery", delivery.id).adoptedVersionId,
    version.id,
  );
  store.close();
});
