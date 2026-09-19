import type { Radar } from "./radar";
import type { RadarEdition, RadarJob, RadarTopic } from "./radar-contract";
import {
  formatRadarTime,
  latestTopicEditions,
  savedEditions,
} from "./radar-reading";
import type {
  ArtifactVersion,
  Contribution,
  Decision,
  Material,
  Message,
  Run,
  Snapshot,
  Work,
} from "./types";

export function editionFeed(
  data: Pick<Snapshot, "radar">,
  scope: "all" | "followed" | "saved" | "topic",
  topicId: string | null,
) {
  if (scope === "saved") return savedEditions(data);
  const latest = latestTopicEditions(data.radar.editions);
  if (scope === "topic" && topicId)
    return latest.filter((edition) => edition.topicId === topicId);
  if (scope === "followed") {
    const active = new Set(
      data.radar.topics.filter((topic) => !topic.archived).map((topic) => topic.id),
    );
    return latest.filter((edition) => active.has(edition.topicId));
  }
  return latest;
}

const shortCoverage: Record<string, string> = {
  title_only: "仅标题",
  summary: "摘要",
  feed_content: "节选",
  feed_excerpt: "节选",
};

export function editionCardMeta(
  data: Pick<Snapshot, "radar">,
  edition: RadarEdition,
) {
  const topic = data.radar.topics.find((item) => item.id === edition.topicId);
  const kept = edition.sources.filter((source) => source.policy !== "exclude");
  const change =
    edition.insight.changes[0] &&
    edition.previousId
      ? edition.insight.changes[0]
      : null;
  const coverage = kept[0]?.coverage ?? "";
  return {
    topic: topic?.title ?? "议题",
    time: formatRadarTime(edition.createdAt),
    footer: `${kept.length} 份${shortCoverage[coverage] ?? "材料"} · ${formatRadarTime(edition.createdAt)}`,
    change,
    legacy: !edition.processing,
  };
}

export function editionImage(
  data: Pick<Snapshot, "materials">,
  edition: RadarEdition,
) {
  for (const source of edition.sources) {
    if (source.policy === "exclude") continue;
    const material = data.materials.find(
      (item) =>
        item.id === source.reference.materialId &&
        item.version === source.reference.version &&
        item.image?.url,
    );
    if (material?.image) return material.image;
  }
  return null;
}

export function canSplitReader(width: number) {
  const gap = 24;
  const team = Math.min(480, Math.max(420, Math.round(width * 0.38)));
  const reader = width - team - gap;
  return reader >= 520 && team >= 420;
}

export function readerTeamWidths(width: number) {
  if (!canSplitReader(width)) return { split: false, reader: width, team: width };
  const gap = 24;
  const team = Math.min(480, Math.max(420, Math.round(width * 0.38)));
  return { split: true, reader: width - team - gap, team };
}

function isToolArtifact(item: Contribution) {
  if (item.tool || item.toolFormatError) return true;
  const body = item.body.trim();
  return (
    body.startsWith("{") ||
    body.startsWith("[") ||
    body.includes("builtin.workspace") ||
    body.includes("ytriple_tool")
  );
}

export function publicTeamEvents(
  contributions: Contribution[],
  workId?: string | null,
  runId?: string | null,
) {
  if (!workId || !runId) return [];
  return contributions.filter(
    (item) =>
      item.workId === workId &&
      item.runId === runId &&
      !item.task?.parentId &&
      !isToolArtifact(item),
  );
}

export function decisionWindowState(
  data: Pick<
    Snapshot,
    | "works"
    | "messages"
    | "runs"
    | "versions"
    | "decisions"
    | "contributions"
    | "drafts"
  >,
  workId: string,
  versionId?: string | null,
) {
  const work = data.works.find((item) => item.id === workId) ?? null;
  const messages = data.messages.filter((item) => item.workId === workId);
  const runs = data.runs.filter((item) => item.workId === workId);
  const latestRun = runs.at(-1) ?? null;
  const versions = data.versions.filter((item) => item.workId === workId);
  const currentVersion =
    versions.find((item) => item.id === versionId) ?? versions.at(-1) ?? null;
  const decision =
    data.decisions.find(
      (item) => item.workId === workId && item.status === "pending",
    ) ?? null;
  const draft = data.drafts.find((item) => item.id === workId) ?? null;
  return {
    work,
    messages,
    runs,
    latestRun,
    versions,
    currentVersion,
    decision,
    draft,
    events: publicTeamEvents(
      data.contributions,
      work?.id ?? null,
      latestRun?.id ?? null,
    ),
  };
}

export function organizeEmptyCopy(topic: RadarTopic | null) {
  return topic
    ? `「${topic.title}」还没有解读。整理一次后会出现在这里。`
    : "还没有解读。关注一个话题后，可以整理一次。";
}

export const ORGANIZE_UNAVAILABLE =
  "公开材料整理服务不可用，上次解读仍保留";
export const ORGANIZE_FAILED = "公开材料整理未完成，上次解读仍保留";

export type RadarProcessor = {
  capabilities(): Promise<{
    available: boolean;
    processor_version: string | null;
  } | null>;
  process(
    items: { id: string; revision: number }[],
    retry?: boolean,
  ): Promise<
    {
      document_id: string;
      revision: number;
      processor_version: string;
      status: "ready" | "insufficient" | "failed";
      title_zh: string | null;
      digest: string | null;
      keypoints: { text: string; quote: string }[];
      coverage: string;
      model: string | null;
      processed_at: string | null;
      content_hash: string;
      error: { code: string; message: string } | null;
      input?: { chars: number; truncated: boolean } | null;
    }[]
  >;
};

export async function organizeRadarTopic(
  radar: Radar,
  topicId: string,
  processor: RadarProcessor | null,
  retry = false,
): Promise<RadarJob> {
  if (radar.hasPublicProcessable(topicId)) {
    if (!processor) throw Error(ORGANIZE_UNAVAILABLE);
    let caps: {
      available: boolean;
      processor_version: string | null;
    } | null;
    try {
      caps = await processor.capabilities();
    } catch {
      throw Error(ORGANIZE_UNAVAILABLE);
    }
    if (!caps?.available || !caps.processor_version)
      throw Error(ORGANIZE_UNAVAILABLE);
    const batch = radar.eligiblePublicProcessing(
      topicId,
      caps.processor_version,
    );
    if (batch.length) {
      const results = await processor.process(
        batch.map((material) => ({
          id: material.upstream!.id,
          revision: material.upstream!.revision,
        })),
        retry,
      );
      radar.associateDerived(results);
      if (
        results.length !== batch.length ||
        results.some((item) => item.status !== "ready")
      )
        throw Error(ORGANIZE_FAILED);
    }
    return radar.refresh(topicId, retry, undefined, {
      processorVersion: caps.processor_version,
    });
  }
  return radar.refresh(topicId, retry);
}

export type { RadarTopic, Work, Message, Run, ArtifactVersion, Decision, Material };
