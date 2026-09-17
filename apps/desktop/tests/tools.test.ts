import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/core/store";
import { Runtime } from "../src/core/runtime";
import { LocalTools } from "../src/core/tools";
import { ProcessRecords } from "../src/core/process";
import {
  WorkspaceBackups,
  validateWorkspace,
} from "../src/core/workspace-backup";
import {
  parseToolRequest,
  toolCatalog,
  type ToolRequest,
  type ToolReceipt,
  type ToolKey,
} from "../src/core/tool-contract";
import {
  defaultTeam,
  defaultWorkflow,
  adaptiveWorkflow,
  type SubmitInput,
  type Contribution,
  type Run,
} from "../src/core/types";
import type { Model, Prompt, StreamEvent } from "../src/core/ycore";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolEvidence } from "../src/ui/ToolEvidence";
import type { Snapshot } from "../src/core/types";

test("tool evidence renders readable values and safely falls back for malformed or executable-looking imported text", () => {
  const request = parseToolRequest(calculate())!;
  const receipt: ToolReceipt = {
    id: "tool:c",
    runId: "r",
    contributionId: "c",
    memberId: "editor",
    fingerprint: "0".repeat(64),
    request,
    status: "succeeded",
    output: JSON.stringify({
      result: 30,
      unit: "%",
      precision: "approx",
      evidence: "仅计算",
    }),
    createdAt: new Date().toISOString(),
  };
  const contribution = { id: "c", runId: "r", tool: receipt } as Contribution;
  const data = { runs: [], materials: [] } as unknown as Snapshot;
  const render = (value: ToolReceipt) =>
    renderToStaticMarkup(
      createElement(ToolEvidence, { receipt: value, contribution, data }),
    );
  assert.match(render(receipt), /结果：30%/);
  assert.match(
    render({ ...receipt, output: '{"result":{"untrusted":true}}' }),
    /返回格式无法展示/,
  );
  const failed = render({
    ...receipt,
    status: "failed",
    output: "<script>alert(1)</script>",
  });
  assert.ok(!failed.includes("<script>"));
  assert.ok(failed.includes("&lt;script&gt;"));
});

test("historical flows reject unexpected tool controls and oversized escaped output fails without losing backup compatibility", async () => {
  assert.throws(
    () => parseToolRequest("```json\n" + calculate() + "\n```"),
    /代码围栏/,
  );
  const store = fixture(":memory:", []);
  try {
    store.put("meta", "workflow", defaultWorkflow);
    const model = new Script(() => calculate()),
      runtime = new Runtime(store, () => model);
    const run = runtime.submit(input());
    await runtime.settled(run.workId);
    assert.equal(store.require<Run>("run", run.id).status, "failed");
    assert.equal(store.all("tool-call").length, 0);
    assert.equal(store.all("version").length, 0);
  } finally {
    store.close();
  }
  const bounded = fixture();
  try {
    const source = bounded.addMaterial(
      "带控制字符的输入",
      "\u0000".repeat(6000),
    );
    const model = new Script((_p, n) =>
      n === 1
        ? material({ mode: "read", reference: 1, start: 0, maxChars: 6000 })
        : "工具超限，需要缩小范围。",
    );
    const runtime = new Runtime(bounded, () => model),
      run = runtime.submit(
        input({
          refs: [{ materialId: source.id, version: 1, label: source.title }],
        }),
      );
    await runtime.settled(run.workId);
    const receipt = bounded.all<ToolReceipt>("tool-call")[0];
    assert.equal(receipt.status, "failed");
    assert.match(receipt.output, /16000/);
    validateWorkspace(bounded.exportState());
  } finally {
    bounded.close();
  }
});
const input = (more: Partial<SubmitInput> = {}): SubmitInput => ({
  key: randomUUID(),
  context: "new",
  text: "查阅真实材料并计算，保留证据范围",
  refs: [],
  recipient: null,
  projectId: null,
  ...more,
});
const calculate = (
  values = [60, 75],
  operation = "percent_change",
  purpose = "核对相对变化",
) =>
  JSON.stringify({
    ytriple_tool: {
      key: "builtin.calculate@1",
      purpose,
      input: { values, operation },
    },
  });
const material = (args: Record<string, unknown>) =>
  JSON.stringify({
    ytriple_tool: {
      key: "builtin.material@1",
      purpose: "核查原记录",
      input: args,
    },
  });
class Script implements Model {
  prompts: Prompt[] = [];
  constructor(private output: (p: Prompt, n: number) => string) {}
  async *stream(p: Prompt, key: string): AsyncGenerator<StreamEvent> {
    this.prompts.push(p);
    yield { type: "run.started", run_id: key };
    yield {
      type: "text.delta",
      run_id: key,
      text: this.output(p, this.prompts.length),
    };
    yield { type: "run.completed", run_id: key };
  }
}
function fixture(
  path = ":memory:",
  keys: ToolKey[] = toolCatalog.map((t) => t.key),
) {
  const store = new Store(path);
  store.put("meta", "team", {
    ...defaultTeam,
    members: defaultTeam.members.map((m) => ({ ...m, toolKeys: keys })),
  });
  store.put("meta", "workflow", adaptiveWorkflow);
  return store;
}
test("real local lookup and arithmetic feed exact receipts into subsequent analysis, preserving version and excerpt boundaries", async () => {
  const store = fixture();
  try {
    const old = store.addMaterial(
      "试读记录",
      "范围外前文。" +
        "填充。".repeat(800) +
        "目标60秒，构造测试75秒；无分段用时。范围外后文。",
    );
    const excerpt = old.body.slice(7, -7);
    store.put("material", `${old.id}@2`, {
      ...old,
      version: 2,
      body: "新版本不能混进本轮。",
    });
    const model = new Script((p, n) =>
      n === 1
        ? material({
            mode: "find",
            reference: 1,
            text: "目标60秒",
            maxMatches: 2,
          })
        : n === 2
          ? material({
              mode: "read",
              reference: 1,
              start: excerpt.indexOf("目标60秒"),
              maxChars: 100,
            })
          : n === 3
            ? calculate()
            : "计算为25%，仅比较传入的测试值；未验证真实效果。",
    );
    const runtime = new Runtime(store, () => model),
      run = runtime.submit(
        input({
          refs: [{ materialId: old.id, version: 1, label: old.title, excerpt }],
        }),
      );
    await runtime.settled(run.workId);
    assert.equal(store.require<Run>("run", run.id).status, "succeeded");
    assert.equal(model.prompts.length, 4);
    assert.ok(!model.prompts[0].messages[1].content.includes("目标60秒"));
    assert.ok(model.prompts[1].messages[1].content.includes("目标60秒"));
    assert.ok(
      !model.prompts.some((p) =>
        p.messages[1].content.includes("新版本不能混进"),
      ),
    );
    const receipts = store.all<ToolReceipt>("tool-call");
    assert.equal(receipts.length, 3);
    assert.equal(JSON.parse(receipts[0].output).source.selection, "用户选段");
    assert.equal(JSON.parse(receipts[0].output).source.version, 1);
    assert.equal(JSON.parse(receipts[2].output).result, 25);
    assert.ok(
      model.prompts.at(-1)!.messages[1].content.includes('"result": 25'),
    );
    const summary = new ProcessRecords(store).prepare({
      workId: run.workId,
      mode: "summary",
      contributionIds: receipts.map((r) => r.contributionId),
    });
    assert.ok(store.material(summary.refs[0]).body.includes("实际返回"));
  } finally {
    store.close();
  }
});
test("disabled, unknown and malformed controls cannot execute or become published artifacts", async () => {
  for (const body of [
    calculate(),
    '{"ytriple_tool":{"key":"shell","purpose":"x","input":{}}}',
    '{"ytriple_tool":',
    calculate().replace(/}$/, ',"extra":true}'),
  ]) {
    const store = fixture(":memory:", []);
    try {
      const model = new Script(() => body),
        runtime = new Runtime(store, () => model),
        run = runtime.submit(input());
      await runtime.settled(run.workId);
      assert.equal(store.require<Run>("run", run.id).status, "failed");
      assert.equal(store.all("tool-call").length, 0);
      assert.equal(store.all("version").length, 0);
    } finally {
      store.close();
    }
  }
  assert.throws(() => parseToolRequest(calculate([1, Infinity])));
  assert.equal(parseToolRequest("普通分析"), null);
});
test("tool errors are visible data, never fabricated values, and unsupported arithmetic cannot execute code", async () => {
  for (const [values, operation, error] of [
    [[10, 0], "divide", "分母为零"],
    [[1, 2, 3], "subtract", "两个数值"],
    [[1e12, ...Array(31).fill(1e12)], "multiply", "有限浮点数范围"],
  ] as const) {
    const store = fixture();
    try {
      const model = new Script((p, n) =>
          n === 1
            ? calculate([...values], operation)
            : "工具失败，不能给出有效结果。",
        ),
        runtime = new Runtime(store, () => model),
        run = runtime.submit(input());
      await runtime.settled(run.workId);
      const receipt = store.all<ToolReceipt>("tool-call")[0];
      assert.equal(receipt.status, "failed");
      assert.match(receipt.output, new RegExp(error));
      assert.ok(model.prompts[1].messages[1].content.includes(error));
    } finally {
      store.close();
    }
  }
  assert.throws(() => parseToolRequest(calculate([1, 2], "eval")));
  const store = fixture();
  try {
    const model = new Script((p, n) =>
        n === 1 ? calculate([0.1, 0.2], "add") : "约0.3",
      ),
      runtime = new Runtime(store, () => model),
      run = runtime.submit(input());
    await runtime.settled(run.workId);
    assert.equal(
      JSON.parse(store.all<ToolReceipt>("tool-call")[0].output).result,
      0.3,
    );
  } finally {
    store.close();
  }
});
test("delegated lookup stays inside assigned references even when parent has more material", async () => {
  const store = fixture();
  try {
    const a = store.addMaterial("A", "唯一获准正文"),
      b = store.addMaterial("B", "SECRET_OUTSIDE_CHILD");
    const model = new Script((p, n) =>
      n === 1
        ? JSON.stringify({
            ytriple_delegate: {
              memberId: "researcher",
              objective: "查找材料",
              context: "只读分配材料",
              references: [1],
            },
          })
        : n === 2
          ? material({ mode: "read", reference: 2, start: 0, maxChars: 100 })
          : n === 3
            ? "第二份材料不在此子任务范围。"
            : "负责人采纳范围限制。",
    );
    const runtime = new Runtime(store, () => model),
      run = runtime.submit(
        input({
          refs: [a, b].map((m) => ({
            materialId: m.id,
            version: 1,
            label: m.title,
          })),
        }),
      );
    await runtime.settled(run.workId);
    assert.equal(store.require<Run>("run", run.id).status, "succeeded");
    assert.ok(
      model.prompts
        .filter((p) => p.taskId.includes(":d:"))
        .every((p) => !p.messages[1].content.includes("SECRET_OUTSIDE_CHILD")),
    );
    assert.equal(store.all<ToolReceipt>("tool-call")[0].status, "failed");
    assert.ok(
      model.prompts[2].messages[1].content.includes("不在本任务分配范围"),
    );
  } finally {
    store.close();
  }
});
test("tool policy and member grants freeze per run, with global limits and duplicate-loop protection", async () => {
  for (const duplicate of [true, false]) {
    const store = fixture();
    try {
      const model = new Script((p, n) =>
        calculate(duplicate ? [1, 2] : [1, n], "add"),
      );
      const runtime = new Runtime(store, () => model),
        run = runtime.submit(input());
      store.put("meta", "team", {
        ...defaultTeam,
        version: 2,
        members: defaultTeam.members.map((m) => ({ ...m, toolKeys: [] })),
      });
      await runtime.settled(run.workId);
      assert.equal(store.require<Run>("run", run.id).status, "failed");
      assert.equal(store.all("tool-call").length, duplicate ? 1 : 8);
      assert.equal(store.require<Run>("run", run.id).tools?.keys.length, 2);
      assert.equal(store.all("version").length, 0);
    } finally {
      store.close();
    }
  }
});
test("completed tool receipts survive process restart and remote reconciliation without rerunning tools or paid requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "ytriple-tools-")),
    path = join(root, "workbench.sqlite");
  let store = fixture(path);
  try {
    const model = new Script((_p, n) => {
      if (n === 1) return calculate();
      throw new TypeError("lost stream");
    });
    let runtime = new Runtime(store, () => model);
    const run = runtime.submit(input());
    await runtime.settled(run.workId);
    assert.equal(store.require<Run>("run", run.id).status, "unknown");
    const receipts = store.all<ToolReceipt>("tool-call");
    assert.equal(receipts.length, 1);
    store.close();
    store = new Store(path);
    store.recover();
    let calls = 0;
    runtime = new Runtime(store, () => ({
      async *stream() {
        calls++;
        throw Error("no replay");
      },
      async lookup(id) {
        return {
          id,
          status: "succeeded",
          error: null,
          result: { text: "已根据工具25%继续，保留测试限制。" },
        };
      },
    }));
    await runtime.reconcile(run.id);
    runtime.resume(run.workId);
    await runtime.settled(run.workId);
    assert.equal(calls, 0);
    assert.equal(store.require<Run>("run", run.id).status, "succeeded");
    assert.deepEqual(store.all("tool-call"), receipts);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("stopped or scope-modified tool requests are rejected before execution and completed records replay only by exact identity", async () => {
  const store = fixture();
  try {
    const model = new Script((_p, n) => (n === 1 ? calculate() : "完成")),
      runtime = new Runtime(store, () => model),
      run = runtime.submit(input());
    await runtime.settled(run.workId);
    const record = store.all<ToolReceipt>("tool-call")[0],
      owner = store.require<Contribution>(
        "contribution",
        record.contributionId,
      ),
      member = run.team.members.find((m) => m.id === owner.memberId)!,
      tools = new LocalTools(store);
    assert.deepEqual(
      tools.execute(
        run,
        member,
        owner.id,
        [],
        record.request,
        new AbortController().signal,
      ),
      record,
    );
    assert.throws(
      () =>
        tools.execute(
          run,
          member,
          owner.id,
          [],
          record.request,
          AbortSignal.abort(),
        ),
      /停止/,
    );
    assert.throws(
      () =>
        tools.execute(
          run,
          member,
          owner.id,
          [],
          parseToolRequest(calculate([100, 120]))!,
          new AbortController().signal,
        ),
      /内容或范围/,
    );
    assert.throws(
      () =>
        tools.execute(
          { ...run, tools: undefined },
          member,
          owner.id,
          [],
          record.request,
          new AbortController().signal,
        ),
      /获准范围/,
    );
    assert.equal(store.all("tool-call").length, 1);
  } finally {
    store.close();
  }
});
test("workspace backup preserves actual tool evidence and rejects orphaned or inconsistent receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "ytriple-tool-backup-")),
    store = fixture(join(root, "workbench.sqlite"));
  let recovered: Store | undefined;
  try {
    const model = new Script((_p, n) => (n === 1 ? calculate() : "结果25%")),
      runtime = new Runtime(store, () => model),
      run = runtime.submit(input());
    await runtime.settled(run.workId);
    const backup = new WorkspaceBackups(root),
      file = join(root, "tools.ytriple-backup");
    await backup.export(store, file);
    const preview = await backup.inspect(file),
      space = await backup.restore(preview.id, "工具记录", {
        aiPath: null,
        codePath: null,
      });
    recovered = new Store(join(root, "spaces", space.id, "workbench.sqlite"));
    assert.deepEqual(recovered.all("tool-call"), store.all("tool-call"));
    const data = JSON.parse(await readFile(file, "utf8")).payload;
    data.entities = data.entities.filter((r: any) => r.kind !== "tool-call");
    assert.throws(() => validateWorkspace(data), /缺少关联/);
    const corrupt = store.exportState();
    const row = corrupt.entities.find((r) => r.kind === "tool-call")!,
      record = JSON.parse(row.data);
    record.memberId = "another";
    row.data = JSON.stringify(record);
    assert.throws(() => validateWorkspace(corrupt), /归属/);
  } finally {
    recovered?.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
