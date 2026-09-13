import { useState, type ReactNode } from "react";
import {
  ArrowRight,
  FileText,
  Folder,
  Clock3,
  CircleAlert,
  Search,
} from "lucide-react";
import type { Snapshot, ProjectInfo } from "../shared/types";
import { STATUS_NAMES, formatDate } from "./common";

export function WorkbenchHome({
  snapshot,
  children,
  onTask,
  onPage,
  onProject,
  onMedia,
}: {
  snapshot: Snapshot | null;
  children: ReactNode;
  onTask: (id: string) => void;
  onPage: (
    page:
      | "attention"
      | "deliveries"
      | "routines"
      | "projects"
      | "radar"
      | "library",
  ) => void;
  onProject: (project: ProjectInfo) => void;
  onMedia?: (channelId: string, workId: string) => void;
}) {
  const [all, setAll] = useState(false);
  const [query, setQuery] = useState("");
  const tasks = (snapshot?.tasks ?? [])
    .filter(
      (task) =>
        !task.archivedAt && !task.deletedAt && task.surface !== "background",
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const matching = tasks.filter((task) =>
    `${task.title} ${task.goal}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()),
  );
  const attention =
    snapshot?.attention?.items.filter((item) => item.state === "open") ?? [];
  return (
    <div className="workbench-home">
      <section className="home-start" aria-labelledby="home-start-title">
        <h2 id="home-start-title">今天，推进什么？</h2>
        <p>提出目标，带上资料，与团队一起完成。</p>
        {children}
      </section>
      <nav className="home-support" aria-label="工作支持">
        <button onClick={() => onPage("attention")}>
          <CircleAlert size={16} />
          待我处理
          {attention.length > 0 ? <span>{attention.length}</span> : null}
        </button>
        <button onClick={() => onPage("deliveries")}>
          <FileText size={16} />
          交付与反馈
        </button>
        <button onClick={() => onPage("routines")}>
          <Clock3 size={16} />
          例行工作
        </button>
      </nav>
      {attention.length ? (
        <section className="home-attention" aria-label="需要关注">
          {attention.slice(0, 2).map((item) => (
            <button
              key={item.id}
              onClick={() => {
                const id = item.origin.workTaskId ?? item.origin.taskId;
                if (id) onTask(id);
                else onPage("attention");
              }}
            >
              <span className="home-attention-reason">
                {
                  {
                    waiting: "等你判断",
                    failed: "需要处理",
                    result: "有新成果",
                    revision: "待修订",
                    feedback: "有新反馈",
                    check: "检查完成",
                  }[item.reason]
                }
              </span>
              <span>{item.title}</span>
              <ArrowRight size={15} />
            </button>
          ))}
        </section>
      ) : null}
      <section className="home-recent" aria-labelledby="home-recent-title">
        <header>
          <h2 id="home-recent-title">继续工作</h2>
          {tasks.length > 5 ? (
            <button className="text-button" onClick={() => setAll(!all)}>
              {all ? "收起" : `全部工作 · ${tasks.length}`}
              <ArrowRight size={14} />
            </button>
          ) : null}
        </header>
        {all ? (
          <label className="home-search">
            <Search size={16} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="搜索已有工作"
              placeholder="搜索工作"
            />
          </label>
        ) : null}
        <div className="home-work-list">
          {(all ? matching : tasks.slice(0, 5)).map((task) => {
            const project = snapshot?.projects.find(
              (item) => item.id === task.projectId,
            );
            const latest = task.artifacts.at(-1);
            return (
              <button
                className="home-work-row"
                key={task.id}
                onClick={() => onTask(task.id)}
              >
                <span className={`home-state-dot status-${task.status}`} />
                <span className="home-work-main">
                  <strong>{task.title}</strong>
                  <small>
                    {project?.name ??
                      (task.teamMode === "media" ? "媒体创作" : "个人工作")}
                    {latest ? ` · ${latest.title}` : ""}
                  </small>
                </span>
                <span className="home-work-status">
                  {STATUS_NAMES[task.status]}
                </span>
                <time>{formatDate(task.updatedAt)}</time>
                <ArrowRight size={16} />
              </button>
            );
          })}
        </div>
        {!tasks.length ? (
          <div className="home-first-work">
            <p>从一个目标开始，工作与成果会保留在这里。</p>
            <button className="text-button" onClick={() => onPage("projects")}>
              <Folder size={15} />
              也可以先创建或导入项目
              <ArrowRight size={14} />
            </button>
          </div>
        ) : all && !matching.length ? (
          <p className="home-first-work">没有匹配的工作。</p>
        ) : null}
      </section>
      {snapshot &&
      (snapshot.projects.length > 0 ||
        (snapshot.media?.channels.length ?? 0) > 0) ? (
        <section className="home-projects">
          <header>
            <h2>我的项目</h2>
            <button className="text-button" onClick={() => onPage("projects")}>
              查看项目
              <ArrowRight size={14} />
            </button>
          </header>
          <div>
            {snapshot.projects.slice(0, 3).map((project) => (
              <button key={project.id} onClick={() => onProject(project)}>
                <Folder size={17} />
                <span>{project.name}</span>
                <ArrowRight size={14} />
              </button>
            ))}
            {snapshot.media?.channels.slice(0, 3).map((channel) => (
              <button
                key={channel.id}
                onClick={() => onMedia?.(channel.id, "")}
              >
                <FileText size={17} />
                <span>{channel.name}</span>
                <ArrowRight size={14} />
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
