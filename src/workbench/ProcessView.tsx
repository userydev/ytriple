import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleAlert,
  FileText,
  Layers2,
  LoaderCircle,
  MessageSquare,
  Pause,
  Search,
  Wrench,
} from "lucide-react";
import {
  ANALYSIS_SECTIONS,
  buildAgentProgress,
  buildPublicExchanges,
  buildProcessSources,
  currentProgressEvents,
  publicAnalysisSection,
  publicReportDetails,
  publicSearchQueries,
  SOURCE_STATUS_NAMES,
  type ProgressStatus,
} from "../shared/progress";
import type { MemberId, Task, TaskEvent } from "../shared/types";
import { formatTime, Markdown, memberName, type Dispatch } from "./common";

const statusNames: Record<ProgressStatus, string> = {
  running: "正在工作",
  completed: "已完成",
  waiting: "等待回复",
  paused: "已暂停",
  failed: "需要处理",
  stale: "待核实",
};
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
  return /^(run_|agent_|delegation_|tool_|progress[_.]reported|artifact_written|clarification_requested|goal_|source_)/.test(
    event.type,
  );
}
function AnalysisDetails({
  report,
  dispatch,
  onArtifactOpen,
}: {
  report: TaskEvent;
  dispatch: Dispatch;
  onArtifactOpen: (id: string) => void;
}) {
  const { detail, method, questions } = publicReportDetails(report);
  if (!detail && !method && !questions.length) return null;
  return (
    <details className="analysis-full-detail">
      <summary>
        展开分析与方法
        <ChevronDown size={12} />
      </summary>
      {method ? (
        <div className="analysis-detail-block">
          <strong>核查方法</strong>
          <Markdown dispatch={dispatch} onArtifactLink={onArtifactOpen}>
            {method}
          </Markdown>
        </div>
      ) : null}
      {detail ? (
        <div className="analysis-detail-block">
          <strong>
            {report.data?.hosted === true ? "Google 公开分析摘要" : "展开说明"}
          </strong>
          <Markdown dispatch={dispatch} onArtifactLink={onArtifactOpen}>
            {detail}
          </Markdown>
        </div>
      ) : null}
      {questions.length ? (
        <div className="analysis-detail-block">
          <strong>仍待解决</strong>
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
export function ProcessView({
  task,
  dispatch,
  compact = false,
  onArtifactOpen,
}: {
  task: Task;
  dispatch: Dispatch;
  compact?: boolean;
  onArtifactOpen?: (id: string) => void;
}) {
  const [layer, setLayer] = useState<
    "analysis" | "sources" | "conversation" | "execution"
  >("analysis");
  const [member, setMember] = useState<MemberId | "all">("all");
  const [scope, setScope] = useState<"goal" | "run">("goal");
  const [saving, setSaving] = useState<MemberId | "team" | null>(null);
  const [allRecords, setAllRecords] = useState(false);
  const [allExpanded, setAllExpanded] = useState(false);
  const [sourceFilter, setSourceFilter] = useState<
    "all" | "read" | "unavailable"
  >("all");
  const container = useRef<HTMLElement>(null);
  useEffect(() => {
    const section = container.current;
    const updateExpanded = () => {
      const details = Array.from(section?.querySelectorAll("details") ?? []);
      setAllExpanded(details.length > 0 && details.every((item) => item.open));
    };
    updateExpanded();
    section?.addEventListener("toggle", updateExpanded, true);
    return () => section?.removeEventListener("toggle", updateExpanded, true);
  }, [layer, member, scope, sourceFilter, allRecords, task.id]);
  const expand = (open: boolean) =>
    container.current?.querySelectorAll("details").forEach((details) => {
      details.open = open;
    });
  const saveSummary = async (member?: MemberId) => {
    if (saving) return;
    setSaving(member ?? "team");
    try {
      const result = await dispatch({
        type: "process.save",
        taskId: task.id,
        ...(member ? { member } : {}),
      });
      if (result) await dispatch({ type: "window.focus", window: "artifact" });
    } finally {
      setSaving(null);
    }
  };
  const openArtifact = (id: string) => {
    if (!task.artifacts.some((artifact) => artifact.id === id)) return;
    if (onArtifactOpen) onArtifactOpen(id);
    else void dispatch({ type: "window.focus", window: "artifact" });
  };
  const lanes = buildAgentProgress(task);
  const goalEvents = task.events.filter(
    (event) => event.goalVersion === task.goalVersion && isPublicEvent(event),
  );
  const currentEvents =
    scope === "goal"
      ? goalEvents
      : currentProgressEvents(task).filter(isPublicEvent);
  const visibleEvents = currentEvents.filter(
    (event) => member === "all" || event.member === member,
  );
  const analysis = visibleEvents.filter((event) =>
    publicAnalysisSection(event),
  );
  const exchanges = buildPublicExchanges(currentEvents, task.status).filter(
    (exchange) =>
      member === "all" ||
      exchange.sender === member ||
      exchange.receiver === member,
  );
  const records = allRecords ? visibleEvents : visibleEvents.slice(-80);
  const sources = buildProcessSources(task, visibleEvents);
  const queries = publicSearchQueries(visibleEvents);
  return (
    <section
      className={`process-view layered-process ${compact ? "compact" : ""}`}
      aria-label="Agent 协作过程"
      ref={container}
    >
      <div className="process-heading">
        <strong title={task.title}>团队过程</strong>
        <span className={`process-state state-${task.status}`}>
          <Layers2 size={13} />
          目标 v{task.goalVersion}
        </span>
      </div>
      <div className="process-overview" aria-label="本次成员状态">
        {lanes.map((lane) => (
          <article
            key={lane.id}
            className={`process-member agent-lane member-${lane.member} agent-${lane.status}`}
          >
            <button
              className="process-member-select"
              aria-pressed={member === lane.member}
              onClick={() =>
                setMember(member === lane.member ? "all" : lane.member)
              }
            >
              {lane.member === "researcher" || lane.specialist ? (
                <Search size={15} />
              ) : lane.member === "cto" ? (
                <Wrench size={15} />
              ) : (
                <Layers2 size={15} />
              )}
              <strong>
                {lane.specialist ? "专项研究" : memberName(lane.member)}
              </strong>
              <span>
                <StateIcon status={lane.status} />
                {statusNames[lane.status]}
              </span>
            </button>
            <p className="agent-summary">{lane.latestSummary}</p>
            {lane.parentInvocationId ? (
              <small className="process-origin">
                由
                {memberName(
                  lanes.find((parent) => parent.id === lane.parentInvocationId)
                    ?.member ?? "coordinator",
                )}
                委派
              </small>
            ) : null}
          </article>
        ))}
      </div>
      <div className="process-content-toolbar">
        <div className="process-layer-tabs" role="group" aria-label="过程层级">
          <button
            aria-pressed={layer === "analysis"}
            onClick={() => setLayer("analysis")}
          >
            思路摘要 <span>{analysis.length}</span>
          </button>
          <button
            aria-pressed={layer === "sources"}
            onClick={() => setLayer("sources")}
          >
            资料与网站 <span>{sources.length}</span>
          </button>
          <button
            aria-pressed={layer === "conversation"}
            onClick={() => setLayer("conversation")}
          >
            成员对话 <span>{exchanges.length}</span>
          </button>
          <button
            aria-pressed={layer === "execution"}
            onClick={() => setLayer("execution")}
          >
            执行记录
          </button>
        </div>
        <div
          className="process-document-actions process-save-bar"
          role="group"
          aria-label="过程整理"
        >
          <label>
            <span className="sr-only">过程范围</span>
            <select
              value={scope}
              onChange={(event) => {
                setScope(event.target.value as "goal" | "run");
                setAllRecords(false);
              }}
            >
              <option value="goal">当前目标全部过程</option>
              <option value="run">本次处理</option>
            </select>
          </label>
          <label>
            <span className="sr-only">筛选成员</span>
            <select
              value={member}
              onChange={(event) =>
                setMember(event.target.value as MemberId | "all")
              }
            >
              <option value="all">全部成员</option>
              {(["coordinator", "cto", "researcher"] as const).map((id) => (
                <option key={id} value={id}>
                  {memberName(id)}
                </option>
              ))}
            </select>
          </label>
          <button
            className="text-button"
            aria-label={
              member === "all"
                ? "整理团队过程为文档"
                : `整理${memberName(member)}过程为文档`
            }
            title="保存当前目标的全部过程"
            disabled={saving !== null || !goalEvents.length}
            onClick={() =>
              void saveSummary(member === "all" ? undefined : member)
            }
          >
            {saving ? (
              <LoaderCircle size={13} className="spin" />
            ) : (
              <FileText size={13} />
            )}
            {saving ? "整理中…" : "保存过程文档"}
          </button>
        </div>
        <div
          className="process-reading-controls"
          role="group"
          aria-label="过程阅读方式"
        >
          <span>摘要浏览，按需展开</span>
          <button
            className="text-button"
            onClick={() => {
              expand(!allExpanded);
              setAllExpanded(!allExpanded);
            }}
          >
            {allExpanded ? "全部收起" : "全部展开"}
          </button>
        </div>
      </div>
      {layer === "analysis" ? (
        <div className="process-analysis" aria-label="公开分析摘要">
          <p className="process-layer-note">
            从问题、方法到依据和判断。简述留在这里，完整解释可展开查看。
          </p>
          {sources.length || queries.length ? (
            <button
              className="process-source-overview"
              onClick={() => setLayer("sources")}
            >
              <Search size={14} />
              <span>
                <strong>{sources.length} 项资料与网站</strong>
                <small>
                  {sources.filter((source) => source.status === "read").length}{" "}
                  项有读取记录
                  {queries.length ? ` · ${queries.length} 个实际检索词` : ""}
                </small>
              </span>
              <ArrowUpRight size={13} />
            </button>
          ) : null}
          {!analysis.length ? (
            <div className="process-empty-summary">
              <strong>还没有公开分析摘要</strong>
              <p>
                {currentEvents.some((event) => event.data?.hosted === true)
                  ? "这段记录尚未收到服务商的公开分析摘要。已返回的检索与来源可在「资料与网站」查看。"
                  : "成员后续会在有实质发现或判断时补充说明；已有执行记录不会被改写为分析。"}
              </p>
            </div>
          ) : null}
          {ANALYSIS_SECTIONS.map((section) => {
            const reports = analysis.filter(
              (event) => publicAnalysisSection(event) === section.id,
            );
            if (!reports.length) return null;
            return (
              <details
                className="analysis-section"
                key={section.id}
                open={reports.length > 0}
              >
                <summary>
                  <span>
                    <strong>{section.title}</strong>
                    <small>{section.description}</small>
                  </span>
                  <span className="analysis-count">
                    {reports.length}
                    <ChevronDown size={13} />
                  </span>
                </summary>
                {reports.length ? (
                  reports.map((report) => (
                    <article className="analysis-report" key={report.id}>
                      <div className="timeline-byline">
                        <strong>
                          {report.member ? memberName(report.member) : "工作台"}
                        </strong>
                        <time>{formatTime(report.createdAt)}</time>
                        {report.data?.hosted === true ? (
                          <span>Google 公开摘要</span>
                        ) : null}
                      </div>
                      <Markdown
                        dispatch={dispatch}
                        onArtifactLink={openArtifact}
                      >
                        {report.summary}
                      </Markdown>
                      <AnalysisDetails
                        report={report}
                        dispatch={dispatch}
                        onArtifactOpen={openArtifact}
                      />
                      <div className="analysis-references">
                        {Array.isArray(report.data?.sourceIds)
                          ? report.data.sourceIds.flatMap((id) => {
                              const source = task.sources.find(
                                (source) => source.id === id,
                              );
                              return source
                                ? [
                                    <details key={source.id}>
                                      <summary>
                                        <FileText size={11} />
                                        {source.title}
                                      </summary>
                                      <p>{source.text.slice(0, 900)}</p>
                                      <small>{source.coverage}</small>
                                      {source.type === "url" ? (
                                        <button
                                          className="text-button"
                                          onClick={() =>
                                            void dispatch({
                                              type: "url.open",
                                              url: source.location,
                                            })
                                          }
                                        >
                                          查看来源
                                          <ArrowUpRight size={12} />
                                        </button>
                                      ) : null}
                                    </details>,
                                  ]
                                : [];
                            })
                          : null}
                        {Array.isArray(report.data?.artifactIds)
                          ? report.data.artifactIds.flatMap((id) => {
                              const artifact = task.artifacts.find(
                                (artifact) => artifact.id === id,
                              );
                              return artifact
                                ? [
                                    <button
                                      className="text-button"
                                      key={artifact.id}
                                      onClick={() => openArtifact(artifact.id)}
                                    >
                                      <FileText size={11} />
                                      {artifact.title}
                                      <ArrowUpRight size={12} />
                                    </button>,
                                  ]
                                : [];
                            })
                          : null}
                      </div>
                    </article>
                  ))
                ) : (
                  <p className="analysis-empty">尚无这一类说明</p>
                )}
              </details>
            );
          })}
        </div>
      ) : layer === "sources" ? (
        <div className="process-sources" aria-label="核查资料与网站">
          <p className="process-layer-note">
            读取、搜索与引用分别标识；搜索结果和引用链接不代表已访问全文。
          </p>
          {queries.length ? (
            <details className="process-search-queries">
              <summary>
                <Search size={13} />
                实际检索词 · {queries.length}
                <ChevronDown size={12} />
              </summary>
              <ol>
                {queries.map((query) => (
                  <li key={query}>{query}</li>
                ))}
              </ol>
            </details>
          ) : null}
          <div
            className="process-source-filters"
            role="group"
            aria-label="资料状态筛选"
          >
            {(
              [
                ["all", "全部"],
                ["read", "已读取"],
                ["unavailable", "未能读取"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                aria-pressed={sourceFilter === value}
                onClick={() => setSourceFilter(value)}
              >
                {label}{" "}
                {
                  sources.filter(
                    (source) => value === "all" || source.status === value,
                  ).length
                }
              </button>
            ))}
          </div>
          {sources
            .filter(
              (source) =>
                sourceFilter === "all" || source.status === sourceFilter,
            )
            .map((source) => (
              <details className="process-source-card" key={source.id}>
                <summary>
                  <FileText size={14} />
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
                  <p className="process-source-origin">
                    {source.origin === "google" ? "Google 返回" : "任务资料"}
                    {source.members.length
                      ? ` · ${source.members.map(memberName).join("、")}`
                      : ""}
                  </p>
                  {source.snippet ? (
                    <p className="process-source-snippet">{source.snippet}</p>
                  ) : (
                    <p className="analysis-empty">
                      此记录没有返回可展示的正文节选。
                    </p>
                  )}
                  {source.url ? (
                    <button
                      className="text-button"
                      onClick={() =>
                        void dispatch({ type: "url.open", url: source.url })
                      }
                    >
                      打开来源
                      <ArrowUpRight size={12} />
                    </button>
                  ) : null}
                </div>
              </details>
            ))}
          {!sources.length ? (
            <div className="process-empty-summary">
              <strong>尚无可核查的来源记录</strong>
              <p>
                成员实际阅读任务资料、返回搜索结果或核查网站后，依据会整理到这里。
              </p>
            </div>
          ) : !sources.some(
              (source) =>
                sourceFilter === "all" || source.status === sourceFilter,
            ) ? (
            <p className="analysis-empty">当前没有这一状态的资料。</p>
          ) : null}
        </div>
      ) : layer === "conversation" ? (
        <div className="process-conversations" aria-label="实际成员对话">
          <p className="process-layer-note">
            实际委派与回复；较长消息可能为运行时保留的节选。
          </p>
          {exchanges.length ? (
            exchanges.map((exchange) => (
              <details
                className="process-exchange"
                key={exchange.id}
                open={exchange.status === "running" || exchanges.length < 3}
              >
                <summary>
                  <MessageSquare size={14} />
                  <strong>{memberName(exchange.sender)}</strong>
                  <ArrowRight size={12} />
                  <strong>
                    {exchange.specialist
                      ? "专项研究"
                      : memberName(exchange.receiver)}
                  </strong>
                  <span className="exchange-status">
                    <StateIcon status={exchange.status} />
                    {statusNames[exchange.status]}
                  </span>
                </summary>
                <div className="exchange-message">
                  <span>委派内容 · {formatTime(exchange.createdAt)}</span>
                  {exchange.request ? (
                    <Markdown dispatch={dispatch} onArtifactLink={openArtifact}>
                      {exchange.request}
                    </Markdown>
                  ) : (
                    <p>此记录没有保留委派正文。</p>
                  )}
                </div>
                <div className="exchange-message exchange-response">
                  <span>
                    {exchange.specialist
                      ? "专项研究"
                      : memberName(exchange.receiver)}
                    回复
                  </span>
                  {exchange.response ? (
                    <Markdown dispatch={dispatch} onArtifactLink={openArtifact}>
                      {exchange.response}
                    </Markdown>
                  ) : (
                    <p>
                      {exchange.status === "running"
                        ? "等待成员回复。"
                        : "此记录没有保留完整回复。"}
                    </p>
                  )}
                </div>
              </details>
            ))
          ) : (
            <div className="process-empty-summary">
              <strong>尚无成员间对话</strong>
              <p>需要协作时，成员的委派、追问和真实回复会出现在这里。</p>
            </div>
          )}
        </div>
      ) : (
        <div className="process-execution" aria-label="执行记录">
          <p className="process-layer-note">
            工具、运行状态和文件操作，按实际发生的时间记录。
          </p>
          <ol className="process-timeline">
            {records.toReversed().map((event) => (
              <li key={event.id}>
                <span className="timeline-point" />
                <div>
                  <div className="timeline-byline">
                    <strong>
                      {event.member ? memberName(event.member) : "工作台"}
                    </strong>
                    <time>{formatTime(event.createdAt)}</time>
                  </div>
                  <p>{event.summary}</p>
                </div>
              </li>
            ))}
          </ol>
          {!records.length ? (
            <p className="analysis-empty">工作开始后显示实际记录。</p>
          ) : null}
          {!allRecords && visibleEvents.length > records.length ? (
            <button className="text-button" onClick={() => setAllRecords(true)}>
              显示本轮全部 {visibleEvents.length} 条记录
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}
