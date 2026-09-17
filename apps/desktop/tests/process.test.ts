import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { Runtime } from "../src/core/runtime";
import { ProcessRecords } from "../src/core/process";
import { Artifacts } from "../src/core/artifacts";
import { Decisions } from "../src/core/decisions";
import type { Contribution, Draft, Run, SubmitInput } from "../src/core/types";
import type { Model, Prompt } from "../src/core/ycore";
const request = (
  context = "new",
  extra: Partial<SubmitInput> = {},
): SubmitInput => ({
  key: randomUUID(),
  context,
  text: "为虚构的读书会写开场",
  refs: [],
  recipient: null,
  projectId: null,
  ...extra,
});
function fixture(path = ":memory:") {
  const store = new Store(path),
    project = store.createProject("虚构栏目", "短且有依据", "media"),
    delivery = store.createDelivery(project.id, "开场");
  const run = store.submit(
    request("new", { projectId: project.id, deliveryId: delivery.id }),
  );
  store.setRun(run.id, { status: "running" });
  const contribution: Contribution = {
    id: `${run.id}:0`,
    workId: run.workId,
    runId: run.id,
    memberId: "researcher",
    memberName: "当时的研究员",
    objective: "研究已提供的开场材料",
    body: "先展示结果。\n不能把报名意向写成出席实绩。",
    status: "succeeded",
    remoteId: null,
    error: null,
    createdAt: new Date().toISOString(),
  };
  store.put("contribution", contribution.id, contribution);
  const version = store.finish(
    run.id,
    "先展示结果，保留未知的出席人数。",
    true,
  )!;
  store.adopt(delivery.id, version.id);
  return {
    store,
    run,
    contribution,
    version,
    project,
    delivery,
    records: new ProcessRecords(store),
  };
}
class Capture implements Model {
  prompts: Prompt[] = [];
  async *stream(prompt: Prompt, key: string) {
    this.prompts.push(prompt);
    yield { type: "run.started" as const, run_id: key };
    yield {
      type: "text.delta" as const,
      run_id: key,
      text: "依据记录：报名意向无法证明实际出席。缺少实际反馈，不判断效果。",
    };
    yield { type: "run.completed" as const, run_id: key };
  }
}
function sendDraft(runtime: Runtime, draft: Draft) {
  return runtime.submit(
    request(draft.id, {
      text: draft.text,
      refs: draft.refs,
      projectId: draft.projectId,
      recipient: draft.recipient,
      outputMode: draft.outputMode,
    }),
  );
}
test("process follow-up freezes exact public record range and member identity, preserves draft, and never executes on preparation", () => {
  const f = fixture();
  try {
    f.store.saveDraft({
      id: f.run.workId,
      text: "先保留我的问题",
      refs: [],
      recipient: "reviewer",
      projectId: f.project.id,
    });
    const d = f.records.prepare({
      workId: f.run.workId,
      mode: "explanation",
      contributionIds: [f.contribution.id],
      excerpt: "不能把报名意向写成出席实绩。",
    });
    assert.equal(d.recipient, "reviewer");
    assert.equal(d.outputMode, "explanation");
    assert.ok(d.text.startsWith("先保留我的问题"));
    const m = f.store.material(d.refs[0]);
    assert.ok(m.body.includes("当时的研究员"));
    assert.ok(m.body.includes(f.contribution.id));
    assert.ok(!m.body.includes("先展示结果。"));
    assert.deepEqual(m.processSource?.contributionIds, [f.contribution.id]);
    const same = f.records.prepare({
      workId: f.run.workId,
      mode: "explanation",
      contributionIds: [f.contribution.id],
      excerpt: "不能把报名意向写成出席实绩。",
    });
    assert.equal(same.refs.length, 1);
    f.store.put("contribution", f.contribution.id, {
      ...f.contribution,
      body: "后续内容",
    });
    assert.equal(f.store.material(d.refs[0]).body, m.body);
    assert.equal(f.store.snapshot().runs.length, 1);
    assert.equal(f.store.snapshot().versions.length, 1);
  } finally {
    f.store.close();
  }
});
test("explanation is a reply; summary and review have independent version chains and cannot replace adopted deliverable", async () => {
  const f = fixture();
  try {
    const model = new Capture(),
      runtime = new Runtime(f.store, () => model);
    const follow = f.records.prepare({
      workId: f.run.workId,
      mode: "explanation",
      contributionIds: [f.contribution.id],
    });
    sendDraft(runtime, follow);
    await runtime.settled(f.run.workId);
    assert.equal(f.store.snapshot().versions.length, 1);
    assert.ok(f.store.snapshot().messages.at(-1)?.body.includes("无法证明"));
    assert.ok(
      model.prompts.every((p) => p.messages[0].content.includes("本轮只解释")),
    );
    const summary = f.records.prepare({
      workId: f.run.workId,
      mode: "summary",
      runId: f.run.id,
    });
    const sr = sendDraft(runtime, summary);
    await runtime.settled(f.run.workId);
    const sv = f.store.snapshot().versions.find((v) => v.runId === sr.id)!;
    assert.equal(sv.kind, "summary");
    assert.equal(sv.number, 1);
    assert.equal(sv.parentId, null);
    assert.notEqual(sv.artifactId, f.version.artifactId);
    const review = f.records.prepare({
      workId: f.run.workId,
      mode: "review",
      runId: f.run.id,
    });
    const rr = sendDraft(runtime, review);
    await runtime.settled(f.run.workId);
    const rv = f.store.snapshot().versions.find((v) => v.runId === rr.id)!;
    assert.equal(rv.kind, "review");
    assert.notEqual(rv.artifactId, sv.artifactId);
    assert.throws(() => f.store.adopt(f.delivery.id, rv.id), /不能替代/);
    assert.equal(
      f.store.snapshot().deliveries[0].adoptedVersionId,
      f.version.id,
    );
    const revision = new Artifacts(f.store).prepareRevision({
      workId: f.run.workId,
      versionId: sv.id,
    });
    assert.equal(revision.outputMode, "summary");
    const revised = sendDraft(runtime, revision);
    await runtime.settled(f.run.workId);
    const sv2 = f.store
      .snapshot()
      .versions.find((v) => v.runId === revised.id)!;
    assert.equal(sv2.number, 2);
    assert.equal(sv2.parentId, sv.id);
    const normal = runtime.submit(
      request(f.run.workId, {
        text: "继续修改主成果",
        projectId: f.project.id,
      }),
    );
    await runtime.settled(f.run.workId);
    const result = f.store
      .snapshot()
      .versions.find((v) => v.runId === normal.id)!;
    assert.equal(result.kind, "result");
    assert.equal(result.number, 2);
    assert.equal(result.parentId, f.version.id);
    assert.equal(result.artifactId, f.version.artifactId);
  } finally {
    f.store.close();
  }
});
test("selected run excludes other rounds, captures exact result for review, and distinguishes missing analysis from unavailable feedback", () => {
  const f = fixture();
  try {
    f.store.put("contribution", f.contribution.id, {
      ...f.contribution,
      body: "",
      status: "failed",
      error: "连接失败，没有公开分析",
    });
    f.store.setRun(f.run.id, { status: "failed" });
    const later = f.store.submit(
      request(f.run.workId, {
        text: "不应混入范围的另一轮目标",
        projectId: f.project.id,
      }),
    );
    f.store.put("contribution", `${later.id}:0`, {
      ...f.contribution,
      id: `${later.id}:0`,
      runId: later.id,
      body: "其他轮次的内容",
    });
    const d = f.records.prepare({
      workId: f.run.workId,
      mode: "review",
      runId: f.run.id,
    });
    const m = f.store.material(d.refs.at(-1)!);
    assert.ok(m.body.includes("未记录公开分析"));
    assert.ok(m.body.includes("没有时明确未验证"));
    assert.ok(m.body.includes(f.version.body));
    assert.ok(!m.body.includes("其他轮次的内容"));
    assert.ok(!m.body.includes("不应混入范围"));
    assert.deepEqual(m.processSource?.versionIds, [f.version.id]);
  } finally {
    f.store.close();
  }
});
test("bad scope, cross-work record and oversized evidence reject atomically without changing ordinary draft", () => {
  const f = fixture();
  try {
    f.store.saveDraft({
      id: f.run.workId,
      text: "原草稿",
      refs: [],
      recipient: null,
      projectId: f.project.id,
    });
    const before = f.store.snapshot();
    const other = f.store.submit(request());
    f.store.put("contribution", "other-record", {
      ...f.contribution,
      id: "other-record",
      workId: other.workId,
      runId: other.id,
    });
    assert.throws(
      () =>
        f.records.prepare({
          workId: f.run.workId,
          mode: "summary",
          contributionIds: ["other-record"],
        }),
      /不属于/,
    );
    assert.throws(
      () =>
        f.records.prepare({
          workId: f.run.workId,
          mode: "explanation",
          contributionIds: [f.contribution.id],
          excerpt: "未记录的话",
        }),
      /选段/,
    );
    f.store.put("contribution", f.contribution.id, {
      ...f.contribution,
      body: "很长的内容".repeat(7000),
    });
    assert.throws(
      () => f.records.prepare({ workId: f.run.workId, mode: "summary" }),
      /超过/,
    );
    assert.deepEqual(f.store.snapshot().drafts, before.drafts);
    assert.equal(f.store.snapshot().materials.length, before.materials.length);
  } finally {
    f.store.close();
  }
});
test("queued review keeps frozen evidence and output mode through restart and explicit resume", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ytriple-process-"));
  const path = join(dir, "db");
  let f = fixture(path);
  try {
    const d = f.records.prepare({
      workId: f.run.workId,
      mode: "review",
      runId: f.run.id,
    });
    const queued = f.store.submit(request(d.id, { ...d, context: d.id }));
    const body = f.store.material(d.refs[0]).body;
    f.store.put("contribution", f.contribution.id, {
      ...f.contribution,
      body: "排队后变化不能漂移",
    });
    f.store.close();
    const reopened = new Store(path);
    f = { ...f, store: reopened };
    reopened.recover();
    assert.equal(reopened.require<Run>("run", queued.id).outputMode, "review");
    const model = new Capture(),
      runtime = new Runtime(reopened, () => model);
    runtime.resume(queued.workId);
    await runtime.settled(queued.workId);
    assert.ok(model.prompts[0].messages[1].content.includes(body));
    assert.ok(
      !model.prompts[0].messages[1].content.includes("排队后变化不能漂移"),
    );
    assert.equal(reopened.snapshot().versions.at(-1)?.kind, "review");
  } finally {
    f.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("review waiting decision checks its own result chain and old output-mode submission cannot erase a changed draft", () => {
  const f = fixture();
  try {
    const d = f.records.prepare({
      workId: f.run.workId,
      mode: "review",
      runId: f.run.id,
    });
    const r = f.store.submit(request(d.id, { ...d, context: d.id }));
    f.store.setRun(r.id, { status: "running" });
    const c = { ...f.contribution, id: `${r.id}:0`, runId: r.id };
    f.store.put("contribution", c.id, c);
    const decisions = new Decisions(f.store);
    const pending = decisions.pause(r.id, c, 0, 0, {
      question: "范围？",
      reason: "两种复盘范围",
      impact: "仅本轮",
      options: [
        { label: "过程", detail: "只看过程" },
        { label: "成果", detail: "也看成果" },
      ],
    });
    const draft = decisions.saveDraft(pending.id, 1, 0, "只看过程");
    assert.doesNotThrow(() =>
      decisions.answer({
        decisionId: pending.id,
        revision: 1,
        draftRevision: draft.draftRevision,
        key: randomUUID(),
        text: "只看过程",
      }),
    );
    decisions.cancel(f.run.workId);
    f.store.setRun(r.id, { status: "cancelled" });
    f.store.saveDraft({ ...d, outputMode: "result" });
    f.store.submit(
      request(d.id, { ...d, context: d.id, outputMode: "review" }),
    );
    assert.equal(f.store.get<Draft>("draft", d.id)?.outputMode, "result");
  } finally {
    f.store.close();
  }
});

test("changing a prepared process action replaces only its generated request and reference, keeping user writing and other materials", () => {
  const f = fixture();
  try {
    const source = f.store.addMaterial("用户材料", "用户自己的证据");
    f.store.saveDraft({
      id: f.run.workId,
      text: "我的补充不能丢",
      refs: [{ materialId: source.id, version: 1, label: source.title }],
      recipient: null,
      projectId: f.project.id,
    });
    const first = f.records.prepare({
      workId: f.run.workId,
      mode: "explanation",
      contributionIds: [f.contribution.id],
    });
    const { preparedProcess, ...uiDraft } = first;
    f.store.saveDraft({ ...uiDraft, text: first.text + "\n\n我又补充了一点" });
    const second = f.records.prepare({
      workId: f.run.workId,
      mode: "summary",
      runId: f.run.id,
    });
    assert.ok(second.text.includes("我的补充不能丢"));
    assert.ok(second.text.includes("我又补充了一点"));
    assert.ok(!second.text.includes("本轮只讨论"));
    assert.equal(second.outputMode, "summary");
    assert.equal(second.refs.length, 2);
    assert.equal(second.refs[0].materialId, source.id);
    assert.ok(
      !second.refs.some((r) => r.materialId === preparedProcess!.materialId),
    );
  } finally {
    f.store.close();
  }
});
