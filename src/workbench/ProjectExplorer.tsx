import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  File,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  MessageSquare,
  RefreshCw,
  Search,
} from "lucide-react";
import type { ProjectInfo, Snapshot } from "../shared/types";
import type {
  ProjectBrowserState,
  ProjectFileEntry,
  ProjectFilePreview,
} from "../shared/project-files";
import { projectDocumentLink } from "../shared/project-files";
import { Markdown, type Dispatch } from "./common";

type DirectoryState = Pick<
  ProjectBrowserState,
  "entries" | "error" | "truncated"
>;
const keyFor = (project: string, worktree: string, directory: string) =>
  JSON.stringify([project, worktree, directory]);
const treeWidths = { min: 160, max: 440, initial: 220 };
const clamp = (width: number) =>
  Math.max(treeWidths.min, Math.min(treeWidths.max, width));
const filename = (file: string) =>
  file.split("/").filter(Boolean).at(-1) ?? file;

function FileTree({
  directory,
  depth,
  cache,
  expanded,
  loading,
  selectedPath,
  projectId,
  worktreePath,
  onDirectory,
  onFile,
}: {
  directory: string;
  depth: number;
  cache: Record<string, DirectoryState>;
  expanded: Set<string>;
  loading: Set<string>;
  selectedPath?: string;
  projectId: string;
  worktreePath: string;
  onDirectory: (entry: ProjectFileEntry) => void;
  onFile: (entry: ProjectFileEntry) => void;
}) {
  const key = keyFor(projectId, worktreePath, directory),
    state = cache[key];
  if (loading.has(key) && !state)
    return (
      <p className="project-tree-note" role="status">
        读取目录中…
      </p>
    );
  if (!state) return null;
  return (
    <div className="project-file-branch" role="group">
      {state.error ? (
        <p className="project-tree-note error" role="status">
          {state.error}
        </p>
      ) : null}
      {!state.error && !state.entries.length ? (
        <p className="project-tree-note">没有可预览的文件</p>
      ) : null}
      {state.entries.map((entry) => {
        const entryKey = keyFor(projectId, worktreePath, entry.path),
          open = expanded.has(entryKey);
        return (
          <div key={entry.path}>
            <button
              className={`project-tree-file ${selectedPath === entry.path && entry.kind === "file" ? "selected" : ""}`}
              style={{ paddingLeft: 12 + depth * 14 }}
              aria-label={`${entry.kind === "directory" ? "目录" : "预览文件"} ${entry.path}`}
              aria-expanded={entry.kind === "directory" ? open : undefined}
              aria-pressed={
                entry.kind === "file" ? selectedPath === entry.path : undefined
              }
              title={entry.path}
              onClick={() =>
                entry.kind === "directory" ? onDirectory(entry) : onFile(entry)
              }
            >
              {entry.kind === "directory" ? (
                <>
                  {open ? (
                    <ChevronDown size={12} />
                  ) : (
                    <ChevronRight size={12} />
                  )}
                  {open ? <FolderOpen size={14} /> : <Folder size={14} />}
                </>
              ) : (
                <>
                  <span className="project-tree-indent" />
                  <FileText size={14} />
                </>
              )}
              <span>{entry.name}</span>
            </button>
            {entry.kind === "directory" && open ? (
              <FileTree
                {...{
                  cache,
                  expanded,
                  loading,
                  selectedPath,
                  projectId,
                  worktreePath,
                  onDirectory,
                  onFile,
                }}
                directory={entry.path}
                depth={depth + 1}
              />
            ) : null}
          </div>
        );
      })}
      {state.truncated ? (
        <p className="project-tree-note">
          目录条目较多，仅展示本次读取的前 400 项。
        </p>
      ) : null}
    </div>
  );
}

function ProjectOverview({
  project,
  dispatch,
  onDiscuss,
  onPreview,
}: {
  project: ProjectInfo;
  dispatch: Dispatch;
  onDiscuss?: (project: ProjectInfo) => void;
  onPreview: (file: string, worktree: string) => void;
}) {
  const observation = project.observation;
  const worktrees = observation?.worktrees ?? [];
  const changed = worktrees.reduce(
    (total, item) => total + (item.changedFiles ?? 0),
    0,
  );
  const documents = observation?.documents ?? [];
  return (
    <div className="project-file-overview">
      <span className="eyebrow">项目概览</span>
      <h2>{project.name}</h2>
      <p className="project-overview-path">{project.root}</p>
      <div className="project-overview-actions">
        {onDiscuss ? (
          <button
            className="button primary small"
            onClick={() => onDiscuss(project)}
          >
            <MessageSquare size={14} />
            讨论项目
          </button>
        ) : null}
        <button
          className="button secondary small"
          disabled={
            observation?.state === "missing" || observation?.state === "error"
          }
          onClick={() =>
            void dispatch({ type: "path.reveal", path: project.devPath })
          }
        >
          <Folder size={14} />
          在本地打开
        </button>
      </div>
      <div className="project-overview-stats">
        <span>{project.registered ? "已登记" : "本地发现"}</span>
        <span>{worktrees.length} 个工作目录</span>
        <span>{changed} 项未提交变更</span>
      </div>
      {observation?.issues.length ? (
        <details className="project-overview-notices">
          <summary>{observation.issues.length} 项需要留意</summary>
          {observation.issues.map((issue, index) => (
            <p key={index}>{issue}</p>
          ))}
        </details>
      ) : null}
      {documents.length ? (
        <section>
          <h3>项目文档</h3>
          <div className="project-document-links">
            {documents.map((item) => {
              const owner = [
                project.devPath,
                ...worktrees.map((tree) => tree.path),
              ].find((root) =>
                item.path.startsWith(root.replace(/\/$/, "") + "/"),
              );
              return (
                <button
                  key={`${item.name}:${item.path}`}
                  disabled={item.state !== "present" || !owner}
                  onClick={() =>
                    owner && onPreview(item.path.slice(owner.length + 1), owner)
                  }
                  title={item.path}
                >
                  <FileText size={14} />
                  <span>{filename(item.path)}</span>
                  <small>
                    {item.state === "present" ? "查看" : "尚未找到"}
                  </small>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}
      {worktrees.length ? (
        <section>
          <h3>工作目录</h3>
          <div className="project-worktree-status">
            {worktrees.map((item) => (
              <div key={item.path}>
                <GitBranch size={14} />
                <strong>
                  {item.branch ?? item.expectedBranch ?? filename(item.path)}
                </strong>
                <span>
                  {item.state === "ready"
                    ? `${item.changedFiles ?? 0} 项变更`
                    : "未完整读取"}
                </span>
                <code>{filename(item.path)}</code>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      <p className="project-preview-hint">
        从左侧选择文件，正文在这里查看；项目讨论保留在右侧。
      </p>
    </div>
  );
}

export function ProjectExplorer({
  snapshot,
  dispatch,
  selectedProjectId,
  onSelectProject,
  onDiscussProject,
}: {
  snapshot: Snapshot | null;
  dispatch: Dispatch;
  selectedProjectId?: string | null;
  onSelectProject?: (project: ProjectInfo) => void;
  onDiscussProject?: (project: ProjectInfo) => void;
}) {
  const projects = snapshot?.projects ?? [];
  const [localSelection, setLocalSelection] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [worktrees, setWorktrees] = useState<Record<string, string>>({});
  const [directories, setDirectories] = useState<
    Record<string, DirectoryState>
  >({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [previews, setPreviews] = useState<
    Record<string, ProjectFilePreview | undefined>
  >({});
  const [previewPending, setPreviewPending] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [treeWidth, setTreeWidth] = useState(() => {
    try {
      return clamp(
        Number(localStorage.getItem("ytriple.projectTreeWidth")) ||
          treeWidths.initial,
      );
    } catch {
      return treeWidths.initial;
    }
  });
  const [dragging, setDragging] = useState(false);
  const layout = useRef<HTMLDivElement>(null);
  const width = useRef(treeWidth);
  const drag = useRef<{
    start: number;
    width: number;
    pointerId: number;
  } | null>(null);
  const requests = useRef(0),
    loaded = useRef(new Set<string>());
  const project = projects.find(
    (item) => item.id === (selectedProjectId ?? localSelection),
  );
  const worktreePath = project
    ? (worktrees[project.id] ?? project.devPath)
    : "";
  const selectionKey = project ? keyFor(project.id, worktreePath, "") : "";
  const currentSelection = useRef(selectionKey);
  currentSelection.current = selectionKey;
  const preview = previews[selectionKey];
  const visibleProjects = projects.filter((item) =>
    `${item.name} ${item.root}`.toLowerCase().includes(query.toLowerCase()),
  );

  const remember = useCallback((state: ProjectBrowserState) => {
    const key = keyFor(state.projectId, state.worktreePath, state.directory);
    loaded.current.add(key);
    setDirectories((value) => ({
      ...value,
      [key]: {
        entries: state.entries,
        truncated: state.truncated,
        error: state.error,
      },
    }));
  }, []);
  const browse = useCallback(
    async (
      item: ProjectInfo,
      root: string,
      directory: string,
      refresh = false,
    ) => {
      const key = keyFor(item.id, root, directory);
      if (!refresh && loaded.current.has(key)) return;
      loaded.current.add(key);
      setLoading((value) => new Set(value).add(key));
      try {
        const result = await dispatch({
          type: "project.browse",
          projectId: item.id,
          worktreePath: root,
          path: directory,
        });
        const browser = result?.projectBrowser;
        if (
          browser?.projectId === item.id &&
          browser.worktreePath === root &&
          browser.directory === directory
        )
          remember(browser);
        else loaded.current.delete(key);
      } finally {
        setLoading((value) => {
          const next = new Set(value);
          next.delete(key);
          return next;
        });
      }
    },
    [dispatch, remember],
  );
  useEffect(() => {
    setPreviewPending(false);
    setPreviewError(null);
    if (project) void browse(project, worktreePath, "");
  }, [project?.id, worktreePath, browse]);

  const read = async (item: ProjectInfo, file: string, root = worktreePath) => {
    const request = ++requests.current;
    setPreviewPending(true);
    setPreviewError(null);
    const targetKey = keyFor(item.id, root, "");
    try {
      const result = await dispatch({
        type: "project.read",
        projectId: item.id,
        worktreePath: root,
        path: file,
      });
      const state = result?.projectBrowser;
      if (state?.projectId !== item.id || state.worktreePath !== root) return;
      remember(state);
      if (
        request !== requests.current ||
        currentSelection.current !== targetKey
      )
        return;
      if (state.error) {
        setPreviewError(state.error);
        return;
      }
      if (state.preview?.path === file) {
        setPreviews((value) => ({ ...value, [targetKey]: state.preview }));
        const pieces = file.split("/").slice(0, -1);
        setExpanded((value) => {
          const next = new Set(value);
          for (let index = 1; index <= pieces.length; index++)
            next.add(keyFor(item.id, root, pieces.slice(0, index).join("/")));
          return next;
        });
        for (let index = 0; index < pieces.length; index++)
          void browse(item, root, pieces.slice(0, index).join("/"));
      }
    } finally {
      if (request === requests.current) setPreviewPending(false);
    }
  };
  const persistWidth = (value: number) => {
    try {
      localStorage.setItem("ytriple.projectTreeWidth", String(value));
    } catch {
      /* In-memory resizing remains available. */
    }
  };
  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!drag.current || drag.current.pointerId !== event.pointerId) return;
      const available = Math.max(
        treeWidths.min,
        (layout.current?.clientWidth ?? 700) - 190,
      );
      width.current = Math.min(
        available,
        clamp(drag.current.width + event.clientX - drag.current.start),
      );
      setTreeWidth(width.current);
    };
    const finish = () => {
      if (!drag.current) return;
      drag.current = null;
      setDragging(false);
      persistWidth(width.current);
    };
    const cancel = () => {
      if (!drag.current) return;
      width.current = drag.current.width;
      setTreeWidth(width.current);
      drag.current = null;
      setDragging(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("mouseup", finish);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("mouseup", finish);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
    };
  }, []);

  return (
    <div
      className={`project-explorer-layout ${dragging ? "resizing" : ""}`}
      ref={layout}
      style={{ "--project-tree-width": `${treeWidth}px` } as CSSProperties}
    >
      <aside className="project-file-sidebar" aria-label="项目文件系统">
        <label className="project-file-search">
          <Search size={13} />
          <input
            aria-label="搜索本机项目"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="查找项目"
          />
        </label>
        <div className="project-tree-scroll">
          <p className="project-tree-heading">
            项目 <span>{visibleProjects.length}</span>
          </p>
          {visibleProjects.map((item) => (
            <div
              key={`${item.id}:${item.root}`}
              className="project-tree-project"
            >
              <button
                className={`project-tree-project-button ${project?.id === item.id ? "selected" : ""}`}
                aria-label={`选择项目 ${item.name}`}
                aria-expanded={project?.id === item.id}
                onClick={() => {
                  setLocalSelection(item.id);
                  onSelectProject?.(item);
                }}
                title={item.root}
              >
                {project?.id === item.id ? (
                  <ChevronDown size={12} />
                ) : (
                  <ChevronRight size={12} />
                )}
                <Folder size={15} />
                <span>{item.name}</span>
                {item.observation?.state === "attention" ? (
                  <i
                    className="project-tree-attention"
                    aria-label="有待留意状态"
                  />
                ) : null}
              </button>
              {project?.id === item.id ? (
                <>
                  <label className="project-tree-worktree">
                    <GitBranch size={12} />
                    <select
                      aria-label="项目工作目录"
                      value={worktreePath}
                      onChange={(event) =>
                        setWorktrees((value) => ({
                          ...value,
                          [item.id]: event.target.value,
                        }))
                      }
                    >
                      {Array.from(
                        new Set([
                          item.devPath,
                          ...(item.observation?.worktrees.map(
                            (tree) => tree.path,
                          ) ?? []),
                        ]),
                      ).map((root) => (
                        <option key={root} value={root}>
                          {filename(root)}
                        </option>
                      ))}
                    </select>
                    <button
                      title="刷新文件树"
                      aria-label="刷新文件树"
                      onClick={() => {
                        for (const key of loaded.current) {
                          if (
                            key.startsWith(
                              JSON.stringify([item.id, worktreePath]).slice(
                                0,
                                -1,
                              ),
                            )
                          )
                            loaded.current.delete(key);
                        }
                        void browse(item, worktreePath, "", true);
                        for (const key of expanded) {
                          const [id, root, directory] = JSON.parse(
                            key,
                          ) as string[];
                          if (id === item.id && root === worktreePath)
                            void browse(item, root, directory, true);
                        }
                      }}
                    >
                      <RefreshCw size={12} />
                    </button>
                  </label>
                  <FileTree
                    directory=""
                    depth={1}
                    cache={directories}
                    expanded={expanded}
                    loading={loading}
                    selectedPath={preview?.path}
                    projectId={item.id}
                    worktreePath={worktreePath}
                    onDirectory={(entry) => {
                      const key = keyFor(item.id, worktreePath, entry.path);
                      setExpanded((value) => {
                        const next = new Set(value);
                        if (next.has(key)) next.delete(key);
                        else next.add(key);
                        return next;
                      });
                      if (!expanded.has(key))
                        void browse(item, worktreePath, entry.path);
                    }}
                    onFile={(entry) => void read(item, entry.path)}
                  />
                </>
              ) : null}
            </div>
          ))}
          {!visibleProjects.length ? (
            <p className="project-tree-note">没有找到匹配的项目</p>
          ) : null}
        </div>
        <p className="project-tree-footer">
          只读浏览 · 略过隐藏文件、依赖与常见凭据文件
        </p>
      </aside>
      <div
        className="project-file-splitter"
        role="separator"
        tabIndex={0}
        aria-label="调整文件树与预览宽度"
        aria-orientation="vertical"
        aria-valuemin={treeWidths.min}
        aria-valuemax={treeWidths.max}
        aria-valuenow={Math.round(treeWidth)}
        onDoubleClick={() => {
          width.current = treeWidths.initial;
          setTreeWidth(width.current);
          persistWidth(width.current);
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.focus();
          event.preventDefault();
          drag.current = {
            start: event.clientX,
            width: treeWidth,
            pointerId: event.pointerId,
          };
          setDragging(true);
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            return;
          event.preventDefault();
          width.current =
            event.key === "Home"
              ? treeWidths.min
              : event.key === "End"
                ? treeWidths.max
                : clamp(treeWidth + (event.key === "ArrowLeft" ? -20 : 20));
          setTreeWidth(width.current);
          persistWidth(width.current);
        }}
      />
      <section
        className="project-file-preview"
        aria-label="项目文件预览"
        aria-busy={previewPending}
      >
        <header className="project-preview-bar">
          <button
            className={!preview ? "active" : ""}
            disabled={!project}
            onClick={() => {
              requests.current++;
              setPreviewPending(false);
              setPreviewError(null);
              setPreviews((value) => ({ ...value, [selectionKey]: undefined }));
            }}
          >
            项目概览
          </button>
          {preview ? (
            <span className="project-preview-tab" title={preview.path}>
              <FileText size={13} />
              {preview.name}
            </span>
          ) : null}
          <span className="project-preview-readonly">只读</span>
        </header>
        {previewPending ? (
          <div className="project-file-loading" role="status">
            正在读取文件…
          </div>
        ) : null}
        {previewError ? (
          <div className="project-preview-error" role="alert">
            {previewError}
          </div>
        ) : null}
        <div className="project-preview-content">
          {preview ? (
            <>
              <div className="project-preview-meta">
                <span title={preview.path}>{preview.path}</span>
                <small>
                  {new Intl.NumberFormat("zh-CN").format(preview.bytes)} 字节
                </small>
              </div>
              {preview.truncated ? (
                <p className="project-preview-error">
                  文件较大，当前仅预览前 192 KB。
                </p>
              ) : null}
              {preview.format === "markdown" ? (
                <Markdown
                  dispatch={dispatch}
                  onDocumentLink={(href) => {
                    if (!project) return;
                    const target = projectDocumentLink(href, preview.path);
                    if (!target) {
                      setPreviewError(
                        "此链接不在当前工作目录内，请从文件树中选择。",
                      );
                      return;
                    }
                    if (href.split(/[?#]/, 1)[0]?.endsWith("/")) {
                      const parts = target.split("/");
                      setExpanded((value) => {
                        const next = new Set(value);
                        for (let index = 1; index <= parts.length; index++)
                          next.add(
                            keyFor(
                              project.id,
                              worktreePath,
                              parts.slice(0, index).join("/"),
                            ),
                          );
                        return next;
                      });
                      for (let index = 1; index <= parts.length; index++)
                        void browse(
                          project,
                          worktreePath,
                          parts.slice(0, index).join("/"),
                        );
                    } else void read(project, target);
                  }}
                >
                  {preview.content ?? ""}
                </Markdown>
              ) : preview.format === "text" ? (
                <pre className="project-code-preview">
                  <code>{preview.content}</code>
                </pre>
              ) : (
                <div className="project-preview-empty">
                  <File size={32} strokeWidth={1.2} />
                  <h2>{preview.name}</h2>
                  <p>{preview.reason}</p>
                  {project ? (
                    <button
                      className="button secondary small"
                      onClick={() =>
                        void dispatch({
                          type: "path.reveal",
                          path: worktreePath,
                        })
                      }
                    >
                      <Folder size={14} />
                      打开工作目录
                    </button>
                  ) : null}
                </div>
              )}
            </>
          ) : project ? (
            <ProjectOverview
              project={project}
              dispatch={dispatch}
              onDiscuss={onDiscussProject}
              onPreview={(file, root) => {
                if (root !== worktreePath) {
                  currentSelection.current = keyFor(project.id, root, "");
                  setWorktrees((value) => ({ ...value, [project.id]: root }));
                }
                void read(project, file, root);
              }}
            />
          ) : (
            <div className="project-preview-empty">
              <FolderOpen size={34} strokeWidth={1.2} />
              <h2>选择一个项目</h2>
              <p>左侧展开文件，中间查看正文，右侧与团队讨论。</p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
