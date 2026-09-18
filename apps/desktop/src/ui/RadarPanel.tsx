import { UnknownRunActions } from "./UnknownRunActions";
import { useLayoutEffect, useRef, useState } from "react";
import Markdown from "./Markdown";
import {
  ArrowLeft,
  ArrowUpRight,
  Bookmark,
  Pencil,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Square,
  Clock,
} from "lucide-react";
import type { Material, Snapshot } from "../core/types";
import {
  coverageLabel,
  type RadarEdition,
  type RadarJob,
  type RadarTopic,
  type TopicInput,
} from "../core/radar-contract";
import { command } from "./api";
import { Dialog } from "./Dialog";
import { IconButton } from "./Composer";

import { latestEditions } from "./RadarHighlights";
import { FeedsPanel } from "./FeedsPanel";
import { RadarAutomationEditor } from "./RadarAutomation";
function TopicEditor({
  data,
  topic,
  onClose,
  onSaved,
}: {
  data: Snapshot;
  topic: RadarTopic | null;
  onClose: () => void;
  onSaved: (topic: RadarTopic) => void;
}) {
  const [title, setTitle] = useState(topic?.title ?? ""),
    [focus, setFocus] = useState(topic?.focus ?? ""),
    [feedIds, setFeedIds] = useState(topic?.feedIds ?? []),
    [feedLimit, setFeedLimit] = useState(topic?.feedLimit ?? 8),
    [sources, setSources] = useState<TopicInput["sources"]>(
      topic?.sources ?? [],
    ),
    [query, setQuery] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const materials = Array.from(
    new Map(
      data.materials
        .filter((m) => m.coverage !== "radar")
        .sort((a, b) => a.version - b.version)
        .map((m) => [m.id, m]),
    ).values(),
  ).reverse();
  return (
    <Dialog title={topic ? "议题与筛选规则" : "关注一个议题"} onClose={onClose}>
      <form
        className="topic-editor"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          void command<RadarTopic>({
            type: "radar-topic",
            topic: {
              id: topic?.id,
              revision: topic?.revision ?? 0,
              title,
              focus,
              sources,
              feedIds,
              feedLimit,
            },
          })
            .then(onSaved)
            .catch((e) => setError(e instanceof Error ? e.message : String(e)))
            .finally(() => setBusy(false));
        }}
      >
        <label>
          议题名称
          <input
            aria-label="议题名称"
            value={title}
            maxLength={120}
            required
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例如：AI 工具如何改变个人创作"
          />
        </label>
        <label>
          重点关注什么
          <textarea
            aria-label="议题关注范围"
            rows={2}
            value={focus}
            maxLength={2000}
            onChange={(e) => setFocus(e.target.value)}
            placeholder="可选：想理解的变化、要保留的不同观点…"
          />
        </label>
        {data.feeds.length ? (
          <fieldset className="topic-feeds">
            <legend>持续纳入订阅的新材料</legend>
            {data.feeds.map((feed) => (
              <label className="material-check" key={feed.id}>
                <input
                  type="checkbox"
                  checked={feedIds.includes(feed.id)}
                  disabled={!feedIds.includes(feed.id) && feedIds.length >= 5}
                  onChange={(e) =>
                    setFeedIds(
                      e.target.checked
                        ? [...feedIds, feed.id]
                        : feedIds.filter((id) => id !== feed.id),
                    )
                  }
                />
                {feed.name}
                {feed.archived ? " · 已停用" : ""}
              </label>
            ))}
            {feedIds.length ? (
              <label>
                每次最多选入新近文章
                <input
                  type="number"
                  min={1}
                  max={18}
                  value={feedLimit}
                  onChange={(e) => setFeedLimit(Number(e.target.value))}
                />
              </label>
            ) : null}
            <p className="muted">
              整理时按发布时间优先选取已读文章，总计最多 18
              份；手选材料优先。读取订阅本身不调用模型，自动整理需另行开启。
            </p>
          </fieldset>
        ) : null}
        <div className="section-heading">
          <h3>用于本议题的材料</h3>
          <small>{sources.length} / 18</small>
        </div>
        <p className="muted">
          保存只调整关注范围；可手动整理或另行开启自动整理。修改规则后需重新确认自动整理范围。后续更新会使用这些材料的新修订。
        </p>
        <input
          aria-label="查找议题材料"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="查找已同步或已导入的材料…"
        />
        <div className="topic-materials">
          {materials
            .filter((m) =>
              m.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
            )
            .map((m) => {
              const selected = sources.find((s) => s.materialId === m.id);
              const patch = (value: Partial<TopicInput["sources"][number]>) =>
                setSources(
                  sources.map((s) =>
                    s.materialId === m.id ? { ...s, ...value } : s,
                  ),
                );
              return (
                <div className="topic-material" key={m.id}>
                  <label className="material-check">
                    <input
                      type="checkbox"
                      checked={!!selected}
                      disabled={busy || (!selected && sources.length >= 18)}
                      onChange={(e) =>
                        setSources(
                          e.target.checked
                            ? [
                                ...sources,
                                {
                                  materialId: m.id,
                                  policy: "auto",
                                  reason: "",
                                },
                              ]
                            : sources.filter((s) => s.materialId !== m.id),
                        )
                      }
                    />
                    <span>
                      {m.title}
                      <small>
                        {coverageLabel(m.coverage)} · v{m.version}
                        {m.readError ? " · 读取失败" : ""}
                      </small>
                    </span>
                  </label>
                  {selected ? (
                    <div className="material-policy">
                      <select
                        aria-label={`${m.title} 筛选规则`}
                        value={selected.policy}
                        onChange={(e) =>
                          patch({
                            policy: e.target.value as
                              "auto" | "keep" | "exclude",
                          })
                        }
                      >
                        <option value="auto">按议题判断</option>
                        <option value="keep">必须保留</option>
                        <option value="exclude">从解读排除</option>
                      </select>
                      <input
                        aria-label={`${m.title} 筛选理由`}
                        value={selected.reason}
                        maxLength={500}
                        onChange={(e) => patch({ reason: e.target.value })}
                        placeholder="补充理由或纠正原判断（可选）"
                      />
                    </div>
                  ) : null}
                </div>
              );
            })}
          {!materials.length ? (
            <p className="muted">先同步来源材料，或从对话入口导入本地文本。</p>
          ) : null}
        </div>
        {error ? (
          <p className="error-inline" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button
            className="primary"
            disabled={
              busy || !title.trim() || (!sources.length && !feedIds.length)
            }
          >
            {busy ? "保存中…" : "保存议题"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
export function RadarPanel({
  data,
  selectedId,
  onSelect,
  onUse,
  onMaterial,
  onWork,
  onSync,
  syncing,
  onError,
}: {
  data: Snapshot;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onUse: (edition: RadarEdition) => void;
  onMaterial: (m: Material) => void;
  onWork: (id: string) => void;
  onSync: () => void;
  syncing: boolean;
  onError: (e: unknown) => void;
}) {
  const [editing, setEditing] = useState<RadarTopic | null | undefined>(
      undefined,
    ),
    [sourcesOpen, setSourcesOpen] = useState(false),
    [filter, setFilter] = useState(""),
    [savedOnly, setSavedOnly] = useState(false),
    [busy, setBusy] = useState<string | null>(null),
    [notice, setNotice] = useState<{ topicId: string; message: string } | null>(
      null,
    );
  const root = useRef<HTMLElement>(null);
  const [automation, setAutomation] = useState<RadarTopic | null>(null);
  const selected = data.radar.editions.find((e) => e.id === selectedId);
  const reading = data.radar.reading.find((r) => r.id === selectedId);
  useLayoutEffect(() => {
    if (!selected) return;
    const page = root.current?.closest<HTMLElement>(".page");
    if (!page) return;
    page.scrollTop = reading?.scroll ?? 0;
    void command({
      type: "radar-reading",
      editionId: selected.id,
      patch: { read: true },
    }).catch(onError);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let top = page.scrollTop;
    const save = () => {
      clearTimeout(timer);
      void command({
        type: "radar-reading",
        editionId: selected.id,
        patch: { scroll: top },
      }).catch(onError);
    };
    const capture = () => {
      top = page.scrollTop;
      clearTimeout(timer);
      timer = setTimeout(save, 180);
    };
    page.addEventListener("scroll", capture, { passive: true });
    return () => {
      page.removeEventListener("scroll", capture);
      save();
    };
  }, [selected?.id]);
  async function refresh(topic: RadarTopic, retry = false) {
    setBusy(topic.id);
    setNotice(null);
    try {
      const job = await command<RadarJob>({
        type: "radar-refresh",
        topicId: topic.id,
        retry,
      });
      if (
        job.status === "succeeded" &&
        data.radar.jobs.some((j) => j.id === job.id)
      )
        setNotice({
          topicId: topic.id,
          message: "材料与规则未变，保留当前解读",
        });
    } catch (e) {
      onError(e);
    } finally {
      setBusy(null);
    }
  }
  const jobActions = (topic: RadarTopic) => {
    const job = data.radar.jobs.filter((j) => j.topic.id === topic.id).at(-1);
    const watch = data.radar.watches.find((w) => w.id === topic.id);
    return (
      <div className="radar-job-actions">
        {job?.status === "running" ? (
          <>
            <span className="muted">正在整理所选材料…</span>
            <IconButton
              label="停止本次整理"
              onClick={() =>
                void command({ type: "radar-stop", jobId: job.id }).catch(
                  onError,
                )
              }
            >
              <Square size={16} />
            </IconButton>
          </>
        ) : job?.status === "unknown" ? (
          <UnknownRunActions
            id={job.id}
            kind="radar"
            local={job.recovery === "local"}
            onError={onError}
          />
        ) : (
          <button
            disabled={busy === topic.id}
            onClick={() =>
              void refresh(
                topic,
                job?.status === "failed" || job?.status === "cancelled",
              )
            }
          >
            <RefreshCw size={15} />
            {job?.status === "failed"
              ? "重试整理"
              : data.radar.editions.some((e) => e.topicId === topic.id)
                ? "检查并更新"
                : "整理议题"}
          </button>
        )}
        <IconButton
          label={`调整议题 ${topic.title}`}
          onClick={() => setEditing(topic)}
        >
          <Pencil size={16} />
        </IconButton>
        <IconButton
          label={`自动整理 ${topic.title}`}
          onClick={() => setAutomation(topic)}
        >
          <Clock size={16} />
        </IconButton>
        {watch ? (
          <span className="muted">
            {watch.error ??
              (watch.enabled
                ? `每 ${watch.intervalMinutes} 分钟自动检查`
                : "自动整理已暂停")}
          </span>
        ) : null}
        {job?.error ? (
          <span className="error-inline">{job.error}</span>
        ) : job?.status === "succeeded" ? (
          <span className="muted">
            {notice?.topicId === topic.id ? notice.message : job.summary}
          </span>
        ) : null}
      </div>
    );
  };
  const editions = (
    savedOnly ? data.radar.editions : latestEditions(data)
  ).filter(
    (e) =>
      (!savedOnly ||
        data.radar.reading.some((r) => r.id === e.id && r.saved)) &&
      (e.insight.title + e.insight.summary)
        .toLowerCase()
        .includes(filter.toLowerCase()),
  );
  const materials = Array.from(
    new Map(
      data.materials
        .filter((m) => m.upstream || m.feedSource)
        .sort((a, b) => a.version - b.version)
        .map((m) => [m.id, m]),
    ).values(),
  ).reverse();
  return (
    <section className="wide-content radar-content" ref={root}>
      {selected ? (
        <>
          <div className="section-heading">
            <button className="quiet" onClick={() => onSelect(null)}>
              <ArrowLeft size={16} />
              雷达观察
            </button>
            <div className="tool-group">
              <select
                aria-label="解读版本"
                value={selected.id}
                onChange={(e) => onSelect(e.target.value)}
              >
                {data.radar.editions
                  .filter((e) => e.topicId === selected.topicId)
                  .map((e) => (
                    <option key={e.id} value={e.id}>
                      解读 v{e.number}
                    </option>
                  ))}
              </select>
              <IconButton
                label={reading?.saved ? "取消收藏解读" : "收藏解读"}
                aria-pressed={reading?.saved ?? false}
                onClick={() =>
                  void command({
                    type: "radar-reading",
                    editionId: selected.id,
                    patch: { saved: !reading?.saved },
                  }).catch(onError)
                }
              >
                <Bookmark
                  size={18}
                  fill={reading?.saved ? "currentColor" : "none"}
                />
              </IconButton>
            </div>
          </div>
          <small>
            {data.radar.topics.find((t) => t.id === selected.topicId)?.title} ·
            解读 v{selected.number}
          </small>
          <h1>{selected.insight.title}</h1>
          <p className="lede">{selected.insight.summary}</p>
          {data.radar.editions
            .filter((e) => e.topicId === selected.topicId)
            .at(-1)?.id !== selected.id ? (
            <p className="muted">已有新版本；当前仍在阅读所选旧版。</p>
          ) : null}
          <article className="radar-prose">
            {selected.insight.sections.map((section, i) => (
              <section key={i}>
                <h2>{section.heading}</h2>
                <Markdown>{section.body}</Markdown>
                <div className="citation-links">
                  {section.sources.map((key) => {
                    const source = selected.sources.find((s) => s.key === key)!;
                    return (
                      <button
                        className="text-action"
                        key={key}
                        onClick={() => {
                          const m = data.materials.find(
                            (m) =>
                              m.id === source.reference.materialId &&
                              m.version === source.reference.version,
                          );
                          if (m) onMaterial(m);
                        }}
                      >
                        {key} · {source.title}
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
            {selected.insight.changes.length ? (
              <section>
                <h2>这次更新了什么</h2>
                <ul>
                  {selected.insight.changes.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </section>
            ) : null}
            <section>
              <h2>依据与限制</h2>
              <ul>
                {selected.insight.limitations.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </section>
          </article>
          <details className="radar-screening">
            <summary>来源范围与筛选理由 · {selected.sources.length} 项</summary>
            {data.radar.jobs.find((j) => j.id === selected.jobId)?.supply
              ?.feedIds.length ? (
              <div className="muted">
                {data.radar.jobs
                  .find((j) => j.id === selected.jobId)
                  ?.supply?.notes.map((note) => (
                    <p key={note}>{note}</p>
                  ))}
                <p>
                  该轮持续订阅选入{" "}
                  {
                    data.radar.jobs.find((j) => j.id === selected.jobId)?.supply
                      ?.included
                  }{" "}
                  篇；另有{" "}
                  {
                    data.radar.jobs.find((j) => j.id === selected.jobId)?.supply
                      ?.omitted
                  }{" "}
                  篇未纳入。本页保留生成当时的范围。
                </p>
              </div>
            ) : null}
            {selected.sources.map((source) => {
              const screening = selected.insight.screening.find(
                (s) => s.source === source.key,
              );
              return (
                <div className="screening-row" key={source.key}>
                  <strong>
                    {source.key} · {source.title}
                  </strong>
                  <small>
                    {coverageLabel(source.coverage)} · v
                    {source.reference.version}
                  </small>
                  <p>
                    {source.policy === "exclude"
                      ? `用户排除：${source.reason || "本议题不采用"}`
                      : source.duplicateOf
                        ? `与 ${source.duplicateOf} 正文相同，不作为独立佐证`
                        : screening
                          ? `${screening.keep ? "保留" : "暂不采用"}：${screening.reason}`
                          : "未采用"}
                  </p>
                </div>
              );
            })}
            <button
              onClick={() =>
                setEditing(
                  data.radar.topics.find((t) => t.id === selected.topicId)!,
                )
              }
            >
              纠正材料筛选
            </button>
          </details>
          {jobActions(
            data.radar.topics.find((t) => t.id === selected.topicId)!,
          )}
          <div className="radar-followup">
            <button
              className="primary"
              data-radar-start
              onClick={() => onUse(selected)}
            >
              围绕解读开展工作 <ArrowUpRight size={16} />
            </button>
            <p className="muted">
              带入解读 v{selected.number} 与出处；写下目标后发送。
            </p>
          </div>
          {Array.from(
            new Set(
              data.messages
                .filter((m) =>
                  m.refs.some(
                    (r) =>
                      r.materialId === selected.materialId &&
                      r.version === selected.number,
                  ),
                )
                .map((m) => m.workId),
            ),
          ).map((id) => (
            <button className="text-action" key={id} onClick={() => onWork(id)}>
              继续：{data.works.find((w) => w.id === id)?.title}
            </button>
          ))}
        </>
      ) : (
        <>
          <div className="section-heading page-intro">
            <div>
              <span className="eyebrow">RADAR</span>
              <h1>观察与理解</h1>
            </div>
            <div className="tool-group">
              <IconButton
                label="来源与议题"
                aria-expanded={sourcesOpen}
                onClick={() => setSourcesOpen((v) => !v)}
              >
                <SlidersHorizontal size={19} />
              </IconButton>
              <button onClick={() => setEditing(null)}>
                <Plus size={16} />
                关注议题
              </button>
            </div>
          </div>
          <div className="radar-filter">
            <input
              aria-label="搜索雷达解读"
              placeholder="查找已整理的解读…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <button
              aria-pressed={savedOnly}
              onClick={() => setSavedOnly((v) => !v)}
            >
              <Bookmark size={16} />
              {savedOnly ? "只看收藏" : "全部解读"}
            </button>
          </div>
          {editions.map((e, i) => (
            <article className={i === 0 ? "lead-story" : "story"} key={e.id}>
              <small>
                {data.radar.topics.find((t) => t.id === e.topicId)?.title} · v
                {e.number}
                {data.radar.reading.some((r) => r.id === e.id && r.read)
                  ? " · 已读"
                  : ""}
              </small>
              <button className="story-title" onClick={() => onSelect(e.id)}>
                {e.insight.title}
              </button>
              <p>{e.insight.summary}</p>
              <button className="text-action" onClick={() => onSelect(e.id)}>
                阅读全文 <ArrowUpRight size={14} />
              </button>
            </article>
          ))}
          {!editions.length ? (
            <div className="empty">
              <h2>
                {savedOnly ? "尚无收藏的解读" : "把分散材料整理成一个认识"}
              </h2>
              <p>
                {savedOnly
                  ? "在解读中收藏准确版本，之后可继续阅读。"
                  : "选择已有来源材料，围绕议题整理证据、不同观点和限制。阅读与收藏不会启动模型。"}
              </p>
            </div>
          ) : null}
          {data.radar.topics
            .filter(
              (t) =>
                sourcesOpen ||
                !data.radar.editions.some((e) => e.topicId === t.id),
            )
            .map((t) => (
              <section className="topic-row" key={t.id}>
                <h3>{t.title}</h3>
                <p>{t.focus}</p>
                <small>
                  {t.sources.length} 项固定材料
                  {t.feedIds?.length
                    ? ` · ${t.feedIds.length} 个持续订阅（最多 ${t.feedLimit ?? 8} 篇）`
                    : ""}{" "}
                  · 规则 v{t.revision}
                </small>
                {jobActions(t)}
              </section>
            ))}
          {sourcesOpen ? (
            <section className="radar-sources">
              <FeedsPanel data={data} />
              <div className="section-heading">
                <h2>来源材料</h2>
                <button onClick={onSync} disabled={syncing}>
                  <RefreshCw size={15} />
                  {syncing ? "同步中…" : "同步公共来源"}
                </button>
              </div>
              <div className="source-line">
                {data.sources.map((s) => (
                  <span key={s.id}>
                    {s.name} · {s.last_error ?? s.status}
                  </span>
                ))}
              </div>
              {materials.map((m) => (
                <article className="radar-row" key={m.id}>
                  <small>
                    {m.feedSource
                      ? `${data.feeds.find((f) => f.id === m.feedSource?.sourceId)?.name ?? "个人订阅"} · `
                      : "公共来源 · "}
                    {coverageLabel(m.coverage)} · v{m.version}
                  </small>
                  <button className="story-title" onClick={() => onMaterial(m)}>
                    {m.title}
                  </button>
                  <p>{m.body.slice(0, 240)}</p>
                </article>
              ))}
              {!materials.length ? (
                <p>
                  添加个人订阅或同步公共来源后，材料会显示在这里；本地文本也可加入议题。
                </p>
              ) : null}
            </section>
          ) : null}
        </>
      )}
      {editing !== undefined ? (
        <TopicEditor
          key={editing?.id ?? "new"}
          data={data}
          topic={editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            setSourcesOpen(true);
          }}
        />
      ) : null}
      {automation ? (
        <RadarAutomationEditor
          data={data}
          topic={automation}
          onClose={() => setAutomation(null)}
        />
      ) : null}
    </section>
  );
}
