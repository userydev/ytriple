import { useEffect, useRef, useState } from "react";
import type { Snapshot, Task } from "../shared/types";
import type { WorkJob } from "../../services/work-service/contract";
import type { Dispatch } from "./common";
import { formatDate } from "./common";
const states: Record<WorkJob["state"], string> = {
  queued: "已排队",
  running: "远端执行中",
  completed: "成果可取回",
  failed: "处理失败",
  cancelled: "已取消",
  waiting: "等待新材料或节点",
  paused: "已暂停",
  uncertain: "上轮状态不明，已暂停重试",
};
function RemoteJob({
  job,
  snapshot,
  dispatch,
  onTask,
}: {
  job: WorkJob;
  snapshot: Snapshot;
  dispatch: Dispatch;
  onTask?: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false),
    [nodeTime, setNodeTime] = useState(""),
    [evidence, setEvidence] = useState(""),
    [error, setError] = useState(""),
    [maxRuns, setMaxRuns] = useState(job.limits.maxRuns),
    [maxTokens, setMaxTokens] = useState(job.limits.maxTokens);
  const pending = useRef(false);
  const perform = async (command: Parameters<Dispatch>[0]) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await dispatch(command);
      if (!result) setError("本次操作未完成，请查看错误提示后重试。");
      return result;
    } catch (value) {
      setError(value instanceof Error ? value.message : "服务操作未完成。");
      return null;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const collected = snapshot.workService?.collected[job.id];
  return (
    <details className="remote-job">
      <summary>
        {job.title} · {states[job.state]}
      </summary>
      <p>
        {job.materials.length} 项已提交资料 · {job.skills.length} 个固定方法 · v
        {job.version} · 已确认 {job.tokens.toLocaleString()} tokens /{" "}
        {job.runCount} 轮
        {job.runs.some(
          (run) => run.state !== "unchanged" && run.tokens === undefined,
        )
          ? " · 部分用量尚未确认"
          : ""}
      </p>
      {job.nextRunAt ? (
        <p>下次检查：{new Date(job.nextRunAt).toLocaleString()}</p>
      ) : null}
      {job.lastError ? <p role="status">{job.lastError}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <div className="form-actions">
        <button
          className="button secondary small"
          disabled={busy || !job.runs.some((run) => run.state === "completed")}
          onClick={() =>
            void perform({
              type: "service.job.collect",
              jobId: job.id,
              requestId: crypto.randomUUID(),
            }).then((result) => {
              const saved = result?.workService?.collected[job.id];
              if (saved) onTask?.(saved.taskId);
            })
          }
        >
          取回最新成果
        </button>
        {collected ? (
          <button
            className="text-button"
            onClick={() => onTask?.(collected.taskId)}
          >
            打开已取回工作
          </button>
        ) : null}
        {!["cancelled"].includes(job.state) ? (
          <button
            className="text-button"
            disabled={busy || job.state === "running"}
            onClick={() =>
              void perform({
                type: "service.job.update",
                jobId: job.id,
                requestId: crypto.randomUUID(),
                expectedVersion: job.version,
                action: ["paused", "failed", "uncertain"].includes(job.state)
                  ? "resume"
                  : "pause",
              })
            }
          >
            {["paused", "failed", "uncertain"].includes(job.state)
              ? "恢复远端执行"
              : "暂停远端执行"}
          </button>
        ) : null}
        <button
          className="text-button"
          disabled={busy || job.state === "cancelled"}
          onClick={() =>
            void perform({
              type: "service.job.cancel",
              jobId: job.id,
              requestId: crypto.randomUUID(),
            })
          }
        >
          取消委托
        </button>
      </div>
      {!["running", "cancelled"].includes(job.state) ? (
        <details>
          <summary>调整后续用量上限</summary>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void perform({
                type: "service.job.update",
                requestId: crypto.randomUUID(),
                jobId: job.id,
                expectedVersion: job.version,
                maxRuns,
                maxTokens,
              });
            }}
          >
            <label className="field">
              最多运行次数
              <input
                type="number"
                min={1}
                max={1000}
                required
                value={maxRuns}
                onChange={(event) => setMaxRuns(Number(event.target.value))}
              />
            </label>
            <label className="field">
              累计 token 上限
              <input
                type="number"
                min={1}
                max={10000000}
                required
                value={maxTokens}
                onChange={(event) => setMaxTokens(Number(event.target.value))}
              />
            </label>
            <button disabled={busy} className="button secondary small">
              保存上限
            </button>
          </form>
        </details>
      ) : null}
      {job.schedule.kind === "after_node" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void perform({
              type: "service.job.node",
              requestId: crypto.randomUUID(),
              jobId: job.id,
              expectedVersion: job.version,
              occurredAt: new Date(nodeTime).toISOString(),
              evidence,
            });
          }}
        >
          <label className="field">
            实际发布时间
            <input
              required
              type="datetime-local"
              value={nodeTime}
              onChange={(e) => setNodeTime(e.target.value)}
            />
          </label>
          <label className="field">
            发布证据
            <textarea
              required
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
            />
          </label>
          <button className="button secondary small" disabled={busy}>
            登记实际节点
          </button>
        </form>
      ) : null}
      <details>
        <summary>执行历史与实际用量</summary>
        {job.runs.toReversed().map((run) => (
          <p key={run.id}>
            {formatDate(run.startedAt)} · {run.state} ·{" "}
            {run.tokens === undefined ? "用量未确认" : `${run.tokens} tokens`}
            {run.error ? ` · ${run.error}` : ""}
          </p>
        ))}
      </details>
    </details>
  );
}

export function ServiceSettings({
  snapshot,
  dispatch,
  onTask,
}: {
  snapshot: Snapshot;
  dispatch: Dispatch;
  onTask?: (id: string) => void;
}) {
  const [panel, setPanel] = useState<"models" | "jobs" | "account">("models");
  const service = snapshot.workService;
  const [baseURL, setBaseURL] = useState(
      service?.baseURL ?? "http://127.0.0.1:8788",
    ),
    [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [deviceName, setDeviceName] = useState("我的电脑");
  const [busy, setBusy] = useState(false),
    [clearing, setClearing] = useState(false),
    [error, setError] = useState("");
  const identity = `${service?.baseURL ?? ""}:${service?.account?.user.id ?? ""}`;
  useEffect(() => {
    setClearing(false);
    setError("");
    setPanel("models");
  }, [identity]);
  const pending = useRef(false);
  const perform = async (command: Parameters<Dispatch>[0]) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await dispatch(command);
      if (!result) setError("操作未完成，请查看错误提示后重试。");
      return result;
    } catch (value) {
      setError(value instanceof Error ? value.message : "服务操作未完成。");
      return null;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <section
      className="settings-section service-settings"
      aria-label="账户与能力服务"
    >
      <div className="section-heading">
        <div>
          <h2>账户与服务</h2>
          <p className="section-description">
            登录服务后使用其模型与远端工作。
          </p>
        </div>
        {service?.baseURL ? (
          <button
            className="button secondary small"
            disabled={busy}
            onClick={() => void perform({ type: "service.refresh" })}
          >
            刷新服务状态
          </button>
        ) : null}
      </div>
      {service?.error ? <p role="status">{service.error}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {!service?.baseURL ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void perform({
              type: "service.login",
              baseURL,
              username,
              password,
              deviceName,
            }).then((result) => {
              if (result?.workService?.baseURL) setPassword("");
            });
          }}
        >
          <fieldset disabled={busy}>
            <div className="form-grid">
              <label className="field">
                服务地址
                <input
                  type="url"
                  required
                  value={baseURL}
                  onChange={(e) => setBaseURL(e.target.value)}
                />
              </label>
              <label className="field">
                设备名称
                <input
                  required
                  value={deviceName}
                  onChange={(e) => setDeviceName(e.target.value)}
                />
              </label>
              <label className="field">
                用户名
                <input
                  required
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </label>
              <label className="field">
                密码
                <input
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
            </div>
            <button className="button primary" disabled={busy}>
              {busy ? "连接中…" : "登录服务"}
            </button>
          </fieldset>
        </form>
      ) : (
        <>
          <p>
            <strong>{service.account?.user.username ?? "已保存的账户"}</strong>{" "}
            · {service.baseURL} ·{" "}
            {service.state === "connected" ? "已连接" : "暂时离线"}
          </p>
          {service.account ? (
            <div className="service-account">
              <p>
                {service.account.entitlement.plan} ·{" "}
                {service.account.entitlement.active ? "权益有效" : "权益不可用"}
                {service.account.entitlement.expiresAt
                  ? ` · 到期 ${formatDate(service.account.entitlement.expiresAt)}`
                  : ""}
              </p>
              <p>
                已用 {service.account.usage.usedTokens.toLocaleString()} tokens
                · 剩余 {service.account.usage.remainingTokens.toLocaleString()}{" "}
                · 处理中预留{" "}
                {service.account.usage.reservedTokens.toLocaleString()}
                {service.account.usage.unknownRequests
                  ? ` · ${service.account.usage.unknownRequests} 笔用量待确认`
                  : ""}
              </p>
            </div>
          ) : null}
          <nav className="asset-operation-tabs" aria-label="账户服务内容">
            <button
              type="button"
              aria-pressed={panel === "models"}
              onClick={() => setPanel("models")}
            >
              模型能力
            </button>
            <button
              type="button"
              aria-pressed={panel === "jobs"}
              onClick={() => setPanel("jobs")}
            >
              远端工作 · {service.jobs.length}
            </button>
            <button
              type="button"
              aria-pressed={panel === "account"}
              onClick={() => setPanel("account")}
            >
              设备与数据
            </button>
          </nav>
          <div hidden={panel !== "models"}>
            <h3>可用模型</h3>
            <div className="service-models">
              {service.models.map((model) => {
                const profile = snapshot.profiles.find(
                  (p) =>
                    p.baseURL === `${service.baseURL}/v1` &&
                    p.modelId === model.id,
                );
                return (
                  <article key={model.id}>
                    <strong>{model.name}</strong>
                    <span>
                      {model.capabilities.tools
                        ? "服务支持工具调用"
                        : "服务仅支持文字"}{" "}
                      ·{" "}
                      {profile?.status === "ready"
                        ? "本机连接已验证"
                        : "本机连接尚待验证"}
                    </span>
                    <div className="form-actions">
                      <button
                        className="button secondary small"
                        disabled={busy}
                        onClick={() =>
                          void perform({
                            type: "service.model.select",
                            modelId: model.id,
                          })
                        }
                      >
                        设为团队模型
                      </button>
                      {profile ? (
                        <button
                          className="text-button"
                          disabled={busy}
                          onClick={() =>
                            void perform({
                              type: "profile.probe",
                              profileId: profile.id,
                            })
                          }
                        >
                          实际测试连接
                        </button>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
          <div hidden={panel !== "account"}>
            <details>
              <summary>登录设备 · {service.devices.length}</summary>
              {service.devices.map((device) => (
                <div className="service-device" key={device.id}>
                  <span>
                    {device.name}
                    {device.current ? " · 当前设备" : ""} · 最近使用{" "}
                    {formatDate(device.lastSeenAt)}
                  </span>
                  <button
                    disabled={busy}
                    className="text-button"
                    onClick={() =>
                      void perform(
                        device.current
                          ? { type: "service.logout" }
                          : {
                              type: "service.device.revoke",
                              deviceId: device.id,
                            },
                      )
                    }
                  >
                    撤销登录
                  </button>
                </div>
              ))}
            </details>
          </div>
          <section hidden={panel !== "jobs"} className="service-job-list">
            <h3>远端委托 · {service.jobs.length}</h3>
            {!service.jobs.length ? (
              <p className="muted">
                还没有远端工作。可以从原工作中选择资料并发起委托。
              </p>
            ) : null}
            {service.jobs.map((job) => (
              <RemoteJob
                key={`${service.baseURL}:${service.account?.user.id}:${job.id}`}
                job={job}
                snapshot={snapshot}
                dispatch={dispatch}
                onTask={onTask}
              />
            ))}
          </section>
          <div hidden={panel !== "account"}>
            <div className="form-actions">
              <button
                className="button secondary small"
                disabled={busy}
                onClick={() => void perform({ type: "service.export" })}
              >
                导出账户与远端资料
              </button>
              <button
                className="text-button"
                disabled={busy}
                onClick={() => setClearing(!clearing)}
              >
                清理远端资料
              </button>
              <button
                className="text-button"
                disabled={busy}
                onClick={() => void perform({ type: "service.logout" })}
              >
                退出账户
              </button>
            </div>
            {clearing ? (
              <div className="inline-notice">
                <p>
                  将取消远端工作并删除该账户的任务正文和结果。本机资料保留；服务仍保留用于配额核算的数字用量。
                </p>
                <button
                  className="button secondary small"
                  disabled={busy}
                  onClick={() =>
                    void perform({
                      type: "service.clearData",
                      confirm: "delete-my-data",
                    }).then((result) => {
                      if (result) setClearing(false);
                    })
                  }
                >
                  确认清理远端资料
                </button>
              </div>
            ) : null}
            {service.exports.map((item) => (
              <button
                key={item.path}
                className="text-button"
                onClick={() =>
                  void dispatch({ type: "path.reveal", path: item.path })
                }
              >
                显示 {formatDate(item.createdAt)} 的账户导出
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

export function TaskRemoteAction({
  task,
  snapshot,
  dispatch,
  onTask,
}: {
  task: Task;
  snapshot: Snapshot;
  dispatch: Dispatch;
  onTask: (id: string) => void;
}) {
  const service = snapshot.workService;
  const [sourceIds, setSourceIds] = useState<string[]>([]),
    [skillIds, setSkillIds] = useState<string[]>([]),
    [modelId, setModelId] = useState(""),
    [schedule, setSchedule] = useState<
      "once" | "change" | "daily" | "weekly" | "interval" | "after_node"
    >("once"),
    [time, setTime] = useState("09:00"),
    [timezone, setTimezone] = useState(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    ),
    [weekday, setWeekday] = useState(1),
    [everyMinutes, setEveryMinutes] = useState(60),
    [delayMinutes, setDelayMinutes] = useState(1440),
    [maxRuns, setMaxRuns] = useState(10),
    [maxTokens, setMaxTokens] = useState(100000),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const requests = useRef(new Map<string, string>()),
    pending = useRef(false);
  if (!service?.baseURL) return null;
  const jobs = service.jobs.filter((job) => job.origin?.taskId === task.id);
  const submit = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    const selectedModel = modelId || service.models[0]?.id;
    if (!selectedModel) {
      pending.current = false;
      setBusy(false);
      return;
    }
    const signature = JSON.stringify({
      goalVersion: task.goalVersion,
      sourceIds,
      skillIds,
      sourceVersions: task.sources
        .filter((source) => sourceIds.includes(source.id))
        .map((source) => [source.id, source.text]),
      skillVersions: (task.skillBindings ?? [])
        .filter((skill) => skillIds.includes(skill.id))
        .map((skill) => [skill.id, skill.hash]),
      account: service.account?.user.id,
      selectedModel,
      schedule,
      time,
      timezone,
      weekday,
      everyMinutes,
      delayMinutes,
      maxRuns,
      maxTokens,
    });
    const requestId = requests.current.get(signature) ?? crypto.randomUUID();
    requests.current.set(signature, requestId);
    try {
      const result = await dispatch({
        type: "service.job.create",
        requestId,
        taskId: task.id,
        modelId: selectedModel,
        sourceIds,
        skillIds,
        schedule,
        time,
        timezone,
        weekday,
        everyMinutes,
        delayMinutes,
        maxRuns,
        maxTokens,
      });
      if (!result) setError("远端委托未创建，请查看提示并核对材料选择。");
    } catch (value) {
      setError(value instanceof Error ? value.message : "远端委托未完成。");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const toggle = (values: string[], id: string) =>
    values.includes(id)
      ? values.filter((value) => value !== id)
      : [...values, id];
  return (
    <details className="task-remote">
      <summary>委托远端处理{jobs.length ? ` · ${jobs.length} 项` : ""}</summary>
      <p>
        仅提交当前工作目标和下面勾选的资料、方法正文。远端不会读取本机目录；资料变化后需明确更新快照。
      </p>
      {error ? <p role="alert">{error}</p> : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <fieldset disabled={busy}>
          <label className="field">
            使用模型
            <select
              aria-label="远端使用模型"
              value={modelId || service.models[0]?.id || ""}
              onChange={(e) => setModelId(e.target.value)}
            >
              {service.models.map((model) => (
                <option value={model.id} key={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
          </label>
          {task.sources
            .filter((source) => !source.library?.supersededAt)
            .map((source) => (
              <label className="remote-choice" key={source.id}>
                <input
                  type="checkbox"
                  checked={sourceIds.includes(source.id)}
                  onChange={() => setSourceIds(toggle(sourceIds, source.id))}
                />
                {source.title}
              </label>
            ))}
          {(task.skillBindings ?? []).map((skill) => (
            <label className="remote-choice" key={skill.id}>
              <input
                type="checkbox"
                checked={skillIds.includes(skill.id)}
                onChange={() => setSkillIds(toggle(skillIds, skill.id))}
              />
              {skill.name} v{skill.version}
            </label>
          ))}
          <label className="field">
            运行安排
            <select
              aria-label="远端运行安排"
              value={schedule}
              onChange={(e) => setSchedule(e.target.value as typeof schedule)}
            >
              <option value="once">处理一次</option>
              <option value="change">收到明确提交的新材料时</option>
              <option value="daily">每天检查一次</option>
              <option value="weekly">每周检查一次</option>
              <option value="interval">固定时间间隔</option>
              <option value="after_node">实际发布后</option>
            </select>
          </label>
          {schedule === "daily" || schedule === "weekly" ? (
            <label className="field">
              本地时区时间
              <input
                type="time"
                required
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </label>
          ) : null}
          {schedule === "weekly" ? (
            <label className="field">
              星期
              <select
                aria-label="远端执行星期"
                value={weekday}
                onChange={(event) => setWeekday(Number(event.target.value))}
              >
                {["周日", "周一", "周二", "周三", "周四", "周五", "周六"].map(
                  (day, index) => (
                    <option value={index} key={day}>
                      {day}
                    </option>
                  ),
                )}
              </select>
            </label>
          ) : null}
          {schedule === "interval" ? (
            <label className="field">
              间隔分钟
              <input
                aria-label="远端间隔分钟"
                type="number"
                required
                min={5}
                max={525600}
                value={everyMinutes}
                onChange={(event) =>
                  setEveryMinutes(Number(event.target.value))
                }
              />
            </label>
          ) : null}
          {schedule === "after_node" ? (
            <>
              <label className="field">
                实际发布后等待分钟
                <input
                  aria-label="发布后等待分钟"
                  type="number"
                  required
                  min={0}
                  max={525600}
                  value={delayMinutes}
                  onChange={(event) =>
                    setDelayMinutes(Number(event.target.value))
                  }
                />
              </label>
              <p>创建后登记实际发生的发布时间与证据。计划日期不会触发复盘。</p>
            </>
          ) : null}
          {!["once", "change"].includes(schedule) ? (
            <label className="field">
              执行时区
              <input
                aria-label="远端执行时区"
                required
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
              />
            </label>
          ) : null}
          <details>
            <summary>次数和用量上限</summary>
            <label className="field">
              最多运行次数
              <input
                aria-label="远端最多运行次数"
                type="number"
                required
                min={1}
                max={1000}
                value={maxRuns}
                onChange={(event) => setMaxRuns(Number(event.target.value))}
              />
            </label>
            <label className="field">
              累计 token 上限
              <input
                aria-label="远端累计 token 上限"
                type="number"
                required
                min={1}
                max={10000000}
                value={maxTokens}
                onChange={(event) => setMaxTokens(Number(event.target.value))}
              />
            </label>
          </details>
          <p className="field-hint">
            最多 {maxRuns} 次、累计 {maxTokens.toLocaleString()}{" "}
            tokens；无新输入不重复调用模型。远端可在关闭客户端后继续检查。上限在后续调用前检查，单次调用可能超过剩余额度。
          </p>
          <button
            className="button secondary small"
            disabled={
              busy ||
              service.state !== "connected" ||
              !service.models.length ||
              !sourceIds.length
            }
          >
            提交明确选择的范围
          </button>
        </fieldset>
      </form>
      {jobs.map((job) => (
        <div key={job.id}>
          <RemoteJob
            job={job}
            snapshot={snapshot}
            dispatch={dispatch}
            onTask={onTask}
          />
          {job.schedule.kind !== "once" ? (
            <button
              className="text-button"
              disabled={busy || !sourceIds.length}
              onClick={() => {
                setBusy(true);
                void dispatch({
                  type: "service.job.update",
                  jobId: job.id,
                  requestId: crypto.randomUUID(),
                  expectedVersion: job.version,
                  taskId: task.id,
                  sourceIds,
                }).finally(() => setBusy(false));
              }}
            >
              将本次勾选材料更新给此委托
            </button>
          ) : null}
        </div>
      ))}
    </details>
  );
}
