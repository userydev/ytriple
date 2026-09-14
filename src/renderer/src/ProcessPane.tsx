import { useState } from "react";
import {
  ArrowUpRight,
  CheckCheck,
  ChevronDown,
  CornerDownRight,
  FileText,
  GitBranch,
  MessageSquare,
  Search,
  Sparkles,
} from "lucide-react";
import type {
  PublicEvent,
  Reference,
  RunSnapshot,
  WorkDetail,
} from "../../shared/contracts";
import { dateText, Empty, intents, Markdown, statuses } from "./common";
import { ScrollArea } from "./ScrollArea";
import "./ProcessPane.css";

type Props = {
  detail: WorkDetail;
  memberFilter?: string;
  setMemberFilter(value: string): void;
  onReference(
    reference: Reference,
    memberId: string | undefined,
    intent: "explain" | "revise",
  ): void;
  onSummary(intent: "summarize" | "reflect", runId?: string): void;
  scroll: number;
  onScroll(top: number): void;
  disabled: boolean;
};
type TaskSummary = {
  id: string;
  title: string;
  memberIds: string[];
  requirements: string[];
  run: RunSnapshot;
  eventTypes: string[];
  status: string;
};

const publicKinds: Record<string, string> = {
  plan: "规划",
  delegation: "委派",
  analysis: "分析",
  review: "核查",
  revision: "修正",
};
const detailKinds = new Set(["tool", "status", "usage"]);

function taskStatus(run: RunSnapshot, events: PublicEvent[]) {
  if (events.some((event) => event.type === "error")) return "失败";
  if (run.status === "running" || run.status === "stopping")
    return statuses[run.status];
  if (events.some((event) => event.type === "revision")) return "已修正";
  if (events.some((event) => event.type === "review")) return "已核查";
  if (events.some((event) => event.type === "analysis")) return "已分析";
  if (events.some((event) => event.type === "delegation")) return "已委派";
  return run.status === "failed" ||
    run.status === "interrupted" ||
    run.status === "stopped"
    ? statuses[run.status]
    : "等待成员记录";
}

function deriveTasks(run: RunSnapshot, events: PublicEvent[]): TaskSummary[] {
  const byId = new Map<string, TaskSummary>();
  const ensure = (event: PublicEvent, id: string) => {
    const existing = byId.get(id);
    if (existing) return existing;
    const task: TaskSummary = {
      id,
      title: event.title || "团队任务",
      memberIds: [],
      requirements: [],
      run,
      eventTypes: [],
      status: "等待记录",
    };
    byId.set(id, task);
    return task;
  };
  const delegationIds = new Set(
    events
      .filter((event) => event.type === "delegation")
      .map((event) => event.taskId ?? event.id),
  );
  for (const event of events) {
    const id =
      event.taskId ?? (event.type === "delegation" ? event.id : undefined);
    if (!id || !delegationIds.has(id)) continue;
    const task = ensure(event, id);
    if (event.type === "delegation" && event.title) task.title = event.title;
    if (event.memberId && !task.memberIds.includes(event.memberId))
      task.memberIds.push(event.memberId);
    if (event.requirement && !task.requirements.includes(event.requirement))
      task.requirements.push(event.requirement);
    if (!task.eventTypes.includes(event.type)) task.eventTypes.push(event.type);
  }
  const all = events.filter((event) => event.type !== "usage");
  for (const task of byId.values())
    task.status = taskStatus(
      run,
      all.filter(
        (event) =>
          event.taskId === task.id ||
          (event.type === "delegation" &&
            (event.taskId ?? event.id) === task.id),
      ),
    );
  return [...byId.values()];
}

function memberName(run: RunSnapshot, id: string | undefined) {
  return (
    run.settings.team.members.find((member) => member.id === id)?.name ??
    (id ? "历史成员" : "团队")
  );
}

export function ProcessPane({
  detail,
  memberFilter,
  setMemberFilter,
  onReference,
  onSummary,
  scroll,
  onScroll,
  disabled,
}: Props) {
  const [scope, setScope] = useState("all");
  const [quote, setQuote] = useState<{ id: string; text: string }>();
  const members = new Map(
    detail.runs
      .flatMap((run) => run.settings.team.members)
      .map((member) => [member.id, member]),
  );
  const eventMap = new Map(detail.events.map((event) => [event.id, event]));
  const materialMap = new Map(
    detail.materials.map((material) => [material.id, material]),
  );
  const taskLabels = new Map<string, string>();
  for (const event of detail.events)
    if (event.taskId && !taskLabels.has(`${event.runId}:${event.taskId}`))
      taskLabels.set(`${event.runId}:${event.taskId}`, event.title);
  const visibleRuns =
    scope === "all"
      ? detail.runs
      : detail.runs.filter((run) => run.id === scope);
  const overviewRuns = scope === "all" ? visibleRuns.slice(-1) : visibleRuns;
  const publicEvents = detail.events.filter(
    (event) => !detailKinds.has(event.type),
  );
  const lastEvent = detail.events.at(-1);

  function sourceLabel(id: string) {
    return (
      materialMap.get(id)?.title ??
      eventMap.get(id)?.title ??
      detail.artifacts.find((artifact) => artifact.id === id)?.title ??
      id
    );
  }
  function eventsFor(runId: string) {
    return detail.events.filter(
      (event) =>
        event.runId === runId &&
        (!memberFilter || event.memberId === memberFilter),
    );
  }

  function eventCard(event: PublicEvent) {
    const run = detail.runs.find((item) => item.id === event.runId);
    const member = run?.settings.team.members.find(
      (item) => item.id === event.memberId,
    );
    const procedural = detailKinds.has(event.type);
    const body = (
      <>
        <div
          className="process-event-body"
          onMouseUp={(e) => {
            const selection = window.getSelection();
            const text = selection?.toString().trim();
            if (
              text &&
              selection?.anchorNode &&
              e.currentTarget.contains(selection.anchorNode) &&
              selection.focusNode &&
              e.currentTarget.contains(selection.focusNode)
            )
              setQuote(
                event.body.includes(text) ? { id: event.id, text } : undefined,
              );
          }}
        >
          <Markdown>{event.body}</Markdown>
        </div>
        {event.requirement ? (
          <div className="requirement">
            <CheckCheck size={14} />
            <div>
              <strong>这一步的要求</strong>
              <p>{event.requirement}</p>
            </div>
          </div>
        ) : null}
        {event.taskId ? (
          <div className="event-relation">
            <GitBranch size={13} />
            <span
              title={`任务标识：${event.taskId}${event.parentTaskId ? `；父任务：${event.parentTaskId}` : ""}`}
            >
              任务：
              {taskLabels.get(`${event.runId}:${event.taskId}`) ?? event.title}
              {event.parentTaskId
                ? ` · 来自：${taskLabels.get(`${event.runId}:${event.parentTaskId}`) ?? "团队分工"}`
                : ""}
            </span>
          </div>
        ) : null}
        {event.sourceIds?.length || event.relatedEventIds?.length ? (
          <details className="sources">
            <summary>
              依据与关联记录{" "}
              <span>
                {(event.sourceIds?.length ?? 0) +
                  (event.relatedEventIds?.length ?? 0)}
              </span>
            </summary>
            {[...(event.sourceIds ?? []), ...(event.relatedEventIds ?? [])].map(
              (id, index) => (
                <div key={`${id}-${index}`}>
                  <span>{sourceLabel(id)}</span>
                  {eventMap.has(id) ? (
                    <>
                      <details className="source-record">
                        <summary>阅读原始记录</summary>
                        <Markdown>{eventMap.get(id)!.body}</Markdown>
                      </details>
                      <button
                        className="text-button"
                        onClick={() =>
                          onReference(
                            { kind: "event", id },
                            eventMap.get(id)?.memberId,
                            "explain",
                          )
                        }
                      >
                        追问
                        <ArrowUpRight size={12} />
                      </button>
                    </>
                  ) : null}
                  {materialMap.has(id) ? (
                    <details>
                      <summary>阅读材料正文</summary>
                      <Markdown>{materialMap.get(id)!.content}</Markdown>
                    </details>
                  ) : null}
                </div>
              ),
            )}
          </details>
        ) : null}
        <div className="event-actions">
          <button
            className="text-button"
            onClick={() =>
              onReference(
                {
                  kind: "event",
                  id: event.id,
                  ...(quote?.id === event.id ? { quote: quote.text } : {}),
                },
                event.memberId,
                "explain",
              )
            }
          >
            <MessageSquare size={13} />
            {quote?.id === event.id ? "追问选段" : "追问此处"}
          </button>
          <button
            className="text-button"
            onClick={() =>
              onReference(
                {
                  kind: "event",
                  id: event.id,
                  ...(quote?.id === event.id ? { quote: quote.text } : {}),
                },
                event.memberId,
                "revise",
              )
            }
          >
            提出修正
            <CornerDownRight size={13} />
          </button>
        </div>
      </>
    );
    return (
      <article
        className={`event-card event-${event.type} ${event.type === "error" ? "event-error-visible" : ""}`}
        key={event.id}
      >
        <div className="event-heading">
          <span className={`event-dot ${event.streaming ? "pulsing" : ""}`} />
          <span className="event-author">
            {member?.name ?? (event.memberId || "团队")}
          </span>
          {member?.role ? <small>{member.role}</small> : null}
          <span className="event-kind">
            {publicKinds[event.type] ??
              (event.type === "error" ? "错误" : "执行详情")}
          </span>
          <time>
            {new Date(event.createdAt).toLocaleTimeString("zh-CN", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </time>
        </div>
        {procedural ? (
          <details>
            <summary className="event-title">{event.title}</summary>
            {body}
          </details>
        ) : (
          <>
            <h4>
              {event.title}
              {event.streaming ? (
                <span className="live-label">正在汇报</span>
              ) : null}
            </h4>
            {body}
          </>
        )}
      </article>
    );
  }

  const overviewTasks = overviewRuns.flatMap((run) =>
    deriveTasks(
      run,
      detail.events.filter((event) => event.runId === run.id),
    ),
  );
  return (
    <div className="process-pane-content">
      <section className="process-overview" aria-label="本项工作的真实委派">
        <div className="process-overview-heading">
          <div>
            <span className="process-kicker">
              {scope === "all" ? "最近一轮轨迹" : "本轮轨迹"}
            </span>
            <h3>目标与分工</h3>
          </div>
          <span className="process-count">
            {publicEvents.length} 条公开记录
          </span>
        </div>
        <p className="process-goal">{detail.work.goal}</p>
        {overviewTasks.length ? (
          <details className="task-list-disclosure" open>
            <summary>查看本轮委派任务（{overviewTasks.length}）</summary>
            <div className="task-list">
              {overviewTasks.map((task) => (
                <article
                  className="task-summary"
                  key={`${task.run.id}:${task.id}`}
                >
                  <div className="task-summary-main">
                    <strong>{task.title}</strong>
                    <span className="task-status">{task.status}</span>
                  </div>
                  <div className="task-members">
                    承担：
                    {task.memberIds.length
                      ? task.memberIds
                          .map((id) => memberName(task.run, id))
                          .join("、")
                      : "团队协调"}
                  </div>
                  {task.requirements.length ? (
                    <p>要求：{task.requirements.join("；")}</p>
                  ) : (
                    <p className="muted">该任务尚未记录额外要求。</p>
                  )}
                  <small>
                    {task.eventTypes
                      .map((type) => publicKinds[type] ?? type)
                      .join(" · ")}
                  </small>
                </article>
              ))}
            </div>
          </details>
        ) : (
          <p className="process-no-tasks">
            本轮尚未产生委派记录；下面只显示已经发生的公开过程。
          </p>
        )}
      </section>
      <div className="process-toolbar">
        <label>
          <span className="sr-only">过程范围</span>
          <select
            aria-label="过程范围"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          >
            <option value="all">整个工作</option>
            {detail.runs.map((run, index) => (
              <option value={run.id} key={run.id}>
                第 {index + 1} 轮 · {intents[run.intent]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">筛选成员</span>
          <select
            aria-label="筛选成员"
            value={memberFilter ?? ""}
            onChange={(e) => setMemberFilter(e.target.value)}
          >
            <option value="">全部成员</option>
            {[...members.values()].map((member) => (
              <option value={member.id} key={member.id}>
                {member.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ScrollArea
        identity={`process:${scope}:${memberFilter ?? ""}`}
        initial={scroll}
        changeToken={`${detail.events.length}:${lastEvent?.body.length ?? 0}`}
        follow
        onPosition={onScroll}
      >
        {!detail.events.length ? (
          <Empty icon={<GitBranch size={28} />} title="过程会随团队工作出现">
            开始协作后，这里会呈现成员实际的分析、分工、依据与修正。
          </Empty>
        ) : (
          visibleRuns.map((run) => (
            <section className="run-group" key={run.id}>
              <div className="run-label">
                <span>第 {detail.runs.indexOf(run) + 1} 轮</span>
                <strong>{intents[run.intent]}</strong>
                <small>{statuses[run.status]}</small>
              </div>
              <div className="run-meta">
                {dateText(run.createdAt)} · {run.strategyVersion} ·{" "}
                {run.settings.team.members
                  .map(
                    (member) =>
                      `${member.name}${member.role ? `（${member.role}）` : ""}`,
                  )
                  .join("、")}
              </div>
              {run.contextNote ? (
                <p className="context-note">{run.contextNote}</p>
              ) : null}
              <div className="method-pills">
                {run.settings.skills
                  .filter((skill) => skill.enabled)
                  .map((skill) => (
                    <span key={skill.id} title={skill.instructions}>
                      <Sparkles size={11} />
                      {skill.name} v{skill.version}
                    </span>
                  ))}
              </div>
              {eventsFor(run.id).filter(
                (event) =>
                  !detailKinds.has(event.type) || event.type === "error",
              ).length ? (
                eventsFor(run.id)
                  .filter(
                    (event) =>
                      !detailKinds.has(event.type) || event.type === "error",
                  )
                  .map(eventCard)
              ) : (
                <p className="muted small">
                  {memberFilter
                    ? "本轮没有该成员的公开记录。"
                    : "等待团队提交公开记录。"}
                </p>
              )}
              {run.error ? (
                <p className="inline-error" role="alert">
                  {run.error}
                </p>
              ) : null}
              <details className="execution-details">
                <summary>
                  <ChevronDown size={14} />
                  执行详情 · 状态、工具与用量
                </summary>
                <div className="execution-details-body">
                  {eventsFor(run.id)
                    .filter(
                      (event) =>
                        detailKinds.has(event.type) &&
                        event.type !== "error" &&
                        event.type !== "usage",
                    )
                    .map(eventCard)}
                  <p className="run-usage">
                    本轮调用 {run.usage.calls} 次 ·{" "}
                    {run.usage.known
                      ? `输入 ${run.usage.inputTokens.toLocaleString()} / 输出 ${run.usage.outputTokens.toLocaleString()} tokens`
                      : "提供方尚未返回完整 Token 用量"}
                  </p>
                </div>
              </details>
            </section>
          ))
        )}
      </ScrollArea>
      <div className="process-footer">
        <div className="process-buttons">
          <button
            className="secondary-button"
            disabled={disabled || !detail.events.length}
            onClick={() =>
              onSummary("summarize", scope === "all" ? undefined : scope)
            }
          >
            <FileText size={14} />
            总结过程
          </button>
          <button
            className="secondary-button"
            disabled={disabled || !detail.events.length}
            onClick={() =>
              onSummary("reflect", scope === "all" ? undefined : scope)
            }
          >
            <Search size={14} />
            复盘工作
          </button>
        </div>
        <p>
          范围：
          {scope === "all"
            ? "整个工作的已记录过程"
            : `第 ${detail.runs.findIndex((run) => run.id === scope) + 1} 轮`}
          。没有实际使用反馈时，仅评价过程与成果。
        </p>
      </div>
    </div>
  );
}
