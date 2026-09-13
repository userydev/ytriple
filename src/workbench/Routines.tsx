import { useState, type FormEvent } from "react";
import type { LibraryEntry, Task } from "../shared/types";
import {
  ROUTINE_TEMPLATES,
  type Routine,
  type RoutineCommand,
  type RoutineSchedule,
  type RoutineSnapshot,
} from "../shared/routines";

type RoutineView = {
  routines?: RoutineSnapshot;
  tasks: Task[];
  library?: LibraryEntry[];
};
type RoutineDispatch = (command: RoutineCommand) => Promise<unknown>;
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const labels = {
  active: "检查中",
  running: "执行中",
  paused: "已暂停",
  waiting: "等待条件",
  failed: "需要处理",
  stopped: "已停止",
};
function when(value: string | undefined, timezone: string) {
  return value
    ? new Date(value).toLocaleString("zh-CN", {
        timeZone: timezone,
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "等待实际节点";
}
function localDateTime() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}

function RoutineForm({
  task,
  existing,
  snapshot,
  dispatch,
  onDone,
}: {
  task: Task;
  existing?: Routine;
  snapshot: RoutineView;
  dispatch: RoutineDispatch;
  onDone: () => void;
}) {
  const [title, setTitle] = useState(existing?.title ?? task.title);
  const [template, setTemplate] = useState(existing?.templateId ?? "");
  const initial = existing?.schedule;
  const [kind, setKind] = useState<RoutineSchedule["kind"]>(
    initial?.kind ?? "change",
  );
  const [timezone, setTimezone] = useState(initial?.timezone ?? zone());
  const [cadence, setCadence] = useState<"daily" | "weekly" | "interval">(
    initial?.kind === "time" ? initial.cadence : "daily",
  );
  const [time, setTime] = useState(
    initial?.kind === "time" ? (initial.time ?? "09:00") : "09:00",
  );
  const [weekday, setWeekday] = useState(
    initial?.kind === "time" ? (initial.weekday ?? 1) : 1,
  );
  const [minutes, setMinutes] = useState(
    initial?.kind === "time"
      ? (initial.everyMinutes ?? 60)
      : initial?.kind === "change"
        ? initial.pollMinutes
        : (initial?.delayMinutes ?? 30),
  );
  const [maxRuns, setMaxRuns] = useState(existing?.limits.maxRuns ?? 30);
  const [maxTokens, setMaxTokens] = useState(
    existing?.limits.maxTokens ?? 200000,
  );
  const [taskSources, setTaskSources] = useState(
    existing?.scope.taskSources ?? true,
  );
  const [libraryIds, setLibraryIds] = useState(
    existing?.scope.libraryIds ?? [],
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const schedule: RoutineSchedule =
      kind === "change"
        ? { kind, timezone, pollMinutes: minutes }
        : kind === "after_node"
          ? { kind, timezone, node: "published", delayMinutes: minutes }
          : cadence === "interval"
            ? { kind, timezone, cadence, everyMinutes: minutes }
            : {
                kind,
                timezone,
                cadence,
                time,
                ...(cadence === "weekly" ? { weekday } : {}),
              };
    try {
      await dispatch(
        existing
          ? {
              type: "routine.edit",
              requestId: crypto.randomUUID(),
              routineId: existing.id,
              expectedVersion: existing.version,
              title,
              schedule,
              limits: { maxRuns, maxTokens },
              libraryIds,
              watchTaskSources: taskSources,
            }
          : {
              type: "routine.create",
              requestId: crypto.randomUUID(),
              taskId: task.id,
              title,
              ...(template
                ? { templateId: template as NonNullable<Routine["templateId"]> }
                : {}),
              schedule,
              limits: { maxRuns, maxTokens },
              libraryIds,
              watchTaskSources: taskSources,
            },
      );
      onDone();
    } catch (value) {
      setError(value instanceof Error ? value.message : "设置未保存，请重试。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="routine-form" onSubmit={submit}>
      <label>
        名称
        <input
          aria-label="例行工作名称"
          value={title}
          maxLength={160}
          required
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      {!existing && (
        <label>
          开始方式
          <select
            aria-label="例行工作模板"
            value={template}
            onChange={(event) => {
              setTemplate(event.target.value);
              if (event.target.value === "post-review") {
                setKind("after_node");
                setMinutes(1440);
              }
            }}
          >
            <option value="">沿用这次有效工作</option>
            {ROUTINE_TEMPLATES.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        什么时候检查
        <select
          aria-label="例行触发方式"
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as RoutineSchedule["kind"]);
            setMinutes(event.target.value === "after_node" ? 1440 : 30);
          }}
        >
          <option value="change">原资料或选定收藏变化时</option>
          <option value="time">按时间</option>
          <option value="after_node">实际发布后</option>
        </select>
      </label>
      {kind === "time" && (
        <label>
          频率
          <select
            aria-label="执行频率"
            value={cadence}
            onChange={(event) =>
              setCadence(event.target.value as typeof cadence)
            }
          >
            <option value="daily">每天</option>
            <option value="weekly">每周</option>
            <option value="interval">固定间隔</option>
          </select>
        </label>
      )}
      {kind === "time" && cadence !== "interval" && (
        <label>
          当地时间
          <input
            aria-label="执行时间"
            type="time"
            value={time}
            required
            onChange={(event) => setTime(event.target.value)}
          />
        </label>
      )}
      {kind === "time" && cadence === "weekly" && (
        <label>
          星期
          <select
            aria-label="执行星期"
            value={weekday}
            onChange={(event) => setWeekday(Number(event.target.value))}
          >
            {["周日", "周一", "周二", "周三", "周四", "周五", "周六"].map(
              (name, index) => (
                <option key={name} value={index}>
                  {name}
                </option>
              ),
            )}
          </select>
        </label>
      )}
      {(kind !== "time" || cadence === "interval") && (
        <label>
          {kind === "change"
            ? "每隔多少分钟检查"
            : kind === "after_node"
              ? "发布后等待多少分钟"
              : "间隔分钟"}
          <input
            aria-label="间隔分钟"
            type="number"
            min={kind === "after_node" ? 0 : kind === "change" ? 1 : 5}
            max={kind === "change" ? 1440 : 525600}
            value={minutes}
            required
            onChange={(event) => setMinutes(Number(event.target.value))}
          />
        </label>
      )}
      <label>
        时区
        <input
          aria-label="执行时区"
          value={timezone}
          required
          onChange={(event) => setTimezone(event.target.value)}
        />
      </label>
      {kind === "after_node" && (
        <p className="routine-note">
          创建后记录真实发布时间和发布证据。计划日期不会启动复盘。
        </p>
      )}
      <details>
        <summary>资料范围与用量上限</summary>
        <label className="routine-check">
          <input
            type="checkbox"
            checked={taskSources}
            onChange={(event) => setTaskSources(event.target.checked)}
          />
          包含原工作以后新增的资料
        </label>
        <p className="routine-note">
          {taskSources
            ? "检查原工作内资料正文的实际变化。"
            : "只检查现在已有资料的版本变化。"}{" "}
          新成果不会触发自己；不自动扩展到其他任务。
        </p>
        {(snapshot.library ?? []).map((entry) => (
          <label className="routine-check" key={entry.id}>
            <input
              type="checkbox"
              checked={libraryIds.includes(entry.id)}
              onChange={(event) =>
                setLibraryIds(
                  event.target.checked
                    ? [...libraryIds, entry.id]
                    : libraryIds.filter((id) => id !== entry.id),
                )
              }
            />
            {entry.title}
          </label>
        ))}
        <label>
          最多运行次数
          <input
            aria-label="最多运行次数"
            type="number"
            min={1}
            max={10000}
            value={maxRuns}
            onChange={(event) => setMaxRuns(Number(event.target.value))}
            required
          />
        </label>
        <label>
          累计 token 上限
          <input
            aria-label="累计 token 上限"
            type="number"
            min={1}
            max={100000000}
            value={maxTokens}
            onChange={(event) => setMaxTokens(Number(event.target.value))}
            required
          />
        </label>
        <p className="routine-note">
          开始下一轮前检查累计上限；单次调用可能越过剩余额度，用量不完整时暂停后续运行。
        </p>
      </details>
      <p className="routine-note">
        继承原目标、项目归属和已确认的方法版本。结果回到原工作，无新材料不调用模型。在设置中启用后台继续后，关闭窗口仍可在菜单栏运行；明确退出客户端或电脑休眠时暂停。
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="routine-actions">
        <button type="submit" disabled={busy}>
          {busy ? "正在保存…" : existing ? "保存新版本" : "建立例行工作"}
        </button>
        <button type="button" onClick={onDone} disabled={busy}>
          取消
        </button>
      </div>
    </form>
  );
}

export function TaskRoutineAction({
  task,
  snapshot,
  dispatch,
}: {
  task: Task;
  snapshot: RoutineView;
  dispatch: RoutineDispatch;
}) {
  const [open, setOpen] = useState(false);
  const eligible =
    task.status === "completed" &&
    (task.artifacts.length > 0 ||
      task.messages.some((message) => message.role === "assistant"));
  const existing =
    snapshot.routines?.items.filter(
      (routine) => routine.taskId === task.id && routine.state !== "stopped",
    ) ?? [];
  return (
    <div className="task-routine-action">
      <button
        type="button"
        disabled={!eligible}
        aria-expanded={open}
        title={
          eligible
            ? "把有效工作设为可重复执行的例行工作"
            : "先完成一次工作并检查结果"
        }
        onClick={() => setOpen(!open)}
      >
        设为例行
      </button>
      {existing.length > 0 && (
        <span className="routine-note">已有 {existing.length} 项例行工作</span>
      )}
      {open && (
        <RoutineForm
          task={task}
          snapshot={snapshot}
          dispatch={dispatch}
          onDone={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function RoutineCard({
  routine,
  snapshot,
  dispatch,
  onTask,
}: {
  routine: Routine;
  snapshot: RoutineView;
  dispatch: RoutineDispatch;
  onTask: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false),
    [recording, setRecording] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [occurredAt, setOccurredAt] = useState(localDateTime),
    [evidence, setEvidence] = useState("");
  const task = snapshot.tasks.find((task) => task.id === routine.taskId);
  const command = async (
    type: "routine.run" | "routine.pause" | "routine.resume" | "routine.stop",
  ) => {
    setBusy(true);
    setError("");
    try {
      await dispatch({
        type,
        routineId: routine.id,
        requestId: crypto.randomUUID(),
      });
    } catch (value) {
      setError(value instanceof Error ? value.message : "操作未完成。");
    } finally {
      setBusy(false);
    }
  };
  async function record(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await dispatch({
        type: "routine.recordNode",
        requestId: crypto.randomUUID(),
        routineId: routine.id,
        occurredAt: new Date(occurredAt).toISOString(),
        evidence,
        actual: true,
      });
      setRecording(false);
    } catch (value) {
      setError(value instanceof Error ? value.message : "发布节点未保存。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="routine-card" data-routine-id={routine.id}>
      <header>
        <div>
          <h3>{routine.title}</h3>
          <button
            type="button"
            className="routine-origin"
            onClick={() => onTask(routine.taskId)}
          >
            回到{task?.title ? `《${task.title}》` : "原工作"}
          </button>
        </div>
        <span className={`routine-state is-${routine.state}`}>
          {labels[routine.state]}
        </span>
      </header>
      <p>
        {routine.schedule.kind === "change"
          ? `每 ${routine.schedule.pollMinutes} 分钟检查本地资料与选定收藏`
          : routine.schedule.kind === "after_node"
            ? `真实发布 ${routine.schedule.delayMinutes} 分钟后`
            : routine.schedule.cadence === "interval"
              ? `每 ${routine.schedule.everyMinutes} 分钟`
              : `${routine.schedule.cadence === "daily" ? "每天" : "每周"} ${routine.schedule.time}`}{" "}
        ·{" "}
        {routine.location === "client"
          ? "本机客户端"
          : "旧记录：尚未建立远端委托"}
      </p>
      {routine.location === "server" && (
        <p className="routine-attention">
          这条记录不会在服务器执行。请在原工作的“委托远端处理”中建立真实服务端例行，再停止这条记录。
        </p>
      )}
      <p className="routine-note">
        下次：
        {["paused", "failed", "stopped"].includes(routine.state)
          ? "已暂停安排"
          : when(routine.nextRunAt, routine.schedule.timezone)}{" "}
        · {routine.schedule.timezone}
      </p>
      <p className="routine-note">
        已运行 {routine.runCount}/{routine.limits.maxRuns} 次 · 已知{" "}
        {routine.tokens.toLocaleString()} /{" "}
        {routine.limits.maxTokens.toLocaleString()} token
        {!routine.usageKnown ? " · 有用量尚未确认" : ""}
      </p>
      {routine.lastError && (
        <p className="routine-attention" role="status">
          {routine.lastError}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="routine-actions">
        {routine.state !== "stopped" && (
          <>
            <button
              type="button"
              disabled={
                busy ||
                routine.state === "running" ||
                routine.state === "paused" ||
                routine.state === "failed" ||
                routine.location === "server"
              }
              onClick={() => void command("routine.run")}
            >
              立即检查
            </button>
            {["paused", "failed", "waiting"].includes(routine.state) ? (
              <button
                type="button"
                disabled={busy || routine.location === "server"}
                onClick={() => void command("routine.resume")}
              >
                恢复
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => void command("routine.pause")}
              >
                暂停
              </button>
            )}
            <button
              type="button"
              disabled={busy || routine.state === "running" || !task}
              onClick={() => setEditing(!editing)}
            >
              编辑
            </button>
            {routine.schedule.kind === "after_node" && (
              <button
                type="button"
                disabled={busy || routine.state === "running"}
                onClick={() => setRecording(!recording)}
              >
                记录实际发布
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => void command("routine.stop")}
            >
              停止
            </button>
          </>
        )}
      </div>
      {editing && task && (
        <RoutineForm
          task={task}
          existing={routine}
          snapshot={snapshot}
          dispatch={dispatch}
          onDone={() => setEditing(false)}
        />
      )}
      {recording && (
        <form className="routine-form" onSubmit={record}>
          <label>
            实际发布时间（本机时区）
            <input
              aria-label="实际发布时间"
              type="datetime-local"
              required
              value={occurredAt}
              onChange={(event) => setOccurredAt(event.target.value)}
            />
          </label>
          <label>
            发布证据或实际记录
            <textarea
              aria-label="发布证据"
              required
              maxLength={2000}
              value={evidence}
              onChange={(event) => setEvidence(event.target.value)}
            />
          </label>
          <p className="routine-note">
            确认这已实际发生。未来计划不会触发工作。
          </p>
          <button type="submit" disabled={busy}>
            确认实际发布
          </button>
        </form>
      )}
      <details>
        <summary>方法、范围与运行记录</summary>
        <p className="routine-note">
          设置第 {routine.version} 版 · {routine.scope.libraryIds.length} 项收藏
          ·{" "}
          {routine.skills.length
            ? routine.skills
                .map(
                  (skill) =>
                    `${skill.name} v${skill.version} (${skill.hash.slice(0, 8)})`,
                )
                .join("、")
            : "不加载方法"}
        </p>
        <p className="routine-note">
          只在有新成果、失败或需要你处理时返回原工作。检查记录留在这里。
        </p>
        {!routine.runs.length && (
          <p className="routine-note">还没有执行记录。</p>
        )}
        <ol className="routine-history">
          {routine.runs
            .slice(-10)
            .reverse()
            .map((run) => (
              <li key={run.id}>
                <strong>
                  {when(run.startedAt, routine.schedule.timezone)} ·{" "}
                  {run.state === "unchanged"
                    ? "没有变化"
                    : run.state === "completed"
                      ? "已完成"
                      : run.state === "running"
                        ? "执行中"
                        : "需处理"}
                </strong>
                <p>{run.summary}</p>
                <small>
                  {run.state === "unchanged"
                    ? "未调用模型"
                    : `${run.tokens} token${run.usageKnown ? "" : "（用量不完整）"}`}{" "}
                  · 设置 v{run.version}
                </small>
              </li>
            ))}
        </ol>
      </details>
    </article>
  );
}

export function RoutinesPanel({
  snapshot,
  dispatch,
  onTask,
}: {
  snapshot: RoutineView;
  dispatch: RoutineDispatch;
  onTask: (id: string) => void;
}) {
  const [selectedTask, setSelectedTask] = useState("");
  const eligible = snapshot.tasks.filter(
    (task) =>
      task.surface !== "background" &&
      !task.archivedAt &&
      task.status === "completed" &&
      (task.artifacts.length > 0 ||
        task.messages.some((message) => message.role === "assistant")),
  );
  const task = eligible.find((task) => task.id === selectedTask);
  return (
    <section className="routines-panel" aria-label="例行工作管理">
      <header>
        <h2>例行工作</h2>
        <p>把已经有效的工作安排为持续检查，结果回到原处。</p>
      </header>
      <p className="routine-note">
        {snapshot.routines?.execution.notice ??
          "客户端运行且电脑唤醒时执行。在设置中启用后台继续后，关闭窗口仍可在菜单栏运行；明确退出或休眠期间暂停。无新材料不调用模型，错过时点只补查一轮。"}
      </p>
      <p className="routine-note">
        需要明确退出客户端后继续执行时，在原工作的“委托远端处理”中选择服务端安排；先在设置中连接
        AI 工作服务。
      </p>
      <details className="routine-new">
        <summary>从有效工作建立例行</summary>
        {eligible.length ? (
          <label>
            原工作
            <select
              aria-label="例行原工作"
              value={selectedTask}
              onChange={(event) => setSelectedTask(event.target.value)}
            >
              <option value="">选择已完成的工作</option>
              {eligible.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p>先完成并检查一次工作，再从这里建立例行。</p>
        )}
        {task && (
          <RoutineForm
            key={task.id}
            task={task}
            snapshot={snapshot}
            dispatch={dispatch}
            onDone={() => setSelectedTask("")}
          />
        )}
      </details>
      {(snapshot.routines?.items ?? []).map((routine) => (
        <RoutineCard
          key={routine.id}
          routine={routine}
          snapshot={snapshot}
          dispatch={dispatch}
          onTask={onTask}
        />
      ))}
      {!snapshot.routines?.items.length && (
        <p className="routine-empty">
          还没有例行工作。可从项目变化、收藏消化、栏目准备、发布后复盘或资产检查开始。
        </p>
      )}
    </section>
  );
}
