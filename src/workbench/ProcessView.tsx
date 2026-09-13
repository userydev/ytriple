import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleAlert,
  FileText,
  LoaderCircle,
  Pause,
  Search,
  X,
} from "lucide-react";
import {
  buildAgentProgress,
  buildProcessSources,
  currentProgressEvents,
  publicReportDetails,
  publicSearchQueries,
  safePublicURL,
  SOURCE_STATUS_NAMES,
  type ProgressStatus,
} from "../shared/progress";
import {
  buildProcessStory,
  type ProcessReference,
  type ProcessStoryEntry,
} from "../shared/process-story";
import type { MemberId, Task, TaskEvent } from "../shared/types";
import { formatTime, Markdown, memberName, type Dispatch } from "./common";
import { projectRequestText } from "../shared/project-context";
import { SkillUsage } from "./Skills";

type Scope = "all" | "goal" | "run";
type Inspection = { ownerId: string; reference: ProcessReference } | null;
type ProcessProps = {
  task: Task;
  dispatch: Dispatch;
  compact?: boolean;
  onArtifactOpen?: (id: string) => void;
};
const statusNames: Record<ProgressStatus, string> = {
  running: "正在工作",
  completed: "已完成",
  waiting: "等待回复",
  paused: "已暂停",
  failed: "需要处理",
  stale: "待核实",
};
const provenanceNames: Record<ProcessStoryEntry["provenance"], string> = {
  public_report: "公开分析",
  public_reply: "公开回复",
  user_request: "用户要求",
  revision_record: "修订记录",
};
interface ReadingState {
  member: MemberId | "all";
  scope: Scope;
  inspection: Inspection;
  sourcesOpen: boolean;
  recordsOpen: boolean;
  reviewOpen: boolean;
  allRecords: boolean;
  details: Set<string>;
  scrollTop: number;
}
const readingStates = new Map<string, ReadingState>();
function readingState(taskId: string): ReadingState {
  const existing = readingStates.get(taskId);
  if (existing) return existing;
  const initial: ReadingState = {
    member: "all",
    scope: "all",
    inspection: null,
    sourcesOpen: false,
    recordsOpen: false,
    reviewOpen: false,
    allRecords: false,
    details: new Set(),
    scrollTop: 0,
  };
  readingStates.set(taskId, initial);
  return initial;
}
const saveStates = new Map<string, { pending: boolean; error: string }>();
const saveListeners = new Set<() => void>();
const emptySave = { pending: false, error: "" };
function saveState(taskId: string) {
  return saveStates.get(taskId) ?? emptySave;
}
function updateSave(taskId: string, value: typeof emptySave) {
  saveStates.set(taskId, value);
  for (const listener of saveListeners) listener();
}
function subscribeSave(listener: () => void) {
  saveListeners.add(listener);
  return () => {
    saveListeners.delete(listener);
  };
}
function StateIcon({ status }: { status: ProgressStatus }) {
  return status === "running" ? (
    <LoaderCircle size={12} className="spin" />
  ) : status === "completed" ? (
    <Check size={12} />
  ) : status === "paused" ? (
    <Pause size={12} />
  ) : status === "failed" ? (
    <CircleAlert size={12} />
  ) : (
    <span className="small-dot" />
  );
}
function isPublicEvent(event: TaskEvent) {
  return /^(run_|agent_|delegation_|tool_|skill_|progress[_.]reported|artifact_written|clarification_requested|goal_|source_|public_response)/.test(
    event.type,
  );
}
function AnalysisDetails({
  report,
  dispatch,
  onArtifactOpen,
  omitDetail = false,
}: {
  report: TaskEvent;
  dispatch: Dispatch;
  onArtifactOpen: (id: string) => void;
  omitDetail?: boolean;
}) {
  const { detail, method, questions } = publicReportDetails(report);
  if ((!detail || omitDetail) && !method && !questions.length) return null;
  return (
    <details
      className="analysis-full-detail"
      data-reading-key={`analysis:${report.id}`}
    >
      <summary>
        公开解释与核查方法 <ChevronDown size={12} />
      </summary>
      {method ? (
        <div className="analysis-detail-block">
          <strong>核查方法</strong>
          <Markdown dispatch={dispatch} onArtifactLink={onArtifactOpen}>
            {method}
          </Markdown>
        </div>
      ) : null}
      {detail && !omitDetail ? (
        <div className="analysis-detail-block">
          <Markdown dispatch={dispatch} onArtifactLink={onArtifactOpen}>
            {detail}
          </Markdown>
        </div>
      ) : null}
      {questions.length ? (
        <div className="analysis-detail-block">
          <strong>当时仍待解决</strong>
          <ul>
            {questions.map((question, index) => (
              <li key={index}>{question}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </details>
  );
}
function ReferenceInspector({
  reference,
  task,
  dispatch,
  onArtifactOpen,
  onClose,
}: {
  reference: ProcessReference;
  task: Task;
  dispatch: Dispatch;
  onArtifactOpen: (id: string) => void;
  onClose: () => void;
}) {
  const source =
    reference.kind === "source"
      ? task.sources.find((item) => item.id === reference.id)
      : undefined;
  const artifact =
    reference.kind === "artifact"
      ? task.artifacts.find((item) => item.id === reference.id)
      : undefined;
  const version = artifact?.versions.find(
    (item) =>
      item.version === reference.version &&
      (!reference.hash || item.hash === reference.hash),
  );
  const currentArtifact =
    artifact &&
    reference.version === artifact.version &&
    (!reference.hash || artifact.hash === reference.hash);
  const event =
    reference.kind === "event"
      ? task.events.find((item) => item.id === reference.id)
      : undefined;
  const message =
    reference.kind === "message"
      ? task.messages.find((item) => item.id === reference.id)
      : undefined;
  const sourceURL =
    source?.type === "url" ? safePublicURL(source.location) : undefined;
  const sourceMismatch =
    source?.remote &&
    reference.hash &&
    source.remote.contentHash !== reference.hash;
  const sourceText =
    source && !sourceMismatch
      ? source.text.slice(reference.readStart ?? 0, reference.readEnd ?? 7000)
      : "";
  return (
    <aside className="process-reference-inspector" aria-label="过程依据详情">
      <header>
        <strong>{reference.label}</strong>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭过程依据"
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </header>
      <p className="work-content-muted">
        {reference.goalVersion
          ? `目标第 ${reference.goalVersion} 版`
          : "本次工作依据"}
        {reference.version ? ` · 成果 v${reference.version}` : ""}
        {reference.revisionId ? ` · 来源版本 ${reference.revisionId}` : ""}
      </p>
      {reference.hash ? (
        <p className="process-reference-fingerprint">
          内容指纹 <code>{reference.hash}</code>
        </p>
      ) : null}
      {reference.coverage ? (
        <p className="process-reference-coverage">{reference.coverage}</p>
      ) : null}
      {reference.readStart !== undefined && reference.readEnd !== undefined ? (
        <p className="process-reference-coverage">
          记录的读取范围：第 {reference.readStart + 1}–{reference.readEnd}{" "}
          字符。
        </p>
      ) : null}
      {source ? (
        <>
          <p className="work-content-muted">
            任务保留资料范围：{source.coverage}
          </p>
          {sourceText ? (
            <div className="process-source-text">{sourceText}</div>
          ) : (
            <p className="work-content-muted">
              {sourceMismatch
                ? "当前资料与引用指纹不一致，未用当前正文替代历史版本。"
                : "没有可显示的正文。"}
            </p>
          )}
          <p className="work-content-muted">
            这里展示任务保存的材料；实际读取以所记录的范围为准。
          </p>
          {sourceURL ? (
            <button
              className="text-button"
              onClick={() =>
                void dispatch({ type: "url.open", url: sourceURL })
              }
            >
              打开来源 <ArrowUpRight size={12} />
            </button>
          ) : null}
        </>
      ) : null}
      {artifact ? (
        currentArtifact ? (
          <>
            <p>
              {artifact.title} · v{artifact.version}
            </p>
            <button
              className="text-button"
              onClick={() => onArtifactOpen(artifact.id)}
            >
              阅读这一版成果 <ArrowUpRight size={12} />
            </button>
          </>
        ) : version ? (
          <>
            <p>{version.summary || "已保存的成果版本"}</p>
            <button
              className="text-button"
              onClick={() =>
                void dispatch({ type: "path.reveal", path: version.path })
              }
            >
              定位成果 v{version.version} 文件 <ArrowUpRight size={12} />
            </button>
          </>
        ) : (
          <p className="work-content-muted">
            {reference.version
              ? "引用的历史版本未保留在当前成果中。"
              : "这条引用没有记录当时版本。"}
            当前最新为 v{artifact.version}，未替代该引用。
          </p>
        )
      ) : null}
      {event ? (
        <>
          <p>{event.summary}</p>
          <AnalysisDetails
            report={event}
            dispatch={dispatch}
            onArtifactOpen={onArtifactOpen}
          />
          {event.type === "delegation_completed" &&
          typeof event.data?.request === "string" ? (
            <details>
              <summary>实际委派内容</summary>
              <Markdown dispatch={dispatch} onArtifactLink={onArtifactOpen}>
                {event.data.request}
              </Markdown>
            </details>
          ) : null}
        </>
      ) : null}
      {message ? (
        <Markdown dispatch={dispatch} onArtifactLink={onArtifactOpen}>
          {message.content}
        </Markdown>
      ) : null}
      {!source && !artifact && !event && !message ? (
        <p className="work-content-muted">
          这项依据已不在当前工作中，保留引用信息供核对。
        </p>
      ) : null}
    </aside>
  );
}
function References({
  ownerId,
  references,
  inspection,
  setInspection,
  task,
  dispatch,
  onArtifactOpen,
}: {
  ownerId: string;
  references: ProcessReference[];
  inspection: Inspection;
  setInspection: (value: Inspection) => void;
  task: Task;
  dispatch: Dispatch;
  onArtifactOpen: (id: string) => void;
}) {
  const selected = (reference: ProcessReference) =>
    inspection?.ownerId === ownerId &&
    inspection.reference.kind === reference.kind &&
    inspection.reference.id === reference.id &&
    inspection.reference.version === reference.version;
  return references.length ? (
    <div className="process-story-references">
      <div className="process-reference-links">
        {references.map((reference, index) => (
          <button
            className="text-button"
            key={`${reference.kind}:${reference.id}:${reference.version ?? ""}:${index}`}
            aria-expanded={selected(reference)}
            onClick={() =>
              setInspection(selected(reference) ? null : { ownerId, reference })
            }
          >
            <FileText size={11} />
            {reference.kind === "event" ? "当时的公开记录" : reference.label}
            {reference.version ? ` · v${reference.version}` : ""}
          </button>
        ))}
      </div>
      {inspection?.ownerId === ownerId ? (
        <ReferenceInspector
          reference={inspection.reference}
          task={task}
          dispatch={dispatch}
          onArtifactOpen={onArtifactOpen}
          onClose={() => setInspection(null)}
        />
      ) : null}
    </div>
  ) : null;
}
function StoryEntry({
  entry,
  task,
  dispatch,
  onArtifactOpen,
  inspection,
  setInspection,
}: {
  entry: ProcessStoryEntry;
  task: Task;
  dispatch: Dispatch;
  onArtifactOpen: (id: string) => void;
  inspection: Inspection;
  setInspection: (value: Inspection) => void;
}) {
  const report =
    entry.provenance === "public_report"
      ? task.events.find((event) =>
          entry.references.some(
            (reference) =>
              reference.kind === "event" && reference.id === event.id,
          ),
        )
      : undefined;
  // Shared story headings come from the public content. Remove that exact first
  // heading from the body so the same sentence is not presented twice.
  const firstHeading = entry.content.match(/^#{1,6}\s+(.+)(?:\r?\n|$)/);
  const firstLine = entry.content.split(/\r?\n/, 1)[0];
  const body =
    firstHeading && firstHeading[1] === entry.title
      ? entry.content.slice(firstHeading[0].length).trim()
      : firstLine === entry.title && entry.content !== firstLine
        ? entry.content.slice(firstLine.length).trim()
        : entry.content;
  const titleIsBody = !firstHeading && entry.title === entry.content;
  return (
    <article
      className={`process-story-entry entry-${entry.kind}`}
      id={`process-entry-${entry.id}`}
      data-provenance={entry.provenance}
    >
      <div className="process-story-byline">
        <strong>
          {entry.member
            ? memberName(entry.member, task.teamMode)
            : entry.provenance === "user_request"
              ? "Y"
              : "工作记录"}
        </strong>
        <span>
          {entry.interaction === "request"
            ? "委派问题"
            : provenanceNames[entry.provenance]}
        </span>
        <time>{formatTime(entry.createdAt)}</time>
      </div>
      {!titleIsBody ? <h3>{entry.title}</h3> : null}
      {body ? (
        <Markdown dispatch={dispatch} onArtifactLink={onArtifactOpen}>
          {body}
        </Markdown>
      ) : null}
      {entry.truncated ? (
        <p className="process-record-coverage">原记录为公开回复节选。</p>
      ) : null}
      {report ? (
        <AnalysisDetails
          report={report}
          dispatch={dispatch}
          onArtifactOpen={onArtifactOpen}
          omitDetail={Boolean(
            publicReportDetails(report).detail &&
            entry.content.includes(publicReportDetails(report).detail),
          )}
        />
      ) : null}
      <References
        ownerId={entry.id}
        references={entry.references}
        inspection={inspection}
        setInspection={setInspection}
        task={task}
        dispatch={dispatch}
        onArtifactOpen={onArtifactOpen}
      />
    </article>
  );
}
function ProcessStoryView({
  task,
  dispatch,
  compact,
  onArtifactOpen,
}: ProcessProps) {
  const remembered = readingState(task.id);
  const section = useRef<HTMLElement>(null);
  const [member, setMember] = useState<MemberId | "all">(
    () => remembered.member,
  );
  const [scope, setScope] = useState<Scope>(() => remembered.scope);
  const [inspection, setInspection] = useState<Inspection>(
    () => remembered.inspection,
  );
  const [sourcesOpen, setSourcesOpen] = useState(() => remembered.sourcesOpen);
  const [recordsOpen, setRecordsOpen] = useState(() => remembered.recordsOpen);
  const [reviewOpen, setReviewOpen] = useState(() => remembered.reviewOpen);
  const [allRecords, setAllRecords] = useState(() => remembered.allRecords);
  useLayoutEffect(() => {
    Object.assign(readingState(task.id), {
      member,
      scope,
      inspection,
      sourcesOpen,
      recordsOpen,
      reviewOpen,
      allRecords,
    });
  }, [
    task.id,
    member,
    scope,
    inspection,
    sourcesOpen,
    recordsOpen,
    reviewOpen,
    allRecords,
  ]);
  useLayoutEffect(() => {
    const node = section.current;
    const scroller = node?.closest<HTMLElement>(".work-content-body") ?? node;
    if (!node || !scroller) return;
    scroller.scrollTop = readingState(task.id).scrollTop;
    const saveScroll = () => {
      readingState(task.id).scrollTop = scroller.scrollTop;
    };
    const saveDetails = (event: Event) => {
      const detail = event.target as HTMLDetailsElement;
      const key = detail.dataset.readingKey;
      if (!key) return;
      const state = readingState(task.id);
      if (detail.open) state.details.add(key);
      else state.details.delete(key);
    };
    scroller.addEventListener("scroll", saveScroll, { passive: true });
    node.addEventListener("toggle", saveDetails, true);
    return () => {
      saveScroll();
      scroller.removeEventListener("scroll", saveScroll);
      node.removeEventListener("toggle", saveDetails, true);
    };
  }, [task.id]);
  useLayoutEffect(() => {
    const opened = readingState(task.id).details;
    for (const detail of section.current?.querySelectorAll<HTMLDetailsElement>(
      "details[data-reading-key]",
    ) ?? []) {
      const next = opened.has(detail.dataset.readingKey!);
      if (Boolean(detail.open) !== next) detail.open = next;
    }
  });
  const saving = useSyncExternalStore(subscribeSave, () => saveState(task.id));
  const story = buildProcessStory(task, {
    scope,
    ...(member === "all" ? {} : { member }),
  });
  const allStory =
    member === "all" ? story : buildProcessStory(task, { scope });
  const participants = [
    ...new Set(
      allStory.entries.flatMap((entry) => (entry.member ? [entry.member] : [])),
    ),
  ];
  const analysisEntries = story.entries.filter(
    (entry) =>
      entry.provenance === "public_report" ||
      entry.provenance === "public_reply",
  );
  const analysisGoal = analysisEntries.some(
    (entry) => entry.goalVersion === task.goalVersion,
  )
    ? task.goalVersion
    : analysisEntries.at(-1)?.goalVersion;
  const currentAnalysis = analysisEntries.filter(
    (entry) => entry.goalVersion === analysisGoal,
  );
  const decision = [...currentAnalysis]
    .reverse()
    .find((entry) => entry.kind === "decision");
  const correction = [...currentAnalysis]
    .reverse()
    .find((entry) => entry.kind === "revision");
  const lead =
    correction &&
    (!decision ||
      currentAnalysis.indexOf(correction) > currentAnalysis.indexOf(decision))
      ? correction
      : decision;
  const history = analysisEntries.filter(
    (entry) => entry.goalVersion !== analysisGoal,
  );
  const context = story.entries.filter(
    (entry) =>
      entry.provenance !== "public_report" &&
      entry.provenance !== "public_reply",
  );
  const lanes = buildAgentProgress(task);
  const status = (
    {
      idle: "paused",
      running: "running",
      completed: "completed",
      waiting: "waiting",
      paused: "paused",
      failed: "failed",
    } as const
  )[task.status];
  const events = (
    scope === "run"
      ? currentProgressEvents(task)
      : scope === "goal"
        ? task.events.filter((event) => event.goalVersion === task.goalVersion)
        : task.events
  ).filter(isPublicEvent);
  const visibleEvents = events.filter(
    (event) => member === "all" || event.member === member,
  );
  const sources = buildProcessSources(task, visibleEvents);
  const queries = publicSearchQueries(visibleEvents);
  const records = allRecords ? visibleEvents : visibleEvents.slice(-80);
  const reviewCount =
    story.review.effective.length +
    story.review.issues.length +
    story.review.unverified.length;
  const openArtifact = (id: string) => {
    if (!task.artifacts.some((artifact) => artifact.id === id)) return;
    if (onArtifactOpen) onArtifactOpen(id);
    else void dispatch({ type: "window.focus", window: "artifact" });
  };
  const saveSummary = async () => {
    if (saveState(task.id).pending) return;
    updateSave(task.id, { pending: true, error: "" });
    try {
      const result = await dispatch({
        type: "process.save",
        taskId: task.id,
        scope,
        ...(member === "all" ? {} : { member }),
      });
      if (!result) throw new Error("过程总结未保存，请重试。已有内容仍保留。");
      updateSave(task.id, { pending: false, error: "" });
    } catch (error) {
      updateSave(task.id, {
        pending: false,
        error:
          error instanceof Error ? error.message : "过程总结未保存，请重试。",
      });
    }
  };
  return (
    <section
      ref={section}
      className={`process-view work-process ${compact ? "compact" : ""}`}
      aria-label="Agent 协作过程"
    >
      <header className="process-story-header">
        <div>
          <h2>分析与判断</h2>
          <p>
            {memberName(task.member, task.teamMode)}负责{" "}
            <span className={`process-state state-${task.status}`}>
              <StateIcon status={status} />
              {task.status === "idle" ? "尚未开始" : statusNames[status]}
            </span>
          </p>
        </div>
        <button
          className="button secondary process-save"
          disabled={saving.pending || (!story.entries.length && !reviewCount)}
          onClick={() => void saveSummary()}
        >
          <FileText size={14} />
          {saving.pending ? "正在整理…" : "总结并保存"}
        </button>
      </header>
      {saving.error ? (
        <p className="inline-notice warning" role="alert">
          {saving.error}
        </p>
      ) : null}
      <div className="process-story-controls">
        <label>
          <span className="sr-only">过程范围</span>
          <select
            aria-label="过程范围"
            value={scope}
            onChange={(event) => {
              setScope(event.currentTarget.value as Scope);
              setAllRecords(false);
              setInspection(null);
            }}
          >
            <option value="all">全部目标与修正</option>
            <option value="goal">当前目标</option>
            <option value="run">本次处理</option>
          </select>
        </label>
        {participants.length > 1 ? (
          <label>
            <span className="sr-only">关注成员观点</span>
            <select
              aria-label="关注成员观点"
              value={member}
              onChange={(event) => {
                setMember(event.currentTarget.value as MemberId | "all");
                setInspection(null);
              }}
            >
              <option value="all">团队整体</option>
              {participants.map((id) => (
                <option key={id} value={id}>
                  {memberName(id, task.teamMode)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button
          className="text-button"
          aria-expanded={reviewOpen}
          onClick={() => {
            setReviewOpen(!reviewOpen);
            setInspection(null);
          }}
        >
          {reviewOpen ? "收起复盘" : "回看得失"}
          {reviewCount ? ` · ${reviewCount}` : ""}
        </button>
      </div>
      <details className="process-current-goal" data-reading-key="goal">
        <summary>
          当前目标 · 第 {task.goalVersion} 版{" "}
          <span>
            {task.projectId ? projectRequestText(task.goal) : task.goal}
          </span>
        </summary>
        <p>{task.goal}</p>
      </details>
      {reviewOpen ? (
        <section className="process-retrospective" aria-label="过程复盘">
          <header>
            <h2>回看这次工作</h2>
            <p>以下归纳来自公开内容与实际记录，可逐项核对。</p>
          </header>
          {(
            [
              ["effective", "可复核的做法"],
              ["issues", "问题与修正"],
              ["unverified", "仍待验证"],
            ] as const
          ).map(([key, title]) =>
            story.review[key].length ? (
              <section key={key}>
                <h3>{title}</h3>
                {story.review[key].map((item) => (
                  <article key={item.id}>
                    <Markdown dispatch={dispatch} onArtifactLink={openArtifact}>
                      {item.text}
                    </Markdown>
                    <References
                      ownerId={`review:${item.id}`}
                      references={item.references}
                      inspection={inspection}
                      setInspection={setInspection}
                      task={task}
                      dispatch={dispatch}
                      onArtifactOpen={openArtifact}
                    />
                  </article>
                ))}
              </section>
            ) : null,
          )}
          {!reviewCount ? (
            <p className="work-content-empty">
              当前公开记录还不足以归纳哪些做法有效、哪些需要改进。
            </p>
          ) : null}
        </section>
      ) : null}
      <div className="process-story" aria-label="公开分析脉络">
        {analysisGoal && analysisGoal !== task.goalVersion ? (
          <p className="process-analysis-scope">
            最近留下的分析 · 目标第 {analysisGoal}{" "}
            版。当前目标尚无新的公开分析。
          </p>
        ) : null}
        {lead ? (
          <section
            className="process-leading-judgment"
            aria-label="最近判断与修正"
          >
            <p className="process-lead-label">
              {lead.kind === "revision" ? "关键修正" : "当前判断"}
            </p>
            <StoryEntry
              entry={lead}
              task={task}
              dispatch={dispatch}
              onArtifactOpen={openArtifact}
              inspection={inspection}
              setInspection={setInspection}
            />
          </section>
        ) : null}
        <div className="process-current-analysis" aria-label="成员分析与贡献">
          {currentAnalysis
            .filter((entry) => entry.id !== lead?.id)
            .map((entry) => (
              <StoryEntry
                key={entry.id}
                entry={entry}
                task={task}
                dispatch={dispatch}
                onArtifactOpen={openArtifact}
                inspection={inspection}
                setInspection={setInspection}
              />
            ))}
        </div>
        {!analysisEntries.length ? (
          <p className="work-content-empty">
            {task.status === "idle"
              ? "开始工作后，在这里阅读团队对目标的理解、判断依据和修正过程。"
              : "这一范围尚未留下可展示的公开分析或回复。已有操作可在排障记录中核对，不能据此补写当时的判断。"}
          </p>
        ) : null}
        {history.length ? (
          <details className="process-story-history" data-reading-key="history">
            <summary>较早目标的分析 · {history.length}</summary>
            {[...new Set(history.map((entry) => entry.goalVersion))].map(
              (goalVersion) => (
                <section key={goalVersion}>
                  <h2 className="process-goal-marker">
                    目标第 {goalVersion} 版
                  </h2>
                  {history
                    .filter((entry) => entry.goalVersion === goalVersion)
                    .map((entry) => (
                      <StoryEntry
                        key={entry.id}
                        entry={entry}
                        task={task}
                        dispatch={dispatch}
                        onArtifactOpen={openArtifact}
                        inspection={inspection}
                        setInspection={setInspection}
                      />
                    ))}
                </section>
              ),
            )}
          </details>
        ) : null}
        {context.length ? (
          <details
            className="process-context-history"
            data-reading-key="context"
          >
            <summary>原始要求与资料、成果版本 · {context.length}</summary>
            {context.map((entry) => (
              <StoryEntry
                key={entry.id}
                entry={entry}
                task={task}
                dispatch={dispatch}
                onArtifactOpen={openArtifact}
                inspection={inspection}
                setInspection={setInspection}
              />
            ))}
          </details>
        ) : null}
      </div>
      <footer className="process-story-support">
        <p className="process-coverage-note">{story.coverage.notice}</p>
        <div className="work-process-evidence-actions">
          {sources.length || queries.length ? (
            <button
              className="text-button"
              aria-expanded={sourcesOpen}
              onClick={() => setSourcesOpen(!sourcesOpen)}
            >
              <Search size={13} />
              {sourcesOpen ? "收起依据" : "查看依据"} · {sources.length} 项资料
            </button>
          ) : null}
          <button
            className="text-button"
            aria-expanded={recordsOpen}
            onClick={() => setRecordsOpen(!recordsOpen)}
          >
            {recordsOpen ? "收起排障记录" : "排障记录"} · {visibleEvents.length}
          </button>
        </div>
        {sourcesOpen ? (
          <div className="process-sources" aria-label="核查资料与网站">
            <p className="work-content-muted">
              搜索结果和引用链接不代表已访问全文。
            </p>
            {queries.length ? (
              <details
                className="process-search-queries"
                data-reading-key="queries"
              >
                <summary>实际检索词 · {queries.length}</summary>
                <ol>
                  {queries.map((query) => (
                    <li key={query}>{query}</li>
                  ))}
                </ol>
              </details>
            ) : null}
            {sources.map((source) => (
              <details
                className="process-source-card"
                key={source.id}
                data-reading-key={`source:${source.id}`}
              >
                <summary>
                  <span>
                    <strong>{source.title}</strong>
                    <small>
                      {source.url
                        ? new URL(source.url).hostname
                        : "本地任务资料"}
                    </small>
                  </span>
                  <span className={`source-read-state source-${source.status}`}>
                    {SOURCE_STATUS_NAMES[source.status]}
                  </span>
                  <ChevronDown size={12} />
                </summary>
                <div className="process-source-body">
                  <p className="work-content-muted">
                    {source.origin === "google" ? "Google 返回" : "任务资料"}
                    {source.members.length
                      ? ` · ${source.members.map((id) => memberName(id, task.teamMode)).join("、")}`
                      : ""}
                  </p>
                  <p>{source.snippet || "此记录没有返回可展示的正文节选。"}</p>
                  {source.url ? (
                    <button
                      className="text-button"
                      onClick={() =>
                        void dispatch({ type: "url.open", url: source.url })
                      }
                    >
                      打开来源 <ArrowUpRight size={12} />
                    </button>
                  ) : null}
                </div>
              </details>
            ))}
          </div>
        ) : null}
        {visibleEvents.some((event) => event.type === "skill_loaded") ? (
          <details className="work-method-evidence" data-reading-key="methods">
            <summary>实际使用的方法</summary>
            <SkillUsage events={visibleEvents} />
          </details>
        ) : null}
        <details className="work-process-members" data-reading-key="members">
          <summary>成员运行状态 · {lanes.length}</summary>
          <div aria-label="本次成员状态">
            {lanes.map((lane) => (
              <div className="process-member work-member-line" key={lane.id}>
                <strong>
                  {memberName(lane.member, task.teamMode)}
                  {lane.specialist ? "的专项成员" : ""}
                </strong>
                <span>
                  <StateIcon status={lane.status} />
                  {statusNames[lane.status]}
                </span>
                <p>{lane.latestSummary}</p>
              </div>
            ))}
          </div>
        </details>
        {recordsOpen ? (
          <div className="process-execution" aria-label="排障记录">
            <p className="work-content-muted">
              以下是执行状态，公开分析与成员观点在上方阅读。
            </p>
            <ol className="process-timeline">
              {records.toReversed().map((event) => (
                <li key={event.id}>
                  <span className="timeline-point" />
                  <div>
                    <div className="timeline-byline">
                      <strong>
                        {event.member
                          ? memberName(event.member, task.teamMode)
                          : "工作台"}
                      </strong>
                      <time>{formatTime(event.createdAt)}</time>
                      <span>目标 v{event.goalVersion}</span>
                    </div>
                    <p>{event.summary}</p>
                  </div>
                </li>
              ))}
            </ol>
            {!records.length ? (
              <p className="work-content-muted">工作开始后显示实际执行记录。</p>
            ) : null}
            {!allRecords && visibleEvents.length > records.length ? (
              <button
                className="text-button"
                onClick={() => setAllRecords(true)}
              >
                显示全部 {visibleEvents.length} 条记录
              </button>
            ) : null}
          </div>
        ) : null}
      </footer>
    </section>
  );
}
export function ProcessView(props: ProcessProps) {
  return <ProcessStoryView key={props.task.id} {...props} />;
}
