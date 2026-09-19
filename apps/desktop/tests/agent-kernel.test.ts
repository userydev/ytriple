import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_KERNEL_V1,
  createAgentKernelV2,
  registerAgentKernel,
  resolveAgentKernel,
} from "../src/core/agent-kernel-contract";
import { executeLegacyRun } from "../src/core/agent-legacy";
import { delegationKey } from "../src/core/delegation";
import { Store } from "../src/core/store";
import { Runtime } from "../src/core/runtime";
import { versionKey } from "../src/core/configuration";
import { WorkspaceBackups } from "../src/core/workspace-backup";
import {
  adaptiveWorkflow,
  defaultTeam,
  defaultWorkflow,
  type FrozenExecution,
  type Run,
  type SubmitInput,
  type Workflow,
} from "../src/core/types";
import type { Model, Prompt, StreamEvent } from "../src/core/ycore";
import { teamResponse, boundBaseFromPrompt } from "./team-response";

const request = (extra: Partial<SubmitInput> = {}): SubmitInput => ({
  key: randomUUID(),
  context: "new",
  text: "整理要点",
  refs: [],
  recipient: null,
  projectId: null,
  ...extra,
});

class Script implements Model {
  prompts: Prompt[] = [];
  constructor(readonly lines: string[]) {}
  async *stream(p: Prompt, key: string): AsyncGenerator<StreamEvent> {
    this.prompts.push(p);
    const body = this.lines[this.prompts.length - 1] ?? "完成";
    yield { type: "run.started", run_id: key };
    const system = p.messages.find((m) => m.role === "system")?.content ?? "";
    const allowsArtifact = !system.includes("不允许提交 artifact");
    const baseVersionId = boundBaseFromPrompt(p);
    const delivered = body.trimStart().startsWith('{"ytriple_') ? body : teamResponse(
      body,
      allowsArtifact ? { body, baseVersionId } : null,
    );
    yield { type: "text.delta", run_id: key, text: delivered };
    yield { type: "run.completed", run_id: key };
  }
}

test("kernel registry rejects silent overwrite and resolves frozen manifest", () => {
  const probe = {
    id: "ytriple.agent-kernel.test",
    version: 1,
    loopPolicy: AGENT_KERNEL_V1.loopPolicy,
    planStages: AGENT_KERNEL_V1.planStages,
    allowsDelegation: AGENT_KERNEL_V1.allowsDelegation,
    buildSystemPrompt: AGENT_KERNEL_V1.buildSystemPrompt,
    buildUserPrompt: AGENT_KERNEL_V1.buildUserPrompt,
  };
  registerAgentKernel(probe);
  assert.throws(() => registerAgentKernel(probe));
  const manifest: FrozenExecution = {
    kernelId: AGENT_KERNEL_V1.id,
    kernelVersion: 1,
    strategyId: "fixed-stages",
  };
  assert.equal(resolveAgentKernel(manifest).version, 1);
  probe.loopPolicy = { ...probe.loopPolicy, afterToolFailure: () => "terminate" };
  const registered = resolveAgentKernel({ ...manifest, kernelId: probe.id });
  assert.equal(registered.loopPolicy.afterToolFailure(), "continue");
  assert.ok(Object.isFrozen(registered));
  assert.ok(Object.isFrozen(registered.loopPolicy));
  assert.throws(() =>
    resolveAgentKernel({ ...manifest, kernelVersion: 99 }),
  );
});

test("new runs freeze execution manifest and checkpoint; tampering blocks resume", async () => {
  const store = new Store(":memory:");
  const run = store.submit(request());
  assert.deepEqual(run.execution, run.executionCheckpoint);
  store.put("run", run.id, {
    ...run,
    execution: { ...run.execution!, kernelVersion: 99 },
  });
  const model = new Script(["x"]);
  const runtime = new Runtime(store, () => model);
  runtime.startQueued(run.workId);
  await runtime.settled(run.workId);
  assert.equal(store.require<Run>("run", run.id).status, "failed");
  assert.equal(model.prompts.length, 0);
  store.close();
});

test("legacy runs without execution keep historical contribution ids", async () => {
  const store = new Store(":memory:");
  const submitted = store.submit(request());
  const run = {
    ...submitted,
    execution: undefined,
    executionCheckpoint: undefined,
    skills: undefined,
    tools: { keys: [], maxCalls: 8 },
  };
  store.put("run", run.id, run);
  const model: Model = {
    async *stream(_p, key) {
      yield { type: "run.started", run_id: key };
      yield { type: "text.delta", run_id: key, text: "legacy 成果" };
      yield { type: "run.completed", run_id: key };
    },
  };
  await executeLegacyRun({
    store,
    model,
    run,
    context: "",
    signal: new AbortController().signal,
    onContribution: () => {},
  });
  const c = store
    .all<{ id: string }>("contribution")
    .find((x) => x.id.startsWith(`${run.id}:0`));
  assert.ok(c);
  assert.ok(!c!.id.includes(":t0"));
  store.close();
});

test("kernel v2 terminates after tool failure while v1 continues via Runtime", async () => {
  registerAgentKernel(createAgentKernelV2());
  const toolJson = JSON.stringify({
    ytriple_tool: {
      key: "builtin.calculate@1",
      purpose: "测试",
      input: { operation: "divide", values: [1, 0] },
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "ytriple-kernel-v2-"));
  try {
    const store = new Store(join(dir, "db.sqlite"));
    const team = {
      ...defaultTeam,
      version: defaultTeam.version + 1,
      members: defaultTeam.members.map((m) =>
        m.id === "researcher"
          ? { ...m, toolKeys: ["builtin.calculate@1" as const] }
          : m,
      ),
    };
    store.put("team", versionKey(team), team);
    const flow: Workflow = {
      ...defaultWorkflow,
      version: defaultWorkflow.version + 1,
      stages: [{ role: "researcher", objective: "计算", result: true }],
    };
    store.put("workflow", versionKey(flow), flow);
    store.selectConfiguration(null, versionKey(team), versionKey(flow));
    const v1Model = new Script([toolJson, "继续分析"]);
    const v1Runtime = new Runtime(store, () => v1Model);
    const v1Run = v1Runtime.submit(request({ text: "计算" }));
    const v1Exec = structuredClone(v1Run.execution!);
    await v1Runtime.settled(v1Run.workId);
    assert.equal(store.require<Run>("run", v1Run.id).status, "succeeded");
    assert.equal(v1Model.prompts.length, 2);

    const v2Model = new Script([toolJson, "不应继续"]);
    const v2Runtime = new Runtime(store, () => v2Model, undefined, undefined, {
      kernelId: AGENT_KERNEL_V1.id, kernelVersion: 2,
    });
    const v2Run = v2Runtime.submit(request({ text: "计算 v2" }));
    await v2Runtime.settled(v2Run.workId);
    assert.equal(store.require<Run>("run", v2Run.id).status, "failed");
    assert.equal(v2Model.prompts.length, 1);
    assert.equal(v1Exec.kernelVersion, 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fixed stages and adaptive delegation produce distinct member traces", async () => {
  const store = new Store(":memory:");
  store.put("meta", "team", defaultTeam);
  store.put("meta", "workflow", defaultWorkflow);
  const fixedModel = new Script(["一步", "二步", "三步"]);
  const fixedRt = new Runtime(store, () => fixedModel);
  const fixed = fixedRt.submit(request());
  await fixedRt.settled(fixed.workId);
  assert.equal(
    store.require<Run>("run", fixed.id).execution?.strategyId,
    "fixed-stages",
  );
  assert.equal(fixedModel.prompts.length, 3);
  const order = fixedModel.prompts.map(
    (p) => p.messages.find((m) => m.role === "system")?.content ?? "",
  );
  assert.match(order[0], /研究员/);
  assert.match(order[1], /核查员/);
  assert.match(order[2], /编辑员/);

  const store2 = new Store(":memory:");
  store2.put("meta", "team", defaultTeam);
  store2.put("meta", "workflow", adaptiveWorkflow);
  const adaptModel = new Script(["负责人直接完成"]);
  const adaptRt = new Runtime(store2, () => adaptModel);
  const adapt = adaptRt.submit(request());
  await adaptRt.settled(adapt.workId);
  assert.equal(
    store2.require<Run>("run", adapt.id).execution?.strategyId,
    "adaptive-delegation",
  );
  assert.equal(adaptModel.prompts.length, 1);
  store.close();
  store2.close();
});

test("backup export retains frozen execution manifest fields", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ytriple-backup-kernel-"));
  const file = join(dir, "snap.ytriple-backup");
  try {
    const store = new Store(join(dir, "workbench.sqlite"));
    const run = store.submit(request());
    await new WorkspaceBackups(dir).export(store, file);
    const text = readFileSync(file, "utf8");
    assert.ok(text.includes(run.execution!.strategyId));
    assert.ok(text.includes("executionCheckpoint"));
    const backups = new WorkspaceBackups(dir);
    const preview = await backups.inspect(file);
    const restored = await backups.restore(preview.id, "内核恢复", { aiPath: null, codePath: null });
    const recovered = new Store(join(dir, "spaces", restored.id, "workbench.sqlite"));
    assert.deepEqual(recovered.require<Run>("run", run.id).execution, run.execution);
    assert.deepEqual(recovered.require<Run>("run", run.id).executionCheckpoint, run.executionCheckpoint);
    recovered.close();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("new runs use unified loop contribution ids", async () => {
  const store = new Store(":memory:");
  const model = new Script(["完成"]);
  const runtime = new Runtime(store, () => model);
  const run = runtime.submit(request());
  await runtime.settled(run.workId);
  const c = store.all<{ id: string; remoteKey?: string }>("contribution")[0];
  assert.ok(c.id.includes(":t0:a0"));
  assert.equal(c.remoteKey, delegationKey(c.id));
  store.close();
});

function calculatorStore() {
  const store = new Store(":memory:");
  const team = { ...defaultTeam, version: 2, members: defaultTeam.members.map(m => ({
    ...m, toolKeys: ["builtin.calculate@1" as const],
  })) };
  const flow: Workflow = { ...defaultWorkflow, version: 2,
    stages: [{ role: "researcher", objective: "完成用户目标", result: true }] };
  store.put("team", versionKey(team), team);
  store.put("workflow", versionKey(flow), flow);
  store.selectConfiguration(null, versionKey(team), versionKey(flow));
  return store;
}
const failedCalculation = JSON.stringify({ ytriple_tool: {
  key: "builtin.calculate@1", purpose: "边界测试", input: { operation: "divide", values: [1, 0] },
} });
function strictTestKernel() {
  const kernel = { ...AGENT_KERNEL_V1, id: `test-${randomUUID()}`, version: 2,
    loopPolicy: { ...AGENT_KERNEL_V1.loopPolicy, afterToolFailure: () => "terminate" as const } };
  registerAgentKernel(kernel);
  return { kernelId: kernel.id, kernelVersion: kernel.version };
}

test("JSON tool examples inside final answers are never executed", async () => {
  const store = calculatorStore();
  const model = new Script([teamResponse(failedCalculation, null)]);
  const runtime = new Runtime(store, () => model);
  const run = runtime.submit(request({ outputMode: "explanation" }));
  await runtime.settled(run.workId);
  assert.equal(store.require<Run>("run", run.id).status, "succeeded");
  assert.equal(model.prompts.length, 1);
  assert.equal(store.all("tool-call").length, 0);
  assert.equal(store.all("version").length, 0);
  store.close();
});

test("a queued v1 run survives a v2 host and only new submissions use v2", async () => {
  const store = calculatorStore();
  const old = store.submit(request());
  const model = new Script([failedCalculation, "恢复原算法继续处理", failedCalculation]);
  const runtime = new Runtime(store, () => model, undefined, undefined, strictTestKernel());
  runtime.startQueued(old.workId);
  await runtime.settled(old.workId);
  assert.equal(store.require<Run>("run", old.id).status, "succeeded");
  assert.equal(model.prompts.length, 2);
  const fresh = runtime.submit(request());
  await runtime.settled(fresh.workId);
  assert.equal(store.require<Run>("run", fresh.id).status, "failed");
  assert.equal(model.prompts.length, 3);
  assert.equal(old.execution?.kernelVersion, 1);
  assert.equal(fresh.execution?.kernelVersion, 2);
  store.close();
});

test("paused v1 resumes under a v2 host without replaying its original question", async () => {
  const store = calculatorStore();
  const question = JSON.stringify({ ytriple_decision: {
    question: "选择范围", reason: "范围影响计算", impact: "本次计算",
    options: [{ label: "较小", detail: "较少数据" }, { label: "较大", detail: "较多数据" }],
  } });
  const firstModel = new Script([question]);
  const first = new Runtime(store, () => firstModel);
  const run = first.submit(request());
  await first.settled(run.workId);
  assert.equal(store.require<Run>("run", run.id).status, "waiting");
  const decision = store.snapshot().decisions[0];
  first.shutdown();
  const model = new Script([failedCalculation, "按旧算法完成"]);
  const next = new Runtime(store, () => model, undefined, undefined, strictTestKernel());
  next.answerDecision({ decisionId: decision.id, revision: decision.revision,
    draftRevision: decision.draftRevision, key: randomUUID(), text: "较小" });
  await next.settled(run.workId);
  assert.equal(store.require<Run>("run", run.id).status, "succeeded");
  assert.equal(firstModel.prompts.length, 1);
  assert.equal(model.prompts.length, 2);
  assert.equal(store.snapshot().decisions.length, 1);
  store.close();
});

test("replacement planning and prompt policies work without Runtime changes and retain input limits", async () => {
  const store = new Store(":memory:");
  const kernel = { ...AGENT_KERNEL_V1, id: `test-${randomUUID()}`,
    planStages: (run: Run) => [run.workflow.stages[2]],
    buildUserPrompt: (input: Parameters<typeof AGENT_KERNEL_V1.buildUserPrompt>[0]) =>
      "替换后的上下文政策\n" + AGENT_KERNEL_V1.buildUserPrompt(input),
  };
  registerAgentKernel(kernel);
  const model = new Script(["一次完成"]);
  const runtime = new Runtime(store, () => model, undefined, undefined, {
    kernelId: kernel.id, kernelVersion: 1,
  });
  const run = runtime.submit(request());
  await runtime.settled(run.workId);
  assert.equal(store.require<Run>("run", run.id).status, "succeeded");
  assert.equal(model.prompts.length, 1);
  assert.match(model.prompts[0].messages[0].content, /编辑员/);
  assert.match(model.prompts[0].messages[1].content, /替换后的上下文政策/);
  assert.equal(store.all("version").length, 1);
  registerAgentKernel({ ...kernel, version: 2, buildUserPrompt: () => "x".repeat(32001) });
  const next = new Runtime(store, () => model, undefined, undefined, {
    kernelId: kernel.id, kernelVersion: 2,
  });
  const blocked = next.submit(request());
  await next.settled(blocked.workId);
  assert.equal(store.require<Run>("run", blocked.id).status, "failed");
  assert.equal(model.prompts.length, 1);
  store.close();
});
