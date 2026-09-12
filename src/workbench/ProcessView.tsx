import { useState } from "react";
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
  currentProgressEvents,
  publicAnalysisSection,
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
  const [layer, setLayer] = useState<"analysis" | "conversation" | "execution">(
    "analysis",
  );
  const [member, setMember] = useState<MemberId | "all">("all");
  const [scope, setScope] = useState<"goal" | "run">("goal");
  const [saving, setSaving] = useState<MemberId | "team" | null>(null);
  const [allRecords, setAllRecords] = useState(false);
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
  return (
    <section
      className={`process-view layered-process ${compact ? "compact" : ""}`}
      aria-label="Agent 协作过程"
    >
      <div className="process-heading">
        <div>
          <span className="eyebrow">TEAM AT WORK</span>
          <strong>{task.title}</strong>
        </div>
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
      </div>
      {layer === "analysis" ? (
        <div className="process-analysis" aria-label="公开分析摘要">
          <p className="process-layer-note">
            成员对问题、依据和取舍的公开说明。点击分类展开查看。
          </p>
          {!analysis.length ? (
            <div className="process-empty-summary">
              <strong>还没有公开分析摘要</strong>
              <p>
                {currentEvents.some((event) => event.data?.hosted === true)
                  ? "当前托管成员只回传运行状态与最终报告；这些状态保留在执行记录中。"
                  : "成员后续会在有实质发现或判断时补充说明；已有执行记录不会被改写为分析。"}
              </p>
            </div>
          ) : null}
          {ANALYSIS_SECTIONS.map((section) => {
            const reports = analysis.filter(
              (event) => publicAnalysisSection(event) === section.id,
            );
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
                      </div>
                      <Markdown
                        dispatch={dispatch}
                        onArtifactLink={openArtifact}
                      >
                        {report.summary}
                      </Markdown>
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
