import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { Runtime } from "../src/core/runtime";
import { Decisions } from "../src/core/decisions";
import { ProcessRecords } from "../src/core/process";
import { parseDelegation } from "../src/core/delegation";
import { workflowSchema } from "../src/core/configuration";
import {
  adaptiveWorkflow,
  defaultWorkflow,
  type Contribution,
  type Run,
  type SubmitInput,
} from "../src/core/types";
import type { Model, Prompt, StreamEvent } from "../src/core/ycore";
import { teamResponse, boundBaseFromPrompt } from "./team-response";
const request = (extra: Partial<SubmitInput> = {}): SubmitInput => ({
  key: randomUUID(),
  context: "new",
  text: "根据材料制定方案，证据有矛盾请按需委派",
  refs: [],
  recipient: null,
  projectId: null,
  ...extra,
});
const delegate = (memberId = "researcher", references = [1]) =>
  JSON.stringify({
    ytriple_delegate: {
      memberId,
      objective: "核查给定证据的限制",
      context: "只处理这个证据，返回依据与限制。",
      references,
    },
  });
class Script implements Model {
  prompts: Prompt[] = [];
  keys: string[] = [];
  constructor(
    readonly output: (p: Prompt, n: number) => string | "FAIL" | "UNKNOWN",
  ) {}
  async *stream(p: Prompt, key: string): AsyncGenerator<StreamEvent> {
    this.prompts.push(p);
    this.keys.push(key);
    yield { type: "run.started", run_id: key };
    const body = this.output(p, this.prompts.length);
    if (body === "FAIL") {
      yield {
        type: "run.failed",
        run_id: key,
        error: { code: "MODEL_FAILED", message: "测试子任务确定失败" },
      };
      return;
    }
    if (body === "UNKNOWN") {
      yield {
        type: "run.failed",
        run_id: key,
        error: {
          code: "PROVIDER_ERROR",
          message: "测试供应商结果与费用未知",
        },
      };
      return;
    }
    const system = p.messages.find((m) => m.role === "system")?.content ?? "";
    const allowsArtifact = !system.includes("不允许提交 artifact");
    const baseVersionId = boundBaseFromPrompt(p);
    const delivered =
      body.startsWith("{") && body.includes("ytriple_")
        ? body
        : teamResponse(
            body,
            allowsArtifact ? { body, baseVersionId } : null,
          );
    yield { type: "text.delta", run_id: key, text: delivered };
    yield { type: "run.completed", run_id: key };
  }
}
function fixture(path = ":memory:") {
  const store = new Store(path);
  store.initializeConfiguration();
  const a = store.addMaterial("指定依据", "已公开证据 A：只有摘要。");
  const b = store.addMaterial("未分配材料", "范围外证据 B，子任务不可读取。");
  return {
    store,
    refs: [a, b].map((m) => ({ materialId: m.id, version: 1, label: m.title })),
  };
}
test("adaptive owner delegates bounded nested work, scoped references reach only the assigned member, returns are reviewed in the same work", async () => {
  const f = fixture();
  try {
    const model = new Script((p) => {
      const depth = (p.taskId.match(/:d:/g) ?? []).length;
      if (depth === 0 && p.taskId.endsWith(":t0:a0")) return delegate();
      if (depth === 1 && p.taskId.endsWith(":t0:a0"))
        return delegate("reviewer");
      return depth === 2
        ? "核查：证据仅有摘要。"
        : depth === 1
          ? "研究员吸收核查：不可声称全文已读。"
          : "负责人吸收返回，最终方案保留限制。";
    });
    const runtime = new Runtime(f.store, () => model),
      run = runtime.submit(request({ refs: f.refs }));
    await runtime.settled(run.workId);
    assert.equal(f.store.require<Run>("run", run.id).status, "succeeded");
    assert.equal(model.prompts.length, 5);
    assert.equal(new Set(model.keys).size, 5);
    assert.ok(model.keys.every((key) => /^[A-Za-z0-9._-]{8,128}$/.test(key)));
    assert.ok(
      model.prompts
        .filter((p) => p.taskId.includes(":d:"))
        .every((p) => !p.messages[1].content.includes("范围外证据 B")),
    );
    assert.ok(
      model.prompts.at(-1)!.messages[1].content.includes("研究员吸收核查"),
    );
    const records = f.store.all<Contribution>("contribution");
    assert.equal(records.filter((c) => c.delegation?.responseId).length, 2);
    assert.equal(records.filter((c) => c.task?.returnedFrom).length, 2);
    assert.equal(f.store.snapshot().works.length, 1);
    assert.equal(f.store.snapshot().versions.length, 1);
    assert.ok(f.store.snapshot().versions[0].body.includes("最终方案"));
    const d = new ProcessRecords(f.store).prepare({
      workId: run.workId,
      mode: "summary",
    });
    const m = f.store.material(d.refs[0]);
    assert.ok(m.body.includes("受委派于记录"));
    assert.ok(m.body.includes("收到子任务回信"));
    const child = records.find((c) => c.task?.depth === 1)!;
    const targeted = new ProcessRecords(f.store).prepare({
      workId: run.workId,
      mode: "explanation",
      contributionIds: [child.id],
    });
    assert.ok(
      !f.store.material(targeted.refs[0]).body.includes("范围外证据 B"),
    );
    const audit = f.store.require<{ prompt: Prompt }>("model-input", child.id);
    assert.deepEqual(audit.prompt, model.prompts[1]);
    assert.ok(
      audit.prompt.messages[0].content.includes("没有实际验证时不得保证达标"),
    );
  } finally {
    f.store.close();
  }
});
test("simple adaptive work uses one member; fixed historical workflows stay fixed and delegation policies are versioned independently", async () => {
  const f = fixture();
  try {
    const model = new Script(() => "简单问题，直接答复。"),
      runtime = new Runtime(f.store, () => model);
    const run = runtime.submit(request());
    await runtime.settled(run.workId);
    assert.equal(model.prompts.length, 1);
    const saved = f.store.saveWorkflow({
      ...adaptiveWorkflow,
      delegation: { maxTasks: 2, maxDepth: 1 },
    });
    assert.equal(saved.version, 2);
    assert.equal(
      f.store.require<Run>("run", run.id).workflow.delegation?.maxTasks,
      4,
    );
    f.store.put("meta", "workflow", defaultWorkflow);
    f.store.initializeConfiguration();
    const fixed = runtime.submit(request());
    await runtime.settled(fixed.workId);
    assert.equal(model.prompts.length, 4);
    assert.equal(
      f.store.require<Run>("run", fixed.id).workflow.delegation,
      undefined,
    );
    assert.equal(
      workflowSchema.safeParse({
        ...adaptiveWorkflow,
        delegation: { maxTasks: 999, maxDepth: 1 },
      }).success,
      false,
    );
  } finally {
    f.store.close();
  }
});
test("child decision pauses the same run, answer resumes only that child, and parent does not replay the original delegation", async () => {
  const f = fixture();
  try {
    const question = JSON.stringify({
      ytriple_decision: {
        question: "使用哪个受众？",
        reason: "必须确定唯一受众",
        impact: "仅当前开场",
        options: [
          { label: "学生", detail: "更口语" },
          { label: "同行", detail: "更专业" },
        ],
      },
    });
    const model = new Script((p) =>
      !p.taskId.includes(":d:")
        ? p.taskId.endsWith(":t0:a0")
          ? delegate()
          : "根据子任务返回完成"
        : p.taskId.endsWith(":a0")
          ? question
          : "用户已选学生，据此使用口语表达。",
    );
    const runtime = new Runtime(f.store, () => model),
      run = runtime.submit(request({ refs: f.refs }));
    await runtime.settled(run.workId);
    assert.equal(f.store.require<Run>("run", run.id).status, "waiting");
    assert.equal(model.prompts.length, 2);
    const d = f.store.snapshot().decisions[0];
    assert.ok(d.taskKey?.includes(":d:"));
    const draft = new Decisions(f.store).saveDraft(d.id, 1, 0, "学生");
    runtime.answerDecision({
      decisionId: d.id,
      revision: 1,
      draftRevision: draft.draftRevision,
      key: randomUUID(),
      text: "学生",
    });
    await runtime.settled(run.workId);
    assert.equal(model.prompts.length, 4);
    assert.equal(new Set(model.keys).size, 4);
    assert.ok(model.prompts[2].messages[1].content.includes("答复：学生"));
    assert.ok(model.prompts[3].messages[1].content.includes("使用口语表达"));
    assert.equal(f.store.snapshot().versions.length, 1);
    assert.equal(f.store.snapshot().works.length, 1);
  } finally {
    f.store.close();
  }
});
test("uncertain child is recovered by original remote ID or idempotency key after reopening, never re-posting paid parent or child", async () => {
  for (const firstEvent of [true, false]) {
    const dir = mkdtempSync(join(tmpdir(), "ytriple-delegate-"));
    const path = join(dir, "db");
    let f = fixture(path);
    try {
      const submitted: string[] = [];
      let originalKey = "";
      const interrupted: Model = {
        async *stream(p, key) {
          submitted.push(key);
          if (!p.taskId.includes(":d:")) {
            yield { type: "run.started", run_id: key };
            yield { type: "text.delta", run_id: key, text: delegate() };
            yield { type: "run.completed", run_id: key };
            return;
          }
          originalKey = key;
          if (firstEvent)
            yield { type: "run.started", run_id: "original-child" };
          throw new TypeError("connection lost");
        },
      };
      const runtime = new Runtime(f.store, () => interrupted),
        run = runtime.submit(request({ refs: f.refs }));
      await runtime.settled(run.workId);
      assert.equal(f.store.require<Run>("run", run.id).status, "unknown");
      f.store.close();
      f = { ...f, store: new Store(path) };
      f.store.recover();
      const resumed = new Script((p) => {
        assert.ok(!p.taskId.includes(":d:"));
        return "负责人根据已恢复子任务完成。";
      });
      let lookupCount = 0;
      const model: Model = {
        stream: resumed.stream.bind(resumed),
        lookup: async (id) => {
          assert.equal(id, "original-child");
          lookupCount++;
          return {
            status: "succeeded",
            result: { text: "恢复的子任务明确结果" },
            error: null,
          };
        },
        lookupByKey: async (key) => {
          assert.equal(key, originalKey);
          lookupCount++;
          return {
            id: "found-child",
            status: "succeeded",
            result: { text: "恢复的子任务明确结果" },
            error: null,
          };
        },
      };
      const rr = new Runtime(f.store, () => model);
      await rr.reconcile(run.id);
      assert.equal(resumed.prompts.length, 0);
      rr.resume(run.workId);
      await rr.settled(run.workId);
      assert.equal(lookupCount, 1);
      assert.equal(submitted.length, 2);
      assert.equal(resumed.prompts.length, 1);
      assert.ok(
        resumed.prompts[0].messages[1].content.includes("恢复的子任务明确结果"),
      );
      assert.equal(f.store.require<Run>("run", run.id).status, "succeeded");
    } finally {
      f.store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
test("confirmed child failures return as failures for the owner to handle, while unconfirmed stop remains unknown until reconciliation", async () => {
  const f = fixture();
  try {
    const model = new Script((p) =>
      p.taskId.includes(":d:")
        ? "FAIL"
        : p.taskId.endsWith(":t0:a0")
          ? delegate()
          : "子任务失败，本结论保留未核查限制。",
    );
    const runtime = new Runtime(f.store, () => model),
      run = runtime.submit(request({ refs: f.refs }));
    await runtime.settled(run.workId);
    assert.equal(model.prompts.length, 3);
    assert.ok(model.prompts[2].messages[1].content.includes("状态：failed"));
    assert.ok(
      model.prompts[2].messages[1].content.includes("测试子任务确定失败"),
    );
    assert.equal(f.store.require<Run>("run", run.id).status, "succeeded");
    assert.equal(
      f.store
        .all<Contribution>("contribution")
        .filter((c) => c.status === "failed").length,
      1,
    );
    let started!: () => void;
    const childStarted = new Promise<void>((r) => (started = r));
    const slow: Model = {
      async *stream(p, key, signal) {
        yield { type: "run.started", run_id: key };
        if (p.taskId.includes(":d:")) {
          started();
          await new Promise<void>((r) =>
            signal.addEventListener("abort", () => r(), { once: true }),
          );
          throw new DOMException("aborted", "AbortError");
        }
        yield { type: "text.delta", run_id: key, text: delegate() };
        yield { type: "run.completed", run_id: key };
      },
      lookup: async () => ({ status: "cancelled", result: null, error: null }),
    };
    const stopped = new Runtime(f.store, () => slow),
      r = stopped.submit(request({ refs: f.refs }));
    await childStarted;
    stopped.stop(r.workId);
    await stopped.settled(r.workId);
    assert.equal(f.store.require<Run>("run", r.id).status, "unknown");
    await stopped.reconcile(r.id);
    assert.equal(f.store.require<Run>("run", r.id).status, "cancelled");
    assert.equal(
      f.store.all<Contribution>("contribution").filter((c) => c.runId === r.id)
        .length,
      2,
    );
  } finally {
    f.store.close();
  }
});
test("provider-unknown child stops its owner and remains recoverable", async () => {
  const f = fixture();
  try {
    const model = new Script((p) =>
      p.taskId.includes(":d:")
        ? "UNKNOWN"
        : p.taskId.endsWith(":t0:a0")
          ? delegate()
          : "不应在未知子任务后继续",
    );
    const runtime = new Runtime(f.store, () => model),
      run = runtime.submit(request({ refs: f.refs }));
    await runtime.settled(run.workId);
    assert.equal(f.store.require<Run>("run", run.id).status, "unknown");
    assert.equal(model.prompts.length, 2);
    const child = f.store
      .all<Contribution>("contribution")
      .find((c) => c.task?.depth === 1)!;
    assert.equal(child.status, "unknown");
    assert.equal(child.error, "测试供应商结果与费用未知");
  } finally {
    f.store.close();
  }
});
test("invalid destinations, out-of-scope references, malformed requests and budget violations stop without unbounded calls or fabricated results", async () => {
  assert.equal(parseDelegation("材料示例 " + delegate()), null);
  assert.throws(() => parseDelegation('{"ytriple_delegate":'));
  for (const scenario of ["unknown", "self", "scope", "depth", "budget"]) {
    const f = fixture();
    try {
      f.store.put("meta", "workflow", {
        ...adaptiveWorkflow,
        delegation: { maxTasks: 1, maxDepth: 1 },
      });
      const model = new Script((p) =>
        scenario === "unknown"
          ? delegate("missing")
          : scenario === "self"
            ? delegate("editor")
            : scenario === "scope"
              ? delegate("researcher", [99])
              : scenario === "depth"
                ? p.taskId.includes(":d:")
                  ? delegate("reviewer")
                  : delegate()
                : p.taskId.includes(":d:")
                  ? "子任务已完成"
                  : delegate(),
      );
      const runtime = new Runtime(f.store, () => model),
        run = runtime.submit(request({ refs: f.refs }));
      await runtime.settled(run.workId);
      assert.equal(
        f.store.require<Run>("run", run.id).status,
        "failed",
        scenario,
      );
      assert.ok(model.prompts.length <= 3);
      assert.equal(f.store.snapshot().versions.length, 0);
    } finally {
      f.store.close();
    }
  }
});

test("a recovered terminal child failure is handed back to its owner after explicit resume, without retrying the child", async () => {
  const f = fixture();
  try {
    const model: Model = {
      async *stream(p, key) {
        yield { type: "run.started", run_id: key };
        if (p.taskId.includes(":d:"))
          throw new TypeError("lost terminal event");
        yield { type: "text.delta", run_id: key, text: delegate() };
        yield { type: "run.completed", run_id: key };
      },
    };
    const first = new Runtime(f.store, () => model);
    const run = first.submit(request({ refs: f.refs }));
    await first.settled(run.workId);
    assert.equal(f.store.require<Run>("run", run.id).status, "unknown");
    const final = new Script((p) => {
      assert.ok(!p.taskId.includes(":d:"));
      assert.ok(p.messages[1].content.includes("服务确认子任务失败"));
      return "核查未完成，只给出有依据的阶段结论。";
    });
    const recovery: Model = {
      stream: final.stream.bind(final),
      lookup: async () => ({
        status: "failed",
        result: null,
        error: { message: "服务确认子任务失败" },
      }),
    };
    const resumed = new Runtime(f.store, () => recovery);
    await resumed.reconcile(run.id);
    assert.equal(f.store.require<Run>("run", run.id).status, "queued");
    assert.equal(final.prompts.length, 0);
    resumed.resume(run.workId);
    await resumed.settled(run.workId);
    assert.equal(final.prompts.length, 1);
    assert.equal(f.store.require<Run>("run", run.id).status, "succeeded");
  } finally {
    f.store.close();
  }
});
