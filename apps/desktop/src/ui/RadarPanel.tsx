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
  savedNews,
  sourceNameForMaterial,
  topicEditionHistory,
  topicMatchesNews,
  type RadarResearchAnchor,
} from "../core/radar-reading";
import {
  canSplitReader,
  editionCardMeta,
  editionFeed,
  editionImage,
  organizeEmptyCopy,
} from "../core/radar-workbench";
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

function CardImage({
  image,
}: {
  image: { url: string; credit?: string | null };
}) {
  const [ok, setOk] = useState(true);
  if (!ok) return null;
  return (
    <figure className="radar-card-image">
      <img src={image.url} alt="" onError={() => setOk(false)} />
      {image.credit ? <figcaption>{image.credit}</figcaption> : null}
    </figure>
  );
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
  const editionCards = useMemo(() => {
    const needle = view.query.trim().toLocaleLowerCase();
    return editionFeed(data, view.scope, view.topicId).filter((edition) => {
      if (!needle) return true;
      const topicTitle =
        data.radar.topics.find((item) => item.id === edition.topicId)?.title ??
        "";
      return (edition.insight.title + edition.insight.summary + topicTitle)
        .toLocaleLowerCase()
        .includes(needle);
    });
  }, [data, view.scope, view.topicId, view.query]);
  const showingSources = view.surface === "sources";

  const object = view.object;
  const selected =
    object?.kind === "edition"
      ? data.radar.editions.find((item) => item.id === object.id)
      : undefined;
  const previousEditions = selected
    ? topicEditionHistory(data.radar.editions, selected.topicId).filter(
        (item) => item.id !== selected.id,
      )
    : [];
  const readingMaterial =
    object?.kind === "material"
      ? data.materials.find(
          (item) => item.id === object.id && item.version === object.version,
        ) ?? openingMaterial
      : undefined;
  const queue = view.queue.length
    ? view.queue
    : showingSources
      ? visible.map((item) => newsRef(item.primary))
      : editionCards.map((edition) => ({
          kind: "edition" as const,
          id: edition.id,
        }));
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
      ? showingSources
        ? visible.map((item) => newsRef(item.primary))
        : editionCards.map((edition) => ({
            kind: "edition" as const,
            id: edition.id,
          }))
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
    const sync = () => setWide(canSplitReader(node.clientWidth));
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

  async function organize(topic: RadarTopic, retry = false) {
    setBusy(topic.id);
    try {
      await command<RadarJob>({
        type: "radar-organize",
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

  const articleMode = Boolean(selected || readingMaterial);
  const showResearchColumn = articleMode && wide;
  const showResearchPage = articleMode && !wide && (askOpen || researchPage);

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

  const boundResearch = showObjectResearch ? research : (
    <section className="decision-window" aria-label="围绕当前内容讨论">
      <header className="decision-window-head"><div><strong>与团队讨论</strong><p className="muted">{selected ? "这份解读" : "这篇材料"}</p></div></header>
      <div className="decision-window-body"><p>核查依据、了解背景，或决定下一步。</p><button className="primary" onClick={askAboutCurrent}>开始讨论</button></div>
    </section>
  );
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
      <div className="radar-toolbar">
        <div className="radar-views" role="tablist" aria-label="视图">
          <button
            type="button"
            aria-selected={!showingSources}
            onClick={() => persist({ ...view, surface: "editions" })}
          >
            解读
          </button>
          <button
            type="button"
            aria-selected={showingSources}
            onClick={() => persist({ ...view, surface: "sources" })}
          >
            来源材料
          </button>
        </div>
        <div className="radar-scopes" role="tablist" aria-label="筛选">
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
        </div>
        <input
          aria-label={showingSources ? "搜索来源材料" : "搜索解读"}
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
            {boundResearch}
          </section>
        ) : articleMode && selected ? (
          <article className="radar-article" ref={mainRef}>
            <p className="radar-kicker">
              {currentTopic?.title ??
                data.radar.topics.find((item) => item.id === selected.topicId)
                  ?.title ??
                "议题"}{" "}
              · 保存于 {formatRadarTime(selected.createdAt)}
              {selected.processing
                ? " · 公开材料已经过中性整理"
                : " · 以往发布的解读"}
            </p>
            <h1>{selected.insight.title}</h1>
            <p className="lede">{selected.insight.summary}</p>
            {selected.previousId && selected.insight.changes.length ? (
              <section className="radar-edition-changes">
                <h2>相对此前解读的变化</h2>
                <ul>
                  {selected.insight.changes.map((change, index) => (
                    <li key={index}>{change}</li>
                  ))}
                </ul>
              </section>
            ) : null}
            <div className="radar-article-body">
              {selected.insight.sections.map((section, index) => (
                <section key={index}>
                  <h2>{section.heading}</h2>
                  <Markdown>{section.body}</Markdown>
                  <p className="muted">
                    依据 {section.sources.join("、")}
                  </p>
                </section>
              ))}
            </div>
            {selected.insight.limitations.length ? (
              <section>
                <h2>未决与覆盖边界</h2>
                <ul>
                  {selected.insight.limitations.map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
              </section>
            ) : null}
            {previousEditions.length ? (
              <section>
                <h2>以往发布的解读</h2>
                <p className="muted">
                  日期是解读保存时间，不是事件发生时间。
                </p>
                {previousEditions.map((item) => (
                  <button
                    type="button"
                    className="text-action"
                    key={item.id}
                    onClick={() => openObject({ kind: "edition", id: item.id })}
                  >
                    v{item.number} {item.title}
                  </button>
                ))}
              </section>
            ) : null}
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
            {readingMaterial.derived?.status === "ready" ? (
              <section className="radar-derived">
                <p className="radar-kicker">中性整理 · 不是原文</p>
                <h2>{readingMaterial.derived.titleZh}</h2>
                <p>{readingMaterial.derived.digest}</p>
                <ul>
                  {readingMaterial.derived.keypoints.map((point, index) => (
                    <li key={index}>
                      {point.text}
                      <small>「{point.quote}」</small>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
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
                <p className="radar-kicker">来源原文</p>
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
          <section
            className={`radar-stream ${showingSources ? "sources" : "editions"}`}
            ref={mainRef}
            aria-label={showingSources ? "来源材料" : "解读"}
          >
            {!showingSources && !editionCards.length ? (
              <div className="empty">
                <h2>还没有已发布的解读</h2>
                <p>{organizeEmptyCopy(currentTopic)}</p>
                <RadarSupplyNote data={data} />
                {currentTopic ? (
                  <button
                    type="button"
                    className="primary"
                    disabled={busy === currentTopic.id}
                    onClick={() => void organize(currentTopic)}
                  >
                    {busy === currentTopic.id ? "正在整理…" : "整理一次"}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="primary"
                    onClick={() => setFollowOpen(true)}
                  >
                    关注话题
                  </button>
                )}
                <button
                  type="button"
                  className="quiet"
                  onClick={() => persist({ ...view, surface: "sources" })}
                >
                  查看来源原文
                </button>
                {currentTopic && editionJobStatus(data, currentTopic.id) ? (
                  <p className="muted">
                    {editionJobStatus(data, currentTopic.id)?.message}
                  </p>
                ) : null}
              </div>
            ) : null}
            {!showingSources
              ? editionCards.map((edition, index) => {
                  const meta = editionCardMeta(data, edition);
                  const image = editionImage(data, edition);
                  return (
                    <article
                      className={`radar-card ${index === 0 ? "lead" : ""}`}
                      key={edition.id}
                      data-radar-anchor={contentKey({
                        kind: "edition",
                        id: edition.id,
                      })}
                    >
                      {image ? <CardImage image={image} /> : null}
                      <div className="radar-card-copy">
                      <p className="radar-kicker">{meta.topic}</p>
                      <button
                        type="button"
                        className="radar-item-title"
                        onClick={() =>
                          openObject({ kind: "edition", id: edition.id }, true)
                        }
                      >
                        {edition.insight.title}
                      </button>
                      <p className="radar-item-lede">{edition.insight.summary}</p>
                      {meta.change ? (
                        <p className="radar-card-change">变化：{meta.change}</p>
                      ) : null}
                      <p className="radar-card-footer">{meta.footer}</p>
                      </div>
                    </article>
                  );
                })
              : null}
            {showingSources && !visible.length ? (
              <div className="empty">
                <h2>这个范围内还没有来源材料</h2>
                <RadarSupplyNote data={data} />
              </div>
            ) : null}
            {showingSources
              ? visible.map((item) => {
                  const shown = displayNewsText(item.primary);
                  const image = item.primary.image;
                  return (
                    <article
                      className="radar-card source-card"
                      key={item.key}
                      data-radar-anchor={contentKey(newsRef(item.primary))}
                    >
                      {image ? <CardImage image={image} /> : null}
                      <p className="radar-kicker">
                        {sourceNameForMaterial(data, item.primary)} ·{" "}
                        {formatRadarTime(newsSortTime(item.primary))} ·{" "}
                        {coverageKindLabel(item.primary)}
                      </p>
                      <button
                        type="button"
                        className="radar-item-title"
                        onClick={() => openObject(newsRef(item.primary), true)}
                      >
                        {item.primary.derived?.status === "ready"
                          ? item.primary.derived.titleZh
                          : item.primary.title}
                      </button>
                      <p className="radar-item-lede">
                        {item.primary.derived?.status === "ready"
                          ? item.primary.derived.digest
                          : shown.lede}
                      </p>
                    </article>
                  );
                })
              : null}
            {currentTopic ? (
              <p className="radar-topic-tools">
                <button
                  type="button"
                  className="quiet"
                  disabled={busy === currentTopic.id}
                  onClick={() => void organize(currentTopic)}
                >
                  整理一次
                </button>
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
          <aside className="radar-research-pane" aria-label="团队">
            {boundResearch}
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
