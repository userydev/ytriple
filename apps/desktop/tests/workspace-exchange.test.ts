import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { Runtime } from "../src/core/runtime";
import { ProcessRecords } from "../src/core/process";
import {
  buildExchangeHistory,
  buildRuntimeContext,
  isProcessScopedRun,
} from "../src/core/workspace-exchange";
import { legacyFinish, teamResponse } from "./team-response";
import type { Model, Prompt, StreamEvent } from "../src/core/ycore";
import type { Run, SubmitInput } from "../src/core/types";

const submit = (
  context: string,
  text: string,
  outputMode: SubmitInput["outputMode"] = "explanation",
): SubmitInput => ({
  key: randomUUID(),
  context,
  text,
  refs: [],
  recipient: null,
  projectId: null,
  outputMode,
});

class Capture implements Model {
  scope = "test";
  recovery = "local" as const;
  prompts: Prompt[] = [];
  calls = 0;
  async *stream(p: Prompt, key: string): AsyncGenerator<StreamEvent> {
    this.calls++;
    this.prompts.push(p);
    yield { type: "run.started", run_id: key };
    const goal =
      p.messages[1]?.content.match(/用户目标：([^\n]+)/)?.[1] ?? "";
    const text = goal.includes("改五天")
      ? "五天，海盐蓝。"
      : "配色海盐蓝，三天。";
    yield {
      type: "text.delta",
      run_id: key,
      text: teamResponse(text, null),
    };
    yield { type: "run.completed", run_id: key };
  }
}

test("explanation rounds carry prior user goals, successful replies, and failed-turn corrections without writing result versions", async () => {
  const store = new Store(":memory:");
  store.initializeConfiguration();
  const model = new Capture();
  const runtime = new Runtime(store, () => model);
  const first = runtime.submit(submit("new", "请记住海盐蓝配色，三天完成"));
  await runtime.settled(first.workId);
  assert.equal(store.require<Run>("run", first.id).status, "succeeded");
  assert.equal(store.all("version").length, 0);
  const second = runtime.submit(
    submit(first.workId, "刚才配色是什么？改为五天完成"),
  );
  await runtime.settled(second.workId);
  const last = model.prompts.at(-1)!;
  const user = last.messages.find((m) => m.role === "user")!.content;
  assert.match(user, /海盐蓝/);
  assert.match(user, /三天/);
  assert.match(user, /同工作交流/);
  assert.equal(store.all("version").length, 0);
  assert.ok(store.require<Run>("run", second.id).contextScope?.exchangeTurns === 1);
  store.close();
});

test("failed prior turn keeps user correction visible but not as successful team output", async () => {
  const store = new Store(":memory:");
  store.initializeConfiguration();
  class FailOnce extends Capture {
    n = 0;
    async *stream(
      p: Prompt,
      key: string,
    ): AsyncGenerator<StreamEvent> {
      this.n++;
      if (this.n === 1) {
        yield { type: "run.started", run_id: key };
        yield {
          type: "run.failed",
          run_id: key,
          error: { code: "MODEL_FAILED", message: "fixture" },
        };
        return;
      }
      yield* super.stream(p, key);
    }
  }
  const model = new FailOnce();
  const runtime = new Runtime(store, () => model);
  const failed = runtime.submit(submit("new", "约束：只用蓝色系"));
  await runtime.settled(failed.workId);
  assert.equal(store.require<Run>("run", failed.id).status, "failed");
  runtime.resume(failed.workId);
  const follow = runtime.submit(submit(failed.workId, "继续：改为五天"));
  await runtime.settled(follow.workId);
  const user = model.prompts.at(-1)!.messages[1].content;
  assert.match(user, /只用蓝色系/);
  assert.match(user, /未成功完成/);
  assert.doesNotMatch(user, /五天，海盐蓝/);
  store.close();
});

test("process-scoped explanation does not widen to full-work exchange or main result body", () => {
  const dir = mkdtempSync(join(tmpdir(), "ytriple-exchange-"));
  try {
    const store = new Store(join(dir, "db"));
    store.initializeConfiguration();
    const material = store.addMaterial("依据", "公开分析正文");
    const run = store.submit(
      {
        ...submit("new", "形成主成果"),
        outputMode: "result",
        refs: [{ materialId: material.id, version: 1, label: "依据" }],
      },
      "test",
    );
    store.put("contribution", `${run.id}:0`, {
      id: `${run.id}:0`,
      remoteKey: `${run.id}-0`,
      runId: run.id,
      workId: run.workId,
      memberId: "editor",
      memberName: "伙伴",
      objective: "写成果",
      body: "主成果正文不应泄露到窄范围追问",
      status: "succeeded",
      remoteId: null,
      error: null,
      createdAt: new Date().toISOString(),
    });
    store.setRun(run.id, { status: "running" });
    legacyFinish(store, run.id, "主成果正文不应泄露到窄范围追问", true);
    const records = new ProcessRecords(store);
    const draft = records.prepare({
      workId: run.workId,
      mode: "explanation",
      contributionIds: [`${run.id}:0`],
    });
    const scopedRun: Run = {
      ...run,
      id: randomUUID(),
      text: draft.text,
      outputMode: "explanation" as const,
      refs: draft.refs,
      status: "queued" as const,
    };
    assert.ok(isProcessScopedRun(store, scopedRun));
    const built = buildRuntimeContext(store, scopedRun, undefined, (r) =>
      store.material(r),
    );
  assert.equal(built.scope.processScoped, true);
  assert.equal(built.scope.exchangeTurns, 0);
  assert.doesNotMatch(buildExchangeHistory(store, scopedRun).text, /主成果正文不应泄露/);
  assert.match(built.context, /记录范围/);
    assert.ok(draft.refs.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queued follow-up sees earlier successful reply when it later executes", async () => {
  const store = new Store(":memory:");
  store.initializeConfiguration();
  const model = new Capture();
  const runtime = new Runtime(store, () => model);
  const a = runtime.submit(submit("new", "第一轮：海盐蓝"));
  await runtime.settled(a.workId);
  store.pauseQueue(a.workId, true);
  const b = runtime.submit(submit(a.workId, "第二轮：改五天"));
  assert.equal(store.require<Run>("run", b.id).status, "queued");
  runtime.resume(a.workId);
  await runtime.settled(a.workId);
  const secondPrompt = model.prompts.at(-1)!.messages[1].content;
  assert.match(secondPrompt, /海盐蓝/);
  assert.match(secondPrompt, /配色海盐蓝，三天/);
  store.close();
});

test("buildExchangeHistory labels omitted and truncated scope", () => {
  const store = new Store(":memory:");
  store.initializeConfiguration();
  const workId = randomUUID();
  store.put("work", workId, {
    id: workId,
    title: "t",
    projectId: null,
    deliveryId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    archived: false,
    queuePaused: false,
  });
  for (let i = 0; i < 12; i++) {
    const r = store.submit(submit(workId, `目标 ${i}`), "s");
    store.setRun(r.id, { status: "succeeded" });
    store.put("message", `${r.id}:reply`, {
      id: `${r.id}:reply`,
      workId,
      runId: r.id,
      role: "assistant",
      body: `回答 ${i}`,
      refs: [],
      createdAt: new Date().toISOString(),
    });
  }
  const current = store.submit(submit(workId, "当前"), "s");
  const hist = buildExchangeHistory(store, current);
  assert.equal(hist.scope.exchangeTurns, 10);
  assert.equal(hist.scope.exchangeOmitted, 2);
  store.close();
});

test("result answer-only history keeps distinctive answers and no artifact versions", async () => {
  const store = new Store(":memory:");
  store.initializeConfiguration();
  const marker = "核验码-NebulaGate-42";
  let n = 0;
  const model: Model = {
    scope: "exchange-answer-only",
    async *stream(_p, key) {
      n++;
      yield { type: "run.started", run_id: key };
      const answer =
        n === 1
          ? teamResponse(`记录：${marker}`, null)
          : n === 2
            ? teamResponse(`仍引用 ${marker}`, null)
            : teamResponse("第三", null);
      yield { type: "text.delta", run_id: key, text: answer };
      yield { type: "run.completed", run_id: key };
    },
  };
  const runtime = new Runtime(store, () => model);
  const first = runtime.submit(submit("new", "请记录一个核验码", "result"));
  await runtime.settled(first.workId);
  assert.equal(store.all("version").length, 0);
  const second = runtime.submit(
    submit(first.workId, "刚才核验码是什么？", "result"),
  );
  await runtime.settled(first.workId);
  const hist = buildExchangeHistory(store, second);
  assert.match(hist.text, new RegExp(marker));
  assert.doesNotMatch(hist.text, /主成果已更新/);
  assert.equal(store.all("version").length, 0);
  runtime.submit(submit(first.workId, "再确认一次", "result"));
  await runtime.settled(first.workId);
  assert.equal(store.all("version").length, 0);
  store.close();
});
