import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Markdown from "./Markdown";
import { Bookmark, RefreshCw } from "lucide-react";
import type { Material, Snapshot } from "../core/types";
import {
  coverageLabel,
  type RadarContentRef,
  type RadarEdition,
  type RadarJob,
  type RadarTopic,
  type RadarView,
  type TopicInput,
} from "../core/radar-contract";
import { command } from "./api";
import { Dialog } from "./Dialog";
import { IconButton } from "./Composer";
import { RadarSupplyNote } from "./RadarHighlights";
import {
  activeRadarTopics,
  collectNewsItems,
  contentKey,
  coverageKindLabel,
  displayNewsText,
  editionJobStatus,
  filterNewsQuery,
  followedNews,
  formatRadarTime,
  newsSortTime,
  radarResearchShows,
  readingForMaterial,
  researchDraftId,
  resolveRadarView,
  savedEditions,
  savedNews,
  sourceNameForMaterial,
  topicMatchesNews,
  type RadarResearchAnchor,
} from "../core/radar-reading";
import { FeedsPanel } from "./FeedsPanel";
import { RadarAutomationEditor } from "./RadarAutomation";
import { visibleRadarMaterials } from "../core/material-list";
import { RadarFollow } from "./RadarFollow";
import { RadarContext } from "./RadarContext";

function TopicEditor({
  data,
  topic,
  onClose,
  onSaved,
}: {
  data: Snapshot;
  topic: RadarTopic;
  onClose: () => void;
  onSaved: (topic: RadarTopic) => void;
}) {
  const [title, setTitle] = useState(topic.title),
    [focus, setFocus] = useState(topic.focus),
    [feedIds, setFeedIds] = useState(topic.feedIds ?? []),
    [feedLimit, setFeedLimit] = useState(topic.feedLimit ?? 8),
    [sources, setSources] = useState<TopicInput["sources"]>(topic.sources ?? []),
    [query, setQuery] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const materials = visibleRadarMaterials(
    data.materials.filter((item) => item.coverage !== "radar"),
  );
  return (
    <Dialog title="来源范围" onClose={onClose}>
      <form
        className="topic-editor"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          void command<RadarTopic>({
            type: "radar-topic",
            topic: {
              id: topic.id,
              revision: topic.revision,
              title,
              focus,
              sources,
              feedIds,
              feedLimit,
              sourceIds: topic.sourceIds,
              keywords: topic.keywords,
              matchRules: topic.matchRules,
            },
          })
            .then(onSaved)
            .catch((err) =>
              setError(err instanceof Error ? err.message : String(err)),
            )
            .finally(() => setBusy(false));
        }}
      >
        <label>
          名称
          <input
            aria-label="话题名称"
            value={title}
            maxLength={120}
            required
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label>
          关注重点
          <textarea
            aria-label="话题关注范围"
            rows={2}
            value={focus}
            maxLength={2000}
            onChange={(event) => setFocus(event.target.value)}
          />
        </label>
        {data.feeds.length ? (
          <fieldset className="topic-feeds">
            <legend>个人订阅</legend>
            {data.feeds.map((feed) => (
              <label className="material-check" key={feed.id}>
                <input
                  type="checkbox"
                  checked={feedIds.includes(feed.id)}
                  disabled={!feedIds.includes(feed.id) && feedIds.length >= 5}
                  onChange={(event) =>
                    setFeedIds(
                      event.target.checked
                        ? [...feedIds, feed.id]
                        : feedIds.filter((id) => id !== feed.id),
                    )
                  }
                />
                {feed.name}
              </label>
            ))}
            {feedIds.length ? (
              <label>
                每次最多选入
                <input
                  type="number"
                  min={1}
                  max={18}
                  value={feedLimit}
                  onChange={(event) => setFeedLimit(Number(event.target.value))}
                />
              </label>
            ) : null}
          </fieldset>
        ) : null}
        <input
          aria-label="查找已选材料"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="查找材料…"
        />
        <div className="topic-materials">
          {materials
            .filter((item) =>
              item.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
            )
            .map((item) => {
              const selected = sources.find((source) => source.materialId === item.id);
              return (
                <label className="material-check" key={item.id}>
                  <input
                    type="checkbox"
                    checked={!!selected}
                    disabled={busy || (!selected && sources.length >= 18)}
                    onChange={(event) =>
                      setSources(
                        event.target.checked
                          ? [
                              ...sources,
                              { materialId: item.id, policy: "auto", reason: "手选" },
                            ]
                          : sources.filter((source) => source.materialId !== item.id),
                      )
                    }
                  />
                  <span>
                    {item.title}
                    <small>
                      {coverageLabel(item.coverage)} · v{item.version}
                    </small>
                  </span>
                </label>
              );
            })}
        </div>
        {error ? (
          <p className="error-inline" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button className="primary" disabled={busy || !title.trim()}>
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function newsRef(material: Material): RadarContentRef {
  return { kind: "material", id: material.id, version: material.version };
}

function sameRef(a: RadarContentRef | null, b: RadarContentRef | null) {
  if (!a || !b) return a === b;
  return contentKey(a) === contentKey(b);
}

export function RadarPanel({
  data,
  selectedId,
  openingMaterial,
  openingTopicId,
  openingKey,
  onSelect,
  onUse,
  onUseMaterial,
  onWork,
  onSync,
  syncing,
  onError,
  onPrepare,
  onExpandDiscussion,
  onBrowseDraft,
  research,
  researchAnchor,
}: {
  data: Snapshot;
  selectedId: string | null;
  openingMaterial?: Material | null;
  openingTopicId?: string | null;
  openingKey?: number;
  onSelect: (id: string | null) => void;
  onUse: (edition: RadarEdition) => void;
  onUseMaterial: (
    material: Material,
    topic?: RadarTopic | null,
    excerpt?: string,
  ) => void;
  onTrace?: (topic: RadarTopic) => void;
  onWork: (id: string, contentKey?: string) => void;
  onSync: () => void;
  syncing: boolean;
  onError: (error: unknown) => void;
  onPrepare: (text: string, topic?: RadarTopic) => void;
  onExpandDiscussion?: () => void;
  onBrowseDraft?: (draftId: string | null) => void;
  research?: ReactNode;
  researchAnchor?: RadarResearchAnchor | null;
}) {
  const [view, setView] = useState<RadarView>(() =>
    resolveRadarView(data, data.radar.view),
  );
  const [followOpen, setFollowOpen] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [researchPage, setResearchPage] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [wide, setWide] = useState(false);
  const [editing, setEditing] = useState<RadarTopic | null>(null);
  const [automation, setAutomation] = useState<RadarTopic | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [feedsOpen, setFeedsOpen] = useState(false);
  const [topicMenu, setTopicMenu] = useState<string | null>(null);
  const [excerpt, setExcerpt] = useState("");
  const [followedHint, setFollowedHint] = useState<RadarTopic | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const pageRef = useRef<HTMLElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const scrollBound = useRef<{
    kind: "list" | "article";
    key: string;
    object: RadarContentRef | null;
  }>({ kind: "list", key: "", object: null });

  const topics = activeRadarTopics(data.radar.topics);
  const currentTopic =
    view.scope === "topic"
      ? topics.find((item) => item.id === view.topicId) ?? null
      : null;

  const list = useMemo(() => {
    if (view.scope === "saved")
      return savedNews(data).map((entry) => ({
        ...entry.item,
        primary: entry.pinned,
      }));
    if (view.scope === "followed") return followedNews(data);
    if (view.scope === "topic" && currentTopic)
      return topicMatchesNews(data, currentTopic);
    return collectNewsItems(data.materials);
  }, [data, view.scope, currentTopic?.id, currentTopic?.revision]);
  const visible = filterNewsQuery(list, view.query);
  const editions = view.scope === "saved" ? savedEditions(data) : [];
  const topicEditions =
    view.scope === "topic" && currentTopic
      ? data.radar.editions
          .filter((item) => item.topicId === currentTopic.id)
          .sort((a, b) => b.number - a.number)
      : [];

  const object = view.object;
  const selected =
    object?.kind === "edition"
      ? data.radar.editions.find((item) => item.id === object.id)
      : undefined;
  const readingMaterial =
    object?.kind === "material"
      ? data.materials.find(
          (item) => item.id === object.id && item.version === object.version,
        ) ?? openingMaterial
      : undefined;
  const queue = view.queue.length ? view.queue : visible.map((item) => newsRef(item.primary));
  const queueIndex = object
    ? queue.findIndex((item) => sameRef(item, object))
    : -1;
  const display = readingMaterial ? displayNewsText(readingMaterial) : null;
  const readingState = selected
    ? data.radar.reading.find((item) => item.id === selected.id)
    : readingMaterial
      ? readingForMaterial(data.radar.reading, readingMaterial.id)
      : undefined;
  const content = object ? contentKey(object) : null;
  const showFollowResearch = radarResearchShows(
    researchAnchor ?? null,
    researchAnchor?.contextId ?? "",
    "follow",
    followOpen || planning,
    content,
  );
  const showObjectResearch = radarResearchShows(
    researchAnchor ?? null,
    researchAnchor?.contextId ?? "",
    "object",
    followOpen || planning,
    content,
  );

  function persist(next: RadarView) {
    const resolved = resolveRadarView(data, next);
    viewRef.current = resolved;
    setView(resolved);
    void command({ type: "radar-view", view: resolved }).catch(onError);
    return resolved;
  }

  function captureScroll(): Pick<RadarView, "listOffset" | "listAnchor"> | Record<string, never> {
    const page = mainRef.current;
    const bound = scrollBound.current;
    if (!page) return {};
    if (bound.kind === "list")
      return { listOffset: page.scrollTop, listAnchor: view.listAnchor };
    return {};
  }

  function flushArticleScroll() {
    const page = mainRef.current;
    const bound = scrollBound.current;
    if (!page || bound.kind !== "article" || !bound.object) return;
    if (bound.object.kind === "edition")
      void command({
        type: "radar-reading",
        editionId: bound.object.id,
        patch: { scroll: page.scrollTop },
      }).catch(onError);
    if (bound.object.kind === "material")
      void command({
        type: "radar-reading",
        materialId: bound.object.id,
        version: bound.object.version,
        patch: { scroll: page.scrollTop },
      }).catch(onError);
  }

  function closeTemps() {
    setFollowOpen(false);
    setPlanning(false);
    setAskOpen(false);
    setResearchPage(false);
    setSourceOpen(false);
    setTopicMenu(null);
  }

  function openList(scope: RadarView["scope"], topicId: string | null = null) {
    flushArticleScroll();
    closeTemps();
    persist({
      ...view,
      ...captureScroll(),
      ...(scope !== view.scope || topicId !== view.topicId ? { listOffset: 0, listAnchor: null } : {}),
      scope,
      topicId,
      object: null,
      returnStack: [],
      queue: [],
    });
    onSelect(null);
    onBrowseDraft?.(null);
  }

  function openObject(next: RadarContentRef, fromList = false) {
    flushArticleScroll();
    const listState = fromList ? captureScroll() : {};
    const stack = view.object && !fromList
      ? [...view.returnStack, view.object].slice(-8)
      : fromList
        ? []
        : view.returnStack;
    const nextQueue = fromList
      ? visible.map((item) => newsRef(item.primary))
      : view.queue;
    persist({
      ...view,
      ...listState,
      object: next,
      returnStack: stack,
      queue: nextQueue,
      listAnchor: fromList ? next : view.listAnchor,
      researchRef: view.researchRef,
      workId: view.workId,
    });
    setAskOpen(false);
    setResearchPage(false);
    setFollowOpen(false);
    setPlanning(false);
    if (next.kind === "edition") onSelect(next.id);
    else onSelect(null);
  }

  useEffect(() => {
    const node = pageRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const sync = () => setWide(node.clientWidth >= 1120);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (openingKey === undefined) return;
    setFollowOpen(false);
    setPlanning(false);
    if (selectedId) {
      const edition = data.radar.editions.find((item) => item.id === selectedId);
      if (edition) openObject({ kind: "edition", id: edition.id }, true);
      return;
    }
    if (openingMaterial) {
      openObject(newsRef(openingMaterial), true);
      return;
    }
    if (openingTopicId) {
      openList("topic", openingTopicId);
    }
  }, [openingKey]);

  useEffect(() => {
    if (!researchAnchor || researchAnchor.kind !== "object" || !object) return;
    if (researchAnchor.contentKey !== contentKey(object)) return;
    if (researchAnchor.contextId.startsWith("new:")) return;
    if (
      view.workId === researchAnchor.contextId &&
      view.researchRef &&
      contentKey(view.researchRef) === contentKey(object)
    )
      return;
    persist({
      ...view,
      workId: researchAnchor.contextId,
      researchRef: object,
    });
  }, [researchAnchor?.contextId, object ? contentKey(object) : ""]);

  useEffect(() => {
    if (!planning || !researchAnchor) return;
    if (
      data.workspaceActions.some(
        (item) =>
          item.workId === researchAnchor.contextId && item.status === "applied",
      )
    ) {
      setFollowOpen(false);
      setPlanning(false);
    }
  }, [data.workspaceActions, planning, researchAnchor?.contextId]);

  useEffect(() => {
    if (followOpen && planning) {
      onBrowseDraft?.(null);
      return;
    }
    if (!object) {
      onBrowseDraft?.(null);
      return;
    }
    onBrowseDraft?.(
      researchDraftId(
        data,
        object.kind === "edition"
          ? { kind: "edition", id: object.id }
          : { kind: "material", id: object.id, version: object.version },
      ),
    );
  }, [object, followOpen, planning]);

  useEffect(() => {
    setView((current) =>
      resolveRadarView(data, {
        ...current,
        listOffset: viewRef.current.listOffset,
      }),
    );
  }, [data.materials, data.works, data.radar.topics, data.radar.editions]);

  useLayoutEffect(() => {
    const page = mainRef.current;
    if (!page) return;
    const key = object
      ? contentKey(object)
      : `list:${view.scope}:${view.topicId ?? ""}:${view.query}`;
    scrollBound.current = {
      kind: object ? "article" : "list",
      key,
      object: object ?? null,
    };
    if (object?.kind === "material")
      page.scrollTop = readingState?.positions?.[String(object.version)] ?? 0;
    else if (object?.kind === "edition") page.scrollTop = readingState?.scroll ?? 0;
    else {
      page.scrollTop = view.listOffset ?? 0;
      if (view.listAnchor) {
        const node = page.querySelector<HTMLElement>(
          `[data-radar-anchor="${contentKey(view.listAnchor)}"]`,
        );
        if (node) node.scrollIntoView({ block: "nearest" });
      }
    }
    if (object?.kind === "edition")
      void command({
        type: "radar-reading",
        editionId: object.id,
        patch: { read: true },
      }).catch(onError);
    if (object?.kind === "material")
      void command({
        type: "radar-reading",
        materialId: object.id,
        version: object.version,
        patch: { read: true },
      }).catch(onError);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let top = page.scrollTop;
    const save = () => {
      const bound = { ...scrollBound.current };
      if (bound.key !== key) return;
      if (bound.kind === "list") {
        const current = viewRef.current;
        if (current.object || key !== `list:${current.scope}:${current.topicId ?? ""}:${current.query}`) return;
        const next = { ...viewRef.current, listOffset: top };
        viewRef.current = next;
        void command({ type: "radar-view", view: next }).catch(onError);
        return;
      }
      if (!bound.object) return;
      if (bound.object.kind === "edition")
        void command({
          type: "radar-reading",
          editionId: bound.object.id,
          patch: { scroll: top },
        }).catch(onError);
      if (bound.object.kind === "material")
        void command({
          type: "radar-reading",
          materialId: bound.object.id,
          version: bound.object.version,
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
      clearTimeout(timer);
      save();
    };
  }, [object ? contentKey(object) : `list:${view.scope}:${view.topicId ?? ""}:${view.query}`, askOpen && (!wide || researchPage)]);

  async function refresh(topic: RadarTopic, retry = false) {
    setBusy(topic.id);
    try {
      await command<RadarJob>({
        type: "radar-refresh",
        topicId: topic.id,
        retry,
      });
    } catch (error) {
      onError(error);
    } finally {
      setBusy(null);
    }
  }

  async function unfollow(topic: RadarTopic) {
    try {
      await command({
        type: "radar-archive-topic",
        id: topic.id,
        revision: topic.revision,
        archived: true,
      });
      setNotice("已取消关注。收藏和研究还在。");
      if (view.topicId === topic.id) openList(topics.length > 1 ? "followed" : "all");
    } catch (error) {
      onError(error);
    }
  }

  function toggleSaved() {
    if (selected)
      void command({
        type: "radar-reading",
        editionId: selected.id,
        patch: { saved: !readingState?.saved },
      }).catch(onError);
    if (readingMaterial)
      void command({
        type: "radar-reading",
        materialId: readingMaterial.id,
        version: readingMaterial.version,
        patch: {
          saved: readingState?.savedRef?.version === readingMaterial.version
            ? !readingState.saved
            : true,
          pinSavedVersion:
            readingState?.saved &&
            readingState.savedRef?.version !== readingMaterial.version,
        },
      }).catch(onError);
  }

  const asking = askOpen;
  const articleMode = Boolean(selected || readingMaterial);
  const showResearchColumn = asking && wide && !researchPage;
  const showResearchPage = asking && (!wide || researchPage);

  function continueWork(id: string) {
    flushArticleScroll();
    setAskOpen(true);
    if (!wide) setResearchPage(true);
    onWork(id, object ? contentKey(object) : undefined);
  }

  function askAboutCurrent() {
    flushArticleScroll();
    setAskOpen(true);
    if (!wide) setResearchPage(true);
    if (view.workId && view.researchRef && object && contentKey(view.researchRef) === contentKey(object) && !excerpt) {
      continueWork(view.workId);
      return;
    }
    if (selected) onUse(selected);
    else if (readingMaterial)
      onUseMaterial(readingMaterial, currentTopic, excerpt || undefined);
  }

  return (
    <section className="radar-page" ref={pageRef}>
      {articleMode ? (
        <div className="radar-read-bar">
          <button
            type="button"
            className="quiet"
            onClick={() => openList(view.scope, view.topicId)}
          >
            返回{view.scope === "saved" ? "收藏" : "列表"}
          </button>
          <IconButton
            label={readingState?.saved ? "取消收藏" : "收藏"}
            aria-pressed={
              selected
                ? (readingState?.saved ?? false)
                : Boolean(
                    readingState?.saved &&
                      readingMaterial &&
                      readingState.savedRef?.version === readingMaterial.version,
                  )
            }
            onClick={toggleSaved}
          >
            <Bookmark
              size={18}
              fill={
                (selected ? readingState?.saved : readingState?.saved &&
                  readingState.savedRef?.version === readingMaterial?.version)
                  ? "currentColor"
                  : "none"
              }
            />
          </IconButton>
          <button type="button" className="primary" onClick={askAboutCurrent}>
            问 AI
          </button>
          <details className="radar-more">
            <summary>更多</summary>
            <button
              type="button"
              disabled={queueIndex <= 0}
              onClick={() => openObject(queue[queueIndex - 1])}
            >
              上一篇
            </button>
            <button
              type="button"
              disabled={queueIndex < 0 || queueIndex >= queue.length - 1}
              onClick={() => openObject(queue[queueIndex + 1])}
            >
              下一篇
            </button>
            {readingMaterial?.url ? (
              <a href={readingMaterial.url} target="_blank" rel="noreferrer">
                原文↗
              </a>
            ) : null}
            {currentTopic ? (
              <button type="button" onClick={() => setTopicMenu(currentTopic.id)}>
                话题选项
              </button>
            ) : null}
          </details>
        </div>
      ) : (
        <>
      <header className="radar-head">
        <div>
          <h1>雷达</h1>
        </div>
        <div className="tool-group">
          <button type="button" disabled={syncing} onClick={onSync}>
            <RefreshCw size={15} />
            {syncing ? "同步中…" : "同步"}
          </button>
          <button
            type="button"
            className="primary"
            aria-expanded={followOpen}
            onClick={() => {
              setFollowOpen(true);
              setPlanning(false);
            }}
          >
            关注话题
          </button>
        </div>
      </header>
      <div className="radar-scopes" role="tablist" aria-label="范围">
        <button
          type="button"
          aria-selected={view.scope === "all"}
          onClick={() => openList("all")}
        >
          全部
        </button>
        <button
          type="button"
          aria-selected={view.scope === "followed"}
          onClick={() => openList("followed")}
        >
          关注
        </button>
        {topics.slice(0, 5).map((topic) => (
          <button
            type="button"
            key={topic.id}
            aria-selected={view.scope === "topic" && view.topicId === topic.id}
            onClick={() => openList("topic", topic.id)}
            onContextMenu={(event) => {
              event.preventDefault();
              setTopicMenu(topic.id);
            }}
          >
            {topic.title}
          </button>
        ))}
        {topics.length > 5 ? (
          <details className="radar-more-topics">
            <summary>更多话题</summary>
            {topics.slice(5).map((topic) => (
              <button
                type="button"
                key={topic.id}
                onClick={() => openList("topic", topic.id)}
              >
                {topic.title}
              </button>
            ))}
          </details>
        ) : null}
        <button
          type="button"
          aria-selected={view.scope === "saved"}
          onClick={() => openList("saved")}
        >
          收藏
        </button>
        <input
          aria-label="搜索新闻"
          value={view.query}
          onChange={(event) =>
            persist({ ...view, query: event.target.value, listOffset: 0, listAnchor: null })
          }
          placeholder="搜索"
        />
      </div>
        </>
      )}
      {followedHint ? (
        <p className="muted">
          已关注「{followedHint.title}」。
          <button
            type="button"
            className="text-action"
            onClick={() => {
              setFollowedHint(null);
              openList("topic", followedHint.id);
            }}
          >
            查看这个话题
          </button>
        </p>
      ) : null}
      {notice ? <p className="muted">{notice}</p> : null}
      {topicMenu ? (
        <div className="radar-topic-menu">
          {topics
            .filter((topic) => topic.id === topicMenu)
            .map((topic) => (
              <div key={topic.id}>
                <button type="button" onClick={() => setEditing(topic)}>
                  来源范围
                </button>
                <button type="button" onClick={() => setAutomation(topic)}>
                  自动整理
                </button>
                <button type="button" onClick={() => void unfollow(topic)}>
                  取消关注
                </button>
                <button type="button" className="quiet" onClick={() => setTopicMenu(null)}>
                  关闭
                </button>
              </div>
            ))}
        </div>
      ) : null}
      {followOpen ? (
        <RadarFollow
          data={data}
          draft={view.followDraft}
          planning={planning || showFollowResearch}
          research={showFollowResearch ? research : undefined}
          onDraft={(value) => persist({ ...view, followDraft: value })}
          onClose={() => {
            setFollowOpen(false);
            setPlanning(false);
          }}
          onFollowed={(topic, outcome) => {
            setFollowOpen(false);
            setPlanning(false);
            setFollowedHint(topic);
            persist({ ...view, followDraft: "" });
            if (outcome === "located")
              setNotice("已打开同名关注，没有重复创建");
            if (outcome === "created-beside-archive")
              setNotice("已有同名归档话题，这次新建了当前关注。");
          }}
          onPlan={(intent) => {
            setPlanning(true);
            onPrepare(intent);
          }}
          onError={onError}
        />
      ) : null}
      <div
        className={`radar-body ${showResearchColumn ? "with-research" : ""}`}
      >
        {showResearchPage ? (
          <section className="radar-research-page" aria-label="提问">
            <button
              type="button"
              className="quiet"
              onClick={() => {
                setAskOpen(false);
                setResearchPage(false);
              }}
            >
              返回正文
            </button>
            {showObjectResearch ? research : null}
          </section>
        ) : articleMode && selected ? (
          <article className="radar-article" ref={mainRef}>
            <p className="radar-kicker">
              {currentTopic?.title ?? "解读"} · 保存于 {formatRadarTime(selected.createdAt)}
            </p>
            <h1>{selected.insight.title}</h1>
            <p className="lede">{selected.insight.summary}</p>
            <div className="radar-article-body">
              {selected.insight.sections.map((section, index) => (
                <section key={index}>
                  <h2>{section.heading}</h2>
                  <Markdown>{section.body}</Markdown>
                </section>
              ))}
            </div>
            <RadarContext
              data={data}
              topic={data.radar.topics.find((item) => item.id === selected.topicId)}
              edition={selected}
              onOpenEdition={(id) => openObject({ kind: "edition", id })}
              onOpenMaterial={(material) => openObject(newsRef(material))}
              onContinue={(work) => continueWork(work.id)}
            />
          </article>
        ) : articleMode && readingMaterial ? (
          <article
            className="radar-article"
            ref={mainRef}
            onMouseUp={() => {
              const text = window.getSelection()?.toString().trim() ?? "";
              setExcerpt(text.slice(0, 400));
            }}
          >
            <p className="radar-kicker">
              {sourceNameForMaterial(data, readingMaterial)} ·{" "}
              {formatRadarTime(newsSortTime(readingMaterial))} ·{" "}
              {coverageKindLabel(readingMaterial)}
            </p>
            <h1>{readingMaterial.title}</h1>
            {display?.titleOnly ? (
              <p className="muted">
                这篇只有标题
                {readingMaterial.url ? (
                  <>
                    ，可{" "}
                    <a
                      href={readingMaterial.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      查看原文
                    </a>
                  </>
                ) : (
                  "，没有正文。"
                )}
              </p>
            ) : (
              <div className="radar-article-body">
                <Markdown>{display?.body ?? ""}</Markdown>
                {readingMaterial.url ? (
                  <p className="muted">
                    来源节选到此，
                    <a href={readingMaterial.url} target="_blank" rel="noreferrer">
                      查看原文↗
                    </a>
                  </p>
                ) : null}
              </div>
            )}
            <button
              type="button"
              className="quiet"
              aria-expanded={sourceOpen}
              onClick={() => setSourceOpen((value) => !value)}
            >
              出处详情
            </button>
            {sourceOpen ? (
              <div className="radar-source-detail">
                <p>
                  {coverageKindLabel(readingMaterial)} · v{readingMaterial.version}
                </p>
                {readingMaterial.url ? (
                  <p>
                    <a
                      href={readingMaterial.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {readingMaterial.url}
                    </a>
                  </p>
                ) : null}
                {readingState?.savedRef &&
                readingState.savedRef.version !== readingMaterial.version ? (
                  <p className="muted">
                    收藏的是 v{readingState.savedRef.version}。
                    <button
                      type="button"
                      className="text-action"
                      onClick={() =>
                        openObject({
                          kind: "material",
                          id: readingMaterial.id,
                          version: readingState.savedRef!.version,
                        })
                      }
                    >
                      打开收藏版本
                    </button>
                  </p>
                ) : null}
              </div>
            ) : null}
            <RadarContext
              data={data}
              topic={currentTopic}
              material={readingMaterial}
              onOpenEdition={(id) => openObject({ kind: "edition", id })}
              onOpenMaterial={(material) => openObject(newsRef(material))}
              onContinue={(work) => continueWork(work.id)}
            />
          </article>
        ) : (
          <section className="radar-stream" ref={mainRef} aria-label="新闻">
            {view.scope === "followed" && !visible.length ? (
              <div className="empty">
                <h2>关注范围内还没有新闻</h2>
                <p>没有把其他来源混进来。</p>
                <button type="button" onClick={() => openList("all")}>
                  看看全部新闻
                </button>
              </div>
            ) : null}
            {view.scope === "all" && !visible.length ? (
              <div className="empty">
                <h2>还没有可读的新闻</h2>
                <RadarSupplyNote data={data} />
                <button
                  type="button"
                  className="primary"
                  onClick={() => setFollowOpen(true)}
                >
                  关注话题
                </button>
              </div>
            ) : null}
            {view.scope === "topic" && currentTopic && !visible.length ? (
              <div className="empty">
                <h2>这个话题还没有匹配的新闻</h2>
                <p>按标题和正文的字面规则查找，没有可靠命中时保持空白。</p>
                <button type="button" onClick={() => openList("all")}>
                  看看全部新闻
                </button>
                <button
                  type="button"
                  disabled={busy === currentTopic.id}
                  onClick={() => void refresh(currentTopic)}
                >
                  整理解读
                </button>
                {editionJobStatus(data, currentTopic.id) ? (
                  <p className="muted">
                    {editionJobStatus(data, currentTopic.id)?.message}
                  </p>
                ) : null}
              </div>
            ) : null}
            {visible.map((item) => {
              const shown = displayNewsText(item.primary);
              return (
                <article
                  className="radar-item"
                  key={item.key}
                  data-radar-anchor={contentKey(newsRef(item.primary))}
                >
                  <p className="radar-kicker">
                    {sourceNameForMaterial(data, item.primary)} ·{" "}
                    {formatRadarTime(newsSortTime(item.primary))} ·{" "}
                    {coverageKindLabel(item.primary)}
                    {item.citations.some((citation) => citation.selected)
                      ? " · 手选"
                      : ""}
                  </p>
                  <button
                    type="button"
                    className="radar-item-title"
                    onClick={() => openObject(newsRef(item.primary), true)}
                  >
                    {item.primary.title}
                  </button>
                  {shown.lede ? <p className="radar-item-lede">{shown.lede}</p> : null}
                  {item.primary.url ? (
                    <a
                      className="radar-original"
                      href={item.primary.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      原文↗
                    </a>
                  ) : null}
                </article>
              );
            })}
            {editions.map((edition) => (
              <article className="radar-item" key={edition.id}>
                <p className="radar-kicker">
                  已收藏解读 · 保存于 {formatRadarTime(edition.createdAt)}
                </p>
                <button
                  type="button"
                  className="radar-item-title"
                  onClick={() => openObject({ kind: "edition", id: edition.id }, true)}
                >
                  {edition.insight.title}
                </button>
                <p className="radar-item-lede">{edition.insight.summary}</p>
              </article>
            ))}
            {topicEditions.length ? (
              <details className="radar-topic-editions">
                <summary>这个话题的解读</summary>
                {topicEditions.map((edition) => (
                  <button
                    type="button"
                    className="text-action"
                    key={edition.id}
                    onClick={() => openObject({ kind: "edition", id: edition.id })}
                  >
                    {edition.insight.title}
                  </button>
                ))}
              </details>
            ) : null}
            {currentTopic ? (
              <p className="radar-topic-tools">
                <button type="button" className="quiet" onClick={() => setEditing(currentTopic)}>
                  来源范围
                </button>
                <button
                  type="button"
                  className="quiet"
                  onClick={() => void unfollow(currentTopic)}
                >
                  取消关注
                </button>
                <button
                  type="button"
                  className="quiet"
                  aria-expanded={feedsOpen}
                  onClick={() => setFeedsOpen((value) => !value)}
                >
                  我的订阅
                </button>
              </p>
            ) : null}
            {feedsOpen ? <FeedsPanel data={data} /> : null}
          </section>
        )}
        {showResearchColumn ? (
          <aside className="radar-research-pane" aria-label="提问">
            {showObjectResearch ? research : null}
          </aside>
        ) : null}
      </div>
      {editing ? (
        <TopicEditor
          data={data}
          topic={editing}
          onClose={() => setEditing(null)}
          onSaved={() => setEditing(null)}
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
