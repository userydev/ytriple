import {
  coverageLabel,
  type RadarEdition,
  type RadarTopic,
} from "./radar-contract";
import type { Material, Message, Reference, Run, Snapshot, Work } from "./types";
import { visibleRadarMaterials } from "./material-list";
import { materialMatchesTopic } from "./radar-match";
import { compareCoreDecision } from "./radar-decision";
export {
  textMatchesKeyword,
  textMatchesAnyKeyword,
  topicMatchMode,
  materialMatchesTopic,
  parseMatchRules,
  previewTopicMatches,
} from "./radar-match";
export {
  SUGGESTED_FOLLOW_LABELS,
  FAMILY_ASSISTANT_RULES,
  keywordsForFollowTitle,
  followTopicInput,
  followIntentKind,
  collectNewsItems,
  topicMatchesNews,
  followedNews,
  savedNews,
  savedEditions,
  displayNewsText,
  relatedNewsForArticle,
  isNewsMaterial,
  canonicalNewsUrl,
  resolveRadarView,
  contentKey,
  coverageKindLabel,
  sourceNameForMaterial,
  editionProvenance,
  readingForMaterial,
  localMatchPreview,
  newsSortTime,
  filterNewsQuery,
} from "./radar-news";

export function latestTopicEditions(editions: RadarEdition[]) {
  const latest = new Map<string, RadarEdition>();
  for (const edition of editions) {
    const current = latest.get(edition.topicId);
    if (
      !current ||
      edition.number > current.number ||
      (edition.number === current.number &&
        edition.createdAt.localeCompare(current.createdAt) > 0)
    )
      latest.set(edition.topicId, edition);
  }
  return [...latest.values()].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}

export function latestEditions(data: Pick<Snapshot, "radar">) {
  return latestTopicEditions(data.radar.editions);
}

export function visibleRadarEditions(
  data: Pick<Snapshot, "radar">,
  options: { savedOnly?: boolean; query?: string } = {},
) {
  const editions = options.savedOnly
    ? data.radar.editions.filter((edition) =>
        data.radar.reading.some((item) => item.id === edition.id && item.saved),
      )
    : latestTopicEditions(data.radar.editions);
  const query = options.query?.trim().toLocaleLowerCase();
  if (!query) return editions;
  return editions.filter((edition) =>
    (edition.insight.title + edition.insight.summary)
      .toLocaleLowerCase()
      .includes(query),
  );
}

export function editionCoverageSummary(edition: RadarEdition) {
  const counts = new Map<string, number>();
  for (const source of edition.sources) {
    const label = coverageLabel(source.coverage);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return (
    [...counts.entries()].map(([label, count]) => `${count} 份${label}`).join(" · ") ||
    "无来源"
  );
}

export function formatRadarTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function radarSupplyStatus(data: Pick<Snapshot, "sources" | "feeds">) {
  const publicSources = data.sources.map((source) => ({
    id: source.id,
    name: source.name,
    status: source.last_error ?? source.status,
  }));
  const feeds = data.feeds
    .filter((feed) => !feed.archived)
    .map((feed) => ({
      id: feed.id,
      name: feed.name,
      status: feed.error ?? (feed.enabled ? "运行时自动更新" : "手动更新"),
    }));
  return {
    publicSources,
    feeds,
    hasSupply: publicSources.length + feeds.length > 0,
    explanation: publicSources.length + feeds.length
      ? "以下是当前真实可用来源，不是已生成的解读。没有整理结果时不会编造文章。"
      : "当前还没有可读的公共来源或个人订阅。可在话题详情添加公开 RSS/Atom，或同步已接通的公共来源。不会生成示例解读。",
  };
}

export function uniqueRefs(refs: Reference[]) {
  const seen = new Set<string>();
  return refs.filter((reference) => {
    const key = `${reference.materialId}@${reference.version}:${reference.excerpt ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function researchRefsForEdition(edition: RadarEdition): Reference[] {
  return uniqueRefs([
    {
      materialId: edition.materialId,
      version: edition.number,
      label: edition.insight.title,
    },
    ...edition.sources
      .filter((source) => source.policy !== "exclude")
      .map((source) => ({
        materialId: source.reference.materialId,
        version: source.reference.version,
        label: source.title,
      })),
  ]);
}

export function researchRefsForMaterial(material: Material): Reference[] {
  return [
    {
      materialId: material.id,
      version: material.version,
      label: material.title,
    },
  ];
}

export function mergeResearchRefs(existing: Reference[], required: Reference[]) {
  const have = new Set(
    existing.map((reference) => `${reference.materialId}@${reference.version}`),
  );
  return uniqueRefs([
    ...existing,
    ...required.filter(
      (reference) => !have.has(`${reference.materialId}@${reference.version}`),
    ),
  ]);
}

export function boundedResearchRefs(existing: Reference[], required: Reference[], limit = 20) {
  const all = mergeResearchRefs(existing, required);
  return { refs: all.slice(0, limit), omitted: Math.max(0, all.length - limit) };
}

export function worksCitingReferences(
  data: Pick<Snapshot, "works" | "messages" | "runs">,
  refs: Reference[],
  topicId?: string | null,
) {
  const keys = new Set(
    refs.map((reference) => `${reference.materialId}@${reference.version}`),
  );
  const cites = (list: Reference[]) =>
    list.some((reference) =>
      keys.has(`${reference.materialId}@${reference.version}`),
    );
  const ids = new Set<string>();
  for (const message of data.messages as Message[])
    if (cites(message.refs)) ids.add(message.workId);
  for (const run of data.runs as Run[]) if (cites(run.refs)) ids.add(run.workId);
  return (data.works as Work[]).filter((work) => {
    if (!ids.has(work.id) || work.archived) return false;
    if (!topicId) return true;
    return (
      work.workspaceContext?.kind === "radar-topic" &&
      work.workspaceContext.id === topicId
    );
  });
}

export function matchingTopicForMaterial(
  topics: RadarTopic[],
  editions: RadarEdition[],
  material: Material,
) {
  const matched = topics.filter(
    (topic) =>
      topic.sources.some((source) => source.materialId === material.id) ||
      editions.some(
        (edition) =>
          edition.topicId === topic.id &&
          edition.sources.some(
            (source) =>
              source.reference.materialId === material.id &&
              source.reference.version === material.version,
          ),
      ),
  );
  return matched.length === 1 ? matched[0] : null;
}

export function defaultResearchText(_input?: {
  title: string;
  coverage: string;
  topic?: Pick<RadarTopic, "title" | "focus" | "revision"> | null;
  url?: string;
  fetchedAt?: string;
  publishedAt?: string | null;
  version?: number;
  sources?: { title: string; url?: string; coverage: string; version: number }[];
}) {
  return "";
}

export function editionJobStatus(
  data: Pick<Snapshot, "radar">,
  topicId: string,
) {
  const job = data.radar.jobs.filter((item) => item.topic.id === topicId).at(-1);
  if (!job) return null;
  if (job.status === "failed")
    return {
      tone: "failed" as const,
      message: job.error ?? "整理失败，上次可读解读仍保留",
    };
  if (job.status === "unknown")
    return {
      tone: "stale" as const,
      message: job.error ?? "整理结果待核对，不把中断当作没有更新",
    };
  if (job.status === "succeeded" && job.summary)
    return {
      tone:
        /未变|没有新增|无新的实质|材料与规则未变/.test(job.summary)
          ? ("unchanged" as const)
          : ("ok" as const),
      message: job.summary,
    };
  if (job.status === "running")
    return { tone: "ok" as const, message: "正在整理所选材料…" };
  if (job.status === "queued")
    return { tone: "ok" as const, message: "整理已排队" };
  return null;
}

export function followPlanText(title: string) {
  const trimmed = title.trim();
  return trimmed
    ? `完善关注「${trimmed}」的范围。请 inspect 当前真实来源后提出 matchRules，先确认再保存。自动跟进保持关闭。`
    : "完善一个关注范围。请 inspect 当前真实来源后提出 matchRules，先确认再保存。自动跟进保持关闭。";
}

export function connectedPublicSourceIds(
  sources: readonly { id: string }[],
) {
  return sources.map((source) => source.id).slice(0, 10);
}

export function resolveFollowTitle(topics: RadarTopic[], title: string) {
  const needle = title.trim().toLocaleLowerCase();
  if (!needle) return { kind: "invalid" as const };
  const sameName = topics.filter(
    (topic) => topic.title.toLocaleLowerCase() === needle,
  );
  const active = sameName
    .filter((topic) => !topic.archived)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (active[0]) return { kind: "active" as const, topic: active[0] };
  const archived = sameName
    .filter((topic) => topic.archived)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (archived[0]) return { kind: "archived" as const, topic: archived[0] };
  return { kind: "new" as const };
}

export function activeRadarTopics(topics: RadarTopic[]) {
  return topics
    .filter((topic) => !topic.archived)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function filterTopicsByQuery(topics: RadarTopic[], query: string) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return topics;
  return topics.filter((topic) =>
    topic.title.toLocaleLowerCase().includes(needle),
  );
}

export function formatRadarDate(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export type RadarNav = "all" | "saved" | { topicId: string };

export type RadarObject =
  | { kind: "list" }
  | { kind: "detail" }
  | { kind: "edition"; id: string }
  | { kind: "material"; id: string; version: number };

export function navKey(nav: RadarNav) {
  return nav === "all" || nav === "saved" ? nav : nav.topicId;
}

export function storeReadingObject(
  memory: Record<string, RadarObject>,
  key: string,
  object: RadarObject,
): Record<string, RadarObject> {
  const current = memory[key];
  if (
    current &&
    current.kind === object.kind &&
    (current.kind !== "edition" ||
      object.kind !== "edition" ||
      current.id === object.id) &&
    (current.kind !== "material" ||
      object.kind !== "material" ||
      (current.id === object.id && current.version === object.version))
  )
    return memory;
  return { ...memory, [key]: object };
}

export function recallReadingObject(
  memory: Record<string, RadarObject>,
  key: string,
): RadarObject {
  return memory[key] ?? { kind: "list" };
}

export function draftIdForObject(
  object: RadarObject,
  topicId?: string | null,
) {
  if (object.kind === "edition") return `new:radar:${object.id}`;
  if (object.kind === "material")
    return `new:radar:m:${object.id}@${object.version}`;
  if (object.kind === "detail" && topicId) return `new:radar:trace:${topicId}`;
  return null;
}

export function materialResearchDraftId(
  material: Pick<Material, "id" | "version">,
  _topicId?: string | null,
) {
  return `new:radar:m:${material.id}@${material.version}`;
}

export type RadarResearchAnchor = {
  kind: "follow" | "object";
  contextId: string;
  topicId?: string | null;
  contentKey: string;
};

export function continueRadarResearch(
  current: RadarResearchAnchor | null,
  fromContext: string,
  workId: string,
): RadarResearchAnchor | null {
  if (!current) return null;
  if (current.contextId !== fromContext && current.contextId !== workId)
    return current;
  return { ...current, contextId: workId };
}

export function radarResearchShows(
  research: RadarResearchAnchor | null,
  context: string,
  panel: "follow" | "object",
  followOpen: boolean,
  contentKey?: string | null,
) {
  if (!research || research.contextId !== context) return false;
  if (panel === "follow") return research.kind === "follow" && followOpen;
  if (research.kind === "follow") return false;
  if (contentKey && research.contentKey !== contentKey) return false;
  return true;
}

export function topicEditionHistory(
  editions: RadarEdition[],
  topicId: string,
) {
  return editions
    .filter((edition) => edition.topicId === topicId)
    .sort(
      (a, b) =>
        b.number - a.number || b.createdAt.localeCompare(a.createdAt),
    )
    .map((edition) => ({
      id: edition.id,
      number: edition.number,
      title: edition.insight.title,
      savedAt: edition.createdAt,
      changes: edition.insight.changes,
    }));
}

function materialKey(material: Pick<Material, "id" | "version">) {
  return `${material.id}@${material.version}`;
}

function lookupMaterial(
  materials: Material[],
  id: string,
  version: number,
): Material | undefined {
  return materials.find((item) => item.id === id && item.version === version);
}

export type RelatedMaterial = {
  material: Material;
  reason: string;
};

export function relatedMaterialsForEdition(
  data: Pick<Snapshot, "materials">,
  edition: RadarEdition,
): RelatedMaterial[] {
  const related: RelatedMaterial[] = [];
  const seen = new Set<string>();
  for (const source of edition.sources) {
    if (source.policy === "exclude") continue;
    const material =
      lookupMaterial(
        data.materials,
        source.reference.materialId,
        source.reference.version,
      ) ?? {
        id: source.reference.materialId,
        version: source.reference.version,
        title: source.title,
        body: source.body,
        coverage: source.coverage,
        createdAt: edition.createdAt,
        url: source.url,
      };
    const key = materialKey(material);
    if (seen.has(key)) continue;
    seen.add(key);
    related.push({
      material,
      reason: source.duplicateOf
        ? `与 ${source.duplicateOf} 正文相同，不作为独立佐证`
        : `本解读引用的出处 · ${coverageLabel(source.coverage)}`,
    });
  }
  return related;
}

export function relatedMaterialsForArticle(
  data: Pick<Snapshot, "materials" | "radar">,
  material: Material,
  edition?: RadarEdition | null,
  _topic?: RadarTopic | null,
): RelatedMaterial[] {
  const related: RelatedMaterial[] = [];
  const seen = new Set<string>([materialKey(material)]);
  const add = (item: Material, reason: string) => {
    const key = materialKey(item);
    if (seen.has(key)) return;
    seen.add(key);
    related.push({ material: item, reason });
  };
  if (edition) {
    for (const item of relatedMaterialsForEdition(data, edition)) {
      if (item.material.id === material.id && item.material.version === material.version)
        continue;
      add(item.material, `本解读引用的出处 · ${coverageLabel(item.material.coverage)}`);
    }
  }
  return related;
}

export function matchingPublicMaterials(
  data: Pick<Snapshot, "materials">,
  topic: Pick<RadarTopic, "sourceIds" | "keywords" | "matchRules">,
) {
  const sourceIds = topic.sourceIds ?? [];
  if (!sourceIds.length) return [];
  return visibleRadarMaterials(data.materials)
    .filter((material) => {
      if (
        !material.upstream?.provenance.some((entry) =>
          sourceIds.includes(entry.sourceId),
        )
      )
        return false;
      return materialMatchesTopic(material, topic);
    })
    .sort(compareCoreDecision)
    .slice(0, 18);
}

export function topicListedMaterials(
  data: Pick<Snapshot, "materials" | "radar">,
  topic: RadarTopic,
): RelatedMaterial[] {
  const related: RelatedMaterial[] = [];
  const seen = new Set<string>();
  const add = (material: Material | undefined, reason: string) => {
    if (!material) return;
    const key = materialKey(material);
    if (seen.has(key)) return;
    seen.add(key);
    related.push({ material, reason });
  };
  for (const source of topic.sources) {
    const latest = data.materials
      .filter((item) => item.id === source.materialId)
      .sort((a, b) => b.version - a.version)[0];
    add(latest, source.reason || "话题选定的材料");
  }
  const latest = latestTopicEditions(data.radar.editions).find(
    (edition) => edition.topicId === topic.id,
  );
  if (latest) {
    for (const item of relatedMaterialsForEdition(data, latest))
      add(item.material, item.reason);
  } else {
    for (const material of matchingPublicMaterials(data, topic))
      add(
        material,
        "已接通来源中命中关注关键词的材料，不是语义推断",
      );
  }
  return related;
}

export function topicHasContent(
  data: Pick<Snapshot, "materials" | "radar">,
  topic: RadarTopic,
) {
  return (
    data.radar.editions.some((edition) => edition.topicId === topic.id) ||
    topicListedMaterials(data, topic).length > 0
  );
}

export function latestEditionForTopic(
  editions: RadarEdition[],
  topicId: string,
) {
  return latestTopicEditions(editions).find(
    (edition) => edition.topicId === topicId,
  );
}

export function groupedTopicContents(
  data: Pick<Snapshot, "radar" | "materials">,
  nav: RadarNav,
  query = "",
) {
  const needle = query.trim().toLocaleLowerCase();
  const matches = (text: string) =>
    !needle || text.toLocaleLowerCase().includes(needle);
  const topics = activeRadarTopics(data.radar.topics);
  const saved = visibleRadarEditions(data, { savedOnly: true }).filter((edition) =>
    matches(edition.insight.title + edition.insight.summary),
  );
  if (nav === "saved") {
    const byTopic = new Map<string, RadarEdition[]>();
    for (const edition of saved) {
      const list = byTopic.get(edition.topicId) ?? [];
      list.push(edition);
      byTopic.set(edition.topicId, list);
    }
    return [...byTopic.entries()].map(([topicId, editions]) => ({
      topic: topics.find((item) => item.id === topicId) ?? null,
      topicId,
      editions,
      materials: [] as RelatedMaterial[],
      empty: !editions.length,
    }));
  }
  const target = typeof nav === "object" ? topics.filter((topic) => topic.id === nav.topicId) : topics;
  return target.map((topic) => {
    const editions = (
      latestEditionForTopic(data.radar.editions, topic.id)
        ? [latestEditionForTopic(data.radar.editions, topic.id)!]
        : []
    ).filter((edition) =>
      matches(edition.insight.title + edition.insight.summary + topic.title),
    );
    const materials =
      typeof nav === "object"
        ? topicListedMaterials(data, topic)
        : editions.length ? [] : topicListedMaterials(data, topic).slice(0, 3);
    return {
      topic,
      topicId: topic.id,
      editions,
      materials,
      empty: !editions.length && !materials.length && !topicHasContent(data, topic),
    };
  });
}

export function researchDraftId(
  data: Pick<Snapshot, "drafts">,
  object: RadarObject,
  topicId?: string | null,
) {
  const id = draftIdForObject(object, topicId);
  if (!id) return null;
  return data.drafts.some((draft) => draft.id === id) ? id : null;
}

export function developmentTraceText(input: {
  title: string;
  editions: { number: number; title: string; savedAt: string }[];
  materials: { title: string; coverage: string; version: number }[];
}) {
  const editions = input.editions
    .map(
      (item) =>
        `解读 v${item.number}「${item.title}」，保存于 ${formatRadarDate(item.savedAt)}`,
    )
    .join("；");
  const materials = input.materials
    .map(
      (item) =>
        `「${item.title}」${coverageLabel(item.coverage)} v${item.version}`,
    )
    .join("；");
  return `请根据「${input.title}」已保存的解读和可用材料，梳理目前能确认的发展脉络。只使用这些已有版本与材料，不要编造未记载的事件或发生日期。解读上的日期是版本保存时间，不是事件发生时间。${editions ? `已保存解读：${editions}。` : "尚无已保存解读。"}${materials ? `可用材料：${materials}。` : ""}`;
}
