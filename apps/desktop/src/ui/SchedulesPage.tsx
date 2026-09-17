import { useRef, useState } from "react";
import {
  Plus,
  Play,
  Pause,
  Square,
  Pencil,
  ArrowUpRight,
  Clock,
} from "lucide-react";
import type { Snapshot, Reference } from "../core/types";
import {
  occurrenceLabels,
  scheduleProblem,
  type Schedule,
  type ScheduleInput,
} from "../core/schedule-contract";
import { outputLabels } from "../core/output";
import { command } from "./api";
import { Dialog } from "./Dialog";
import { IconButton } from "./Composer";
import { References } from "./References";
import { SkillChooser } from "./SkillChooser";
import { RadarAutomationList } from "./RadarAutomation";

function localDate(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
function time(at: string | null, zone: string) {
  return at
    ? new Intl.DateTimeFormat("zh-CN", {
        timeZone: zone,
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(at))
    : "—";
}
export function ScheduleEditor({
  data,
  schedule,
  workId,
  onClose,
  onSaved,
}: {
  data: Snapshot;
  schedule?: Schedule;
  workId?: string;
  onClose: () => void;
  onSaved: (schedule: Schedule) => void;
}) {
  const [id] = useState(() => schedule?.id ?? crypto.randomUUID());
  const [selectedWork, setWork] = useState(schedule?.workId ?? workId ?? "");
  const initialRun = data.runs
    .filter((r) => r.workId === selectedWork && r.status === "succeeded")
    .at(-1);
  const [name, setName] = useState(
    schedule?.name ??
      data.works.find((w) => w.id === selectedWork)?.title ??
      "",
  );
  const [text, setText] = useState(schedule?.text ?? initialRun?.text ?? "");
  const [projectId, setProject] = useState(
    schedule?.projectId ??
      data.works.find((w) => w.id === selectedWork)?.projectId ??
      "",
  );
  const [refs, setRefs] = useState<Reference[]>(
    schedule?.refs ?? initialRun?.refs ?? [],
  );
  const [keys, setKeys] = useState(
    schedule?.skillKeys ?? initialRun?.requestedSkillKeys ?? [],
  );
  const [recipient, setRecipient] = useState(
    schedule?.recipient ?? initialRun?.recipient ?? "",
  );
  const [outputMode, setMode] = useState<ScheduleInput["outputMode"]>(
    schedule?.outputMode ?? initialRun?.outputMode ?? "result",
  );
  const [hours, setHours] = useState(
    schedule?.intervalHours === null
      ? ""
      : String(schedule?.intervalHours ?? 24),
  );
  const [firstAt, setFirst] = useState(() =>
    localDate(
      new Date(
        schedule?.nextAt && Date.parse(schedule.nextAt) > Date.now()
          ? schedule.nextAt
          : Date.now() + 3600000,
      ),
    ),
  );
  const [followLatest, setLatest] = useState(
    schedule?.followLatest ?? !refs.some((r) => r.excerpt),
  );
  const [limit, setLimit] = useState(schedule?.maxModelCalls ?? 8);
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const work = data.works.find((w) => w.id === selectedWork);
  const team =
    data.teams.find((t) => `${t.id}@${t.version}` === work?.teamKey) ??
    data.team;
  const workflow =
    data.workflows.find((w) => `${w.id}@${w.version}` === work?.workflowKey) ??
    data.workflow;
  const materials = data.materials.filter(
    (m) =>
      !m.readError &&
      m.body.trim() &&
      !data.materials.some((n) => n.id === m.id && n.version > m.version),
  );
  function chooseWork(value: string) {
    setWork(value);
    const selected = data.works.find((w) => w.id === value);
    const run = data.runs
      .filter((r) => r.workId === value && r.status === "succeeded")
      .at(-1);
    setProject(selected?.projectId ?? "");
    setName(selected?.title ?? "");
    setText(run?.text ?? "");
    setRefs(run?.refs ?? []);
    setKeys(run?.requestedSkillKeys ?? []);
    setRecipient(run?.recipient ?? "");
    setMode(run?.outputMode ?? "result");
    setLatest(!run?.refs.some((r) => r.excerpt));
  }
  return (
    <Dialog
      title={schedule ? "编辑定时任务" : "新建定时任务"}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="schedule-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setError("");
          setBusy(true);
          try {
            const date = new Date(firstAt);
            if (!Number.isFinite(date.getTime()) || localDate(date) !== firstAt)
              throw Error("所选本地时间不存在，请调整时间");
            const saved = await command<Schedule>({
              type: "schedule-save",
              input: {
                id,
                expectedRevision: schedule?.revision ?? 0,
                name,
                workId: selectedWork || null,
                projectId: projectId || null,
                text,
                refs,
                recipient: recipient || null,
                skillKeys: keys,
                outputMode,
                firstAt: date.toISOString(),
                intervalHours: hours ? Number(hours) : null,
                timezone,
                followLatest,
                maxModelCalls: limit,
                enabled,
              },
            });
            onSaved(saved);
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          任务名称
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={120}
            autoFocus
          />
        </label>
        <label>
          结果归回
          <select
            value={selectedWork}
            disabled={!!schedule}
            onChange={(e) => chooseWork(e.target.value)}
          >
            <option value="">新建一项持续工作</option>
            {data.works
              .filter(
                (w) => (!w.archived && !w.completedAt) || w.id === selectedWork,
              )
              .map((w) => (
                <option key={w.id} value={w.id}>
                  {w.title}
                </option>
              ))}
          </select>
        </label>
        {!selectedWork ? (
          <label>
            所属项目
            <select
              value={projectId}
              onChange={(e) => setProject(e.target.value)}
            >
              <option value="">独立工作</option>
              {data.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <small>
            {data.projects.find((p) => p.id === projectId)?.name ?? "独立工作"}{" "}
            · 每次运行进入同一工作与成果链
          </small>
        )}
        <label>
          让团队做什么
          <textarea
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
            required
          />
        </label>
        <div className="schedule-timing">
          <label>
            首次执行
            <input
              type="datetime-local"
              value={firstAt}
              onChange={(e) => setFirst(e.target.value)}
              required
            />
          </label>
          <label>
            重复
            <select value={hours} onChange={(e) => setHours(e.target.value)}>
              <option value="">只执行一次</option>
              {[...new Set([1, 6, 24, 168, ...(hours ? [Number(hours)] : [])])]
                .sort((a, b) => a - b)
                .map((n) => (
                  <option key={n} value={n}>
                    每 {n} 小时
                  </option>
                ))}
            </select>
          </label>
        </div>
        <small>
          {timezone} · 周期按实际小时计算；跨夏令时可能改变本地钟点。
        </small>
        <References
          data={data}
          refs={refs}
          onChange={setRefs}
          disabled={busy}
        />
        <label>
          添加已读取材料
          <select
            value=""
            disabled={refs.length >= 20}
            onChange={(e) => {
              const m = materials.find(
                (m) => `${m.id}@${m.version}` === e.target.value,
              );
              if (m && !refs.some((r) => r.materialId === m.id))
                setRefs([
                  ...refs,
                  { materialId: m.id, version: m.version, label: m.title },
                ]);
            }}
          >
            <option value="">选择材料…</option>
            {materials
              .filter((m) => !refs.some((r) => r.materialId === m.id))
              .map((m) => (
                <option key={m.id} value={`${m.id}@${m.version}`}>
                  {m.title} · v{m.version}
                </option>
              ))}
          </select>
        </label>
        <label className="schedule-check">
          <input
            type="checkbox"
            checked={followLatest}
            onChange={(e) => setLatest(e.target.checked)}
          />
          跟随所选材料的已读取新版本
        </label>
        <p className="muted">
          不会自行读取文件或抓取网页。输入没有变化时只记录检查；立即运行会重新调用模型。
        </p>
        <div className="schedule-authorization">
          <strong>本机执行 · 每次最多 {limit} 次模型请求</strong>
          <p>
            {team.name} v{team.version} · {workflow.name} v{workflow.version}
          </p>
          <small>
            {data.service.baseUrl} ·
            保存后按此范围委托；方法、项目要求或连接改变需重新核对。
          </small>
        </div>
        <details>
          <summary>负责人、方法与用量</summary>
          <label>
            负责人
            <select
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
            >
              <option value="">团队协作</option>
              {team.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            输出类型
            <select
              value={outputMode}
              onChange={(e) =>
                setMode(e.target.value as ScheduleInput["outputMode"])
              }
            >
              {Object.entries(outputLabels).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            每次模型请求上限
            <input
              type="number"
              min={1}
              max={32}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              required
            />
          </label>
          <SkillChooser data={data} selected={keys} onChange={setKeys} />
        </details>
        <p className="muted">
          应用运行且电脑唤醒时执行。关闭窗口会退出；错过的周期不补跑。结果与问题在工作台查看，尚无系统通知。
        </p>
        <label className="schedule-check">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          保存后启用后续触发
        </label>
        {error ? <p role="alert">{error}</p> : null}
        <button
          type="submit"
          className="primary"
          disabled={
            busy || !(data.model?.configured ?? data.service.configured)
          }
        >
          {busy ? "保存中…" : "保存委托"}
        </button>
      </form>
    </Dialog>
  );
}

export function SchedulesPage({
  data,
  onRadar,
  onWork,
  selectedId,
  onSelect,
}: {
  data: Snapshot;
  onRadar: (id: string | null) => void;
  onWork: (id: string, versionId?: string) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [editor, setEditor] = useState<Schedule | "new" | null>(null);
  const [filter, setFilter] = useState("all"),
    [project, setProject] = useState("all");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const submitting = useRef(false),
    manualKeys = useRef(new Map<string, string>());
  async function act(action: () => Promise<unknown>) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  const visible = data.schedules.filter(
    (s) =>
      (project === "all" || s.projectId === (project || null)) &&
      (filter === "all" ||
        (filter === "attention"
          ? !!scheduleProblem(s, data.scheduleOccurrences, data.runs)
          : filter === "enabled"
            ? s.enabled
            : !s.enabled)),
  );
  const selected = data.schedules.find((s) => s.id === selectedId);
  return (
    <section className="wide-content schedules-page">
      <div className="section-heading">
        <div>
          <small>SCHEDULES · 本机</small>
          <h1>持续委托</h1>
        </div>
        <button className="primary" onClick={() => setEditor("new")}>
          <Plus size={17} />
          新建任务
        </button>
      </div>
      <p className="lede">把重复的工作交给团队，结果回到原处。</p>
      <p className="muted">
        应用运行、电脑唤醒时触发；关闭窗口即退出，错过的周期不集中补跑。
      </p>
      <RadarAutomationList data={data} onRead={onRadar} />
      {data.radar.watches.length ? <h2>团队定时任务</h2> : null}
      <div className="schedule-filters">
        <label>
          状态
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">全部</option>
            <option value="enabled">已启用</option>
            <option value="paused">已暂停</option>
            <option value="attention">需处理</option>
          </select>
        </label>
        <label>
          项目
          <select value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="all">全部项目</option>
            <option value="">独立工作</option>
            {data.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {!visible.length ? (
        <div className="empty">
          <Clock size={26} />
          <h2>
            {data.schedules.length
              ? "没有符合筛选的任务"
              : "安排下一次团队工作"}
          </h2>
          <p>选择目标和已有材料，设定首次时间与周期。</p>
        </div>
      ) : null}
      <div className="schedule-list">
        {visible.map((s) => {
          const problem = scheduleProblem(
            s,
            data.scheduleOccurrences,
            data.runs,
          );
          const last = data.scheduleOccurrences
            .filter((o) => o.scheduleId === s.id)
            .at(-1);
          const run = last?.runId
            ? data.runs.find((r) => r.id === last.runId)
            : undefined;
          const active = data.scheduleOccurrences
            .filter(
              (o) =>
                o.scheduleId === s.id &&
                data.runs.some(
                  (r) =>
                    r.id === o.runId &&
                    ["queued", "running", "waiting", "unknown"].includes(
                      r.status,
                    ),
                ),
            )
            .at(-1);
          return (
            <article key={s.id}>
              <div className="schedule-row-main">
                <button className="work-title" onClick={() => onSelect(s.id)}>
                  {s.name}
                  <ArrowUpRight size={16} />
                </button>
                <small>
                  {data.projects.find((p) => p.id === s.projectId)?.name ??
                    "独立工作"}{" "}
                  · 本机 ·{" "}
                  {problem ? "需处理" : s.enabled ? "已启用" : "已暂停"}
                </small>
                <p>
                  {s.intervalHours ? `每 ${s.intervalHours} 小时` : "单次"} ·
                  下次 {time(s.nextAt, s.timezone)} <small>{s.timezone}</small>
                </p>
                <p className="muted">
                  {last
                    ? `上次 ${time(last.checkedAt, s.timezone)} · ${occurrenceLabels[run?.status ?? last.state]}`
                    : "尚未执行"}
                  {problem ? ` · ${problem}` : ""}
                </p>
              </div>
              <div className="schedule-actions">
                <IconButton
                  label={`立即运行 ${s.name}`}
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      const key =
                        manualKeys.current.get(s.id) ?? crypto.randomUUID();
                      manualKeys.current.set(s.id, key);
                      await command({
                        type: "schedule-now",
                        id: s.id,
                        revision: s.revision,
                        key,
                      });
                      manualKeys.current.delete(s.id);
                    })
                  }
                >
                  <Play size={17} />
                </IconButton>
                <IconButton
                  label={`${s.enabled ? "暂停后续触发" : "启用后续触发"} ${s.name}`}
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      command({
                        type: "schedule-enabled",
                        id: s.id,
                        revision: s.revision,
                        enabled: !s.enabled,
                      }),
                    )
                  }
                >
                  {s.enabled ? <Pause size={17} /> : <Clock size={17} />}
                </IconButton>
                <IconButton
                  label={`编辑 ${s.name}`}
                  disabled={busy}
                  onClick={() => setEditor(s)}
                >
                  <Pencil size={17} />
                </IconButton>
                {active ? (
                  <IconButton
                    label={`停止本次运行 ${s.name}`}
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        command({
                          type: "schedule-stop",
                          occurrenceId: active.id,
                        }),
                      )
                    }
                  >
                    <Square size={17} />
                  </IconButton>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
      {selected ? (
        <Dialog title={selected.name} onClose={() => onSelect(null)}>
          <p>{selected.text}</p>
          <p className="muted">
            {selected.team.name} v{selected.team.version} ·{" "}
            {selected.workflow.name} v{selected.workflow.version} · 委托 v
            {selected.revision}
          </p>
          <p>
            结果归回：{data.works.find((w) => w.id === selected.workId)?.title}
          </p>
          <References
            data={data}
            refs={selected.refs}
            onChange={() => {}}
            disabled
          />
          <details>
            <summary>已授权的方法版本 · {selected.skills.length}</summary>
            {selected.skills.map((s) => (
              <p key={`${s.id}@${s.version}`}>
                {s.name} v{s.version}
              </p>
            ))}
          </details>
          <p className="muted">
            每次最多 {selected.maxModelCalls}{" "}
            次模型请求。请求次数含已尝试提交，不能等同实际收费；服务尚未回传费用。
          </p>
          <button
            className="text-action"
            onClick={() => {
              onSelect(null);
              onWork(selected.workId);
            }}
          >
            打开原工作
            <ArrowUpRight size={16} />
          </button>
          <h3>触发与运行历史</h3>
          {!data.scheduleOccurrences.some(
            (o) => o.scheduleId === selected.id,
          ) ? (
            <p>尚未触发。</p>
          ) : null}
          {data.scheduleOccurrences
            .filter((o) => o.scheduleId === selected.id)
            .slice()
            .reverse()
            .map((o) => {
              const run = data.runs.find((r) => r.id === o.runId);
              const version = data.versions.find((v) => v.runId === o.runId);
              const calls = data.modelCalls.filter((c) => c.runId === o.runId);
              return (
                <article className="schedule-history" key={o.id}>
                  <strong>{occurrenceLabels[run?.status ?? o.state]}</strong>
                  <small>
                    {time(o.checkedAt, selected.timezone)} ·{" "}
                    {o.trigger === "manual" ? "立即运行" : "定时触发"} · 委托 v
                    {o.revision}
                  </small>
                  <p>{run?.error ?? o.detail}</p>
                  <small>
                    模型请求 {calls.length} 次 · 确认完成{" "}
                    {calls.filter((c) => c.state === "completed").length} 次
                  </small>
                  {run ? (
                    <button
                      className="text-action"
                      onClick={() => {
                        onSelect(null);
                        onWork(run.workId, version?.id);
                      }}
                    >
                      {version ? "查看本次成果" : "查看原工作与过程"}
                      <ArrowUpRight size={15} />
                    </button>
                  ) : null}
                </article>
              );
            })}
        </Dialog>
      ) : null}
      {editor ? (
        <ScheduleEditor
          data={data}
          schedule={editor === "new" ? undefined : editor}
          onClose={() => setEditor(null)}
          onSaved={(s) => {
            setEditor(null);
            onSelect(s.id);
          }}
        />
      ) : null}
    </section>
  );
}
