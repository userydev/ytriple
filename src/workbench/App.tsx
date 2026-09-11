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
  MessageSquare,
  PanelRight,
  Pause,
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
  type Snapshot,
  type Task,
  type TaskKind,
} from "../shared/types";
import { ArtifactList, ContextPanel, SourceList } from "./Artifacts";
import { Settings } from "./Settings";
import {
  Markdown,
  Modal,
  STATUS_NAMES,
  formatDate,
  formatTime,
  memberName,
  type Dispatch,
} from "./common";

type Page = "work" | "projects" | "library" | "settings";
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
const QUERY = new URLSearchParams(window.location.search);
const AUXILIARY =
  QUERY.get("window") === "artifact" || QUERY.get("window") === "evidence"
    ? (QUERY.get("window") as "artifact" | "evidence")
    : null;
const INITIAL_TASK_ID = QUERY.get("taskId");
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
          ? "停止"
          : task.status === "idle"
            ? "开始"
            : "继续"}
    </button>
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
}) {
  return (
    <aside className={`sidebar ${collapsed ? "sidebar-hidden" : ""}`}>
      <div className="sidebar-brand">
        <Logo />
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
            { id: "library", label: "资料与知识", icon: BookOpen },
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
        {snapshot?.tasks.length ? <span>{snapshot.tasks.length}</span> : null}
      </div>
      <div className="work-list">
        {snapshot?.tasks.length ? (
          [...snapshot.tasks]
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .map((task) => (
              <button
                className={`work-item ${page === "work" && selectedTaskId === task.id ? "active" : ""}`}
                key={task.id}
                onClick={() => onTask(task.id)}
              >
                <span className={`work-dot ${task.status}`} />
                <span className="work-title">{task.title}</span>
                {task.status === "running" ? (
                  <LoaderCircle size={12} className="spin" />
                ) : null}
              </button>
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
        <div className="workspace-stamp">
          <span className="workspace-monogram">Y</span>
          <div>
            <strong>我的工作空间</strong>
            <span>
              <span className={`tiny-dot ${connected ? "green" : ""}`} />
              {connected ? "本机 · 前台运行" : "桌面连接未接入"}
            </span>
          </div>
        </div>
        <button
          className={`settings-nav ${page === "settings" ? "active" : ""}`}
          onClick={() => onPage("settings")}
        >
          <Settings2 size={16} />
          设置与连接
          <ChevronRight size={14} />
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

function Conversation({ task, dispatch }: { task: Task; dispatch: Dispatch }) {
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
  const currentEvents = task.events.filter(
    (event) => event.goalVersion === task.goalVersion,
  );
  const contributions = Array.from(
    new Set(
      currentEvents
        .map((event) => event.member)
        .filter((member): member is MemberId => Boolean(member)),
    ),
  );
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
                  <Markdown dispatch={dispatch}>{message.content}</Markdown>
                ) : (
                  <p>{message.content}</p>
                )}
              </div>
            </article>
          ))}
        </div>
        {task.events.length ? (
          <div className="activity-summary">
            <div className="activity-heading">
              {task.status === "running" ? (
                <LoaderCircle size={14} className="spin" />
              ) : task.status === "failed" ? (
                <CircleAlert size={14} />
              ) : (
                <Layers2 size={14} />
              )}
              <strong>
                {task.status === "running" ? "团队正在推进" : "这项工作的进展"}
              </strong>
              {contributions.length ? (
                <span>{contributions.map(memberName).join(" · ")}</span>
              ) : null}
            </div>
            <p>{currentEvents.at(-1)?.summary ?? lastEvent?.summary}</p>
            <details className="activity-details">
              <summary>
                查看协作记录<span>{task.events.length}</span>
                <ChevronDown size={12} />
              </summary>
              <ol>
                {task.events.slice(-50).map((event) => (
                  <li
                    key={event.id}
                    className={
                      event.goalVersion !== task.goalVersion
                        ? "superseded-event"
                        : ""
                    }
                  >
                    <time>{formatTime(event.createdAt)}</time>
                    <div>
                      {event.member ? (
                        <strong>{memberName(event.member)}</strong>
                      ) : null}
                      <span>{event.summary}</span>
                      {event.goalVersion !== task.goalVersion ? (
                        <small>此前目标 v{event.goalVersion}</small>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ol>
              {task.events.length > 50 ? (
                <p className="muted small-text">当前显示最近 50 条记录。</p>
              ) : null}
            </details>
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
          <button type="button" className="button secondary" onClick={onClose}>
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

function Projects({
  snapshot,
  dispatch,
  onInitialize,
  onTask,
}: {
  snapshot: Snapshot | null;
  dispatch: Dispatch;
  onInitialize: () => void;
  onTask: (id: string) => void;
}) {
  const projectTasks =
    snapshot?.tasks.filter((task) => task.kind === "project") ?? [];
  return (
    <div className="collection-page">
      <div className="page-heading">
        <span className="eyebrow">PROJECTS</span>
        <div className="heading-with-action">
          <h1>让想法走向实践</h1>
          <button className="button primary" onClick={onInitialize}>
            <Plus size={15} />
            初始化项目
          </button>
        </div>
        <p>在这里讨论、准备，再交给专业工具继续。</p>
      </div>
      {snapshot?.projects.length ? (
        <div className="project-list">
          {snapshot.projects.map((project) => (
            <article className="project-row" key={project.id}>
              <div className="project-symbol">
                <Folder size={23} strokeWidth={1.4} />
              </div>
              <div className="project-row-content">
                <div>
                  <h3>{project.name}</h3>
                  <span className="series-label">{project.series}</span>
                </div>
                <code>{project.root}</code>
                <div className="project-documents">
                  {Object.entries(project.documents).map(([name, path]) =>
                    path ? (
                      <button
                        className="text-button"
                        key={name}
                        onClick={() =>
                          void dispatch({ type: "path.reveal", path })
                        }
                      >
                        <FileText size={12} />
                        {name}
                      </button>
                    ) : null,
                  )}
                </div>
              </div>
              <button
                className="icon-button"
                aria-label={`打开 ${project.name} 开发目录`}
                title="打开开发目录"
                onClick={() =>
                  void dispatch({ type: "path.reveal", path: project.devPath })
                }
              >
                <ArrowUpRight size={18} />
              </button>
            </article>
          ))}
        </div>
      ) : (
        <div className="collection-empty">
          <div className="large-line-icon">
            <Sprout size={49} strokeWidth={1.1} />
          </div>
          <h2>每个项目，都从一个想法开始</h2>
          <p>
            准备好产品雏形和需求，
            <br />
            团队会建立规则、文档与开发目录。
          </p>
          <button className="button secondary" onClick={onInitialize}>
            准备第一个项目
            <ArrowRight size={14} />
          </button>
        </div>
      )}
      {projectTasks.length ? (
        <section className="related-work">
          <h3>相关讨论</h3>
          {projectTasks.map((task) => (
            <button
              className="related-task"
              key={task.id}
              onClick={() => onTask(task.id)}
            >
              <MessageSquare size={15} />
              <span>{task.title}</span>
              <Status task={task} />
              <ArrowUpRight size={14} />
            </button>
          ))}
        </section>
      ) : null}
    </div>
  );
}

function Library({
  snapshot,
  dispatch,
  onTask,
  onAdd,
}: {
  snapshot: Snapshot | null;
  dispatch: Dispatch;
  onTask: (id: string) => void;
  onAdd: () => void;
}) {
  const [search, setSearch] = useState("");
  const sources =
    snapshot?.tasks.flatMap((task) =>
      task.sources.map((source) => ({ source, task })),
    ) ?? [];
  const filtered = sources.filter(({ source }) =>
    `${source.title} ${source.text}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <div className="collection-page">
      <div className="page-heading">
        <span className="eyebrow">LIBRARY</span>
        <div className="heading-with-action">
          <h1>积累，可以接着用</h1>
          <button className="button secondary" onClick={onAdd}>
            <Plus size={15} />
            添加资料
          </button>
        </div>
        <p>回到原始材料，沿着已有工作继续理解。</p>
      </div>
      {sources.length ? (
        <>
          <label className="library-search">
            <Search size={16} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索材料名称或已取得的正文"
              aria-label="搜索资料"
            />
            <span>{filtered.length} 项</span>
          </label>
          <div className="library-list">
            {filtered.length ? (
              filtered.map(({ source, task }) => (
                <article
                  className="library-row"
                  key={`${task.id}-${source.id}`}
                >
                  <div className="library-row-heading">
                    <FileText size={18} strokeWidth={1.5} />
                    <h3>{source.title}</h3>
                    <time>{formatDate(source.addedAt)}</time>
                  </div>
                  <p>{source.text.slice(0, 160) || "尚未取得可阅读的正文"}</p>
                  <div className="library-row-foot">
                    <span>{source.coverage}</span>
                    <button
                      className="text-button"
                      onClick={() => onTask(task.id)}
                    >
                      回到「{task.title}」<ArrowUpRight size={13} />
                    </button>
                    {source.type === "url" ? (
                      <button
                        className="icon-button"
                        title="打开原始链接"
                        aria-label="打开原始链接"
                        onClick={() =>
                          void dispatch({
                            type: "url.open",
                            url: source.location,
                          })
                        }
                      >
                        <Link2 size={14} />
                      </button>
                    ) : null}
                  </div>
                </article>
              ))
            ) : (
              <div className="section-empty">
                <Search size={25} />
                <h3>没有找到这份资料</h3>
                <p>换个关键词试试。</p>
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="collection-empty">
          <div className="large-line-icon">
            <BookOpen size={46} strokeWidth={1.1} />
          </div>
          <h2>有用的理解，从材料开始</h2>
          <p>
            导入文章、笔记或项目资料。
            <br />
            随着工作推进，它们会在这里积累。
          </p>
          <button className="button secondary" onClick={onAdd}>
            加入一份材料
            <Plus size={14} />
          </button>
          <p className="collection-footnote">
            来源接入与验证状态，以真实导入结果为准。
          </p>
        </div>
      )}
    </div>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connection, setConnection] = useState<
    "loading" | "connected" | "unavailable" | "failed"
  >(() => (window.ytriple ? "loading" : "unavailable"));
  const [page, setPage] = useState<Page>("work");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(
    INITIAL_TASK_ID,
  );
  const [contextOpen, setContextOpen] = useState(() => window.innerWidth > 960);
  const [contextTab, setContextTab] = useState<"artifact" | "evidence">(
    "artifact",
  );
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 760);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [error, setError] = useState<string | null>(null);
  const [composerDraft, setComposerDraft] = useState<ComposerDraft>(() => ({
    ...EMPTY_DRAFT,
  }));
  const [sourceDraft, setSourceDraft] = useState<ComposerDraft | null>(null);
  const [seedRevision, setSeedRevision] = useState(0);
  const [newWorkRevision, setNewWorkRevision] = useState(0);
  useEffect(() => {
    document.title =
      AUXILIARY === "artifact"
        ? "ytriple · 成果工作区"
        : AUXILIARY === "evidence"
          ? "ytriple · 资料与依据"
          : "ytriple · 工作台";
  }, []);
  const connected = connection === "connected";
  const task = snapshot?.tasks.find((item) => item.id === selectedTaskId);
  const dispatch = useCallback<Dispatch>(async (command: Command) => {
    if (!window.ytriple) {
      setError("桌面连接未接入。请在 ytriple 桌面应用中执行这项操作。");
      return null;
    }
    try {
      const result = await window.ytriple.invoke(command);
      setSnapshot(result);
      setConnection("connected");
      return result;
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "操作未完成，请稍后重试。",
      );
      return null;
    }
  }, []);
  useEffect(() => {
    if (!window.ytriple) return;
    let active = true;
    const unsubscribe = window.ytriple.subscribe((value) => {
      if (active) {
        setSnapshot(value);
        setConnection("connected");
      }
    });
    void window.ytriple
      .invoke({ type: "snapshot" })
      .then((value) => {
        if (active) {
          setSnapshot(value);
          setConnection("connected");
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
  }, []);
  const closeDialog = useCallback(() => {
    setDialog(null);
    setSourceDraft(null);
  }, []);
  const newWork = useCallback(() => {
    setSelectedTaskId(null);
    setPage("work");
    setComposerDraft({ ...EMPTY_DRAFT });
    setSeedRevision((value) => value + 1);
    setNewWorkRevision((value) => value + 1);
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "n" &&
        !AUXILIARY
      ) {
        event.preventDefault();
        newWork();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [newWork]);
  const selectTask = (id: string, created?: Task) => {
    const selected = created ?? snapshot?.tasks.find((item) => item.id === id);
    setSelectedTaskId(id);
    setPage("work");
    setComposerDraft({
      text: "",
      kind: selected?.kind ?? "research",
      member: selected?.member ?? "coordinator",
      profileId: selected?.profileId ?? "",
    });
    setSeedRevision((value) => value + 1);
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
    if (page === "library" && !AUXILIARY) setSelectedTaskId(null);
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
    <div className={`app-shell ${AUXILIARY ? "auxiliary-shell" : ""}`}>
      {!AUXILIARY ? (
        <Sidebar
          snapshot={snapshot}
          page={page}
          selectedTaskId={selectedTaskId}
          onPage={setPage}
          onTask={selectTask}
          onNew={newWork}
          connected={connected}
          collapsed={!sidebarOpen}
          onClose={() => setSidebarOpen(false)}
        />
      ) : null}
      <main className="main-shell">
        <header className="topbar">
          <div className="topbar-location">
            {!AUXILIARY ? (
              <button
                className="icon-button"
                aria-label={sidebarOpen ? "收起侧栏" : "展开侧栏"}
                onClick={() => setSidebarOpen(!sidebarOpen)}
              >
                <Menu size={17} />
              </button>
            ) : (
              <span className="aux-brand">
                <Logo />
              </span>
            )}
            <span className="breadcrumb">
              {AUXILIARY
                ? (task?.title ?? "当前工作")
                : {
                    work: "工作空间",
                    projects: "项目",
                    library: "资料与知识",
                    settings: "设置",
                  }[page]}
            </span>
            <ChevronRight size={12} />
            <strong>
              {AUXILIARY
                ? AUXILIARY === "artifact"
                  ? "成果工作区"
                  : "资料与依据"
                : page === "work"
                  ? (task?.title ?? "新的开始")
                  : page === "settings"
                    ? "工作台配置"
                    : "我的工作"}
            </strong>
          </div>
          <div className="topbar-actions">
            {task && page === "work" && !AUXILIARY ? (
              <>
                <TaskControl key={task.id} task={task} dispatch={dispatch} />
                <button
                  className="icon-button"
                  aria-label="将当前工作初始化为项目"
                  title="将讨论初始化为项目"
                  onClick={() => setDialog("project")}
                >
                  <FilePlus2 size={16} />
                </button>
              </>
            ) : null}
            {!AUXILIARY && page === "work" ? (
              <button
                className={`icon-button ${contextOpen ? "selected" : ""}`}
                aria-label={contextOpen ? "收起成果与资料" : "展开成果与资料"}
                onClick={() => setContextOpen(!contextOpen)}
              >
                <PanelRight size={17} />
              </button>
            ) : null}
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
        {AUXILIARY ? (
          <div className="auxiliary-body">
            {task ? (
              AUXILIARY === "artifact" ? (
                <ArtifactList key={task.id} task={task} dispatch={dispatch} />
              ) : (
                <>
                  <div className="page-heading">
                    <span className="eyebrow">EVIDENCE</span>
                    <div className="heading-with-action">
                      <h1>沿着依据，继续理解</h1>
                      <button className="button secondary" onClick={addSource}>
                        <Plus size={15} />
                        添加资料
                      </button>
                    </div>
                    <p>{task.goal}</p>
                  </div>
                  <SourceList
                    sources={task.sources}
                    dispatch={dispatch}
                    onAdd={addSource}
                  />
                </>
              )
            ) : (
              <div className="collection-empty">
                <FolderOpen size={36} strokeWidth={1.3} />
                <h2>
                  {connection === "loading"
                    ? "正在打开这项工作"
                    : "暂时无法找到这项工作"}
                </h2>
                <p>回到主窗口，选择一项已保存的工作。</p>
              </div>
            )}
          </div>
        ) : page === "settings" ? (
          <Settings
            snapshot={snapshot}
            dispatch={dispatch}
            connected={connected}
          />
        ) : page === "projects" ? (
          <Projects
            snapshot={snapshot}
            dispatch={dispatch}
            onInitialize={() => setDialog("project")}
            onTask={selectTask}
          />
        ) : page === "library" ? (
          <Library
            snapshot={snapshot}
            dispatch={dispatch}
            onTask={selectTask}
            onAdd={addSource}
          />
        ) : (
          <div className="work-layout">
            <section
              className={`decision-pane ${task ? "has-task" : "is-new"}`}
            >
              {task ? (
                <Conversation
                  key={`conversation:${task.id}`}
                  task={task}
                  dispatch={dispatch}
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
                onConfigure={() => setPage("settings")}
              />
            </section>
            {contextOpen ? (
              <ContextPanel
                task={task}
                tab={contextTab}
                onTab={setContextTab}
                dispatch={dispatch}
                onAdd={addSource}
                onClose={() => setContextOpen(false)}
              />
            ) : null}
          </div>
        )}
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
