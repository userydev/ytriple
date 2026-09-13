import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeftIcon as ArrowLeft,
  ArrowRightIcon as ArrowRight,
  ArrowUpRightIcon as ArrowUpRight,
  BookOpenIcon as BookOpen,
  RssIcon as Rss,
  FilesIcon as FileCheck2,
  ClockCounterClockwiseIcon as History,
  ChatTeardropTextIcon as MessageSquareText,
  ArrowClockwiseIcon as RefreshCw,
  MagnifyingGlassIcon as Search,
  UsersThreeIcon as UsersRound,
} from "@phosphor-icons/react";
import type {
  EditorialCorrection,
  EditorialFocus,
  EditorialIssue,
  EditorialRevision,
} from "@ytriple/source-contract";
import type { RadarSnapshot, Snapshot, Task } from "../shared/types";
import { Markdown, Modal, type Dispatch } from "./common";
import {
  EditorialEdition,
  Interpretation,
  editorialHeading,
  editorialUpdateText,
  readingMinutes,
} from "./EditorialEdition";
import { EditorialCover } from "./EditorialCover";
import { Material } from "./EditorialEvidence";
import { RadarReader } from "./RadarReader";
import { SourceManager } from "./RadarArchive";
import { PortablePanel } from "./Portable";
import {
  MediaFromMaterial,
  radarMediaMaterial,
  type MediaMaterialNavigation,
} from "./MediaFromMaterial";

const empty: RadarSnapshot = {
  configured: false,
  connection: "unconfigured",
  follows: [],
  recommendedSources: [],
  items: [],
  unreadCount: 0,
};
const date = (value: string) =>
  new Date(value).toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const correctionNames: Record<EditorialCorrection["status"], string> = {
  pending: "等待复核",
  accepted: "已采纳并更新",
  unsupported: "现有依据不支持",
  needs_evidence: "仍需补充证据",
};
type Selection = { issueId: string; revision: EditorialRevision };
type ReadingState = {
  selection?: Selection;
  preview?: Selection;
  focus: EditorialFocus | "全部";
  query?: string;
  updatesOnly?: boolean;
  visibleCount?: number;
  browseAll?: boolean;
};
type ReadingPanel = (
  { kind: "evidence"; ids?: string[] } | { kind: "history" | "correction" }
) & { revision?: EditorialRevision };
const readings = new Map<string, ReadingState>();
const handoffs = new Map<string, string>();
const drafts = new Map<string, { text: string; requestId: string }>();

function CorrectionForm({
  identity,
  issue,
  revision,
  dispatch,
  canSubmit,
}: {
  identity: string;
  issue: EditorialIssue | undefined;
  revision: EditorialRevision;
  dispatch: Dispatch;
  canSubmit: boolean;
}) {
  const key = `${identity}:${revision.id}`;
  const [draft, setDraft] = useState(
    () => drafts.get(key) ?? { text: "", requestId: crypto.randomUUID() },
  );
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [notice, setNotice] = useState("");
  return (
    <section className="editorial-correction" aria-label="解读纠正">
      <div>
        <p>指出不准确的判断或补充依据。复核结果会保留在这条议题中。</p>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy.current || !canSubmit || draft.text.trim().length < 3)
              return;
            busy.current = true;
            setPending(true);
            setNotice("");
            try {
              const result = await dispatch({
                type: "radar.correctEditorial",
                issueId: revision.issueId,
                revisionId: revision.id,
                text: draft.text.trim(),
                requestId: draft.requestId,
              });
              if (result) {
                const next = { text: "", requestId: crypto.randomUUID() };
                drafts.delete(key);
                setDraft(next);
                setNotice("纠正已保存，复核结果和后续更新会出现在这条议题中。");
              } else
                setNotice("提交未完成，已保留输入；重试会接续同一条纠正。");
            } catch {
              setNotice("提交未完成，已保留输入；请检查连接或是否出现新版本。");
            } finally {
              busy.current = false;
              setPending(false);
            }
          }}
        >
          <textarea
            aria-label="纠正内容"
            placeholder="具体指出要纠正的判断和依据…"
            maxLength={3000}
            rows={4}
            value={draft.text}
            disabled={pending}
            onChange={(event) => {
              const next = {
                text: event.target.value,
                requestId: crypto.randomUUID(),
              };
              drafts.set(key, next);
              setDraft(next);
            }}
          />
          <button
            className="button primary small"
            disabled={pending || !canSubmit || draft.text.trim().length < 3}
          >
            {pending ? "正在提交…" : "提交纠正"}
          </button>
          {!canSubmit && (
            <p>请打开当前版本并恢复服务连接后提交，输入会保留。</p>
          )}
          {notice && <p role="status">{notice}</p>}
        </form>
      </div>
      {(issue?.corrections.length ?? 0) > 0 && (
        <div className="editorial-correction-records">
          <h3>纠正与复核 · {issue!.corrections.length}</h3>
          {issue!.corrections.map((correction) => (
            <article key={correction.id}>
              <small>
                {correctionNames[correction.status]} ·{" "}
                {date(correction.createdAt)}
              </small>
              <p>{correction.text}</p>
              {correction.response && (
                <p className="editorial-response">
                  {editorialUpdateText(correction.response)}
                </p>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

type Props = MediaMaterialNavigation & {
  snapshot: Snapshot | null;
  dispatch: Dispatch;
  connected: boolean;
  onTask: (taskId: string, task?: Task) => void;
};
export function Radar(props: Props) {
  const identity =
    props.snapshot?.radar?.editorialIdentity ??
    props.snapshot?.radar?.serviceURL ??
    "unconfigured";
  return <EditorialRadar key={identity} {...props} identity={identity} />;
}
function EditorialRadar({
  snapshot,
  dispatch,
  connected,
  onTask,
  onMediaCreated,
  onMediaSetup,
  identity,
}: Props & { identity: string }) {
  const radar = snapshot?.radar ?? empty;
  const [headerHost, setHeaderHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setHeaderHost(document.getElementById("radar-page-header"));
  }, []);
  const [reading, setReading] = useState<ReadingState>(
    () => readings.get(identity) ?? { focus: "全部" },
  );
  const [view, setView] = useState<"editorial" | "materials" | "collections">(
    "editorial",
  );
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [evidenceSection, setEvidenceSection] = useState<number | null>(null);
  const [panel, setPanel] = useState<ReadingPanel | null>(null);
  const [url, setURL] = useState("");
  const followInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const sequence = useRef(0);
  const root = useRef<HTMLElement>(null);
  const overviewScroll = useRef(0);
  const overviewIssue = useRef<string | null>(null);
  const sectionTarget = useRef<number | null>(null);
  const selection = reading.selection;
  const issue = radar.editorial?.issues.find(
    (value) => value.id === selection?.issueId,
  );
  const rawRevision = selection?.revision;
  const revision =
    rawRevision &&
    !rawRevision.presentation &&
    issue?.latest.id === rawRevision.id
      ? { ...rawRevision, presentation: issue.latest.presentation }
      : rawRevision;
  const activePanelRevision = panel?.revision ?? revision;
  const panelIssue = radar.editorial?.issues.find(
    (value) => value.id === activePanelRevision?.issueId,
  );
  const change = (next: ReadingState) => {
    readings.set(identity, next);
    setReading(next);
  };
  const choose = (value: EditorialRevision, sectionIndex?: number) => {
    sequence.current++;
    setPanel(null);
    setEvidenceSection(null);
    sectionTarget.current = sectionIndex ?? null;
    if (!selection) {
      overviewScroll.current = root.current?.scrollTop ?? 0;
      overviewIssue.current = value.issueId;
    }
    change({
      ...reading,
      selection: { issueId: value.issueId, revision: value },
      preview: { issueId: value.issueId, revision: value },
    });
    setError("");
    void dispatch({
      type: "radar.editorialVersion",
      issueId: value.issueId,
      revisionId: value.id,
    }).catch(() => {});
  };
  const back = () => {
    sequence.current++;
    setPanel(null);
    change({ ...reading, selection: undefined });
  };
  useLayoutEffect(() => {
    if (root.current)
      root.current.scrollTop = revision ? 0 : overviewScroll.current;
    if (sectionTarget.current !== null) {
      const target = root.current?.querySelector<HTMLElement>(
        `#editorial-section-${sectionTarget.current}`,
      );
      target?.scrollIntoView?.({ block: "start" });
      target?.focus({ preventScroll: true });
      sectionTarget.current = null;
    } else if (view === "editorial") {
      const target = revision
        ? root.current?.querySelector<HTMLElement>(
            ".editorial-article-heading h2",
          )
        : root.current?.querySelector<HTMLElement>(
            `[data-editorial-issue="${overviewIssue.current}"]`,
          );
      target?.focus({ preventScroll: true });
    }
  }, [revision?.id, view]);
  const begin = async (key: string, action: () => Promise<Snapshot | null>) => {
    if (busy.current) return;
    busy.current = true;
    setPending(key);
    setError("");
    try {
      await action();
    } catch {
      setError("操作未完成，请检查服务连接后重试。");
    } finally {
      busy.current = false;
      setPending(null);
    }
  };
  const refresh = () =>
    void begin("refresh", () => dispatch({ type: "radar.refresh" }));
  const submitFollow = async (event: FormEvent) => {
    event.preventDefault();
    const value = (followInput.current?.value ?? url).trim();
    if (!value) return;
    await begin("follow", async () => {
      const result = await dispatch({ type: "radar.follow", url: value });
      if (result) setURL("");
      return result;
    });
  };
  const loadVersion = async (issueId: string, revisionId: string) => {
    const request = ++sequence.current;
    const cached = radar.editorialVersions?.[revisionId];
    if (cached?.issueId === issueId) {
      choose(cached);
      return;
    }
    await begin(`version:${revisionId}`, async () => {
      const result = await dispatch({
        type: "radar.editorialVersion",
        issueId,
        revisionId,
      });
      const value = result?.radar?.editorialVersions?.[revisionId];
      if (request === sequence.current && value?.issueId === issueId)
        choose(value);
      if (!result) setError("这个版本暂不可读，请检查连接后重试。");
      return result;
    });
  };
  const query = (reading.query ?? "").trim().toLocaleLowerCase();
  const allIssues = radar.editorial?.issues ?? [];
  const issues = allIssues.filter(
    (value) =>
      (reading.focus === "全部" || value.focus === reading.focus) &&
      (!query ||
        [
          value.latest.title,
          value.latest.question,
          value.latest.takeaway,
          value.latest.relationship,
          value.latest.presentation?.headline,
          value.latest.presentation?.summary,
          value.latest.presentation?.visual.conclusion,
          ...(value.latest.presentation?.visual.items.map(
            (item) => item.label,
          ) ?? []),
        ].some((text) => text?.toLocaleLowerCase().includes(query))),
  );
  const focuses = (["全部", "科技", "AI", "金融", "股票"] as const).filter(
    (focus) =>
      focus === "全部" ||
      focus === reading.focus ||
      allIssues.some((value) => value.focus === focus),
  );

  const handoff = () => {
    if (!revision) return;
    void begin("discuss", async () => {
      const handoffKey = `${identity}:${revision.id}`;
      const requestId = handoffs.get(handoffKey) ?? crypto.randomUUID();
      handoffs.set(handoffKey, requestId);
      const result = await dispatch({
        type: "radar.discussEditorial",
        issueId: revision.issueId,
        revisionId: revision.id,
        requestId,
        title: `继续研究 · ${revision.title}`.slice(0, 120),
        instruction: `围绕「${revision.question}」继续研究。先核查附带的第 ${revision.version} 版解读和材料范围，再区分新增证据、分析与仍待验证的条件。成果请保存为可修订的 Markdown。`,
      });
      const task = result?.tasks.find((value) => value.id === requestId);
      if (task) onTask(task.id, task);
      return result;
    });
  };
  const header = (
    <header className="editorial-header">
      <div className="editorial-brand">
        <h1>雷达</h1>
      </div>
      {view === "editorial" && !revision && allIssues[0] && (
        <time
          className="editorial-edition"
          dateTime={
            radar.editorial?.edition?.createdAt ?? allIssues[0].updatedAt
          }
        >
          {date(radar.editorial?.edition?.createdAt ?? allIssues[0].updatedAt)}{" "}
          更新
        </time>
      )}
      <nav className="editorial-navigation" aria-label="雷达导航">
        <button
          aria-current={view === "editorial" ? "page" : undefined}
          onClick={() => {
            setView("editorial");
            back();
          }}
        >
          <BookOpen size={20} /> 解读
        </button>
        <button
          aria-current={view === "materials" ? "page" : undefined}
          onClick={() => setView("materials")}
        >
          <Rss size={20} /> 来源材料
        </button>
        <button
          aria-current={view === "collections" ? "page" : undefined}
          onClick={() => setView("collections")}
        >
          <BookOpen size={20} /> 平台与收藏
        </button>
      </nav>
      <button
        className="editorial-refresh"
        onClick={() =>
          void begin("refresh", () => dispatch({ type: "radar.reload" }))
        }
        disabled={!connected || !radar.configured || Boolean(pending)}
        aria-label="更新雷达"
        title="接收最新解读"
      >
        <RefreshCw size={19} className={pending === "refresh" ? "spin" : ""} />
        <span>刷新</span>
      </button>
    </header>
  );
  return (
    <section className="radar-page editorial-page" aria-label="雷达" ref={root}>
      <div className="editorial-inner">
        {headerHost ? createPortal(header, headerHost) : header}
        {radar.connection === "offline" && (
          <p className="editorial-status" role="status">
            服务暂时离线，正在显示已保存的解读。
          </p>
        )}
        {error && (
          <p role="alert" className="editorial-status">
            {error}
          </p>
        )}
        {view === "collections" ? (
          snapshot ? (
            <section
              className="editorial-management-view"
              aria-label="导入自己的材料"
            >
              <div className="editorial-secondary-heading">
                <button
                  className="text-button"
                  onClick={() => setView("editorial")}
                >
                  <ArrowLeft size={15} /> 返回解读
                </button>
                <h2>导入自己的材料</h2>
                <p>把链接、收藏或文章交给团队，保留实际读取范围。</p>
              </div>
              <PortablePanel
                mode="imports"
                snapshot={snapshot}
                dispatch={dispatch}
                onTask={onTask}
              />
            </section>
          ) : null
        ) : view === "materials" ? (
          <>
            <div className="editorial-sources-heading">
              <div>
                <button
                  className="text-button"
                  onClick={() => setView("editorial")}
                >
                  <ArrowLeft size={15} /> 返回解读
                </button>
                <h2>来源材料</h2>
                <p>阅读已取得的内容，按实际覆盖判断。</p>
              </div>
            </div>
            <RadarReader
              radar={radar}
              dispatch={dispatch}
              onTask={onTask}
              onSources={() => setSourcesOpen(true)}
              tasks={snapshot?.tasks ?? []}
              onImport={() => setView("collections")}
            />
          </>
        ) : revision ? (
          <>
            <nav className="editorial-reading-actions" aria-label="解读操作">
              <button className="editorial-back" onClick={back}>
                <ArrowLeft size={16} /> 全部解读
              </button>
              <div>
                <button onClick={() => setPanel({ kind: "evidence" })}>
                  <FileCheck2 size={16} /> 查看依据{" "}
                  <span>{revision.evidence.length}</span>
                </button>
                <button onClick={() => setPanel({ kind: "correction" })}>
                  <MessageSquareText size={16} /> 纠正解读
                  {issue?.corrections.some(
                    (value) => value.status === "pending",
                  ) && (
                    <span
                      className="editorial-pending-dot"
                      aria-label="有纠正等待复核"
                    />
                  )}
                </button>
                <button onClick={() => setPanel({ kind: "history" })}>
                  <History size={16} /> 历史{" "}
                  <span>{issue?.history.length ?? 1}</span>
                </button>
                <button
                  className="editorial-research"
                  disabled={Boolean(pending) || !connected}
                  onClick={handoff}
                  aria-label="交给团队继续"
                  title="将当前版本和依据带入团队研究"
                >
                  <UsersRound size={16} />{" "}
                  {pending === "discuss" ? "正在打开…" : "继续研究"}
                </button>
                {snapshot && (
                  <MediaFromMaterial
                    snapshot={snapshot}
                    dispatch={dispatch}
                    material={radarMediaMaterial(revision, identity)}
                    disabled={Boolean(pending)}
                    onMediaCreated={onMediaCreated}
                    onMediaSetup={onMediaSetup}
                  />
                )}
              </div>
            </nav>
            <article className="editorial-detail" aria-label="议题解读">
              {issue && issue.latest.id !== revision.id && (
                <div className="editorial-update" role="status">
                  <span>
                    这条议题已有新解读 ·{" "}
                    {editorialUpdateText(issue.latest.changeSummary)}
                  </span>
                  <button
                    className="button primary small"
                    onClick={() => choose(issue.latest)}
                  >
                    阅读当前版本
                  </button>
                </div>
              )}
              <EditorialCover
                key={revision.id}
                revision={revision}
                dispatch={dispatch}
              />
              <header className="editorial-article-heading">
                <div>
                  <div className="editorial-meta">
                    <span className="editorial-focus-tag">
                      {issue?.focus ?? "持续议题"}
                    </span>
                    <span>{date(revision.createdAt)} · 解读更新</span>
                    <span>第 {revision.version} 版</span>
                  </div>
                  <h2 tabIndex={-1}>{editorialHeading(revision).main}</h2>
                  {editorialHeading(revision).deck && (
                    <p className="editorial-question">
                      {editorialHeading(revision).deck}
                    </p>
                  )}
                  <span className="editorial-reading-time">
                    约 {readingMinutes(revision)} 分钟阅读
                  </span>
                </div>
              </header>
              <div className="editorial-reading-layout">
                <div className="editorial-reading-column">
                  <section
                    className="editorial-lead"
                    id="editorial-summary"
                    tabIndex={-1}
                  >
                    <div className="editorial-eyebrow">先看结论</div>
                    <Markdown dispatch={dispatch}>{revision.takeaway}</Markdown>
                  </section>
                  {revision.presentation?.visual.kind &&
                  revision.presentation.visual.kind !== "none" ? (
                    <Interpretation
                      key={revision.id}
                      revision={revision}
                      dispatch={dispatch}
                      detail
                    />
                  ) : (
                    <blockquote className="editorial-relationship">
                      <p>{revision.relationship}</p>
                    </blockquote>
                  )}
                  {revision.sections.map((section, index) => (
                    <section
                      className="editorial-section"
                      id={`editorial-section-${index}`}
                      tabIndex={-1}
                      key={`${revision.id}:${index}`}
                    >
                      <div className="editorial-section-label">
                        <span className="editorial-section-number">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <span className={`editorial-kind ${section.kind}`}>
                          {section.kind === "fact" ? "材料所述" : "分析判断"}
                        </span>
                      </div>
                      <h3>{section.heading}</h3>
                      <Markdown dispatch={dispatch}>{section.body}</Markdown>
                      <button
                        className="editorial-citations"
                        aria-expanded={evidenceSection === index}
                        onClick={() =>
                          setEvidenceSection(
                            evidenceSection === index ? null : index,
                          )
                        }
                      >
                        <FileCheck2 size={14} /> 依据 ·{" "}
                        {section.sourceIds
                          .map(
                            (id) =>
                              revision.evidence.find(
                                (source) => source.itemId === id,
                              )?.sourceName,
                          )
                          .filter(
                            (name, index, all) =>
                              name && all.indexOf(name) === index,
                          )
                          .join("、")}{" "}
                        <ArrowUpRight size={13} />
                      </button>
                      {evidenceSection === index && (
                        <aside
                          className="radar-inline-evidence"
                          aria-label="段落依据"
                        >
                          {revision.evidence
                            .filter((material) =>
                              section.sourceIds.includes(material.itemId),
                            )
                            .map((material) => (
                              <Material
                                key={material.itemId}
                                material={material}
                                revision={revision}
                                dispatch={dispatch}
                              />
                            ))}
                        </aside>
                      )}
                    </section>
                  ))}
                  <section
                    className="editorial-conditions"
                    id="editorial-conditions"
                    tabIndex={-1}
                    aria-label="判断的边界与后续观察"
                  >
                    <div>
                      <h3>
                        <span className="editorial-condition-dot" />
                        尚不能确定
                      </h3>
                      <ul>
                        {revision.uncertainties.map((value, index) => (
                          <li key={index}>{value}</li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <h3>
                        <span className="editorial-condition-dot" />
                        继续观察什么
                      </h3>
                      <ul>
                        {revision.watchFor.map((value, index) => (
                          <li key={index}>{value}</li>
                        ))}
                      </ul>
                    </div>
                  </section>
                </div>
              </div>
              <footer className="editorial-detail-footer">
                <span>这条议题会随新证据接续更新</span>
                <button onClick={() => setPanel({ kind: "correction" })}>
                  发现不准确？纠正解读 <ArrowRight size={14} />
                </button>
              </footer>
            </article>
          </>
        ) : (
          <>
            {radar.editorial?.status.state === "retrying" && (
              <p role="status" className="editorial-status">
                {radar.editorial.status.message}
              </p>
            )}
            {allIssues.length > 0 ? (
              <EditorialEdition
                issues={issues}
                edition={radar.editorial?.edition}
                browseAll={reading.browseAll ?? false}
                onBrowseAll={(browseAll) =>
                  change({ ...reading, browseAll, visibleCount: 6 })
                }
                active={reading.preview?.revision}
                focus={reading.focus}
                focuses={focuses}
                query={reading.query ?? ""}
                visibleCount={reading.visibleCount ?? 6}
                onVisibleCount={(visibleCount) =>
                  change({ ...reading, visibleCount })
                }
                onReset={() =>
                  change({
                    ...reading,
                    focus: "全部",
                    query: "",
                    updatesOnly: false,
                    visibleCount: 6,
                    browseAll: false,
                  })
                }
                updatesOnly={reading.updatesOnly ?? false}
                onUpdatesOnly={(updatesOnly) =>
                  change({ ...reading, updatesOnly, visibleCount: 6 })
                }
                onFocus={(focus) =>
                  change({ ...reading, focus, visibleCount: 6 })
                }
                onQuery={(query) =>
                  change({ ...reading, query, visibleCount: 6 })
                }
                onSelect={(value) =>
                  change({
                    ...reading,
                    preview: { issueId: value.issueId, revision: value },
                  })
                }
                onRead={choose}
                onHistory={(value) =>
                  setPanel({ kind: "history", revision: value })
                }
                onCorrect={(value) =>
                  setPanel({ kind: "correction", revision: value })
                }
                dispatch={dispatch}
              />
            ) : (
              <div className="editorial-empty">
                {query ? <Search size={28} /> : <BookOpen size={28} />}
                <h2>
                  {query
                    ? "没有找到匹配的议题"
                    : radar.configured
                      ? "这个方向还在积累中"
                      : "从自己的材料开始阅读"}
                </h2>
                <p>
                  {query
                    ? "试试其他关键词，或回到全部解读。"
                    : radar.configured
                      ? "有值得展开的新理解后，会出现在这里。也可以先查看收到的来源材料。"
                      : "导入链接、收藏或文章，让团队整理值得理解的问题。已有自己的来源也能继续阅读，无需先连接订阅服务。"}
                </p>
                {query ? (
                  <button
                    className="button secondary"
                    onClick={() => change({ focus: "全部", query: "" })}
                  >
                    回到全部解读
                  </button>
                ) : radar.configured ? (
                  <button
                    className="button secondary"
                    onClick={() => setView("materials")}
                  >
                    查看来源材料 <ArrowRight size={16} />
                  </button>
                ) : (
                  <div className="editorial-empty-actions">
                    <button
                      className="button primary"
                      onClick={() => setView("collections")}
                    >
                      导入链接或收藏 <ArrowRight size={16} />
                    </button>
                    {radar.items.length ? (
                      <button
                        className="text-button"
                        onClick={() => setView("materials")}
                      >
                        阅读已有来源
                      </button>
                    ) : null}
                    <button
                      className="text-button"
                      onClick={() => setSourcesOpen(true)}
                    >
                      连接信息服务
                    </button>
                  </div>
                )}
              </div>
            )}
            <footer className="editorial-footer">
              {(radar.digestions?.length ?? 0) > 0 && (
                <button onClick={() => setArchiveOpen(true)}>
                  以往团队记录
                </button>
              )}
            </footer>
          </>
        )}
      </div>
      {panel && activePanelRevision && view === "editorial" && (
        <Modal
          title={
            panel.kind === "evidence"
              ? "解读依据"
              : panel.kind === "history"
                ? "议题历史"
                : "纠正解读"
          }
          description={`第 ${activePanelRevision.version} 版 · ${editorialHeading(activePanelRevision).main}`}
          onClose={() => setPanel(null)}
          wide={panel.kind === "evidence"}
        >
          <div className="editorial-dialog">
            {error && (
              <p className="editorial-status" role="alert">
                {error}
              </p>
            )}
            {panel.kind === "evidence" ? (
              <div className="editorial-evidence-list">
                {activePanelRevision.evidence
                  .filter(
                    (value) => !panel.ids || panel.ids.includes(value.itemId),
                  )
                  .map((material) => (
                    <Material
                      key={material.itemId}
                      material={material}
                      revision={activePanelRevision}
                      dispatch={dispatch}
                    />
                  ))}
              </div>
            ) : panel.kind === "history" ? (
              <ol className="editorial-history">
                {(panelIssue?.history ?? [activePanelRevision]).map(
                  (version) => (
                    <li key={version.id}>
                      <div className="editorial-history-marker">
                        {version.version}
                      </div>
                      <div>
                        <div className="editorial-meta">
                          <span>第 {version.version} 版</span>
                          <span>{date(version.createdAt)}</span>
                        </div>
                        <p>{editorialUpdateText(version.changeSummary)}</p>
                        <button
                          className="button secondary small"
                          disabled={
                            version.id === activePanelRevision.id ||
                            Boolean(pending)
                          }
                          onClick={() =>
                            void loadVersion(
                              activePanelRevision.issueId,
                              version.id,
                            )
                          }
                        >
                          {version.id === activePanelRevision.id
                            ? "正在阅读"
                            : "阅读这一版"}
                        </button>
                      </div>
                    </li>
                  ),
                )}
              </ol>
            ) : (
              <CorrectionForm
                key={activePanelRevision.id}
                identity={identity}
                issue={panelIssue}
                revision={activePanelRevision}
                dispatch={dispatch}
                canSubmit={
                  connected &&
                  radar.connection === "online" &&
                  panelIssue?.latest.id === activePanelRevision.id
                }
              />
            )}
          </div>
        </Modal>
      )}
      {archiveOpen && (
        <Modal
          title="以往团队记录"
          description="保留此前形成的团队判断。"
          onClose={() => setArchiveOpen(false)}
        >
          <div className="editorial-dialog editorial-legacy-records">
            {radar.digests?.length ? (
              radar.digests.map((digest) => {
                const task = snapshot?.tasks.find(
                  (value) => value.id === digest.taskId,
                );
                return (
                  <article key={digest.id}>
                    <small>{date(digest.publishedAt)}</small>
                    <h3>{digest.title}</h3>
                    <Markdown dispatch={dispatch}>{digest.summary}</Markdown>
                    {task && (
                      <button
                        className="button secondary small"
                        onClick={() => onTask(task.id, task)}
                      >
                        打开团队工作 <ArrowUpRight size={14} />
                      </button>
                    )}
                  </article>
                );
              })
            ) : (
              <p>此前的处理尚未形成已发布的团队解读。</p>
            )}
          </div>
        </Modal>
      )}
      {sourcesOpen && (
        <SourceManager
          radar={radar}
          connected={connected}
          pending={pending}
          url={url}
          followInput={followInput}
          onURL={setURL}
          onSubmit={submitFollow}
          onRefresh={refresh}
          onClose={() => setSourcesOpen(false)}
          dispatch={dispatch}
          begin={begin}
        />
      )}
    </section>
  );
}
