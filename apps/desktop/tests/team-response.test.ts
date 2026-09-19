import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../src/core/store";
import { Runtime } from "../src/core/runtime";
import {
  MAX_EXCHANGE_BYTES,
  buildExchangeHistory,
} from "../src/core/workspace-exchange";
import {
  parseTeamResponse,
  TEAM_RESPONSE_PROTOCOL,
  teamResponseInstruction,
  publicAnswer,
} from "../src/core/team-response";
import { legacyFinish, teamResponse } from "./team-response";
import { resolveRunContext } from "../src/core/workspace-exchange";
import type { Model, Prompt, StreamEvent } from "../src/core/ycore";
import { ServiceError } from "../src/core/ycore";
import type { Run, SubmitInput, Contribution } from "../src/core/types";
import { defaultTeam, defaultWorkflow } from "../src/core/types";

test("future queued submissions are excluded from exchange history", () => {
  const store = new Store(":memory:");
  store.initializeConfiguration();
  const a = store.submit(
    {
      key: randomUUID(),
      context: "new",
      text: "先前目标",
      refs: [],
      recipient: null,
      projectId: null,
      outputMode: "explanation",
    },
    "test",
  );
  store.setRun(a.id, { status: "succeeded" });
  const b = store.submit(
    {
      key: randomUUID(),
      context: a.workId,
      text: "当前轮",
      refs: [],
      recipient: null,
      projectId: null,
      outputMode: "explanation",
    },
    "test",
  );
  store.submit(
    {
      key: randomUUID(),
      context: a.workId,
      text: "未来排队的秘密指令",
      refs: [],
      recipient: null,
      projectId: null,
      outputMode: "explanation",
    },
    "test",
  );
  const hist = buildExchangeHistory(store, b);
  assert.equal(hist.text.includes("未来排队的秘密指令"), false);
  assert.ok(hist.scope.exchangeHistoryBytes <= MAX_EXCHANGE_BYTES);
  store.close();
});

test("exchange byte scope matches actual history block size", () => {
  const store = new Store(":memory:");
  store.initializeConfiguration();
  const long = store.submit(
    {
      key: randomUUID(),
      context: "new",
      text: "长".repeat(4000),
      refs: [],
      recipient: null,
      projectId: null,
      outputMode: "explanation",
    },
    "test",
  );
  store.setRun(long.id, { status: "failed" });
  const next = store.submit(
    {
      key: randomUUID(),
      context: long.workId,
      text: "继续",
      refs: [],
      recipient: null,
      projectId: null,
      outputMode: "explanation",
    },
    "test",
  );
  assert.throws(
    () => buildExchangeHistory(store, next),
    /单轮交流超过输入预算/,
  );
  store.close();
});

test("resolveRunContext keeps first snapshot when later submissions arrive", () => {
  const store = new Store(":memory:");
  store.initializeConfiguration();
  const first = store.submit(
    {
      key: randomUUID(),
      context: "new",
      text: "第一轮",
      refs: [],
      recipient: null,
      projectId: null,
      outputMode: "explanation",
    },
    "test",
  );
  store.setRun(first.id, { status: "running" });
  const snap = resolveRunContext(store, first, undefined);
  store.submit(
    {
      key: randomUUID(),
      context: first.workId,
      text: "后来的纠正",
      refs: [],
      recipient: null,
      projectId: null,
      outputMode: "explanation",
    },
    "test",
  );
  const again = resolveRunContext(store, first, undefined);
  assert.equal(again.context, snap.context);
  assert.equal(
    store.require<Run>("run", first.id).contextSnapshot?.text,
    snap.context,
  );
  store.close();
});

test("result-mode answer-only does not create a version", async () => {
  const store = new Store(":memory:");
  store.initializeConfiguration();
  const material = store.addMaterial("依据", "正文");
  class SeedThenExplain implements Model {
    n = 0;
    async *stream(p: Prompt, key: string): AsyncGenerator<StreamEvent> {
      this.n++;
      yield { type: "run.started", run_id: key };
      const goal = p.messages[1]?.content.match(/用户目标：([^\n]+)/)?.[1] ?? "";
      if (goal.includes("写主成果")) {
        yield {
          type: "text.delta",
          run_id: key,
          text: teamResponse("成果", {
            body: "第一段\n第二段铺垫",
            baseVersionId: null,
          }),
        };
      } else {
        yield {
          type: "text.delta",
          run_id: key,
          text: teamResponse("因为第二段只是铺垫，先解释。", null),
        };
      }
      yield { type: "run.completed", run_id: key };
    }
  }
  const runtime = new Runtime(store, () => new SeedThenExplain());
  const seed = runtime.submit({
    key: randomUUID(),
    context: "new",
    text: "写主成果",
    refs: [{ materialId: material.id, version: 1, label: "依据" }],
    recipient: null,
    projectId: null,
    outputMode: "result",
  });
  await runtime.settled(seed.workId);
  assert.equal(store.all("version").length, 1);
  assert.equal(store.require<{ body: string }>("message", `${seed.id}:reply`).body, "成果");
  const follow = runtime.submit({
    key: randomUUID(),
    context: seed.workId,
    text: "第二段为什么这样，先解释不要修改",
    refs: [],
    recipient: null,
    projectId: null,
    outputMode: "result",
  });
  await runtime.settled(follow.workId);
  const followRun = store.require<Run>("run", follow.id);
  assert.equal(followRun.status, "succeeded", followRun.error ?? "");
  assert.equal(store.all("version").length, 1);
  assert.match(
    store.require<{ body: string }>("message", `${follow.id}:reply`).body,
    /铺垫/,
  );
  store.close();
});

test("protocol rejects wrong baseVersionId and legacy finish still works", () => {
  const store = new Store(":memory:");
  store.initializeConfiguration();
  const run = store.submit(
    {
      key: randomUUID(),
      context: "new",
      text: "修订",
      refs: [],
      recipient: null,
      projectId: null,
      outputMode: "result",
    },
    "test",
  );
  store.setRun(run.id, { status: "running" });
  assert.throws(
    () =>
      store.finish(
        run.id,
        teamResponse("答", {
          body: "新正文",
          baseVersionId: randomUUID(),
        }),
        true,
      ),
    /不是本轮基准/,
  );
  const legacy = store.submit(
    {
      key: randomUUID(),
      context: "new",
      text: "legacy",
      refs: [],
      recipient: null,
      projectId: null,
      outputMode: "result",
    },
    "test",
  );
  store.setRun(legacy.id, { status: "running", responseProtocol: undefined });
  assert.ok(legacyFinish(store, legacy.id, "旧协议正文", true));
  store.close();
});

test("early requirements remain in background after more than ten turns", () => {
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
    nextSubmitSeq: 0,
  });
  for (let i = 1; i <= 12; i++) {
    const r = store.submit(
      {
        key: randomUUID(),
        context: workId,
        text: i === 1 ? "早期约束：只用蓝色" : `中间 ${i}`,
        refs: [],
        recipient: null,
        projectId: null,
        outputMode: "explanation",
      },
      "test",
    );
    store.setRun(r.id, { status: "succeeded" });
    store.put("message", `${r.id}:reply`, {
      id: `${r.id}:reply`,
      workId,
      runId: r.id,
      role: "assistant",
      body: `答 ${i}`,
      refs: [],
      createdAt: new Date().toISOString(),
    });
  }
  const current = store.submit(
    {
      key: randomUUID(),
      context: workId,
      text: "当前问题",
      refs: [],
      recipient: null,
      projectId: null,
      outputMode: "explanation",
    },
    "test",
  );
  const hist = buildExchangeHistory(store, current);
  assert.match(hist.text, /早期约束：只用蓝色/);
  assert.match(hist.text, /不代表仍有效指令/);
  assert.doesNotMatch(hist.text, /下列约束仍有效/);
  store.close();
});

test("parseTeamResponse requires artifact null for explanation runs", () => {
  const run = {
    responseProtocol: TEAM_RESPONSE_PROTOCOL,
    outputMode: "explanation",
    baseVersionId: null,
  } as Run;
  assert.throws(
    () =>
      parseTeamResponse(
        teamResponse("答", { body: "x", baseVersionId: null }),
        run,
        true,
      ),
    /不能提交主成果候选/,
  );
});

test("teamResponseInstruction uses JSON null for missing baseVersionId", () => {
  const run = {
    responseProtocol: TEAM_RESPONSE_PROTOCOL,
    outputMode: "result",
    baseVersionId: null,
  } as Run;
  const text = teamResponseInstruction(run, {
    finalStage: true,
    allowsArtifact: true,
  });
  assert.match(text, /YTRIPLE_BOUND_BASE=null/);
  assert.doesNotMatch(text, /YTRIPLE_BOUND_BASE="null"/);
});

test("parseTeamResponse rejects plain text on protocol runs", () => {
  const run = {
    responseProtocol: TEAM_RESPONSE_PROTOCOL,
    outputMode: "result",
    baseVersionId: null,
  } as Run;
  assert.throws(
    () => parseTeamResponse("只有正文", run, true),
    /协议格式不完整/,
  );
});

test("publicAnswer hides invalid control JSON from conversation", () => {
  const run = {
    responseProtocol: TEAM_RESPONSE_PROTOCOL,
    outputMode: "result",
    baseVersionId: null,
  } as Run;
  assert.equal(publicAnswer(teamResponse("解释", null), run), "解释");
  assert.match(publicAnswer('{"ytriple_response":{', run), /未能解析/);
});

test("runtime final stage keeps protocol instruction without provider stream schema", async () => {
  const store = new Store(":memory:");
  store.selectConfiguration(
    null,
    `${defaultTeam.id}@${defaultTeam.version}`,
    `${defaultWorkflow.id}@${defaultWorkflow.version}`,
  );
  const prompts: Prompt[] = [];
  const model: Model = {
    scope: "schema-test",
    async *stream(prompt) {
      prompts.push(prompt);
      yield { type: "run.started", run_id: "k" };
      yield {
        type: "text.delta",
        run_id: "k",
        text: teamResponse("完成", {
          body: "完成",
          baseVersionId: null,
        }),
      };
      yield { type: "run.completed", run_id: "k" };
    },
  };
  const runtime = new Runtime(store, () => model);
  const run = runtime.submit({
    key: randomUUID(),
    context: "new",
    text: "写主成果",
    refs: [],
    recipient: null,
    projectId: null,
  });
  await runtime.settled(run.workId);
  const last = prompts.at(-1)!;
  assert.equal(last.outputSchema, undefined);
  assert.match(
    last.messages.find((m) => m.role === "system")!.content,
    /YTRIPLE_BOUND_BASE=/,
  );
  store.close();
});

test("reconcile keeps remote body verbatim; invalid protocol fails on finish", async () => {
  const store = new Store(":memory:");
  store.initializeConfiguration();
  let calls = 0;
  const model: Model = {
    scope: "reconcile-strict",
    async *stream() {
      calls++;
      throw new ServiceError("INVALID_STREAM", "broken");
    },
    async lookupByKey() {
      return {
        id: "remote",
        status: "succeeded",
        result: { text: "非 JSON 的已付费正文" },
        error: null,
      };
    },
  };
  const runtime = new Runtime(store, () => model);
  const run = runtime.submit({
    key: randomUUID(),
    context: "new",
    text: "写主成果",
    refs: [],
    recipient: null,
    projectId: null,
  });
  await runtime.settled(run.workId);
  await runtime.reconcile(run.id);
  assert.equal(
    store.all<Contribution>("contribution")[0].body,
    "非 JSON 的已付费正文",
  );
  runtime.resume(run.workId);
  await runtime.settled(run.workId);
  assert.equal(store.require<Run>("run", run.id).status, "failed");
  assert.equal(store.all("version").length, 0);
  assert.equal(calls, 1);
  store.close();
});


test("adaptive owner keeps final response contract while delegate controls remain possible", async () => {
  const store = new Store(":memory:");
  store.initializeConfiguration();
  let calls = 0;
  const model: Model = {
    scope: "owner-protocol-fixture",
    async *stream(prompt, key) {
      const system = prompt.messages[0].content;
      calls++;
      assert.equal(prompt.outputSchema, undefined, "control-capable calls must not be constrained to a final answer");
      yield { type: "run.started", run_id: key };
      if (calls === 1) {
        assert.match(system, /YTRIPLE_BOUND_BASE=null/);
        yield { type: "text.delta", run_id: key, text: JSON.stringify({ytriple_delegate:{memberId:"reviewer", objective:"核查范围", context:"仅核查说明", references:[]}}) };
      } else if (calls === 2) {
        assert.doesNotMatch(system, /YTRIPLE_BOUND_BASE=/, "child contribution is not the owner's final artifact");
        yield { type: "text.delta", run_id: key, text: "范围已核查，仅依据给定说明。" };
      } else {
        assert.match(system, /YTRIPLE_BOUND_BASE=null/);
        yield { type: "text.delta", run_id: key, text: teamResponse("已吸收核查意见。", null) };
      }
      yield { type: "run.completed", run_id: key };
    },
  };
  const runtime = new Runtime(store, () => model);
  const run = runtime.submit({key:randomUUID(),context:"new",text:"请核查后回答",refs:[],recipient:null,projectId:null});
  await runtime.settled(run.workId);
  assert.equal(store.require<Run>("run",run.id).status,"succeeded");
  assert.equal(calls,3);
  assert.equal(store.all("version").length,0);
  assert.equal(store.require<{body:string}>("message",`${run.id}:reply`).body,"已吸收核查意见。");
  store.close();
});
