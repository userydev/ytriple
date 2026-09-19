import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../src/core/store";
import { Radar } from "../src/core/radar";
import { WorkspaceActions } from "../src/core/workspace-actions";
import { Schedules } from "../src/core/schedules";
import { RadarWatches } from "../src/core/radar-watches";

import {
  FAMILY_ASSISTANT_RULES,
  canonicalNewsUrl,
  collectNewsItems,
  displayNewsText,
  followIntentKind,
  followTopicInput,
  isNewsMaterial,
  localMatchPreview,
  relatedNewsForArticle,
  resolveRadarView,
  topicMatchesNews,
} from "../src/core/radar-news";
import {
  materialMatchesTopic,
  parseMatchRules,
  previewTopicMatches,
  textMatchesKeyword,
} from "../src/core/radar-match";
import { materialReadingId } from "../src/core/radar-contract";
import type { Material, Source } from "../src/core/types";
import { defaultTeam, adaptiveWorkflow, type Run } from "../src/core/types";
import type { Model } from "../src/core/ycore";

const publicMaterial = (
  localId: string,
  upstreamId: string,
  sourceId: string,
  title: string,
  body: string,
  extras: Partial<Material> = {},
): Material => ({
  id: localId,
  version: extras.version ?? 1,
  title,
  body,
  coverage: extras.coverage ?? "summary",
  url: extras.url ?? `https://publisher.example/${upstreamId}`,
  upstream: extras.upstream ?? {
    scope: "managed",
    id: upstreamId,
    revision: 1,
    publisher: "Publisher",
    publishedAt: "2026-09-18T01:00:00Z",
    discoveredAt: "2026-09-18T01:00:00Z",
    updatedAt: "2026-09-18T01:00:00Z",
    topics: [],
    provenance: [
      {
        sourceId,
        adapter: "rss",
        upstreamId,
        discoveredAt: "2026-09-18T01:00:00Z",
        rawRef: upstreamId,
      },
    ],
    contentHash: upstreamId,
    fullArticle: false,
  },
  createdAt: extras.createdAt ?? "2026-09-18T01:00:00Z",
  ...extras,
});

test("cross-source canonical URL merges entries while similar titles stay distinct", () => {
  const a = publicMaterial("ycore:a", "same-doc", "src-1", "Launch note", "Body A", {
    url: "https://news.example/story/?utm_source=rss",
  });
  const b = publicMaterial("ycore:b", "other-scope", "src-2", "Launch note", "Body B", {
    url: "https://www.news.example/story",
  });
  const c = publicMaterial("ycore:c", "other-doc", "src-1", "Launch note", "Different report", {
    url: "https://news.example/other-story",
  });
  const items = collectNewsItems([a, b, c]);
  assert.equal(items.length, 2);
  const merged = items.find((item) => item.citations.length === 2);
  assert.ok(merged);
  assert.equal(
    canonicalNewsUrl("https://News.Example/story/?utm_source=rss"),
    canonicalNewsUrl("https://www.news.example/story"),
  );
  assert.ok(items.some((item) => item.primary.id === c.id));
});

test("same material id keeps the latest version in the stream and pins a saved version", () => {
  const store = new Store(":memory:");
  const radar = new Radar(store, () => ({ scope: "test" }) as Model);
  const v1 = publicMaterial("ycore:doc", "doc", "src", "Old title", "Old body", {
    version: 1,
  });
  const v2 = { ...v1, version: 2, title: "New title", body: "New body" };
  store.put("material", `${v1.id}@1`, v1);
  store.put("material", `${v2.id}@2`, v2);
  const items = collectNewsItems(store.all("material"));
  assert.equal(items.length, 1);
  assert.equal(items[0].primary.version, 2);
  radar.reading(
    { materialId: v1.id, version: 1 },
    { saved: true, read: true, scroll: 40 },
  );
  radar.reading(
    { materialId: v1.id, version: 2 },
    { read: true, scroll: 90 },
  );
  const reading = store.get<any>("radar-reading", materialReadingId(v1.id));
  assert.equal(reading.saved, true);
  assert.equal(reading.savedRef.version, 1);
  assert.equal(reading.positions["1"], 40);
  assert.equal(reading.positions["2"], 90);
  radar.reading(
    { materialId: v1.id, version: 2 },
    { saved: true, pinSavedVersion: true },
  );
  assert.equal(
    store.get<any>("radar-reading", materialReadingId(v1.id)).savedRef.version,
    2,
  );
  store.close();
});

test("project files, process snapshots and radar editions are not news", () => {
  const news = publicMaterial("ycore:n", "n", "src", "Public", "Body");
  const project = {
    ...news,
    id: "local-project",
    projectSource: {
      projectId: "p",
      root: "/tmp",
      path: "README.md",
      sha256: "x",
      bytes: 1,
      modifiedAt: news.createdAt,
      kind: "documentation",
    },
  } as Material;
  const process = {
    ...news,
    id: "proc",
    coverage: "process_snapshot",
    processSource: {
      workId: "w",
      runIds: [],
      contributionIds: [],
      versionIds: [],
      capturedAt: news.createdAt,
      mode: "explanation",
    },
  } as Material;
  const edition = {
    ...news,
    id: "radar:topic",
    coverage: "radar",
    provenance: { editionId: randomUUID(), refs: [] },
  } as Material;
  assert.equal(isNewsMaterial(news), true);
  assert.equal(isNewsMaterial(project), false);
  assert.equal(isNewsMaterial(process), false);
  assert.equal(isNewsMaterial(edition), false);
  assert.equal(collectNewsItems([news, project, process, edition]).length, 1);
});

test("latin AI keyword does not match said or Spain, family assistant needs both groups", () => {
  assert.equal(textMatchesKeyword("They said it failed in Spain", "AI"), false);
  const family = { matchRules: FAMILY_ASSISTANT_RULES, keywords: ["AI"] };
  const google = publicMaterial(
    "ycore:cc",
    "cc",
    "src",
    "Google unveils AI agent for families",
    "A new helper for households.",
  );
  const volvo = publicMaterial(
    "ycore:volvo",
    "volvo",
    "src",
    "Volvo battery assistant",
    "The car battery pack uses an AI thermal model.",
  );
  const car = publicMaterial(
    "ycore:car",
    "car",
    "src",
    "In-car voice assistant",
    "Drivers can ask the assistant for navigation.",
  );
  const travel = publicMaterial(
    "ycore:trip",
    "trip",
    "src",
    "家庭旅行代理上线",
    "请让旅行代理帮全家订酒店。",
  );
  const human = publicMaterial(
    "ycore:human",
    "human",
    "src",
    "家庭助手照顾老人",
    "一位人类助手上门陪伴家人。",
  );
  assert.equal(materialMatchesTopic(google, family), true);
  assert.equal(materialMatchesTopic(volvo, family), false);
  assert.equal(materialMatchesTopic(car, family), false);
  assert.equal(materialMatchesTopic(travel, family), false);
  assert.equal(materialMatchesTopic(human, family), false);
  assert.equal(
    materialMatchesTopic(volvo, { keywords: ["AI"] }),
    true,
  );
});

test("matchRules require the same title or paragraph, reject empty groups, and do not fall back", () => {
  const split = publicMaterial(
    "ycore:split",
    "split",
    "src",
    "Household budget notes",
    "First paragraph is only about cooking.\n\nSecond paragraph mentions an assistant upgrade.",
  );
  assert.equal(materialMatchesTopic(split, { matchRules: FAMILY_ASSISTANT_RULES }), false);
  const together = publicMaterial(
    "ycore:together",
    "together",
    "src",
    "Notes",
    "Families can try the new AI assistant this week.",
  );
  assert.equal(
    materialMatchesTopic(together, { matchRules: FAMILY_ASSISTANT_RULES }),
    true,
  );
  assert.equal(parseMatchRules({ version: 1, groups: [{ terms: [] }] }).ok, false);
  const broken = materialMatchesTopic(together, {
    matchRules: { version: 2, groups: [{ terms: ["家庭"] }] } as any,
    keywords: ["assistant"],
  });
  assert.equal(broken, false);
  const preview = previewTopicMatches([together], {
    matchRules: { version: 1, groups: [{ terms: [] }] } as any,
  });
  assert.ok(preview.error);
  assert.equal(preview.count, 0);
});

test("related news needs a shared specific object and real sentences, not source or company", () => {
  const pixelA = publicMaterial(
    "ycore:p1",
    "p1",
    "src",
    "Pixel 10 launch event",
    "Google showed the Pixel 10 launch timeline in New York.",
  );
  const pixelB = publicMaterial(
    "ycore:p2",
    "p2",
    "src",
    "Pixel 10 battery claim",
    "Reviewers measured the Pixel 10 battery after the launch.",
  );
  const other = publicMaterial(
    "ycore:g",
    "g",
    "src",
    "Google quarterly note",
    "Google posted a company update without a product code.",
  );
  const hits = relatedNewsForArticle([pixelA, pixelB, other], pixelA);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].material.id, pixelB.id);
  assert.match(hits[0].from, /Pixel 10/);
  assert.match(hits[0].to, /Pixel 10/);
  assert.ok(!hits.some((item) => item.material.id === other.id));
});

test("RSS indented excerpts are not shown as code while fenced code stays", () => {
  const rss = publicMaterial(
    "ycore:ars",
    "ars",
    "src",
    "Ars item",
    "    The agency published the filing on Monday.\n    It remains an excerpt.\nRead full article\nComments 12",
    { coverage: "feed_excerpt" },
  );
  const shown = displayNewsText(rss);
  assert.equal(shown.code, false);
  assert.match(shown.lede, /agency published/);
  assert.doesNotMatch(shown.body, /^    The agency/);
  assert.doesNotMatch(shown.body, /Read full article/);
  const googleCc = publicMaterial(
    "ycore:ccbody",
    "ccbody",
    "src",
    "Google CC",
    "     Google CC is a consumer product.\n CC is an evolution of the assistant.\n Google says families can try it next week.",
    { coverage: "feed_excerpt" },
  );
  const paragraphs = displayNewsText(googleCc);
  assert.equal(paragraphs.paragraphs.length, 3);
  assert.match(paragraphs.lede, /consumer product/);
  assert.doesNotMatch(paragraphs.lede, /evolution/);
  const long = displayNewsText(
    publicMaterial(
      "ycore:long",
      "long",
      "src",
      "Long",
      `${"word ".repeat(80)}endinghere extra`,
      { coverage: "feed_excerpt" },
    ),
  );
  assert.match(long.lede, /…$/);
  assert.doesNotMatch(long.lede, /endinghere extra/);
  const code = publicMaterial(
    "ycore:code",
    "code",
    "src",
    "Snippet",
    "```js\nconst n = 1;\n```\n",
    { coverage: "feed_excerpt" },
  );
  const kept = displayNewsText(code);
  assert.equal(kept.code, true);
  assert.match(kept.body, /```js/);
  const titleOnly = publicMaterial("ycore:t", "t", "src", "Headline", "", {
    coverage: "title_only",
  });
  const missing = displayNewsText(titleOnly);
  assert.equal(missing.titleOnly, true);
  assert.equal(missing.body, "");
  assert.equal(missing.lede, "");
});

test("free-text follow does not treat a sentence as an immediate keyword success", () => {
  assert.equal(followIntentKind("家庭AI助手"), "preset");
  assert.equal(followIntentKind("量子计算"), "choice");
  assert.equal(followIntentKind("Google CC的商业机会"), "choice");
  const preset = followTopicInput("家庭AI助手", ["src"]);
  assert.deepEqual(preset.matchRules, FAMILY_ASSISTANT_RULES);
  assert.equal(preset.keywords, undefined);
  const silent = followTopicInput("Google CC的商业机会", ["src"]);
  assert.equal(silent.keywords, undefined);
  assert.equal(silent.matchRules, undefined);
  const literal = followTopicInput("Google CC的商业机会", ["src"], {
    literalText: true,
  });
  assert.deepEqual(literal.keywords, ["Google CC的商业机会"]);
});

test("topic matching distinguishes hand-picked materials from automatic hits", () => {
  const store = new Store(":memory:");
  store.put("meta", "sources", [
    { id: "src", name: "Public", status: "active", last_error: null } satisfies Source,
  ]);
  const picked = publicMaterial("ycore:pick", "pick", "src", "Unrelated title", "No keywords here");
  const auto = publicMaterial(
    "ycore:auto",
    "auto",
    "src",
    "Google unveils AI agent for families",
    "Households can try it.",
  );
  store.put("material", `${picked.id}@1`, picked);
  store.put("material", `${auto.id}@1`, auto);
  const radar = new Radar(store, () => ({ scope: "test" }) as Model);
  const topic = radar.saveTopic({
    revision: 0,
    title: "家庭AI助手",
    focus: "",
    sourceIds: ["src"],
    matchRules: FAMILY_ASSISTANT_RULES,
    sources: [{ materialId: picked.id, policy: "keep", reason: "手选" }],
  });
  const items = topicMatchesNews(
    { materials: store.all("material"), sources: store.get("meta", "sources") ?? [], feeds: [] },
    topic,
  );
  assert.ok(items.some((item) => item.primary.id === picked.id && item.citations.some((c) => c.selected)));
  assert.ok(items.some((item) => item.primary.id === auto.id && !item.citations.some((c) => c.selected)));
  store.close();
});

test("local preview uses the topic source range instead of every material", () => {
  const allowed = publicMaterial(
    "ycore:ok",
    "ok",
    "src-a",
    "Allowed hit",
    "家庭AI助手今晚发布。",
  );
  const other = publicMaterial(
    "ycore:no",
    "no",
    "src-b",
    "Other source hit",
    "家庭AI助手也在这边。",
  );
  const data = {
    materials: [allowed, other],
    sources: [
      { id: "src-a", name: "A", status: "active", last_error: null },
      { id: "src-b", name: "B", status: "active", last_error: null },
    ],
    feeds: [],
  };
  const preview = localMatchPreview(data, {
    title: "家庭AI助手",
    focus: "",
    sourceIds: ["src-a"],
    sources: [],
    matchRules: FAMILY_ASSISTANT_RULES,
  });
  assert.equal(preview.count, 1);
  assert.equal(preview.samples[0].title, "Allowed hit");
});

test("stored all and saved views are not rewritten to followed", () => {
  const news = publicMaterial("ycore:n", "n", "src", "News", "Body");
  const topic = {
    id: "11111111-1111-4111-8111-111111111111",
    revision: 1,
    title: "人工智能",
    focus: "",
    sources: [],
    updatedAt: "2026-09-18T00:00:00.000Z",
  };
  const data = {
    materials: [news],
    works: [],
    radar: {
      topics: [topic],
      editions: [],
      reading: [],
      jobs: [],
      watches: [],
      checks: [],
    },
  };
  const all = resolveRadarView(data as any, {
    scope: "all",
    topicId: null,
    query: "pixel",
    object: { kind: "material", id: news.id, version: 1 },
    returnStack: [],
    queue: [],
    listAnchor: { kind: "material", id: news.id, version: 1 },
    listOffset: 80,
    workId: "missing-work",
    researchRef: { kind: "material", id: news.id, version: 1 },
    followDraft: "draft",
  });
  assert.equal(all.scope, "all");
  assert.equal(all.query, "pixel");
  assert.equal(all.object?.kind, "material");
  assert.equal(all.workId, null);
  assert.equal(all.listOffset, 80);
  const saved = resolveRadarView(data as any, {
    ...all,
    scope: "saved",
    object: null,
    workId: null,
    researchRef: null,
  });
  assert.equal(saved.scope, "saved");
  const fresh = resolveRadarView(data as any);
  assert.equal(fresh.scope, "followed");
  const other = publicMaterial("ycore:other", "other", "src", "Other", "Body");
  const visitedOther = resolveRadarView({ ...data, materials: [news, other], works: [{ id: "work-a" }] } as any, {
    ...all,
    object: { kind: "material", id: other.id, version: 1 },
    workId: "work-a",
    researchRef: { kind: "material", id: news.id, version: 1 },
  });
  assert.equal(visitedOther.workId, "work-a");
  assert.deepEqual(visitedOther.researchRef, { kind: "material", id: news.id, version: 1 });
  const returned = resolveRadarView({ ...data, works: [{ id: "work-a" }] } as any, { ...visitedOther, object: { kind: "material", id: news.id, version: 1 } });
  assert.equal(returned.workId, "work-a");
  assert.deepEqual(returned.researchRef, returned.object);
});

test("changing matchRules is not a direct narrow and material readings restore in backups", () => {
  const store = new Store(":memory:");
  store.put("meta", "workspace-policy", { direct: true });
  const workId = randomUUID(),
    runId = randomUUID(),
    contributionId = `${runId}:0:t0:a0`;
  store.put("work", workId, {
    id: workId,
    title: "工作",
    projectId: null,
    deliveryId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    archived: false,
    queuePaused: false,
  });
  const run: Run = {
    id: runId,
    workId,
    text: "修改这个议题",
    refs: [],
    recipient: null,
    status: "running",
    error: null,
    createdAt: new Date().toISOString(),
    team: defaultTeam,
    workflow: adaptiveWorkflow,
    baseVersionId: null,
    submissionKey: randomUUID(),
    serviceScope: "account:test",
    workspacePolicy: { direct: true },
    workspaceContext: { kind: "radar-topic", id: "pending", revision: 1 },
  };
  const radar = new Radar(store, () => ({ scope: "account:test" }) as Model);
  const topic = radar.saveTopic({
    revision: 0,
    title: "家庭AI助手",
    focus: "",
    keywords: ["AI"],
    sources: [],
  });
  run.workspaceContext = { kind: "radar-topic", id: topic.id, revision: topic.revision };
  store.put("run", run.id, run);
  store.put("contribution", contributionId, {
    id: contributionId,
    workId,
    runId,
    memberId: defaultTeam.members[0].id,
    memberName: defaultTeam.members[0].name,
    objective: run.text,
    body: "",
    status: "succeeded",
    remoteId: null,
    error: null,
    createdAt: new Date().toISOString(),
    task: { key: "top", stage: 0, depth: 0, refs: [] },
  });
  const actions = new WorkspaceActions(store, {
    radar,
    schedules: new Schedules(store, { startQueued() {}, stop() {} }, () => "account:test"),
    radarWatches: new RadarWatches(store, radar, () => "account:test"),
    currentScope: () => "account:test",
  });
  const proposal = actions.prepare(run, contributionId, defaultTeam.members[0].id, {
    kind: "radar-topic",
    topic: {
      id: topic.id,
      revision: topic.revision,
      title: topic.title,
      focus: topic.focus,
      keywords: topic.keywords,
      matchRules: FAMILY_ASSISTANT_RULES,
      sources: [],
    },
  });
  assert.equal(proposal.execution, "confirmation");
  const news = publicMaterial("ycore:keep", "keep", "src", "Kept", "Body");
  store.put("material", `${news.id}@1`, news);
  radar.reading({ materialId: news.id, version: 1 }, { saved: true, scroll: 12 });
  const exported = store.exportState();
  const reading = exported.entities.find((row) => row.kind === "radar-reading");
  assert.ok(reading);
  const value = JSON.parse(reading.data);
  assert.equal(reading.id, materialReadingId(news.id));
  assert.equal(value.savedRef.materialId, news.id);
  assert.equal(value.savedRef.version, 1);
  store.close();
});
