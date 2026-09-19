import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/core/store";
import { Runtime } from "../src/core/runtime";
import {
  YCore,
  ServiceError,
  type Model,
  type Prompt,
  type StreamEvent,
} from "../src/core/ycore";
import type {
  Run,
  SubmitInput,
  ArtifactVersion,
  Contribution,
  Work,
} from "../src/core/types";
import { teamResponse, boundBaseFromPrompt } from "./team-response";
const input = (context = "new", text = "整理证据并形成说明"): SubmitInput => ({
  key: randomUUID(),
  context,
  text,
  refs: [],
  recipient: null,
  projectId: null,
});
class ModelFixture implements Model {
  calls = 0;
  active = 0;
  maxActive = 0;
  fail = false;
  async *stream(
    _prompt: Prompt,
    key: string,
    signal: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    this.calls++;
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      yield { type: "run.started", run_id: key };
      await new Promise((r) => setTimeout(r, 3));
      if (signal.aborted) throw new DOMException("Stopped", "AbortError");
      const answer =
        this.calls % 3 === 2 ? "依据不足，保留限制" : "测试成果，保留限制";
      const system =
        _prompt.messages.find((m) => m.role === "system")?.content ?? "";
      const allowsArtifact = !system.includes("不允许提交 artifact");
      const baseVersionId = boundBaseFromPrompt(_prompt);
      yield {
        type: "text.delta",
        run_id: key,
        text: teamResponse(
          answer,
          allowsArtifact ? { body: answer, baseVersionId } : null,
        ),
      };
      if (this.fail)
        throw new ServiceError(
          "STREAM_INTERRUPTED",
          "fixture interruption",
          key,
        );
      yield { type: "run.completed", run_id: key };
    } finally {
      this.active--;
    }
  }
}
test("durable drafts, submissions and exact references survive reopening; duplicate submission cannot create a second run", () => {
  const dir = mkdtempSync(join(tmpdir(), "ytriple-test-"));
  try {
    let s = new Store(join(dir, "db.sqlite"));
    const material = s.addMaterial("依据", "原始正文");
    const request = {
      ...input(),
      refs: [{ materialId: material.id, version: 1, label: "依据" }],
    };
    s.saveDraft({
      id: "new",
      text: request.text,
      refs: request.refs,
      recipient: null,
      projectId: null,
    });
    const first = s.submit(request);
    assert.equal(s.submit(request).id, first.id);
    assert.equal(s.all("work").length, 1);
    assert.equal(s.get("draft", "new"), undefined);
    assert.throws(() => s.submit({ ...request, text: "不同目标" }));
    s.close();
    s = new Store(join(dir, "db.sqlite"));
    assert.equal(s.material(request.refs[0]).body, "原始正文");
    assert.equal(s.require<Run>("run", first.id).text, request.text);
    s.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});
test("project ownership and missing material fail atomically without creating partial works", () => {
  const s = new Store(":memory:");
  const a = s.createProject("甲", "", "software"),
    b = s.createProject("乙", "", "media"),
    d = s.createDelivery(a.id, "版本");
  assert.throws(() =>
    s.submit({ ...input(), projectId: b.id, deliveryId: d.id }),
  );
  assert.throws(() =>
    s.submit({
      ...input(),
      refs: [{ materialId: "missing", version: 1, label: "missing" }],
    }),
  );
  assert.equal(s.all("work").length, 0);
  assert.equal(s.all("run").length, 0);
  s.close();
});
test("real orchestration serializes members and queued turns, versions remain one chain; adopted version never floats", async () => {
  const s = new Store(":memory:"),
    model = new ModelFixture(),
    runtime = new Runtime(s, () => model);
  const p = s.createProject("项目", "", "media"),
    d = s.createDelivery(p.id, "脚本");
  const first = runtime.submit({
    ...input(),
    projectId: p.id,
    deliveryId: d.id,
  });
  const second = runtime.submit({
    ...input(first.workId, "改得更口语"),
    projectId: p.id,
  });
  await runtime.settled(first.workId);
  assert.equal(model.calls, 6);
  assert.equal(model.maxActive, 1);
  assert.equal(s.require<Run>("run", second.id).status, "succeeded");
  const versions = s.all<ArtifactVersion>("version");
  assert.equal(versions.length, 2);
  assert.equal(versions[1].parentId, versions[0].id);
  assert.equal(versions[1].artifactId, versions[0].artifactId);
  s.adopt(d.id, versions[0].id);
  runtime.submit({ ...input(first.workId, "重新整理成果"), projectId: p.id });
  await runtime.settled(first.workId);
  const revised = s.all<ArtifactVersion>("version").at(-1)!;
  assert.equal(
    s.require<{ adoptedVersionId: string }>("delivery", d.id).adoptedVersionId,
    versions[0].id,
  );
  assert.equal(revised.number, 3);
  assert.equal(revised.parentId, versions[1].id);
  s.close();
});
test("interrupted stream pauses pending work, retains partial analysis and creates no successful artifact", async () => {
  const s = new Store(":memory:"),
    model = new ModelFixture();
  model.fail = true;
  const runtime = new Runtime(s, () => model),
    first = runtime.submit(input());
  const queued = runtime.submit(input(first.workId, "下一轮"));
  await runtime.settled(first.workId);
  assert.equal(s.require<Run>("run", first.id).status, "unknown");
  assert.equal(s.require<Run>("run", queued.id).status, "queued");
  assert.equal(s.all("version").length, 0);
  assert.ok(s.all<Contribution>("contribution")[0].body);
  assert.equal(model.calls, 1);
  assert.throws(() => runtime.resume(first.workId));
  s.close();
});
test("stop aborts current generation and pauses queued supplement without deleting it", async () => {
  const s = new Store(":memory:"),
    model = new ModelFixture(),
    runtime = new Runtime(s, () => model);
  const first = runtime.submit(input()),
    queued = runtime.submit(input(first.workId, "后续补充"));
  await new Promise((r) => setTimeout(r, 1));
  runtime.stop(first.workId);
  await runtime.settled(first.workId);
  assert.equal(s.require<Run>("run", first.id).status, "cancelled");
  assert.equal(s.require<Run>("run", queued.id).status, "queued");
  assert.equal(s.all("version").length, 0);
  assert.equal(s.require<Work>("work", first.workId).queuePaused, true);
  s.close();
});
test("restart does not silently retry running or queued paid work", () => {
  const s = new Store(":memory:"),
    first = s.submit(input()),
    second = s.submit(input(first.workId, "补充"));
  s.setRun(first.id, { status: "running" });
  s.recover();
  assert.equal(s.require<Run>("run", first.id).status, "unknown");
  assert.equal(s.require<Run>("run", second.id).status, "queued");
  assert.equal(s.require<Work>("work", first.workId).queuePaused, true);
  s.close();
});
const prompt: Prompt = {
  taskId: "t",
  refs: [],
  messages: [{ role: "user", content: "hello" }],
};
const streamFetch = (wire: string) => async () =>
  new Response(
    new ReadableStream({
      start(c) {
        const bytes = new TextEncoder().encode(wire);
        for (let i = 0; i < bytes.length; i++) c.enqueue(bytes.slice(i, i + 1));
        c.close();
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "X-YCore-Contract": "0.1.0",
      },
    },
  );
test("SSE handles split UTF-8 and CRLF, and requires a terminal event", async () => {
  const wire =
    'event: run.started\r\ndata: {"run_id":"r"}\r\n\r\nevent: text.delta\r\ndata: {"run_id":"r","text":"中文"}\r\n\r\n';
  let c = new YCore(
    "https://service.example",
    "test",
    streamFetch(
      wire + 'event: run.completed\r\ndata: {"run_id":"r"}\r\n\r\n',
    ) as typeof fetch,
  );
  const events = [];
  for await (const e of c.stream(
    prompt,
    "fixed-key",
    new AbortController().signal,
  ))
    events.push(e);
  assert.equal(events[1].text, "中文");
  c = new YCore(
    "https://service.example",
    "test",
    streamFetch(
      wire + 'event: run.completed\r\ndata: {"run_id":"r"}',
    ) as typeof fetch,
  );
  const eofEvents = [];
  for await (const event of c.stream(
    prompt,
    "fixed-key",
    new AbortController().signal,
  ))
    eofEvents.push(event);
  assert.equal(eofEvents.at(-1)?.type, "run.completed");
  c = new YCore(
    "https://service.example",
    "test",
    streamFetch(wire) as typeof fetch,
  );
  await assert.rejects(async () => {
    for await (const _ of c.stream(
      prompt,
      "fixed-key",
      new AbortController().signal,
    )) {
    }
  }, /尚未确认完成/);
});
test("sync reads every snapshot page and persists revisions plus incremental cursor without duplicate materials", async () => {
  const s = new Store(":memory:");
  const doc = (id: string, revision = 1) => ({
    id,
    revision,
    url: "https://example.com/" + id,
    publisher: "Example",
    published_at: null,
    discovered_at: "2026-09-18T00:00:00Z",
    updated_at: "2026-09-18T00:00:00Z",
    topics: ["technology"],
    content: {
      title: id,
      summary: "内容",
      body: null,
      format: "text",
      coverage: "summary",
      full_article: false,
    },
    provenance: [
      {
        source_id: "source-1",
        adapter: "rss",
        upstream_id: id,
        discovered_at: "2026-09-18T00:00:00Z",
        raw_ref: "raw-1",
      },
    ],
    content_hash: `hash-${id}-${revision}`,
    visibility: "public" as const,
  });
  let pages = 0;
  const fetcher = async (url: RequestInfo | URL) => {
    const p = new URL(String(url));
    let body: unknown;
    if (p.pathname.endsWith("sources")) body = { data: [] };
    else if (p.pathname.endsWith("documents")) {
      pages++;
      body = p.searchParams.has("cursor")
        ? { data: [doc("b")], next_cursor: null, sync_cursor: "same-position-new-signature" }
        : { data: [doc("a")], next_cursor: "page-2", sync_cursor: "start" };
    } else
      body = {
        data: [
          {
            sequence: "90071992547409990",
            operation: "upsert",
            document: doc("a", 2),
          },
        ],
        next_cursor: "end",
        has_more: false,
      };
    return new Response(JSON.stringify(body), {
      headers: { "X-YCore-Contract": "0.1.0" },
    });
  };
  const c = new YCore(
    "https://service.example",
    "test",
    fetcher as typeof fetch,
  );
  await c.sync(s);
  await c.sync(s);
  assert.equal(pages, 2);
  assert.equal(s.all("material").length, 3);
  assert.equal(s.get("meta", `sync:${c.scope}`), "end");
  assert.notEqual(c.scope, new YCore("https://service.example", "other").scope);
  s.close();
});
test("reconcile retrieves original paid stage and resumes without replaying it", async () => {
  const s = new Store(":memory:");
  class Recoverable extends ModelFixture {
    async lookup() {
      return {
        status: "succeeded",
        result: {
          text: teamResponse("已找回原运行的研究结果", {
            body: "已找回原运行的研究结果",
            baseVersionId: null,
          }),
        },
        error: null,
      };
    }
  }
  const model = new Recoverable();
  model.fail = true;
  const runtime = new Runtime(s, () => model);
  const run = runtime.submit(input());
  await runtime.settled(run.workId);
  assert.equal(model.calls, 1);
  await runtime.reconcile(run.id);
  assert.equal(model.calls, 1);
  assert.equal(s.require<Run>("run", run.id).status, "queued");
  model.fail = false;
  runtime.resume(run.workId);
  await runtime.settled(run.workId);
  assert.equal(model.calls, 3);
  assert.equal(s.require<Run>("run", run.id).status, "succeeded");
  assert.equal(s.all("version").length, 1);
  s.close();
});
test("quitting an idle completed work does not pause its next explicitly sent turn", async () => {
  const s = new Store(":memory:"),
    m = new ModelFixture(),
    r = new Runtime(s, () => m);
  const first = r.submit(input());
  await r.settled(first.workId);
  r.shutdown();
  assert.equal(s.require<Work>("work", first.workId).queuePaused, false);
  s.recover();
  const next = r.submit(input(first.workId, "继续修订"));
  await r.settled(first.workId);
  assert.equal(s.require<Run>("run", next.id).status, "succeeded");
  s.close();
});

test("team and workflow versions are independent; selecting a pair only affects later submissions in that work", () => {
  const s = new Store(":memory:");
  const first = s.submit(input());
  const queued = s.submit(input(first.workId, "已排队的原配置"));
  const other = s.submit(input());
  const original = s.configuration(first.workId);
  const team = s.saveTeam({
    ...original.team,
    name: "证据团队",
    members: original.team.members.map((m) => ({ ...m, name: m.name + "甲" })),
  });
  assert.equal(team.version, 2);
  assert.equal(s.configuration().team.version, 1);
  assert.equal(s.configuration().workflow.version, 1);
  assert.throws(() => s.saveTeam(original.team), /新版本/);
  const flow = s.saveWorkflow({
    ...original.workflow,
    name: "只做判断",
    stages: [
      { role: "researcher", objective: "回应问题而不改成果", result: false },
    ],
  });
  s.selectConfiguration(first.workId, `${team.id}@2`, `${flow.id}@2`);
  const next = s.submit(input(first.workId, "使用新的独立组合"));
  assert.equal(next.team.version, 2);
  assert.equal(next.workflow.version, 2);
  assert.equal(s.require<Run>("run", queued.id).team.version, 1);
  assert.equal(s.require<Run>("run", first.id).workflow.version, 1);
  assert.equal(s.configuration(other.workId).team.version, 1);
  assert.equal(s.configuration().team.version, 1);
  const incompatible = s.saveTeam({
    ...team,
    members: [team.members.find((m) => m.id === "editor")!],
  });
  assert.throws(
    () =>
      s.selectConfiguration(
        first.workId,
        `${incompatible.id}@3`,
        `${flow.id}@2`,
      ),
    /不存在的成员/,
  );
  assert.equal(s.configuration(first.workId).team.version, 2);
  s.selectConfiguration(null, `${team.id}@2`, `${flow.id}@2`);
  assert.equal(s.submit(input()).team.version, 2);
  assert.equal(s.submit(input(other.workId)).team.version, 1);
  s.close();
});

test("work reassignment preserves identity, drafts and versions, and refuses incompatible or adopted delivery moves", async () => {
  const s = new Store(":memory:"),
    m = new ModelFixture(),
    r = new Runtime(s, () => m);
  const run = r.submit(input());
  await r.settled(run.workId);
  const v = s.all<ArtifactVersion>("version")[0];
  s.saveDraft({
    id: run.workId,
    text: "未发修改",
    refs: [],
    recipient: null,
    projectId: null,
  });
  const a = s.createProject("甲项目", "", "media"),
    b = s.createProject("乙项目", "", "software"),
    d = s.createDelivery(a.id, "脚本");
  assert.throws(() => s.updateWork(run.workId, "新名字", b.id, d.id), /不属于/);
  s.updateWork(run.workId, "证据摘要", a.id, d.id);
  assert.equal(s.require<Work>("work", run.workId).title, "证据摘要");
  assert.equal(s.snapshot().drafts[0].text, "未发修改");
  assert.equal(s.snapshot().drafts[0].projectId, a.id);
  assert.equal(s.all<ArtifactVersion>("version")[0].id, v.id);
  assert.equal(s.all("work").length, 1);
  s.adopt(d.id, v.id);
  assert.throws(
    () => s.updateWork(run.workId, "同一工作", null, null),
    /已被交付采用/,
  );
  assert.throws(() => s.clearAdoption(d.id, "stale"), /已变化/);
  s.clearAdoption(d.id, v.id);
  s.updateWork(run.workId, "同一工作", null, null);
  const pending = s.submit(input(run.workId));
  assert.throws(() => s.updateWork(run.workId, "等待中", a.id, null), /未结束/);
  s.updateWork(run.workId, "允许改名", null, null);
  s.withdraw(pending.id);
  s.updateWork(run.workId, "已归入甲", a.id, null);
  s.close();
});

test("scoped interrupted runs cannot be reconciled or switched using another service account", async () => {
  class Scoped extends ModelFixture {
    lookups = 0;
    constructor(readonly scope: string) {
      super();
    }
    async lookup() {
      this.lookups++;
      return {
        status: "succeeded",
        result: { text: "原服务输出" },
        error: null,
      };
    }
  }
  const s = new Store(":memory:"),
    a = new Scoped("account-a"),
    b = new Scoped("account-b");
  let current = a;
  a.fail = true;
  const runtime = new Runtime(s, () => current);
  const run = runtime.submit(input());
  await runtime.settled(run.workId);
  assert.equal(s.require<Run>("run", run.id).serviceScope, "account-a");
  assert.throws(() => runtime.assertCanChangeProvider("account-b"), /原服务/);
  runtime.assertCanChangeProvider("account-a");
  current = b;
  await assert.rejects(() => runtime.reconcile(run.id), /另一服务/);
  assert.equal(b.lookups, 0);
  assert.equal(s.require<Run>("run", run.id).status, "unknown");
  current = a;
  await runtime.reconcile(run.id);
  a.fail = false;
  runtime.resume(run.workId);
  await runtime.settled(run.workId);
  runtime.assertCanChangeProvider("account-b");
  assert.equal(a.calls, 3);
  assert.equal(b.calls, 0);
  s.close();
});

test("custom non-result workflow executes its chosen member and responds without creating an artifact", async () => {
  const s = new Store(":memory:");
  const { team, workflow } = s.configuration();
  const nextTeam = s.saveTeam({
    ...team,
    members: team.members.map((m) =>
      m.id === "editor"
        ? { ...m, name: "科普编辑", instruction: "解释用户问题，不改写成果。" }
        : m,
    ),
  });
  const nextFlow = s.saveWorkflow({
    ...workflow,
    stages: [{ role: "editor", objective: "只解释概念", result: false }],
  });
  s.selectConfiguration(null, `${nextTeam.id}@2`, `${nextFlow.id}@2`);
  class InspectModel extends ModelFixture {
    prompts: Prompt[] = [];
    override async *stream(p: Prompt, key: string, signal: AbortSignal) {
      this.prompts.push(p);
      yield* super.stream(p, key, signal);
    }
  }
  const model = new InspectModel(),
    runtime = new Runtime(s, () => model);
  const run = runtime.submit(input());
  await runtime.settled(run.workId);
  assert.equal(model.calls, 1);
  assert.equal(s.all("version").length, 0);
  assert.match(model.prompts[0].messages[0].content, /科普编辑.*解释用户问题/);
  assert.match(model.prompts[0].messages[1].content, /只解释概念/);
  assert.equal(s.all<Contribution>("contribution")[0].memberName, "科普编辑");
  assert.equal(s.snapshot().messages.at(-1)?.body, "测试成果，保留限制");
  s.close();
});

test("resuming a persisted queue with changed credentials retains pending state and makes no model call", async () => {
  const s = new Store(":memory:");
  const run = s.submit(input(), "account-a");
  s.recover();
  class Other extends ModelFixture {
    readonly scope = "account-b";
  }
  const m = new Other(),
    runtime = new Runtime(s, () => m);
  assert.throws(() => runtime.resume(run.workId), /另一服务/);
  assert.equal(s.require<Run>("run", run.id).status, "queued");
  assert.equal(s.require<Work>("work", run.workId).queuePaused, true);
  assert.equal(m.calls, 0);
  s.close();
});

test("layouts and per-work reading views persist independently without starting work or changing drafts", () => {
  const dir = mkdtempSync(join(tmpdir(), "ytriple-layout-"));
  try {
    let s = new Store(join(dir, "db"));
    const a = s.submit(input()),
      b = s.submit(input());
    s.saveDraft({
      id: a.workId,
      text: "保存的输入",
      refs: [],
      recipient: null,
      projectId: null,
    });
    s.saveLayout({
      mode: "mixed",
      order: ["result", "decision", "process"],
      split: 45,
      stacked: 58,
      sizes: [30, 35, 35],
    });
    s.saveView({
      id: a.workId,
      surface: "process",
      focused: "process",
      versionId: null,
      scroll: { process: 451, result: 120 },
    });
    s.saveView({
      id: b.workId,
      surface: "result",
      focused: null,
      versionId: null,
      scroll: { process: 72 },
    });
    assert.throws(() =>
      s.saveLayout({
        mode: "rows",
        order: ["result", "result", "decision"],
        split: 38,
        stacked: 50,
        sizes: [34, 33, 33],
      }),
    );
    assert.throws(() =>
      s.saveView({
        id: b.workId,
        surface: "result",
        focused: null,
        versionId: "missing",
        scroll: {},
      }),
    );
    s.close();
    s = new Store(join(dir, "db"));
    const snap = s.snapshot();
    assert.deepEqual(snap.layout.order, ["result", "decision", "process"]);
    assert.equal(snap.layout.split, 45);
    assert.equal(
      snap.views.find((v) => v.id === a.workId)?.scroll.process,
      451,
    );
    assert.equal(snap.views.find((v) => v.id === b.workId)?.scroll.process, 72);
    assert.equal(snap.drafts[0].text, "保存的输入");
    assert.equal(snap.runs.length, 2);
    assert.equal(snap.contributions.length, 0);
    s.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("editing pending supplement pauses the queue and survives restart without changing the original submission or paid steps", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ytriple-queue-"));
  try {
    let s = new Store(join(dir, "db"));
    const first = s.submit(input()),
      pending = s.submit(input(first.workId, "原补充"));
    const opened = s.beginQueueEdit(pending.id);
    assert.ok(opened.queueDraft);
    assert.equal(s.require<Work>("work", first.workId).queuePaused, true);
    s.saveQueueDraft(pending.id, 0, {
      text: "更准确的补充",
      refs: [],
      recipient: "reviewer",
    });
    assert.equal(s.require<Run>("run", pending.id).text, "原补充");
    s.close();
    s = new Store(join(dir, "db"));
    s.recover();
    const model = new ModelFixture(),
      r = new Runtime(s, () => model);
    assert.throws(() => r.resume(first.workId), /保存或放弃/);
    const saved = s.applyQueueEdit(pending.id, 0);
    assert.equal(saved.text, "更准确的补充");
    assert.equal(saved.recipient, "reviewer");
    assert.equal(
      s.snapshot().messages.find((m) => m.runId === pending.id)?.body,
      "更准确的补充",
    );
    assert.throws(() => s.applyQueueEdit(pending.id, 0), /已变化/);
    assert.equal(model.calls, 0);
    r.resume(first.workId);
    await r.settled(first.workId);
    assert.equal(model.calls, 4);
    assert.equal(s.all("version").length, 1);
    assert.equal(s.all("run").length, 2);
    assert.throws(() => s.beginQueueEdit(first.id), /开始执行/);
    s.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("failed attachments and invalid excerpts cannot be silently dropped from first sends or edited queued runs", () => {
  const s = new Store(":memory:");
  const material = s.addMaterial("未读取文件", "", "unread");
  s.put("material", `${material.id}@1`, { ...material, readError: "读取失败" });
  const ref = { materialId: material.id, version: 1, label: material.title };
  assert.throws(() => s.submit({ ...input(), refs: [ref] }), /尚未就绪/);
  assert.equal(s.all("work").length, 0);
  const queued = s.submit(input());
  s.beginQueueEdit(queued.id);
  s.saveQueueDraft(queued.id, 0, {
    text: "继续",
    refs: [ref],
    recipient: null,
  });
  assert.throws(() => s.applyQueueEdit(queued.id, 0), /修复或移除/);
  assert.equal(s.require<Run>("run", queued.id).text, queued.text);
  s.put("material", `${material.id}@1`, { ...material, body: "实际读取范围" });
  s.saveQueueDraft(queued.id, 0, {
    text: "继续",
    refs: [{ ...ref, excerpt: "未读取范围" }],
    recipient: null,
  });
  assert.throws(() => s.applyQueueEdit(queued.id, 0), /选段/);
  s.saveQueueDraft(queued.id, 0, {
    text: "继续",
    refs: [{ ...ref, excerpt: "实际读取" }],
    recipient: null,
  });
  assert.equal(s.applyQueueEdit(queued.id, 0).refs[0].excerpt, "实际读取");
  s.close();
});

test("invalid stream before the first event finds the same submitted stage without a new POST", async () => {
  const store = new Store(":memory:");
  let calls = 0;
  let lookups = 0;
  const model: Model = {
    scope: "recovery-test",
    async *stream() {
      calls++;
      throw new ServiceError(
        "INVALID_STREAM",
        "invalid event before first server event",
      );
    },
    async lookupByKey(key) {
      lookups++;
      const remoteKey = store.all<Contribution>("contribution")[0].remoteKey!;
      assert.equal(key, remoteKey);
      return {
        id: "original-remote-run",
        status: "succeeded",
        result: { text: "已付费的原步骤" },
        error: null,
      };
    },
  };
  const runtime = new Runtime(store, () => model);
  const run = runtime.submit(input());
  await runtime.settled(run.workId);
  assert.equal(store.require<Run>("run", run.id).status, "unknown");
  assert.equal(store.all<Contribution>("contribution")[0].remoteId, null);
  await runtime.reconcile(run.id);
  const saved = store.all<Contribution>("contribution")[0];
  assert.equal(saved.remoteId, "original-remote-run");
  assert.equal(saved.body, "已付费的原步骤");
  assert.equal(saved.status, "succeeded");
  assert.equal(store.require<Work>("work", run.workId).queuePaused, true);
  assert.equal(store.require<Run>("run", run.id).status, "queued");
  assert.equal(calls, 1);
  assert.equal(lookups, 1);
  store.close();
});

test("execution-lost and provider-unknown terminal events retain the original run for recovery", async () => {
  for (const code of ["EXECUTION_LOST", "PROVIDER_ERROR"]) {
    const store = new Store(":memory:");
    let calls = 0;
    const remoteId = `remote-${code}`;
    const model: Model = {
      scope: "uncertain-terminal-test",
      async *stream() {
        calls++;
        yield { type: "run.started", run_id: remoteId };
        yield {
          type: "run.failed",
          run_id: remoteId,
          error: { code, message: "billing and result are not confirmed" },
        };
      },
      async lookup(id) {
        assert.equal(id, remoteId);
        return {
          status: "succeeded",
          result: { text: "已找回原运行结果" },
          error: null,
        };
      },
    };
    const runtime = new Runtime(store, () => model);
    const run = runtime.submit(input());
    await runtime.settled(run.workId);
    assert.equal(store.require<Run>("run", run.id).status, "unknown");
    assert.equal(store.all<Contribution>("contribution")[0].status, "unknown");
    await runtime.reconcile(run.id);
    assert.equal(store.require<Run>("run", run.id).status, "queued");
    assert.equal(calls, 1);
    store.close();
  }
});

test("stopping before the first server event remains uncertain until read-only recovery confirms cancellation", async () => {
  const store = new Store(":memory:");
  let calls = 0;
  const model: Model = {
    scope: "stop-before-first-event",
    async *stream(_prompt, _key, signal) {
      calls++;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("stopped", "AbortError")),
          { once: true },
        );
      });
    },
    async lookupByKey() {
      return {
        id: "stopped-remote-run",
        status: "cancelled",
        result: null,
        error: { message: "cancelled by disconnect" },
      };
    },
  };
  const runtime = new Runtime(store, () => model);
  const run = runtime.submit(input());
  await new Promise((resolve) => setTimeout(resolve, 0));
  runtime.stop(run.workId);
  await runtime.settled(run.workId);
  assert.equal(store.require<Run>("run", run.id).status, "unknown");
  await runtime.reconcile(run.id);
  assert.equal(store.require<Run>("run", run.id).status, "cancelled");
  assert.equal(store.require<Work>("work", run.workId).queuePaused, true);
  assert.equal(calls, 1);
  store.close();
});
