import { useState } from "react";
import {
  ArrowRight,
  MessageSquare,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Sprout,
} from "lucide-react";
import type { ProjectInfo, ProjectInput, Snapshot } from "../shared/types";
import { Modal, type Dispatch } from "./common";
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

export function Projects({
  snapshot,
  dispatch,
  onInitialize,
  onTask,
  selectedProjectId,
  onSelectProject,
  onDiscussProject,
}: {
  snapshot: Snapshot | null;
  dispatch: Dispatch;
  onInitialize?: () => void;
  onTask?: (id: string) => void;
  selectedProjectId?: string | null;
  onSelectProject?: (project: ProjectInfo) => void;
  onDiscussProject?: (project: ProjectInfo) => void;
}) {
  const [initializing, setInitializing] = useState(false);
  const [pending, setPending] = useState(false);
  const discovery = snapshot?.projectDiscovery;
  const monitoring = snapshot?.settings.projectMonitoring !== false;
  const scanning = pending || discovery?.status === "scanning";
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
  const issueCount =
    (discovery?.errors.length ?? 0) + (discovery?.truncated ? 1 : 0);
  return (
    <div className="local-projects-page project-ide-page">
      <header className="project-ide-heading">
        <div>
          <h1>本机项目</h1>
          <span>{snapshot?.projects.length ?? 0} 个项目</span>
        </div>
        <button
          className="button secondary small"
          onClick={() => {
            setInitializing(true);
            if (!snapshot) onInitialize?.();
          }}
        >
          <Plus size={14} />
          新建项目
        </button>
      </header>
      <section className="project-monitor-bar" aria-label="项目监控">
        <div>
          <span
            className={`project-monitor-light ${monitoring ? "enabled" : ""}`}
          />
          <strong>{monitoring ? "前台监控" : "监控已暂停"}</strong>
          <small>{scanning ? "读取中…" : clock(discovery?.checkedAt)}</small>
        </div>
        <button
          className="text-button"
          disabled={scanning || !snapshot}
          onClick={() => void monitor()}
          title={monitoring ? "暂停前台监控" : "开启前台监控"}
        >
          {monitoring ? <Pause size={12} /> : <Play size={12} />}
          {monitoring ? "暂停" : "开启"}
        </button>
        <button
          className="text-button"
          disabled={scanning || !snapshot}
          onClick={() => void refresh()}
        >
          <RefreshCw size={12} />
          刷新状态
        </button>
        {issueCount || discovery?.status === "partial" ? (
          <details className="project-monitor-detail">
            <summary>扫描提醒{issueCount ? ` · ${issueCount}` : ""}</summary>
            {discovery?.errors.map((message, index) => (
              <p key={index}>{message}</p>
            ))}
            {discovery?.truncated ? (
              <p>本轮达到扫描上限，当前结果不代表全部目录。</p>
            ) : null}
            {!issueCount ? (
              <p>部分项目状态尚未完整读取，在项目概览查看详情。</p>
            ) : null}
          </details>
        ) : null}
      </section>
      <ProjectExplorer
        snapshot={snapshot}
        dispatch={dispatch}
        selectedProjectId={selectedProjectId}
        onSelectProject={onSelectProject}
        onDiscussProject={onDiscussProject}
      />
      {initializing && snapshot ? (
        <Modal
          title="新建项目"
          description="创建新的规则、文档与开发目录。已有项目可直接在文件树中打开。"
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
    </div>
  );
}
