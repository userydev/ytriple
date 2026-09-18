import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/core/store";
import { Radar } from "../src/core/radar";
import {
  ServiceError,
  YCore,
  type Model,
  type Prompt,
  type StreamEvent,
} from "../src/core/ycore";
import type { RadarJob, Insight } from "../src/core/radar-contract";
import type { Material, Source } from "../src/core/types";

class EditorialFixture implements Model {
  scope = "fixture-a";
  calls = 0;
  lookups = 0;
  interrupt = false;
  protocolError = false;
  terminalError?: "EXECUTION_LOST" | "PROVIDER_ERROR";
  noChange = false;
  corrupt = false;
  extraMetadata = false;
  output = "";
  prompts: Prompt[] = [];
  async *stream(
    prompt: Prompt,
    key: string,
    _signal: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    this.calls++;
    this.prompts.push(prompt);
    const input = JSON.parse(prompt.messages[1].content);
    const eligible = input.sources.filter(
      (s: any) =>
        s.policy !== "exclude" && (!s.duplicateOf || s.policy === "keep"),
    );
    const insight: Insight = {
      changed: !this.noChange,
      title: "测试议题理解",
      summary: "测试材料表明方案仍有条件，不能当成已经完成。",
      sections: this.noChange
        ? []
        : [
            {
              heading: "认识与分歧",
              body: "比较两份材料，保留实际范围。",
              sources: this.corrupt ? ["FAKE"] : eligible.map((s: any) => s.id),
            },
          ],
      changes: input.previous ? ["新增材料修正了条件"] : [],
      limitations: ["这是测试文本，未浏览外部全文"],
      screening: eligible.map((s: any) => ({
        source: s.id,
        keep: true,
        reason: "与当前问题有关",
      })),
    };
    this.output = JSON.stringify({
      ...insight,
      ...(this.extraMetadata
        ? { sections_count: insight.sections.length }
        : {}),
    });
    yield { type: "run.started", run_id: key };
    yield {
      type: "text.delta",
      run_id: key,
      text: this.interrupt ? this.output.slice(0, 15) : this.output,
    };
    if (this.interrupt)
      throw new ServiceError(
        this.protocolError ? "INVALID_STREAM" : "STREAM_INTERRUPTED",
        "fixture interrupted",
        key,
      );
    if (this.terminalError) {
      yield {
        type: "run.failed",
        run_id: key,
        error: {
          code: this.terminalError,
          message: "billing and result are not confirmed",
        },
      };
      return;
    }
    yield { type: "run.completed", run_id: key };
  }
  async lookup() {
    this.lookups++;
    return { status: "succeeded", result: { text: this.output }, error: null };
  }
}
function setup(store = new Store(":memory:")) {
  const first = store.addMaterial(
    "甲材料",
    "已读取的详细证据。".repeat(30),
    "summary",
  );
  const duplicate = store.addMaterial("甲材料转载", first.body, "summary");
  const second = store.addMaterial(
    "乙材料：反例",
    "不能根据计划声称已经实现。",
    "feed_content",
  );
  const model = new EditorialFixture(),
    radar = new Radar(store, () => model);
  const topic = radar.saveTopic({
    revision: 0,
    title: "计划和实绩",
    focus: "关注不同观点",
    sources: [first, duplicate, second].map((m) => ({
      materialId: m.id,
      policy: "auto",
      reason: "",
    })),
  });
  return { store, model, radar, topic, first, duplicate, second };
}

const publicMaterial = (
  localId: string,
  upstreamId: string,
  sourceId: string,
  version: number,
  title: string,
  body: string,
  updatedAt: string,
  scope = "managed",
): Material => ({
  id: localId,
  version,
  title,
  body,
  coverage: "summary",
  url: `https://publisher.example/${upstreamId}`,
  upstream: {
    scope,
    id: upstreamId,
    revision: version,
    publisher: "Publisher",
    publishedAt: null,
    discoveredAt: updatedAt,
    updatedAt,
    topics: [],
    provenance: [
      {
        sourceId,
        adapter: "rss",
        upstreamId: `${upstreamId}-${version}`,
        discoveredAt: updatedAt,
        rawRef: `raw-${version}`,
      },
    ],
    contentHash: `${upstreamId}-${version}`,
    fullArticle: false,
  },
  createdAt: updatedAt,
});

function addPublicSource(store: Store, source: Partial<Source> = {}) {
  const value: Source = {
    id: "source-rss",
    name: "Public RSS",
    status: "active",
    last_error: null,
    ...source,
  };
  store.put("meta", "sources", [value]);
  return value;
}

test("a public-source topic picks up newly synced material without editing eighteen fixed references", async () => {
  const store = new Store(":memory:");
  const source = addPublicSource(store);
  const first = publicMaterial(
    "ycore:managed:first",
    "first",
    source.id,
    1,
    "Agent launch",
    "An agent product launched with measured limitations.",
    "2026-09-18T01:00:00Z",
  );
  store.put("material", `${first.id}@${first.version}`, first);
  const model = new EditorialFixture();
  const radar = new Radar(store, () => model);
  const topic = radar.saveTopic({
    revision: 0,
    title: "Agent products",
    focus: "Track evidence",
    sourceIds: [source.id],
    keywords: ["agent"],
    sources: [],
  });
  const initial = radar.refresh(topic.id);
  await radar.settled(initial.id);
  assert.deepEqual(
    store
      .require<RadarJob>("radar-job", initial.id)
      .sources.map((item) => item.reference.materialId),
    [first.id],
  );

  const next = publicMaterial(
    "ycore:managed:next",
    "next",
    source.id,
    1,
    "Another agent release",
    "New evidence arrived in the next completed sync.",
    "2026-09-18T02:00:00Z",
  );
  store.put("material", `${next.id}@${next.version}`, next);
  const refreshed = radar.refresh(topic.id);
  await radar.settled(refreshed.id);
  assert.deepEqual(
    store
      .require<RadarJob>("radar-job", refreshed.id)
      .sources.map((item) => item.reference.materialId),
    [next.id, first.id],
  );
  assert.equal(model.calls, 2);
  store.close();
});

test("public supply matches literal keywords, keeps the latest revision, and deduplicates an upstream document across scopes", async () => {
  const store = new Store(":memory:");
  const source = addPublicSource(store, {
    status: "degraded",
    last_error: "upstream timeout",
  });
  const old = publicMaterial(
    "ycore:legacy:same",
    "same",
    source.id,
    1,
    "Old robotics report",
    "robotics first revision",
    "2026-09-18T01:00:00Z",
    "legacy",
  );
  const latest = publicMaterial(
    "ycore:managed:same",
    "same",
    source.id,
    2,
    "Updated robotics report",
    "robotics latest revision",
    "2026-09-18T03:00:00Z",
  );
  const miss = publicMaterial(
    "ycore:managed:miss",
    "miss",
    source.id,
    1,
    "Unrelated finance",
    "No matching term here.",
    "2026-09-18T04:00:00Z",
  );
  for (const material of [old, latest, miss])
    store.put("material", `${material.id}@${material.version}`, material);
  const model = new EditorialFixture();
  const radar = new Radar(store, () => model);
  const topic = radar.saveTopic({
    revision: 0,
    title: "Robotics",
    focus: "",
    sourceIds: [source.id],
    keywords: ["ROBOTICS"],
    sources: [],
  });
  const job = radar.refresh(topic.id);
  await radar.settled(job.id);
  const request = JSON.parse(model.prompts[0].messages[1].content);
  assert.deepEqual(
    store
      .require<RadarJob>("radar-job", job.id)
      .sources.map((item) => [
        item.reference.materialId,
        item.reference.version,
      ]),
    [[latest.id, 2]],
  );
  assert.deepEqual(request.supply.sourceIds, [source.id]);
  assert.deepEqual(request.supply.keywords, ["ROBOTICS"]);
  assert.match(request.supply.notes.join("\n"), /不触发来源抓取/);
  assert.match(request.supply.notes.join("\n"), /upstream timeout/);
  store.close();
});

test("an empty public match is reported honestly and never calls the model", () => {
  const store = new Store(":memory:");
  const source = addPublicSource(store);
  const material = publicMaterial(
    "ycore:managed:item",
    "item",
    source.id,
    1,
    "Robotics",
    "Evidence about robotics.",
    "2026-09-18T01:00:00Z",
  );
  store.put("material", `${material.id}@${material.version}`, material);
  const model = new EditorialFixture();
  const radar = new Radar(store, () => model);
  const topic = radar.saveTopic({
    revision: 0,
    title: "Quantum",
    focus: "",
    sourceIds: [source.id],
    keywords: ["quantum"],
    sources: [],
  });
  assert.throws(
    () => radar.refresh(topic.id),
    /没有符合来源和关键词.*未调用模型/,
  );
  assert.equal(model.calls, 0);
  assert.equal(store.snapshot().radar.jobs.length, 0);
  store.close();
});

test("legacy fixed-material topics remain valid and unchanged by omitted dynamic supply fields", () => {
  const { store, radar, topic } = setup();
  const unchanged = radar.saveTopic({
    id: topic.id,
    revision: topic.revision,
    title: topic.title,
    focus: topic.focus,
    sources: topic.sources,
  });
  assert.equal(unchanged.revision, topic.revision);
  assert.equal(unchanged.sourceIds, undefined);
  assert.equal(unchanged.keywords, undefined);
  store.close();
});

test("topic archival preserves history, checks revision, and prevents new radar work", () => {
  const { store, radar, topic, model } = setup();
  const archived = radar.archiveTopic(topic.id, topic.revision, true);
  assert.equal(archived.archived, true);
  assert.equal(archived.revision, topic.revision + 1);
  assert.throws(
    () => radar.archiveTopic(topic.id, topic.revision, false),
    /已变化/,
  );
  assert.throws(() => radar.refresh(topic.id), /已归档/);
  assert.equal(model.calls, 0);
  assert.equal(store.snapshot().radar.topics.length, 1);
  const restored = radar.archiveTopic(topic.id, archived.revision, false);
  assert.equal(restored.archived, false);
  assert.equal(restored.revision, archived.revision + 1);
  store.close();
});
test("radar integrates a collection, preserves dedup reasons and exact editions, and skips unchanged input without creating work", async () => {
  const { store, model, radar, topic, first } = setup();
  assert.equal(model.calls, 0);
  assert.equal(
    radar.saveTopic({
      id: topic.id,
      revision: topic.revision,
      title: topic.title,
      focus: topic.focus,
      sources: topic.sources,
    }).revision,
    topic.revision,
  );
  const job = radar.refresh(topic.id);
  assert.equal(radar.refresh(topic.id).id, job.id);
  await radar.settled(job.id);
  const original = store.snapshot().radar.editions[0];
  assert.equal(original.sources[1].duplicateOf, "S1");
  assert.equal(original.insight.sections[0].sources.length, 2);
  assert.equal(store.snapshot().works.length, 0);
  assert.equal(store.snapshot().runs.length, 0);
  assert.equal(radar.refresh(topic.id).id, job.id);
  assert.equal(model.calls, 1);
  const ref = radar.reference(original.id);
  assert.equal(store.material(ref).provenance?.refs.length, 2);
  store.put("material", `${first.id}@2`, {
    ...first,
    version: 2,
    body: "新证据改变了条件，而不是证明原假设已完成。",
  });
  const next = radar.refresh(topic.id);
  await radar.settled(next.id);
  const editions = store.snapshot().radar.editions;
  assert.equal(editions.length, 2);
  assert.equal(editions[1].previousId, original.id);
  assert.equal(editions[1].sources[0].reference.version, 2);
  assert.equal(original.sources[0].reference.version, 1);
  assert.equal(store.material(ref).version, 1);
  assert.equal(
    JSON.parse(model.prompts[1].messages[1].content).previous.summary,
    original.insight.summary,
  );
  radar.reading(original.id, { saved: true, read: true, scroll: 410 });
  assert.equal(store.snapshot().radar.reading[0].scroll, 410);
  assert.equal(model.calls, 2);
  store.close();
});

test("radar ignores undeclared top-level model metadata while retaining strict declared-field validation", async () => {
  const { store, model, radar, topic } = setup();
  model.extraMetadata = true;
  const job = radar.refresh(topic.id);
  await radar.settled(job.id);
  assert.equal(
    store.require<RadarJob>("radar-job", job.id).status,
    "succeeded",
  );
  const edition = store.snapshot().radar.editions[0];
  assert.equal(edition.insight.sections.length, 1);
  assert.equal("sections_count" in edition.insight, false);
  store.close();
});
test("radar corrections are scoped to a topic; excluded text is not transmitted and cannot be cited", async () => {
  const { store, model, radar, topic, second } = setup();
  const current = radar.saveTopic({
    id: topic.id,
    revision: topic.revision,
    title: topic.title,
    focus: topic.focus,
    sources: topic.sources.map((s) =>
      s.materialId === second.id
        ? { ...s, policy: "exclude", reason: "不属于本议题" }
        : s,
    ),
  });
  // Passing a persisted topic through the renderer sends only editable fields.
  const job = radar.refresh(current.id);
  await radar.settled(job.id);
  const request = JSON.parse(model.prompts[0].messages[1].content);
  assert.equal(request.sources[2].body, "");
  assert.equal(store.snapshot().radar.editions[0].sources[2].policy, "exclude");
  model.corrupt = true;
  const edited = radar.saveTopic({
    id: current.id,
    revision: current.revision,
    title: current.title,
    focus: "再次核查",
    sources: current.sources,
  });
  const broken = radar.refresh(edited.id);
  await radar.settled(broken.id);
  assert.equal(
    store.require<RadarJob>("radar-job", broken.id).status,
    "failed",
  );
  assert.equal(store.snapshot().radar.editions.length, 1);
  assert.equal(store.get("material", `${second.id}@1`) !== undefined, true);
  store.close();
});
test("no-new-understanding checks retain previous edition rather than generating another article", async () => {
  const { store, model, radar, topic, second } = setup();
  const first = radar.refresh(topic.id);
  await radar.settled(first.id);
  const old = store.snapshot().radar.editions[0];
  store.put("material", `${second.id}@2`, {
    ...second,
    version: 2,
    body: "补充材料没有改变原判断。",
  });
  model.noChange = true;
  const next = radar.refresh(topic.id);
  await radar.settled(next.id);
  assert.equal(
    store.require<RadarJob>("radar-job", next.id).status,
    "succeeded",
  );
  assert.equal(store.snapshot().radar.editions.length, 1);
  assert.equal(store.snapshot().radar.editions[0].id, old.id);
  store.close();
});
test("interrupted radar jobs reopen without replay and reconcile only with their original service", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ytriple-radar-"));
  try {
    const { store, model, radar, topic } = setup(new Store(join(dir, "db")));
    model.interrupt = true;
    const job = radar.refresh(topic.id);
    await radar.settled(job.id);
    assert.equal(
      store.require<RadarJob>("radar-job", job.id).status,
      "unknown",
    );
    store.close();
    const reopened = new Store(join(dir, "db"));
    const other = new EditorialFixture();
    other.scope = "fixture-b";
    const wrong = new Radar(reopened, () => other);
    wrong.recover();
    await assert.rejects(wrong.reconcile(job.id), /原服务/);
    assert.equal(other.lookups, 0);
    assert.throws(() => wrong.assertCanChangeProvider(other.scope));
    const resumed = new Radar(reopened, () => model);
    assert.equal(resumed.refresh(topic.id).id, job.id);
    assert.equal(model.calls, 1);
    await resumed.reconcile(job.id);
    await resumed.reconcile(job.id);
    assert.equal(model.calls, 1);
    assert.equal(model.lookups, 1);
    assert.equal(reopened.snapshot().radar.editions.length, 1);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});
test("invalid topic versions and oversized or failed material stop before starting a model request", () => {
  const { store, model, radar, topic, first } = setup();
  assert.throws(
    () =>
      radar.saveTopic({
        id: topic.id,
        revision: 0,
        title: topic.title,
        focus: "",
        sources: topic.sources,
      }),
    /已变化/,
  );
  store.put("material", `${first.id}@1`, { ...first, readError: "读取失败" });
  assert.throws(() => radar.refresh(topic.id), /尚未就绪/);
  assert.equal(model.calls, 0);
  store.put("material", `${first.id}@1`, {
    ...first,
    body: "文".repeat(40000),
  });
  assert.throws(() => radar.refresh(topic.id), /超过模型输入范围/);
  assert.equal(store.snapshot().radar.jobs.length, 0);
  assert.equal(model.calls, 0);
  store.close();
});

test("explicitly retaining a duplicate keeps its text but never removes the duplicate provenance", async () => {
  const { store, model, radar, topic, duplicate } = setup();
  const edited = radar.saveTopic({
    id: topic.id,
    revision: topic.revision,
    title: topic.title,
    focus: topic.focus,
    sources: topic.sources.map((s) =>
      s.materialId === duplicate.id
        ? { ...s, policy: "keep", reason: "保留转载的措辞作对照" }
        : s,
    ),
  });
  const job = radar.refresh(edited.id);
  await radar.settled(job.id);
  const sent = JSON.parse(model.prompts[0].messages[1].content).sources[1];
  assert.equal(sent.policy, "keep");
  assert.equal(sent.duplicateOf, "S1");
  assert.ok(sent.body.length > 80);
  assert.equal(store.snapshot().radar.editions[0].sources[1].duplicateOf, "S1");
  store.close();
});

test("radar recovers a lost first event through read-only key lookup using the actual ycore result envelope", async () => {
  const { store, radar, model, topic } = setup();
  model.interrupt = true;
  model.protocolError = true;
  const job = radar.refresh(topic.id);
  await radar.settled(job.id);
  const remoteId = randomUUID();
  const requests: { url: string; method: string }[] = [];
  const service = new YCore("http://127.0.0.1:4318", "fixture-only", (async (
    url,
    init,
  ) => {
    requests.push({ url: String(url), method: init?.method ?? "GET" });
    return new Response(
      JSON.stringify({
        id: remoteId,
        status: "succeeded",
        result: { text: model.output },
        error: null,
      }),
      {
        headers: {
          "X-YCore-Contract": "0.1.0",
          "Content-Type": "application/json",
        },
      },
    );
  }) as typeof fetch);
  store.put("radar-job", job.id, {
    ...store.require<RadarJob>("radar-job", job.id),
    remoteId: null,
    serviceScope: service.scope,
  });
  const recovered = new Radar(store, () => service);
  await recovered.reconcile(job.id);
  await recovered.reconcile(job.id);
  assert.deepEqual(requests, [
    { url: `http://127.0.0.1:4318/v1/ai/runs/by-key/${job.id}`, method: "GET" },
  ]);
  assert.equal(store.require<RadarJob>("radar-job", job.id).remoteId, remoteId);
  assert.equal(store.snapshot().radar.editions.length, 1);
  assert.equal(model.calls, 1);
  assert.equal(store.snapshot().runs.length, 0);
  store.close();
});

test("missing or uncertain original radar runs never start replacement calls or discard partial output", async () => {
  const { store, radar, model, topic } = setup();
  model.interrupt = true;
  const job = radar.refresh(topic.id);
  await radar.settled(job.id);
  const original = store.require<RadarJob>("radar-job", job.id);
  store.put("radar-job", job.id, { ...original, remoteId: null });
  let mode = "missing";
  let keyQueries = 0;
  const remoteId = randomUUID();
  const recovery: Model = {
    scope: model.scope,
    stream: model.stream.bind(model),
    lookupByKey: async (key) => {
      assert.equal(key, job.id);
      keyQueries++;
      if (mode === "missing")
        throw new ServiceError("NOT_FOUND", "Run not found");
      return { id: remoteId, status: "unknown", result: null, error: null };
    },
  };
  const recovered = new Radar(store, () => recovery);
  await assert.rejects(recovered.reconcile(job.id), /not found/);
  assert.equal(
    store.require<RadarJob>("radar-job", job.id).body,
    original.body,
  );
  assert.equal(recovered.refresh(topic.id, true).id, job.id);
  mode = "unknown";
  await recovered.reconcile(job.id);
  assert.equal(store.require<RadarJob>("radar-job", job.id).status, "unknown");
  assert.equal(store.require<RadarJob>("radar-job", job.id).remoteId, remoteId);
  assert.equal(store.snapshot().radar.editions.length, 0);
  assert.equal(keyQueries, 2);
  assert.equal(model.calls, 1);
  store.close();
});

test("radar keeps execution-lost and provider-unknown terminal events recoverable", async () => {
  for (const code of ["EXECUTION_LOST", "PROVIDER_ERROR"] as const) {
    const { store, radar, model, topic } = setup();
    model.terminalError = code;
    const job = radar.refresh(topic.id);
    await radar.settled(job.id);
    assert.equal(
      store.require<RadarJob>("radar-job", job.id).status,
      "unknown",
    );
    await radar.reconcile(job.id);
    assert.equal(
      store.require<RadarJob>("radar-job", job.id).status,
      "succeeded",
    );
    assert.equal(model.calls, 1);
    assert.equal(model.lookups, 1);
    store.close();
  }
});
