import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { legacyFinish } from "./team-response";
import { Projects } from "../src/core/projects";
import { latestBrief, latestStandards } from "../src/core/project-contract";
import { Runtime } from "../src/core/runtime";
import type { ArtifactVersion, Run } from "../src/core/types";
import type { Model, Prompt } from "../src/core/ycore";
const request = (projectId: string | null, context = "new") => ({
  key: randomUUID(),
  context,
  projectId,
  text: "为今天的话题写一段开场",
  refs: [],
  recipient: null,
});
const standard = (projectId: string) => ({
  projectId,
  expectedRevision: 0,
  title: "结果先行",
  body: "开场先呈现结果，再解释方法。",
  deliveryId: null,
  enabled: true,
});
class CaptureModel implements Model {
  calls: { prompt: Prompt; key: string }[] = [];
  async *stream(prompt: Prompt, key: string) {
    this.calls.push({ prompt, key });
    yield { type: "run.started" as const, run_id: key };
    yield {
      type: "text.delta" as const,
      run_id: key,
      text: "已完成当前范围内的内容",
    };
    yield { type: "run.completed" as const, run_id: key };
  }
}
test("adopted project rules and exact source range survive restart and are used only by that project", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ytriple-project-context-"));
  try {
    const s = new Store(join(dir, "db"));
    const projects = new Projects(s);
    const a = s.createProject("栏目 A", "帮助新手理解方法", "media"),
      b = s.createProject("栏目 B", "讨论另一种主题", "media");
    const m = s.addMaterial(
      "A 的代表作品",
      "可读片段。\n不选入的段落。",
      "local_text",
    );
    projects.saveBrief({
      projectId: a.id,
      expectedRevision: 0,
      goal: a.goal,
      refs: [
        { materialId: m.id, version: 1, label: m.title, excerpt: "可读片段。" },
      ],
    });
    projects.saveStandard(standard(a.id));
    assert.equal(s.snapshot().runs.length, 0);
    s.close();
    const reopened = new Store(join(dir, "db"));
    const model = new CaptureModel();
    const runtime = new Runtime(reopened, () => model);
    const ar = runtime.submit(request(a.id));
    await runtime.settled(ar.workId);
    const br = runtime.submit(request(b.id));
    await runtime.settled(br.workId);
    const prompts = (runId: string) =>
      model.calls
        .filter((c) => c.prompt.taskId.startsWith(runId))
        .map((c) => JSON.stringify(c.prompt))
        .join("\n");
    assert.match(prompts(ar.id), /开场先呈现结果，再解释方法/);
    assert.match(prompts(ar.id), /可读片段/);
    assert.doesNotMatch(prompts(ar.id), /不选入的段落/);
    assert.doesNotMatch(prompts(br.id), /结果先行|可读片段|帮助新手理解方法/);
    assert.equal(
      reopened.require<Run>("run", ar.id).projectContext?.standards[0].revision,
      1,
    );
    assert.equal(
      reopened.require<Run>("run", br.id).projectContext?.standards.length,
      0,
    );
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("queued runs freeze project goal, rules and actual source body at submission; updates and retirement only affect new submissions", () => {
  const s = new Store(":memory:"),
    projects = new Projects(s),
    p = s.createProject("栏目", "初始目标", "media");
  const m = s.addMaterial("依据", "原始资料", "local_text");
  projects.saveBrief({
    projectId: p.id,
    expectedRevision: 0,
    goal: "目标一",
    refs: [{ materialId: m.id, version: 1, label: m.title }],
  });
  const rule = projects.saveStandard(standard(p.id));
  const first = s.submit(request(p.id));
  projects.saveBrief({
    projectId: p.id,
    expectedRevision: 1,
    goal: "目标二",
    refs: [{ materialId: m.id, version: 1, label: m.title }],
  });
  projects.saveStandard({
    ...standard(p.id),
    id: rule.id,
    expectedRevision: 1,
    body: "从问题开始，再给出结果。",
  });
  // A same-key material repair must not rewrite the submitted context snapshot.
  s.put("material", `${m.id}@1`, { ...m, body: "修复后的资料" });
  const queued = s.submit(request(p.id, first.workId));
  assert.equal(s.require<Run>("run", first.id).projectContext?.goal, "目标一");
  assert.equal(
    s.require<Run>("run", first.id).projectContext?.materials[0].material.body,
    "原始资料",
  );
  assert.equal(queued.projectContext?.goal, "目标二");
  assert.equal(queued.projectContext?.standards[0].revision, 2);
  projects.saveStandard({
    ...standard(p.id),
    id: rule.id,
    expectedRevision: 2,
    enabled: false,
  });
  const after = s.submit(request(p.id, first.workId));
  assert.equal(after.projectContext?.standards.length, 0);
  assert.equal(
    s.require<Run>("run", queued.id).projectContext?.standards.length,
    1,
  );
  assert.equal(
    latestStandards(s.snapshot().projectStandards, p.id)[0].revision,
    3,
  );
  s.close();
});
test("delivery-specific standards do not affect sibling deliveries or general project work", () => {
  const s = new Store(":memory:"),
    projects = new Projects(s),
    p = s.createProject("栏目", "目标", "media");
  const a = s.createDelivery(p.id, "作品 A"),
    b = s.createDelivery(p.id, "作品 B");
  projects.saveStandard({ ...standard(p.id), deliveryId: a.id });
  const ar = s.submit({ ...request(p.id), deliveryId: a.id });
  const br = s.submit({ ...request(p.id), deliveryId: b.id });
  const general = s.submit(request(p.id));
  assert.equal(ar.projectContext?.standards.length, 1);
  assert.equal(br.projectContext?.standards.length, 0);
  assert.equal(general.projectContext?.standards.length, 0);
  s.close();
});
test("adopting a result as a standard preserves exact provenance and does not edit the result or adopt it for delivery", () => {
  const s = new Store(":memory:"),
    projects = new Projects(s),
    a = s.createProject("A", "目标", "media"),
    b = s.createProject("B", "目标", "media");
  const d = s.createDelivery(a.id, "交付");
  const run = s.submit({ ...request(a.id), deliveryId: d.id });
  s.setRun(run.id, { status: "running" });
  const version = legacyFinish(s, run.id, "先给出结果。\n然后解释方法。", true)!;
  const saved = projects.saveStandard({
    ...standard(a.id),
    source: { versionId: version.id, excerpt: "先给出结果。" },
  });
  assert.equal(saved.source?.versionId, version.id);
  assert.equal(
    s.require<ArtifactVersion>("version", version.id).body,
    version.body,
  );
  assert.equal(s.snapshot().deliveries[0].adoptedVersionId, null);
  assert.equal(s.snapshot().versions.length, 1);
  assert.throws(
    () => projects.saveStandard({ ...standard(b.id), source: saved.source }),
    /不属于当前项目/,
  );
  assert.throws(
    () =>
      projects.saveStandard({
        ...standard(a.id),
        source: { versionId: version.id, excerpt: "错误选段" },
      }),
    /选段/,
  );
  assert.throws(
    () =>
      projects.saveStandard({
        ...standard(b.id),
        id: saved.id,
        expectedRevision: 1,
      }),
    /另一项目/,
  );
  assert.throws(
    () =>
      projects.saveStandard({
        ...standard(a.id),
        id: saved.id,
        expectedRevision: 0,
      }),
    /已变化/,
  );
  s.close();
});
test("failed or invalid project sources and oversized context reject submission atomically before model invocation", () => {
  const s = new Store(":memory:"),
    projects = new Projects(s),
    p = s.createProject("A", "目标", "media"),
    m = s.addMaterial("资料", "完整正文");
  assert.throws(
    () =>
      projects.saveBrief({
        projectId: p.id,
        expectedRevision: 0,
        goal: "目标",
        refs: [
          { materialId: m.id, version: 1, label: m.title, excerpt: "不存在" },
        ],
      }),
    /选段/,
  );
  assert.equal(s.snapshot().projectBriefs.length, 0);
  projects.saveBrief({
    projectId: p.id,
    expectedRevision: 0,
    goal: "目标",
    refs: [{ materialId: m.id, version: 1, label: m.title }],
  });
  s.put("material", `${m.id}@1`, { ...m, readError: "读取失败" });
  const model = new CaptureModel(),
    runtime = new Runtime(s, () => model);
  assert.throws(() => runtime.submit(request(p.id)), /尚未就绪/);
  assert.equal(model.calls.length, 0);
  assert.equal(s.snapshot().works.length, 0);
  s.put("material", `${m.id}@1`, { ...m, body: "x".repeat(22000) });
  assert.throws(() => runtime.submit(request(p.id)), /超出本轮范围/);
  assert.equal(s.snapshot().runs.length, 0);
  assert.equal(s.snapshot().messages.length, 0);
  assert.throws(
    () =>
      projects.saveBrief({
        projectId: p.id,
        expectedRevision: 0,
        goal: "过时目标",
        refs: [],
      }),
    /已变化/,
  );
  assert.equal(latestBrief(s.snapshot().projectBriefs, p.id)?.goal, "目标");
  s.close();
});
test("moving completed work adopts the new project's requirements for later submissions without rewriting old runs", () => {
  const s = new Store(":memory:"),
    projects = new Projects(s),
    a = s.createProject("A", "A目标", "media"),
    b = s.createProject("B", "B目标", "media");
  projects.saveStandard(standard(a.id));
  const old = s.submit(request(a.id));
  s.setRun(old.id, { status: "running" });
  legacyFinish(s, old.id, "原成果", true);
  s.updateWork(old.workId, "迁移后的工作", b.id, null);
  const next = s.submit(request(b.id, old.workId));
  assert.equal(next.projectContext?.projectId, b.id);
  assert.equal(next.projectContext?.standards.length, 0);
  assert.equal(s.require<Run>("run", old.id).projectContext?.projectId, a.id);
  assert.equal(
    s.require<Run>("run", old.id).projectContext?.standards.length,
    1,
  );
  s.close();
});
