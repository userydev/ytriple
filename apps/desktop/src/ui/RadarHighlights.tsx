import { ArrowUpRight } from "lucide-react";
import type { Snapshot } from "../core/types";
export function latestEditions(data: Snapshot) {
  return Array.from(
    new Map(data.radar.editions.map((e) => [e.topicId, e])).values(),
  ).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function RadarHighlights({
  data,
  onOpen,
  onExplore,
}: {
  data: Snapshot;
  onOpen: (id: string) => void;
  onExplore: () => void;
}) {
  const editions = latestEditions(data).slice(0, 4);
  return editions.length ? (
    <>
      {editions.map((e, i) => (
        <article className={i === 0 ? "lead-story" : "story"} key={e.id}>
          <small>
            {data.radar.topics.find((t) => t.id === e.topicId)?.title} · 解读 v
            {e.number}
          </small>
          <button className="story-title" onClick={() => onOpen(e.id)}>
            {e.insight.title}
          </button>
          <p>{e.insight.summary}</p>
          <button className="text-action" onClick={() => onOpen(e.id)}>
            阅读解读 <ArrowUpRight size={14} />
          </button>
        </article>
      ))}
      <button className="quiet" onClick={onExplore}>
        全部观察
      </button>
    </>
  ) : (
    <div className="empty">
      <h2>围绕关心的问题，读懂变化</h2>
      <p>
        选择一个议题和已有材料，整理出认识、分歧与证据范围。之后从这里直接阅读。
      </p>
      <button onClick={onExplore}>
        {data.radar.topics.length ? "查看议题整理" : "开始整理议题"}
      </button>
    </div>
  );
}
