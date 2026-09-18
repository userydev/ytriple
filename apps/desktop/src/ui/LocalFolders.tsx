import { useState, Suspense, lazy } from "react";
import { FolderOpen, RefreshCw, Link } from "lucide-react";
import type { Snapshot, Project } from "../core/types";
import type { Command } from "../core/commands";
import { command } from "./api";
import { IconButton } from "./Composer";
const LocalSystemSetup = lazy(() =>
  import("./LocalSystemSetup").then((m) => ({ default: m.LocalSystemSetup })),
);
type Props = { data: Snapshot; onError: (error: unknown) => void };
function useAction(onError: Props["onError"]) {
  const [busy, setBusy] = useState(false);
  const act = async (input: Command) => {
    if (busy) return;
    setBusy(true);
    try {
      await command(input);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  return { busy, act };
}
export function LocalFolderSettings({ data, onError }: Props) {
  const { busy, act } = useAction(onError);
  return (
    <div className="settings-page local-folders">
      <section className="settings-section">
        <div className="settings-section-header">
          <div>
            <h2>本地目录</h2>
            <p>指定项目与 AI 资产所在的位置。</p>
          </div>
          <button
            className="quiet"
            disabled={busy}
            onClick={() => void act({ type: "refresh-local-directories" })}
          >
            <RefreshCw size={17} />
            刷新状态
          </button>
        </div>
        {(["code", "ai"] as const).map((kind) => {
          const path =
            kind === "ai" ? data.localRoots.aiPath : data.localRoots.codePath;
          const status = data.localInventory?.roots.find(
            (r) => r.kind === kind,
          );
          return (
            <div className="setting-row" key={kind}>
              <div className="setting-copy">
                <strong>{kind === "ai" ? "AI 目录" : "Code 目录"}</strong>
                <small>
                  {kind === "ai"
                    ? "工作流、知识库与可复用成果"
                    : "本地项目与代码"}
                </small>
              </div>
              <div className="setting-value">
                <span
                  className={`status-badge ${status?.available ? "success" : ""}`}
                >
                  {status?.available ? "可用" : path ? "不可用" : "未设置"}
                </span>
                <span className="local-path">{path ?? "尚未选择目录"}</span>
              </div>
              <div className="settings-actions">
                <button
                  className="quiet"
                  disabled={busy}
                  onClick={() => void act({ type: "choose-local-root", kind })}
                >
                  {path ? "更换目录" : "选择目录"}
                </button>
                <button
                  className="quiet"
                  disabled={busy || !status?.available}
                  onClick={() => void act({ type: "reveal-local-root", kind })}
                >
                  <FolderOpen size={16} />在 Finder 打开
                </button>
              </div>
            </div>
          );
        })}
        {data.localInventory?.notes.length ? (
          <details>
            <summary>目录检查说明</summary>
            {data.localInventory.notes.map((note, i) => (
              <p key={i}>{note}</p>
            ))}
          </details>
        ) : null}
        <p className="settings-note">
          沿用已有文件夹。关联目录不会移动文件或自动发送内容给 AI。
        </p>
      </section>
      <Suspense fallback={null}>
        <LocalSystemSetup data={data} />
      </Suspense>
    </div>
  );
}
export function ProjectFolder({
  data,
  project,
  onError,
}: Props & { project: Project }) {
  const { busy, act } = useAction(onError);
  const root = data.localRoots.codePath;
  const within = !!(root && project.directory?.startsWith(root + "/"));
  return (
    <div className="local-folder-row">
      <div>
        <span className="local-path">
          {project.directory ?? "尚未关联本地项目目录"}
        </span>
        {project.directory && !within ? (
          <p className="muted">此路径不在当前 Code 目录内，请重新关联。</p>
        ) : null}
      </div>
      <IconButton
        label={project.directory ? "更换项目目录" : "关联项目目录"}
        disabled={busy || !root}
        onClick={() =>
          void act({ type: "choose-project-directory", projectId: project.id })
        }
      >
        <Link size={17} />
      </IconButton>
      {project.directory ? (
        <IconButton
          label="在 Finder 打开项目"
          disabled={busy || !within}
          onClick={() =>
            void act({
              type: "reveal-project-directory",
              projectId: project.id,
            })
          }
        >
          <FolderOpen size={17} />
        </IconButton>
      ) : null}
    </div>
  );
}
export function LocalProjects({ data, onError }: Props) {
  const { busy, act } = useAction(onError);
  const candidates =
    data.localInventory?.projects.filter(
      (p) => !data.projects.some((existing) => existing.directory === p.path),
    ) ?? [];
  return (
    <section className="local-projects">
      <button
        className="quiet"
        disabled={busy || !data.localRoots.codePath}
        onClick={() => void act({ type: "choose-project-directory" })}
      >
        <FolderOpen size={17} />
        关联本地项目
      </button>
      {!data.localRoots.codePath ? (
        <p className="muted">先在设置中选择 Code 目录。</p>
      ) : null}
      {candidates.length ? (
        <details>
          <summary>Code 中的项目 · {candidates.length}</summary>
          {candidates.map((p) => (
            <div className="local-folder-row" key={p.path}>
              <div>
                <strong>{p.name}</strong>
                <p className="local-path">{p.path}</p>
              </div>
              <IconButton
                label={`关联 ${p.name}`}
                disabled={busy}
                onClick={() =>
                  void act({ type: "import-local-project", path: p.path })
                }
              >
                <Link size={17} />
              </IconButton>
            </div>
          ))}
        </details>
      ) : null}
    </section>
  );
}
export function LocalAssets({ data, onError }: Props) {
  const { busy, act } = useAction(onError);
  return (
    <section className="local-assets">
      <div className="section-heading">
        <h2>AI 目录</h2>
        <IconButton
          label="在 Finder 打开 AI 资产"
          disabled={
            busy ||
            !data.localInventory?.roots.find((r) => r.kind === "ai")?.available
          }
          onClick={() => void act({ type: "reveal-local-root", kind: "ai" })}
        >
          <FolderOpen size={18} />
        </IconButton>
      </div>
      <p className="local-path">
        {data.localRoots.aiPath ?? "在设置中选择已有的 AI 目录"}
      </p>
      {data.localInventory?.assets.map((a) => (
        <div className="local-folder-row" key={a.path}>
          <div>
            <strong>{a.title}</strong>
            <p className="local-path">{a.path}</p>
            <small>
              {a.kind === "skill" ? "Skill" : a.kind}
              {a.available ? "" : " · 文件不可用"}
            </small>
          </div>
          <IconButton
            label={`在 Finder 显示 ${a.title}`}
            disabled={busy || !a.available}
            onClick={() =>
              void act({ type: "reveal-local-asset", path: a.path })
            }
          >
            <FolderOpen size={17} />
          </IconButton>
        </div>
      ))}
      <p className="muted">
        显示已有索引中的资产；工作流执行和知识检索需分别接入。
      </p>
      <h2>工作中收藏的材料</h2>
    </section>
  );
}
