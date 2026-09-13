import { useLayoutEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  Check,
  LoaderCircle,
  MessageCircleQuestion,
  Search,
  Server,
} from "lucide-react";
import type { RadarItem, RadarSnapshot, Snapshot, Task } from "../shared/types";
import { type Dispatch } from "./common";
import { ServerTopics } from "./ServerTopics";

type ReaderState = {
  origin: "all" | "server" | "user";
  category: string;
  source: string;
  query: string;
  selected?: string;
  selectedSnapshot?: RadarItem;
  question?: string;
  visibleCount?: number;
};
// Reading selection survives a visit to the team, Lib, or source settings.
const readingStates = new Map<string, ReaderState>();
const defaults: ReaderState = {
  origin: "all",
  category: "",
  source: "",
  query: "",
};
const moment = (time: string) =>
  new Date(time).toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

// Early feed mirrors carried this explicit source date in the normalized body.
// Read it for display until a later revision supplies the structured field.
function publicationDate(item: RadarItem): string | undefined {
  const value =
    item.publishedAt ??
    /^发布时间：(\d{4}-\d{2}-\d{2}T[^\n]+)\n/.exec(item.content)?.[1];
  return value && Number.isFinite(Date.parse(value)) ? value : undefined;
}

export function SourceConnectionForm({
  radar,
  dispatch,
}: {
  radar: RadarSnapshot;
  dispatch: Dispatch;
}) {
  const [address, setAddress] = useState(
    radar.serviceURL || "http://127.0.0.1:47321",
  );
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [error, setError] = useState("");
  return (
    <form
      className="radar-connect-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy.current) return;
        busy.current = true;
        setPending(true);
        setError("");
        try {
          const result = await dispatch({
            type: "radar.connect",
            baseURL: address.trim(),
            bootstrapToken: code || undefined,
          });
          if (!result) setError("连接未保存，请检查提示后重试。");
          else setCode("");
        } catch {
          setError("未能连接服务，请检查地址与配对码。");
        } finally {
          busy.current = false;
          setPending(false);
        }
      }}
    >
      <strong>
        <Server size={16} />{" "}
        {radar.configured ? "信息源连接" : "连接信息源服务器"}
      </strong>
      <p>连接后接收服务器提供的来源和更新，重开应用会自动接续。</p>
      <label>
        服务地址
        <input
          type="url"
          required
          value={address}
          disabled={pending}
          onChange={(event) => setAddress(event.target.value)}
        />
      </label>
      <label>
        配对码
        <input
          type="password"
          autoComplete="off"
          value={code}
          disabled={pending}
          placeholder="本机测试服务可留空"
          onChange={(event) => setCode(event.target.value)}
        />
      </label>
      <button className="button primary small" disabled={pending} type="submit">
        {pending ? (
          <LoaderCircle size={14} className="spin" />
        ) : (
          <Server size={14} />
        )}
        {pending
          ? "正在连接…"
          : radar.configured
            ? "保存连接"
            : "连接并接收内容"}
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  );
}

export function RadarReader({
  radar,
  dispatch,
  onTask,
  onSources,
  tasks,
  onImport,
}: {
  radar: RadarSnapshot;
  dispatch: Dispatch;
  onTask: (id: string, task?: Task) => void;
  onSources: () => void;
  tasks: Task[];
  onImport?: () => void;
}) {
  const identity = `${radar.serviceURL ?? ""}:${radar.items[0]?.tenantId ?? ""}`;
  const [state, setState] = useState<ReaderState>(
    () => readingStates.get(identity) ?? { ...defaults },
  );
  const [pending, setPending] = useState(false);
  const question = state.question ?? "";
  const readerRoot = useRef<HTMLDivElement>(null);
  const overviewScroll = useRef(0);
  useLayoutEffect(() => {
    const scroll = readerRoot.current?.closest<HTMLElement>(".radar-page");
    if (scroll) scroll.scrollTop = state.selected ? 0 : overviewScroll.current;
  }, [state.selected]);
  const setQuestion = (value: string) => change({ question: value });
  const change = (patch: Partial<ReaderState>) =>
    setState((previous) => {
      const next = { ...previous, ...patch };
      readingStates.set(identity, next);
      return next;
    });
  const items = radar.items
    .filter((item) => !item.archivedAt)
    .toSorted(
      (left, right) =>
        Date.parse(publicationDate(right) ?? right.receivedAt) -
        Date.parse(publicationDate(left) ?? left.receivedAt),
    );
  const categories = Array.from(
    new Set(items.map((item) => item.category || "其他内容")),
  ).sort();
  const matchesOrigin = (item: RadarItem) =>
    state.origin === "all" ||
    (state.origin === "user" ? item.origin === "user" : item.origin !== "user");
  const sources = Array.from(
    new Map(
      items
        .filter(matchesOrigin)
        .map((item) => [item.sourceId, item.sourceTitle]),
    ).entries(),
  );
  const query = state.query.trim().toLocaleLowerCase();
  const filtered = items.filter(
    (item) =>
      matchesOrigin(item) &&
      (!state.category || (item.category || "其他内容") === state.category) &&
      (!state.source || item.sourceId === state.source) &&
      (!query ||
        `${item.title}\n${item.content}\n${item.sourceTitle}`
          .toLocaleLowerCase()
          .includes(query)),
  );
  const groups = (() => {
    const result = new Map<string, RadarItem[]>();
    for (const item of filtered) {
      const key = item.category || "其他内容";
      const group = result.get(key) ?? [];
      group.push(item);
      result.set(key, group);
    }
    return Array.from(result);
  })();
  const currentSelection = items.find((item) => item.id === state.selected);
  const selected = currentSelection
    ? (state.selectedSnapshot ?? currentSelection)
    : undefined;
  const readingChanged =
    selected &&
    currentSelection &&
    selected.latestRevisionId !== currentSelection.latestRevisionId;
  const topics = (radar.readingTopics ?? []).filter(
    (topic) =>
      (!state.category || topic.category === state.category) &&
      (!state.source ||
        topic.evidence.some((reference) =>
          filtered.some((item) => item.remoteItemId === reference.itemId),
        )) &&
      (state.origin === "all" ||
        topic.evidence.every((reference) =>
          items.some(
            (item) =>
              item.remoteItemId === reference.itemId && matchesOrigin(item),
          ),
        )) &&
      (!query ||
        `${topic.title} ${topic.summary}`.toLocaleLowerCase().includes(query)),
  );
  const select = (item: RadarItem) => {
    if (!state.selected)
      overviewScroll.current =
        readerRoot.current?.closest<HTMLElement>(".radar-page")?.scrollTop ?? 0;
    change({
      selected: item.id,
      selectedSnapshot: structuredClone(item),
      question: "",
    });
    if (!item.readAt)
      void dispatch({ type: "radar.markRead", itemId: item.id, read: true });
  };
  const discuss = async () => {
    if (!selected || pending || readingChanged) return;
    const previousTasks = new Set(tasks.map((task) => task.id));
    setPending(true);
    try {
      const result: Snapshot | null = await dispatch({
        type: "radar.createTask",
        itemIds: [selected.id],
        instruction:
          question.trim() ||
          `阅读《${selected.title}》，说明关键内容、适用条件和证据缺口，并结合与当前问题相关的已有积累继续分析。`,
      });
      const task = result?.tasks.find(
        (task) =>
          !previousTasks.has(task.id) &&
          !task.archivedAt &&
          task.sources.some(
            (source) => source.remote?.itemId === selected.remoteItemId,
          ),
      );
      if (task) onTask(task.id, task);
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="radar-reader" aria-label="信息阅读" ref={readerRoot}>
      <div
        className="radar-reader-filters"
        aria-label="来源材料筛选"
        hidden={Boolean(selected)}
      >
        <div className="radar-reader-origins">
          {(
            [
              { id: "all", label: "总览" },
              { id: "server", label: "订阅服务" },
              { id: "user", label: "我的来源" },
            ] as const
          ).map((option) => (
            <button
              key={option.id}
              className={state.origin === option.id ? "active" : ""}
              onClick={() =>
                change({
                  origin: option.id,
                  category: "",
                  source: "",
                  selected: undefined,
                })
              }
            >
              {option.label}
              <span>
                {
                  items.filter(
                    (item) =>
                      option.id === "all" ||
                      (option.id === "user"
                        ? item.origin === "user"
                        : item.origin !== "user"),
                  ).length
                }
              </span>
            </button>
          ))}
        </div>
        <label>
          <span className="sr-only">内容分类</span>
          <select
            aria-label="内容分类"
            value={state.category}
            onChange={(event) =>
              change({
                category: event.target.value,
                source: "",
                selected: undefined,
              })
            }
          >
            <option value="">全部分类</option>
            {categories.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">来源</span>
          <select
            aria-label="筛选来源"
            value={state.source}
            onChange={(event) =>
              change({
                source: event.target.value,
                category: "",
                selected: undefined,
              })
            }
          >
            <option value="">全部来源</option>
            {sources.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <button className="radar-manage-sources" onClick={onSources}>
          管理来源与订阅
        </button>
      </div>
      <div className="radar-reading-content">
        {selected ? (
          <article className="radar-article" key={selected.id}>
            <button
              className="button ghost small"
              onClick={() => change({ selected: undefined })}
            >
              <ArrowLeft size={14} /> 返回阅读
            </button>
            <div className="radar-article-meta">
              <span>{selected.sourceTitle}</span>
              <span>{selected.category}</span>
              <span>
                {publicationDate(selected)
                  ? `发布于 ${moment(publicationDate(selected)!)}`
                  : `接收于 ${moment(selected.receivedAt)}`}
              </span>
            </div>
            <h2>{selected.title}</h2>
            <div className="radar-article-actions">
              <span className="radar-coverage-label">
                {selected.coverageLevel === "fulltext"
                  ? "已取得正文"
                  : "订阅源提供的摘要"}
              </span>
              <button
                className="button ghost small"
                onClick={() =>
                  void dispatch({ type: "url.open", url: selected.url })
                }
              >
                查看原文 <ArrowUpRight size={14} />
              </button>
            </div>
            {readingChanged ? (
              <p className="radar-reading-note">
                来源已有新版本，当前阅读位置保留。
                <button
                  className="button ghost small"
                  onClick={() => select(currentSelection!)}
                >
                  阅读最新版本
                </button>
              </p>
            ) : null}
            {selected.coverageLevel !== "fulltext" ? (
              <p className="radar-reading-note">
                当前内容来自订阅源，尚未取得原网页全文。
              </p>
            ) : null}
            <div className="radar-article-body">
              {selected.content
                .split(/\n\s*\n/)
                .filter(Boolean)
                .map((paragraph, index) => (
                  <p key={index}>{paragraph}</p>
                ))}
            </div>
            <div className="radar-reading-next">
              <strong>
                <MessageCircleQuestion size={16} /> 与团队继续
              </strong>
              <p>围绕这条信息研究、核查或整理成可复用文档。</p>
              <textarea
                aria-label="围绕这条信息向团队提问"
                rows={2}
                value={question}
                disabled={pending}
                placeholder="这对我有什么用？需要再核查什么？"
                onChange={(event) => setQuestion(event.target.value)}
              />
              <button
                className="button primary small"
                disabled={pending || Boolean(readingChanged)}
                onClick={() => void discuss()}
              >
                {pending ? (
                  <LoaderCircle size={14} className="spin" />
                ) : (
                  <MessageCircleQuestion size={14} />
                )}
                交给团队
              </button>
            </div>
          </article>
        ) : (
          <>
            <div className="radar-reading-toolbar">
              <div>
                <h2>
                  {state.source
                    ? sources.find(([id]) => id === state.source)?.[1]
                    : state.category ||
                      (state.origin === "user"
                        ? "我的来源"
                        : state.origin === "server"
                          ? "订阅更新"
                          : "已取得的材料")}
                </h2>
                <p>
                  {filtered.length} 条已接收内容 · {radar.unreadCount} 条未读
                </p>
              </div>
              <label className="radar-search">
                <Search size={15} />
                <input
                  aria-label="搜索已接收信息"
                  placeholder="搜索信息"
                  value={state.query}
                  onChange={(event) => change({ query: event.target.value })}
                />
              </label>
            </div>
            {!radar.editorial && (
              <ServerTopics
                topics={topics}
                items={items}
                onRead={select}
                dispatch={dispatch}
              />
            )}
            {groups.length ? (
              groups.map(([category, group]) => (
                <section
                  className="radar-reading-group"
                  key={category}
                  aria-label={category}
                >
                  <header>
                    <h3>{category}</h3>
                    <span>{group.length} 条</span>
                  </header>
                  <div className="radar-reading-grid">
                    {group
                      .slice(
                        0,
                        state.category || state.source || query
                          ? (state.visibleCount ?? 80)
                          : 6,
                      )
                      .map((item) => (
                        <button
                          key={item.id}
                          className="radar-reading-card"
                          onClick={() => select(item)}
                        >
                          <span className="radar-card-source">
                            {item.sourceTitle}
                            {item.readAt ? (
                              <Check size={13} aria-label="已读" />
                            ) : (
                              <i aria-label="未读" />
                            )}
                          </span>
                          <h4>{item.title}</h4>
                          <p>{item.excerpt}</p>
                          <span className="radar-card-footer">
                            <span>
                              {item.coverageLevel === "fulltext"
                                ? "正文可读"
                                : "源站摘要"}
                            </span>
                            <BookOpen size={14} />
                          </span>
                        </button>
                      ))}
                  </div>
                  {!state.category &&
                  !state.source &&
                  !query &&
                  group.length > 6 ? (
                    <button
                      className="button ghost small"
                      onClick={() => change({ category })}
                    >
                      浏览全部 {group.length} 条 <ArrowUpRight size={14} />
                    </button>
                  ) : null}
                  {(state.category || state.source || query) &&
                  group.length > (state.visibleCount ?? 80) ? (
                    <button
                      className="button ghost small"
                      onClick={() =>
                        change({
                          visibleCount: (state.visibleCount ?? 80) + 80,
                        })
                      }
                    >
                      继续浏览
                    </button>
                  ) : null}
                </section>
              ))
            ) : (
              <div className="radar-reading-empty">
                <BookOpen size={25} />
                <h3>
                  {items.length
                    ? "没有符合条件的内容"
                    : radar.configured
                      ? "正在等待来源更新"
                      : "还没有自己的阅读材料"}
                </h3>
                <p>
                  {items.length
                    ? "调整分类、来源或搜索词后继续浏览。"
                    : radar.configured
                      ? "服务器取得内容后会自动出现在这里。可以在来源管理中查看进度。"
                      : "导入链接或收藏就能开始整理；持续来源可在需要时连接信息服务。"}
                </p>
                {!radar.configured && onImport ? (
                  <button className="button primary small" onClick={onImport}>
                    导入链接或收藏
                  </button>
                ) : null}
                <button className="button secondary small" onClick={onSources}>
                  查看来源
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
