import { useLayoutEffect, useRef, useState } from "react";
import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  ClockCounterClockwiseIcon,
  MagnifyingGlassIcon,
  XIcon,
  FilesIcon,
  ChatTeardropTextIcon,
  ArrowClockwiseIcon,
} from "@phosphor-icons/react";
import type {
  EditorialEdition as Edition,
  EditorialFocus,
  EditorialIssue,
  EditorialRevision,
} from "@ytriple/source-contract";
import { EditorialVisual } from "./EditorialVisual";
import { EditorialCover } from "./EditorialCover";
import { Material } from "./EditorialEvidence";
import type { Dispatch } from "./common";

export const readingMinutes = (revision: EditorialRevision) =>
  Math.max(
    1,
    Math.ceil(
      [revision.takeaway, ...revision.sections.map((section) => section.body)]
        .join("")
        .replace(/\s/gu, "").length / 450,
    ),
  );
const shortDate = (date: string) =>
  new Date(date).toLocaleDateString("zh-CN", {
    month: "short",
    day: "numeric",
  });
const headline = (revision: EditorialRevision) =>
  revision.presentation?.headline ?? revision.title;
export const editorialHeading = (revision: EditorialRevision) => ({
  main: headline(revision),
  deck: "",
});
export const editorialUpdateText = (text: string) =>
  text
    .replace(/\btakeaway\b/gu, "核心理解")
    .replace(/\brelationship\b/gu, "关键关系");
const understanding = (revision: EditorialRevision) =>
  revision.presentation?.summary ?? revision.relationship;

type Props = {
  issues: EditorialIssue[];
  edition?: Edition;
  browseAll: boolean;
  onBrowseAll: (value: boolean) => void;
  active?: EditorialRevision;
  focus: EditorialFocus | "全部";
  focuses: readonly (EditorialFocus | "全部")[];
  query: string;
  visibleCount: number;
  onVisibleCount: (count: number) => void;
  onReset: () => void;
  updatesOnly: boolean;
  onUpdatesOnly: (value: boolean) => void;
  onFocus: (focus: EditorialFocus | "全部") => void;
  onQuery: (query: string) => void;
  onSelect: (revision: EditorialRevision) => void;
  onRead: (revision: EditorialRevision) => void;
  onHistory: (revision: EditorialRevision) => void;
  onCorrect: (revision: EditorialRevision) => void;
  dispatch: Dispatch;
};

export function EditorialEdition(props: Props) {
  const issues = props.issues.filter(
    (issue) => !props.updatesOnly || issue.latest.version > 1,
  );
  const edited =
    props.edition?.entries.flatMap((entry) => {
      const issue = issues.find(
        (value) =>
          value.id === entry.issueId &&
          value.latest.id === entry.presentation.revisionId,
      );
      return issue ? [issue] : [];
    }) ?? [];
  const curatedMode =
    Boolean(props.edition) &&
    !props.browseAll &&
    props.focus === "全部" &&
    !props.query.trim() &&
    !props.updatesOnly;
  const selected = curatedMode
    ? edited
    : [
        ...edited,
        ...issues.filter(
          (issue) => !edited.some((value) => value.id === issue.id),
        ),
      ];
  const lead = selected[0];
  const side = selected.slice(1, 3);
  const rest = selected.filter(
    (issue) =>
      issue.id !== lead?.id && !side.some((value) => value.id === issue.id),
  );
  const displayed = (issue: EditorialIssue) => {
    const pinned =
      props.active?.issueId === issue.id ? props.active : issue.latest;
    return !pinned.presentation && pinned.id === issue.latest.id
      ? {
          ...pinned,
          presentation: issue.latest.presentation,
          cover: issue.latest.cover,
        }
      : pinned;
  };
  return (
    <div className="radar-journal editorial-stories">
      <div className="radar-edition-navigation">
        <nav aria-label="关注方向" className="radar-edition-focus">
          {props.focuses.map((focus) => (
            <button
              key={focus}
              aria-current={props.focus === focus ? "page" : undefined}
              onClick={() => props.onFocus(focus)}
            >
              {focus === "全部" ? "全部解读" : focus}
            </button>
          ))}
        </nav>
        <div className="radar-edition-tools">
          <button
            className="radar-updates-filter"
            aria-pressed={props.updatesOnly}
            onClick={() => props.onUpdatesOnly(!props.updatesOnly)}
          >
            <ClockCounterClockwiseIcon size={17} />
            有进展
          </button>
          <label className="radar-edition-search">
            <MagnifyingGlassIcon size={18} />
            <input
              aria-label="查找议题"
              placeholder="查找议题"
              value={props.query}
              onChange={(event) => props.onQuery(event.target.value)}
            />
            {props.query && (
              <button aria-label="清空搜索" onClick={() => props.onQuery("")}>
                <XIcon size={16} />
              </button>
            )}
          </label>
        </div>
      </div>
      {lead ? (
        <>
          <div
            className={`journal-opening ${side.length ? "has-companions" : ""}`}
          >
            <JournalStory
              key={displayed(lead).id}
              issue={lead}
              revision={displayed(lead)}
              prominent
              curated={edited.some((value) => value.id === lead.id)}
              reason={
                props.edition?.entries.find(
                  (value) => value.issueId === lead.id,
                )?.reason
              }
              {...props}
            />
            {side.length > 0 && (
              <section className="journal-companions" aria-label="一起关注">
                <h2>一起关注</h2>
                {side.map((issue) => (
                  <JournalStory
                    key={displayed(issue).id}
                    issue={issue}
                    revision={displayed(issue)}
                    {...props}
                  />
                ))}
              </section>
            )}
          </div>
          {rest.length > 0 && (
            <section className="journal-collection" aria-label="更多议题">
              <header>
                <h2>{props.updatesOnly ? "议题的后续变化" : "继续阅读"}</h2>
                <span>每个问题，都可以继续跟进</span>
              </header>
              <div className="journal-collection-grid">
                {rest.slice(0, props.visibleCount).map((issue) => (
                  <article key={issue.id}>
                    <div className="journal-byline">
                      <span>{issue.focus}</span>
                      <time>{shortDate(issue.latest.createdAt)}</time>
                      {issue.latest.version > 1 && (
                        <span className="journal-update-label">有后续</span>
                      )}
                    </div>
                    <EditorialCover
                      revision={issue.latest}
                      dispatch={props.dispatch}
                      onRead={() => props.onRead(issue.latest)}
                    />
                    <h3>
                      <button
                        data-editorial-issue={issue.id}
                        onClick={() => props.onRead(issue.latest)}
                      >
                        {headline(issue.latest)}
                      </button>
                    </h3>
                    <p>{understanding(issue.latest)}</p>
                    <button
                      className="journal-text-action"
                      onClick={() => props.onRead(issue.latest)}
                    >
                      阅读解读
                      <ArrowUpRightIcon size={18} />
                    </button>
                  </article>
                ))}
              </div>
              {rest.length > props.visibleCount && (
                <button
                  className="journal-more"
                  onClick={() => props.onVisibleCount(props.visibleCount + 6)}
                >
                  再看 {Math.min(6, rest.length - props.visibleCount)} 条解读
                  <ArrowRightIcon size={19} />
                </button>
              )}
            </section>
          )}
        </>
      ) : (
        <div className="journal-empty">
          <h2>
            {curatedMode
              ? "本期没有新的选读"
              : props.updatesOnly
                ? "这个范围还没有后续更新"
                : "没有找到相关议题"}
          </h2>
          <p>
            {curatedMode
              ? "已有议题仍可浏览，有值得展开的新理解时再接续。"
              : "换一个关注方向或关键词，继续阅读。"}
          </p>
          <button
            onClick={
              curatedMode ? () => props.onBrowseAll(true) : props.onReset
            }
          >
            {curatedMode ? "浏览全部议题" : "查看全部解读"}
            <ArrowRightIcon size={18} />
          </button>
        </div>
      )}
      {props.edition &&
        lead &&
        props.focus === "全部" &&
        !props.query &&
        !props.updatesOnly && (
          <button
            className="journal-catalog-link"
            onClick={() => props.onBrowseAll(!props.browseAll)}
          >
            {props.browseAll ? "回到本期选读" : "浏览全部议题"}
            <ArrowRightIcon size={18} />
          </button>
        )}
    </div>
  );
}

function JournalStory({
  issue,
  revision,
  prominent = false,
  curated = false,
  reason,
  onRead,
  onHistory,
  onCorrect,
  onSelect,
  dispatch,
}: Pick<
  Props,
  "onRead" | "onHistory" | "onCorrect" | "onSelect" | "dispatch"
> & {
  issue: EditorialIssue;
  revision: EditorialRevision;
  prominent?: boolean;
  curated?: boolean;
  reason?: string;
}) {
  return (
    <article
      className={`journal-story ${prominent ? "journal-lead" : "journal-companion"}`}
      aria-label={prominent ? "重点解读" : "议题短解读"}
    >
      <div className="journal-byline">
        <span>{issue.focus}</span>
        <span>
          {prominent
            ? curated
              ? "本期选读"
              : "最近解读"
            : shortDate(revision.createdAt)}
        </span>
        {revision.version > 1 && (
          <button
            className="journal-update-label"
            onClick={() => onHistory(revision)}
          >
            第 {revision.version} 版 · 有变化
          </button>
        )}
      </div>
      <EditorialCover
        revision={revision}
        dispatch={dispatch}
        onRead={() => onRead(revision)}
      />
      <h2>
        <button
          data-editorial-issue={issue.id}
          onClick={() => onRead(revision)}
        >
          {headline(revision)}
        </button>
      </h2>
      <p className="journal-understanding">{understanding(revision)}</p>
      {revision.version > 1 && (
        <details className="journal-change">
          <summary>
            这次更新了什么
            <ArrowUpRightIcon size={15} />
          </summary>
          <p>{editorialUpdateText(revision.changeSummary)}</p>
          <button onClick={() => onHistory(revision)}>查看判断如何变化</button>
        </details>
      )}
      {prominent && (
        <Interpretation
          revision={revision}
          dispatch={dispatch}
          onInspect={() => onSelect(revision)}
        />
      )}
      <div className="journal-story-footer">
        <button
          className={
            prominent ? "journal-primary-action" : "journal-text-action"
          }
          onClick={() => onRead(revision)}
        >
          阅读解读
          <ArrowRightIcon size={18} />
        </button>
        <span>{readingMinutes(revision)} 分钟</span>
        {prominent && (
          <button
            className="journal-correct"
            aria-label="纠正解读"
            onClick={() => onCorrect(revision)}
          >
            <ChatTeardropTextIcon size={18} />
            纠正
          </button>
        )}
      </div>
      {reason && (
        <details className="journal-editor-note">
          <summary>为什么选这条</summary>
          <p>{reason}</p>
        </details>
      )}
      {issue.latest.id !== revision.id && (
        <div className="radar-new-edition">
          <ArrowClockwiseIcon size={18} />
          <span>这条议题有了新理解</span>
          <button onClick={() => onSelect(issue.latest)}>
            查看新版
            <ArrowRightIcon size={18} />
          </button>
        </div>
      )}
    </article>
  );
}

export function Interpretation({
  revision,
  dispatch,
  detail = false,
  onInspect,
}: {
  revision: EditorialRevision;
  dispatch: Dispatch;
  detail?: boolean;
  onInspect?: () => void;
}) {
  const [evidence, setEvidence] = useState<number | "all" | null>(null);
  const evidenceBox = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const close = () => {
    setEvidence(null);
    trigger.current?.focus({ preventScroll: true });
  };
  const inspect = (value: number | "all") => {
    if (value === evidence) return close();
    onInspect?.();
    trigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setEvidence(value);
  };
  useLayoutEffect(() => {
    if (evidence !== null)
      evidenceBox.current?.scrollIntoView?.({ block: "nearest" });
  }, [evidence]);
  const presentation = revision.presentation;
  const node =
    typeof evidence === "number"
      ? presentation?.visual.items[evidence]
      : undefined;
  const section = node ? revision.sections[node.sectionIndex] : undefined;
  const sources = [
    ...new Set(revision.evidence.map((value) => value.sourceName)),
  ];
  return (
    <div
      className={`journal-interpretation ${detail ? "in-reader" : ""}`}
      onKeyDown={(event) => {
        if (event.key === "Escape" && evidence !== null) {
          event.stopPropagation();
          close();
        }
      }}
    >
      {presentation && presentation.visual.kind !== "none" && (
        <EditorialVisual
          revision={revision}
          selected={typeof evidence === "number" ? evidence : null}
          onInspect={inspect}
        />
      )}
      <div className="journal-evidence-line">
        <button
          onClick={() => inspect("all")}
          aria-expanded={evidence === "all"}
        >
          <FilesIcon size={16} />
          依据 · {sources.slice(0, 2).join("、")}
          {sources.length > 2 ? "等" : ""}
          <ArrowUpRightIcon size={14} />
        </button>
      </div>
      {!detail && (
        <p className="journal-boundary">
          <span>尚不能确定</span>
          {presentation?.boundary.text ?? revision.uncertainties[0]}
        </p>
      )}
      {evidence !== null && (
        <section
          ref={evidenceBox}
          className="radar-inline-evidence"
          aria-label="就地查看依据"
        >
          <header>
            <h3>{node ? `${node.label} · 依据` : "本篇解读的依据"}</h3>
            <button aria-label="收起依据" onClick={close}>
              <XIcon size={20} />
            </button>
          </header>
          {node && (
            <div className="radar-located-quote">
              <span>
                {section?.kind === "analysis"
                  ? "解读中的分析判断"
                  : "解读中的材料表述"}
              </span>
              <p>{node.text}</p>
              <blockquote>{node.quote}</blockquote>
            </div>
          )}
          {revision.evidence
            .filter(
              (material) =>
                evidence === "all" ||
                section?.sourceIds.includes(material.itemId),
            )
            .map((material) => (
              <Material
                key={material.itemId}
                material={material}
                revision={revision}
                dispatch={dispatch}
              />
            ))}
        </section>
      )}
    </div>
  );
}
