import {
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import {
  Archive,
  ArrowRight,
  BookOpenCheck,
  CheckCircle2,
  CircleAlert,
  ExternalLink,
  FileSearch,
  Layers3,
  Link2,
  LoaderCircle,
  MessageCircleQuestion,
  Pause,
  Play,
  Radar as RadarIcon,
  RefreshCw,
  Rss,
  Server,
  Settings2,
  Sparkles,
  Trash2,
  UserRound,
} from "lucide-react";
import type {
  RadarDigest,
  RadarDigestionRun,
  RadarDisposition,
  RadarEvidenceRevision,
  RadarFollow,
  RadarItem,
  RadarRecommendedSource,
  RadarSnapshot,
  Snapshot,
  Task,
} from "../shared/types";
import { Modal, type Dispatch } from "./common";

import { RadarReader, SourceConnectionForm } from "./RadarReader";

type RadarView = "reading" | "today" | "insights" | "inbox" | "history";

interface DigestGroup {
  digest: RadarDigest;
  evidence: {
    item?: RadarItem;
    sourceId: string;
    revisionId: string;
    revision?: RadarEvidenceRevision;
    note?: string;
    stale: boolean;
  }[];
  context: {
    sourceId: string;
    label: string;
    detail?: string;
    relation: RadarDigest["context"][number]["relation"];
    note: string;
  }[];
}

interface DispositionView {
  disposition: RadarDisposition;
  item?: RadarItem;
  revisionId?: string;
  revision?: RadarEvidenceRevision;
  stale: boolean;
}

const EMPTY_RADAR: RadarSnapshot = {
  configured: false,
  connection: "unconfigured",
  follows: [],
  recommendedSources: [],
  items: [],
  digests: [],
  dispositions: [],
  digestions: [],
  events: [],
  unreadCount: 0,
};

const CONNECTION_LABELS: Record<RadarSnapshot["connection"], string> = {
  unconfigured: "信息源服务未配置",
  connecting: "正在连接信息源服务",
  online: "信息源服务在线",
  offline: "信息源服务暂不可达",
};

const COVERAGE_LABELS: Record<RadarItem["coverageLevel"], string> = {
  listing: "仅列表信息",
  metadata: "标题与元数据",
  fulltext: "已取得正文",
  transcript: "已取得文字稿",
  vision: "已完成画面理解",
};

function formatMoment(value?: string): string {
  if (!value) return "尚未观察";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "观察时间未知";
  return date.toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function localDay(value: string): string | undefined {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function sourceHost(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function originLabel(origin: RadarItem["origin"]): string {
  return origin === "user" ? "你关注的来源" : "产品提供的来源";
}

function itemTimestamp(item: RadarItem): number {
  const value = Date.parse(item.observedAt || item.receivedAt);
  return Number.isNaN(value) ? 0 : value;
}

function revisionKey(itemId: string, revisionId: string): string {
  return `${itemId}\0${revisionId}`;
}

function shortRevision(revisionId: string): string {
  return revisionId.length > 14 ? `${revisionId.slice(0, 12)}…` : revisionId;
}

function digestItemIds(group: DigestGroup): string[] {
  return Array.from(
    new Set(
      group.evidence
        .map((evidence) => evidence.item?.id)
        .filter((itemId): itemId is string => Boolean(itemId)),
    ),
  );
}

function runForItem(
  runs: RadarDigestionRun[],
  item: RadarItem,
): RadarDigestionRun | undefined {
  return runs
    .filter(
      (run) =>
        run.state === "pending" &&
        run.items.some(
          (locked) =>
            locked.radarItemId === item.id &&
            locked.revisionId === item.latestRevisionId,
        ),
    )
    .toSorted((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    )[0];
}

function runPresentation(run?: RadarDigestionRun): {
  label: string;
  className: string;
  active: boolean;
  retryable: boolean;
} {
  if (!run)
    return {
      label: "待消化",
      className: "waiting",
      active: false,
      retryable: false,
    };
  if (run.state === "published")
    return {
      label: "已发布",
      className: "published",
      active: false,
      retryable: false,
    };
  switch (run.taskStatus) {
    case "running":
      return {
        label: "团队处理中",
        className: "processing",
        active: true,
        retryable: false,
      };
    case "waiting":
      return {
        label: "团队等待中",
        className: "waiting-team",
        active: true,
        retryable: false,
      };
    case "paused":
      return {
        label: "团队已暂停",
        className: "paused",
        active: false,
        retryable: false,
      };
    case "failed":
      return {
        label: "整理失败",
        className: "failed",
        active: false,
        retryable: true,
      };
    case "completed":
      return {
        label: "任务结束，未发布",
        className: "unpublished",
        active: false,
        retryable: true,
      };
    case "idle":
      return {
        label: "等待团队开始",
        className: "queued",
        active: false,
        retryable: false,
      };
    default:
      return {
        label: "已进入整理批次",
        className: "queued",
        active: false,
        retryable: false,
      };
  }
}

const RELATION_LABELS: Record<
  RadarDigest["context"][number]["relation"],
  string
> = {
  new: "新增",
  supports: "支持已有判断",
  extends: "补充",
  repeats: "重复",
  conflicts: "存在冲突",
};

const DISPOSITION_LABELS: Record<RadarDisposition["kind"], string> = {
  duplicate: "重复",
  outdated: "已过时",
  low_value: "价值较低",
  irrelevant: "与当前方向无关",
  incomplete: "证据不完整",
  deferred: "延期判断",
};

function FollowCard({
  follow,
  pending,
  dispatch,
  begin,
}: {
  follow: RadarFollow;
  pending: boolean;
  dispatch: Dispatch;
  begin: (key: string, action: () => Promise<Snapshot | null>) => Promise<void>;
}) {
  const host = sourceHost(follow.url);
  const stateClass = follow.lastError ? "error" : follow.state;
  const stateLabel = follow.lastError
    ? "需要处理"
    : follow.state === "paused"
      ? "已暂停"
      : "监控中";

  return (
    <article className="radar-source-card">
      <div className="radar-source-card-head">
        <div>
          <h3>{follow.name}</h3>
          <p>
            {host ? `${host} · ` : ""}
            {follow.lastSuccessAt
              ? `最近观察 ${formatMoment(follow.lastSuccessAt)}`
              : "等待首次观察"}
          </p>
        </div>
        <span className={`radar-source-state ${stateClass}`}>
          <span className={`radar-status-dot ${stateClass}`} />
          {stateLabel}
        </span>
      </div>
      {follow.lastError ? (
        <p className="radar-source-error">{follow.lastError}</p>
      ) : null}
      <div className="radar-source-card-actions">
        <button
          className="text-button"
          disabled={pending || follow.state === "paused"}
          onClick={() =>
            void begin(`refresh:${follow.id}`, () =>
              dispatch({ type: "radar.refresh", followId: follow.id }),
            )
          }
        >
          <RefreshCw size={13} className={pending ? "spin" : ""} />
          刷新
        </button>
        <button
          className="text-button"
          disabled={pending}
          onClick={() =>
            void begin(`state:${follow.id}`, () =>
              dispatch({
                type: "radar.setFollowState",
                followId: follow.id,
                state: follow.state === "paused" ? "active" : "paused",
              }),
            )
          }
        >
          {follow.state === "paused" ? <Play size={13} /> : <Pause size={13} />}
          {follow.state === "paused" ? "继续" : "暂停"}
        </button>
        <button
          className="text-button"
          disabled={pending}
          onClick={() =>
            void begin(`remove:${follow.id}`, () =>
              dispatch({ type: "radar.unfollow", followId: follow.id }),
            )
          }
        >
          <Trash2 size={13} />
          移除
        </button>
      </div>
    </article>
  );
}

function RecommendedCard({
  source,
  follow,
  pending,
  dispatch,
  begin,
}: {
  source: RadarRecommendedSource;
  follow?: RadarFollow;
  pending: boolean;
  dispatch: Dispatch;
  begin: (key: string, action: () => Promise<Snapshot | null>) => Promise<void>;
}) {
  const followed = Boolean(follow || source.followed);
  const active = follow?.state === "active";
  const stateClass = follow
    ? follow.state === "paused"
      ? "paused"
      : follow.lastError
        ? "error"
        : "online"
    : "paused";
  const stateLabel = follow
    ? follow.state === "paused"
      ? "已暂停"
      : follow.lastError
        ? "观察失败"
        : "服务器监控中"
    : followed
      ? "状态待同步"
      : "可以关注";

  return (
    <article className="radar-source-card">
      <div className="radar-source-card-head">
        <div>
          <h3>{source.name}</h3>
          <p>{source.description || source.category}</p>
        </div>
        <span className={`radar-source-state ${stateClass}`}>
          <span className={`radar-status-dot ${stateClass}`} />
          {stateLabel}
        </span>
      </div>
      {follow ? (
        <div className="radar-source-observation" aria-label="服务器观察状态">
          <span>
            {follow.lastAttemptAt
              ? `最近尝试 ${formatMoment(follow.lastAttemptAt)}`
              : "等待首次观察"}
          </span>
          {follow.lastSuccessAt ? (
            <span>最近成功 {formatMoment(follow.lastSuccessAt)}</span>
          ) : null}
          {active && follow.nextRefreshAt ? (
            <span>计划下次 {formatMoment(follow.nextRefreshAt)}</span>
          ) : null}
        </div>
      ) : null}
      {follow?.lastError ? (
        <p className="radar-source-error" role="status">
          最近观察失败：{follow.lastError}
        </p>
      ) : null}
      <div className="radar-source-card-actions">
        {followed && follow ? (
          <button
            className="text-button"
            disabled={pending}
            onClick={() =>
              void begin(`state:${follow.id}`, () =>
                dispatch({
                  type: "radar.setFollowState",
                  followId: follow.id,
                  state: active ? "paused" : "active",
                }),
              )
            }
          >
            {active ? <Pause size={13} /> : <Play size={13} />}
            {active ? "暂停监控" : "继续接收"}
          </button>
        ) : (
          <button
            className="text-button"
            disabled={pending}
            onClick={() =>
              void begin(`recommended:${source.id}`, () =>
                dispatch({
                  type: "radar.follow",
                  recommendedSourceId: source.id,
                }),
              )
            }
          >
            <Rss size={13} />
            开始接收
          </button>
        )}
        {source.url ? (
          <button
            className="text-button"
            onClick={() =>
              void dispatch({ type: "url.open", url: source.url! })
            }
          >
            <ExternalLink size={13} />
            查看来源
          </button>
        ) : null}
      </div>
    </article>
  );
}

export function SourceManager({
  radar,
  connected,
  pending,
  url,
  followInput,
  onURL,
  onSubmit,
  onRefresh,
  onClose,
  dispatch,
  begin,
}: {
  radar: RadarSnapshot;
  connected: boolean;
  pending: string | null;
  url: string;
  followInput: RefObject<HTMLInputElement | null>;
  onURL: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onRefresh: () => void;
  onClose: () => void;
  dispatch: Dispatch;
  begin: (key: string, action: () => Promise<Snapshot | null>) => Promise<void>;
}) {
  const userFollows = radar.follows.filter(
    (follow) => follow.origin === "user",
  );
  const recommendedFollows = new Map(
    radar.follows
      .filter((follow) => follow.origin === "recommended")
      .map((follow) => [follow.recommendedSourceId, follow]),
  );
  const sourceReady = connected && radar.configured;

  return (
    <Modal
      title="来源与关注"
      description="订阅服务器提供的内容，也可以添加自己的公开网址和 RSS。"
      onClose={onClose}
      wide
    >
      <div className="radar-source-panel" aria-label="来源与关注">
        <div className="radar-source-service">
          <div>
            <strong>
              <span className={`radar-status-dot ${radar.connection}`} />
              {CONNECTION_LABELS[radar.connection]}
            </strong>
            <span>
              {radar.lastSyncAt
                ? `最近接收 ${formatMoment(radar.lastSyncAt)}`
                : "尚无服务端接收记录"}
            </span>
          </div>
          <button
            className="button secondary small"
            disabled={!sourceReady || Boolean(pending)}
            onClick={onRefresh}
          >
            <RefreshCw
              size={14}
              className={pending === "refresh:all" ? "spin" : ""}
            />
            手动刷新
          </button>
        </div>
        <details className="radar-connection-settings" open={!radar.configured}>
          <summary>
            服务器连接{radar.serviceURL ? ` · ${radar.serviceURL}` : ""}
          </summary>
          <SourceConnectionForm radar={radar} dispatch={dispatch} />
        </details>
        <form className="radar-follow-form" onSubmit={onSubmit}>
          <label htmlFor="radar-follow-url">
            添加公开网址或 RSS / Atom 订阅源
          </label>
          <div className="radar-follow-input">
            <input
              ref={followInput}
              id="radar-follow-url"
              type="url"
              required
              placeholder="https://…"
              value={url}
              disabled={!sourceReady || pending === "follow"}
              onChange={(event) => onURL(event.target.value)}
            />
            <button
              className="button primary small"
              type="submit"
              disabled={!sourceReady || !url.trim() || Boolean(pending)}
              aria-label="关注这个信息源"
            >
              {pending === "follow" ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <Link2 size={14} />
              )}
              关注
            </button>
          </div>
          <p>
            服务器持续取得更新，内容会直接进入阅读区；需要深入时再与团队讨论。
          </p>
        </form>
        <div className="radar-source-panel-grid">
          <section aria-labelledby="user-follows-title">
            <div className="radar-source-title">
              <span id="user-follows-title">
                <UserRound size={15} /> 用户关注 · 你指定的来源
              </span>
              <span>{userFollows.length}</span>
            </div>
            {userFollows.length ? (
              <div className="radar-source-list">
                {userFollows.map((follow) => (
                  <FollowCard
                    key={follow.id}
                    follow={follow}
                    pending={Boolean(pending?.endsWith(follow.id))}
                    dispatch={dispatch}
                    begin={begin}
                  />
                ))}
              </div>
            ) : (
              <p className="radar-source-empty">
                还没有你指定的来源。可以从上方加入一个公开网址。
              </p>
            )}
          </section>
          <section aria-labelledby="recommended-sources-title">
            <div className="radar-source-title">
              <span id="recommended-sources-title">
                <Server size={15} /> 服务器推荐 · 产品提供的来源
              </span>
              <span>{radar.recommendedSources.length}</span>
            </div>
            {radar.recommendedSources.length ? (
              <div className="radar-source-list">
                {radar.recommendedSources.map((source) => {
                  const follow =
                    recommendedFollows.get(source.id) ??
                    radar.follows.find(
                      (candidate) => candidate.id === source.followId,
                    );
                  return (
                    <RecommendedCard
                      key={source.id}
                      source={source}
                      follow={follow}
                      pending={
                        pending === `recommended:${source.id}` ||
                        Boolean(follow && pending?.endsWith(follow.id))
                      }
                      dispatch={dispatch}
                      begin={begin}
                    />
                  );
                })}
              </div>
            ) : (
              <p className="radar-source-empty">
                服务端暂未提供推荐来源；这里不会用示例内容冒充真实推荐。
              </p>
            )}
          </section>
        </div>
      </div>
    </Modal>
  );
}

function EvidencePanel({
  item,
  dispatch,
  lockedRevision,
  evidenceRevision,
  digestNote,
}: {
  item: RadarItem;
  dispatch: Dispatch;
  lockedRevision?: string;
  evidenceRevision?: RadarEvidenceRevision;
  digestNote?: string;
}) {
  const stale = Boolean(
    lockedRevision && lockedRevision !== item.latestRevisionId,
  );
  const lockedEvidence =
    lockedRevision &&
    evidenceRevision?.revisionId === lockedRevision &&
    evidenceRevision.remoteItemId === item.remoteItemId
      ? evidenceRevision
      : undefined;
  const coverageLevel = lockedRevision
    ? lockedEvidence?.coverageLevel
    : item.coverageLevel;
  const observedAt = lockedRevision
    ? lockedEvidence?.observedAt
    : item.observedAt;
  const missing = lockedRevision ? lockedEvidence?.missing : item.missing;
  return (
    <div className="radar-evidence-panel">
      <div className="radar-evidence-heading">
        <strong>{lockedRevision ? "判断所用修订" : "来源证据"}</strong>
        <span>
          {lockedRevision
            ? stale
              ? `当前最新修订 ${shortRevision(item.latestRevisionId)}`
              : "当前仍为最新修订"
            : "未经团队整理的本机缓存内容"}
        </span>
      </div>
      {stale ? (
        <div className="radar-evidence-stale" role="status">
          当前来源已更新到修订 {shortRevision(item.latestRevisionId)}
          ；下方仍显示 判断所用修订 {shortRevision(lockedRevision!)}{" "}
          的真实正文。
        </div>
      ) : null}
      {lockedEvidence ? (
        <div className="radar-evidence-content">
          <span className="radar-evidence-revision-label">
            判断所用修订正文 · {lockedEvidence.title}
          </span>
          <p>{lockedEvidence.content}</p>
        </div>
      ) : lockedRevision ? (
        <div className="radar-missing-evidence" role="status">
          锁定修订正文当前不可用；这里不会用最新正文代替。
        </div>
      ) : (
        <div className="radar-evidence-content">
          {item.content || item.excerpt}
        </div>
      )}
      {digestNote ? (
        <p className="radar-evidence-note">团队证据说明：{digestNote}</p>
      ) : null}
      <dl className="radar-evidence-facts">
        {coverageLevel ? (
          <div>
            <dt>内容范围</dt>
            <dd>{COVERAGE_LABELS[coverageLevel]}</dd>
          </div>
        ) : null}
        {observedAt ? (
          <div>
            <dt>观察时间</dt>
            <dd>{formatMoment(observedAt)}</dd>
          </div>
        ) : null}
        <div>
          <dt>{lockedRevision ? "判断所用修订" : "当前修订"}</dt>
          <dd>
            {shortRevision(lockedRevision ?? item.latestRevisionId)}
            {stale ? " · 来源已有新修订" : " · 当前一致"}
          </dd>
        </div>
        {missing?.length ? (
          <div>
            <dt>仍然缺失</dt>
            <dd>{missing.join("、")}</dd>
          </div>
        ) : null}
      </dl>
      <button
        className="text-button"
        onClick={() =>
          void dispatch({
            type: "url.open",
            url: lockedEvidence?.url ?? item.url,
          })
        }
      >
        <ExternalLink size={13} />
        {lockedEvidence ? "打开判断所用来源" : "打开原始来源"}
      </button>
    </div>
  );
}

function SignalRow({
  item,
  run,
  pending,
  dispatch,
  onDigest,
  archived = false,
}: {
  item: RadarItem;
  run?: RadarDigestionRun;
  pending: boolean;
  dispatch: Dispatch;
  onDigest: (items: RadarItem[], retry?: boolean) => Promise<void>;
  archived?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const evidenceId = useId();
  const state = archived
    ? {
        label: "你暂不处理",
        className: "archived",
        active: false,
        retryable: false,
      }
    : runPresentation(run);

  return (
    <article className="radar-signal-row radar-inbox-item">
      <div className="radar-signal-status" aria-hidden="true">
        <span className={state.className} />
      </div>
      <div className="radar-signal-body">
        <div className="radar-signal-meta">
          <span>{item.sourceTitle}</span>
          <span>{originLabel(item.origin)}</span>
          <span>{formatMoment(item.observedAt)}</span>
          <span>{COVERAGE_LABELS[item.coverageLevel]}</span>
          {item.isUpdated ? <span>来源新修订</span> : null}
        </div>
        <h3>{item.title}</h3>
        {item.excerpt ? <p>{item.excerpt}</p> : null}
        {run?.taskStatus === "failed" && run.error ? (
          <p className="radar-run-error" role="status">
            最近整理失败：{run.error}
          </p>
        ) : null}
        <div className="radar-signal-actions">
          {!archived && (!run || state.retryable) ? (
            <button
              className="text-button primary-action"
              disabled={pending}
              onClick={() => void onDigest([item], state.retryable)}
            >
              {pending ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <Sparkles size={14} />
              )}
              {state.retryable ? "重新交给团队整理" : "交给团队整理"}
            </button>
          ) : null}
          <button
            className="text-button"
            aria-expanded={expanded}
            aria-controls={evidenceId}
            onClick={() => setExpanded((current) => !current)}
          >
            <FileSearch size={14} />
            {expanded ? "收起证据" : "查看原始证据"}
          </button>
          <button
            className="text-button"
            disabled={pending || state.active}
            onClick={() =>
              void dispatch({
                type: "radar.archive",
                itemId: item.id,
                archived: !item.archivedAt,
              })
            }
          >
            <Archive size={13} />
            {item.archivedAt ? "移回待消化" : "暂不处理"}
          </button>
        </div>
        {expanded ? (
          <div id={evidenceId}>
            <EvidencePanel item={item} dispatch={dispatch} />
          </div>
        ) : null}
      </div>
      <span className={`radar-processing-label ${state.className}`}>
        {state.label}
      </span>
    </article>
  );
}

function DigestCard({
  group,
  pending,
  dispatch,
  onDiscuss,
}: {
  group: DigestGroup;
  pending: boolean;
  dispatch: Dispatch;
  onDiscuss: (
    itemIds: string[],
    title: string,
    mode: "continue" | "verify",
  ) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const evidenceId = useId();
  const { digest } = group;
  const itemIds = digestItemIds(group);
  const sourceCount = new Set(group.evidence.map((item) => item.sourceId)).size;
  const staleCount = group.evidence.filter((evidence) => evidence.stale).length;

  return (
    <article className="radar-insight-card radar-theme-card">
      <div className="radar-insight-kicker">
        <span className="radar-insight-state">
          <CheckCircle2 size={13} />
          {staleCount
            ? "来源已有新修订"
            : sourceCount > 1
              ? "团队多源整理"
              : "团队已发布"}
        </span>
        <span>{formatMoment(digest.publishedAt)} 发布</span>
      </div>
      <h3>{digest.title}</h3>
      <div className="radar-insight-summary">
        <p>{digest.summary}</p>
      </div>
      <div className="radar-relevance">
        <strong>为何值得关注</strong>
        <p>{digest.whyItMatters}</p>
      </div>
      {group.context.length ? (
        <div className="radar-context-relations">
          <strong>与本地上下文的关系</strong>
          <ul>
            {group.context.map((context, index) => (
              <li key={`${context.sourceId}:${index}`}>
                <span>{RELATION_LABELS[context.relation]}</span>
                <p>
                  <b>{context.label}</b>
                  {context.detail ? ` · ${context.detail}` : ""}：{context.note}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="radar-relevance incomplete">
          <strong>本轮没有引用本地上下文</strong>
          <p>团队没有把未读取的项目或 Lib 冒充为已对照内容。</p>
        </div>
      )}
      {digest.disagreements.length || digest.gaps.length ? (
        <div className="radar-caveats">
          {digest.disagreements.length ? (
            <div>
              <strong>仍有分歧</strong>
              <ul>
                {digest.disagreements.map((value) => (
                  <li key={value}>{value}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {digest.gaps.length ? (
            <div>
              <strong>证据缺口</strong>
              <ul>
                {digest.gaps.map((value) => (
                  <li key={value}>{value}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="radar-insight-context">
        <span>
          <Layers3 size={13} /> {group.evidence.length} 条锁定证据 ·{" "}
          {sourceCount} 个来源
        </span>
        {staleCount ? (
          <span>
            <CircleAlert size={13} /> {staleCount} 条来源已有新修订
          </span>
        ) : null}
      </div>
      {digest.topics.length ? (
        <div className="radar-topic-list" aria-label="相关主题">
          {digest.topics.map((topic) => (
            <span key={topic}>{topic}</span>
          ))}
        </div>
      ) : null}
      <div className="radar-insight-actions">
        <button
          className="button primary small"
          disabled={pending || !itemIds.length}
          onClick={() => void onDiscuss(itemIds, digest.title, "continue")}
        >
          {pending ? (
            <LoaderCircle size={14} className="spin" />
          ) : (
            <MessageCircleQuestion size={14} />
          )}
          围绕这个主题继续
        </button>
        <button
          className="text-button"
          aria-expanded={expanded}
          aria-controls={evidenceId}
          onClick={() => setExpanded((current) => !current)}
        >
          <FileSearch size={14} />
          {expanded ? "收起证据" : "查看证据"}
        </button>
        <button
          className="text-button"
          disabled={pending || !itemIds.length}
          onClick={() => void onDiscuss(itemIds, digest.title, "verify")}
        >
          <MessageCircleQuestion size={14} />
          和团队核对
        </button>
      </div>
      {expanded ? (
        <div
          className="radar-insight-evidence radar-theme-evidence"
          id={evidenceId}
        >
          <div className="radar-evidence-heading">
            <strong>这项理解依据什么</strong>
            <span>可以回到每条来源核查内容范围与缺失</span>
          </div>
          {group.evidence.map((evidence, index) =>
            evidence.item ? (
              <details key={`${evidence.sourceId}:${evidence.revisionId}`}>
                <summary>
                  <span>{evidence.revision?.title ?? evidence.item.title}</span>
                  <small>
                    {evidence.item.sourceTitle} ·{" "}
                    {
                      COVERAGE_LABELS[
                        evidence.revision?.coverageLevel ??
                          evidence.item.coverageLevel
                      ]
                    }{" "}
                    · 修订 {shortRevision(evidence.revisionId)}
                    {evidence.stale ? " · 来源已有新修订" : " · 当前一致"}
                  </small>
                </summary>
                <EvidencePanel
                  item={evidence.item}
                  dispatch={dispatch}
                  lockedRevision={evidence.revisionId}
                  evidenceRevision={evidence.revision}
                  digestNote={evidence.note}
                />
              </details>
            ) : (
              <div
                className="radar-missing-evidence"
                key={`${evidence.sourceId}:${index}`}
              >
                <strong>证据条目当前不可用</strong>
                <span>锁定修订 {shortRevision(evidence.revisionId)}</span>
                {evidence.note ? <p>{evidence.note}</p> : null}
              </div>
            ),
          )}
        </div>
      ) : null}
    </article>
  );
}

function DispositionRow({
  view,
  dispatch,
}: {
  view: DispositionView;
  dispatch: Dispatch;
}) {
  const [expanded, setExpanded] = useState(false);
  const evidenceId = useId();
  const { disposition, item, revisionId, revision, stale } = view;
  return (
    <article className="radar-disposition-row">
      <div className="radar-disposition-meta">
        <span>{DISPOSITION_LABELS[disposition.kind]}</span>
        <span>{formatMoment(disposition.publishedAt)}</span>
      </div>
      <h3>{revision?.title ?? item?.title ?? "原始证据当前不可用"}</h3>
      <p>{disposition.reason}</p>
      <div className="radar-disposition-foot">
        <span>
          {item?.sourceTitle ?? "来源未知"}
          {revisionId ? ` · 判断修订 ${shortRevision(revisionId)}` : ""}
          {stale ? " · 来源已有新修订" : ""}
        </span>
        {item ? (
          <button
            className="text-button"
            aria-expanded={expanded}
            aria-controls={evidenceId}
            onClick={() => setExpanded((current) => !current)}
          >
            <FileSearch size={13} />
            {expanded ? "收起证据" : "查看证据"}
          </button>
        ) : null}
      </div>
      {expanded && item ? (
        <div id={evidenceId}>
          <EvidencePanel
            item={item}
            dispatch={dispatch}
            lockedRevision={revisionId}
            evidenceRevision={revision}
          />
        </div>
      ) : null}
    </article>
  );
}

function DigestionErrorNotice({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <div className="radar-digestion-error" role="status">
      <CircleAlert size={15} />
      <div>
        <strong>团队自动消化暂时停住</strong>
        <p>{message}</p>
        <span>来源仍会继续接收；可以先查看原始信号或稍后重试。</span>
      </div>
    </div>
  );
}

function RadarContext({
  snapshot,
  digestedCount,
  pendingCount,
  processingCount,
  filteredCount,
  onTask,
}: {
  snapshot: Snapshot | null;
  digestedCount: number;
  pendingCount: number;
  processingCount: number;
  filteredCount: number;
  onTask: (taskId: string, task?: Task) => void;
}) {
  const recentWork = (snapshot?.tasks ?? [])
    .filter((task) => !task.archivedAt && !task.deletedAt)
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 3);

  return (
    <aside className="radar-context" aria-label="雷达对照上下文">
      <section className="radar-context-section">
        <span className="radar-context-label">雷达正在对照</span>
        <h2>你的本地上下文</h2>
        <p>团队消化时应结合正在推进的工作、项目与已有积累，而不是只看热度。</p>
        <dl className="radar-context-counts">
          <div>
            <dt>进行中的工作</dt>
            <dd>{recentWork.length}</dd>
          </div>
          <div>
            <dt>本机项目</dt>
            <dd>{snapshot?.projects.length ?? 0}</dd>
          </div>
          <div>
            <dt>Lib 资产</dt>
            <dd>{snapshot?.library?.length ?? 0}</dd>
          </div>
        </dl>
        {recentWork.length ? (
          <div className="radar-recent-work">
            {recentWork.map((task) => (
              <button key={task.id} onClick={() => onTask(task.id, task)}>
                <span>{task.title}</span>
                <ArrowRight size={13} />
              </button>
            ))}
          </div>
        ) : (
          <p className="radar-context-empty">当前还没有可用于对照的工作。</p>
        )}
      </section>
      <section className="radar-context-section radar-progress">
        <span className="radar-context-label">这一轮吸收</span>
        <ul>
          <li>
            <span>已形成理解</span>
            <strong>{digestedCount}</strong>
          </li>
          <li>
            <span>团队处理中</span>
            <strong>{processingCount}</strong>
          </li>
          <li>
            <span>待团队消化</span>
            <strong>{pendingCount}</strong>
          </li>
          <li>
            <span>有理由过滤</span>
            <strong>{filteredCount}</strong>
          </li>
        </ul>
      </section>
    </aside>
  );
}

export function RadarArchive({
  snapshot,
  dispatch,
  connected,
  onTask,
}: {
  snapshot: Snapshot | null;
  dispatch: Dispatch;
  connected: boolean;
  onTask: (taskId: string, task?: Task) => void;
}) {
  const radar = snapshot?.radar ?? EMPTY_RADAR;
  const digestionError = radar.digestionError;
  const tasks = snapshot?.tasks ?? [];
  const [view, setView] = useState<RadarView>("reading");
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [url, setURL] = useState("");
  const followInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<string | null>(null);

  const begin = async (key: string, action: () => Promise<Snapshot | null>) => {
    if (pending) return;
    setPending(key);
    try {
      await action();
    } finally {
      setPending(null);
    }
  };

  const digestions = radar.digestions ?? [];
  const digests = radar.digests ?? [];
  const dispositions = radar.dispositions ?? [];
  const publishedRevisionKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const run of digestions) {
      if (run.state !== "published") continue;
      for (const item of run.items)
        keys.add(revisionKey(item.radarItemId, item.revisionId));
    }
    return keys;
  }, [digestions]);
  const runByCurrentItem = useMemo(() => {
    const result = new Map<string, RadarDigestionRun>();
    for (const item of radar.items) {
      const run = runForItem(digestions, item);
      if (run) result.set(item.id, run);
    }
    return result;
  }, [digestions, radar.items]);
  const digestGroups = useMemo(() => {
    const runById = new Map(digestions.map((run) => [run.id, run]));
    const itemById = new Map(radar.items.map((item) => [item.id, item]));
    const libraryById = new Map(
      (snapshot?.library ?? []).map((entry) => [entry.id, entry]),
    );
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    return digests
      .map((digest): DigestGroup => {
        const run = runById.get(digest.runId);
        const lockedBySource = new Map(
          (run?.items ?? []).map((item) => [item.sourceId, item]),
        );
        const contextBySource = new Map(
          (run?.contextSources ?? []).map((source) => [
            source.sourceId,
            source,
          ]),
        );
        return {
          digest,
          evidence: digest.evidence.map((reference) => {
            const locked = lockedBySource.get(reference.sourceId);
            const item = locked ? itemById.get(locked.radarItemId) : undefined;
            const candidate = locked
              ? radar.evidenceRevisions?.[locked.radarItemId]?.[
                  reference.revisionId
                ]
              : undefined;
            const revision =
              candidate &&
              locked &&
              candidate.sourceId === reference.sourceId &&
              candidate.remoteItemId === locked.remoteItemId &&
              candidate.revisionId === reference.revisionId
                ? candidate
                : undefined;
            return {
              item,
              sourceId: reference.sourceId,
              revisionId: reference.revisionId,
              revision,
              note: reference.note,
              stale: Boolean(
                item && item.latestRevisionId !== reference.revisionId,
              ),
            };
          }),
          context: digest.context.map((reference) => {
            const source = contextBySource.get(reference.sourceId);
            const library =
              source?.kind === "library"
                ? libraryById.get(source.referenceId)
                : undefined;
            const task =
              source?.kind === "task" &&
              source.referenceId !== "workspace-overview"
                ? taskById.get(source.referenceId)
                : undefined;
            return {
              sourceId: reference.sourceId,
              label:
                library?.title ??
                task?.title ??
                (source?.kind === "library"
                  ? "已读取的 Lib 资料"
                  : "当前工作与项目索引"),
              detail:
                source?.kind === "library" && source.version
                  ? `版本 ${source.version}`
                  : source?.kind === "task"
                    ? "目标与登记元数据"
                    : undefined,
              relation: reference.relation,
              note: reference.note,
            };
          }),
        };
      })
      .toSorted((left, right) =>
        right.digest.publishedAt.localeCompare(left.digest.publishedAt),
      );
  }, [
    digestions,
    digests,
    radar.evidenceRevisions,
    radar.items,
    snapshot?.library,
    tasks,
  ]);
  const today = localDay(new Date().toISOString());
  const todayDigestGroups = digestGroups.filter(
    (group) => localDay(group.digest.publishedAt) === today,
  );
  const historicalDigestGroups = digestGroups.filter(
    (group) => localDay(group.digest.publishedAt) !== today,
  );
  const rawItems = useMemo(
    () =>
      radar.items
        .filter(
          (item) =>
            !item.archivedAt &&
            !publishedRevisionKeys.has(
              revisionKey(item.id, item.latestRevisionId),
            ),
        )
        .toSorted((left, right) => itemTimestamp(right) - itemTimestamp(left)),
    [publishedRevisionKeys, radar.items],
  );
  const archivedItems = useMemo(
    () =>
      radar.items
        .filter(
          (item) =>
            Boolean(item.archivedAt) &&
            !publishedRevisionKeys.has(
              revisionKey(item.id, item.latestRevisionId),
            ),
        )
        .toSorted((left, right) => itemTimestamp(right) - itemTimestamp(left)),
    [publishedRevisionKeys, radar.items],
  );
  const dispositionViews = useMemo(() => {
    const runById = new Map(digestions.map((run) => [run.id, run]));
    const itemById = new Map(radar.items.map((item) => [item.id, item]));
    return dispositions
      .map((disposition): DispositionView => {
        const run = runById.get(disposition.runId);
        const locked = run?.items.find(
          (item) => item.sourceId === disposition.sourceId,
        );
        const item = locked ? itemById.get(locked.radarItemId) : undefined;
        const candidate = locked
          ? radar.evidenceRevisions?.[locked.radarItemId]?.[locked.revisionId]
          : undefined;
        const revision =
          candidate &&
          locked &&
          candidate.sourceId === disposition.sourceId &&
          candidate.remoteItemId === locked.remoteItemId &&
          candidate.revisionId === locked.revisionId
            ? candidate
            : undefined;
        return {
          disposition,
          item,
          revisionId: locked?.revisionId,
          revision,
          stale: Boolean(
            item && locked && item.latestRevisionId !== locked.revisionId,
          ),
        };
      })
      .toSorted((left, right) =>
        right.disposition.publishedAt.localeCompare(
          left.disposition.publishedAt,
        ),
      );
  }, [digestions, dispositions, radar.evidenceRevisions, radar.items]);
  const processingItems = rawItems.filter((item) => {
    const status = runByCurrentItem.get(item.id)?.taskStatus;
    return status === "idle" || status === "running" || status === "waiting";
  });
  const waitingItems = rawItems.filter(
    (item) => !runByCurrentItem.has(item.id),
  );
  const digestedCount = todayDigestGroups.length;
  const digestedEvidenceCount = new Set(
    todayDigestGroups.flatMap((group) =>
      group.evidence.map(
        (evidence) => `${evidence.sourceId}\0${evidence.revisionId}`,
      ),
    ),
  ).size;

  const submitFollow = async (event: FormEvent) => {
    event.preventDefault();
    const value = (followInput.current?.value ?? url).trim();
    if (!value || pending) return;
    await begin("follow", async () => {
      const result = await dispatch({ type: "radar.follow", url: value });
      if (result) setURL("");
      return result;
    });
  };

  const requestDigest = async (items: RadarItem[], retry = false) => {
    const itemIds = Array.from(new Set(items.map((item) => item.id))).slice(
      0,
      24,
    );
    if (!itemIds.length) return;
    const actionKey = `digest:${itemIds.join(",")}`;
    await begin(actionKey, async () => {
      return dispatch({
        type: "radar.digest",
        itemIds,
        ...(retry ? { retry: true } : {}),
      });
    });
  };

  const openDiscussion = async (
    itemIds: string[],
    title: string,
    mode: "continue" | "verify",
  ) => {
    if (!itemIds.length) return;
    await begin(`discuss:${mode}:${itemIds.join(",")}`, async () => {
      const before = new Set(tasks.map((task) => task.id));
      const result = await dispatch({
        type: "radar.createTask",
        itemIds,
        title:
          mode === "verify"
            ? `核对 Radar 理解 · ${title}`
            : `继续研究 · ${title}`,
        instruction:
          mode === "verify"
            ? `和我一起核查 Radar 对「${title}」的判断、证据边界与本地上下文关系。这是一项核对讨论，不自动修改当前简报。`
            : `围绕 Radar 主题「${title}」继续研究。区分已发布判断、新证据与仍待验证的部分。`,
      });
      const created = result?.tasks.find((task) => !before.has(task.id));
      if (created) onTask(created.id, created);
      return result;
    });
  };

  const refreshAll = () =>
    void begin("refresh:all", () => dispatch({ type: "radar.refresh" }));

  const views: { id: RadarView; label: string; count?: number }[] = [
    {
      id: "reading",
      label: "信息阅读",
      count: radar.items.filter((item) => !item.archivedAt).length,
    },
    { id: "today", label: "今日理解", count: todayDigestGroups.length },
    {
      id: "insights",
      label: "历史理解",
      count: historicalDigestGroups.length,
    },
    { id: "inbox", label: "待团队消化", count: rawItems.length },
    {
      id: "history",
      label: "筛选记录",
      count: dispositionViews.length + archivedItems.length,
    },
  ];
  const queue = view === "today" ? rawItems.slice(0, 4) : rawItems;

  return (
    <section className="radar-page" aria-label="雷达">
      <div className="radar-inner">
        <header className="radar-hero">
          <div className="radar-hero-copy">
            <span className="radar-heading-mark">
              <RadarIcon size={14} /> Personal intelligence
            </span>
            <h1>雷达</h1>
            <p>
              从订阅更新到主题浏览，打开一条信息深入阅读，再与团队继续研究。
            </p>
          </div>
          <div className="radar-hero-actions">
            <div
              className="radar-connection"
              title={CONNECTION_LABELS[radar.connection]}
            >
              <span className={`radar-status-dot ${radar.connection}`} />
              <span>
                {CONNECTION_LABELS[radar.connection]}
                {radar.lastSyncAt ? ` · ${formatMoment(radar.lastSyncAt)}` : ""}
              </span>
            </div>
            <button
              className="button secondary small"
              onClick={() => setSourcesOpen(true)}
            >
              <Settings2 size={14} />
              来源与关注
            </button>
          </div>
        </header>

        {radar.error ? (
          <div className="radar-sync-error" role="status">
            <CircleAlert size={15} />
            <span>{radar.error}</span>
          </div>
        ) : null}

        <nav className="radar-view-tabs" aria-label="雷达阅读区">
          <button
            className={view === "reading" ? "active" : ""}
            aria-current={view === "reading" ? "page" : undefined}
            onClick={() => setView("reading")}
          >
            信息阅读
          </button>
          {radar.digests?.length ||
          radar.digestions?.length ||
          radar.dispositions?.length ? (
            <button
              className={view !== "reading" ? "active" : ""}
              onClick={() => setView("today")}
            >
              团队处理记录
            </button>
          ) : null}
        </nav>
        {view !== "reading" ? (
          <nav className="radar-view-tabs" aria-label="团队处理记录">
            {views
              .filter((option) => option.id !== "reading")
              .map((option) => (
                <button
                  key={option.id}
                  className={view === option.id ? "active" : ""}
                  aria-current={view === option.id ? "page" : undefined}
                  onClick={() => setView(option.id)}
                >
                  {option.label}
                  {option.count ? <span>{option.count}</span> : null}
                </button>
              ))}
          </nav>
        ) : null}

        <div className={`radar-layout ${view === "reading" ? "reading" : ""}`}>
          <main className="radar-main">
            {view === "reading" ? (
              <RadarReader
                key={`${radar.serviceURL ?? "unconfigured"}:${radar.items[0]?.tenantId ?? ""}`}
                radar={radar}
                dispatch={dispatch}
                onTask={onTask}
                tasks={tasks}
                onSources={() => setSourcesOpen(true)}
              />
            ) : view === "today" ? (
              <>
                <section
                  className="radar-digest"
                  aria-labelledby="today-digest-title"
                >
                  <div className="radar-section-heading">
                    <div>
                      <span>团队简报</span>
                      <h2 id="today-digest-title">今日主题理解</h2>
                      <p>按问题和主题整理，不用你自己从一篇篇来源里归纳。</p>
                    </div>
                    {todayDigestGroups.length ? (
                      <span className="radar-section-summary">
                        {digestedEvidenceCount} 条锁定证据 →{" "}
                        {todayDigestGroups.length} 个主题
                      </span>
                    ) : null}
                  </div>
                  {todayDigestGroups.length ? (
                    <div className="radar-insight-list">
                      {todayDigestGroups.map((group) => {
                        const ids = digestItemIds(group).join(",");
                        return (
                          <DigestCard
                            key={group.digest.id}
                            group={group}
                            pending={
                              pending === `discuss:continue:${ids}` ||
                              pending === `discuss:verify:${ids}`
                            }
                            dispatch={dispatch}
                            onDiscuss={openDiscussion}
                          />
                        );
                      })}
                    </div>
                  ) : (
                    <div className="radar-brief-empty">
                      <div className="radar-empty-icon">
                        <Sparkles size={22} />
                      </div>
                      <div>
                        <h3>今天还没有已整理的主题</h3>
                        <p>
                          {rawItems.length
                            ? `已收到 ${rawItems.length} 条真实信号。它们只有经过筛选、合并并与本地积累对照后，才会作为“今日理解”出现在这里。`
                            : radar.configured
                              ? "今天暂时没有新的可整理内容。收到的来源内容会先进入待消化队列。"
                              : "来源服务尚未配置；本机工作、项目与 Lib 不受影响。"}
                        </p>
                        {rawItems.length ? (
                          <button
                            className="text-button"
                            onClick={() => setView("inbox")}
                          >
                            查看待消化信号 <ArrowRight size={13} />
                          </button>
                        ) : historicalDigestGroups.length ? (
                          <button
                            className="text-button"
                            onClick={() => setView("insights")}
                          >
                            查看历史理解 <ArrowRight size={13} />
                          </button>
                        ) : null}
                      </div>
                    </div>
                  )}
                </section>

                <section
                  className="radar-queue radar-inbox"
                  aria-labelledby="radar-queue-title"
                >
                  <div className="radar-queue-heading">
                    <div>
                      <span>原始信号</span>
                      <h2 id="radar-queue-title">待消化</h2>
                    </div>
                    {waitingItems.length ? (
                      <button
                        className="button secondary small"
                        disabled={Boolean(pending)}
                        onClick={() => void requestDigest(waitingItems)}
                      >
                        <Sparkles size={14} />
                        交给团队整理这批
                      </button>
                    ) : null}
                  </div>
                  <p className="radar-queue-note">
                    这里保留来源与证据边界，但它们还不是你的知识或结论。
                  </p>
                  <DigestionErrorNotice message={digestionError} />
                  {queue.length ? (
                    <div className="radar-signal-list">
                      {queue.map((item) => (
                        <SignalRow
                          key={item.id}
                          item={item}
                          run={runByCurrentItem.get(item.id)}
                          pending={pending === `digest:${item.id}`}
                          dispatch={dispatch}
                          onDigest={requestDigest}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="radar-simple-empty compact">
                      <BookOpenCheck size={25} />
                      <div>
                        <h3>没有待消化的信号</h3>
                        <p>新内容由来源服务送达后，会先进入这里。</p>
                      </div>
                    </div>
                  )}
                  {rawItems.length > queue.length ? (
                    <button
                      className="radar-show-all"
                      onClick={() => setView("inbox")}
                    >
                      查看全部 {rawItems.length} 条 <ArrowRight size={13} />
                    </button>
                  ) : null}
                </section>
              </>
            ) : view === "insights" ? (
              <section
                className="radar-digest"
                aria-labelledby="radar-insight-history-title"
              >
                <div className="radar-section-heading">
                  <div>
                    <span>过往团队简报</span>
                    <h2 id="radar-insight-history-title">历史主题理解</h2>
                    <p>
                      按发布时间保留过往判断；今日入口只呈现今天新形成的理解。
                    </p>
                  </div>
                  {historicalDigestGroups.length ? (
                    <span className="radar-section-summary">
                      {historicalDigestGroups.length} 个历史主题
                    </span>
                  ) : null}
                </div>
                {historicalDigestGroups.length ? (
                  <div className="radar-insight-list">
                    {historicalDigestGroups.map((group) => {
                      const ids = digestItemIds(group).join(",");
                      return (
                        <DigestCard
                          key={group.digest.id}
                          group={group}
                          pending={
                            pending === `discuss:continue:${ids}` ||
                            pending === `discuss:verify:${ids}`
                          }
                          dispatch={dispatch}
                          onDiscuss={openDiscussion}
                        />
                      );
                    })}
                  </div>
                ) : (
                  <div className="radar-simple-empty">
                    <BookOpenCheck size={28} />
                    <h3>还没有历史主题理解</h3>
                    <p>今天以前发布的团队简报会保留在这里。</p>
                  </div>
                )}
              </section>
            ) : view === "inbox" ? (
              <section
                className="radar-queue radar-inbox full"
                aria-labelledby="radar-inbox-title"
              >
                <div className="radar-section-heading">
                  <div>
                    <span>团队吸收队列</span>
                    <h2 id="radar-inbox-title">待团队消化</h2>
                    <p>原始内容在这里等待筛选、聚合、核查和本地上下文对照。</p>
                  </div>
                  {waitingItems.length ? (
                    <button
                      className="button primary small"
                      disabled={Boolean(pending)}
                      onClick={() => void requestDigest(waitingItems)}
                    >
                      <Sparkles size={14} />
                      交给团队整理这批
                    </button>
                  ) : null}
                </div>
                <DigestionErrorNotice message={digestionError} />
                {rawItems.length ? (
                  <div className="radar-signal-list">
                    {rawItems.map((item) => (
                      <SignalRow
                        key={item.id}
                        item={item}
                        run={runByCurrentItem.get(item.id)}
                        pending={pending === `digest:${item.id}`}
                        dispatch={dispatch}
                        onDigest={requestDigest}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="radar-simple-empty">
                    <BookOpenCheck size={28} />
                    <h3>没有待消化的信号</h3>
                    <p>新内容由来源服务送达后，会先进入这里。</p>
                  </div>
                )}
              </section>
            ) : (
              <section
                className="radar-queue full"
                aria-labelledby="radar-history-title"
              >
                <div className="radar-section-heading">
                  <div>
                    <span>团队判断</span>
                    <h2 id="radar-history-title">筛选记录</h2>
                    <p>
                      每条未进入主题的信号，都保留明确理由和当时锁定的修订。
                    </p>
                  </div>
                </div>
                {dispositionViews.length ? (
                  <div className="radar-disposition-list">
                    {dispositionViews.map((item) => (
                      <DispositionRow
                        key={item.disposition.id}
                        view={item}
                        dispatch={dispatch}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="radar-simple-empty">
                    <Archive size={28} />
                    <h3>还没有团队筛选记录</h3>
                    <p>团队过滤的内容与理由会保留在这里。</p>
                  </div>
                )}
                {archivedItems.length ? (
                  <section className="radar-manual-archive">
                    <div className="radar-queue-heading">
                      <div>
                        <span>你的选择</span>
                        <h2>暂不处理</h2>
                      </div>
                    </div>
                    <div className="radar-signal-list">
                      {archivedItems.map((item) => (
                        <SignalRow
                          key={item.id}
                          item={item}
                          run={runByCurrentItem.get(item.id)}
                          pending={false}
                          dispatch={dispatch}
                          onDigest={requestDigest}
                          archived
                        />
                      ))}
                    </div>
                  </section>
                ) : null}
              </section>
            )}
          </main>

          {view !== "reading" ? (
            <RadarContext
              snapshot={snapshot}
              digestedCount={digestedCount}
              pendingCount={waitingItems.length}
              processingCount={processingItems.length}
              filteredCount={dispositionViews.length}
              onTask={onTask}
            />
          ) : null}
        </div>
      </div>

      {sourcesOpen ? (
        <SourceManager
          radar={radar}
          connected={connected}
          pending={pending}
          url={url}
          followInput={followInput}
          onURL={setURL}
          onSubmit={(event) => void submitFollow(event)}
          onRefresh={refreshAll}
          onClose={() => setSourcesOpen(false)}
          dispatch={dispatch}
          begin={begin}
        />
      ) : null}
    </section>
  );
}
