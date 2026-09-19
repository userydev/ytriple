import { SkillChooser } from "./SkillChooser";
import { skillAvailability, skillKey } from "../core/skill-contract";
import { outputLabels } from "../core/output";
import { latestBrief, latestStandards } from "../core/project-contract";
import { ProjectRequirements } from "./ProjectRequirements";
import { Dialog } from "./Dialog";
import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  lazy,
  Suspense,
} from "react";
import {
  BookOpen,
  Plus,
  Users,
  PanelsTopLeft,
  ArrowUp,
  Square,
  X,
  Paperclip,
  Link,
  FileText,
  ChevronDown,
  Pencil,
  Sparkles,
  LoaderCircle,
  Folder,
  Radar,
  MessageSquare,
  ClipboardList,
} from "lucide-react";
import { command } from "./api";
import { References } from "./References";
import { QueueEditor } from "./QueueEditor";
import { configurationForSnapshot } from "../core/configuration";
import type { Draft, Material, Reference, Run, Snapshot } from "../core/types";
const DecisionInput = lazy(() =>
  import("./DecisionInput").then((m) => ({ default: m.DecisionInput })),
);
export function IconButton({
  label,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      {...props}
      type={props.type ?? "button"}
      aria-label={label}
      title={label}
      className={`icon-button ${props.className ?? ""}`}
    >
      {children}
    </button>
  );
}
export function Composer({
  data,
  context,
  projectId,
  deliveryId,
  immersive,
  surface = "home",
  onExpand,
  onWork,
  onContext,
  onManage,
  onTeam,
  onSettings,
  onClose,
  onError,
  extraRefs = [],
  compactRadar = false,
  radarTitle,
  radarExcerpt,
}: {
  data: Snapshot;
  context: string;
  projectId: string | null;
  deliveryId?: string | null;
  immersive: boolean;
  surface?: "home" | "radar" | "projects" | "assets" | "schedules" | "settings";
  onExpand: () => void;
  onWork: (id: string) => void;
  onContext: (id: string) => void;
  onManage: () => void;
  onTeam?: () => void;
  onSettings?: () => void;
  onClose?: () => void;
  onError: (e: unknown) => void;
  extraRefs?: Reference[];
  compactRadar?: boolean;
  radarTitle?: string;
  radarExcerpt?: string;
}) {
  const initial = data.drafts.find((d) => d.id === context);
  const workspaceContext =
    data.works.find((w) => w.id === context)?.workspaceContext ??
    initial?.workspaceContext;
  const [skillKeys, setSkillKeys] = useState<string[]>(
    initial?.skillKeys ?? [],
  );
  const [showSkills, setShowSkills] = useState(false);
  const [focused, setFocused] = useState(false);
  const [outputMode, setOutputMode] = useState(initial?.outputMode ?? "result");
  const [text, setText] = useState(initial?.text ?? "");
  const [refs, setRefs] = useState<Reference[]>([
    ...(initial?.refs ?? []),
    ...extraRefs,
  ]);
  const [recipient, setRecipient] = useState<string | null>(
    initial?.recipient ?? null,
  );
  const [menu, setMenu] = useState<
    "add" | "people" | "work" | "materials" | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [showProject, setShowProject] = useState(false);
  const [importing, setImporting] = useState(false),
    [editingQueue, setEditingQueue] = useState<Run | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null),
    root = useRef<HTMLElement>(null),
    menuOpener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const el = textarea.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 220) + "px";
    }
  }, [text, focused, immersive, menu, refs.length]);
  useEffect(() => {
    if (!menu) return;
    menuOpener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const close = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setMenu(null);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menu]);
  const submitKey = useRef<string | null>(null);
  const work = data.works.find((w) => w.id === context),
    running = data.runs.find(
      (r) => r.workId === context && r.status === "running",
    );
  const { team } = configurationForSnapshot(data, work);
  const queued = data.runs.filter(
    (r) => r.workId === context && r.status === "queued",
  );
  const missing = refs.some((r) => {
    const m = data.materials.find(
      (m) => m.id === r.materialId && m.version === r.version,
    );
    return !m || m.readError;
  });
  async function save(next: Partial<Draft> = {}) {
    await command({
      type: "draft",
      id: context,
      outputMode,
      text,
      refs,
      recipient,
      skillKeys,
      projectId,
      workspaceContext,
      ...next,
    });
  }
  function change(value: string) {
    setText(value);
    submitKey.current = null;
    void save({ text: value }).catch(onError);
  }
  function setReferences(value: Reference[]) {
    setRefs(value);
    submitKey.current = null;
    void save({ refs: value }).catch(onError);
  }
  function selectSkills(keys: string[]) {
    setSkillKeys(keys);
    submitKey.current = null;
    void save({ skillKeys: keys }).catch(onError);
  }
  const unavailableSkills = skillKeys.some((key) => {
    const skill = data.skills.find((s) => skillKey(s) === key);
    return !skill || skillAvailability(skill, data.skillStates) !== "ready";
  });
  const modelReady = data.model?.configured ?? data.service.configured;
  async function send() {
    if (
      busy ||
      importing ||
      missing ||
      unavailableSkills ||
      !modelReady ||
      !text.trim()
    )
      return;
    setBusy(true);
    try {
      await save();
      submitKey.current ??= crypto.randomUUID();
      const run = await command<Run>({
        type: "submit",
        key: submitKey.current,
        context,
        outputMode,
        text,
        refs,
        recipient,
        skillKeys,
        projectId,
        deliveryId,
        workspaceContext,
      });
      setText("");
      setOutputMode(workspaceContext ? "explanation" : "result");
      setRefs(context.startsWith("new:radar:") || work?.keepResearchReferences ? refs : []);
      setSkillKeys([]);
      submitKey.current = null;
      onWork(run.workId);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  async function importFiles() {
    setMenu(null);
    setImporting(true);
    try {
      const files = await command<Material[]>({ type: "import" });
      setReferences([
        ...refs,
        ...files.map((m) => ({
          materialId: m.id,
          version: m.version,
          label: m.title,
        })),
      ]);
    } catch (e) {
      onError(e);
    } finally {
      setImporting(false);
    }
  }
  const actualProjectId = work ? work.projectId : projectId;
  const actualDeliveryId = work ? work.deliveryId : deliveryId;
  const project = data.projects.find((p) => p.id === actualProjectId);
  const brief = project
    ? latestBrief(data.projectBriefs, project.id)
    : undefined;
  const projectContext = project
    ? {
        projectId: project.id,
        projectName: project.name,
        briefRevision: brief?.revision ?? 0,
        goal: brief?.goal ?? project.goal,
        standards: latestStandards(data.projectStandards, project.id).filter(
          (s) =>
            s.enabled && (!s.deliveryId || s.deliveryId === actualDeliveryId),
        ),
        materials: (brief?.refs ?? []).flatMap((reference) => {
          const material = data.materials.find(
            (m) =>
              m.id === reference.materialId && m.version === reference.version,
          );
          return material ? [{ reference, material }] : [];
        }),
      }
    : null;
  const expandedInput =
    immersive ||
    !!work ||
    focused ||
    !!text ||
    refs.length > 0 ||
    skillKeys.length > 0 ||
    !!menu ||
    outputMode !== "result";
  const inputState = running
    ? "running"
    : refs.length
      ? "referenced"
      : work
        ? "continuing"
        : project
          ? "project"
          : "new";
  const delivery = data.deliveries.find((d) => d.id === actualDeliveryId);
  const workspaceOperation = context.startsWith("new:workspace:");
  const contextLabel =
    workspaceContext?.kind === "radar-topic"
      ? `雷达议题 · ${data.radar.topics.find((topic) => topic.id === workspaceContext.id)?.title ?? workspaceContext.id} · v${workspaceContext.revision}`
      : workspaceContext?.kind === "schedule"
        ? `定时任务 · ${data.schedules.find((schedule) => schedule.id === workspaceContext.id)?.name ?? workspaceContext.id} · v${workspaceContext.revision}`
        : workspaceOperation
          ? surface === "radar"
            ? "雷达委托"
            : "定时任务委托"
          : (work?.title ??
            (surface === "radar"
              ? (radarTitle ?? "围绕这篇文章")
              : (delivery?.title ?? project?.name ?? "新工作")));
  const placeholder = running
    ? "补充下一轮要处理的内容…"
    : recipient
      ? `给${team.members.find((m) => m.id === recipient)?.name ?? "成员"}的补充…`
      : refs.length
        ? work
          ? "想怎样调整？写下修改意见…"
          : "基于这些材料，你想进一步做什么？"
        : work
          ? "继续讨论，或告诉团队下一步…"
          : compactRadar
            ? "这篇新闻里，你想弄清什么？"
          : delivery
            ? `围绕「${delivery.title}」推进什么？`
            : project
              ? `为「${project.name}」开始一项工作…`
              : "有什么想法，交给团队一起完成…";
  const ContextIcon = running
    ? LoaderCircle
    : surface === "radar"
      ? Radar
      : work
        ? MessageSquare
        : project
          ? Folder
          : Sparkles;
  const decision = data.decisions.find(
    (d) => d.workId === context && d.status === "pending",
  );
  if (decision)
    return (
      <Suspense fallback={<p role="status">打开待决…</p>}>
        <DecisionInput
          key={decision.id}
          decision={decision}
          title={work?.title ?? "当前工作"}
          immersive={immersive}
          onExpand={onExpand}
          onManage={onManage}
          onError={onError}
        />
      </Suspense>
    );
  return (
    <section
      className={`composer ${expandedInput ? "is-expanded" : "is-compact"} ${immersive ? "in-workspace" : ""} ${compactRadar ? "radar-compact" : ""}`}
      data-state={inputState}
      ref={root}
      onFocusCapture={(e) => {
        if (e.target === textarea.current) setFocused(true);
      }}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          setFocused(false);
      }}
      aria-label="对话输入"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          if (menu) {
            e.stopPropagation();
            setMenu(null);
            menuOpener.current?.focus();
          } else if (!text && !refs.length && !work) {
            textarea.current?.blur();
            setFocused(false);
          }
        }
      }}
    >
      <div className="composer-context">
        {compactRadar ? (
          <div className="radar-ask-identity">
            <strong>{radarTitle ?? "这篇文章"}</strong>
            {radarExcerpt ? <small>{radarExcerpt}</small> : null}
          </div>
        ) : (
        <button
          className="quiet composer-identity"
          aria-expanded={menu === "work"}
          title={contextLabel}
          onClick={() => setMenu(menu === "work" ? null : "work")}
        >
          <ContextIcon size={15} className={running ? "spinning" : ""} />
          <span>{contextLabel}</span>
          <ChevronDown size={13} />
        </button>
        )}
        {projectContext ? (
          <IconButton
            label={`项目要求 · ${projectContext.standards.length} 条标准`}
            onClick={() => setShowProject(true)}
          >
            <ClipboardList size={16} />
          </IconButton>
        ) : null}
        {outputMode !== "result" ? (
          <span className="output-mode">
            {workspaceOperation ? "团队办理" : outputLabels[outputMode]}
            <IconButton
              label="改为普通成果任务"
              disabled={busy}
              onClick={() => {
                setOutputMode("result");
                submitKey.current = null;
                void save({ outputMode: "result" }).catch(onError);
              }}
            >
              <X size={13} />
            </IconButton>
          </span>
        ) : null}
        {running ? (
          <span className="composer-state" role="status">
            团队处理中
          </span>
        ) : work ? (
          <span className="composer-state">继续工作</span>
        ) : null}
        {work?.archived ? (
          <span className="muted">已归档</span>
        ) : work?.completedAt ? (
          <span className="muted">工作已完成</span>
        ) : null}
        {onClose ? (
          <IconButton
            label="收起输入，保留草稿"
            disabled={busy || importing}
            onClick={() => {
              void save().then(onClose).catch(onError);
            }}
          >
            <X size={16} />
          </IconButton>
        ) : null}
      </div>
      {menu === "work" ? (
        <div className="popover work-menu">
          {work ? (
            <button
              onClick={() => {
                setMenu(null);
                onManage();
              }}
            >
              工作名称与归属
            </button>
          ) : null}
          <button
            onClick={() => {
              void save()
                .then(() => onContext(projectId ? "new:" + projectId : "new"))
                .catch(onError);
              setMenu(null);
            }}
          >
            开始另一项工作
          </button>
          {data.works
            .filter(
              (w) => !w.archived && (!projectId || w.projectId === projectId),
            )
            .map((w) => (
              <button
                key={w.id}
                onClick={() => {
                  void save()
                    .then(() => onContext(w.id))
                    .catch(onError);
                  setMenu(null);
                }}
              >
                {w.title}
              </button>
            ))}
        </div>
      ) : null}
      {workspaceContext && !compactRadar ? (
        <div className="workspace-team-ready">
          <small>
            {team.members.map((member) => member.name).join("、")} ·
            可读取当前工作台并提出明确变更
          </small>
          {onTeam ? (
            <button className="text-action" onClick={onTeam}>
              查看团队配置
            </button>
          ) : null}
        </div>
      ) : null}
      <References
        refs={refs}
        data={data}
        disabled={busy}
        onChange={setReferences}
      />
      {skillKeys.length ? (
        <div className="skill-chips">
          {skillKeys.map((key) => (
            <span className="output-mode" key={key}>
              {data.skills.find((s) => skillKey(s) === key)?.name ??
                "不可用方法"}
              <small>
                v{data.skills.find((s) => skillKey(s) === key)?.version ?? "?"}
              </small>
              <IconButton
                label={`移除方法 ${data.skills.find((s) => skillKey(s) === key)?.name ?? key}`}
                disabled={busy}
                onClick={() => selectSkills(skillKeys.filter((k) => k !== key))}
              >
                <X size={13} />
              </IconButton>
            </span>
          ))}
        </div>
      ) : null}
      {unavailableSkills ? (
        <p className="error-inline" role="status">
          指定方法已停用或缺少依赖，请更换或移除后发送。
        </p>
      ) : null}
      {!modelReady ? (
        <p className="error-inline" role="status">
          先连接 AI 服务，团队才能处理这项请求。{" "}
          {onSettings ? (
            <button className="text-action" onClick={onSettings}>
              打开模型设置
            </button>
          ) : null}
        </p>
      ) : null}
      {showSkills ? (
        <Dialog title="本轮方法" onClose={() => setShowSkills(false)}>
          <SkillChooser
            data={data}
            selected={skillKeys}
            onChange={selectSkills}
          />
          <div className="dialog-actions">
            <button onClick={() => setShowSkills(false)}>完成选择</button>
          </div>
        </Dialog>
      ) : null}
      {importing ? <p className="muted">正在读取材料…</p> : null}
      {missing ? (
        <p className="error-inline" role="status">
          请先修复或移除未就绪材料
        </p>
      ) : null}
      {recipient ? (
        <div className="mention">
          @{team.members.find((m) => m.id === recipient)?.name}
        </div>
      ) : null}
      <textarea
        ref={textarea}
        aria-label="工作目标或补充"
        disabled={busy}
        value={text}
        rows={1}
        placeholder={placeholder}
        onChange={(e) => change(e.target.value)}
        onKeyDown={(e) => {
          if (
            e.key === "Enter" &&
            (e.metaKey || e.ctrlKey) &&
            !e.nativeEvent.isComposing
          ) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="composer-tools">
        <div className="tool-group">
          {compactRadar ? null : (
          <IconButton
            label="添加材料"
            className="attach-trigger"
            aria-expanded={menu === "add"}
            onClick={() => setMenu(menu === "add" ? null : "add")}
          >
            <Plus size={19} />
          </IconButton>
          )}
          {compactRadar ? null : (
            <>
          <IconButton
            label="选择本轮方法"
            className="extended-tool"
            disabled={busy}
            aria-haspopup="dialog"
            onClick={() => setShowSkills(true)}
          >
            <BookOpen size={18} />
          </IconButton>
          <IconButton
            label="交流对象"
            className="extended-tool"
            aria-expanded={menu === "people"}
            onClick={() => setMenu(menu === "people" ? null : "people")}
          >
            <Users size={18} />
          </IconButton>
            </>
          )}
        </div>
        <div className="tool-group">
          {compactRadar ? (
            <button
              type="button"
              className="quiet"
              onClick={() => {
                void save().then(onExpand).catch(onError);
              }}
            >
              在工作中打开
            </button>
          ) : (
          <IconButton
            label={immersive ? "收起工作区" : "展开团队工作区"}
            className="workspace-trigger"
            onClick={() => {
              void save().then(onExpand).catch(onError);
            }}
          >
            <PanelsTopLeft size={19} />
          </IconButton>
          )}
          {running ? (
            <IconButton
              label="停止当前轮并暂停待发"
              onClick={() =>
                void command({ type: "stop", workId: context }).catch(onError)
              }
            >
              <Square size={16} />
            </IconButton>
          ) : null}
          {!running || text.trim() ? (
            <>
              <span className="muted">{running ? "下一轮" : ""}</span>
              <IconButton
                label="发送 · ⌘/Ctrl+Enter"
                className="send"
                disabled={
                  busy ||
                  importing ||
                  missing ||
                  unavailableSkills ||
                  !modelReady ||
                  !text.trim()
                }
                onClick={() => void send()}
              >
                <ArrowUp size={20} />
              </IconButton>
            </>
          ) : null}
        </div>
      </div>
      {menu === "add" ? (
        <div className="popover bottom-menu">
          <button onClick={() => void importFiles()}>
            <Paperclip size={16} />
            添加文件
          </button>
          <button onClick={() => setMenu("materials")}>
            <FileText size={16} />
            引用已有材料
          </button>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const url = String(new FormData(e.currentTarget).get("url"));
              void command<Material>({ type: "link", url })
                .then((m) => {
                  setReferences([
                    ...refs,
                    { materialId: m.id, version: m.version, label: m.title },
                  ]);
                  setMenu(null);
                })
                .catch(onError);
            }}
          >
            <label>
              <Link size={15} />
              保存链接（仅链接，未读正文）
              <input name="url" type="url" placeholder="https://…" required />
            </label>
            <button type="submit">添加</button>
          </form>
        </div>
      ) : null}
      {menu === "materials" ? (
        <div className="popover bottom-menu">
          <button onClick={() => setMenu(null)}>关闭</button>
          {data.materials.length ? (
            data.materials.map((m) => (
              <button
                key={`${m.id}@${m.version}`}
                onClick={() => {
                  setReferences([
                    ...refs,
                    { materialId: m.id, version: m.version, label: m.title },
                  ]);
                  setMenu(null);
                }}
              >
                {m.title}
                <small>
                  v{m.version} · {m.coverage}
                </small>
              </button>
            ))
          ) : (
            <p>还没有材料，先添加文件或同步雷达。</p>
          )}
        </div>
      ) : null}
      {menu === "people" ? (
        <div className="popover bottom-menu">
          <button
            onClick={() => {
              setRecipient(null);
              submitKey.current = null;
              void save({ recipient: null }).catch(onError);
              setMenu(null);
            }}
          >
            整个团队
          </button>
          {team.members.map((m) => (
            <button
              key={m.id}
              onClick={() => {
                setRecipient(m.id);
                submitKey.current = null;
                void save({ recipient: m.id }).catch(onError);
                setMenu(null);
              }}
            >
              {m.name}
              {recipient === m.id ? " ✓" : ""}
            </button>
          ))}
        </div>
      ) : null}
      {queued.length ? (
        <div className="queue">
          <span>待发 {queued.length}</span>
          {queued.map((r) => (
            <span key={r.id}>
              {r.queueDraft ? "编辑中 · " : ""}
              {r.text.slice(0, 32)}
              <IconButton
                label="编辑待发"
                onClick={() =>
                  void command<Run>({ type: "begin-queue-edit", runId: r.id })
                    .then(setEditingQueue)
                    .catch(onError)
                }
              >
                <Pencil size={13} />
              </IconButton>
              <IconButton
                label="撤回待发"
                onClick={() =>
                  void command({ type: "withdraw", runId: r.id }).catch(onError)
                }
              >
                <X size={13} />
              </IconButton>
            </span>
          ))}
          {work?.queuePaused ? (
            <button
              onClick={() =>
                void command({ type: "resume", workId: context }).catch(onError)
              }
            >
              继续待发
            </button>
          ) : null}
        </div>
      ) : null}
      {showProject && projectContext ? (
        <Dialog
          title="下次发送使用的项目要求"
          onClose={() => setShowProject(false)}
        >
          <p className="muted">
            以下要求仅用于本项目；正在执行或已排队的运行保留提交时的版本。
          </p>
          <ProjectRequirements
            context={projectContext}
            versions={data.versions}
          />
        </Dialog>
      ) : null}
      {editingQueue ? (
        <QueueEditor
          key={editingQueue.id}
          run={editingQueue}
          data={data}
          onClose={() => setEditingQueue(null)}
        />
      ) : null}
    </section>
  );
}
