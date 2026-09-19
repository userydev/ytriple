import {
  coverageLabel,
  defaultRadarView,
  materialReadingId,
  type RadarContentRef,
  type RadarReading,
  type RadarTopic,
  type RadarView,
  type TopicInput,
} from "./radar-contract";
import {
  materialMatchesTopic,
  topicMatchMode,
} from "./radar-match";
import type { Material, Snapshot } from "./types";

export const FAMILY_ASSISTANT_RULES = {
  version: 1 as const,
  groups: [
    {
      terms: ["家庭", "家人", "家用", "家中", "family", "families", "household"],
    },
    {
      terms: [
        "AI助手",
        "智能助手",
        "人工智能助手",
        "AI 助手",
        "AI assistant",
        "AI agent",
      ],
    },
  ],
};

export const SUGGESTED_FOLLOW_LABELS = [
  { title: "家庭AI助手", matchRules: FAMILY_ASSISTANT_RULES },
  { title: "人工智能", aliases: ["人工智能", "AI", "OpenAI", "大模型"] },
  { title: "开源软件", aliases: ["开源软件", "开源", "open source"] },
  { title: "产品与设计", aliases: ["产品与设计", "交互", "设计"] },
  { title: "科学研究", aliases: ["科学研究", "科研", "论文"] },
  { title: "产业与政策", aliases: ["产业与政策", "政策", "监管"] },
] as const;

export function keywordsForFollowTitle(title: string) {
  const trimmed = title.trim();
  if (!trimmed) return [];
  const preset = SUGGESTED_FOLLOW_LABELS.find((item) => item.title === trimmed);
  if (preset && "aliases" in preset) return [...preset.aliases];
  return [trimmed];
}

export function presetForFollowTitle(title: string) {
  return SUGGESTED_FOLLOW_LABELS.find((item) => item.title === title.trim());
}

export function followIntentKind(
  title: string,
): "preset" | "choice" | "empty" {
  const trimmed = title.trim();
  if (!trimmed) return "empty";
  if (presetForFollowTitle(trimmed)) return "preset";
  return "choice";
}

export function followTopicInput(
  title: string,
  sourceIds: string[],
  options: { literalText?: boolean } = {},
): TopicInput {
  const trimmed = title.trim();
  const preset = presetForFollowTitle(trimmed);
  const ids = sourceIds.slice(0, 10);
  const matchRules =
    preset && "matchRules" in preset ? preset.matchRules : undefined;
  const keywords = matchRules
    ? undefined
    : options.literalText
      ? [trimmed]
      : preset && "aliases" in preset
        ? [...preset.aliases]
        : undefined;
  return {
    revision: 0,
    title: trimmed,
    focus: "",
    sources: [],
    ...(ids.length ? { sourceIds: ids } : {}),
    ...(matchRules ? { matchRules } : {}),
    ...(keywords?.length ? { keywords } : {}),
  };
}

export function isNewsMaterial(material: Material) {
  if (material.coverage === "radar") return false;
  if (material.projectSource || material.processSource || material.readinessSource)
    return false;
  if (material.provenance?.editionId) return false;
  return Boolean(material.upstream || material.feedSource);
}

export function canonicalNewsUrl(url?: string | null) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.hash = "";
    parsed.hostname = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    for (const key of [...parsed.searchParams.keys()])
      if (/^(utm_|fbclid|gclid|spm$|ref$)/i.test(key))
        parsed.searchParams.delete(key);
    parsed.searchParams.sort();
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString();
  } catch {
    return null;
  }
}

export function newsPublishedAt(material: Material) {
  return (
    material.feedSource?.publishedAt ??
    material.upstream?.publishedAt ??
    null
  );
}

export function newsCollectedAt(material: Material) {
  return (
    material.feedSource?.fetchedAt ??
    material.upstream?.discoveredAt ??
    material.createdAt
  );
}

export function newsSortTime(material: Material) {
  return newsPublishedAt(material) ?? newsCollectedAt(material);
}

export function materialHasCodeSemantics(material: Pick<Material, "body" | "coverage">) {
  if (
    ["artifact", "project_file", "process_snapshot"].includes(material.coverage)
  )
    return true;
  if (/```[\w+-]*\n/.test(material.body)) return true;
  const codeTokens = material.body.match(/[{};]/g)?.length ?? 0;
  return (
    codeTokens > 8 &&
    /^\s*(?:function|class|import |export |const |let |var |def |package |using )/m.test(
      material.body,
    )
  );
}

function stripRssFooter(body: string) {
  let text = body.replace(/\r\n/g, "\n");
  let next = text;
  do {
    text = next;
    next = text.replace(
      /\n*(?:Read full article\.?|Comments(?:\s+\d+)?)\s*$/i,
      "",
    );
  } while (next !== text);
  return text;
}

function rssDisplayParagraphs(body: string) {
  const text = stripRssFooter(body);
  const lines = text.split("\n").map((line) => line.replace(/^\s{2,}/, "").trimEnd());
  if (lines.some((line) => !line.trim()) && /\n\s*\n/.test(text))
    return text
      .split(/\n\s*\n/)
      .map((item) => item.replace(/^\s{2,}/gm, "").trim())
      .filter(Boolean);
  return lines.map((line) => line.trim()).filter(Boolean);
}

export function truncateLede(text: string, max = 220) {
  const value = text.trim();
  if (value.length <= max) return value;
  const slice = value.slice(0, max);
  const breaks = [slice.lastIndexOf("。"), slice.lastIndexOf(". "), slice.lastIndexOf("，"), slice.lastIndexOf(" ")];
  const at = Math.max(...breaks);
  const cut = at >= Math.floor(max * 0.5) ? slice.slice(0, at + (slice[at] === "." ? 1 : 0)) : slice;
  return `${cut.trimEnd()}…`;
}

export function displayNewsText(material: Material) {
  const titleOnly =
    material.coverage === "title_only" ||
    material.coverage === "link_only" ||
    !material.body.trim();
  if (titleOnly)
    return { body: "", lede: "", titleOnly: true, code: false, paragraphs: [] as string[] };
  if (materialHasCodeSemantics(material))
    return {
      body: material.body,
      lede: truncateLede(material.body.split(/\n\s*\n/)[0] ?? material.body),
      titleOnly: false,
      code: true,
      paragraphs: [material.body],
    };
  const paragraphs = rssDisplayParagraphs(material.body);
  return {
    body: paragraphs.join("\n\n"),
    lede: truncateLede(paragraphs[0] ?? ""),
    titleOnly: !paragraphs.length,
    code: false,
    paragraphs,
  };
}

export function coverageKindLabel(material: Material) {
  if (
    material.coverage === "title_only" ||
    material.coverage === "link_only" ||
    !material.body.trim()
  )
    return "仅标题";
  if (
    material.coverage === "summary" ||
    material.coverage === "feed_content" ||
    material.coverage === "feed_excerpt"
  )
    return "节选";
  return coverageLabel(material.coverage);
}

export type NewsCitation = {
  material: Material;
  selected?: boolean;
};

export type NewsItem = {
  key: string;
  primary: Material;
  citations: NewsCitation[];
  publishedAt: string | null;
  collectedAt: string;
};

function latestById(materials: readonly Material[]) {
  const latest = new Map<string, Material>();
  for (const material of materials) {
    const current = latest.get(material.id);
    if (!current || material.version > current.version)
      latest.set(material.id, material);
  }
  return [...latest.values()];
}

function newsKey(material: Material) {
  return canonicalNewsUrl(material.url ?? material.feedSource?.resolvedUrl) ??
    `id:${material.id}`;
}

export function collectNewsItems(materials: readonly Material[]): NewsItem[] {
  const news = latestById(materials.filter(isNewsMaterial));
  const groups = new Map<string, Material[]>();
  for (const material of news) {
    const key = newsKey(material);
    const list = groups.get(key) ?? [];
    list.push(material);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .map(([key, list]) => {
      const primary = [...list].sort(
        (a, b) =>
          newsSortTime(b).localeCompare(newsSortTime(a)) ||
          b.version - a.version ||
          a.id.localeCompare(b.id),
      )[0];
      return {
        key,
        primary,
        citations: list
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((material) => ({ material })),
        publishedAt: newsPublishedAt(primary),
        collectedAt: newsCollectedAt(primary),
      };
    })
    .sort(
      (a, b) =>
        newsSortTime(b.primary).localeCompare(newsSortTime(a.primary)) ||
        a.primary.id.localeCompare(b.primary.id),
    );
}

export function sourceNameForMaterial(
  data: Pick<Snapshot, "sources" | "feeds">,
  material: Material,
) {
  const publicName = material.upstream?.provenance
    .map(
      (entry) =>
        data.sources.find((source) => source.id === entry.sourceId)?.name,
    )
    .find(Boolean);
  if (publicName) return publicName;
  if (material.feedSource)
    return (
      data.feeds.find((feed) => feed.id === material.feedSource?.sourceId)
        ?.name ?? material.feedSource.publisher ?? "个人订阅"
    );
  return material.upstream?.publisher ?? "来源";
}

function explicitTopicMaterials(
  data: Pick<Snapshot, "materials">,
  topic: RadarTopic,
) {
  const selected = new Map<string, Material>();
  for (const source of topic.sources) {
    if (source.policy === "exclude") continue;
    const latest = data.materials
      .filter((item) => item.id === source.materialId)
      .sort((a, b) => b.version - a.version)[0];
    if (latest && isNewsMaterial(latest)) selected.set(latest.id, latest);
  }
  return selected;
}

export function topicMatchesNews(
  data: Pick<Snapshot, "materials" | "sources" | "feeds">,
  topic: RadarTopic,
): NewsItem[] {
  const selected = explicitTopicMaterials(data, topic);
  const mode = topicMatchMode(topic);
  const auto = collectNewsItems(data.materials).filter((item) => {
    if (selected.has(item.primary.id)) return false;
    if (mode.mode === "invalid" || mode.mode === "none") return false;
    const inSources = item.citations.some((citation) =>
      citation.material.upstream?.provenance.some((entry) =>
        topic.sourceIds?.includes(entry.sourceId),
      ),
    );
    const inFeeds = item.citations.some((citation) =>
      Boolean(
        citation.material.feedSource &&
          topic.feedIds?.includes(citation.material.feedSource.sourceId),
      ),
    );
    if (topic.sourceIds?.length || topic.feedIds?.length) {
      const allowed =
        (topic.sourceIds?.length ? inSources : false) ||
        (topic.feedIds?.length ? inFeeds : false);
      if (!allowed) return false;
    }
    return item.citations.some((citation) =>
      materialMatchesTopic(citation.material, topic),
    );
  });
  const selectedItems = collectNewsItems([...selected.values()]).map((item) => ({
    ...item,
    citations: item.citations.map((citation) => ({
      ...citation,
      selected: true,
    })),
  }));
  const seen = new Set(selectedItems.map((item) => item.key));
  return [...selectedItems, ...auto.filter((item) => !seen.has(item.key))].sort(
    (a, b) =>
      newsSortTime(b.primary).localeCompare(newsSortTime(a.primary)) ||
      a.primary.id.localeCompare(b.primary.id),
  );
}

export function followedNews(
  data: Pick<Snapshot, "materials" | "radar" | "sources" | "feeds">,
) {
  const topics = data.radar.topics.filter((topic) => !topic.archived);
  const merged = new Map<string, NewsItem>();
  for (const topic of topics) {
    for (const item of topicMatchesNews(data, topic)) {
      const current = merged.get(item.key);
      if (!current) merged.set(item.key, item);
      else {
        const citations = [...current.citations];
        for (const citation of item.citations)
          if (!citations.some((entry) => entry.material.id === citation.material.id))
            citations.push(citation);
        merged.set(item.key, { ...current, citations });
      }
    }
  }
  return [...merged.values()].sort(
    (a, b) =>
      newsSortTime(b.primary).localeCompare(newsSortTime(a.primary)) ||
      a.primary.id.localeCompare(b.primary.id),
  );
}

export function savedNews(
  data: Pick<Snapshot, "materials" | "radar">,
): { item: NewsItem; pinned: Material }[] {
  const result: { item: NewsItem; pinned: Material }[] = [];
  for (const reading of data.radar.reading) {
    if (!reading.saved) continue;
    if (reading.savedRef) {
      const pinned = data.materials.find(
        (item) =>
          item.id === reading.savedRef!.materialId &&
          item.version === reading.savedRef!.version,
      );
      if (!pinned || !isNewsMaterial(pinned)) continue;
      const item = collectNewsItems([pinned])[0];
      if (item) result.push({ item, pinned });
      continue;
    }
    const edition = data.radar.editions.find((item) => item.id === reading.id);
    if (edition) continue;
  }
  return result.sort(
    (a, b) =>
      newsSortTime(b.pinned).localeCompare(newsSortTime(a.pinned)) ||
      a.pinned.id.localeCompare(b.pinned.id),
  );
}

export function savedEditions(data: Pick<Snapshot, "radar">) {
  return data.radar.editions.filter((edition) =>
    data.radar.reading.some((item) => item.id === edition.id && item.saved),
  );
}

export function filterNewsQuery(items: NewsItem[], query: string) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return items;
  return items.filter((item) =>
    `${item.primary.title}\n${displayNewsText(item.primary).lede}`
      .toLocaleLowerCase()
      .includes(needle),
  );
}

function splitSentences(text: string) {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n+|(?<=[。！？.!?])\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 8);
}

function extractConcreteObjects(title: string, body: string) {
  const found: { object: string; sentence: string }[] = [];
  const add = (object: string, sentence: string) => {
    const value = object.trim().replace(/\s+/g, " ");
    if (value.length < 2 || value.length > 80) return;
    const tokens = value.split(/\s+/);
    const specific =
      tokens.length >= 2 ||
      /\d/.test(value) ||
      /[“"「《]/.test(sentence);
    if (!specific) return;
    found.push({ object: value, sentence });
  };
  for (const sentence of [title, ...splitSentences(`${title}\n${body}`)]) {
    for (const match of sentence.matchAll(/[“"「]([^”"」]{3,80})[”"」]/g))
      add(match[1], sentence);
    for (const match of sentence.matchAll(/《([^》]{2,40})》/g))
      add(match[1], sentence);
    for (const match of sentence.matchAll(
      /\b([A-Z][A-Za-z0-9]+(?:[ \-][A-Z0-9][A-Za-z0-9]+){1,3})\b/g,
    ))
      add(match[1], sentence);
    for (const match of sentence.matchAll(
      /\b([A-Z][A-Za-z]*\d+[A-Za-z0-9\-]*)\b/g,
    ))
      add(match[1], sentence);
  }
  return found;
}

export type RelatedNewsHit = {
  material: Material;
  object: string;
  from: string;
  to: string;
};

export function relatedNewsForArticle(
  materials: readonly Material[],
  article: Material,
): RelatedNewsHit[] {
  if (!isNewsMaterial(article)) return [];
  const mine = extractConcreteObjects(article.title, article.body);
  if (!mine.length) return [];
  const related: RelatedNewsHit[] = [];
  const seen = new Set<string>([article.id]);
  for (const material of latestById(materials.filter(isNewsMaterial))) {
    if (seen.has(material.id)) continue;
    if (canonicalNewsUrl(material.url) &&
      canonicalNewsUrl(material.url) === canonicalNewsUrl(article.url))
      continue;
    const theirs = extractConcreteObjects(material.title, material.body);
    let hit: RelatedNewsHit | null = null;
    for (const left of mine) {
      const match = theirs.find(
        (right) =>
          right.object.toLocaleLowerCase() === left.object.toLocaleLowerCase(),
      );
      if (!match) continue;
      hit = {
        material,
        object: left.object,
        from: left.sentence.slice(0, 180),
        to: match.sentence.slice(0, 180),
      };
      break;
    }
    if (hit) {
      seen.add(material.id);
      related.push(hit);
    }
    if (related.length >= 6) break;
  }
  return related;
}

export function editionProvenance(
  data: Pick<Snapshot, "radar">,
  material: Material,
) {
  return data.radar.editions.filter((edition) =>
    edition.sources.some(
      (source) =>
        source.policy !== "exclude" &&
        source.reference.materialId === material.id &&
        source.reference.version === material.version,
    ),
  );
}

export function contentKey(ref: RadarContentRef) {
  return ref.kind === "edition"
    ? `edition:${ref.id}`
    : `material:${ref.id}@${ref.version}`;
}

export function readingForMaterial(
  reading: RadarReading[],
  materialId: string,
) {
  return reading.find((item) => item.id === materialReadingId(materialId));
}

export function pinnedMaterialVersion(
  reading: RadarReading | undefined,
  latest: Material,
) {
  if (reading?.saved && reading.savedRef?.materialId === latest.id)
    return reading.savedRef.version;
  return latest.version;
}

export function resolveRadarView(
  data: Pick<Snapshot, "radar" | "materials" | "works">,
  stored?: RadarView | null,
): RadarView {
  const topics = data.radar.topics.filter((topic) => !topic.archived);
  const view = stored ?? data.radar.view;
  if (!view)
    return {
      ...defaultRadarView,
      scope: topics.length ? "followed" : "all",
    };
  let scope = view.scope;
  let topicId = view.topicId;
  if (scope === "topic" && (!topicId || !topics.some((topic) => topic.id === topicId))) {
    scope = topics.length ? "followed" : "all";
    topicId = null;
  }
  const validObject = (ref: RadarContentRef | null) => {
    if (!ref) return null;
    if (ref.kind === "edition")
      return data.radar.editions.some((item) => item.id === ref.id) ? ref : null;
    return data.materials.some(
      (item) => item.id === ref.id && item.version === ref.version,
    )
      ? ref
      : null;
  };
  const object = validObject(view.object);
  const researchRef = validObject(view.researchRef);
  const workId =
    view.workId && data.works.some((work) => work.id === view.workId && !work.archived)
      ? view.workId
      : null;
  const listAnchor = validObject(view.listAnchor);
  const queue = view.queue.filter((item) => validObject(item));
  const returnStack = view.returnStack
    .map((item) => validObject(item))
    .filter((item): item is RadarContentRef => !!item)
    .slice(0, 8);
  return {
    ...defaultRadarView,
    ...view,
    scope,
    topicId,
    query: view.query,
    object,
    returnStack,
    queue: object ? queue : view.queue,
    listAnchor: listAnchor,
    listOffset: view.listOffset ?? 0,
    workId,
    researchRef: workId ? researchRef : null,
    followDraft: view.followDraft,
    surface: view.surface === "sources" ? "sources" : "editions",
  };
}

export function localMatchPreview(
  data: Pick<Snapshot, "materials" | "sources" | "feeds">,
  topic: Pick<
    RadarTopic,
    "title" | "focus" | "keywords" | "matchRules" | "sourceIds" | "feedIds" | "sources"
  >,
) {
  const mode = topicMatchMode(topic);
  if (mode.mode === "invalid")
    return { error: mode.error, count: 0, samples: [] as { title: string; hit: string }[] };
  const items = topicMatchesNews(data, {
    id: "preview",
    revision: 0,
    title: topic.title || "预览",
    focus: topic.focus ?? "",
    sources: topic.sources ?? [],
    sourceIds: topic.sourceIds,
    feedIds: topic.feedIds,
    keywords: topic.keywords,
    matchRules: topic.matchRules,
    updatedAt: "",
  });
  return {
    error: null as string | null,
    count: items.length,
    samples: items.slice(0, 8).map((item) => ({
      title: item.primary.title,
      hit: item.primary.title,
    })),
  };
}
