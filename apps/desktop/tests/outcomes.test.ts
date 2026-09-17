import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { Outcomes } from "../src/core/outcomes";
import { ProcessRecords } from "../src/core/process";
import { Artifacts } from "../src/core/artifacts";
import { Runtime } from "../src/core/runtime";
import { commandSchema } from "../src/core/commands";
import {
  outcomeSnapshotChanged,
  type OutcomeInput,
} from "../src/core/outcome-contract";
import type { Contribution, Draft, SubmitInput } from "../src/core/types";
import type { Model, Prompt } from "../src/core/ycore";
const submit = (extra: Partial<SubmitInput> = {}): SubmitInput => ({
  key: randomUUID(),
  context: "new",
  text: "制定读书会主持说明",
  refs: [],
  recipient: null,
  projectId: null,
  ...extra,
});
function fixture(path = ":memory:") {
  const store = new Store(path);
  const project = store.createProject("测试栏目", "开场需在一分钟内", "media");
  const delivery = store.createDelivery(project.id, "主持说明");
  const run = store.submit(
    submit({ projectId: project.id, deliveryId: delivery.id }),
  );
  store.setRun(run.id, { status: "running" });
  const c: Contribution = {
    id: `${run.id}:0`,
    workId: run.workId,
    runId: run.id,
    memberId: "researcher",
    memberName: "研究员",
    objective: "核对主持条件",
    body: "到场人数未知；请核实设备。",
    status: "succeeded",
    remoteId: null,
    error: null,
    createdAt: new Date().toISOString(),
  };
  store.put("contribution", c.id, c);
  const version = store.finish(
    run.id,
    "请主持人介绍三位嘉宾，设备和到场人数待核实。",
    true,
  )!;
  store.adopt(delivery.id, version.id);
  return {
    store,
    project,
    delivery,
    run,
    version,
    service: new Outcomes(store),
  };
}
function input(
  versionId: string,
  extra: Partial<OutcomeInput> = {},
): OutcomeInput {
  return {
    key: randomUUID(),
    versionId,
    kind: "usage",
    recipient: "主持人",
    purpose: "用于一分钟开场",
    occurredOn: "2026-09-17",
    body: "现场试读超时，尚未正式使用。",
    refs: [],
    ...extra,
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
      text: "测试模型固定意见：接收对象主持人；设备缺少证据，用户记录不能证明已验证。",
    };
    yield { type: "run.completed" as const, run_id: key };
  }
}
function send(runtime: Runtime, d: Draft) {
  return runtime.submit(submit({ ...d, context: d.id }));
}
test("outcomes retain exact versions and frozen evidence; idempotent retries neither duplicate nor silently change the report", () => {
  const f = fixture();
  try {
    const m = f.store.addMaterial("现场试读", "主持人反馈：90 秒，需缩短。");
    const raw = input(f.version.id, {
      refs: [
        {
          materialId: m.id,
          version: m.version,
          label: "伪造标题",
          excerpt: "90 秒",
        },
      ],
    });
    const saved = f.service.record(raw);
    assert.equal(saved.source, "user_report");
    assert.equal(saved.evidence[0].reference.label, m.title);
    assert.equal(f.service.record(raw).id, saved.id);
    assert.throws(
      () => f.service.record({ ...raw, body: "偷偷改成成功" }),
      /已使用/,
    );
    const nextRun = f.store.submit(
      submit({ context: f.run.workId, projectId: f.project.id }),
    );
    f.store.setRun(nextRun.id, { status: "running" });
    const next = f.store.finish(nextRun.id, "修改后开场。", true)!;
    assert.equal(
      f.store.snapshot().outcomes.filter((r) => r.versionId === next.id).length,
      0,
    );
    f.store.put("material", `${m.id}@1`, { ...m, body: "事后不同内容" });
    assert.equal(
      f.store.snapshot().outcomes[0].evidence[0].material.body,
      m.body,
    );
    assert.equal(
      f.store.snapshot().deliveries[0].adoptedVersionId,
      f.version.id,
    );
  } finally {
    f.store.close();
  }
});
test("withdrawal is recorded with reason, survives reopening and appears in fresh reviews without rewriting old snapshots", () => {
  const dir = mkdtempSync(join(tmpdir(), "ytriple-outcome-"));
  const path = join(dir, "db");
  const f = fixture(path);
  try {
    const record = f.service.record(
      input(f.version.id, { kind: "validation", body: "误填：验证通过" }),
    );
    const old = new ProcessRecords(f.store).prepare({
      workId: f.run.workId,
      runId: f.run.id,
      mode: "review",
    });
    const oldBody = f.store.material(old.refs[0]).body;
    f.service.withdraw(record.id, "验证过程属于别的版本");
    assert.throws(() => f.service.withdraw(record.id, "  "), /原因/);
    const fresh = new ProcessRecords(f.store).prepare({
      workId: f.run.workId,
      runId: f.run.id,
      mode: "review",
    });
    assert.ok(f.store.material(fresh.refs[0]).body.includes("本记录已撤回"));
    assert.equal(f.store.material(old.refs[0]).body, oldBody);
    assert.ok(!oldBody.includes("本记录已撤回"));
    const other = new Store(path);
    try {
      assert.equal(
        other.snapshot().outcomes[0].withdrawn?.reason,
        "验证过程属于别的版本",
      );
    } finally {
      other.close();
    }
  } finally {
    f.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("readiness preparation preserves original draft, replaces generated request only, scopes exact version/receiver and executes nothing", () => {
  const f = fixture();
  try {
    f.store.saveDraft({
      id: f.run.workId,
      text: "保留我的疑问",
      refs: [],
      recipient: "reviewer",
      projectId: f.project.id,
    });
    const a = f.service.prepare({
      versionId: f.version.id,
      recipient: "主持人",
      purpose: "一分钟开场",
    });
    assert.equal(a.outputMode, "readiness");
    assert.equal(a.recipient, "reviewer");
    const m = f.store.material(a.refs[0]);
    assert.equal(m.readinessSource?.versionId, f.version.id);
    assert.ok(m.body.includes(f.version.body));
    assert.ok(m.body.includes("一分钟"));
    const { preparedProcess: _, ...ui } = a;
    f.store.saveDraft({ ...ui, text: a.text + "\n\n补充：要关注时长。" });
    const b = f.service.prepare({
      versionId: f.version.id,
      recipient: "剪辑师",
      purpose: "视频剪辑",
    });
    assert.equal(b.refs.length, 1);
    assert.ok(b.text.includes("保留我的疑问"));
    assert.ok(b.text.includes("补充：要关注时长。"));
    assert.ok(f.store.material(b.refs[0]).body.includes("剪辑师"));
    assert.ok(!f.store.material(b.refs[0]).body.includes("接收对象：主持人"));
    assert.ok(f.store.material(a.refs[0]).body.includes("接收对象：主持人"));
    assert.equal(f.store.snapshot().runs.length, 1);
    assert.equal(f.store.snapshot().outcomes.length, 0);
    const c = new ProcessRecords(f.store).prepare({
      workId: f.run.workId,
      mode: "summary",
    });
    assert.equal(c.refs.length, 1);
    assert.ok(!c.text.includes("输出独立的 AI 检查意见"));
    assert.ok(c.text.includes("保留我的疑问"));
  } finally {
    f.store.close();
  }
});
test("readiness executes as an independent support result and feedback reaches review without adopting changes or inheriting use", async () => {
  const f = fixture();
  try {
    const m = f.store.addMaterial("试读记录", "实测 90 秒，只做了一次试读。");
    const record = f.service.record(
      input(f.version.id, {
        refs: [{ materialId: m.id, version: 1, label: m.title }],
      }),
    );
    const model = new Capture(),
      runtime = new Runtime(f.store, () => model);
    const draft = f.service.prepare({
      versionId: f.version.id,
      recipient: "主持人",
      purpose: "一分钟开场",
    });
    const r = send(runtime, draft);
    await runtime.settled(r.workId);
    const report = f.store.snapshot().versions.find((v) => v.runId === r.id)!;
    assert.equal(report.kind, "readiness");
    assert.notEqual(report.artifactId, f.version.artifactId);
    assert.ok(model.prompts[0].messages[0].content.includes("不能认证可用"));
    assert.ok(model.prompts[0].messages[1].content.includes(m.body));
    assert.throws(() => f.store.adopt(f.delivery.id, report.id), /不能替代/);
    assert.throws(() => f.service.record(input(report.id)), /主成果/);
    const revise = new Artifacts(f.store).prepareRevision({
      workId: r.workId,
      versionId: report.id,
    });
    assert.equal(revise.outputMode, "readiness");
    const revised = send(runtime, revise);
    await runtime.settled(r.workId);
    assert.equal(
      f.store.snapshot().versions.find((v) => v.runId === revised.id)?.parentId,
      report.id,
    );
    const review = new ProcessRecords(f.store).prepare({
      workId: r.workId,
      mode: "review",
      runId: f.run.id,
      versionId: f.version.id,
    });
    const snapshot = f.store.material(review.refs.at(-1)!);
    assert.deepEqual(snapshot.processSource?.outcomeIds, [record.id]);
    const rr = send(runtime, review);
    await runtime.settled(r.workId);
    assert.equal(
      f.store.snapshot().versions.find((v) => v.runId === rr.id)?.kind,
      "review",
    );
    assert.equal(
      f.store.snapshot().deliveries[0].adoptedVersionId,
      f.version.id,
    );
    assert.equal(f.store.snapshot().outcomes.length, 1);
    assert.equal(
      f.store.snapshot().versions.filter((v) => v.kind === "result").length,
      1,
    );
  } finally {
    f.store.close();
  }
});
test("review includes only scoped versions and records, while explicit historical manual result can be reviewed without losing its feedback", () => {
  const f = fixture(),
    other = fixture();
  try {
    const a = f.service.record(input(f.version.id));
    const nextRun = f.store.submit(
      submit({ context: f.run.workId, projectId: f.project.id }),
    );
    f.store.setRun(nextRun.id, { status: "running" });
    const next = f.store.finish(nextRun.id, "后续不同版本", true)!;
    f.service.record(input(next.id, { body: "新版专属使用反馈" }));
    const d = new ProcessRecords(f.store).prepare({
      workId: f.run.workId,
      runId: f.run.id,
      mode: "review",
    });
    const m = f.store.material(d.refs[0]);
    assert.deepEqual(m.processSource?.outcomeIds, [a.id]);
    assert.ok(!m.body.includes("新版专属使用反馈"));
    const historical = {
      ...next,
      id: randomUUID(),
      author: "user" as const,
      runId: null,
      body: "历史手动版本",
    };
    f.store.put("version", historical.id, historical);
    const b = f.service.record(
      input(historical.id, { body: "历史版本专属反馈" }),
    );
    const history = new ProcessRecords(f.store).prepare({
      workId: f.run.workId,
      mode: "review",
      versionId: historical.id,
    });
    assert.ok(
      f.store
        .material(history.refs[0])
        .processSource?.outcomeIds?.includes(b.id),
    );
    f.store.put("version", other.version.id, other.version);
    assert.throws(
      () =>
        new ProcessRecords(f.store).prepare({
          workId: f.run.workId,
          mode: "review",
          versionId: other.version.id,
        }),
      /不属于/,
    );
    assert.throws(
      () =>
        new ProcessRecords(f.store).prepare({
          workId: f.run.workId,
          mode: "summary",
          versionId: f.version.id,
        }),
      /不属于/,
    );
  } finally {
    f.store.close();
    other.store.close();
  }
});
test("invalid, oversized and missing evidence requests reject atomically; failed readiness preparation never erases an existing draft", () => {
  const f = fixture();
  try {
    f.store.saveDraft({
      id: f.run.workId,
      text: "不能丢的草稿",
      refs: [],
      recipient: null,
      projectId: f.project.id,
    });
    const before = f.store.snapshot();
    assert.equal(
      commandSchema.safeParse({
        type: "record-outcome",
        input: input(f.version.id, { occurredOn: "2026-02-30" }),
      }).success,
      false,
    );
    assert.throws(() => f.service.record(input("missing")));
    assert.throws(() =>
      f.service.prepare({
        versionId: f.version.id,
        recipient: " ",
        purpose: "试用",
      }),
    );
    const m = f.store.addMaterial("证据", "真实内容");
    assert.throws(
      () =>
        f.service.record(
          input(f.version.id, {
            refs: [
              { materialId: m.id, version: 1, label: m.title, excerpt: "虚构" },
            ],
          }),
        ),
      /选段/,
    );
    const huge = f.store.addMaterial("超长", "长".repeat(10000));
    assert.throws(
      () =>
        f.service.record(
          input(f.version.id, {
            refs: [{ materialId: huge.id, version: 1, label: huge.title }],
          }),
        ),
      /过长/,
    );
    f.store.put("version", f.version.id, {
      ...f.version,
      body: "长".repeat(10000),
    });
    assert.throws(
      () =>
        f.service.prepare({
          versionId: f.version.id,
          recipient: "读者",
          purpose: "试读",
        }),
      /超出/,
    );
    assert.deepEqual(f.store.snapshot().drafts, before.drafts);
    assert.equal(f.store.snapshot().outcomes.length, 0);
    assert.equal(f.store.all("outcome-input").length, 0);
    f.store.setRun(f.run.id, { status: "failed" });
    assert.throws(() => f.service.record(input(f.version.id)), /已完成/);
  } finally {
    f.store.close();
  }
});

test("feedback changes invalidate the freshness of captured opinions, including withdrawals, without borrowing another version's evidence", () => {
  const f = fixture();
  try {
    const first = f.service.prepare({
      versionId: f.version.id,
      recipient: "主持人",
      purpose: "试读",
    });
    const empty = f.store.material(first.refs[0]);
    assert.equal(outcomeSnapshotChanged(empty, []), false);
    const record = f.service.record(input(f.version.id));
    assert.equal(
      outcomeSnapshotChanged(empty, f.store.snapshot().outcomes),
      true,
    );
    const second = f.service.prepare({
      versionId: f.version.id,
      recipient: "主持人",
      purpose: "试读",
    });
    const captured = f.store.material(second.refs[0]);
    assert.equal(
      outcomeSnapshotChanged(captured, f.store.snapshot().outcomes),
      false,
    );
    const review = new ProcessRecords(f.store).prepare({
      workId: f.run.workId,
      mode: "review",
    });
    const reviewed = f.store.material(review.refs[0]);
    assert.equal(
      outcomeSnapshotChanged(reviewed, f.store.snapshot().outcomes),
      false,
    );
    f.service.withdraw(record.id, "测试撤回");
    assert.equal(
      outcomeSnapshotChanged(captured, f.store.snapshot().outcomes),
      true,
    );
    assert.equal(
      outcomeSnapshotChanged(reviewed, f.store.snapshot().outcomes),
      true,
    );
    assert.equal(
      outcomeSnapshotChanged(empty, [
        { ...record, versionId: "other-version" },
      ]),
      false,
    );
  } finally {
    f.store.close();
  }
});
