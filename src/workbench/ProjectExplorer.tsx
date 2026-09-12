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
  ChevronsDownUp,
  LocateFixed,
  X,
  LoaderCircle,
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
  focusedId,
  onFocusRow,
  onRetry,
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
  focusedId: string;
  onFocusRow: (id: string) => void;
  onRetry: (directory: string) => void;
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
          <button className="text-button" onClick={() => onRetry(directory)}>
            重试
          </button>
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
              role="treeitem"
              aria-level={depth + 1}
              aria-selected={
                entry.kind === "file" && selectedPath === entry.path
              }
              data-tree-row={entryKey}
              data-tree-project={projectId}
              data-tree-root={worktreePath}
              data-tree-path={entry.path}
              data-tree-parent={
                directory
                  ? keyFor(projectId, worktreePath, directory)
                  : `project:${projectId}`
              }
              data-tree-kind={entry.kind}
              tabIndex={focusedId === entryKey ? 0 : -1}
              onFocus={() => onFocusRow(entryKey)}
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
              {entry.kind === "directory" && loading.has(entryKey) ? (
                <LoaderCircle
                  className="spin"
                  size={11}
                  aria-label="正在读取"
                />
              ) : null}
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
                  focusedId,
                  onFocusRow,
                  onRetry,
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
  const [openProjects, setOpenProjects] = useState<Set<string>>(
    () => new Set(selectedProjectId ? [selectedProjectId] : []),
  );
  const [focusedId, setFocusedId] = useState("");
  const tree = useRef<HTMLDivElement>(null);
  const previewScroll = useRef<HTMLDivElement>(null);
  const focusAfterLoad = useRef<string | null>(null);
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [previews, setPreviews] = useState<
    Record<string, ProjectFilePreview | undefined>
  >({});
  const [previewPending, setPreviewPending] = useState(false);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const lastRead = useRef<{
    project: ProjectInfo;
    root: string;
    path: string;
  } | null>(null);
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
    initial: number;
    pointerId: number;
  } | null>(null);
  const requests = useRef(0),
    loaded = useRef(new Set<string>());
  const project = projects.find(
    (item) =>
      item.id ===
      (selectedProjectId === undefined ? localSelection : selectedProjectId),
  );
  const worktreePath = project
    ? (worktrees[project.id] ?? project.devPath)
    : "";
  const selectionKey = project ? keyFor(project.id, worktreePath, "") : "";
  const currentSelection = useRef(selectionKey);
  currentSelection.current = selectionKey;
  const preview = previews[selectionKey];
  const browsing = loading.size > 0;
  const visibleProjects = projects.filter((item) =>
    `${item.name} ${item.root}`.toLowerCase().includes(query.toLowerCase()),
  );

  const effectiveFocusId =
    focusedId || (visibleProjects[0] ? `project:${visibleProjects[0].id}` : "");

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
        else {
          loaded.current.delete(key);
          setDirectories((value) => ({
            ...value,
            [key]: {
              entries: [],
              truncated: false,
              error: "目录未能读取，请重试。",
            },
          }));
        }
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
    setPendingPath(null);
    setPreviewError(null);
    if (project) void browse(project, worktreePath, "");
  }, [project?.id, worktreePath, browse]);
  useEffect(() => {
    if (project?.id) setOpenProjects((value) => new Set(value).add(project.id));
  }, [project?.id]);
  useEffect(() => {
    previewScroll.current?.scrollTo?.({ top: 0 });
  }, [selectionKey, preview?.path]);
  useEffect(() => {
    const rows = Array.from(
      tree.current?.querySelectorAll<HTMLButtonElement>("[data-tree-row]") ??
        [],
    );
    const node = rows.find(
      (element) => element.dataset.treeRow === focusAfterLoad.current,
    );
    if (node) {
      node.focus();
      node.scrollIntoView?.({ block: "nearest" });
      focusAfterLoad.current = null;
    } else if (rows.length && !rows.some((element) => element.tabIndex === 0))
      setFocusedId(rows[0].dataset.treeRow!);
  }, [directories, expanded, openProjects, query]);

  const read = async (item: ProjectInfo, file: string, root = worktreePath) => {
    const request = ++requests.current;
    lastRead.current = { project: item, root, path: file };
    setPendingPath(file);
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
      if (state?.projectId !== item.id || state.worktreePath !== root) {
        if (
          request === requests.current &&
          currentSelection.current === targetKey
        )
          setPreviewError(`未能读取 ${filename(file)}，请重试。`);
        return;
      }
      if (!state.error) remember(state);
      if (
        request !== requests.current ||
        currentSelection.current !== targetKey
      )
        return;
      if (state.error) {
        setPreviewError(`${filename(file)}：${state.error}`);
        return;
      }
      if (state.preview?.path === file) {
        setOpenProjects((value) => new Set(value).add(item.id));
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
      if (request === requests.current) {
        setPreviewPending(false);
        setPendingPath(null);
      }
    }
  };
  const selectProject = (item: ProjectInfo) => {
    setLocalSelection(item.id);
    currentSelection.current = keyFor(
      item.id,
      worktrees[item.id] ?? item.devPath,
      "",
    );
    if (item.id !== project?.id) onSelectProject?.(item);
  };
  const toggleProject = (item: ProjectInfo, force?: boolean) => {
    const open = force ?? !openProjects.has(item.id);
    if (!open) setFocusedId(`project:${item.id}`);
    setOpenProjects((value) => {
      const next = new Set(value);
      if (open) next.add(item.id);
      else next.delete(item.id);
      return next;
    });
    if (open) void browse(item, worktrees[item.id] ?? item.devPath, "");
  };
  const toggleDirectory = (
    item: ProjectInfo,
    root: string,
    directory: string,
    force?: boolean,
  ) => {
    const key = keyFor(item.id, root, directory),
      open = force ?? !expanded.has(key);
    if (!open) setFocusedId(key);
    setExpanded((value) => {
      const next = new Set(value);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });
    if (open) void browse(item, root, directory);
  };
  const refreshTree = async () => {
    if (!project) return;
    for (const key of loaded.current) {
      const [id, root] = JSON.parse(key) as string[];
      if (id === project.id && root === worktreePath)
        loaded.current.delete(key);
    }
    await Promise.all([
      browse(project, worktreePath, "", true),
      ...Array.from(expanded).flatMap((key) => {
        const [id, root, directory] = JSON.parse(key) as string[];
        return id === project.id && root === worktreePath
          ? [browse(project, root, directory, true)]
          : [];
      }),
    ]);
  };
  const revealFile = () => {
    if (!project || !preview) return;
    setQuery("");
    setOpenProjects((value) => new Set(value).add(project.id));
    const parts = preview.path.split("/").slice(0, -1);
    setExpanded((value) => {
      const next = new Set(value);
      for (let index = 1; index <= parts.length; index++)
        next.add(
          keyFor(project.id, worktreePath, parts.slice(0, index).join("/")),
        );
      return next;
    });
    focusAfterLoad.current = keyFor(project.id, worktreePath, preview.path);
    setFocusedId(focusAfterLoad.current);
    for (let index = 0; index <= parts.length; index++)
      void browse(project, worktreePath, parts.slice(0, index).join("/"));
  };
  const treeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>(
      "[data-tree-row]",
    );
    if (!target) return;
    const rows = Array.from(
      tree.current?.querySelectorAll<HTMLButtonElement>("[data-tree-row]") ??
        [],
    );
    const index = rows.indexOf(target),
      kind = target.dataset.treeKind;
    let next: HTMLButtonElement | undefined;
    if (event.key === "ArrowDown")
      next = rows[Math.min(rows.length - 1, index + 1)];
    else if (event.key === "ArrowUp") next = rows[Math.max(0, index - 1)];
    else if (event.key === "Home") next = rows[0];
    else if (event.key === "End") next = rows.at(-1);
    else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      const item = projects.find(
        (item) => item.id === target.dataset.treeProject,
      );
      if (!item) return;
      const open = target.getAttribute("aria-expanded") === "true";
      const expandable = kind === "project" || kind === "directory";
      const expand = event.key === "ArrowRight";
      if (expandable && open !== expand) {
        if (kind === "project") toggleProject(item, expand);
        else
          toggleDirectory(
            item,
            target.dataset.treeRoot!,
            target.dataset.treePath!,
            expand,
          );
      } else if (expand && open)
        next = rows.find(
          (row) => row.dataset.treeParent === target.dataset.treeRow,
        );
      else if (!expand)
        next = rows.find(
          (row) => row.dataset.treeRow === target.dataset.treeParent,
        );
    } else if (event.key === "Enter" || event.key === " ") target.click();
    else return;
    event.preventDefault();
    next?.focus();
    next?.scrollIntoView?.({ block: "nearest" });
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
      width.current = drag.current.initial;
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
            onChange={(event) => {
              setQuery(event.target.value);
              setFocusedId("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") setQuery("");
            }}
            placeholder="查找项目"
          />
          {query ? (
            <button
              type="button"
              aria-label="清除项目搜索"
              onClick={() => setQuery("")}
            >
              <X size={12} />
            </button>
          ) : null}
        </label>
        <div className="project-tree-heading">
          <span>文件</span>
          <div className="project-tree-tools" aria-label="文件树操作">
            <button
              title="刷新当前项目文件树"
              aria-label="刷新文件树"
              disabled={!project || browsing}
              onClick={() => void refreshTree()}
            >
              <RefreshCw size={13} className={browsing ? "spin" : ""} />
            </button>
            <button
              title="收起全部项目与目录"
              aria-label="收起全部"
              disabled={!openProjects.size}
              onClick={() => {
                setOpenProjects(new Set());
                setExpanded(new Set());
                setFocusedId(
                  `project:${visibleProjects.find((item) => item.id === project?.id)?.id ?? visibleProjects[0]?.id ?? ""}`,
                );
              }}
            >
              <ChevronsDownUp size={13} />
            </button>
          </div>
        </div>
        <div
          className="project-tree-scroll"
          ref={tree}
          role="tree"
          aria-label="项目与文件"
          onKeyDown={treeKeyDown}
        >
          {visibleProjects.map((item) => {
            const itemRoot = worktrees[item.id] ?? item.devPath;
            const open = openProjects.has(item.id),
              selected = project?.id === item.id;
            const rowId = `project:${item.id}`;
            return (
              <div
                key={`${item.id}:${item.root}`}
                className="project-tree-project"
              >
                <button
                  className={`project-tree-project-button ${selected ? "selected" : ""}`}
                  role="treeitem"
                  aria-level={1}
                  aria-selected={selected}
                  aria-label={`选择项目 ${item.name}`}
                  aria-expanded={open}
                  data-tree-row={rowId}
                  data-tree-project={item.id}
                  data-tree-kind="project"
                  tabIndex={effectiveFocusId === rowId ? 0 : -1}
                  onFocus={() => setFocusedId(rowId)}
                  onClick={() => {
                    selectProject(item);
                    toggleProject(item, selected ? !open : true);
                  }}
                  title={item.root}
                >
                  <span
                    className="project-tree-disclosure"
                    aria-hidden="true"
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleProject(item);
                    }}
                  >
                    {open ? (
                      <ChevronDown size={12} />
                    ) : (
                      <ChevronRight size={12} />
                    )}
                  </span>
                  {open ? <FolderOpen size={15} /> : <Folder size={15} />}
                  <span>{item.name}</span>
                  {loading.has(keyFor(item.id, itemRoot, "")) ? (
                    <LoaderCircle
                      size={11}
                      className="spin"
                      aria-label="正在读取"
                    />
                  ) : item.observation?.state === "attention" ? (
                    <i
                      className="project-tree-attention"
                      aria-label="有待留意状态"
                    />
                  ) : null}
                </button>
                {open ? (
                  <>
                    <div className="project-tree-worktree">
                      <GitBranch size={12} />
                      <select
                        aria-label={`${item.name} 工作目录`}
                        value={itemRoot}
                        onChange={(event) => {
                          const root = event.target.value;
                          setWorktrees((value) => ({
                            ...value,
                            [item.id]: root,
                          }));
                          selectProject(item);
                          currentSelection.current = keyFor(item.id, root, "");
                          void browse(item, root, "");
                        }}
                      >
                        {Array.from(
                          new Set([
                            item.devPath,
                            ...(item.observation?.worktrees.map(
                              (worktree) => worktree.path,
                            ) ?? []),
                          ]),
                        ).map((root) => (
                          <option key={root} value={root}>
                            {filename(root)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <FileTree
                      directory=""
                      depth={1}
                      cache={directories}
                      expanded={expanded}
                      loading={loading}
                      selectedPath={selected ? preview?.path : undefined}
                      projectId={item.id}
                      worktreePath={itemRoot}
                      focusedId={effectiveFocusId}
                      onFocusRow={setFocusedId}
                      onRetry={(directory) =>
                        void browse(item, itemRoot, directory, true)
                      }
                      onDirectory={(entry) =>
                        toggleDirectory(item, itemRoot, entry.path)
                      }
                      onFile={(entry) => {
                        selectProject(item);
                        void read(item, entry.path, itemRoot);
                      }}
                    />
                  </>
                ) : null}
              </div>
            );
          })}
          {!visibleProjects.length ? (
            <div className="project-tree-empty" role="status">
              <Folder size={22} strokeWidth={1.3} />
              <p>
                {!snapshot || snapshot.projectDiscovery?.status === "scanning"
                  ? "正在发现本机项目…"
                  : query
                    ? "没有匹配的项目"
                    : "暂未发现本机项目"}
              </p>
              {query ? (
                <button className="text-button" onClick={() => setQuery("")}>
                  清除搜索
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
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
        aria-valuetext={`文件树宽度 ${Math.round(treeWidth)} 像素`}
        onLostPointerCapture={() => {
          if (!drag.current) return;
          width.current = drag.current.initial;
          setTreeWidth(width.current);
          drag.current = null;
          setDragging(false);
        }}
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
            width:
              layout.current
                ?.querySelector<HTMLElement>(".project-file-sidebar")
                ?.getBoundingClientRect().width || treeWidth,
            initial: treeWidth,
            pointerId: event.pointerId,
          };
          setDragging(true);
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && drag.current) {
            event.preventDefault();
            width.current = drag.current.initial;
            setTreeWidth(width.current);
            drag.current = null;
            setDragging(false);
            return;
          }
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
          <div className="project-preview-tools">
            {preview ? (
              <>
                <button
                  aria-label="在文件树中定位"
                  title="在文件树中定位"
                  onClick={revealFile}
                >
                  <LocateFixed size={14} />
                </button>
                <button
                  aria-label="重新读取文件"
                  title="重新读取文件"
                  disabled={previewPending || !project}
                  onClick={() => project && void read(project, preview.path)}
                >
                  <RefreshCw
                    size={13}
                    className={previewPending ? "spin" : ""}
                  />
                </button>
              </>
            ) : null}
            <span className="project-preview-readonly" title="项目文件只读预览">
              只读
            </span>
          </div>
        </header>
        {previewPending ? (
          <div className="project-file-loading" role="status">
            <LoaderCircle size={12} className="spin" /> 正在读取{" "}
            {pendingPath ? filename(pendingPath) : "文件"}…
          </div>
        ) : null}
        {previewError ? (
          <div className="project-preview-error" role="alert">
            <span>{previewError}</span>
            {lastRead.current &&
            currentSelection.current ===
              keyFor(lastRead.current.project.id, lastRead.current.root, "") ? (
              <button
                className="text-button"
                disabled={previewPending}
                onClick={() => {
                  const value = lastRead.current;
                  if (value) void read(value.project, value.path, value.root);
                }}
              >
                重试
              </button>
            ) : null}
            <button
              className="text-button"
              aria-label="关闭预览提示"
              onClick={() => setPreviewError(null)}
            >
              <X size={12} />
            </button>
          </div>
        ) : null}
        <div className="project-preview-content" ref={previewScroll}>
          {preview ? (
            <>
              <div className="project-preview-meta">
                <span title={`${worktreePath}/${preview.path}`}>
                  {filename(worktreePath)} / {preview.path}
                </span>
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
