import { useState } from "react";
import {
  ArrowRight,
  ArrowLeft,
  FileText,
  FolderOpen,
  MessageSquare,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Sprout,
  CircleAlert,
  Search,
  Activity,
} from "lucide-react";
import type { ProjectInfo, ProjectInput, Snapshot } from "../shared/types";
import {
  Modal,
  STATUS_NAMES,
  formatDate,
  memberName,
  type Dispatch,
} from "./common";
import {
  deriveProjectStatus,
  type ProjectStateSignal,
  type ProjectStatus,
} from "../shared/project-status";
import { ProjectExplorer } from "./ProjectExplorer";

const clock = (value?: string) =>
  value
    ? new Date(value).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "尚未读取";

function Initialization({
  snapshot,
  dispatch,
  onTask,
}: {
  snapshot: Snapshot;
  dispatch: Dispatch;
  onTask?: (id: string) => void;
}) {
  const [input, setInput] = useState<ProjectInput>({
    id: "",
    name: "",
    series: "y",
    description: "",
  });
  const [pending, setPending] = useState(false);
  const [completed, setCompleted] = useState<string | null>(null);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    try {
      const result = await dispatch({ type: "project.initialize", input });
      if (result) setCompleted(input.name || input.id);
    } finally {
      setPending(false);
    }
  };
  const discuss = async () => {
    setPending(true);
    try {
      const before = new Set(snapshot.tasks.map((task) => task.id));
      const result = await dispatch({
        type: "task.create",
        kind: "project",
        member: "cto",
        title: input.name ? `项目讨论 · ${input.name}` : "讨论一个新项目",
        goal:
          input.description.trim() ||
          "和我一起讨论产品雏形、需求与项目边界，再整理为可交给 Codex 开发的项目文档。",
      });
      const task = result?.tasks.find((item) => !before.has(item.id));
      if (task) {
        setInput((value) => ({ ...value, taskId: task.id }));
        onTask?.(task.id);
      }
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="project-initialization-card">
      <div className="project-init-heading">
        <Sprout size={21} />
        <div>
          <h2>从想法建立新项目</h2>
          <p>先讨论，也可以直接准备规则、文档与本地开发目录。</p>
        </div>
      </div>
      {completed ? (
        <div className="inline-notice">
          已初始化「{completed}」，项目列表已更新。
        </div>
      ) : null}
      <form onSubmit={(event) => void submit(event)}>
        <div className="project-init-fields">
          <label className="field">
            项目名称
            <input
              value={input.name}
              onChange={(event) =>
                setInput((value) => ({ ...value, name: event.target.value }))
              }
              placeholder="例如：我的阅读工具"
              required
              maxLength={120}
            />
          </label>
          <label className="field">
            项目 ID
            <input
              value={input.id}
              onChange={(event) =>
                setInput((value) => ({
                  ...value,
                  id: event.target.value.toLowerCase(),
                }))
              }
              placeholder="my-reading-tool"
              pattern="[a-z0-9][a-z0-9.-]*"
              required
              maxLength={80}
            />
          </label>
          <label className="field">
            产品系列
            <select
              value={input.series}
              onChange={(event) =>
                setInput((value) => ({
                  ...value,
                  series: event.target.value as ProjectInput["series"],
                }))
              }
            >
              <option value="x">x · 探索</option>
              <option value="y">y · 开源工具</option>
              <option value="z">z · 闭源产品</option>
            </select>
          </label>
        </div>
        <label className="field">
          雏形与需求
          <textarea
            value={input.description}
            onChange={(event) =>
              setInput((value) => ({
                ...value,
                description: event.target.value,
              }))
            }
            placeholder="想解决什么问题，给谁使用，第一步先做到什么。"
            required
            maxLength={40000}
            rows={4}
          />
        </label>
        {snapshot.tasks.some((task) => task.kind === "project") ? (
          <label className="field">
            使用已有讨论
            <select
              value={input.taskId ?? ""}
              onChange={(event) =>
                setInput((value) => ({
                  ...value,
                  taskId: event.target.value || undefined,
                }))
              }
            >
              <option value="">只用上面的说明</option>
              {snapshot.tasks
                .filter((task) => task.kind === "project")
                .map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.title}
                  </option>
                ))}
            </select>
          </label>
        ) : null}
        <div className="project-init-footer">
          <span>使用设置中的 AI / Code 根目录</span>
          <button
            className="button secondary"
            type="button"
            disabled={pending}
            onClick={() => void discuss()}
          >
            <MessageSquare size={14} />
            先和团队讨论
          </button>
          <button className="button primary" disabled={pending} type="submit">
            {pending ? "处理中…" : "初始化项目"}
            <ArrowRight size={14} />
          </button>
        </div>
      </form>
    </section>
  );
}

function StateEvidence({ signal }: { signal: ProjectStateSignal }) {
  return (
    <span className={`project-evidence source-${signal.evidence.kind}`}>
      {signal.evidence.label}
      {signal.evidence.at ? ` · ${formatDate(signal.evidence.at)}` : ""}
    </span>
  );
}
export function Projects({
  snapshot,
  dispatch,
  onInitialize,
  onTask,
  selectedProjectId,
  onSelectProject,
  onClearSelection,
  onDiscussProject,
  onArtifact,
  overviewOnly = false,
  hideHeading = false,
  onShowFiles,
}: {
  snapshot: Snapshot | null;
  dispatch: Dispatch;
  onInitialize?: () => void;
  onTask?: (id: string) => void;
  selectedProjectId?: string | null;
  onSelectProject?: (project: ProjectInfo) => void;
  onClearSelection?: () => void;
  onDiscussProject?: (
    project: ProjectInfo,
    intent?: "understand" | "new",
  ) => void;
  onArtifact?: (taskId: string, artifactId: string) => void;
  overviewOnly?: boolean;
  hideHeading?: boolean;
  onShowFiles?: (project: ProjectInfo) => void;
}) {
  const [initializing, setInitializing] = useState(false);
  const [pending, setPending] = useState(false);
  const [localSelection, setLocalSelection] = useState<string | null>(null);
  const [fileProject, setFileProject] = useState<string | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [query, setQuery] = useState("");
  const projects = snapshot?.projects ?? [];
  const selectedId =
    selectedProjectId === undefined ? localSelection : selectedProjectId;
  const project = projects.find((item) => item.id === selectedId);
  const states = new Map(
    projects.map((item) => [
      item.id,
      snapshot ? deriveProjectStatus(item, snapshot) : undefined,
    ]),
  );
  const status = project ? states.get(project.id) : undefined;
  const matchingProjects = projects.filter((item) =>
    `${item.name} ${item.id}`.toLowerCase().includes(query.toLowerCase()),
  );
  const discovery = snapshot?.projectDiscovery;
  const monitoring = snapshot?.settings.projectMonitoring !== false;
  const scanning = pending || discovery?.status === "scanning";
  const select = (item: ProjectInfo) => {
    setLocalSelection(item.id);
    setFilesOpen(false);
    onSelectProject?.(item);
  };
  const back = () => {
    setLocalSelection(null);
    setFilesOpen(false);
    onClearSelection?.();
  };
  const files = (item: ProjectInfo) => {
    if (onShowFiles) onShowFiles(item);
    else {
      setFileProject(item.id);
      setFilesOpen(!filesOpen);
    }
  };
  const next = (item: ProjectInfo, value: ProjectStatus) => {
    if (
      value.next.kind === "artifact" &&
      value.next.taskId &&
      value.next.artifactId &&
      onArtifact
    )
      onArtifact(value.next.taskId, value.next.artifactId);
    else if (value.next.taskId) onTask?.(value.next.taskId);
    else onDiscussProject?.(item, "understand");
  };
  const refresh = async () => {
    if (pending) return;
    setPending(true);
    try {
      await dispatch({ type: "project.refresh" });
    } finally {
      setPending(false);
    }
  };
  const monitor = async () => {
    if (!snapshot || pending) return;
    setPending(true);
    try {
      await dispatch({
        type: "settings.save",
        settings: { ...snapshot.settings, projectMonitoring: !monitoring },
      });
    } finally {
      setPending(false);
    }
  };
  const issueCount =
    (discovery?.errors.length ?? 0) + (discovery?.truncated ? 1 : 0);
  return (
    <section
      className={`software-projects project-status-page ${overviewOnly ? "project-status-embedded" : ""}`}
      aria-label="软件项目"
    >
      {project && status ? (
        <>
          {!hideHeading ? (
            <header className="project-status-heading">
              {!overviewOnly ? (
                <button className="text-button" onClick={back}>
                  <ArrowLeft size={14} />
                  全部软件项目
                </button>
              ) : null}
              <div>
                <h1>{project.name}</h1>
                <span
                  className={`project-status-badge is-${status.state.kind}`}
                >
                  {status.state.label}
                </span>
              </div>
              <p>{status.state.basis}</p>
            </header>
          ) : null}
          <section className="project-state-overview" aria-label="项目状态概览">
            <div className="project-goal-line">
              <span className="project-state-label">
                {status.goal.scope === "work"
                  ? "本轮工作目标"
                  : status.goal.scope === "delivery"
                    ? "交付目标"
                    : "项目目标"}
              </span>
              <p>{status.goal.text}</p>
              <span
                className={`project-evidence source-${status.goal.evidence.kind}`}
              >
                {status.goal.evidence.label}
                {status.goal.evidence.at
                  ? ` · ${formatDate(status.goal.evidence.at)}`
                  : ""}
              </span>
            </div>
            <div className="project-current-state">
              <span className={`project-status-badge is-${status.state.kind}`}>
                <Activity size={12} />
                {status.state.label}
              </span>
              <span>{status.state.basis}</span>
            </div>
            <div className="project-next-work">
              <div>
                <span className="project-state-label">下一项实际工作</span>
                <strong>{status.next.label}</strong>
                <p>{status.next.reason}</p>
              </div>
              <button
                className="button primary small"
                onClick={() => next(project, status)}
              >
                {status.next.kind === "understand" ? "和团队理解" : "进入工作"}
                <ArrowRight size={14} />
              </button>
            </div>
          </section>
          <div className="project-state-actions">
            <button
              className="text-button"
              onClick={() => onDiscussProject?.(project, "new")}
            >
              <Plus size={13} />
              开始项目工作
            </button>
            <button
              className="text-button"
              onClick={() => onDiscussProject?.(project, "understand")}
            >
              重新理解状态
            </button>
            <button
              className="text-button"
              onClick={() => files(project)}
              aria-expanded={onShowFiles ? undefined : filesOpen}
            >
              <FolderOpen size={13} />
              {filesOpen && !onShowFiles ? "收起文件与状态" : "查看文件与状态"}
            </button>
          </div>
          {status.blockers.length ? (
            <section
              className="project-state-section project-blockers"
              aria-label="项目受阻事项"
            >
              <h2>
                <CircleAlert size={14} />
                需要处理 <span>{status.blockers.length}</span>
              </h2>
              {status.blockers.map((signal) => (
                <article key={signal.id}>
                  <strong>{signal.title}</strong>
                  <p>{signal.detail}</p>
                  <StateEvidence signal={signal} />
                  {status.tasks.some(
                    (task) => task.id === signal.evidence.taskId,
                  ) ? (
                    <button
                      className="text-button"
                      onClick={() =>
                        signal.evidence.artifactId && onArtifact
                          ? onArtifact(
                              signal.evidence.taskId!,
                              signal.evidence.artifactId,
                            )
                          : onTask?.(signal.evidence.taskId!)
                      }
                    >
                      查看依据
                      <ArrowRight size={12} />
                    </button>
                  ) : null}
                </article>
              ))}
            </section>
          ) : null}
          <section className="project-state-section" aria-label="项目当前工作">
            <h2>
              团队当前工作 <span>{status.tasks.length}</span>
            </h2>
            {status.tasks.length ? (
              <div className="project-work-rows">
                {status.tasks.map((task) => {
                  const event = task.events.findLast(
                    (item) =>
                      item.member &&
                      [
                        "agent_started",
                        "agent_completed",
                        "tool_started",
                        "tool_completed",
                        "agent_waiting",
                        "agent_failed",
                      ].includes(item.type),
                  );
                  return (
                    <button key={task.id} onClick={() => onTask?.(task.id)}>
                      <span>
                        <strong>{task.title}</strong>
                        <small>
                          {memberName(task.member, task.teamMode)} ·{" "}
                          {task.status === "completed"
                            ? "本轮运行结束"
                            : STATUS_NAMES[task.status]}
                          {event ? ` · ${event.summary}` : ""}
                        </small>
                      </span>
                      <span>
                        {task.artifacts.length} 份成果
                        <small>{formatDate(task.updatedAt)}</small>
                      </span>
                      <ArrowRight size={13} />
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="project-state-empty">
                尚未关联实际工作。可以让团队读取指定资料，先形成一版可修正的项目理解。
              </p>
            )}
          </section>
          <section className="project-state-section" aria-label="项目当前成果">
            <h2>
              工作成果 <span>{status.artifacts.length}</span>
            </h2>
            {status.artifacts.length ? (
              <div className="project-status-artifacts project-result-list">
                {status.artifacts.slice(0, 5).map(({ task, artifact }) => {
                  const registered = status.deliveries.find(
                    (record) =>
                      record.taskId === task.id &&
                      record.artifactId === artifact.id &&
                      record.artifactHash === artifact.hash,
                  );
                  return (
                    <button
                      key={`${task.id}:${artifact.id}`}
                      onClick={() =>
                        onArtifact
                          ? onArtifact(task.id, artifact.id)
                          : onTask?.(task.id)
                      }
                    >
                      <FileText size={16} />
                      <span>
                        <strong>{artifact.title}</strong>
                        <small>
                          v{artifact.version} ·{" "}
                          {registered
                            ? "有对应版本交付记录"
                            : "尚无对应版本交付登记"}{" "}
                          · {formatDate(artifact.updatedAt)}
                        </small>
                      </span>
                      <ArrowRight size={13} />
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="project-state-empty">
                尚无保存的工作成果。文件存在或 Git 有提交都不能代替交付结果。
              </p>
            )}
          </section>
          <section
            className="project-state-section"
            aria-label="项目已确认记录"
          >
            <h2>
              用户确认与实际结果 <span>{status.confirmed.length}</span>
            </h2>
            {status.confirmed.length ? (
              status.confirmed.map((signal) => (
                <article className="project-confirmed-fact" key={signal.id}>
                  <strong>{signal.title}</strong>
                  <p>{signal.detail}</p>
                  <StateEvidence signal={signal} />
                </article>
              ))
            ) : (
              <p className="project-state-empty">
                尚无用户确认的交付或使用证据。团队运行结束不代表项目完成。
              </p>
            )}
          </section>
          <section className="project-state-section" aria-label="项目变化依据">
            <div className="project-section-heading">
              <h2>文件观察与变化来源</h2>
              {status.changedFiles !== undefined ? (
                <span>
                  {status.changedFilesComplete ? "" : "至少 "}
                  {status.changedFiles} 个未提交改动文件
                </span>
              ) : null}
            </div>
            {status.observations.length ? (
              <details className="project-observation-details">
                <summary>
                  {status.observations[0]!.detail}
                  <span>{status.observations.length} 条观察</span>
                </summary>
                {status.observations.map((signal) => (
                  <article key={signal.id}>
                    <strong>{signal.title}</strong>
                    <p>{signal.detail}</p>
                    <StateEvidence signal={signal} />
                    {signal.evidence.path ? (
                      <code>{signal.evidence.path}</code>
                    ) : null}
                  </article>
                ))}
              </details>
            ) : (
              <p className="project-state-empty">尚无文件观察记录。</p>
            )}
          </section>
          <details className="project-unknowns">
            <summary>尚未确认的范围</summary>
            {status.unknowns.map((item) => (
              <p key={item}>{item}</p>
            ))}
          </details>
          {fileProject === project.id && snapshot && !onShowFiles ? (
            <div className="project-file-inspector" hidden={!filesOpen}>
              <ProjectExplorer
                snapshot={{ ...snapshot, projects: [project] }}
                dispatch={dispatch}
                selectedProjectId={project.id}
                onDiscussProject={onDiscussProject}
              />
            </div>
          ) : null}
        </>
      ) : overviewOnly ? (
        <p className="project-state-empty">选择一个项目查看状态与依据。</p>
      ) : (
        <>
          <header className="project-status-index-heading">
            <div>
              <h1>项目状态</h1>
              <p>对照当前目标、真实进展和下一项工作。</p>
            </div>
            <div className="project-heading-actions">
              <button
                className="button secondary small"
                disabled={pending || !snapshot}
                onClick={() => {
                  setPending(true);
                  void dispatch({ type: "project.import" }).finally(() =>
                    setPending(false),
                  );
                }}
              >
                导入已有项目
              </button>
              <button
                className="button primary small"
                onClick={() => {
                  setInitializing(true);
                  if (!snapshot) onInitialize?.();
                }}
              >
                <Plus size={13} />
                新建项目
              </button>
            </div>
          </header>
          {discovery?.status === "failed" ? (
            <div className="project-scan-error" role="alert">
              <span>{discovery.errors[0] || "暂时未能读取本机项目状态。"}</span>
              <button
                className="text-button"
                disabled={scanning}
                onClick={() => void refresh()}
              >
                重新读取
              </button>
            </div>
          ) : null}
          {!snapshot ? (
            <div className="project-state-loading" role="status">
              正在读取项目与工作状态…
            </div>
          ) : projects.length ? (
            <>
              <div className="project-state-index-summary">
                <span>{projects.length} 个项目</span>
                <span>
                  {
                    [...states.values()].filter(
                      (value) => value?.state.kind === "running",
                    ).length
                  }{" "}
                  个团队正在推进
                </span>
                <span>
                  {
                    [...states.values()].filter(
                      (value) => value?.state.kind === "blocked",
                    ).length
                  }{" "}
                  个需要处理
                </span>
                <label>
                  <Search size={13} />
                  <input
                    aria-label="查找软件项目"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="查找项目"
                  />
                </label>
              </div>
              <div className="project-status-table-scroll">
                <table className="project-status-table">
                  <thead>
                    <tr>
                      <th>项目 / 当前目标</th>
                      <th>当前状态</th>
                      <th>下一项工作</th>
                      <th>变化依据</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!matchingProjects.length ? (
                      <tr>
                        <td colSpan={4} className="project-filter-empty">
                          没有匹配的项目。
                          <button
                            className="text-button"
                            onClick={() => setQuery("")}
                          >
                            清除筛选
                          </button>
                        </td>
                      </tr>
                    ) : null}
                    {matchingProjects.map((item) => {
                      const value = states.get(item.id)!;
                      return (
                        <tr
                          key={item.id}
                          onClick={(event) => {
                            if (
                              !(event.target as HTMLElement).closest(
                                "button, a, input",
                              )
                            )
                              select(item);
                          }}
                        >
                          <td>
                            <button
                              className="project-state-open"
                              aria-label={`打开项目 ${item.name}`}
                              onClick={() => select(item)}
                            >
                              <strong>{item.name}</strong>
                              <ArrowRight size={13} />
                            </button>
                            <p
                              className="project-row-goal"
                              title={value.goal.text}
                            >
                              {value.goal.text}
                            </p>
                            <small>
                              {value.goal.scope === "unknown"
                                ? "目标未知"
                                : value.goal.scope === "work"
                                  ? "依据：本轮工作目标"
                                  : "依据：用户登记的交付目标"}
                            </small>
                          </td>
                          <td>
                            <span
                              className={`project-status-badge is-${value.state.kind}`}
                            >
                              {value.state.label}
                            </span>
                            <small className="project-row-basis">
                              {value.blockers[0]?.title ??
                                `${value.tasks.length} 项工作 · ${value.artifacts.length} 份成果`}
                            </small>
                          </td>
                          <td>
                            <button
                              className="text-button project-row-next"
                              onClick={() => next(item, value)}
                            >
                              {value.next.label}
                              <ArrowRight size={12} />
                            </button>
                            <small>
                              {value.next.kind === "understand"
                                ? "尚无可继续的工作记录"
                                : value.next.reason}
                            </small>
                          </td>
                          <td>
                            <span>
                              {value.changedFiles === undefined
                                ? "改动范围未知"
                                : `${value.changedFilesComplete ? "" : "至少 "}${value.changedFiles} 个文件改动`}
                            </span>
                            <small>
                              {item.observation
                                ? `目录观察 · ${formatDate(item.observation.checkedAt)}`
                                : "尚未取得目录观察"}
                            </small>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div className="project-state-empty project-empty-index">
              <FolderOpen size={26} />
              <h2>先关联一个项目</h2>
              <p>
                导入已有目录，或从目标建立项目。团队会基于实际工作和材料整理状态。
              </p>
            </div>
          )}
          <details className="project-discovery-controls">
            <summary>
              {scanning
                ? "正在读取项目状态"
                : `本机项目来源 · ${projects.length} 个项目`}
              {issueCount ? ` · ${issueCount} 项提醒` : ""}
            </summary>
            <div>
              <span>
                {monitoring ? "本机监控已开启" : "监控已暂停"} ·{" "}
                {clock(discovery?.checkedAt)}
              </span>
              <button
                className="text-button"
                disabled={scanning || !snapshot}
                onClick={() => void refresh()}
              >
                <RefreshCw size={13} />
                刷新状态
              </button>
              <button
                className="text-button"
                disabled={scanning || !snapshot}
                onClick={() => void monitor()}
              >
                {monitoring ? <Pause size={13} /> : <Play size={13} />}{" "}
                {monitoring ? "暂停监控" : "开启监控"}
              </button>
            </div>
            {discovery?.errors.map((message, index) => (
              <p key={index}>{message}</p>
            ))}
            {discovery?.truncated ? (
              <p>本轮达到扫描上限，当前结果不代表全部目录。</p>
            ) : null}
          </details>
        </>
      )}
      {initializing && snapshot ? (
        <Modal
          title="新建软件项目"
          description="从目标准备项目规则、资料和开发目录。"
          wide
          onClose={() => setInitializing(false)}
        >
          <Initialization
            snapshot={snapshot}
            dispatch={dispatch}
            onTask={onTask}
          />
        </Modal>
      ) : null}
    </section>
  );
}
