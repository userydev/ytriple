import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
  Radar as RadarIcon,
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
import {
  ArtifactList,
  SourceList,
  discardTaskArtifactDrafts,
} from "./Artifacts";
import { Settings } from "./Settings";
import { Library } from "./Library";
import { ProcessView } from "./ProcessView";
import {
  SkillPolicyPicker,
  TaskSkills,
  skillPolicyLabel,
  validSkillSelection,
} from "./Skills";
import { DEFAULT_SKILL_POLICY, type SkillPolicy } from "../shared/skills";
import { Projects } from "./Projects";
import { ProjectExplorer } from "./ProjectExplorer";
import {
  projectContextDocuments,
  projectDiscussionGoal,
  projectRequestText,
} from "../shared/project-context";
import { WorkbenchHome } from "./WorkbenchHome";
import { WorkSurface, type WorkContext } from "./WorkSurface";
import { Attention } from "./Attention";
import { ProjectSupport, type ProjectSection } from "./ProjectSupport";
import { MediaProjects } from "./MediaProjects";
import { DeliveryOverview } from "./Deliveries";
import { RoutinesPanel, TaskRoutineAction } from "./Routines";
import { TaskRemoteAction } from "./ServiceSettings";
import { Radar } from "./Radar";

import {
  Markdown,
  Modal,
  STATUS_NAMES,
  formatDate,
  formatTime,
  memberName,
  type Dispatch,
} from "./common";

type Page =
  | "home"
  | "work"
  | "radar"
  | "projects"
  | "library"
  | "models"
  | "team"
  | "environment"
  | "service"
  | "attention"
  | "deliveries"
  | "routines";
const isSettingsPage = (page: Page) =>
  ["models", "team", "environment", "service"].includes(page);
const UI_PREFERENCES_KEY = "ytriple.navigation.v2";
function readPinnedSidebar() {
  try {
    return (
      JSON.parse(window.localStorage.getItem(UI_PREFERENCES_KEY) ?? "{}")
        .pinned !== false
    );
  } catch {
    return true;
  }
}
type Dialog = "source" | "project" | null;
type ComposerDraft = {
  text: string;
  kind: TaskKind;
  member: MemberId;
  profileId: string;
  skillPolicy?: SkillPolicy;
};
const EMPTY_DRAFT: ComposerDraft = {
  text: "",
  kind: "research",
  member: "coordinator",
  profileId: "",
};

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
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [pending, setPending] = useState(false);
  const archived = Boolean(task.archivedAt || task.deletedAt);
  const menu = useRef<HTMLDetailsElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0 });
  const act = async (command: Command) => {
    if (pending) return;
    menu.current?.removeAttribute("open");
    setPending(true);
    const result = await dispatch(command);
    setPending(false);
    if (result) setRenaming(false);
  };
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: Event) => {
      if (
        event.type !== "pointerdown" ||
        !menu.current?.contains(event.target as Node)
      )
        menu.current?.removeAttribute("open");
    };
    document.addEventListener("pointerdown", close);
    window.addEventListener("resize", close);
    document.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", close);
      document.removeEventListener("scroll", close, true);
    };
  }, [menuOpen]);
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
            onKeyDown={(event) => {
              if (event.key === "Escape") setRenaming(false);
            }}
            autoFocus
            disabled={pending}
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
            disabled={pending}
            onClick={() => setRenaming(false)}
            aria-label="取消重命名"
          >
            <X size={13} />
          </button>
        </form>
      ) : (
        <>
          <button
            className={`${archived ? "archived-work-item" : "work-item"} ${active ? "active" : ""}`}
            onClick={() =>
              archived
                ? void act({ type: "task.restore", taskId: task.id })
                : onTask(task.id)
            }
            title={archived ? `恢复工作：${task.title}` : task.title}
            aria-label={archived ? `恢复工作：${task.title}` : task.title}
            disabled={pending}
          >
            <span className={`work-dot ${task.status}`} />
            <span className="work-title">{task.title}</span>
            {task.status === "running" ? (
              <LoaderCircle size={12} className="spin" />
            ) : null}
          </button>
          <details
            className="work-item-menu"
            name="task-actions"
            ref={menu}
            onToggle={(event) => {
              setMenuOpen(event.currentTarget.open);
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
              {!archived ? (
                <>
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
                </>
              ) : (
                <button
                  disabled={pending}
                  onClick={() =>
                    void act({ type: "task.restore", taskId: task.id })
                  }
                >
                  <RotateCcw size={13} />
                  恢复到最近工作
                </button>
              )}
              <button
                disabled={pending}
                className="destructive-menu-item"
                onClick={() => {
                  menu.current?.removeAttribute("open");
                  setConfirmingDelete(true);
                }}
              >
                <Trash2 size={13} />
                删除会话
              </button>
            </div>
          </details>
        </>
      )}
      {confirmingDelete ? (
        <Modal
          title="删除这段会话？"
          description="会话与过程记录将永久删除。已保存的成果、Lib 和项目文件保留。"
          onClose={() => {
            if (!pending) setConfirmingDelete(false);
          }}
        >
          <p className="delete-task-title">{task.title}</p>
          <div className="modal-actions">
            <button
              className="button secondary"
              disabled={pending}
              onClick={() => setConfirmingDelete(false)}
            >
              取消
            </button>
            <button
              className="button danger"
              disabled={pending}
              onClick={() => void act({ type: "task.delete", taskId: task.id })}
            >
              {pending ? "正在删除…" : "永久删除"}
            </button>
          </div>
        </Modal>
      ) : null}
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
    snapshot?.tasks.filter((task) => task.archivedAt || task.deletedAt) ?? [];

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
            { id: "home", label: "工作台", icon: Compass },
            { id: "radar", label: "雷达", icon: RadarIcon },
            { id: "projects", label: "项目", icon: Folder },
            { id: "library", label: "资产", icon: BookOpen },
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            className={
              page === item.id ||
              (item.id === "home" &&
                ["work", "attention", "deliveries", "routines"].includes(page))
                ? "active"
                : ""
            }
            onClick={() => onPage(item.id)}
          >
            <item.icon size={17} strokeWidth={1.7} />
            <span>{item.label}</span>
            {item.id === "radar" &&
            !snapshot?.radar?.editorial &&
            snapshot?.radar?.unreadCount ? (
              <span className="nav-count">{snapshot.radar.unreadCount}</span>
            ) : item.id === "home" &&
              snapshot?.attention?.notification.count ? (
              <span
                className="nav-count"
                title={snapshot.attention.notification.summary}
              >
                {snapshot.attention.notification.count}
              </span>
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
        {archived.length ? (
          <details className="work-history">
            <summary>
              <span>已归档</span>
              <span>{archived.length}</span>
            </summary>
            {archived.map((item) => (
              <TaskNavigationItem
                key={item.id}
                task={item}
                active={false}
                onTask={onTask}
                dispatch={dispatch}
              />
            ))}
          </details>
        ) : null}
        <button
          className={`settings-nav ${isSettingsPage(page) ? "active" : ""}`}
          onClick={() => onPage("models")}
        >
          <Settings2 size={16} />
          设置
        </button>
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
    skillPolicy?: SkillPolicy,
  ) => Promise<void>;
  onAdd: () => void;
  draft: ComposerDraft;
  setDraft: ReactDispatch<SetStateAction<ComposerDraft>>;
  seedRevision: number;
  onConfigure: () => void;
}) {
  const { text, member, profileId } = draft;
  const skillPolicy = draft.skillPolicy ?? DEFAULT_SKILL_POLICY;
  const validSkills =
    Boolean(task) || validSkillSelection(skillPolicy, snapshot?.skills ?? []);
  const [reviseGoal, setReviseGoal] = useState(false);
  const [sending, setSending] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (seedRevision > 0) textarea.current?.focus();
  }, [seedRevision]);
  const send = async () => {
    if (!text.trim() || !connected || sending || !validSkills) return;
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
      await onCreate(
        text.trim(),
        draft.kind,
        member,
        profileId || undefined,
        skillPolicy,
      );
    setSending(false);
  };
  const configured = snapshot?.profiles.some(
    (profile) => profile.hasKey && profile.modelId,
  );
  return (
    <div className="composer-area">
      {task && snapshot ? (
        <TaskSkills
          task={task}
          snapshot={snapshot}
          dispatch={dispatch}
          connected={connected}
        />
      ) : (
        <details className="work-skills" aria-label="新工作的 Skills">
          <summary>
            <BookOpen size={13} />
            <span>Skill · {skillPolicyLabel(skillPolicy)}</span>
            <ChevronDown size={12} />
          </summary>
          <SkillPolicyPicker
            policy={skillPolicy}
            catalog={snapshot?.skills ?? []}
            disabled={!connected || sending}
            onChange={(skillPolicy) =>
              setDraft((current) => ({ ...current, skillPolicy }))
            }
          />
        </details>
      )}
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
                    {item.id === "coordinator"
                      ? `团队 · ${task?.teamMode === "media" ? "主编" : "统筹"}`
                      : item.shortName}
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
            disabled={!connected || !text.trim() || sending || !validSkills}
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

function userMessageText(
  task: Task,
  message: Task["messages"][number],
): string {
  if (task.projectId && message.content.startsWith("围绕本机项目"))
    return projectRequestText(message.content);
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

const conversationPositions = new Map<
  string,
  { top: number; history: boolean }
>();

function Conversation({
  task,
  active = true,
  dispatch,
  onDetail,
  onArtifact,
}: {
  task: Task;
  active?: boolean;
  dispatch: Dispatch;
  onDetail?: (message: Task["messages"][number]) => void;
  onArtifact?: (artifactId: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [showHistory, setShowHistory] = useState(
    conversationPositions.get(task.id)?.history ?? false,
  );
  // Adding a source advances context without replacing the user's discussion.
  const displayedGoal = task.messages.some(
    (item) => item.goalVersion === task.goalVersion,
  )
    ? task.goalVersion
    : (task.messages.at(-1)?.goalVersion ?? task.goalVersion);
  const historyCount = task.messages.filter(
    (item) => item.goalVersion !== displayedGoal,
  ).length;
  const stickToBottom = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const lastMessage = task.messages.at(-1);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!active || !element) return;
    const saved = conversationPositions.get(task.id);
    element.scrollTop = saved?.top ?? 0;
    stickToBottom.current =
      !saved ||
      element.scrollHeight - element.scrollTop - element.clientHeight < 100;
  }, [task.id, active]);
  useEffect(() => {
    const element = scrollRef.current;
    if (!active || !element) return;
    // Only scroll this reading surface; hidden work must never move another page.
    if (stickToBottom.current && task.status === "running")
      element.scrollTop = element.scrollHeight;
    else if (!stickToBottom.current) setShowLatest(true);
  }, [lastMessage?.id, lastMessage?.content, task.status, active]);
  return (
    <div
      className="conversation-scroll"
      ref={scrollRef}
      onScroll={() => {
        const element = scrollRef.current;
        if (element && active) {
          conversationPositions.set(task.id, {
            top: element.scrollTop,
            history: showHistory,
          });
          stickToBottom.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            100;
          if (stickToBottom.current) setShowLatest(false);
        }
      }}
    >
      <div className="conversation-inner">
        <div className="task-overview">
          <details className="goal-details">
            <summary>
              <span>当前目标</span>
              <span className="goal-version">v{task.goalVersion}</span>
              <ChevronDown size={13} />
            </summary>
            <p>{task.goal}</p>
          </details>
          {task.status === "paused" &&
          task.events.some(
            (event) =>
              event.type === "library.changed" &&
              event.goalVersion === task.goalVersion,
          ) ? (
            <p className="inline-notice warning">
              相关 Lib
              已有修订或反馈。继续工作时，团队会依据更新重新判断；原成果已保留。
            </p>
          ) : null}
        </div>
        {!task.messages.length && !task.events.length ? (
          <div className="conversation-empty">
            <span className="empty-line" />
            <p>
              目标已记下。可以先补充资料，
              <br />
              准备好后让团队开始。
            </p>
          </div>
        ) : null}
        {historyCount ? (
          <button
            className="conversation-history-toggle"
            aria-expanded={showHistory}
            onClick={() => {
              const next = !showHistory;
              setShowHistory(next);
              conversationPositions.set(task.id, {
                top: scrollRef.current?.scrollTop ?? 0,
                history: next,
              });
            }}
          >
            此前讨论 · {historyCount}
            <ChevronDown size={13} />
          </button>
        ) : null}
        <div className="messages">
          {task.messages
            .filter(
              (message) => showHistory || message.goalVersion === displayedGoal,
            )
            .map((message) => {
              const report =
                message.role === "assistant"
                  ? decisionExcerpt(message.content)
                  : null;
              return (
                <article
                  className={`message ${message.role} ${message.goalVersion !== displayedGoal ? "superseded" : ""}`}
                  key={message.id}
                >
                  <div className="message-byline">
                    <span className={`message-avatar ${message.role}`}>
                      {message.role === "user" ? "Y" : <Layers2 size={14} />}
                    </span>
                    <strong>
                      {message.role === "user"
                        ? "你"
                        : memberName(message.member, task.teamMode)}
                    </strong>
                    <time dateTime={message.createdAt}>
                      {formatTime(message.createdAt)}
                    </time>
                    {message.goalVersion !== displayedGoal ? (
                      <span className="old-goal">
                        此前目标 v{message.goalVersion}
                      </span>
                    ) : null}
                  </div>
                  <div className="message-content">
                    {message.role === "assistant" ? (
                      <>
                        <Markdown
                          dispatch={dispatch}
                          onArtifactLink={onArtifact}
                        >
                          {report!.text}
                        </Markdown>
                        {report!.detailed && onDetail ? (
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
              );
            })}
        </div>
        {task.status === "running" || task.status === "waiting" ? (
          <div className="decision-progress-note">
            {task.status === "running" ? (
              <LoaderCircle size={13} className="spin" />
            ) : (
              <CircleAlert size={13} />
            )}
            {task.status === "running"
              ? "团队正在处理，可在过程里查看进展。"
              : "这项工作正在等待确认或补充。"}
          </div>
        ) : null}
        {task.error ? (
          <div className="task-error">
            <CircleAlert size={16} />
            <div>
              <strong>这一步需要处理</strong>
              <p>{task.error}</p>
            </div>
          </div>
        ) : null}
        <div ref={bottomRef} />
      </div>
      {showLatest ? (
        <button
          className="jump-latest"
          onClick={() => {
            if (scrollRef.current)
              scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
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
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
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
    if (result && mounted.current) onClose();
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
  const snapshotRef = useRef<Snapshot | null>(null);
  const [messageDetail, setMessageDetail] = useState<{
    taskId: string;
    id: string;
    title: string;
    content: string;
  } | null>(null);
  const messageDetailRef = useRef(messageDetail);
  messageDetailRef.current = messageDetail;
  const [artifactFocus, setArtifactFocus] = useState<{
    taskId: string;
    artifactId: string;
  } | null>(null);
  const [connection, setConnection] = useState<
    "loading" | "connected" | "unavailable" | "failed"
  >(() => (window.ytriple ? "loading" : "unavailable"));
  const navigationRevision = useRef(0);
  const [page, setCurrentPage] = useState<Page>("home");
  const setPage = useCallback((next: Page) => {
    navigationRevision.current += 1;
    setCurrentPage(next);
  }, []);
  const [projectSection, setProjectSection] =
    useState<ProjectSection>("software");
  const [mediaFocus, setMediaFocus] = useState<{
    channelId: string;
    workId: string;
    revision: number;
  }>();
  const openMediaWork = (channelId: string, workId: string) => {
    setMediaFocus({ channelId, workId, revision: Date.now() });
    setProjectSection("media");
    setPage("projects");
  };
  const openMediaSetup = () => {
    setProjectSection("media");
    setPage("projects");
  };
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const selectedTaskRef = useRef(selectedTaskId);
  selectedTaskRef.current = selectedTaskId;
  const [sidebarPinned, setSidebarPinned] = useState(readPinnedSidebar);
  const [sidebarOpen, setSidebarOpen] = useState(
    () => readPinnedSidebar() && window.innerWidth > 800,
  );
  useEffect(() => {
    let narrow = window.innerWidth <= 800;
    const resize = () => {
      const next = window.innerWidth <= 800;
      if (next !== narrow) {
        setSidebarOpen(!next && sidebarPinned);
        narrow = next;
      }
    };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [sidebarPinned]);
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
  const [contextTab, setContextTab] = useState<WorkContext>("artifact");
  const [workActions, setWorkActions] = useState(false);
  const [homeDraft, setHomeDraft] = useState<ComposerDraft>({ ...EMPTY_DRAFT });
  const [sourceTaskId, setSourceTaskId] = useState<string | null>(null);
  const sourcePrepared = useRef<Task | null>(null);
  const sourceSession = useRef(0);
  const [sourceDialogId, setSourceDialogId] = useState(0);
  const [workProjectId, setWorkProjectId] = useState<string | null>(null);
  const [sourceProject, setSourceProject] = useState<ProjectInfo | undefined>();
  const initialSelectionLoaded = useRef(false);
  const [libraryEntryId, setLibraryEntryId] = useState<string | null>(null);
  const composerDrafts = useRef(new Map<string, ComposerDraft>());
  const [dialog, setDialog] = useState<Dialog>(null);
  const [error, setError] = useState<string | null>(null);
  const [composerDraft, setComposerDraft] = useState<ComposerDraft>(() => ({
    ...EMPTY_DRAFT,
  }));
  const composerKey =
    selectedTaskId ?? (workProjectId ? `project:${workProjectId}:new` : "new");
  useEffect(() => {
    composerDrafts.current.set(composerKey, composerDraft);
  }, [composerKey, composerDraft]);
  const navigate = (next: Page) => {
    if (next === "work")
      setComposerDraft(
        composerDrafts.current.get(composerKey) ?? composerDraft,
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
  const workProject = snapshot?.projects.find(
    (project) => project.id === (linkedProjectId ?? workProjectId),
  );
  const projectTasks = workProject
    ? (snapshot?.tasks ?? [])
        .filter(
          (item) =>
            !item.archivedAt &&
            !item.deletedAt &&
            (item.projectId === workProject.id ||
              item.events.some(
                (event) =>
                  event.type === "project.initialized" &&
                  event.data?.projectId === workProject.id,
              )),
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    : [];

  const acceptSnapshot = useCallback((value: Snapshot) => {
    const current = snapshotRef.current;
    const next =
      current &&
      (current.desktop?.revision ?? -1) > (value.desktop?.revision ?? -1)
        ? { ...value, desktop: current.desktop }
        : value;
    snapshotRef.current = next;
    setSnapshot(next);
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
          if (selectedTaskRef.current === command.taskId) {
            selectedTaskRef.current = null;
            setSelectedTaskId(null);
            setComposerDraft({ ...EMPTY_DRAFT });
            if (result.desktop?.taskId === command.taskId)
              void window.ytriple
                .invoke({ type: "window.select", taskId: null })
                .then(acceptSnapshot)
                .catch(() => {});
          }
          if (command.type === "task.delete") {
            composerDrafts.current.delete(command.taskId);
            discardTaskArtifactDrafts(command.taskId);
          }
          setArtifactFocus((current) =>
            current?.taskId === command.taskId ? null : current,
          );
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
          if (
            typeof artifactId === "string" &&
            selectedTaskRef.current === command.taskId &&
            messageDetailRef.current?.taskId === command.taskId &&
            messageDetailRef.current.id === command.messageId
          ) {
            setArtifactFocus({ taskId: command.taskId, artifactId });
            setMessageDetail((current) =>
              current?.taskId === command.taskId &&
              current.id === command.messageId
                ? null
                : current,
            );
          }
        }
        if (command.type === "process.save") {
          const artifactId = result.tasks
            .find((task) => task.id === command.taskId)
            ?.artifacts.at(-1)?.id;
          if (artifactId) {
            setArtifactFocus({ taskId: command.taskId, artifactId });
            setContextTab("artifact");
          }
        }
        if (command.type === "window.focus" || command.type === "window.open") {
          setPage("work");
          if (command.window !== "main")
            setContextTab(
              command.window === "artifact" ? "artifact" : "process",
            );
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
    navigationRevision.current += 1;
    sourceSession.current += 1;
    setDialog(null);
    setSourceDraft(null);
  }, []);
  const newWork = useCallback(() => {
    if (page === "work") composerDrafts.current.set(composerKey, composerDraft);
    setSelectedTaskId(null);
    setWorkProjectId(null);
    void dispatch({ type: "window.select", taskId: null });
    setPage("home");
    if (!sidebarPinned) setSidebarOpen(false);
    setSeedRevision((value) => value + 1);
    setNewWorkRevision((value) => value + 1);
  }, [
    dispatch,
    composerDraft,
    selectedTaskId,
    composerKey,
    sidebarPinned,
    page,
  ]);
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
      snapshotRef.current?.tasks.find(
        (item) => item.id === id && !item.archivedAt && !item.deletedAt,
      );
    if (!selected) return;
    if (page === "work") composerDrafts.current.set(composerKey, composerDraft);
    setSelectedTaskId(id);
    setWorkProjectId(
      selected.projectId ??
        (selected.events.findLast(
          (event) => event.type === "project.initialized",
        )?.data?.projectId as string | undefined) ??
        null,
    );
    void dispatch({ type: "window.select", taskId: id });
    void dispatch({ type: "window.expand", window: null });
    setPage("work");
    setContextTab("artifact");
    setFocusRequest((current) => ({
      panel: "main",
      sequence: current.sequence + 1,
    }));
    setWorkActions(false);
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
  const openProject = (project: ProjectInfo, intent?: "understand" | "new") => {
    if (page === "work") composerDrafts.current.set(composerKey, composerDraft);
    setSelectedProjectId(project.id);
    setWorkProjectId(project.id);
    const related = (snapshotRef.current?.tasks ?? [])
      .filter(
        (item) =>
          !item.archivedAt &&
          !item.deletedAt &&
          (item.projectId === project.id ||
            item.events.some(
              (event) =>
                event.type === "project.initialized" &&
                event.data?.projectId === project.id,
            )),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (!intent && related[0]) selectTask(related[0].id);
    else {
      setSelectedTaskId(null);
      void dispatch({ type: "window.select", taskId: null });
      const key = `project:${project.id}:new`;
      const stored = composerDrafts.current.get(key);
      setComposerDraft(
        stored
          ? stored
          : {
              ...EMPTY_DRAFT,
              kind: "project",
              text:
                intent === "understand"
                  ? "阅读项目正式资料，梳理目标、当前状态、已完成与未验证的工作、阻塞和下一步。给出可追溯依据，并保存项目状态说明。"
                  : "",
            },
      );
      setPage("work");
      setSeedRevision((value) => value + 1);
    }
    setContextTab("project");
    setFocusRequest((current) => ({
      panel: "main",
      sequence: current.sequence + 1,
    }));
    setWorkActions(false);
    closeTransientSidebar();
  };
  const showDetail = (sourceTask: Task, message: Task["messages"][number]) => {
    if (selectedTaskId !== sourceTask.id || page !== "work")
      selectTask(sourceTask.id);
    setMessageDetail({
      taskId: sourceTask.id,
      id: message.id,
      title: `${memberName(message.member, sourceTask.teamMode)} · 完整答复`,
      content: message.content,
    });
    setContextTab("artifact");
    setFocusRequest((current) => ({
      panel: "artifact",
      sequence: current.sequence + 1,
    }));
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
    setContextTab("artifact");
    setFocusRequest((current) => ({
      panel: "artifact",
      sequence: current.sequence + 1,
    }));
  };
  const createTask = async (
    goal: string,
    kind: TaskKind,
    member: MemberId,
    profileId?: string,
    skillPolicy?: SkillPolicy,
    run = true,
    project?: ProjectInfo,
  ) => {
    const submittedNavigation = navigationRevision.current;
    const requestId = crypto.randomUUID();
    const existingIds = new Set(
      snapshotRef.current?.tasks.map((item) => item.id) ?? [],
    );
    const submittedDraft = project ? composerDraft : undefined;
    const taskGoal = project ? projectDiscussionGoal(project, goal) : goal;
    const preparedSources: { title: string; text: string }[] = [];
    if (project) {
      for (const doc of projectContextDocuments(project)) {
        const read = await dispatch({
          type: "project.read",
          projectId: project.id,
          worktreePath: doc.worktreePath,
          path: doc.path,
        });
        const browser = read?.projectBrowser,
          preview = browser?.preview;
        if (
          !browser ||
          browser.projectId !== project.id ||
          browser.worktreePath !== doc.worktreePath ||
          preview?.path !== doc.path ||
          !preview.content?.trim()
        ) {
          setError(
            `未能读取项目资料「${doc.path}」：${browser?.error ?? preview?.reason ?? "没有取得对应正文"}。工作尚未启动，输入已保留，可检查文件后重试。`,
          );
          return null;
        }
        preparedSources.push({
          title: `${project.name} / ${doc.path}`,
          text: `项目正式资料：${doc.absolutePath}\n读取时间：${new Date().toISOString()}${preview.truncated ? "；文件较长，以下仅为可预览部分" : ""}\n\n${preview.content}`,
        });
      }
    }
    const result = await dispatch({
      type: "task.create",
      requestId,
      ...(project
        ? {
            projectId: project.id,
            title: `${project.name} · ${goal.startsWith("阅读项目正式资料，梳理目标") ? "项目状态理解" : goal.slice(0, 35)}`,
          }
        : {}),
      goal: taskGoal,
      kind,
      member,
      skillPolicy: skillPolicy ?? DEFAULT_SKILL_POLICY,
      ...(profileId ? { profileId } : {}),
    });
    const created =
      result?.tasks.find((item) => item.requestId === requestId) ??
      result?.tasks.find(
        (item) =>
          !existingIds.has(item.id) &&
          item.goal === taskGoal &&
          item.kind === kind &&
          item.member === member,
      );
    if (!created) return null;
    let prepared = created;
    const stillPreparing = () => {
      const current = snapshotRef.current?.tasks.find(
        (item) => item.id === created.id,
      );
      return (
        current &&
        !current.archivedAt &&
        !current.deletedAt &&
        current.goalVersion === prepared.goalVersion &&
        !["running", "waiting"].includes(current.status)
      );
    };
    for (const source of preparedSources) {
      if (!stillPreparing()) {
        setError(
          "这项工作在准备资料期间已发生变化，已停止自动加入和启动。请在原工作确认下一步。",
        );
        return prepared;
      }
      const priorVersion = prepared.goalVersion;
      const priorMessages = JSON.stringify(
        prepared.messages
          .filter((message) => message.role === "user")
          .map((message) => [message.id, message.content]),
      );
      const attached = await dispatch({
        type: "source.addText",
        taskId: created.id,
        expectedGoalVersion: priorVersion,
        ...source,
      });
      const next = attached?.tasks.find((item) => item.id === created.id);
      if (!next) return prepared;
      const nextMessages = JSON.stringify(
        next.messages
          .filter((message) => message.role === "user")
          .map((message) => [message.id, message.content]),
      );
      if (
        (next.goalVersion !== priorVersion &&
          next.goalVersion !== priorVersion + 1) ||
        nextMessages !== priorMessages ||
        ["running", "waiting"].includes(next.status)
      ) {
        setError(
          "项目资料准备期间收到了新的工作要求，已停止自动启动，请在该工作中继续。",
        );
        return next;
      }
      prepared = next;
    }
    if (navigationRevision.current === submittedNavigation)
      selectTask(created.id, prepared);
    if (project) {
      const draftKey = `project:${project.id}:new`;
      if (composerDrafts.current.get(draftKey) === submittedDraft)
        composerDrafts.current.delete(draftKey);
    }
    if (run && (!project || stillPreparing()))
      await dispatch({ type: "task.run", taskId: created.id });
    return prepared;
  };
  const ensureTask = async () => {
    const existing =
      snapshotRef.current?.tasks.find((item) => item.id === sourceTaskId) ??
      sourcePrepared.current;
    if (existing) return existing;
    const created = await createTask(
      sourceDraft?.text.trim() ||
        "理解并整理这次导入的资料，形成清楚、有依据的说明。",
      sourceDraft?.kind ?? "research",
      sourceDraft?.member ?? "coordinator",
      sourceDraft?.profileId || undefined,
      sourceDraft?.skillPolicy,
      false,
      sourceProject,
    );
    if (sourceSession.current === sourceDialogId)
      sourcePrepared.current = created;
    return created;
  };
  const addSource = () => {
    sourceSession.current += 1;
    setSourceDialogId(sourceSession.current);
    sourcePrepared.current = null;
    setSourceTaskId(page === "work" ? selectedTaskId : null);
    setSourceProject(page === "work" ? workProject : undefined);
    setSourceDraft(
      page === "home"
        ? { ...homeDraft }
        : !selectedTaskId
          ? { ...composerDraft }
          : null,
    );
    setDialog("source");
  };
  const openTaskArtifact = (taskId: string, artifactId: string) => {
    const owner = snapshotRef.current?.tasks.find((item) => item.id === taskId);
    if (owner) showArtifact(owner, artifactId);
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
      className={`app-shell integrated-shell ${page === "radar" ? "radar-mode" : ""} product-shell ${sidebarOpen ? "sidebar-is-open" : ""} ${sidebarPinned ? "sidebar-is-pinned" : ""}`}
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
              <Menu size={18} />
            </button>
            {page === "radar" ? (
              <div id="radar-page-header" />
            ) : (
              <>
                {page === "work" ||
                ["attention", "deliveries", "routines"].includes(page) ? (
                  <>
                    <button
                      className="breadcrumb"
                      onClick={() => navigate("home")}
                    >
                      工作台
                    </button>
                    <ChevronRight size={13} />
                  </>
                ) : null}
                <h1 className="location-title">
                  {
                    {
                      home: "工作台",
                      work: workProject?.name ?? task?.title ?? "新工作",
                      projects: "项目",
                      library: "资产",
                      models: "设置",
                      team: "设置",
                      environment: "设置",
                      service: "设置",
                      attention: "待我处理",
                      deliveries: "交付",
                      routines: "例行工作",
                      radar: "雷达",
                    }[page]
                  }
                </h1>
              </>
            )}
          </div>
          {page === "work" && task ? (
            <div className="topbar-actions">
              <Status task={task} />
              <button
                className="icon-button"
                aria-label="工作操作"
                aria-expanded={workActions}
                onClick={() => setWorkActions(!workActions)}
              >
                <MoreHorizontal size={19} />
              </button>
            </div>
          ) : null}
        </header>
        {page === "work" && workProject ? (
          <div className="project-work-context">
            <button
              className="text-button"
              onClick={() => {
                setProjectSection("software");
                navigate("projects");
              }}
            >
              <ChevronRight size={14} className="back-chevron" />
              所有项目
            </button>
            <label htmlFor="project-work-choice">当前工作</label>
            <select
              id="project-work-choice"
              value={task?.id ?? ""}
              onChange={(event) =>
                event.target.value
                  ? selectTask(event.target.value)
                  : openProject(workProject, "new")
              }
            >
              <option value="">新的项目工作</option>
              {projectTasks.map((item) => (
                <option key={item.id} value={item.id}>
                  {STATUS_NAMES[item.status]} / {item.title}
                </option>
              ))}
            </select>
            <button
              className="button secondary"
              onClick={() => openProject(workProject, "new")}
            >
              <Plus size={14} />
              新工作
            </button>
          </div>
        ) : null}
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
        <div className="home-host" hidden={page !== "home"}>
          <WorkbenchHome
            snapshot={snapshot}
            onTask={selectTask}
            onPage={navigate}
            onProject={(project) => openProject(project)}
            onMedia={openMediaWork}
          >
            <Composer
              snapshot={snapshot}
              connected={connected}
              dispatch={dispatch}
              draft={homeDraft}
              setDraft={setHomeDraft}
              seedRevision={page === "home" ? seedRevision : 0}
              onAdd={addSource}
              onConfigure={() => navigate("models")}
              onCreate={async (...args) => {
                const created = await createTask(...args);
                if (created)
                  setHomeDraft((current) =>
                    current === homeDraft ? { ...EMPTY_DRAFT } : current,
                  );
              }}
            />
          </WorkbenchHome>
        </div>
        <WorkSurface
          desktop={snapshot?.desktop}
          dispatch={dispatch}
          hidden={page !== "work"}
          focusRequest={focusRequest}
          context={contextTab}
          onContext={setContextTab}
          sourceCount={task?.sources.length ?? 0}
          project={
            workProject ? (
              <Projects
                overviewOnly
                hideHeading
                snapshot={snapshot}
                dispatch={dispatch}
                onInitialize={() => setDialog("project")}
                onTask={selectTask}
                selectedProjectId={workProject.id}
                onSelectProject={(project) => openProject(project)}
                onArtifact={openTaskArtifact}
                onDiscussProject={openProject}
                onShowFiles={() => {
                  setContextTab("files");
                  setFocusRequest((current) => ({
                    panel: "artifact",
                    sequence: current.sequence + 1,
                  }));
                }}
              />
            ) : undefined
          }
          files={
            workProject ? (
              <ProjectExplorer
                projectOnly
                snapshot={snapshot}
                dispatch={dispatch}
                selectedProjectId={workProject.id}
                onSelectProject={(project) => openProject(project)}
                onDiscussProject={(project) => openProject(project, "new")}
              />
            ) : undefined
          }
          decision={
            <section className="decision-pane has-task">
              {task && task.status !== "completed" ? (
                <div className="work-state-actions">
                  <TaskControl task={task} dispatch={dispatch} />
                </div>
              ) : null}
              {task ? (
                <Conversation
                  key={`conversation:${task.id}`}
                  active={page === "work"}
                  task={task}
                  dispatch={dispatch}
                  onDetail={(message) => showDetail(task, message)}
                  onArtifact={(id) => showArtifact(task, id)}
                />
              ) : (
                <div className="work-empty">
                  <h2>{workProject ? "从当前项目继续推进" : "开始一项工作"}</h2>
                  <p>
                    {workProject
                      ? projectContextDocuments(workProject).length
                        ? `提出要解决的问题。发送时带入 ${projectContextDocuments(workProject).length} 份已登记的项目正式资料。`
                        : "尚无可自动读取的项目正式资料。可以先查看文件，或添加资料后与团队讨论。"
                      : "写下目标或导入资料，与团队一起完成。"}
                  </p>
                  {workProject ? (
                    <button
                      className="text-button"
                      onClick={() => {
                        setContextTab("files");
                        setFocusRequest((current) => ({
                          panel: "artifact",
                          sequence: current.sequence + 1,
                        }));
                      }}
                    >
                      查看项目资料
                      <ArrowRight size={14} />
                    </button>
                  ) : null}
                </div>
              )}
              <Composer
                key={`composer:${task?.id ?? `${workProject?.id ?? "new"}-${newWorkRevision}`}`}
                task={task}
                snapshot={snapshot}
                connected={connected}
                dispatch={dispatch}
                onCreate={async (
                  text,
                  kind,
                  member,
                  profileId,
                  skillPolicy,
                ) => {
                  await createTask(
                    text,
                    workProject ? "project" : kind,
                    member,
                    profileId,
                    skillPolicy,
                    true,
                    workProject,
                  );
                }}
                onAdd={addSource}
                draft={composerDraft}
                setDraft={setComposerDraft}
                seedRevision={page === "work" ? seedRevision : 0}
                onConfigure={() => setPage("models")}
              />
            </section>
          }
          process={
            task ? (
              <ProcessView
                task={task}
                dispatch={dispatch}
                onArtifactOpen={(id) => showArtifact(task, id)}
              />
            ) : null
          }
          sources={
            <SourceList
              key={`sources:${task?.id ?? "new"}`}
              sources={task?.sources ?? []}
              dispatch={dispatch}
              onAdd={addSource}
              onLibrary={(entryId) => {
                setLibraryEntryId(entryId);
                navigate("library");
              }}
            />
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
                snapshot={snapshot ?? undefined}
                onTask={selectTask}
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
        {page === "radar" ? (
          <Radar
            snapshot={snapshot}
            dispatch={dispatch}
            connected={connected}
            onTask={selectTask}
            onMediaCreated={openMediaWork}
            onMediaSetup={openMediaSetup}
          />
        ) : null}
        <div
          className={`settings-host ${!isSettingsPage(page) ? "workspace-hidden" : ""}`}
        >
          <Settings
            snapshot={snapshot}
            dispatch={dispatch}
            connected={connected}
            section={
              isSettingsPage(page)
                ? (page as "models" | "team" | "environment" | "service")
                : "models"
            }
            onSectionChange={(section) => setPage(section)}
            onOpenModels={() => setPage("models")}
            onTask={selectTask}
          />
        </div>
        {page === "projects" ? (
          <ProjectSupport
            snapshot={snapshot}
            section={projectSection}
            onSection={setProjectSection}
          />
        ) : null}
        <div
          className="project-feature-page"
          hidden={page !== "projects" || projectSection !== "software"}
        >
          <Projects
            snapshot={snapshot}
            dispatch={dispatch}
            onInitialize={() => setDialog("project")}
            onTask={selectTask}
            selectedProjectId={null}
            onSelectProject={(project) => openProject(project)}
            onClearSelection={() => setSelectedProjectId(null)}
            onArtifact={openTaskArtifact}
            onDiscussProject={openProject}
          />
        </div>
        {snapshot ? (
          <>
            <div
              className="project-feature-page"
              hidden={page !== "projects" || projectSection !== "media"}
            >
              <MediaProjects
                active={page === "projects" && projectSection === "media"}
                snapshot={snapshot}
                dispatch={dispatch}
                onTask={selectTask}
                focus={mediaFocus}
                onArtifact={openTaskArtifact}
              />
            </div>
            <div
              className="project-feature-page"
              hidden={page !== "deliveries"}
            >
              <DeliveryOverview
                snapshot={snapshot}
                dispatch={dispatch}
                onTask={selectTask}
              />
            </div>
            <div className="project-feature-page" hidden={page !== "routines"}>
              <RoutinesPanel
                snapshot={snapshot}
                dispatch={dispatch}
                onTask={selectTask}
              />
            </div>
          </>
        ) : null}
        {page === "attention" ? (
          <div className="support-page">
            <Attention
              snapshot={snapshot}
              dispatch={dispatch}
              onTask={selectTask}
              onSection={navigate}
              onService={() => navigate("service")}
              standalone
            />
          </div>
        ) : null}
        {workActions && task && snapshot ? (
          <Modal
            title="工作操作"
            description={task.title}
            onClose={() => setWorkActions(false)}
          >
            <div className="work-action-options">
              {linkedProjectId ? (
                <button
                  className="button secondary"
                  disabled={!linkedProject}
                  onClick={() => {
                    setWorkActions(false);
                    setSelectedProjectId(String(linkedProjectId));
                    setProjectSection("software");
                    navigate("projects");
                  }}
                >
                  <FolderOpen size={15} />
                  查看所属项目
                </button>
              ) : task.kind === "project" ? (
                <button
                  className="button secondary"
                  onClick={() => {
                    setWorkActions(false);
                    setDialog("project");
                  }}
                >
                  <FilePlus2 size={15} />
                  将讨论创建为项目
                </button>
              ) : null}
              <TaskRoutineAction
                task={task}
                snapshot={snapshot}
                dispatch={dispatch}
              />
              <TaskRemoteAction
                key={task.id}
                task={task}
                snapshot={snapshot}
                dispatch={dispatch}
                onTask={(id) => {
                  setWorkActions(false);
                  selectTask(id);
                }}
              />
            </div>
          </Modal>
        ) : null}
        {page === "library" ? (
          <Library
            key={`${snapshot?.settings.aiRoot}:${libraryEntryId}`}
            initialEntryId={libraryEntryId}
            snapshot={snapshot}
            dispatch={dispatch}
            onTask={selectTask}
            onMediaCreated={openMediaWork}
            onMediaSetup={openMediaSetup}
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
          key={sourceDialogId}
          connected={connected}
          dispatch={dispatch}
          ensureTask={ensureTask}
          onClose={() => {
            if (sourceSession.current === sourceDialogId) closeDialog();
          }}
        />
      ) : dialog === "project" ? (
        <ProjectDialog
          task={page === "work" ? task : undefined}
          connected={connected}
          dispatch={dispatch}
          onClose={closeDialog}
          onCreated={() => setPage("projects")}
        />
      ) : null}
    </div>
  );
}
