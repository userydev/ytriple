import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../src/core/store";
import { Runtime } from "../src/core/runtime";
import { ProcessRecords } from "../src/core/process";
import { Outcomes } from "../src/core/outcomes";
import { WorkflowLearning } from "../src/core/workflow-learning";
import { parseTeamResponse, teamResponse } from "../src/core/team-response";
import { buildTaskInputManifest, materialManifestId } from "../src/core/input-manifest";
import { processSnapshotStaleData } from "../src/core/process-scope-stale";
import type { Model, Prompt, StreamEvent } from "../src/core/ycore";
import type { Contribution, SubmitInput } from "../src/core/types";
import { legacyFinish, protocolModel } from "./team-response";

const request = (extra: Partial<SubmitInput> = {}): SubmitInput => ({
  key: randomUUID(),
  context: "new",
  text: "写一段说明",
  refs: [],
  recipient: null,
  projectId: null,
  ...extra,
});

test("illegal feedback ref is stripped while legal answer and artifact publish", () => {
  const store = new Store(":memory:");
  store.initializeConfiguration();
  const run = store.submit(request());
  store.setRun(run.id, { status: "running" });
  const ref = { materialId: "mat-1", version: 1, label: "材料" };
  store.put("material", "mat-1@1", {
    id: "mat-1",
    version: 1,
    title: "材料",
    body: "正文",
    coverage: "full",
    createdAt: new Date().toISOString(),
  });
  const manifest = buildTaskInputManifest(store, run, "c1", [ref]);
  store.put("input-manifest", manifest.id, manifest);
  const legalId = materialManifestId(ref);
  const body = teamResponse(
    "可读回答",
    { body: "成果正文", baseVersionId: null },
    {
      basis: "依据材料",
      feedback: [
        { sourceId: legalId, stance: "used" },
        { sourceId: "mat:missing@1", stance: "used" },
      ],
    },
  );
  const parsed = parseTeamResponse(body, run, true, manifest);
  assert.equal(parsed?.answer, "可读回答");
  assert.equal(parsed?.public?.feedback?.length, 1);
  assert.ok(parsed?.publicWarnings?.[0]?.includes("missing"));
  store.close();
});

test("contribution can carry host tool failure separate from AI success claim", () => {
  const store = new Store(":memory:");
  store.initializeConfiguration();
  const run = store.submit(request());
  store.put("contribution", "c-tool", {
    id: "c-tool",
    workId: run.workId,
    runId: run.id,
    memberId: "researcher",
    memberName: "研究员",
    objective: "算",
    body: teamResponse("我已完成计算。", null),
    status: "succeeded",
    remoteId: null,
    error: null,
    createdAt: new Date().toISOString(),
    tool: {
      request: {
        key: "builtin.calculate@1",
        purpose: "算",
        input: { expression: "1/0" },
      },
      status: "failed",
      output: "除零",
      capturedAt: new Date().toISOString(),
    },
  });
  const c = store.require<Contribution>("contribution", "c-tool");
  assert.equal(c.tool?.status, "failed");
  assert.ok(c.body.includes("已完成"));
  store.close();
});

test("process snapshot marks uncovered after new user message and superseded after feedback withdraw", () => {
  const store = new Store(":memory:");
  store.initializeConfiguration();
  const project = store.createProject("P", "g", "media");
  const run = store.submit(request({ projectId: project.id }));
  store.setRun(run.id, { status: "running" });
  const c: Contribution = {
    id: `${run.id}:0`,
    workId: run.workId,
    runId: run.id,
    memberId: "researcher",
    memberName: "研究员",
    objective: "o",
    body: "公开分析",
    status: "succeeded",
    remoteId: null,
    error: null,
    createdAt: new Date().toISOString(),
  };
  store.put("contribution", c.id, c);
  const version = legacyFinish(store, run.id, "成果 v1", true)!;
  const draft = new ProcessRecords(store).prepare({
    workId: run.workId,
    mode: "review",
    runId: run.id,
  });
  const material = store.material(draft.refs.at(-1)!);
  const snap = () => store.snapshot();
  assert.equal(
    processSnapshotStaleData(material, snap()).status,
    "current",
  );
  store.put("message", randomUUID(), {
    id: randomUUID(),
    workId: run.workId,
    runId: run.id,
    role: "user",
    body: "新输入",
    refs: [],
    createdAt: new Date(Date.now() + 1000).toISOString(),
  });
  assert.equal(
    processSnapshotStaleData(material, snap()).status,
    "uncovered",
  );
  store.close();
});

test("process snapshot marks superseded when scoped feedback state changes", () => {
  const store = new Store(":memory:");
  store.initializeConfiguration();
  const run = store.submit(request());
  store.setRun(run.id, { status: "running" });
  store.put("contribution", `${run.id}:0`, {
    id: `${run.id}:0`,
    workId: run.workId,
    runId: run.id,
    memberId: "researcher",
    memberName: "研究员",
    objective: "o",
    body: "公开分析",
    status: "succeeded",
    remoteId: null,
    error: null,
    createdAt: new Date().toISOString(),
  });
  const version = legacyFinish(store, run.id, "成果 v1", true)!;
  const outcomes = new Outcomes(store);
  const saved = outcomes.record({
    key: randomUUID(),
    versionId: version.id,
    kind: "usage",
    recipient: "主持人",
    purpose: "试读",
    occurredOn: "2026-09-17",
    body: "超时",
    refs: [],
  });
  const draft = new ProcessRecords(store).prepare({
    workId: run.workId,
    mode: "review",
    runId: run.id,
  });
  const material = store.material(draft.refs.at(-1)!);
  assert.equal(processSnapshotStaleData(material, store.snapshot()).status, "current");
  outcomes.withdraw(saved.id, "撤回");
  assert.equal(
    processSnapshotStaleData(material, store.snapshot()).status,
    "superseded",
  );
  store.close();
});

test("workflow candidate id is per source run and invalid parse does not fail the explanation run", async () => {
  const store = new Store(":memory:");
  store.initializeConfiguration();
  const run = store.submit(request());
  store.setRun(run.id, { status: "running" });
  store.put("contribution", `${run.id}:0`, {
    id: `${run.id}:0`,
    workId: run.workId,
    runId: run.id,
    memberId: "researcher",
    memberName: "R",
    objective: "o",
    body: "过程",
    status: "succeeded",
    remoteId: null,
    error: null,
    createdAt: new Date().toISOString(),
  });
  legacyFinish(store, run.id, "v1", true);
  const reviewDraft = new ProcessRecords(store).prepare({
    workId: run.workId,
    mode: "review",
    runId: run.id,
  });
  const reviewRun = store.submit(
    request({
      context: reviewDraft.id,
      text: reviewDraft.text,
      refs: reviewDraft.refs,
      recipient: reviewDraft.recipient,
      projectId: reviewDraft.projectId,
      outputMode: "review",
    }),
  );
  store.setRun(reviewRun.id, { status: "running" });
  const reviewVersion = legacyFinish(store, reviewRun.id, "# 复盘", true)!;
  const wd = new WorkflowLearning(store).prepare(reviewVersion.id);
  class Bad implements Model {
    async *stream(_p: Prompt, key: string): AsyncGenerator<StreamEvent> {
      yield { type: "run.started", run_id: key };
      yield {
        type: "text.delta",
        run_id: key,
        text: teamResponse("坏候选", null),
      };
      yield { type: "run.completed", run_id: key };
    }
  }
  const runtime = new Runtime(store, () => protocolModel(new Bad()));
  const explain = runtime.submit({
    key: randomUUID(),
    context: wd.id,
    text: wd.text,
    refs: wd.refs,
    recipient: wd.recipient,
    projectId: wd.projectId,
    outputMode: "explanation",
  });
  await runtime.settled(explain.workId);
  assert.equal(store.require<import("../src/core/types").Run>("run", explain.id).status, "succeeded");
  const candidate = store.snapshot().workflowCandidates[0];
  assert.ok(candidate.parseError);
  assert.equal(candidate.id, `${reviewVersion.id}:${explain.id}`);
  store.close();
});

test("workflow candidates from different works do not share candidate id when content matches", () => {
  const make = () => {
    const store = new Store(":memory:");
    store.initializeConfiguration();
    const run = store.submit(request());
    store.setRun(run.id, { status: "running" });
    store.put("contribution", `${run.id}:0`, {
      id: `${run.id}:0`,
      workId: run.workId,
      runId: run.id,
      memberId: "researcher",
      memberName: "R",
      objective: "o",
      body: "过程",
      status: "succeeded",
      remoteId: null,
      error: null,
      createdAt: new Date().toISOString(),
    });
    legacyFinish(store, run.id, "v1", true);
    const reviewDraft = new ProcessRecords(store).prepare({
      workId: run.workId,
      mode: "review",
      runId: run.id,
    });
    const reviewRun = store.submit(
      request({
        context: reviewDraft.id,
        text: reviewDraft.text,
        refs: reviewDraft.refs,
        recipient: reviewDraft.recipient,
        projectId: reviewDraft.projectId,
        outputMode: "review",
      }),
    );
    store.setRun(reviewRun.id, { status: "running" });
    const reviewVersion = legacyFinish(store, reviewRun.id, "# 复盘", true)!;
    const fp = "same-fingerprint-content";
    store.put("workflow-candidate", `${reviewVersion.id}:run-a`, {
      id: `${reviewVersion.id}:run-a`,
      sourceVersionId: reviewVersion.id,
      sourceWorkId: run.workId,
      runId: "run-a",
      fingerprint: fp,
      preview: {
        name: "x",
        applicability: "a",
        unverified: [],
        sourceNotes: "s",
        stages: [{ role: "researcher", objective: "o", result: true }],
      },
      targetWorkflowId: "wf-a",
      status: "draft",
      createdAt: new Date().toISOString(),
    });
    return { store, reviewVersion, workId: run.workId };
  };
  const a = make();
  const b = make();
  assert.notEqual(
    a.store.snapshot().workflowCandidates[0].id,
    b.store.snapshot().workflowCandidates[0].id,
  );
  assert.equal(
    a.store.snapshot().workflowCandidates[0].fingerprint,
    b.store.snapshot().workflowCandidates[0].fingerprint,
  );
  a.store.close();
  b.store.close();
});

test("input manifest and workflow candidates survive backup roundtrip", () => {
  const store = new Store(":memory:");
  store.initializeConfiguration();
  const run = store.submit(request());
  const manifest = buildTaskInputManifest(store, run, "c-backup", []);
  store.put("input-manifest", manifest.id, manifest);
  store.put("workflow-candidate", "cand-1", {
    id: "cand-1",
    sourceVersionId: randomUUID(),
    sourceWorkId: run.workId,
    runId: run.id,
    fingerprint: "abc",
    preview: {
      name: "x",
      applicability: "a",
      unverified: [],
      sourceNotes: "s",
      stages: [
        { role: "researcher", objective: "o", result: true },
      ],
    },
    targetWorkflowId: "wf-new",
    status: "draft",
    createdAt: new Date().toISOString(),
  });
  const exported = store.exportState();
  const restored = new Store(":memory:");
  restored.restoreState(exported);
  assert.equal(restored.all("input-manifest").length, 1);
  assert.equal(restored.all("workflow-candidate").length, 1);
  store.close();
  restored.close();
});
