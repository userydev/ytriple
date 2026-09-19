import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/store";
import { Radar } from "../src/core/radar";
import type { Material } from "../src/core/types";
import type { RadarEdition, RadarTopic } from "../src/core/radar-contract";
import {
  ORGANIZE_FAILED,
  ORGANIZE_UNAVAILABLE,
  canSplitReader,
  decisionWindowState,
  editionCardMeta,
  editionFeed,
  organizeRadarTopic,
  readerTeamWidths,
} from "../src/core/radar-workbench";
import type { Model, Prompt, StreamEvent } from "../src/core/ycore";

const topic = (id: string, title: string): RadarTopic => ({
  id,
  revision: 1,
  title,
  focus: "只关心已同步材料中的家庭助手",
  sources: [],
  sourceIds: ["src-1"],
  updatedAt: "2026-09-18T00:00:00Z",
});

const edition = (
  id: string,
  topicId: string,
  number: number,
  processing?: RadarEdition["processing"],
): RadarEdition => ({
  id,
  topicId,
  topicRevision: 1,
  number,
  previousId: number > 1 ? "ed-old" : null,
  jobId: "job",
  createdAt: `2026-09-18T0${number}:00:00Z`,
  insight: {
    changed: true,
    title: "具体发现而不是话题名",
    summary: "根据已读材料可以确认的内容。",
    sections: [
      { heading: "发现", body: "正文", sources: ["S1"] },
    ],
    changes: number > 1 ? ["新增一条证据"] : [],
    limitations: ["未读全文"],
    screening: [{ source: "S1", keep: true, reason: "相关" }],
  },
  sources: [
    {
      key: "S1",
      reference: { materialId: "m1", version: 1, label: "源" },
      title: "源",
      coverage: "summary",
      policy: "auto",
      reason: "",
      body: "source summary",
    },
  ],
  materialId: `radar:${topicId}`,
  processing,
});

test("default feed is latest edition per topic and does not mix source rows", () => {
  const data = {
    radar: {
      topics: [topic("t1", "家庭AI助手"), topic("t2", "开源")],
      editions: [
        edition("e1", "t1", 1),
        edition("e2", "t1", 2, {
          kind: "ycore-neutral",
          processorVersion: "neutral-brief-v1+gemini-3.8-flash",
        }),
        edition("e3", "t2", 1),
      ],
      jobs: [],
      watches: [],
      checks: [],
      reading: [{ id: "e1", saved: true, read: true, scroll: 0 }],
      view: undefined,
    },
  };
  const latest = editionFeed(data, "all", null);
  assert.deepEqual(
    latest.map((item) => item.id),
    ["e2", "e3"],
  );
  assert.equal(latest.some((item) => item.id === "e1"), false);
  const meta = editionCardMeta(data, latest.find((item) => item.id === "e2")!);
  assert.equal(meta.legacy, false);
  assert.match(meta.footer, /1 份摘要/);
  assert.equal(meta.footer.includes("依据"), false);
  assert.equal(editionCardMeta(data, edition("e1", "t1", 1)).legacy, true);
  assert.equal(editionFeed(data, "saved", null)[0].id, "e1");
});

test("reader split requires readable text plus a 420px team column", () => {
  assert.equal(canSplitReader(1256), true);
  assert.equal(canSplitReader(900), false);
  const wide = readerTeamWidths(1256);
  assert.equal(wide.split, true);
  assert.ok(wide.team >= 420);
  assert.ok(wide.reader >= 520);
});

test("decision window state is the same work, run, draft, version and decision", () => {
  const state = decisionWindowState(
    {
      works: [{ id: "w1", title: "研究", archived: false } as never],
      messages: [
        {
          id: "m1",
          workId: "w1",
          runId: "r1",
          role: "user",
          body: "完整提问",
          refs: [],
          createdAt: "",
        },
      ],
      runs: [
        { id: "r1", workId: "w1", status: "succeeded" } as never,
      ],
      versions: [
        { id: "v1", workId: "w1", body: "完整成果正文" } as never,
      ],
      decisions: [
        { id: "d1", workId: "w1", status: "pending", question: "选方向" } as never,
      ],
      contributions: [
        {
          id: "c1",
          workId: "w1",
          runId: "r1",
          memberName: "研究员",
          objective: "分析",
          body: "公开结论",
        } as never,
      ],
      drafts: [{ id: "w1", text: "草稿仍在" } as never],
    },
    "w1",
    "v1",
  );
  assert.equal(state.work?.id, "w1");
  assert.equal(state.currentVersion?.body, "完整成果正文");
  assert.equal(state.decision?.question, "选方向");
  assert.equal(state.draft?.text, "草稿仍在");
  assert.equal(state.events[0].body, "公开结论");
});

test("decision window events stay on the exact work and run", () => {
  const foreign = {
    id: "c-other",
    workId: "w2",
    runId: "r2",
    memberName: "研究员",
    objective: "别的工作",
    body: "不该出现在新阅读窗",
  } as never;
  const inspect = {
    id: "c-tool",
    workId: "w1",
    runId: "r1",
    memberName: "研究员",
    objective: "inspect",
    body: '{"mode":"inspect","builtin.workspace":true}',
    tool: { request: { key: "builtin.workspace" } },
  } as never;
  const own = {
    id: "c1",
    workId: "w1",
    runId: "r1",
    memberName: "研究员",
    objective: "分析",
    body: "公开结论",
  } as never;
  const snapshot = {
    works: [
      { id: "w1", title: "A", archived: false },
      { id: "w2", title: "B", archived: false },
    ] as never[],
    messages: [],
    runs: [
      { id: "r1", workId: "w1", status: "succeeded" },
      { id: "r2", workId: "w2", status: "succeeded" },
    ] as never[],
    versions: [],
    decisions: [],
    contributions: [foreign, inspect, own],
    drafts: [],
  };
  const empty = decisionWindowState(snapshot, "new:radar:edition");
  assert.equal(empty.work, null);
  assert.equal(empty.events.length, 0);
  const a = decisionWindowState(snapshot, "w1");
  assert.deepEqual(
    a.events.map((item) => item.id),
    ["c1"],
  );
  const b = decisionWindowState(snapshot, "w2");
  assert.deepEqual(
    b.events.map((item) => item.id),
    ["c-other"],
  );
});

test("organize processes at most five new public items and skips title-only", () => {
  const store = new Store(":memory:");
  const radar = new Radar(store, () => ({}) as Model);
  store.put("meta", "sources", [{ id: "src-1", name: "RSS", status: "active" }]);
  store.put("radar-topic", "t1", topic("t1", "家庭AI助手"));
  for (let i = 0; i < 7; i++) {
    const material: Material = {
      id: `ycore:scope:doc-${i}`,
      version: 1,
      title: i === 0 ? "Only headline" : `Article ${i}`,
      body: i === 0 ? "" : `body evidence ${i} `.repeat(20),
      coverage: i === 0 ? "title_only" : "summary",
      url: `https://example.org/${i}`,
      createdAt: `2026-09-18T0${i}:00:00Z`,
      upstream: {
        scope: "scope",
        id: `doc-${i}`,
        revision: 1,
        publisher: "Pub",
        publishedAt: `2026-09-18T0${i}:00:00Z`,
        discoveredAt: `2026-09-18T0${i}:00:00Z`,
        updatedAt: `2026-09-18T0${i}:00:00Z`,
        topics: [],
        provenance: [
          {
            sourceId: "src-1",
            adapter: "rss",
            upstreamId: String(i),
            discoveredAt: `2026-09-18T0${i}:00:00Z`,
            rawRef: String(i),
          },
        ],
        contentHash: `h${i}`,
        fullArticle: false,
      },
    };
    store.put("material", `${material.id}@1`, material);
  }
  const eligible = radar.eligiblePublicProcessing(
    "t1",
    "neutral-brief-v1+gemini-3.8-flash",
  );
  assert.equal(eligible.length, 5);
  assert.equal(
    eligible.some((item) => item.coverage === "title_only"),
    false,
  );
  radar.associateDerived([
    {
      document_id: eligible[0].upstream!.id,
      revision: 1,
      processor_version: "neutral-brief-v1+gemini-3.8-flash",
      status: "ready",
      title_zh: "中性标题",
      digest: "digest",
      keypoints: [{ text: "k", quote: "body evidence" }],
      coverage: "summary",
      model: "gemini-3.8-flash",
      processed_at: "2026-09-18T10:00:00Z",
      content_hash: eligible[0].upstream!.contentHash,
      error: null,
    },
  ]);
  const remaining = radar.eligiblePublicProcessing(
    "t1",
    "neutral-brief-v1+gemini-3.8-flash",
  );
  assert.equal(
    remaining.some((item) => item.id === eligible[0].id),
    false,
  );
  store.close();
});

class SynthesisModel implements Model {
  calls = 0;
  async *stream(
    prompt: Prompt,
    key: string,
  ): AsyncGenerator<StreamEvent> {
    this.calls++;
    const input = JSON.parse(prompt.messages[1].content);
    const eligible = input.sources.filter(
      (source: { policy: string; duplicateOf?: string }) =>
        source.policy !== "exclude" &&
        (!source.duplicateOf || source.policy === "keep"),
    );
    const insight = {
      changed: true,
      title: "整理后的发现",
      summary: "只使用已完成中性整理的公开材料。",
      sections: [
        {
          heading: "认识",
          body: "有依据的整理。",
          sources: eligible.map((source: { id: string }) => source.id),
        },
      ],
      changes: [],
      limitations: ["未读全文"],
      screening: eligible.map((source: { id: string }) => ({
        source: source.id,
        keep: true,
        reason: "相关",
      })),
    };
    yield { type: "run.started", run_id: key };
    yield { type: "text.delta", run_id: key, text: JSON.stringify(insight) };
    yield { type: "run.completed", run_id: key };
  }
}

function seedPublic(store: Store, count = 7) {
  store.put("meta", "sources", [{ id: "src-1", name: "RSS", status: "active" }]);
  store.put("radar-topic", "t1", topic("t1", "家庭AI助手"));
  const materials: Material[] = [];
  for (let i = 0; i < count; i++) {
    const material: Material = {
      id: `ycore:scope:doc-${i}`,
      version: 1,
      title: i === 0 ? "Only headline" : `Article ${i}`,
      body: i === 0 ? "" : `body evidence ${i} `.repeat(20),
      coverage: i === 0 ? "title_only" : "summary",
      url: `https://example.org/${i}`,
      createdAt: `2026-09-18T0${i}:00:00Z`,
      upstream: {
        scope: "scope",
        id: `doc-${i}`,
        revision: 1,
        publisher: "Pub",
        publishedAt: `2026-09-18T0${i}:00:00Z`,
        discoveredAt: `2026-09-18T0${i}:00:00Z`,
        updatedAt: `2026-09-18T0${i}:00:00Z`,
        topics: [],
        provenance: [
          {
            sourceId: "src-1",
            adapter: "rss",
            upstreamId: String(i),
            discoveredAt: `2026-09-18T0${i}:00:00Z`,
            rawRef: String(i),
          },
        ],
        contentHash: `h${i}`,
        fullArticle: false,
      },
    };
    store.put("material", `${material.id}@1`, material);
    materials.push(material);
  }
  return materials;
}

function readyRecord(material: Material) {
  return {
    document_id: material.upstream!.id,
    revision: 1,
    processor_version: "neutral-brief-v1+gemini-3.8-flash",
    status: "ready" as const,
    title_zh: material.title,
    digest: material.body.slice(0, 40),
    keypoints: [{ text: "要点", quote: material.body.slice(0, 20) }],
    coverage: "summary",
    model: "gemini-3.8-flash",
    processed_at: "2026-09-18T10:00:00Z",
    content_hash: material.upstream!.contentHash,
    error: null,
  };
}

test("organize stops when processing is unavailable and does not synthesize", async () => {
  const store = new Store(":memory:");
  const model = new SynthesisModel();
  const radar = new Radar(store, () => model);
  seedPublic(store);
  store.put("radar-edition", "old", edition("old", "t1", 1));
  await assert.rejects(
    () => organizeRadarTopic(radar, "t1", null),
    (error: Error) => error.message === ORGANIZE_UNAVAILABLE,
  );
  await assert.rejects(
    () =>
      organizeRadarTopic(radar, "t1", {
        capabilities: async () => {
          throw Error("offline");
        },
        process: async () => [],
      }),
    (error: Error) => error.message === ORGANIZE_UNAVAILABLE,
  );
  await assert.rejects(
    () =>
      organizeRadarTopic(radar, "t1", {
        capabilities: async () => ({ available: false, processor_version: null }),
        process: async () => [],
      }),
    (error: Error) => error.message === ORGANIZE_UNAVAILABLE,
  );
  assert.equal(model.calls, 0);
  assert.equal(store.get<RadarEdition>("radar-edition", "old")?.id, "old");
  assert.equal(store.all<RadarEdition>("radar-edition").length, 1);
  store.close();
});

test("failed organize batch keeps the previous edition and does not fall back to raw synthesis", async () => {
  const store = new Store(":memory:");
  const model = new SynthesisModel();
  const radar = new Radar(store, () => model);
  seedPublic(store);
  store.put("radar-edition", "old", edition("old", "t1", 1));
  await assert.rejects(
    () =>
      organizeRadarTopic(radar, "t1", {
        capabilities: async () => ({
          available: true,
          processor_version: "neutral-brief-v1+gemini-3.8-flash",
        }),
        process: async (items) =>
          items.map((item) => ({
            document_id: item.id,
            revision: item.revision,
            processor_version: "neutral-brief-v1+gemini-3.8-flash",
            status: "failed" as const,
            title_zh: null,
            digest: null,
            keypoints: [],
            coverage: "summary",
            model: "gemini-3.8-flash",
            processed_at: "2026-09-18T10:00:00Z",
            content_hash: "h",
            error: { code: "INVALID_OUTPUT", message: "bad" },
          })),
      }),
    (error: Error) => error.message === ORGANIZE_FAILED,
  );
  assert.equal(model.calls, 0);
  assert.equal(store.all<RadarEdition>("radar-edition").length, 1);
  store.close();
});

test("organize synthesizes only the processed batch, not remaining unprocessed public items", async () => {
  const store = new Store(":memory:");
  const model = new SynthesisModel();
  const radar = new Radar(store, () => model);
  const materials = seedPublic(store);
  let requested: string[] = [];
  const job = await organizeRadarTopic(radar, "t1", {
    capabilities: async () => ({
      available: true,
      processor_version: "neutral-brief-v1+gemini-3.8-flash",
    }),
    process: async (items) => {
      requested = items.map((item) => item.id);
      return items.map((item) =>
        readyRecord(materials.find((material) => material.upstream!.id === item.id)!),
      );
    },
  });
  await radar.settled(job.id);
  assert.equal(requested.length, 5);
  assert.equal(requested.includes("doc-1"), false);
  assert.equal(model.calls, 1);
  const created = store.all<RadarEdition>("radar-edition").at(-1)!;
  const ids = created.sources.map((source) => source.reference.materialId);
  assert.equal(ids.includes("ycore:scope:doc-1"), false);
  assert.equal(ids.includes("ycore:scope:doc-0"), true);
  for (const id of requested)
    assert.equal(ids.includes(`ycore:scope:${id}`), true);
  store.close();
});
