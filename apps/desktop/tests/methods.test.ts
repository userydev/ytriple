import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { Methods } from "../src/core/methods";
import { Skills } from "../src/core/skills";
import { ProcessRecords } from "../src/core/process";
import { Artifacts } from "../src/core/artifacts";
import { Outcomes } from "../src/core/outcomes";
import { Runtime } from "../src/core/runtime";
import { LocalDirectories } from "../src/core/local-directories";
import { skillKey, isTrialMethod } from "../src/core/skill-contract";
import { outcomeSnapshotChanged } from "../src/core/outcome-contract";
import {
  defaultTeam,
  type ArtifactVersion,
  type Contribution,
  type Draft,
  type Run,
  type SubmitInput,
} from "../src/core/types";
import type { Model, Prompt } from "../src/core/ycore";
const input = (extra: Partial<SubmitInput> = {}): SubmitInput => ({
  key: randomUUID(),
  context: "new",
  text: "整理读书会开场",
  refs: [],
  recipient: null,
  projectId: null,
  ...extra,
});
const methodBody =
  "# 目标与实测分开核对\n\n## 适用范围\n有目标和实测记录、但解释不充分的任务。\n\n## 步骤\n逐项对照目标、实测和未知；给出需要验证的步骤。\n\n## 实例与限制\n一次 90 秒试读不能证明 60 秒方案可用，超时原因未知。不可保证效果。";
function finish(store: Store, raw: SubmitInput, body: string) {
  const run = store.submit(raw);
  store.setRun(run.id, { status: "running" });
  store.put<Contribution>("contribution", `${run.id}:0`, {
    id: `${run.id}:0`,
    runId: run.id,
    workId: run.workId,
    memberId: "editor",
    memberName: "编辑员",
    objective: raw.text,
    body,
    status: "succeeded",
    remoteId: null,
    error: null,
    createdAt: new Date().toISOString(),
  });
  return { run, version: store.finish(run.id, body, true)! };
}
function fixture(path = ":memory:") {
  const store = new Store(path);
  store.initializeConfiguration();
  new Skills(store).initialize();
  const project = store.createProject("栏目 A", "有依据的表达", "media"),
    delivery = store.createDelivery(project.id, "开场");
  const first = finish(
    store,
    input({ projectId: project.id, deliveryId: delivery.id }),
    "按字数估计约 60 秒，尚无试读。",
  );
  const second = finish(
    store,
    input({
      context: first.run.workId,
      text: "实际试读是90秒，缺少分段数据，不能保证修改达标。",
    }),
    "目标60秒，实际90秒，原因未知，仍需验证。",
  );
  store.adopt(delivery.id, second.version.id);
  const outcome = new Outcomes(store).record({
    key: randomUUID(),
    versionId: second.version.id,
    kind: "usage",
    recipient: "测试作者",
    purpose: "试读",
    occurredOn: "2026-09-17",
    body: "只有一次试读，没有观众反馈。",
    refs: [],
  });
  return {
    store,
    project,
    delivery,
    first,
    second,
    outcome,
    methods: new Methods(store),
  };
}
function proposal(f: ReturnType<typeof fixture>) {
  const draft = new ProcessRecords(f.store).prepare({
    workId: f.first.run.workId,
    versionId: f.second.version.id,
    mode: "method",
  });
  return {
    ...finish(
      f.store,
      input({
        context: draft.id,
        text: draft.text,
        refs: draft.refs,
        outputMode: draft.outputMode,
        projectId: draft.projectId,
      }),
      methodBody,
    ),
    draft,
  };
}
class Capture implements Model {
  prompts: Prompt[] = [];
  async *stream(p: Prompt, key: string) {
    this.prompts.push(p);
    yield { type: "run.started" as const, run_id: key };
    yield {
      type: "text.delta" as const,
      run_id: key,
      text: "目标120秒；实测150秒；原因与下一版时长未知。需要完整复读验证。",
    };
    yield { type: "run.completed" as const, run_id: key };
  }
}
function send(runtime: Runtime, draft: Draft, text: string) {
  return runtime.submit(
    input({
      context: draft.id,
      projectId: draft.projectId,
      refs: draft.refs,
      skillKeys: draft.skillKeys,
      text,
      outputMode: draft.outputMode,
    }),
  );
}
test("method draft freezes actual corrections, results and scoped feedback, preserves working draft and adopted main result", () => {
  const f = fixture();
  try {
    f.store.saveDraft({
      id: f.first.run.workId,
      text: "用户已有补充",
      refs: [],
      recipient: "editor",
      projectId: f.project.id,
    });
    const p = proposal(f),
      material = f.store.material(p.draft.refs.at(-1)!);
    assert.match(p.draft.text, /用户已有补充/);
    assert.equal(p.draft.recipient, "editor");
    assert.ok(material.body.includes(f.outcome.id));
    assert.ok(material.body.includes(f.first.version.id));
    assert.ok(material.body.includes(f.second.version.id));
    assert.match(material.body, /实际试读是90秒/);
    assert.equal(p.version.kind, "method");
    assert.equal(p.version.number, 1);
    assert.notEqual(p.version.artifactId, f.second.version.artifactId);
    assert.equal(
      f.store.snapshot().deliveries[0].adoptedVersionId,
      f.second.version.id,
    );
    assert.equal(
      f.store.require<ArtifactVersion>("version", f.second.version.id).body,
      "目标60秒，实际90秒，原因未知，仍需验证。",
    );
    assert.throws(() => f.store.adopt(f.delivery.id, p.version.id));
    new Outcomes(f.store).withdraw(f.outcome.id, "测试撤回");
    assert.equal(
      outcomeSnapshotChanged(material, f.store.snapshot().outcomes),
      true,
    );
    assert.ok(!material.body.includes("测试撤回"));
    assert.equal(
      f.store.snapshot().skills.filter((s) => s.source.kind === "proposal")
        .length,
      0,
    );
  } finally {
    f.store.close();
  }
});
test("trial is explicit and idempotent, preserves user inputs, separates project scopes and never silently joins member catalog", () => {
  const f = fixture();
  try {
    const p = proposal(f),
      a = f.methods.prepareTrial(p.version.id, null),
      key = a.skillKeys![0];
    assert.equal(a.text, "");
    assert.equal(a.refs.length, 0);
    assert.equal(a.projectId, null);
    assert.equal(f.store.snapshot().runs.length, 3);
    f.store.saveDraft({ ...a, text: "保留试用目标" });
    const repeat = f.methods.prepareTrial(p.version.id, null);
    assert.equal(repeat.id, a.id);
    assert.equal(repeat.text, "保留试用目标");
    assert.equal(repeat.skillKeys!.length, 1);
    const b = f.methods.prepareTrial(p.version.id, f.project.id);
    assert.notEqual(b.id, a.id);
    assert.equal(b.projectId, f.project.id);
    const team = {
      ...defaultTeam,
      members: defaultTeam.members.map((m) => ({ ...m, skillKeys: [key] })),
    };
    assert.ok(
      !new Skills(f.store).capture([], team).some((s) => skillKey(s) === key),
    );
    assert.ok(
      new Skills(f.store).capture([key], team).some((s) => skillKey(s) === key),
    );
    const method = f.store.snapshot().skills.find((s) => skillKey(s) === key)!;
    assert.ok(isTrialMethod(method, []));
    assert.equal(method.proposal!.versionId, p.version.id);
    assert.match(method.description, /有目标和实测记录/);
    assert.throws(
      () => f.methods.adopt(key, p.run.id, "仅草案生成"),
      /确实载入/,
    );
    new Skills(f.store).state(method.id, false);
    assert.throws(() => f.methods.prepareTrial(p.version.id, null), /不可加载/);
    assert.equal(f.store.get<Draft>("draft", a.id)!.text, "保留试用目标");
  } finally {
    f.store.close();
  }
});
test("completed trial is loaded into actual request; adoption points at exact run and version but does not rewrite teams or global standards", async () => {
  const f = fixture();
  try {
    const p = proposal(f),
      draft = f.methods.prepareTrial(p.version.id, null),
      key = draft.skillKeys![0];
    const model = new Capture(),
      runtime = new Runtime(f.store, () => model),
      trial = send(
        runtime,
        draft,
        "试用：目标120秒，实测150秒，形成有限结论。",
      );
    await runtime.settled(trial.workId);
    assert.equal(f.store.require<Run>("run", trial.id).status, "succeeded");
    assert.ok(model.prompts[0].messages[0].content.includes(methodBody));
    const teams = JSON.stringify(f.store.snapshot().teams),
      standards = JSON.stringify(f.store.snapshot().projectStandards);
    const accepted = f.methods.adopt(
      key,
      trial.id,
      "保留估算和实测差异，适用于已有演练记录的稿件。",
    );
    assert.equal(accepted.trialRunId, trial.id);
    assert.equal(
      f.methods.adopt(key, trial.id, "repeat").acceptedAt,
      accepted.acceptedAt,
    );
    assert.equal(JSON.stringify(f.store.snapshot().teams), teams);
    assert.equal(
      JSON.stringify(f.store.snapshot().projectStandards),
      standards,
    );
    const team = {
      ...defaultTeam,
      members: defaultTeam.members.map((m) => ({ ...m, skillKeys: [key] })),
    };
    assert.ok(
      new Skills(f.store).capture([], team).some((s) => skillKey(s) === key),
    );
    const v2draft = new Artifacts(f.store).prepareRevision({
      workId: p.run.workId,
      versionId: p.version.id,
    });
    assert.ok(
      v2draft.refs.some(
        (r) => f.store.material(r).processSource?.mode === "method",
      ),
    );
    const v2 = finish(
      f.store,
      input({
        context: v2draft.id,
        text: v2draft.text,
        refs: v2draft.refs,
        outputMode: v2draft.outputMode,
      }),
      methodBody + "\n新增限制：无来源不作结论。",
    );
    assert.equal(v2.version.number, 2);
    const trial2 = f.methods.prepareTrial(v2.version.id, null);
    assert.notEqual(trial2.skillKeys![0], key);
    const method2 = f.store
      .snapshot()
      .skills.find((s) => skillKey(s) === trial2.skillKeys![0])!;
    assert.ok(isTrialMethod(method2, f.store.snapshot().skillAdoptions));
    assert.equal(f.store.snapshot().skillAdoptions.length, 1);
  } finally {
    f.store.close();
  }
});
test("source, completed state and input limits fail atomically without turning ordinary outputs into methods", () => {
  const f = fixture();
  try {
    assert.throws(
      () => f.methods.prepareTrial(f.second.version.id, null),
      /方法草案/,
    );
    const direct = finish(f.store, input({ outputMode: "method" }), methodBody);
    assert.throws(
      () => f.methods.prepareTrial(direct.version.id, null),
      /过程依据/,
    );
    const p = proposal(f),
      before = f.store.snapshot().skills.length;
    f.store.setRun(p.run.id, { status: "failed" });
    assert.throws(() => f.methods.prepareTrial(p.version.id, null), /已完成/);
    assert.equal(f.store.snapshot().skills.length, before);
    f.store.setRun(p.run.id, { status: "succeeded" });
    f.store.put("version", p.version.id, {
      ...p.version,
      body: "中".repeat(6000),
    });
    assert.throws(() => f.methods.prepareTrial(p.version.id, null), /过长/);
    assert.equal(f.store.snapshot().skills.length, before);
  } finally {
    f.store.close();
  }
});
test("method source and accepted state survive restart; export carries provenance without adopting or restoring foreign work on import", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ytriple-methods-")));
  let f = fixture(join(dir, "db"));
  try {
    const p = proposal(f),
      draft = f.methods.prepareTrial(p.version.id, null),
      key = draft.skillKeys![0];
    const model = new Capture(),
      runtime = new Runtime(f.store, () => model),
      trial = send(runtime, draft, "使用目标和实测核对方法");
    await runtime.settled(trial.workId);
    f.methods.adopt(key, trial.id, "只采纳条件与证据核对方法，效果仍待验证");
    f.store.close();
    const store = new Store(join(dir, "db"));
    f = { ...f, store, methods: new Methods(store) };
    const method = store.snapshot().skills.find((s) => skillKey(s) === key)!;
    assert.equal(method.proposal!.versionId, p.version.id);
    assert.equal(store.snapshot().skillAdoptions[0].trialRunId, trial.id);
    await mkdir(join(dir, "AI"));
    await mkdir(join(dir, "Code"));
    await new LocalDirectories(store).discover(dir);
    const path = join(dir, "AI/proposal.method.json");
    await new Skills(store).exportFile(key, path);
    const json = JSON.parse(await readFile(path, "utf8"));
    assert.equal(json.provenance.versionId, p.version.id);
    const foreign = new Store(":memory:");
    try {
      await new LocalDirectories(foreign).discover(dir);
      const imported = await new Skills(foreign).importFile(path);
      assert.equal(imported.importedProposal!.versionId, p.version.id);
      assert.equal(imported.proposal, undefined);
      assert.equal(imported.source.kind, "local");
      assert.equal(foreign.snapshot().works.length, 0);
      assert.equal(foreign.snapshot().skillAdoptions.length, 0);
    } finally {
      foreign.close();
    }
  } finally {
    f.store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
