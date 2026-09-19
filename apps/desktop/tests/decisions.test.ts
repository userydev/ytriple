import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { Runtime } from "../src/core/runtime";
import { Decisions, parseDecision } from "../src/core/decisions";
import { ServiceError, type Model, type Prompt } from "../src/core/ycore";
import { protocolModel } from "./team-response";
import type { Decision, Draft, Run, Work } from "../src/core/types";
const question = {
  question: "首版是否包含离线导入？",
  reason: "这会改变你设定的交付范围，需要由你取舍。",
  impact: "仅影响当前首版的导入范围",
  options: [
    { label: "先做在线导入", detail: "尽早验证核心流程" },
    { label: "包含离线导入", detail: "延后交付并覆盖本地使用" },
  ],
};
const control = JSON.stringify({ ytriple_decision: question });
const request = (context = "new") => ({
  key: randomUUID(),
  context,
  text: "明确首版范围并形成方案",
  refs: [],
  recipient: null,
  projectId: null,
});
function stageAttempt(taskId: string, runId: string) {
  const tail = taskId.slice(runId.length + 1).split(":");
  const stage = Number(tail[0]);
  const attemptToken = tail.find((p) => /^a\d+$/.test(p));
  const legacyAttempt =
    tail.length > 1 && /^\d+$/.test(tail[1]) ? Number(tail[1]) : 0;
  const attempt = attemptToken
    ? Number(attemptToken.slice(1))
    : legacyAttempt;
  return { stage, attempt };
}
class DecisionModel implements Model {
  scope = "test-decision-service";
  calls: { key: string; prompt: Prompt }[] = [];
  askStage = 1;
  answerMode: "normal" | "interrupt" | "ask-again" = "normal";
  async *stream(prompt: Prompt, key: string) {
    this.calls.push({ key, prompt });
    yield { type: "run.started" as const, run_id: key };
    const runId = prompt.taskId.split(":")[0];
    const { stage, attempt } = stageAttempt(prompt.taskId, runId);
    if (this.answerMode === "interrupt" && attempt > 0)
      throw new ServiceError("STREAM_INTERRUPTED", "验证断线");
    const ask =
      stage === this.askStage &&
      (this.answerMode === "ask-again" ? attempt < 2 : attempt === 0) &&
      (this.answerMode === "ask-again" || !key.includes("answer-"));
    yield {
      type: "text.delta" as const,
      run_id: key,
      text: ask ? control : `已完成步骤 ${stage}，保留范围限制。`,
    };
    yield { type: "run.completed" as const, run_id: key };
  }
}
async function waiting(
  store = new Store(":memory:"),
  model = new DecisionModel(),
) {
  const runtime = new Runtime(store, () => protocolModel(model));
  const run = runtime.submit(request());
  const queued = runtime.submit({
    ...request(run.workId),
    text: "随后补充交接说明",
  });
  await runtime.settled(run.workId);
  const decision = store.snapshot().decisions[0];
  assert.equal(store.require<Run>("run", run.id).status, "waiting");
  return { store, model, runtime, run, queued, decision };
}
function answer(d: Decision, text = "先做在线导入") {
  return {
    decisionId: d.id,
    revision: d.revision,
    draftRevision: d.draftRevision,
    key: randomUUID(),
    text,
  };
}

test("a genuine decision pauses the same run, preserves supplement queue, and answers without replaying completed steps", async () => {
  const { store, model, runtime, run, queued, decision } = await waiting();
  assert.equal(model.calls.length, 2);
  assert.equal(store.snapshot().versions.length, 0);
  assert.equal(store.require<Work>("work", run.workId).queuePaused, true);
  assert.throws(() => runtime.resume(run.workId), /原待决/);
  assert.throws(() => runtime.submit(request(run.workId)), /等待答复/);
  store.saveDraft({
    id: run.workId,
    text: "另一个未发送草稿",
    refs: [],
    recipient: null,
    projectId: null,
  });
  const submission = answer(decision);
  runtime.answerDecision(submission);
  runtime.answerDecision(submission);
  await runtime.settled(run.workId);
  assert.equal(model.calls.length, 4);
  assert.equal(
    model.calls.filter((c) => c.prompt.taskId.startsWith(`${run.id}:0`)).length,
    1,
  );
  assert.ok(
    model.calls.some((c) =>
      JSON.stringify(c.prompt).includes("先做在线导入"),
    ),
  );
  assert.equal(store.require<Run>("run", run.id).status, "succeeded");
  assert.equal(store.require<Run>("run", queued.id).status, "queued");
  assert.equal(store.snapshot().runs.length, 2);
  assert.equal(store.snapshot().versions.length, 1);
  assert.equal(
    store.require<Draft>("draft", run.workId).text,
    "另一个未发送草稿",
  );
  assert.equal(
    store.snapshot().messages.filter((m) => m.id === `${decision.id}:answer`)
      .length,
    1,
  );
  assert.throws(
    () => runtime.answerDecision({ ...submission, text: "另一答案" }),
    /同一答复/,
  );
  assert.throws(
    () => runtime.answerDecision({ ...submission, key: randomUUID() }),
    /不再等待/,
  );
  runtime.resume(run.workId);
  await runtime.settled(run.workId);
  assert.notEqual(store.require<Run>("run", queued.id).status, "queued");
  store.close();
});

test("decision draft and checkpoint survive restart; shutdown does not cancel waiting and no model is called until answer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ytriple-decisions-"));
  try {
    const { store, runtime, run, decision } = await waiting(
      new Store(join(dir, "db")),
    );
    const saved = new Decisions(store).saveDraft(
      decision.id,
      1,
      0,
      "先做在线，离线留到下一版",
    );
    assert.throws(
      () => new Decisions(store).saveDraft(decision.id, 1, 0, "旧窗口"),
      /另一处/,
    );
    runtime.shutdown();
    store.close();
    const reopened = new Store(join(dir, "db"));
    reopened.recover();
    const model = new DecisionModel();
    const next = new Runtime(reopened, () => protocolModel(model));
    const d = reopened.require<Decision>("decision", decision.id);
    assert.equal(d.draft, saved.draft);
    assert.equal(reopened.require<Run>("run", run.id).status, "waiting");
    assert.equal(model.calls.length, 0);
    next.answerDecision(answer(d, d.draft));
    await next.settled(run.workId);
    assert.equal(model.calls.length, 2);
    assert.equal(reopened.require<Run>("run", run.id).status, "succeeded");
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale question version, changed result, wrong provider and cancelled decision cannot resume a paid run", async () => {
  const { store, model, runtime, run, decision } = await waiting();
  assert.throws(
    () => runtime.answerDecision({ ...answer(decision), revision: 2 }),
    /变化/,
  );
  model.scope = "different";
  assert.throws(() => runtime.answerDecision(answer(decision)), /另一服务/);
  model.scope = "test-decision-service";
  store.put("version", "external", { id: "external", workId: run.workId });
  assert.throws(() => runtime.answerDecision(answer(decision)), /过时/);
  new Decisions(store).saveDraft(decision.id, 1, 0, "保留尚未提交的取舍");
  runtime.stop(run.workId);
  const stopped = store.require<Decision>("decision", decision.id);
  assert.equal(stopped.status, "cancelled");
  assert.equal(stopped.draft, "保留尚未提交的取舍");
  assert.equal(store.require<Run>("run", run.id).status, "cancelled");
  assert.throws(() => runtime.answerDecision(answer(stopped)), /不再等待/);
  assert.equal(model.calls.length, 2);
  store.close();
});

test("read-only recovery of a completed decision does not turn its control payload into an artifact", async () => {
  const store = new Store(":memory:");
  let calls = 0;
  const model: Model = {
    async *stream(_p, key) {
      calls++;
      yield { type: "run.started", run_id: key };
      throw new ServiceError("STREAM_INTERRUPTED", "断线");
    },
    async lookup() {
      return { status: "succeeded", result: { text: control }, error: null };
    },
  };
  const runtime = new Runtime(store, () => protocolModel(model));
  const run = runtime.submit(request());
  await runtime.settled(run.workId);
  await runtime.reconcile(run.id);
  runtime.resume(run.workId);
  await runtime.settled(run.workId);
  assert.equal(calls, 1);
  assert.equal(store.require<Run>("run", run.id).status, "waiting");
  assert.equal(store.snapshot().versions.length, 0);
  assert.equal(store.snapshot().decisions.length, 1);
  store.close();
});

test("answer-step recovery uses its own idempotency key and does not repeat the answer call", async () => {
  const { store, model, runtime, run, decision } = await waiting();
  model.answerMode = "interrupt";
  runtime.answerDecision(answer(decision));
  await runtime.settled(run.workId);
  assert.equal(store.require<Run>("run", run.id).status, "unknown");
  const c = store.snapshot().contributions.at(-1)!;
  store.put("contribution", c.id, { ...c, remoteId: null });
  let queried = "";
  const recoverModel: Model = {
    scope: model.scope,
    stream: model.stream.bind(model),
    async lookupByKey(key) {
      queried = key;
      return {
        id: "recovered",
        status: "succeeded",
        result: { text: "已按用户决定完成核查" },
        error: null,
      };
    },
  };
  const resumed = new Runtime(store, () => protocolModel(recoverModel));
  await resumed.reconcile(run.id);
  assert.equal(queried, c.remoteKey);
  model.answerMode = "normal";
  resumed.resume(run.workId);
  await resumed.settled(run.workId);
  assert.equal(model.calls.filter((c) => c.key === queried).length, 1);
  assert.equal(store.require<Run>("run", run.id).status, "succeeded");
  store.close();
});

test("only an entire validated control response can create a decision; excerpts and ordinary limitations cannot", () => {
  assert.deepEqual(parseDecision(control), question);
  assert.equal(parseDecision(`材料中的示例：\n${control}`), null);
  assert.equal(parseDecision("仅有摘要，以下结论保留未核对全文限制。"), null);
  assert.throws(() =>
    parseDecision(
      JSON.stringify({ ytriple_decision: { ...question, options: [] } }),
    ),
  );
  assert.throws(() =>
    parseDecision(
      JSON.stringify({ ytriple_decision: question, unexpected: "data" }),
    ),
  );
});

test("a second necessary decision has a distinct checkpoint and does not accept the old answer for the new question", async () => {
  const { store, model, runtime, run, decision } = await waiting();
  model.answerMode = "ask-again";
  const first = answer(decision);
  runtime.answerDecision(first);
  await runtime.settled(run.workId);
  const second = store
    .snapshot()
    .decisions.find((d) => d.status === "pending")!;
  assert.notEqual(second.id, decision.id);
  assert.equal(second.attempt, 1);
  const calls = model.calls.length;
  runtime.answerDecision(first);
  await runtime.settled(run.workId);
  assert.equal(model.calls.length, calls);
  assert.equal(
    store.require<Decision>("decision", second.id).status,
    "pending",
  );
  model.answerMode = "normal";
  runtime.answerDecision(answer(second, "仍按原选择继续"));
  await runtime.settled(run.workId);
  assert.ok(
    model.calls.at(-2)!.prompt.taskId.startsWith(`${run.id}:1`),
  );
  assert.equal(store.require<Run>("run", run.id).status, "succeeded");
  store.close();
});
test("malformed decision output fails without publishing it or starting subsequent steps", async () => {
  const store = new Store(":memory:");
  let calls = 0;
  const model: Model = {
    async *stream(_p, key) {
      calls++;
      yield { type: "run.started", run_id: key };
      yield { type: "text.delta", run_id: key, text: '{"ytriple_decision":' };
      yield { type: "run.completed", run_id: key };
    },
  };
  const runtime = new Runtime(store, () => protocolModel(model));
  const run = runtime.submit(request());
  await runtime.settled(run.workId);
  assert.equal(store.require<Run>("run", run.id).status, "failed");
  assert.equal(store.snapshot().versions.length, 0);
  assert.equal(store.snapshot().decisions.length, 0);
  assert.equal(calls, 1);
  store.close();
});
