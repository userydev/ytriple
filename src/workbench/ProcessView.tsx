import { useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleAlert,
  FileText,
  Layers2,
  LoaderCircle,
  Pause,
  Search,
  Wrench,
} from "lucide-react";
import { buildAgentProgress, type ProgressStatus } from "../shared/progress";
import type { Task, TaskEvent } from "../shared/types";
import { formatTime, memberName, type Dispatch } from "./common";

const statusNames: Record<ProgressStatus, string> = {
  running: "正在工作",
  completed: "已完成",
  waiting: "等待回复",
  paused: "已暂停",
  failed: "需要处理",
  stale: "待核实",
};
const toolNames: Record<string, string> = {
  read_source: "阅读资料",
  list_sources: "整理资料",
  web_search: "检索资料",
  fetch_url: "读取网页",
  write_artifact: "整理成果",
  read_artifact: "阅读成果",
  revise_artifact: "修订成果",
  report_progress: "汇报进展",
  report_public_progress: "汇报进展",
  delegate_research: "委派研究",
  delegate_cto: "委派技术审视",
  ask_user: "提出问题",
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
}: {
  task: Task;
  dispatch: Dispatch;
  compact?: boolean;
}) {
  const [history, setHistory] = useState(false);
  const lanes = buildAgentProgress(task);
  const currentEvents = task.events.filter(
    (event) => event.goalVersion === task.goalVersion && isPublicEvent(event),
  );
  const publicReports = currentEvents.filter((event) =>
    /^progress[_.]reported$/.test(event.type),
  );
  const events = history
    ? currentEvents
    : publicReports.length
      ? publicReports
      : currentEvents.filter(
          (event) => !/tool_(started|completed)$/.test(event.type),
        );
  return (
    <section
      className={`process-view ${compact ? "compact" : ""}`}
      aria-label="Agent 协作过程"
    >
      <div className="process-heading">
        <div>
          <span className="eyebrow">TEAM AT WORK</span>
          <strong>{task.title}</strong>
        </div>
        <span className={`process-state state-${task.status}`}>
          {task.status === "running" ? (
            <LoaderCircle size={12} className="spin" />
          ) : (
            <Layers2 size={13} />
          )}
          目标 v{task.goalVersion}
        </span>
      </div>
      {lanes.length ? (
        <>
          <div className="agent-lanes">
            {lanes.map((lane) => {
              const parent = lanes.find(
                (item) => item.id === lane.parentInvocationId,
              );
              const activeTools = lane.tools.filter(
                (tool) => tool.status === "running",
              );
              return (
                <article
                  className={`agent-lane member-${lane.member} agent-${lane.status}`}
                  key={lane.id}
                >
                  <div className="agent-lane-heading">
                    <span className="agent-avatar">
                      {lane.specialist ? (
                        <Search size={14} />
                      ) : lane.member === "researcher" ? (
                        <Search size={15} />
                      ) : lane.member === "cto" ? (
                        <Wrench size={15} />
                      ) : (
                        <Layers2 size={15} />
                      )}
                    </span>
                    <div>
                      <strong>
                        {lane.specialist ? "专项研究" : memberName(lane.member)}
                      </strong>
                      <span>
                        <StateIcon status={lane.status} />
                        {statusNames[lane.status]}
                      </span>
                    </div>
                  </div>
                  {parent ? (
                    <div className="delegation-link">
                      <ArrowDownRight size={12} />
                      {memberName(parent.member)} 委派
                    </div>
                  ) : null}
                  <p className="agent-summary">{lane.latestSummary}</p>
                  {activeTools.length ? (
                    <div className="active-tools">
                      {activeTools.map((tool) => (
                        <span key={tool.id}>
                          <LoaderCircle size={11} className="spin" />
                          {tool.receiver
                            ? `交给${memberName(tool.receiver)}`
                            : (toolNames[tool.tool] ?? "执行工具")}
                          <span className="sr-only">{tool.summary}</span>
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {lane.sourceIds.length || lane.artifactIds.length ? (
                    <div className="agent-references">
                      {lane.sourceIds.map((id) => {
                        const source = task.sources.find(
                          (source) => source.id === id,
                        );
                        return source ? (
                          <details key={`source:${id}`}>
                            <summary title={source.title}>
                              <FileText size={11} />
                              {source.title}
                            </summary>
                            <p>{source.text.slice(0, 700)}</p>
                            <span>{source.coverage}</span>
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
                                <ArrowUpRight size={11} />
                              </button>
                            ) : null}
                          </details>
                        ) : null;
                      })}
                      {lane.artifactIds.map((id) => {
                        const artifact = task.artifacts.find(
                          (item) => item.id === id,
                        );
                        return artifact ? (
                          <button
                            className="text-button"
                            key={`artifact:${id}`}
                            onClick={() =>
                              void dispatch({
                                type: "window.focus",
                                window: "artifact",
                              })
                            }
                          >
                            <FileText size={11} />
                            {artifact.title}
                            <ArrowUpRight size={11} />
                          </button>
                        ) : null;
                      })}
                    </div>
                  ) : null}
                  {lane.tools.length ? (
                    <details className="agent-tool-details">
                      <summary>
                        工具与协作 · {lane.tools.length}
                        <ChevronDown size={11} />
                      </summary>
                      {lane.tools.map((tool) => (
                        <div key={tool.id}>
                          <StateIcon status={tool.status} />
                          <span>{tool.summary}</span>
                        </div>
                      ))}
                    </details>
                  ) : null}
                </article>
              );
            })}
          </div>
          <div className="process-timeline-heading">
            <strong>{history ? "完整执行记录" : "工作摘要"}</strong>
            <button
              className="text-button"
              onClick={() => setHistory(!history)}
            >
              {history ? "只看摘要" : "查看工具与记录"}
              <ChevronDown size={12} />
            </button>
          </div>
          <ol className="process-timeline">
            {events
              .slice(history ? -150 : -24)
              .toReversed()
              .map((event) => (
                <li key={event.id}>
                  <span
                    className={`timeline-point ${event.type === "progress_reported" ? "report" : ""}`}
                  />
                  <div>
                    <div className="timeline-byline">
                      <strong>
                        {event.member ? memberName(event.member) : "工作台"}
                      </strong>
                      <span>
                        {event.data?.stage === "plan"
                          ? "计划"
                          : event.data?.stage === "finding"
                            ? "发现"
                            : event.data?.stage === "decision"
                              ? "判断"
                              : ""}
                      </span>
                      <time>{formatTime(event.createdAt)}</time>
                    </div>
                    <p>{event.summary}</p>
                  </div>
                </li>
              ))}
          </ol>
        </>
      ) : (
        <div className="process-empty">
          <Layers2 size={27} strokeWidth={1.2} />
          <h3>
            {task.status === "running"
              ? "等待成员开始工作"
              : "协作过程从实际工作开始"}
          </h3>
          <p>成员的计划、资料依据、工具活动和公开摘要会随工作展开。</p>
        </div>
      )}
    </section>
  );
}
