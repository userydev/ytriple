import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type Dispatch as ReactDispatch,
  type SetStateAction,
} from "react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Compass,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  Layers2,
  Lightbulb,
  Link2,
  LoaderCircle,
  Menu,
  MoreHorizontal,
  Pencil,
  Archive,
  Trash2,
  RotateCcw,
  MessageSquare,
  Pause,
  Pin,
  PinOff,
  Bot,
  Cpu,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Sprout,
  Upload,
  X,
} from "lucide-react";
import {
  MEMBERS,
  type Command,
  type MemberId,
  type ProjectInput,
  type ProjectInfo,
  type Snapshot,
  type Task,
  type TaskKind,
  type WindowKind,
} from "../shared/types";
import { decisionExcerpt } from "./decision-summary";
import { ArtifactList, SourceList } from "./Artifacts";
import { Settings } from "./Settings";
import { Library } from "./Library";
import { ProcessView } from "./ProcessView";
import { Projects } from "./Projects";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { WorkspaceControls } from "./WindowControls";
import { WorkspacePanels } from "./WorkspacePanels";
import {
  Markdown,
  Modal,
  STATUS_NAMES,
  formatDate,
  formatTime,
  memberName,
  type Dispatch,
} from "./common";

type Page = "work" | "projects" | "library" | "models" | "team" | "environment";
const isSettingsPage = (page: Page) =>
  ["models", "team", "environment"].includes(page);
const UI_PREFERENCES_KEY = "ytriple.navigation.v1";
function readPinnedSidebar() {
  try {
    return (
      JSON.parse(window.localStorage.getItem(UI_PREFERENCES_KEY) ?? "{}")
        .pinned === true
    );
  } catch {
    return false;
  }
}
type Dialog = "source" | "project" | null;
type ComposerDraft = {
  text: string;
  kind: TaskKind;
  member: MemberId;
  profileId: string;
};
const EMPTY_DRAFT: ComposerDraft = {
  text: "",
  kind: "research",
  member: "coordinator",
  profileId: "",
};
const DIRECTIONS: {
  kind: TaskKind;
  label: string;
  description: string;
  seed: string;
  icon: typeof Search;
}[] = [
  {
    kind: "research",
    label: "深入研究一个问题",
    description: "找到依据，形成自己的判断",
    seed: "我想深入研究：",
    icon: Search,
  },
  {
    kind: "project",
    label: "把想法变成项目",
    description: "讨论雏形，准备开发的起点",
    seed: "我有一个产品想法：",
    icon: Sprout,
  },
  {
    kind: "learning",
    label: "打开一个知识点",
    description: "从好奇出发，把理解再推进一步",
    seed: "我想理解这个知识点：",
    icon: BookOpen,
  },
  {
    kind: "brainstorm",
    label: "一起扩展一个创意",
    description: "换个视角，找到更多可能",
    seed: "和我一起想一想：",
    icon: Lightbulb,
  },
];

function Logo() {
  return (
    <div className="brand">
      <span className="brand-glyph" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>
        ytriple<span className="brand-period">.</span>
      </span>
    </div>
  );
}

function Status({ task }: { task: Task }) {
  return (
    <span className={`task-status status-${task.status}`}>
      <span
        className={
          task.status === "running" ? "status-dot pulse" : "status-dot"
        }
      />
      {STATUS_NAMES[task.status]}
    </span>
  );
}

function TaskControl({ task, dispatch }: { task: Task; dispatch: Dispatch }) {
  const [pending, setPending] = useState(false);
  const stoppable = task.status === "running" || task.status === "waiting";
  const act = async () => {
    setPending(true);
    await dispatch({
      type: stoppable ? "task.stop" : "task.run",
      taskId: task.id,
    });
    setPending(false);
  };
  if (task.status === "completed") return null;
  return (
    <button
      className="text-button task-run-control"
      disabled={pending}
      onClick={() => void act()}
    >
      {pending ? (
        <LoaderCircle size={14} className="spin" />
      ) : stoppable ? (
        <Pause size={14} />
      ) : (
        <ArrowRight size={14} />
      )}
      {pending
        ? stoppable
          ? "停止中…"
          : "正在开始…"
        : stoppable
          ? "暂停工作"
          : task.status === "idle"
            ? "开始处理"
            : task.status === "failed"
              ? "重试本次工作"
              : "恢复暂停的工作"}
    </button>
  );
}

function TaskNavigationItem({
  task,
  active,
  onTask,
  dispatch,
}: {
  task: Task;
  active: boolean;
  onTask: (id: string) => void;
  dispatch: Dispatch;
}) {
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [pending, setPending] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null);
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0 });
  const act = async (command: Command) => {
    menu.current?.removeAttribute("open");
    setPending(true);
    const result = await dispatch(command);
    setPending(false);
    if (result) setRenaming(false);
  };
  return (
    <div className={`work-item-row ${active ? "active" : ""}`}>
      {renaming ? (
        <form
          className="work-rename"
          onSubmit={(event) => {
            event.preventDefault();
            void act({ type: "task.rename", taskId: task.id, title });
          }}
        >
          <input
            aria-label="工作名称"
            value={title}
            maxLength={120}
            onChange={(event) => setTitle(event.target.value)}
            autoFocus
          />
          <button
            type="submit"
            disabled={pending || !title.trim()}
            aria-label="保存工作名称"
          >
            <Check size={13} />
          </button>
          <button
            type="button"
            onClick={() => setRenaming(false)}
            aria-label="取消重命名"
          >
            <X size={13} />
          </button>
        </form>
      ) : (
        <>
          <button
            className={`work-item ${active ? "active" : ""}`}
            onClick={() => onTask(task.id)}
          >
            <span className={`work-dot ${task.status}`} />
            <span className="work-title">{task.title}</span>
            {task.status === "running" ? (
              <LoaderCircle size={12} className="spin" />
            ) : null}
          </button>
          <details
            className="work-item-menu"
            ref={menu}
            onToggle={(event) => {
              if (event.currentTarget.open) {
                const rect = event.currentTarget.getBoundingClientRect();
                setMenuPosition({
                  left: Math.max(
                    8,
                    Math.min(window.innerWidth - 174, rect.right - 160),
                  ),
                  top: Math.max(
                    8,
                    Math.min(window.innerHeight - 130, rect.bottom + 4),
                  ),
                });
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                menu.current?.removeAttribute("open");
                menu.current?.querySelector("summary")?.focus();
              }
            }}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget))
                menu.current?.removeAttribute("open");
            }}
          >
            <summary aria-label={`管理工作：${task.title}`}>
              <MoreHorizontal size={15} />
            </summary>
            <div className="work-item-popover" style={menuPosition}>
              <button
                disabled={pending}
                onClick={() => {
                  setTitle(task.title);
                  setRenaming(true);
                }}
              >
                <Pencil size={13} />
                重命名
              </button>
              <button
                disabled={pending}
                onClick={() =>
                  void act({ type: "task.archive", taskId: task.id })
                }
              >
                <Archive size={13} />
                归档
              </button>
              <button
                disabled={pending}
                onClick={() =>
                  void act({ type: "task.delete", taskId: task.id })
                }
              >
                <Trash2 size={13} />
                移到最近删除
              </button>
            </div>
          </details>
        </>
      )}
    </div>
  );
}

function Sidebar({
  snapshot,
  page,
  selectedTaskId,
  onPage,
  onTask,
  onNew,
  connected,
  collapsed,
  onClose,
  pinned,
  onPin,
  dispatch,
}: {
  snapshot: Snapshot | null;
  page: Page;
  selectedTaskId: string | null;
  onPage: (page: Page) => void;
  onTask: (id: string) => void;
  onNew: () => void;
  connected: boolean;
  collapsed: boolean;
  onClose: () => void;
  pinned: boolean;
  onPin: () => void;
  dispatch: Dispatch;
}) {
  const recent =
    snapshot?.tasks.filter((task) => !task.archivedAt && !task.deletedAt) ?? [];
  const archived =
    snapshot?.tasks.filter((task) => task.archivedAt && !task.deletedAt) ?? [];
  const deleted = snapshot?.tasks.filter((task) => task.deletedAt) ?? [];
  const [settingsOpen, setSettingsOpen] = useState(false);
  return (
    <aside className={`sidebar ${collapsed ? "sidebar-hidden" : ""}`}>
      <div className="sidebar-brand">
        <Logo />
        <button
          className="icon-button sidebar-pin"
          aria-label={pinned ? "取消固定侧栏" : "固定侧栏"}
          title={pinned ? "取消固定侧栏" : "固定侧栏"}
          aria-pressed={pinned}
          onClick={onPin}
        >
          {pinned ? <PinOff size={15} /> : <Pin size={15} />}
        </button>
        <button
          className="icon-button sidebar-close"
          onClick={onClose}
          aria-label="收起侧栏"
        >
          <X size={16} />
        </button>
      </div>
      <button className="new-work" onClick={onNew}>
        <Plus size={17} />
        开启一项工作<span>⌘ N</span>
      </button>
      <nav className="primary-nav" aria-label="工作台导航">
        {(
          [
            { id: "work", label: "工作台", icon: Compass },
            { id: "projects", label: "项目", icon: Folder },
            { id: "library", label: "本地 Lib", icon: BookOpen },
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            className={page === item.id ? "active" : ""}
            onClick={() => onPage(item.id)}
          >
            <item.icon size={17} strokeWidth={1.7} />
            <span>{item.label}</span>
            {item.id === "projects" && snapshot?.projects.length ? (
              <span className="nav-count">{snapshot.projects.length}</span>
            ) : null}
          </button>
        ))}
      </nav>
      <div className="work-list-heading">
        <span>最近的工作</span>
        {recent.length ? <span>{recent.length}</span> : null}
      </div>
      <div className="work-list">
        {recent.length ? (
          [...recent]
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .map((task) => (
              <TaskNavigationItem
                key={task.id}
                task={task}
                active={page === "work" && selectedTaskId === task.id}
                onTask={onTask}
                dispatch={dispatch}
              />
            ))
        ) : (
          <p className="sidebar-empty">
            每项工作都会留在这里，
            <br />
            方便下次接着做。
          </p>
        )}
      </div>
      <div className="sidebar-bottom">
        {[
          { label: "归档", items: archived },
          { label: "最近删除", items: deleted },
        ].map((group) =>
          group.items.length ? (
            <details className="work-history" key={group.label}>
              <summary>
                {group.label}
                <span>{group.items.length}</span>
              </summary>
              {group.items.map((item) => (
                <div key={item.id}>
                  <span title={item.title}>{item.title}</span>
                  <button
                    className="icon-button"
                    title="恢复工作"
                    aria-label={`恢复工作：${item.title}`}
                    onClick={() =>
                      void dispatch({ type: "task.restore", taskId: item.id })
                    }
                  >
                    <RotateCcw size={13} />
                  </button>
                </div>
              ))}
            </details>
          ) : null,
        )}
        <details
          className="sidebar-settings-group"
          open={settingsOpen || isSettingsPage(page)}
          onToggle={(event) => setSettingsOpen(event.currentTarget.open)}
        >
          <summary>
            <Settings2 size={16} />
            设置
            <ChevronDown size={13} />
          </summary>
          <nav className="configuration-nav" aria-label="工作台配置">
            {(
              [
                { id: "team", label: "Agent 团队", icon: Bot },
                { id: "models", label: "AI 模型", icon: Cpu },
                { id: "environment", label: "本机设置", icon: Settings2 },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                className={`settings-nav ${page === item.id ? "active" : ""}`}
                onClick={() => onPage(item.id)}
              >
                <item.icon size={16} />
                {item.label}
                <ChevronRight size={14} />
              </button>
            ))}
          </nav>
        </details>
      </div>
    </aside>
  );
}

function Composer({
  task,
  snapshot,
  connected,
  dispatch,
  onCreate,
  onAdd,
  draft,
  setDraft,
  seedRevision,
  onConfigure,
}: {
  task?: Task;
  snapshot: Snapshot | null;
  connected: boolean;
  dispatch: Dispatch;
  onCreate: (
    text: string,
    kind: TaskKind,
    member: MemberId,
    profileId?: string,
  ) => Promise<void>;
  onAdd: () => void;
  draft: ComposerDraft;
  setDraft: ReactDispatch<SetStateAction<ComposerDraft>>;
  seedRevision: number;
  onConfigure: () => void;
}) {
  const { text, member, profileId } = draft;
  const [reviseGoal, setReviseGoal] = useState(false);
  const [sending, setSending] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (seedRevision > 0) textarea.current?.focus();
  }, [seedRevision]);
  const send = async () => {
    if (!text.trim() || !connected || sending) return;
    setSending(true);
    if (task) {
      const result = await dispatch({
        type: "task.send",
        taskId: task.id,
        text: text.trim(),
        member,
        ...(profileId ? { profileId } : {}),
        ...(reviseGoal ? { reviseGoal: true } : {}),
      });
      if (result) {
        setDraft((current) =>
          current.text === text ? { ...current, text: "" } : current,
        );
        setReviseGoal(false);
      }
    } else
      await onCreate(text.trim(), draft.kind, member, profileId || undefined);
    setSending(false);
  };
  const configured = snapshot?.profiles.some(
    (profile) => profile.hasKey && profile.modelId,
  );
  return (
    <div className="composer-area">
      {task && reviseGoal ? (
        <div className="revise-banner">
          <Lightbulb size={14} />
          <span>写下新的工作目标。团队会据此调整当前方向。</span>
          <button
            className="icon-button"
            onClick={() => setReviseGoal(false)}
            aria-label="取消修正目标"
          >
            <X size={13} />
          </button>
        </div>
      ) : null}
      <form
        className={`composer ${reviseGoal ? "revising" : ""}`}
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          ref={textarea}
          aria-label={
            reviseGoal
              ? "新的工作目标"
              : task
                ? "继续讨论或提出修改"
                : "描述你想开展的工作"
          }
          placeholder={
            !connected
              ? "连接桌面应用后，在这里开始工作…"
              : reviseGoal
                ? "我想调整一下方向…"
                : task
                  ? "继续追问、提出修改，或者换一个角度…"
                  : "说说你的想法，或放入一份资料…"
          }
          value={text}
          onChange={(event) => {
            const text = event.target.value;
            setDraft((current) => ({ ...current, text }));
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void send();
            }
          }}
          rows={3}
          disabled={!connected}
        />
        <div className="composer-toolbar">
          <div className="composer-options">
            <button
              className="icon-button"
              type="button"
              onClick={onAdd}
              disabled={!connected}
              title="添加资料"
              aria-label="添加资料"
            >
              <Plus size={18} />
            </button>
            <span className="toolbar-divider" />
            <label className="select-member">
              <span className="sr-only">选择对话成员</span>
              <select
                value={member}
                onChange={(event) => {
                  const member = event.target.value as MemberId;
                  setDraft((current) => ({ ...current, member }));
                }}
                disabled={!connected}
              >
                {MEMBERS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.id === "coordinator" ? "团队 · 统筹" : item.shortName}
                  </option>
                ))}
              </select>
              <ChevronDown size={12} />
            </label>
            <label className="select-model">
              <span className="sr-only">本次工作的模型连接</span>
              <select
                value={profileId}
                onChange={(event) => {
                  const profileId = event.target.value;
                  setDraft((current) => ({ ...current, profileId }));
                }}
                disabled={!connected}
              >
                <option value="">成员默认模型</option>
                {snapshot?.profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={11} />
            </label>
          </div>
          <button
            type="submit"
            className="send-button"
            aria-label={task ? "发送消息" : "开始工作"}
            disabled={!connected || !text.trim() || sending}
          >
            {sending ? (
              <LoaderCircle size={17} className="spin" />
            ) : (
              <ArrowUp size={19} />
            )}
          </button>
        </div>
      </form>
      <div className="composer-footnote">
        {task ? (
          <button
            className={`text-button ${reviseGoal ? "accent" : ""}`}
            onClick={() => {
              setReviseGoal(!reviseGoal);
              textarea.current?.focus();
            }}
          >
            <Lightbulb size={12} />
            修正工作目标
          </button>
        ) : (
          <span>把背景交给团队，把判断留给自己。</span>
        )}
        <span>
          {connected && !configured ? (
            <button className="text-button accent" onClick={onConfigure}>
              先连接一个模型
              <ArrowUpRight size={12} />
            </button>
          ) : (
            "Enter 发送 · Shift Enter 换行"
          )}
        </span>
      </div>
    </div>
  );
}

function ProjectDecision({
  project,
  snapshot,
  dispatch,
  connected,
  drafts,
  onOpenTask,
  onConfigure,
  onDetail,
  onArtifact,
}: {
  project?: ProjectInfo;
  snapshot: Snapshot | null;
  dispatch: Dispatch;
  connected: boolean;
  drafts: Map<string, ComposerDraft>;
  onDetail: (task: Task, message: Task["messages"][number]) => void;
  onArtifact: (task: Task, artifactId: string) => void;
  onOpenTask: (id: string) => void;
  onConfigure: () => void;
}) {
  const related =
    snapshot?.tasks.filter(
      (task) =>
        !task.archivedAt &&
        !task.deletedAt &&
        ((project && task.projectId === project.id) ||
          (project &&
            task.events.some(
              (event) =>
                event.type === "project.initialized" &&
                event.data?.projectId === project.id,
            ))),
    ) ?? [];
  const [chosenTaskId, setChosenTaskId] = useState<string | null>(() =>
    drafts.get(`project:${project?.id}:new`)?.text
      ? null
      : (related[0]?.id ?? null),
  );
  const task = related.find((item) => item.id === chosenTaskId);
  const draftKey = task?.id ?? `project:${project?.id ?? "none"}:new`;
  const [draft, updateDraft] = useState<ComposerDraft>(
    () =>
      drafts.get(draftKey) ?? {
        ...EMPTY_DRAFT,
        kind: "project",
        member: task?.member ?? "coordinator",
        profileId: task?.profileId ?? "",
      },
  );
  const mounted = useRef(true);
  const selectionVersion = useRef(0);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const setDraft: ReactDispatch<SetStateAction<ComposerDraft>> = (next) =>
    updateDraft((current) => {
      const value = typeof next === "function" ? next(current) : next;
      draftRef.current = value;
      drafts.set(draftKey, value);
      return value;
    });
  const [adding, setAdding] = useState(false);
  const selectDiscussion = (
    id: string | null,
    created?: Task,
    preserveDraft = true,
  ) => {
    selectionVersion.current += 1;
    if (preserveDraft) drafts.set(draftKey, draft);
    const selected = created ?? related.find((item) => item.id === id);
    setChosenTaskId(id);
    updateDraft(
      drafts.get(id ?? `project:${project?.id}:new`) ?? {
        ...EMPTY_DRAFT,
        kind: "project",
        member: selected?.member ?? "coordinator",
        profileId: selected?.profileId ?? "",
      },
    );
  };
  const create = async (
    text: string,
    _kind: TaskKind,
    member: MemberId,
    profileId?: string,
    run = true,
  ) => {
    if (!project) return null;
    const submittedDraft = draftRef.current;
    const submittedSelection = selectionVersion.current;
    const existing = new Set(snapshot?.tasks.map((item) => item.id));
    const context = [
      `围绕本机项目「${project.name}」讨论。`,
      `项目 ID：${project.id}；目录：${project.root}`,
      `以下仅为本地扫描概况，尚未读取项目文件正文。`,
      ...(project.observation?.issues ?? []).map(
        (issue) => `状态提示：${issue}`,
      ),
      ...(project.observation?.worktrees ?? []).map(
        (tree) =>
          `工作目录：${tree.path}；分支：${tree.branch ?? "未知"}；改动文件：${tree.changedFiles ?? "未知"}`,
      ),
      `我的问题：${text}`,
    ].join("\n");
    const result = await dispatch({
      type: "task.create",
      projectId: project.id,
      title: `${project.name} · ${text.slice(0, 35)}`,
      goal: context,
      kind: "project",
      member,
      ...(profileId ? { profileId } : {}),
    });
    const created = result?.tasks.find(
      (item) =>
        !existing.has(item.id) &&
        item.projectId === project.id &&
        item.goal === context,
    );
    if (!created) return null;
    if (drafts.get(draftKey) === submittedDraft) drafts.delete(draftKey);
    if (
      mounted.current &&
      selectionVersion.current === submittedSelection &&
      draftRef.current === submittedDraft
    )
      selectDiscussion(created.id, created, false);
    if (run) await dispatch({ type: "task.run", taskId: created.id });
    return created;
  };
  return (
    <aside className="project-decision" aria-label="项目决策与讨论">
      <header className="project-decision-header">
        <div>
          <span className="eyebrow">决策与讨论</span>
          <h2>{project?.name ?? "一起推进项目"}</h2>
        </div>
        <MessageSquare size={18} />
      </header>
      {project ? (
        <>
          <div className="project-discussion-controls">
            <label>
              <span className="sr-only">项目讨论记录</span>
              <select
                aria-label="项目讨论记录"
                value={chosenTaskId ?? ""}
                onChange={(event) =>
                  selectDiscussion(event.target.value || null)
                }
              >
                <option value="">新的项目讨论</option>
                {related.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            </label>
            {task ? (
              <button
                className="text-button"
                onClick={() => selectDiscussion(null)}
              >
                <Plus size={13} />
                新讨论
              </button>
            ) : null}
          </div>
          {task ? (
            <>
              <div className="decision-task-actions">
                <TaskControl task={task} dispatch={dispatch} />
                <button
                  className="text-button"
                  onClick={() => onOpenTask(task.id)}
                >
                  查看过程与成果
                  <ArrowUpRight size={13} />
                </button>
              </div>
              <Conversation
                key={task.id}
                task={task}
                dispatch={dispatch}
                onDetail={(message) => onDetail(task, message)}
                onArtifact={(id) => onArtifact(task, id)}
              />
            </>
          ) : (
            <div className="project-discussion-intro">
              <span className="project-discussion-mark">
                <MessageSquare size={23} />
              </span>
              <h3>围绕这个项目，直接讨论</h3>
              <p>梳理进展、讨论取舍，或确定下一步。</p>
              <div className="project-discussion-seeds">
                {[
                  "梳理当前项目状态与待处理事项",
                  "一起讨论这个项目下一步的优先级",
                ].map((text) => (
                  <button
                    key={text}
                    onClick={() =>
                      setDraft((current) => ({ ...current, text }))
                    }
                  >
                    {text}
                    <ArrowUpRight size={13} />
                  </button>
                ))}
              </div>
              <small>发送时带入当前项目概况；可添加文档补充背景。</small>
            </div>
          )}
          <Composer
            key={draftKey}
            task={task}
            snapshot={snapshot}
            connected={connected}
            dispatch={dispatch}
            draft={draft}
            setDraft={setDraft}
            seedRevision={0}
            onCreate={async (...args) => {
              await create(...args);
            }}
            onAdd={() => setAdding(true)}
            onConfigure={onConfigure}
          />
          {adding ? (
            <SourceDialog
              connected={connected}
              dispatch={dispatch}
              ensureTask={async () =>
                task ??
                create(
                  draft.text.trim() || "理解项目资料，讨论后续工作",
                  "project",
                  draft.member,
                  draft.profileId || undefined,
                  false,
                )
              }
              onClose={() => setAdding(false)}
            />
          ) : null}
        </>
      ) : (
        <div className="project-discussion-intro unselected">
          <span className="project-discussion-mark">
            <MessageSquare size={25} />
          </span>
          <h3>选一个项目，开始交流</h3>
          <p>
            从左侧文件系统选择项目。
            <br />
            这里保留决策与讨论，过程和成果可随时回到工作台查看。
          </p>
        </div>
      )}
    </aside>
  );
}

function userMessageText(
  task: Task,
  message: Task["messages"][number],
): string {
  if (
    task.projectId &&
    message.content.startsWith("围绕本机项目") &&
    message.content.includes("我的问题：")
  )
    return message.content.split("我的问题：").slice(1).join("我的问题：");
  if (!message.content.startsWith("继续处理已选成果")) return message.content;
  const request = task.events.find(
    (event) =>
      event.type === "artifact.refine_requested" &&
      event.goalVersion === message.goalVersion,
  );
  if (typeof request?.data?.instruction !== "string") return message.content;
  const artifact = task.artifacts.find(
    (item) => item.id === request.data?.artifactId,
  );
  return `继续处理《${artifact?.title ?? "选定成果"}》：\n${request.data.instruction}`;
}

function Conversation({
  task,
  dispatch,
  onDetail,
  onArtifact,
}: {
  task: Task;
  dispatch: Dispatch;
  onDetail?: (message: Task["messages"][number]) => void;
  onArtifact?: (artifactId: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const lastMessage = task.messages.at(-1);
  const lastEvent = task.events.at(-1);
  useEffect(() => {
    if (stickToBottom.current)
      bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
    else setShowLatest(true);
  }, [lastMessage?.id, lastMessage?.content, lastEvent?.id]);
  return (
    <div
      className="conversation-scroll"
      ref={scrollRef}
      onScroll={() => {
        const element = scrollRef.current;
        if (element) {
          stickToBottom.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            100;
          if (stickToBottom.current) setShowLatest(false);
        }
      }}
    >
      <div className="conversation-inner">
        <div className="task-overview">
          <span className="eyebrow">
            {
              {
                research: "研究与判断",
                project: "项目孵化",
                learning: "知识扩展",
                brainstorm: "创意探索",
              }[task.kind]
            }
          </span>
          <h1>{task.title}</h1>
          <details className="goal-details">
            <summary>
              <span>当前目标</span>
              <span className="goal-version">v{task.goalVersion}</span>
              <ChevronDown size={13} />
            </summary>
            <p>{task.goal}</p>
          </details>
          <div className="task-overview-meta">
            <Status task={task} />
            <span>{task.sources.length} 份资料</span>
            <span>{task.artifacts.length} 项成果</span>
          </div>
        </div>
        {!task.messages.length && !task.events.length ? (
          <div className="conversation-empty">
            <span className="empty-line" />
            <p>
              目标已记下。可以先补充资料，
              <br />
              准备好后让团队开始。
            </p>
            <button
              className="button secondary small"
              onClick={() =>
                void dispatch({ type: "task.run", taskId: task.id })
              }
            >
              开始研究
              <ArrowRight size={14} />
            </button>
          </div>
        ) : null}
        <div className="messages">
          {task.messages.map((message) => (
            <article
              className={`message ${message.role} ${message.goalVersion !== task.goalVersion ? "superseded" : ""}`}
              key={message.id}
            >
              <div className="message-byline">
                <span className={`message-avatar ${message.role}`}>
                  {message.role === "user" ? "Y" : <Layers2 size={14} />}
                </span>
                <strong>
                  {message.role === "user" ? "你" : memberName(message.member)}
                </strong>
                <time dateTime={message.createdAt}>
                  {formatTime(message.createdAt)}
                </time>
                {message.goalVersion !== task.goalVersion ? (
                  <span className="old-goal">
                    此前目标 v{message.goalVersion}
                  </span>
                ) : null}
              </div>
              <div className="message-content">
                {message.role === "assistant" ? (
                  <>
                    <Markdown dispatch={dispatch} onArtifactLink={onArtifact}>
                      {decisionExcerpt(message.content).text}
                    </Markdown>
                    {decisionExcerpt(message.content).detailed ? (
                      <button
                        className="decision-detail-link"
                        onClick={() => onDetail?.(message)}
                      >
                        查看完整内容
                        <ArrowUpRight size={13} />
                      </button>
                    ) : null}
                  </>
                ) : (
                  <p>{userMessageText(task, message)}</p>
                )}
              </div>
            </article>
          ))}
        </div>
        {task.status === "running" || task.status === "waiting" ? (
          <div className="decision-progress-note">
            <LoaderCircle size={13} className="spin" />
            团队正在处理，详细过程见右侧。
          </div>
        ) : null}
        {task.error ? (
          <div className="task-error">
            <CircleAlert size={16} />
            <div>
              <strong>这一步需要处理</strong>
              <p>{task.error}</p>
              <button
                className="text-button"
                onClick={() =>
                  void dispatch({ type: "task.run", taskId: task.id })
                }
              >
                重试并继续
                <ArrowRight size={13} />
              </button>
            </div>
          </div>
        ) : null}
        <div ref={bottomRef} />
      </div>
      {showLatest ? (
        <button
          className="jump-latest"
          onClick={() => {
            bottomRef.current?.scrollIntoView({ behavior: "smooth" });
            stickToBottom.current = true;
            setShowLatest(false);
          }}
        >
          <ArrowDown size={14} />
          查看最新进展
        </button>
      ) : null}
    </div>
  );
}

function ProjectDialog({
  task,
  connected,
  dispatch,
  onClose,
  onCreated,
}: {
  task?: Task;
  connected: boolean;
  dispatch: Dispatch;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [input, setInput] = useState<ProjectInput>({
    id: "",
    name: "",
    series: "y",
    description: task?.goal ?? "",
    ...(task ? { taskId: task.id } : {}),
  });
  const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    const result = await dispatch({ type: "project.initialize", input });
    setPending(false);
    if (result) {
      onClose();
      onCreated();
    }
  };
  return (
    <Modal
      title="让想法有一个起点"
      description="把讨论和资料整理成 Codex 可以接手的本机项目。"
      onClose={onClose}
    >
      <form onSubmit={(event) => void submit(event)}>
        <fieldset className="settings-fieldset" disabled={pending}>
          <div className="form-grid">
            <label className="field">
              项目名称
              <input
                value={input.name}
                required
                placeholder="给这个想法起个名字"
                onChange={(event) =>
                  setInput({ ...input, name: event.target.value })
                }
              />
            </label>
            <label className="field">
              稳定 ID
              <input
                value={input.id}
                required
                pattern="[a-z0-9][a-z0-9-]*"
                title="使用小写字母、数字和连字符"
                placeholder="my-project"
                onChange={(event) =>
                  setInput({ ...input, id: event.target.value })
                }
              />
            </label>
          </div>
          <label className="field">
            项目系列
            <select
              value={input.series}
              onChange={(event) =>
                setInput({
                  ...input,
                  series: event.target.value as ProjectInput["series"],
                })
              }
            >
              <option value="x">x · 探索型产品</option>
              <option value="y">y · 计划开源的工具或产品</option>
              <option value="z">z · 闭源产品</option>
            </select>
          </label>
          <label className="field">
            产品雏形与需求
            <textarea
              value={input.description}
              rows={5}
              required
              placeholder="它要解决什么问题？现阶段有哪些想法或约束？"
              onChange={(event) =>
                setInput({ ...input, description: event.target.value })
              }
            />
          </label>
          <div className="initialization-note">
            <Check size={14} />
            <p>
              建立目录、规则、项目文档与 Git 基础。
              {task
                ? "会关联当前工作的资料与成果。"
                : "文档可以在之后的工作中继续完善。"}
            </p>
          </div>
          <div className="modal-actions">
            <button
              type="button"
              className="button secondary"
              onClick={onClose}
            >
              稍后再说
            </button>
            <button
              className="button primary"
              type="submit"
              disabled={!connected || pending}
            >
              {pending ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <Sprout size={15} />
              )}
              {pending ? "正在初始化" : "初始化本机项目"}
            </button>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}

function SourceDialog({
  connected,
  dispatch,
  ensureTask,
  onClose,
}: {
  connected: boolean;
  dispatch: Dispatch;
  ensureTask: () => Promise<Task | null>;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"file" | "url" | "text">("file");
  const [title, setTitle] = useState("");
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    setPending(true);
    const task = await ensureTask();
    if (!task) {
      setPending(false);
      return;
    }
    const result = await dispatch(
      tab === "file"
        ? { type: "source.import", taskId: task.id }
        : tab === "url"
          ? { type: "source.addURL", taskId: task.id, url: value.trim() }
          : {
              type: "source.addText",
              taskId: task.id,
              title: title.trim() || "补充材料",
              text: value,
            },
    );
    setPending(false);
    if (result) onClose();
  };
  return (
    <Modal
      title="给团队一些背景"
      description="材料会跟随这项工作，之后仍能引用和继续研究。"
      onClose={onClose}
    >
      <div className="source-import-tabs">
        {(
          [
            { id: "file", label: "本地文件", icon: FileText },
            { id: "url", label: "网页链接", icon: Link2 },
            { id: "text", label: "粘贴文本", icon: MessageSquare },
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            className={tab === item.id ? "active" : ""}
            onClick={() => {
              setTab(item.id);
              setValue("");
            }}
          >
            <item.icon size={15} />
            {item.label}
          </button>
        ))}
      </div>
      {tab === "file" ? (
        <div className="file-import">
          <div className="import-symbol">
            <Upload size={30} strokeWidth={1.3} />
          </div>
          <h3>把已有的材料放进来</h3>
          <p>
            MD、TXT、JSON、PDF、DOC / DOCX
            <br />
            按实际解析结果标明内容范围
          </p>
          <button
            className="button primary"
            disabled={!connected || pending}
            onClick={() => void submit()}
          >
            {pending ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <FolderOpen size={15} />
            )}
            {pending ? "正在导入" : "选择本地文件"}
          </button>
        </div>
      ) : (
        <form onSubmit={(event) => void submit(event)}>
          {tab === "text" ? (
            <label className="field">
              材料名称
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="例如：产品讨论笔记"
              />
            </label>
          ) : null}
          <label className="field">
            {tab === "url" ? "网页地址" : "材料正文"}
            {tab === "url" ? (
              <input
                type="url"
                required
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder="https://…"
              />
            ) : (
              <textarea
                rows={7}
                required
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder="粘贴你的笔记、原文或补充背景…"
              />
            )}
          </label>
          {tab === "url" ? (
            <p className="field-hint">
              先读取当前可访问的内容。平台登录、收藏采集或视频全文按实际接入能力处理。
            </p>
          ) : null}
          <div className="modal-actions">
            <button
              className="button secondary"
              type="button"
              onClick={onClose}
            >
              取消
            </button>
            <button
              className="button primary"
              type="submit"
              disabled={!connected || pending || !value.trim()}
            >
              {pending ? "正在加入资料" : "加入这项工作"}
              <ArrowRight size={14} />
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [messageDetail, setMessageDetail] = useState<{
    taskId: string;
    id: string;
    title: string;
    content: string;
  } | null>(null);
  const [artifactFocus, setArtifactFocus] = useState<{
    taskId: string;
    artifactId: string;
  } | null>(null);
  const [connection, setConnection] = useState<
    "loading" | "connected" | "unavailable" | "failed"
  >(() => (window.ytriple ? "loading" : "unavailable"));
  const [page, setPage] = useState<Page>("work");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [sidebarPinned, setSidebarPinned] = useState(readPinnedSidebar);
  const [sidebarOpen, setSidebarOpen] = useState(readPinnedSidebar);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const selectedProject = snapshot?.projects.find(
    (item) => item.id === selectedProjectId,
  );
  const closeTransientSidebar = () => {
    if (!sidebarPinned) setSidebarOpen(false);
  };
  const togglePin = () => {
    const pinned = !sidebarPinned;
    setSidebarPinned(pinned);
    setSidebarOpen(true);
    try {
      window.localStorage.setItem(
        UI_PREFERENCES_KEY,
        JSON.stringify({ pinned }),
      );
    } catch {
      /* Navigation remains usable without storage. */
    }
  };
  const [focusRequest, setFocusRequest] = useState<{
    panel: WindowKind;
    sequence: number;
  }>({ panel: "main", sequence: 0 });
  const [evidenceTab, setEvidenceTab] = useState<"process" | "sources">(
    "process",
  );
  const initialSelectionLoaded = useRef(false);
  const composerDrafts = useRef(new Map<string, ComposerDraft>());
  const [dialog, setDialog] = useState<Dialog>(null);
  const [error, setError] = useState<string | null>(null);
  const [composerDraft, setComposerDraft] = useState<ComposerDraft>(() => ({
    ...EMPTY_DRAFT,
  }));
  useEffect(() => {
    composerDrafts.current.set(selectedTaskId ?? "new", composerDraft);
  }, [selectedTaskId, composerDraft]);
  const navigate = (next: Page) => {
    if (next === "work")
      setComposerDraft(
        composerDrafts.current.get(selectedTaskId ?? "new") ?? composerDraft,
      );
    setPage(next);
    closeTransientSidebar();
  };
  const [sourceDraft, setSourceDraft] = useState<ComposerDraft | null>(null);
  const [seedRevision, setSeedRevision] = useState(0);
  const [newWorkRevision, setNewWorkRevision] = useState(0);
  useEffect(() => {
    document.title = "ytriple · 工作台";
  }, []);
  const connected = connection === "connected";
  const task = snapshot?.tasks.find(
    (item) => item.id === selectedTaskId && !item.archivedAt && !item.deletedAt,
  );
  const linkedProjectId =
    task?.projectId ??
    task?.events.findLast((event) => event.type === "project.initialized")?.data
      ?.projectId;
  const linkedProject = snapshot?.projects.find(
    (project) => project.id === linkedProjectId,
  );
  const triple = snapshot?.desktop?.mode !== "single";
  const acceptSnapshot = useCallback((value: Snapshot) => {
    setSnapshot((current) => {
      const currentRevision = current?.desktop?.revision ?? -1;
      const incomingRevision = value.desktop?.revision ?? -1;
      return current && currentRevision > incomingRevision
        ? { ...value, desktop: current.desktop }
        : value;
    });
    if (!initialSelectionLoaded.current) {
      initialSelectionLoaded.current = true;
      if (value.desktop) {
        setSelectedTaskId(
          value.tasks.some(
            (task) =>
              task.id === value.desktop?.taskId &&
              !task.archivedAt &&
              !task.deletedAt,
          )
            ? value.desktop.taskId
            : null,
        );
        const restored = value.tasks.find(
          (item) =>
            item.id === value.desktop?.taskId &&
            !item.archivedAt &&
            !item.deletedAt,
        );
        if (restored)
          setComposerDraft((current) =>
            current.text
              ? current
              : (composerDrafts.current.get(restored.id) ?? {
                  text: "",
                  kind: restored.kind,
                  member: restored.member,
                  profileId: restored.profileId ?? "",
                }),
          );
      }
    }
    setConnection("connected");
  }, []);
  const dispatch = useCallback<Dispatch>(
    async (command: Command) => {
      if (!window.ytriple) {
        setError("桌面连接未接入。请在 ytriple 桌面应用中执行这项操作。");
        return null;
      }
      try {
        const result = await window.ytriple.invoke(command);
        if (
          command.type !== "project.browse" &&
          command.type !== "project.read"
        )
          acceptSnapshot(result);
        if (command.type === "task.archive" || command.type === "task.delete") {
          if (result.desktop?.taskId === command.taskId) {
            setSelectedTaskId(null);
            setComposerDraft({ ...EMPTY_DRAFT });
            void window.ytriple
              .invoke({ type: "window.select", taskId: null })
              .then(acceptSnapshot)
              .catch(() => {});
          }
          setMessageDetail((current) =>
            current?.taskId === command.taskId ? null : current,
          );
        }
        if (command.type === "message.save") {
          const artifactId = result.tasks
            .find((task) => task.id === command.taskId)
            ?.events.findLast(
              (event) =>
                event.type === "message.saved" &&
                event.data?.messageId === command.messageId,
            )?.data?.artifactId;
          if (typeof artifactId === "string") {
            setArtifactFocus({ taskId: command.taskId, artifactId });
            setMessageDetail(null);
          }
        }
        if (command.type === "process.save") {
          const artifactId = result.tasks
            .find((task) => task.id === command.taskId)
            ?.artifacts.at(-1)?.id;
          if (artifactId)
            setArtifactFocus({ taskId: command.taskId, artifactId });
        }
        if (command.type === "window.focus" || command.type === "window.open") {
          setPage("work");
          setFocusRequest((current) => ({
            panel: command.window,
            sequence: current.sequence + 1,
          }));
        }
        return result;
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : "操作未完成，请稍后重试。",
        );
        return null;
      }
    },
    [acceptSnapshot],
  );
  useEffect(() => {
    if (!window.ytriple) return;
    let active = true;
    const unsubscribe = window.ytriple.subscribe((value) => {
      if (active) {
        acceptSnapshot(value);
      }
    });
    void window.ytriple
      .invoke({ type: "snapshot" })
      .then((value) => {
        if (active) {
          acceptSnapshot(value);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setConnection("failed");
          setError(
            cause instanceof Error ? cause.message : "无法读取工作台状态。",
          );
        }
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [acceptSnapshot]);
  const closeDialog = useCallback(() => {
    setDialog(null);
    setSourceDraft(null);
  }, []);
  const newWork = useCallback(() => {
    if (page === "work")
      composerDrafts.current.set(selectedTaskId ?? "new", composerDraft);
    setSelectedTaskId(null);
    void dispatch({ type: "window.select", taskId: null });
    setPage("work");
    if (!sidebarPinned) setSidebarOpen(false);
    setComposerDraft({ ...EMPTY_DRAFT });
    setSeedRevision((value) => value + 1);
    setNewWorkRevision((value) => value + 1);
  }, [dispatch, composerDraft, selectedTaskId, sidebarPinned, page]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        newWork();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [newWork]);
  const selectTask = (id: string, created?: Task) => {
    const selected =
      created ??
      snapshot?.tasks.find(
        (item) => item.id === id && !item.archivedAt && !item.deletedAt,
      );
    if (!selected) return;
    if (page === "work")
      composerDrafts.current.set(selectedTaskId ?? "new", composerDraft);
    setSelectedTaskId(id);
    void dispatch({ type: "window.select", taskId: id });
    setPage("work");
    if (!sidebarPinned) setSidebarOpen(false);
    setComposerDraft(
      composerDrafts.current.get(id) ?? {
        text: "",
        kind: selected?.kind ?? "research",
        member: selected?.member ?? "coordinator",
        profileId: selected?.profileId ?? "",
      },
    );
    setSeedRevision((value) => value + 1);
  };
  const showDetail = (sourceTask: Task, message: Task["messages"][number]) => {
    if (selectedTaskId !== sourceTask.id || page !== "work")
      selectTask(sourceTask.id);
    setMessageDetail({
      taskId: sourceTask.id,
      id: message.id,
      title: `${memberName(message.member)} · 完整答复`,
      content: message.content,
    });
    void dispatch({ type: "window.rightMode", mode: "artifact" });
  };
  const showArtifact = (sourceTask: Task, artifactId: string) => {
    if (!sourceTask.artifacts.some((artifact) => artifact.id === artifactId)) {
      setError("这条成果引用暂不可用，请查看该次答复的完整内容。");
      return;
    }
    if (selectedTaskId !== sourceTask.id || page !== "work")
      selectTask(sourceTask.id);
    setMessageDetail(null);
    setArtifactFocus({ taskId: sourceTask.id, artifactId });
    void dispatch({ type: "window.rightMode", mode: "artifact" });
  };
  const createTask = async (
    goal: string,
    kind: TaskKind,
    member: MemberId,
    profileId?: string,
    run = true,
  ) => {
    const existingIds = new Set(snapshot?.tasks.map((item) => item.id) ?? []);
    const result = await dispatch({
      type: "task.create",
      goal,
      kind,
      member,
      ...(profileId ? { profileId } : {}),
    });
    const created = result?.tasks.find((item) => !existingIds.has(item.id));
    if (!created) return null;
    selectTask(created.id, created);
    if (run) await dispatch({ type: "task.run", taskId: created.id });
    return created;
  };
  const ensureTask = async () =>
    task ??
    createTask(
      sourceDraft?.text.trim() ||
        "理解并整理这次导入的资料，形成清楚、有依据的说明。",
      sourceDraft?.kind ?? "research",
      sourceDraft?.member ?? "coordinator",
      sourceDraft?.profileId || undefined,
      false,
    );
  const chooseDirection = (direction: (typeof DIRECTIONS)[number]) => {
    setComposerDraft((current) => ({
      ...current,
      text: direction.seed,
      kind: direction.kind,
    }));
    setSeedRevision((value) => value + 1);
  };
  const addSource = () => {
    setSourceDraft(!selectedTaskId ? { ...composerDraft } : null);
    if (page === "library") {
      setSelectedTaskId(null);
      void dispatch({ type: "window.select", taskId: null });
    }
    setDialog("source");
  };
  const statusMessage =
    connection === "unavailable"
      ? "当前为浏览器布局预览，桌面连接未接入。模型、文件和项目操作需在桌面应用中使用。"
      : connection === "failed"
        ? "暂时无法连接桌面服务，已有工作不会在这里被替换。"
        : connection === "loading"
          ? "正在读取本机工作空间…"
          : null;
  return (
    <div
      className={`app-shell integrated-shell ${triple ? "three-panel-layout" : "focused-layout"} ${sidebarOpen ? "sidebar-is-open" : ""} ${sidebarPinned ? "sidebar-is-pinned" : ""}`}
    >
      <Sidebar
        snapshot={snapshot}
        dispatch={dispatch}
        page={page}
        selectedTaskId={selectedTaskId}
        onPage={navigate}
        onTask={selectTask}
        onNew={newWork}
        connected={connected}
        collapsed={!sidebarOpen}
        pinned={sidebarPinned}
        onPin={togglePin}
        onClose={() => setSidebarOpen(false)}
      />
      <main className="main-shell">
        <header className="topbar">
          <div className="topbar-location">
            <button
              className="icon-button"
              aria-label={sidebarOpen ? "收起侧栏" : "展开侧栏"}
              onClick={() => setSidebarOpen(!sidebarOpen)}
            >
              <Menu size={17} />
            </button>
            <span className="breadcrumb">
              {
                {
                  work: "工作空间",
                  projects: "项目",
                  library: "本地 Lib",
                  models: "AI 模型",
                  team: "Agent 团队",
                  environment: "本机设置",
                }[page]
              }
            </span>
            <ChevronRight size={12} />
            <strong>
              {page === "work"
                ? (task?.title ?? "新的开始")
                : isSettingsPage(page)
                  ? (
                      {
                        models: "连接与能力",
                        team: "角色与协作",
                        environment: "目录与规则",
                      } as const
                    )[page as "models" | "team" | "environment"]
                  : "我的工作"}
            </strong>
          </div>
          <div className="topbar-actions">
            {page === "work" ? (
              <WorkspaceControls
                desktop={snapshot?.desktop}
                dispatch={dispatch}
              />
            ) : (
              <button className="text-button" onClick={() => navigate("work")}>
                回到工作区
                <ArrowUpRight size={13} />
              </button>
            )}
            <span className="topbar-local">
              <span className={`tiny-dot ${connected ? "green" : ""}`} />
              {connected ? "本机工作台" : "未连接"}
            </span>
          </div>
        </header>
        {statusMessage ? (
          <div
            className={`connection-banner ${connection === "loading" ? "loading" : ""}`}
            role="status"
          >
            {connection === "loading" ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <CircleAlert size={14} />
            )}
            <span>{statusMessage}</span>
            {connection === "failed" ? (
              <button
                className="text-button"
                onClick={() => void dispatch({ type: "snapshot" })}
              >
                重新连接
                <ArrowRight size={13} />
              </button>
            ) : null}
          </div>
        ) : null}
        <WorkspacePanels
          desktop={snapshot?.desktop}
          dispatch={dispatch}
          hidden={page !== "work"}
          focusRequest={focusRequest}
          decision={
            <section
              className={`decision-pane ${task ? "has-task" : "is-new"}`}
            >
              {task &&
              (task.status !== "completed" ||
                linkedProjectId ||
                task.kind === "project") ? (
                <div
                  className="decision-task-actions"
                  role="group"
                  aria-label="当前工作操作"
                >
                  <TaskControl
                    key={`control:${task.id}`}
                    task={task}
                    dispatch={dispatch}
                  />
                  {linkedProjectId ? (
                    <button
                      className="text-button"
                      disabled={!linkedProject}
                      onClick={() => {
                        setSelectedProjectId(String(linkedProjectId));
                        setPage("projects");
                      }}
                    >
                      <FolderOpen size={14} />
                      查看项目
                    </button>
                  ) : task.kind === "project" ? (
                    <button
                      className="text-button"
                      aria-label="将当前讨论创建为新项目"
                      onClick={() => setDialog("project")}
                    >
                      <FilePlus2 size={14} />
                      创建项目…
                    </button>
                  ) : null}
                </div>
              ) : null}
              {task ? (
                <Conversation
                  key={`conversation:${task.id}`}
                  task={task}
                  dispatch={dispatch}
                  onDetail={(message) => showDetail(task, message)}
                  onArtifact={(id) => showArtifact(task, id)}
                />
              ) : (
                <div className="welcome-scroll">
                  <div className="welcome">
                    <div className="welcome-kicker">
                      <span className="welcome-mark">
                        <Sparkles size={17} strokeWidth={1.5} />
                      </span>
                      为好奇留一点空间
                    </div>
                    <h1>
                      把一个想法，
                      <br />
                      变成可以继续的工作<span>。</span>
                    </h1>
                    <p className="welcome-description">
                      一起研究、理解和创造。
                      <br />
                      有用的判断与成果，都会留下来。
                    </p>
                    <div className="direction-list">
                      {DIRECTIONS.map((direction) => (
                        <button
                          className="direction"
                          key={direction.kind}
                          onClick={() => chooseDirection(direction)}
                        >
                          <span className={`direction-icon ${direction.kind}`}>
                            <direction.icon size={19} strokeWidth={1.55} />
                          </span>
                          <span>
                            <strong>{direction.label}</strong>
                            <small>{direction.description}</small>
                          </span>
                          <ArrowUpRight size={16} />
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
              <Composer
                key={`composer:${task?.id ?? `new-${newWorkRevision}`}`}
                task={task}
                snapshot={snapshot}
                connected={connected}
                dispatch={dispatch}
                onCreate={async (text, kind, member, profileId) => {
                  await createTask(text, kind, member, profileId);
                }}
                onAdd={addSource}
                draft={composerDraft}
                setDraft={setComposerDraft}
                seedRevision={seedRevision}
                onConfigure={() => setPage("models")}
              />
            </section>
          }
          evidence={
            <div className="evidence-workspace">
              <div className="evidence-toolbar">
                <div className="panel-tabs">
                  <button
                    className={evidenceTab === "process" ? "active" : ""}
                    onClick={() => setEvidenceTab("process")}
                  >
                    Agent 过程
                  </button>
                  <button
                    className={evidenceTab === "sources" ? "active" : ""}
                    onClick={() => setEvidenceTab("sources")}
                  >
                    资料 <span>{task?.sources.length ?? 0}</span>
                  </button>
                </div>
                {evidenceTab === "sources" ? (
                  <button className="text-button" onClick={addSource}>
                    <Plus size={13} />
                    添加资料
                  </button>
                ) : null}
              </div>
              {evidenceTab === "process" ? (
                task ? (
                  <ProcessView
                    task={task}
                    dispatch={dispatch}
                    onArtifactOpen={(id) => showArtifact(task, id)}
                  />
                ) : (
                  <div className="collection-empty pane-empty">
                    <Layers2 size={30} strokeWidth={1.3} />
                    <h2>看见团队怎样推进</h2>
                    <p>
                      从一项工作开始，成员分工、工具活动和公开工作摘要会在这里展开。
                    </p>
                  </div>
                )
              ) : (
                <SourceList
                  key={`sources:${task?.id ?? "new"}`}
                  sources={task?.sources ?? []}
                  dispatch={dispatch}
                  onAdd={addSource}
                />
              )}
            </div>
          }
          artifact={
            task ? (
              <ArtifactList
                key={`artifacts:${task.id}`}
                detail={
                  messageDetail?.taskId === task.id ? messageDetail : undefined
                }
                onCloseDetail={() => setMessageDetail(null)}
                onSaveDetail={async () => {
                  if (messageDetail)
                    await dispatch({
                      type: "message.save",
                      taskId: task.id,
                      messageId: messageDetail.id,
                    });
                }}
                preferredArtifactId={
                  artifactFocus?.taskId === task.id
                    ? artifactFocus.artifactId
                    : undefined
                }
                task={task}
                dispatch={dispatch}
              />
            ) : (
              <div className="collection-empty pane-empty">
                <FileText size={30} strokeWidth={1.3} />
                <h2>成果可以接着做</h2>
                <p>
                  文档与图示在这里产出。继续编辑、交给团队加工，或收藏到本地
                  Lib。
                </p>
              </div>
            )
          }
        />
        <div
          className={`settings-host ${!isSettingsPage(page) ? "workspace-hidden" : ""}`}
        >
          <Settings
            snapshot={snapshot}
            dispatch={dispatch}
            connected={connected}
            section={
              isSettingsPage(page)
                ? (page as "models" | "team" | "environment")
                : "models"
            }
            onOpenModels={() => setPage("models")}
          />
        </div>
        <ProjectWorkspace hidden={page !== "projects"}>
          <Projects
            snapshot={snapshot}
            dispatch={dispatch}
            onInitialize={() => setDialog("project")}
            onTask={selectTask}
            selectedProjectId={selectedProjectId}
            onSelectProject={(project) => setSelectedProjectId(project.id)}
            onDiscussProject={(project) => {
              setSelectedProjectId(project.id);
              requestAnimationFrame(() =>
                document
                  .querySelector<HTMLTextAreaElement>(
                    ".project-decision textarea",
                  )
                  ?.focus(),
              );
            }}
          />
          {page === "projects" ? (
            <ProjectDecision
              key={selectedProject?.id ?? "none"}
              project={selectedProject}
              snapshot={snapshot}
              dispatch={dispatch}
              connected={connected}
              drafts={composerDrafts.current}
              onOpenTask={selectTask}
              onDetail={showDetail}
              onArtifact={showArtifact}
              onConfigure={() => setPage("models")}
            />
          ) : null}
        </ProjectWorkspace>
        {page === "library" ? (
          <Library
            snapshot={snapshot}
            dispatch={dispatch}
            onTask={selectTask}
            onAdd={addSource}
            selectedTaskId={selectedTaskId}
          />
        ) : null}
      </main>
      {error ? (
        <div className="error-toast" role="alert">
          <CircleAlert size={18} />
          <div>
            <strong>操作未完成</strong>
            <p>{error}</p>
          </div>
          <button
            className="icon-button"
            aria-label="关闭提示"
            onClick={() => setError(null)}
          >
            <X size={16} />
          </button>
        </div>
      ) : null}
      {dialog === "source" ? (
        <SourceDialog
          connected={connected}
          dispatch={dispatch}
          ensureTask={ensureTask}
          onClose={closeDialog}
        />
      ) : dialog === "project" ? (
        <ProjectDialog
          task={task}
          connected={connected}
          dispatch={dispatch}
          onClose={closeDialog}
          onCreated={() => setPage("projects")}
        />
      ) : null}
    </div>
  );
}
