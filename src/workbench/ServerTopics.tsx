import { ArrowUpRight, BookOpen, Layers3 } from "lucide-react";
import type { ReadingTopic } from "@ytriple/source-contract";
import type { RadarItem } from "../shared/types";
import type { Dispatch } from "./common";

export function ServerTopics({
  topics,
  items,
  onRead,
  dispatch,
}: {
  topics: ReadingTopic[];
  items: RadarItem[];
  onRead: (item: RadarItem) => void;
  dispatch: Dispatch;
}) {
  if (!topics.length) return null;
  const byId = new Map(items.map((item) => [item.remoteItemId, item]));
  return (
    <section className="radar-server-topics" aria-label="服务器主题整理">
      <header>
        <h3>
          <Layers3 size={16} /> 先看重点
        </h3>
        <span>服务器整理 · 可回到来源核查</span>
      </header>
      <div className="radar-server-topic-grid">
        {topics.map((topic) => (
          <article className="radar-server-topic" key={topic.id}>
            <span className="radar-topic-category">{topic.category}</span>
            <h4>{topic.title}</h4>
            <p>{topic.summary}</p>
            <details>
              <summary>
                展开主题与依据 <span>{topic.evidence.length} 条材料</span>
              </summary>
              {topic.points.map((point, index) => (
                <section className="radar-topic-point" key={index}>
                  <h5>{point.title}</h5>
                  <p>{point.detail}</p>
                  <div>
                    {point.sourceIds.map((id) => {
                      const evidence = topic.evidence.find(
                        (candidate) => candidate.itemId === id,
                      );
                      const item = byId.get(id);
                      if (!evidence) return null;
                      return (
                        <button
                          key={id}
                          className="radar-topic-source"
                          onClick={() =>
                            item
                              ? onRead(item)
                              : void dispatch({
                                  type: "url.open",
                                  url: evidence.url,
                                })
                          }
                        >
                          <BookOpen size={12} />
                          {evidence.title}
                          {item && item.latestRevisionId !== evidence.revisionId
                            ? " · 来源已更新"
                            : ""}
                          <ArrowUpRight size={12} />
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))}
              {topic.caveats.length ? (
                <div className="radar-topic-caveats">
                  <strong>还需留意</strong>
                  {topic.caveats.map((note, index) => (
                    <p key={index}>{note}</p>
                  ))}
                </div>
              ) : null}
              <details className="radar-topic-evidence">
                <summary>核查整理所用的材料片段</summary>
                {topic.evidence.map((evidence) => (
                  <details key={evidence.itemId}>
                    <summary>{evidence.title}</summary>
                    <p>
                      {evidence.coverage === "fulltext"
                        ? "已取得正文中的片段"
                        : "仅订阅源摘要"}
                    </p>
                    <blockquote>{evidence.excerpt}</blockquote>
                  </details>
                ))}
              </details>
              <small>
                整理于 {new Date(topic.generatedAt).toLocaleString("zh-CN")} ·
                依据上述材料，尚需结合实际用途判断。
              </small>
            </details>
          </article>
        ))}
      </div>
    </section>
  );
}
