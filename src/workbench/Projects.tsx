import { useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  ChevronDown,
  FileText,
  Folder,
  GitBranch,
  MessageSquare,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Sprout,
} from "lucide-react";
import type { ProjectInfo, ProjectInput, Snapshot } from "../shared/types";
import { type Dispatch } from "./common";

const DOC_NAMES: Record<string, string> = {
  entry: "项目入口",
  product: "产品文档",
  research: "调研",
  rules: "项目规则",
  external_ai_writeback: "文档目录",
};
const STATE_NAMES = {
  ready: "已检查",
  attention: "待留意",
  missing: "目录缺失",
  error: "检查失败",
};
const clock = (value?: string) =>
  value
    ? new Date(value).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "尚未读取";

function ProjectCard({
  project,
  dispatch,
}: {
  project: ProjectInfo;
  dispatch: Dispatch;
}) {
  const [expanded, setExpanded] = useState(false);
  const observation = project.observation;
  const changed =
    observation?.worktrees.reduce(
      (sum, item) => sum + (item.changedFiles ?? 0),
      0,
    ) ?? 0;
  return (
    <article className="local-project-card">
      <div className="local-project-top">
        <div className="local-project-symbol">
          <Folder size={21} strokeWidth={1.5} />
        </div>
        <button
          className="local-project-title"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <span>
            <strong>{project.name}</strong>
            <span className="series-label">{project.series}</span>
            <span
              className={`project-registration ${project.registered ? "registered" : "discovered"}`}
            >
              {project.registered ? "已登记" : "本地发现"}
            </span>
          </span>
          <code>{project.root}</code>
        </button>
        <button
          className="icon-button"
          aria-label={`打开 ${project.name} 开发目录`}
          disabled={
            observation?.state === "missing" || observation?.state === "error"
          }
          onClick={() =>
            void dispatch({ type: "path.reveal", path: project.devPath })
          }
        >
          <ArrowUpRight size={17} />
        </button>
      </div>
      <div className="local-project-summary">
        <span className={`project-health ${observation?.state ?? "unknown"}`}>
          {observation ? STATE_NAMES[observation.state] : "尚未观察"}
        </span>
        <span>
          <GitBranch size={12} />
          {observation?.worktrees.length ?? 0} 个工作目录
        </span>
        <span>
          {!observation?.worktrees.length ||
          observation.worktrees.some((worktree) => worktree.state !== "ready")
            ? "Git 状态尚未完整读取"
            : changed
              ? `${changed} 项未提交变更`
              : "暂无未提交变更"}
        </span>
        <button
          className="text-button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          {expanded ? "收起" : "查看状态"}
          <ChevronDown size={13} className={expanded ? "rotate" : ""} />
        </button>
      </div>
      {expanded ? (
        <div className="local-project-details">
          {observation?.issues.length ? (
            <div className="project-issues">
              {observation.issues.map((item, index) => (
                <p key={`${index}:${item}`}>{item}</p>
              ))}
            </div>
          ) : null}
          {observation?.worktrees.length ? (
            <div className="project-worktrees">
              {observation.worktrees.map((worktree) => (
                <div key={worktree.path}>
                  <div>
                    <GitBranch size={13} />
                    <strong>
                      {worktree.branch ?? worktree.expectedBranch ?? "分支未知"}
                    </strong>
                    <span>
                      {worktree.head && worktree.head !== "(initial)"
                        ? worktree.head.slice(0, 8)
                        : ""}
                    </span>
                  </div>
                  <code>{worktree.path}</code>
                  <small>
                    {worktree.state === "ready"
                      ? `${worktree.changedFiles ?? 0} 项变更${worktree.expectedBranch && worktree.branch !== worktree.expectedBranch ? ` · 登记分支 ${worktree.expectedBranch}` : ""}`
                      : worktree.error}
                  </small>
                </div>
              ))}
            </div>
          ) : null}
          <div className="project-doc-observations">
            {observation?.documents.map((document) => (
              <div key={`${document.name}:${document.path}`}>
                <FileText size={13} />
                <span>{DOC_NAMES[document.name] ?? document.name}</span>
                {document.state === "present" ? (
                  <button
                    className="text-button"
                    onClick={() =>
                      void dispatch({
                        type: "path.reveal",
                        path: document.path,
                      })
                    }
                  >
                    查看
                    <ArrowUpRight size={12} />
                  </button>
                ) : (
                  <small>
                    {document.state === "missing" ? "未找到" : "不可读取"}
                  </small>
                )}
              </div>
            ))}
          </div>
          <p className="project-observed-at">
            本地观察于 {clock(observation?.checkedAt)} · Git
            与文档信息只在刷新时更新
          </p>
        </div>
      ) : null}
    </article>
  );
}

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

export function Projects({
  snapshot,
  dispatch,
  onInitialize,
  onTask,
}: {
  snapshot: Snapshot | null;
  dispatch: Dispatch;
  onInitialize?: () => void;
  onTask?: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "registered" | "discovered">(
    "all",
  );
  const [initializing, setInitializing] = useState(false);
  const [pending, setPending] = useState(false);
  const projects = snapshot?.projects ?? [],
    discovery = snapshot?.projectDiscovery;
  const monitoring = snapshot?.settings.projectMonitoring !== false;
  const scanning = pending || discovery?.status === "scanning";
  const visible = projects.filter(
    (project) =>
      `${project.name} ${project.root}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (filter === "all" ||
        Boolean(project.registered) === (filter === "registered")),
  );
  const refresh = async () => {
    setPending(true);
    try {
      await dispatch({ type: "project.refresh" });
    } finally {
      setPending(false);
    }
  };
  const monitor = async () => {
    if (!snapshot) return;
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
  return (
    <div className="collection-page local-projects-page">
      <div className="page-heading">
        <span className="eyebrow">LOCAL PROJECTS</span>
        <div className="heading-with-action">
          <h1>本机项目，一处掌握</h1>
          <button
            className="button primary"
            onClick={() => {
              setInitializing((value) => !value);
              if (!snapshot) onInitialize?.();
            }}
          >
            <Plus size={15} />
            {initializing ? "收起初始化" : "新项目"}
          </button>
        </div>
        <p>读取 Code 下的本地项目，结合中央登记，持续留意开发状态。</p>
      </div>
      <section className="project-monitor-bar">
        <div>
          <span
            className={`project-monitor-light ${monitoring ? "enabled" : ""}`}
          />
          <strong>{monitoring ? "前台监控已开启" : "前台监控已暂停"}</strong>
          <small>
            {scanning
              ? "正在检查本地状态…"
              : `上次读取 ${clock(discovery?.checkedAt)}`}
          </small>
        </div>
        <div>
          <button
            className="button secondary small"
            disabled={scanning || !snapshot}
            onClick={() => void monitor()}
          >
            {monitoring ? <Pause size={13} /> : <Play size={13} />}
            {monitoring ? "暂停" : "开启监控"}
          </button>
          <button
            className="button secondary small"
            disabled={scanning || !snapshot}
            onClick={() => void refresh()}
          >
            <RefreshCw size={13} />
            刷新
          </button>
        </div>
        <code>{snapshot?.settings.codeRoot ?? "正在读取目录"}</code>
      </section>
      {discovery &&
      (discovery.errors.length ||
        discovery.truncated ||
        discovery.status === "partial") ? (
        <div className="project-scan-errors" role="status">
          <strong>
            {discovery.status === "failed"
              ? "这次读取未完成"
              : "部分目录需要留意"}
          </strong>
          {discovery.errors.map((error, index) => (
            <p key={`${index}:${error}`}>{error}</p>
          ))}
          {discovery.truncated ? (
            <p>本轮达到目录、文件或时间上限；当前结果不代表全部扫描完毕。</p>
          ) : null}
          {!discovery.errors.length && !discovery.truncated ? (
            <p>部分项目的 Git 或文档状态不可读取，可展开项目查看详情。</p>
          ) : null}
        </div>
      ) : null}
      {discovery?.changes.length ? (
        <details className="project-changes">
          <summary>最近一次刷新有 {discovery.changes.length} 项变化</summary>
          {discovery.changes.map((change) => (
            <p key={`${change.kind}:${change.projectId}`}>{change.summary}</p>
          ))}
        </details>
      ) : null}
      {initializing && snapshot ? (
        <Initialization
          snapshot={snapshot}
          dispatch={dispatch}
          onTask={onTask}
        />
      ) : null}
      <div className="project-toolbar">
        <label className="project-search">
          <Search size={15} />
          <input
            aria-label="搜索本机项目"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索项目或路径"
          />
        </label>
        <div className="project-filter-tabs">
          {(
            [
              ["all", "全部"],
              ["registered", "已登记"],
              ["discovered", "本地发现"],
            ] as const
          ).map(([value, label]) => (
            <button
              className={filter === value ? "active" : ""}
              aria-pressed={filter === value}
              key={value}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <span>{visible.length} 个项目</span>
      </div>
      {visible.length ? (
        <div className="local-project-list">
          {visible.map((project) => (
            <ProjectCard
              key={`${project.id}:${project.root}`}
              project={project}
              dispatch={dispatch}
            />
          ))}
        </div>
      ) : (
        <div className="collection-empty">
          <Folder size={36} strokeWidth={1.2} />
          <h2>
            {query
              ? "没有找到匹配的项目"
              : scanning
                ? "正在读取本机项目"
                : "当前目录还没有发现项目"}
          </h2>
          <p>
            {query
              ? "换一个名称或路径关键词。"
              : "可以刷新 Code 目录，或从上方开始初始化项目。"}
          </p>
        </div>
      )}
      {onTask && snapshot?.tasks.some((task) => task.kind === "project") ? (
        <section className="related-work">
          <h3>项目讨论</h3>
          {snapshot.tasks
            .filter((task) => task.kind === "project")
            .map((task) => (
              <button
                className="related-task"
                key={task.id}
                onClick={() => onTask(task.id)}
              >
                <MessageSquare size={15} />
                <span>{task.title}</span>
                <small>
                  {
                    {
                      idle: "待开始",
                      running: "处理中",
                      waiting: "等待输入",
                      paused: "已暂停",
                      failed: "需处理",
                      completed: "已完成",
                    }[task.status]
                  }
                </small>
                <ArrowUpRight size={14} />
              </button>
            ))}
        </section>
      ) : null}
    </div>
  );
}
