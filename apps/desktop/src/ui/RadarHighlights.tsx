import { ArrowUpRight, BookOpen, Radar } from "lucide-react";
import type { Snapshot, Material } from "../core/types";
import { coverageLabel } from "../core/radar-contract";
export function latestEditions(data: Snapshot) {
  return Array.from(
    new Map(data.radar.editions.map((e) => [e.topicId, e])).values(),
  ).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function RadarHighlights({
  data,
  onOpen,
  onExplore,
  onMaterial,
}: {
  data: Snapshot;
  onOpen: (id: string) => void;
  onMaterial: (material: Material) => void;
  onExplore: () => void;
}) {
  const editions = latestEditions(data).slice(0, 4);
  return editions.length ? (
    <>
      {editions.map((e, i) => (
        <article className={i === 0 ? "lead-story" : "story"} key={e.id}>
          <div className="story-meta">
            <span className="story-category">
              {i === 0 ? "重点解读" : "观察"}
            </span>
            <small>
              {data.radar.topics.find((t) => t.id === e.topicId)?.title}
            </small>
          </div>
          <button className="story-title" onClick={() => onOpen(e.id)}>
            {e.insight.title}
          </button>
          <p>{e.insight.summary}</p>
          {i === 0 && e.insight.sections.length ? (
            <div className="story-threads" aria-label="解读脉络">
              {e.insight.sections.slice(0, 3).map((section, index) => (
                <button
                  key={`${index}:${section.heading}`}
                  onClick={() => onOpen(e.id)}
                >
                  <span className="thread-number">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span>
                    <strong>{section.heading}</strong>
                    <small>{section.sources.length} 份引用依据</small>
                  </span>
                  <ArrowUpRight size={16} />
                </button>
              ))}
            </div>
          ) : null}
          <div className="story-footer">
            <span>
              <BookOpen size={14} />
              {e.sources.length} 份依据 · v{e.number}
            </span>
            <button className="text-action" onClick={() => onOpen(e.id)}>
              阅读解读 <ArrowUpRight size={14} />
            </button>
          </div>
        </article>
      ))}
      {editions[0]?.sources.length ? (
        <div className="home-evidence">
          <div className="trace-heading">
            <span>本期材料</span>
            <small>{editions[0].sources.length} 份</small>
          </div>
          {editions[0].sources.slice(0, 3).map((source) => (
            <button
              key={source.key}
              onClick={() =>
                onMaterial(
                  data.materials.find(
                    (m) =>
                      m.id === source.reference.materialId &&
                      m.version === source.reference.version,
                  ) ?? {
                    id: source.reference.materialId,
                    version: source.reference.version,
                    title: source.title,
                    body: source.body,
                    coverage: source.coverage,
                    createdAt: editions[0].createdAt,
                    url: source.url,
                  },
                )
              }
              title={source.title}
            >
              <span className="evidence-symbol">
                <BookOpen size={16} />
              </span>
              <span>
                <strong>{source.title}</strong>
                <small>{coverageLabel(source.coverage)}</small>
              </span>
              <ArrowUpRight size={14} />
            </button>
          ))}
        </div>
      ) : null}
      <button className="quiet" onClick={onExplore}>
        全部观察
      </button>
    </>
  ) : (
    <div className="empty radar-empty">
      <Radar size={29} />
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
