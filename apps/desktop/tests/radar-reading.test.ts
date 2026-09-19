import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../src/core/store";
import {
  defaultResearchText,
  continueRadarResearch,
  developmentTraceText,
  draftIdForObject,
  followPlanText,
  followTopicInput,
  groupedTopicContents,
  keywordsForFollowTitle,
  materialResearchDraftId,
  radarResearchShows,
  textMatchesKeyword,
  latestTopicEditions,
  mergeResearchRefs,
  boundedResearchRefs,
  relatedMaterialsForArticle,
  relatedMaterialsForEdition,
  researchRefsForEdition,
  researchRefsForMaterial,
  resolveFollowTitle,
  storeReadingObject,
  recallReadingObject,
  topicEditionHistory,
  topicListedMaterials,
  visibleRadarEditions,
  worksCitingReferences,
} from "../src/core/radar-reading";
import type { RadarTopic } from "../src/core/radar-contract";
import type { RadarEdition } from "../src/core/radar-contract";
import type { Message, Run, Snapshot, Work } from "../src/core/types";

function edition(
  topicId: string,
  number: number,
  createdAt: string,
  extras: Partial<RadarEdition> = {},
): RadarEdition {
  const id = extras.id ?? randomUUID();
  const materialId = extras.materialId ?? randomUUID();
  const sourceId = randomUUID();
  return {
    id,
    topicId,
    topicRevision: 1,
    number,
    previousId: null,
    jobId: randomUUID(),
    createdAt,
    materialId,
    insight: {
      changed: number > 1,
      title: `认识 ${number}`,
      summary: `议题理解 ${number}`,
      sections: [
        {
          heading: "认识",
          body: "根据已读材料整理。",
          sources: ["S1"],
        },
      ],
      changes: number > 1 ? [`相对 v${number - 1} 的变化`] : [],
      limitations: ["仅有来源摘要"],
      screening: [{ source: "S1", keep: true, reason: "相关" }],
    },
    sources: [
      {
        key: "S1",
        reference: { materialId: sourceId, version: 1, label: "来源" },
        title: "来源文章",
        coverage: "summary",
        policy: "auto",
        reason: "",
        body: "摘要正文",
      },
    ],
    ...extras,
  };
}

test("same-topic list defaults to the latest edition while saved history remains addressable", () => {
  const topicId = randomUUID();
  const older = edition(topicId, 1, "2026-09-01T00:00:00.000Z");
  const newer = edition(topicId, 2, "2026-09-18T00:00:00.000Z");
  const other = edition(randomUUID(), 1, "2026-09-10T00:00:00.000Z");
  const data = {
    radar: {
      editions: [older, newer, other],
      reading: [{ id: older.id, saved: true, read: true, scroll: 12 }],
      topics: [],
      jobs: [],
      watches: [],
      checks: [],
    },
  } as Pick<Snapshot, "radar">;
  const latest = latestTopicEditions(data.radar.editions);
  assert.deepEqual(
    latest.map((item) => item.id).sort(),
    [newer.id, other.id].sort(),
  );
  assert.equal(
    visibleRadarEditions(data).every((item) => item.id !== older.id),
    true,
  );
  const saved = visibleRadarEditions(data, { savedOnly: true });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, older.id);
  assert.equal(saved[0].number, 1);
});

test("article research keeps exact edition and source versions and reuses the citing work", () => {
  const older = edition(randomUUID(), 1, "2026-09-01T00:00:00.000Z");
  const newer = edition(older.topicId, 2, "2026-09-18T00:00:00.000Z", {
    sources: older.sources.map((source) => ({
      ...source,
      reference: { ...source.reference, version: 2 },
    })),
  });
  const refs = researchRefsForEdition(older);
  assert.equal(refs[0].materialId, older.materialId);
  assert.equal(refs[0].version, 1);
  assert.equal(refs[1].version, 1);
  assert.ok(!refs.some((item) => item.version === 2));
  const unrelated = { materialId: randomUUID(), version: 9, label: "私有笔记" };
  const merged = mergeResearchRefs([unrelated], researchRefsForEdition(older));
  assert.equal(merged[0].materialId, unrelated.materialId);
  assert.ok(merged.some((item) => item.materialId === older.materialId && item.version === 1));
  const restored = mergeResearchRefs(merged, researchRefsForEdition(newer));
  assert.ok(restored.some((item) => item.materialId === older.materialId && item.version === 1));
  assert.ok(!restored.some((item) => item.materialId === older.materialId && item.version === 2));

  const workId = randomUUID();
  const data = {
    works: [
      {
        id: workId,
        title: "研究旧版解读",
        projectId: null,
        deliveryId: null,
        createdAt: older.createdAt,
        updatedAt: older.createdAt,
        archived: false,
        queuePaused: false,
      } satisfies Work,
    ],
    messages: [
      {
        id: randomUUID(),
        workId,
        runId: randomUUID(),
        role: "user",
        body: "研究这篇",
        refs: [{ materialId: older.materialId, version: 1, label: older.insight.title }],
        createdAt: older.createdAt,
      } satisfies Message,
    ],
    runs: [] as Run[],
  };
  const related = worksCitingReferences(data, researchRefsForEdition(older));
  assert.equal(related.length, 1);
  assert.equal(related[0].id, workId);
  assert.equal(worksCitingReferences(data, researchRefsForEdition(newer)).length, 0);
  assert.equal(
    worksCitingReferences(data, researchRefsForEdition(older), randomUUID())
      .length,
    0,
  );
  const bound = {
    ...data,
    works: [
      {
        ...data.works[0],
        workspaceContext: {
          kind: "radar-topic" as const,
          id: older.topicId,
          revision: 1,
        },
      },
    ],
  };
  assert.equal(
    worksCitingReferences(bound, researchRefsForEdition(older), older.topicId)
      .length,
    1,
  );

  const material = {
    id: older.sources[0].reference.materialId,
    version: 1,
    title: "来源文章",
    body: "摘要正文",
    coverage: "summary",
    createdAt: older.createdAt,
  };
  const materialRefs = researchRefsForMaterial(material);
  assert.deepEqual(materialRefs, [
    { materialId: material.id, version: 1, label: material.title },
  ]);
  const text = defaultResearchText({
    title: older.insight.title,
    coverage: "radar",
    topic: { title: "持续议题", focus: "工具变化", revision: 3 },
    version: 1,
    sources: [
      {
        title: "来源文章",
        url: "https://example.com/item",
        coverage: "summary",
        version: 1,
      },
    ],
  });
  assert.equal(text, "");
});

test("research draft identity restores user text and does not inherit unrelated materials", () => {
  const store = new Store(":memory:");
  try {
    const editionId = randomUUID();
    const draftId = `new:radar:${editionId}`;
    const first = store.addMaterial("授权来源", "摘要", "summary");
    const privateNote = store.addMaterial("无关笔记", "私人内容", "local_text");
    store.saveDraft({
      id: draftId,
      text: "继续核对这篇旧版的限制",
      refs: [{ materialId: first.id, version: 1, label: first.title }],
      recipient: null,
      projectId: null,
    });
    const existing = store.get<import("../src/core/types").Draft>("draft", draftId)!;
    const merged = mergeResearchRefs(existing.refs, [
      { materialId: first.id, version: 1, label: first.title },
      { materialId: randomUUID(), version: 1, label: "解读" },
    ]);
    assert.equal(existing.text, "继续核对这篇旧版的限制");
    assert.ok(!merged.some((item) => item.materialId === privateNote.id));
    assert.equal(merged.filter((item) => item.materialId === first.id).length, 1);
  } finally {
    store.close();
  }
});

test("research followups retain the explicit version and respect removing the reference", () => {
  const store = new Store(":memory:");
  try {
    const material = store.addMaterial("文章", "原节选", "feed_excerpt");
    const refs = researchRefsForMaterial(material);
    const firstContext = `new:radar:${material.id}@1`;
    const send = (context: string, selected: typeof refs, text: string) => {
      store.saveDraft({ id: context, text, refs: selected, recipient: null, projectId: null });
      return store.submit({ key: randomUUID(), context, text, refs: selected, recipient: null, projectId: null });
    };
    const first = send(firstContext, refs, "研究这篇");
    store.put("material", `${material.id}@2`, { ...material, version: 2, body: "新正文" });
    const continuation = store.get<import("../src/core/types").Draft>("draft", first.workId)!;
    assert.deepEqual(continuation.refs, refs);
    assert.equal(continuation.text, "");
    const second = send(first.workId, continuation.refs, "继续核对依据");
    assert.equal(second.workId, first.workId);
    assert.equal(second.refs[0].version, 1);
    assert.equal(store.all("work").length, 1);
    send(first.workId, [], "不使用这份材料");
    assert.deepEqual(store.get<import("../src/core/types").Draft>("draft", first.workId)!.refs, []);
  } finally {
    store.close();
  }
});

function topic(
  title: string,
  extras: Partial<RadarTopic> = {},
): RadarTopic {
  return {
    id: extras.id ?? randomUUID(),
    revision: extras.revision ?? 1,
    title,
    focus: extras.focus ?? "",
    sources: extras.sources ?? [],
    updatedAt: extras.updatedAt ?? "2026-09-18T00:00:00.000Z",
    ...extras,
  };
}

test("light follow reuses an active same-name topic and does not restore archived names", () => {
  const live = topic("人工智能", { updatedAt: "2026-09-18T02:00:00.000Z" });
  const older = topic("人工智能", { updatedAt: "2026-09-10T00:00:00.000Z" });
  const archived = topic("人工智能", {
    archived: true,
    updatedAt: "2026-09-19T00:00:00.000Z",
  });
  const located = resolveFollowTitle([archived, older, live], "人工智能");
  assert.equal(located.kind, "active");
  if (located.kind === "active") assert.equal(located.topic.id, live.id);
  const onlyArchived = resolveFollowTitle([archived], "人工智能");
  assert.equal(onlyArchived.kind, "archived");
  if (onlyArchived.kind === "archived")
    assert.equal(onlyArchived.topic.id, archived.id);
  assert.equal(resolveFollowTitle([], "新方向").kind, "new");
});

test("latin keywords use word boundaries and preset aliases stay literal", () => {
  assert.equal(textMatchesKeyword("They said it failed in Spain", "AI"), false);
  assert.equal(textMatchesKeyword("Graph Sandwich recipe", "AI"), false);
  assert.equal(textMatchesKeyword("OpenAI released a model", "AI"), false);
  assert.equal(textMatchesKeyword("OpenAI released a model", "OpenAI"), true);
  assert.equal(textMatchesKeyword("An AI model shipped", "AI"), true);
  assert.equal(textMatchesKeyword("人工智能进展", "人工智能"), true);
  assert.equal(textMatchesKeyword("we love open source tools", "open source"), true);
  assert.equal(textMatchesKeyword("An agent product launched", "agent"), true);
});

test("preset follow keywords use local aliases while custom names stay literal", () => {
  assert.deepEqual(keywordsForFollowTitle("人工智能"), [
    "人工智能",
    "AI",
    "OpenAI",
    "大模型",
  ]);
  assert.ok(keywordsForFollowTitle("开源软件").includes("open source"));
  assert.match(followPlanText("人工智能"), /关注「人工智能」/);
  assert.match(followPlanText("  "), /完善一个关注范围/);
  assert.deepEqual(keywordsForFollowTitle(" 量子计算 "), ["量子计算"]);
  const input = followTopicInput("量子计算", ["src-1", "src-2"], {
    literalText: true,
  });
  assert.equal(input.title, "量子计算");
  assert.deepEqual(input.keywords, ["量子计算"]);
  assert.deepEqual(input.sourceIds, ["src-1", "src-2"]);
  assert.deepEqual(input.sources, []);
  assert.equal(input.focus, "");
  const empty = followTopicInput("待定方向", []);
  assert.equal(empty.sourceIds, undefined);
  assert.equal(empty.keywords, undefined);
  assert.deepEqual(empty.sources, []);
});

test("related materials require a shared edition or topic, not the same publisher", () => {
  const topicId = randomUUID();
  const cited = edition(topicId, 2, "2026-09-18T00:00:00.000Z");
  const citedMaterial = {
    id: cited.sources[0].reference.materialId,
    version: cited.sources[0].reference.version,
    title: cited.sources[0].title,
    body: cited.sources[0].body,
    coverage: "summary",
    createdAt: cited.createdAt,
    url: "https://publisher.example/a",
    upstream: {
      scope: "managed",
      id: "a",
      revision: 1,
      publisher: "Publisher",
      publishedAt: null,
      discoveredAt: cited.createdAt,
      updatedAt: cited.createdAt,
      topics: [],
      provenance: [
        {
          sourceId: "ars",
          adapter: "rss",
          upstreamId: "a",
          discoveredAt: cited.createdAt,
          rawRef: "a",
        },
      ],
      contentHash: "h1",
      fullArticle: false as const,
    },
  };
  const samePublisher = {
    ...citedMaterial,
    id: randomUUID(),
    title: "同一来源站的另一篇",
    url: "https://publisher.example/b",
    upstream: { ...citedMaterial.upstream, id: "b" },
  };
  const topicMaterial = {
    id: randomUUID(),
    version: 1,
    title: "话题内另一份材料",
    body: "另一份",
    coverage: "summary",
    createdAt: cited.createdAt,
  };
  const data = {
    materials: [citedMaterial, samePublisher, topicMaterial],
    radar: {
      topics: [
        topic("工具变化", {
          id: topicId,
          sources: [
            { materialId: topicMaterial.id, policy: "auto", reason: "手选" },
          ],
        }),
      ],
      editions: [cited],
      reading: [],
      jobs: [],
      watches: [],
      checks: [],
    },
  };
  const forEdition = relatedMaterialsForEdition(data, cited);
  assert.equal(forEdition.length, 1);
  assert.match(forEdition[0].reason, /本解读引用/);
  assert.ok(!forEdition.some((item) => item.material.id === samePublisher.id));
  const forArticle = relatedMaterialsForArticle(data, citedMaterial, cited);
  assert.ok(!forArticle.some((item) => item.material.id === samePublisher.id));
  assert.ok(!forArticle.some((item) => item.material.id === topicMaterial.id));
});

test("topic history uses saved edition dates rather than inventing an event timeline", () => {
  const topicId = randomUUID();
  const older = edition(topicId, 1, "2026-09-01T08:00:00.000Z");
  const newer = edition(topicId, 2, "2026-09-18T12:00:00.000Z");
  const history = topicEditionHistory([older, newer], topicId);
  assert.deepEqual(
    history.map((item) => [item.number, item.savedAt]),
    [
      [2, newer.createdAt],
      [1, older.createdAt],
    ],
  );
  assert.equal(history[0].title, newer.insight.title);
});

test("each topic remembers the exact reading object and draft identity stays bound", () => {
  let memory = storeReadingObject({}, "topic-a", {
    kind: "edition",
    id: "e1",
  });
  memory = storeReadingObject(memory, "topic-a", {
    kind: "material",
    id: "m1",
    version: 2,
  });
  memory = storeReadingObject(memory, "topic-b", { kind: "list" });
  assert.deepEqual(recallReadingObject(memory, "topic-a"), {
    kind: "material",
    id: "m1",
    version: 2,
  });
  assert.deepEqual(recallReadingObject(memory, "topic-b"), { kind: "list" });
  assert.deepEqual(recallReadingObject(memory, "topic-c"), { kind: "list" });
  assert.equal(draftIdForObject({ kind: "edition", id: "e1" }), "new:radar:e1");
  assert.equal(
    draftIdForObject({ kind: "material", id: "m1", version: 2 }),
    "new:radar:m:m1@2",
  );
  assert.equal(
    draftIdForObject({ kind: "material", id: "m1", version: 2 }, "topic-a"),
    "new:radar:m:m1@2",
  );
  assert.equal(
    materialResearchDraftId({ id: "m1", version: 2 }, "topic-b"),
    "new:radar:m:m1@2",
  );
  assert.equal(
    materialResearchDraftId({ id: "m1", version: 2 }, "topic-a"),
    materialResearchDraftId({ id: "m1", version: 2 }, "topic-b"),
  );
  assert.equal(draftIdForObject({ kind: "list" }), null);
});

test("radar research anchor survives submit conversion and does not leak across topics", () => {
  const follow = continueRadarResearch(
    {
      kind: "follow",
      contextId: "new:workspace:1",
      topicId: null,
      contentKey: "follow:intent",
    },
    "new:workspace:1",
    "work-1",
  );
  assert.deepEqual(follow, {
    kind: "follow",
    contextId: "work-1",
    topicId: null,
    contentKey: "follow:intent",
  });
  assert.equal(
    radarResearchShows(follow, "work-1", "follow", true, null),
    true,
  );
  assert.equal(
    radarResearchShows(follow, "work-1", "object", false, "other"),
    false,
  );
  const object = {
    kind: "object" as const,
    contextId: "work-2",
    topicId: "topic-a",
    contentKey: "material:a@1",
  };
  assert.equal(
    radarResearchShows(object, "work-2", "object", false, "material:a@1"),
    true,
  );
  assert.equal(
    radarResearchShows(object, "work-2", "object", false, "material:b@1"),
    false,
  );
  assert.equal(
    radarResearchShows(object, "new:radar:x", "object", false, "material:a@1"),
    false,
  );
});

test("development trace prompt uses saved versions and available materials, not invented dates", () => {
  const text = developmentTraceText({
    title: "人工智能",
    editions: [
      {
        number: 2,
        title: "新认识",
        savedAt: "2026-09-18T12:00:00.000Z",
      },
    ],
    materials: [
      { title: "来源文章", coverage: "summary", version: 1 },
    ],
  });
  assert.match(text, /人工智能/);
  assert.match(text, /解读 v2/);
  assert.match(text, /版本保存时间/);
  assert.match(text, /来源文章/);
  assert.doesNotMatch(text, /发生在/);
});

test("content is grouped by topic and empty topics stay empty instead of mixing materials", () => {
  const emptyId = randomUUID();
  const readyId = randomUUID();
  const ready = edition(readyId, 1, "2026-09-18T00:00:00.000Z");
  const data = {
    materials: [
      {
        id: ready.sources[0].reference.materialId,
        version: 1,
        title: "来源文章",
        body: "摘要正文",
        coverage: "summary",
        createdAt: ready.createdAt,
      },
    ],
    radar: {
      topics: [
        topic("已有解读", { id: readyId }),
        topic("尚无材料", { id: emptyId }),
      ],
      editions: [ready],
      reading: [],
      jobs: [],
      watches: [],
      checks: [],
    },
  };
  const all = groupedTopicContents(data, "all");
  assert.equal(all.length, 2);
  const readyGroup = all.find((item) => item.topicId === readyId)!;
  const emptyGroup = all.find((item) => item.topicId === emptyId)!;
  assert.equal(readyGroup.editions[0].id, ready.id);
  assert.equal(emptyGroup.empty, true);
  assert.equal(emptyGroup.editions.length, 0);
  const one = groupedTopicContents(data, { topicId: readyId });
  assert.equal(one.length, 1);
  assert.ok(one[0].materials.some((item) => item.reason.includes("出处")));
  assert.equal(topicListedMaterials(data, data.radar.topics[1]).length, 0);
  data.radar.topics[1].sources = [{ materialId: data.materials[0].id, policy: "auto", reason: "已选材料" }];
  const rawOnly = groupedTopicContents(data, "all").find((item) => item.topicId === emptyId)!;
  assert.equal(rawOnly.empty, false);
  assert.equal(rawOnly.editions.length, 0);
  assert.equal(rawOnly.materials[0].material.id, data.materials[0].id);
});


test("development research respects the host reference limit and preserves chosen versions", () => {
  const chosen = { materialId: "kept", version: 2, label: "用户已选" };
  const required = Array.from({ length: 25 }, (_, i) => ({ materialId: `m${i}`, version: 1, label: `材料${i}` }));
  const result = boundedResearchRefs([chosen], required);
  assert.equal(result.refs.length, 20);
  assert.deepEqual(result.refs[0], chosen);
  assert.equal(result.omitted, 6);
});
