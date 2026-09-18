import productMark from "../../../../assets/product-mark.svg?url";
import { TeamTrace } from "./TeamTrace";
import { UnknownRunActions } from "./UnknownRunActions";
import { outcomeSnapshotChanged } from "../core/outcome-contract";
import { scheduleProblem } from "../core/schedule-contract";
import { versionLabel } from "../core/output";
import { latestBrief, latestStandards } from "../core/project-contract";
import {
  StrictMode,
  Suspense,
  lazy,
  useEffect,
  useCallback,
  useLayoutEffect,
  useState,
  useRef,
} from "react";
import { createRoot } from "react-dom/client";
import Markdown from "./Markdown";
import {
  Menu,
  House,
  Radar,
  Folder,
  Library,
  Clock,
  Settings,
  ArrowLeft,
  ArrowUpRight,
  Search,
  RefreshCw,
  Download,
  PanelLeftClose,
  Check,
  X,
  FileText,
  FileOutput,
  FolderGit2,
  ClipboardCheck,
  Plus,
  BookOpen,
  ArrowRight,
  PanelsTopLeft,
  Layers,
  SlidersHorizontal,
  Ellipsis,
} from "lucide-react";
import type {
  Snapshot,
  Draft,
  Work,
  Project,
  Material,
  Reference,
  ArtifactVersion,
  Delivery,
} from "../core/types";
import { command } from "./api";
import { Composer, IconButton } from "./Composer";
import { ConfigurationEditor } from "./ConfigurationEditor";
import { WorkEditor } from "./WorkEditor";
import { WorkArea } from "./WorkArea";
import { useWorkViews } from "./useWorkViews";
import { Dialog } from "./Dialog";
import { RadarHighlights } from "./RadarHighlights";
const MethodActions = lazy(() =>
  import("./MethodActions").then((m) => ({ default: m.MethodActions })),
);
const SchedulesPage = lazy(() =>
  import("./SchedulesPage").then((m) => ({ default: m.SchedulesPage })),
);
const ScheduleEditor = lazy(() =>
  import("./SchedulesPage").then((m) => ({ default: m.ScheduleEditor })),
);
const OutcomeDialog = lazy(() =>
  import("./OutcomeDialog").then((m) => ({ default: m.OutcomeDialog })),
);
const ProjectFilesPanel = lazy(() =>
  import("./ProjectFilesPanel").then((m) => ({ default: m.ProjectFilesPanel })),
);
const ProjectInitializer = lazy(() =>
  import("./ProjectInitializer").then((m) => ({
    default: m.ProjectInitializer,
  })),
);
const SuggestionLocation = lazy(() =>
  import("./ProjectSuggestions").then((m) => ({
    default: m.SuggestionLocation,
  })),
);
const SuggestionDialog = lazy(() =>
  import("./ProjectSuggestions").then((m) => ({ default: m.SuggestionDialog })),
);
const ProcessPane = lazy(() =>
  import("./ProcessPane").then((m) => ({ default: m.ProcessPane })),
);
const AssetLibrary = lazy(() =>
  import("./AssetLibrary").then((m) => ({ default: m.AssetLibrary })),
);
const AccountSettings = lazy(() =>
  import("./AccountSettings").then((m) => ({ default: m.AccountSettings })),
);
const ModelSettings = lazy(() =>
  import("./ModelSettings").then((m) => ({ default: m.ModelSettings })),
);
const WorkspaceSettings = lazy(() =>
  import("./WorkspaceSettings").then((m) => ({ default: m.WorkspaceSettings })),
);
const LocalFolderSettings = lazy(() =>
  import("./LocalFolders").then((m) => ({ default: m.LocalFolderSettings })),
);
const LocalProjects = lazy(() =>
  import("./LocalFolders").then((m) => ({ default: m.LocalProjects })),
);
const ProjectFolder = lazy(() =>
  import("./LocalFolders").then((m) => ({ default: m.ProjectFolder })),
);
const ProjectContextEditor = lazy(() =>
  import("./ProjectContextEditor").then((m) => ({
    default: m.ProjectContextEditor,
  })),
);
const VersionCompare = lazy(() =>
  import("./VersionCompare").then((m) => ({ default: m.VersionCompare })),
);
const RadarPanel = lazy(() =>
  import("./RadarPanel").then((m) => ({ default: m.RadarPanel })),
);
import { coverageLabel, type RadarEdition } from "../core/radar-contract";
import "./style.css";
type Page = "home" | "radar" | "projects" | "assets" | "schedules" | "settings";
const names: Record<Page, string> = {
  home: "首页",
  radar: "雷达",
  projects: "项目",
  assets: "资产",
  schedules: "定时任务",
  settings: "设置",
};
const icons = {
  home: House,
  radar: Radar,
  projects: Folder,
  assets: Library,
  schedules: Clock,
  settings: Settings,
};
function App() {
  const [data, setData] = useState<Snapshot | null>(null),
    [error, setError] = useState(""),
    [page, setPage] = useState<Page>("home"),
    [expanded, setExpanded] = useState(false),
    [projectTab, setProjectTab] = useState<"overview" | "files">("overview"),
    [settingsTab, setSettingsTab] = useState("connection"),
    [projectId, setProjectId] = useState<string | null>(null),
    [context, setContext] = useState("new"),
    [immersive, setImmersive] = useState(false),
    [reading, setReading] = useState<Material | null>(null),
    [radarEditionId, setRadarEditionId] = useState<string | null>(null),
    [scheduleId, setScheduleId] = useState<string | null>(null),
    [scheduleWork, setScheduleWork] = useState<string | null>(null),
    [dialog, setDialog] = useState<
      "project" | "delivery" | "search" | "team" | "work" | null
    >(null),
    [query, setQuery] = useState(""),
    [extra, setExtra] = useState<Reference[]>([]),
    [composerEpoch, setComposerEpoch] = useState(0),
    [composerFocus, setComposerFocus] = useState(0),
    [syncing, setSyncing] = useState(false),
    [selectedDelivery, setSelectedDelivery] = useState<string | null>(null),
    [outcomeVersion, setOutcomeVersion] = useState<string | null>(null),
    [comparing, setComparing] = useState<string | null>(null),
    [initializing, setInitializing] = useState<string | null>(null),
    [suggestion, setSuggestion] = useState<{
      projectId: string;
      version: ArtifactVersion;
      excerpt?: string;
    } | null>(null),
    [requirementsProject, setRequirementsProject] = useState<string | null>(
      null,
    ),
    [standardCandidate, setStandardCandidate] = useState<
      { version: ArtifactVersion; excerpt?: string } | undefined
    >(undefined),
    [showArchived, setShowArchived] = useState(false),
    [processFocus, setProcessFocus] = useState<string[] | undefined>(undefined),
    [selectedPassage, setSelectedPassage] = useState<{
      versionId: string;
      text: string;
    } | null>(null);
  const pagePositions = useRef(new Map<string, number>());
  const pagePositionKey = `${page}:${projectId ?? ""}:${projectTab}:${data?.works.some((w) => w.id === context) ? context : "browse"}`;
  useLayoutEffect(() => {
    const node = document.querySelector<HTMLElement>("main.page");
    if (!node) return;
    const key = pagePositionKey;
    node.scrollTop = pagePositions.current.get(key) ?? 0;
    return () => {
      pagePositions.current.set(key, node.scrollTop);
    };
  }, [pagePositionKey, immersive, !!data]);
  const fail = useCallback(
    (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    [],
  );
  useLayoutEffect(() => {
    if (composerFocus)
      document
        .querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="工作目标或补充"]',
        )
        ?.focus();
  }, [composerFocus]);
  useEffect(() => {
    const capture = () => {
      const s = window.getSelection();
      const parent =
        s?.anchorNode instanceof Element
          ? s.anchorNode
          : s?.anchorNode?.parentElement;
      const doc = parent?.closest<HTMLElement>(".document[data-version-id]");
      if (
        doc &&
        s?.focusNode &&
        doc.contains(s.focusNode) &&
        s.toString().trim()
      )
        setSelectedPassage({
          versionId: doc.dataset.versionId!,
          text: s.toString(),
        });
    };
    document.addEventListener("selectionchange", capture);
    return () => document.removeEventListener("selectionchange", capture);
  }, []);
  const viewState = useWorkViews(data, context, fail);
  const selectedVersion = viewState.view.versionId;
  const setSelectedVersion = (versionId: string | null) =>
    viewState.update(context, { versionId });
  useEffect(() => {
    let live = true;
    const off = window.ytriple.subscribe((s) => {
      if (live) setData(s);
    });
    command<Snapshot>({ type: "snapshot" })
      .then((s) => {
        if (live) setData(s);
      })
      .catch(fail);
    return () => {
      live = false;
      off();
    };
  }, []);
  if (!data)
    return (
      <main className="boot">
        <h1>ytriple</h1>
        <p>{error || "打开你的工作空间…"}</p>
      </main>
    );
  const work = data.works.find((w) => w.id === context),
    project = data.projects.find((p) => p.id === projectId),
    works = data.works.filter((w) => !w.archived),
    versions = data.versions.filter((v) => v.workId === context),
    version = versions.find((v) => v.id === selectedVersion) ?? versions.at(-1),
    runs = data.runs.filter((r) => r.workId === context),
    latestRun = runs.at(-1),
    messages = data.messages.filter((m) => m.workId === context);
  function changeContext(id: string) {
    setSelectedPassage(null);
    setProcessFocus(undefined);
    setContext(id);
    viewState.flush();
    setExtra([]);
    setComposerEpoch((n) => n + 1);
  }
  function openWork(id: string, resultVersionId?: string) {
    setProjectTab("overview");
    changeContext(id);
    const w = data!.works.find((w) => w.id === id);
    setSelectedDelivery(w?.deliveryId ?? null);
    setProjectId(w?.projectId ?? null);
    if (w?.projectId) {
      setProjectId(w.projectId);
      setPage("projects");
    }
    if (resultVersionId)
      viewState.update(id, {
        surface: "result",
        versionId: resultVersionId,
        focused: null,
      });
  }
  function navigate(next: Page) {
    setProjectTab("overview");
    setPage(next);
    setProjectId(null);
    setSelectedDelivery(null);
    setReading(null);
    setImmersive(false);
    changeContext("new");
  }
  async function sync() {
    setSyncing(true);
    setError("");
    try {
      await command({ type: "sync" });
    } catch (e) {
      fail(e);
    } finally {
      setSyncing(false);
    }
  }
  async function useMaterial(m: Material) {
    const next = "new:radar:" + m.id + "@" + m.version;
    const ref: Reference = {
      materialId: m.id,
      version: m.version,
      label: m.title,
    };
    await command({
      type: "draft",
      id: next,
      text: data!.drafts.find((d) => d.id === next)?.text ?? "",
      refs: [ref],
      recipient: null,
      projectId: null,
    });
    setData(await command<Snapshot>({ type: "snapshot" }));
    changeContext(next);
    setExtra([]);
    setReading(null);
    setImmersive(true);
  }
  async function useRadarEdition(edition: RadarEdition) {
    const reference = await command<Reference>({
      type: "radar-reference",
      editionId: edition.id,
    });
    const next = `new:radar:${edition.id}`;
    const draft = data!.drafts.find((d) => d.id === next);
    const refs = draft?.refs ?? [];
    await command({
      type: "draft",
      id: next,
      text: draft?.text ?? "",
      refs: refs.some(
        (r) =>
          r.materialId === reference.materialId &&
          r.version === reference.version,
      )
        ? refs
        : [...refs, reference],
      recipient: draft?.recipient ?? null,
      projectId: null,
    });
    setData(await command<Snapshot>({ type: "snapshot" }));
    changeContext(next);
    setComposerFocus((n) => n + 1);
  }
  function openRadar(id: string | null) {
    setPage("radar");
    setProjectId(null);
    setSelectedDelivery(null);
    changeContext("new");
    setRadarEditionId(id);
  }
  const composer = (
    <Composer
      key={`${context}:${composerEpoch}`}
      data={data}
      context={context}
      projectId={work?.projectId ?? projectId}
      deliveryId={work?.deliveryId ?? selectedDelivery}
      immersive={immersive}
      surface={page}
      onExpand={() => {
        void command<Snapshot>({ type: "snapshot" })
          .then((s) => {
            setData(s);
            viewState.flush();
            setImmersive((v) => !v);
          })
          .catch(fail);
      }}
      onWork={(id) => {
        if (context !== id) {
          if (context === "new" || context.startsWith("new:")) {
            const { id: _, ...previous } = viewState.read(context);
            viewState.update(id, { ...previous, versionId: null });
          }
          openWork(id);
        }
      }}
      onManage={() => setDialog("work")}
      onClose={
        !immersive && page === "radar" && context.startsWith("new:radar:")
          ? () => {
              changeContext("new");
              document
                .querySelector<HTMLElement>("[data-radar-start]")
                ?.focus({ preventScroll: true });
            }
          : undefined
      }
      onContext={(id) => {
        if (data.works.some((w) => w.id === id)) openWork(id);
        else {
          setSelectedDelivery(null);
          changeContext(id);
        }
      }}
      onError={fail}
      extraRefs={extra}
    />
  );
  async function prepareRevision(
    versionId: string,
    excerpt?: string,
    candidateId?: string,
  ) {
    await command({
      type: "prepare-revision",
      workId: context,
      versionId,
      excerpt,
      candidateId,
    });
    setData(await command<Snapshot>({ type: "snapshot" }));
    setExtra([]);
    setComposerEpoch((n) => n + 1);
    if (viewState.view.focused || window.innerWidth < 900)
      viewState.update(context, { focused: "decision" });
    setSelectedPassage(null);
    setComposerFocus((n) => n + 1);
  }
  function workList(list: Work[]) {
    return list.length ? (
      <div className="work-list">
        {list.map((w) => {
          const p = data!.projects.find((p) => p.id === w.projectId),
            v = data!.versions.filter((v) => v.workId === w.id).at(-1),
            pending = data!.decisions.find(
              (d) => d.workId === w.id && d.status === "pending",
            ),
            r =
              (pending
                ? data!.runs.find((r) => r.id === pending.runId)
                : undefined) ??
              data!.runs.filter((r) => r.workId === w.id).at(-1);
          return (
            <article
              className={`work-card ${pending ? "needs-decision" : ""}`}
              key={w.id}
            >
              <div className="work-card-meta">
                <span>{p?.name ?? "独立工作"}</span>
                <span className={`status-label ${r?.status ?? ""}`}>
                  {w.completedAt
                    ? "已完成"
                    : r
                      ? {
                          queued: "待发",
                          running: "团队处理中",
                          succeeded: "已有成果",
                          failed: "运行失败",
                          unknown: "状态待核",
                          cancelled: "已停止",
                          waiting: "待你决定",
                        }[r.status]
                      : "待开始"}
                </span>
              </div>
              <button className="work-title" onClick={() => openWork(w.id)}>
                {w.title}
                <ArrowUpRight size={17} />
              </button>
              {pending ? (
                <p>{pending.question}</p>
              ) : v ? (
                <div className="work-excerpt">
                  <Markdown>{v.body}</Markdown>
                </div>
              ) : null}
              {r ? (
                <TeamTrace
                  compact
                  run={r}
                  records={data!.contributions}
                  onRecord={(id) => {
                    openWork(w.id);
                    setProcessFocus([id]);
                    setImmersive(true);
                    viewState.update(w.id, { focused: "process" });
                  }}
                />
              ) : null}
              <div className="work-card-actions">
                <button
                  className="continue-action"
                  onClick={() => {
                    openWork(w.id);
                    if (!pending) {
                      setImmersive(true);
                      viewState.update(w.id, {
                        focused: null,
                        surface: "process",
                      });
                    }
                  }}
                >
                  <PanelsTopLeft size={16} />
                  {pending ? "回答问题" : "团队工作区"}
                </button>
                {!w.completedAt &&
                !w.archived &&
                data!.runs.some(
                  (r) => r.workId === w.id && r.status === "succeeded",
                ) ? (
                  <IconButton
                    label={`设为定时任务 ${w.title}`}
                    onClick={() => setScheduleWork(w.id)}
                  >
                    <Clock size={16} />
                  </IconButton>
                ) : null}
                {v ? (
                  <button
                    className="text-action muted"
                    onClick={() => {
                      openWork(w.id, v.id);
                      setImmersive(true);
                    }}
                  >
                    {versionLabel(v)}
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
    ) : (
      <div className="empty">
        <h3>从一个具体问题开始</h3>
        <p>交给团队一个目标，过程与成果会保留在这里。</p>
      </div>
    );
  }
  async function useMethodDraft(draft: Draft) {
    setData(await command<Snapshot>({ type: "snapshot" }));
    changeContext(draft.id);
    setProjectId(draft.projectId);
    setSelectedDelivery(null);
    setImmersive(true);
    setComposerFocus((n) => n + 1);
  }
  const openMethodSource = (id: string, versionId?: string) => {
    openWork(id, versionId);
    setImmersive(true);
  };
  const process = (
    <Suspense fallback={<p>打开过程…</p>}>
      <ProcessPane
        key={context}
        data={data}
        workId={context}
        focusIds={processFocus}
        onError={fail}
        onPrepare={async (request) => {
          await command({ type: "prepare-process", ...request });
          setData(await command<Snapshot>({ type: "snapshot" }));
          setExtra([]);
          setComposerEpoch((n) => n + 1);
          if (viewState.view.focused || window.innerWidth < 900)
            viewState.update(context, { focused: "decision" });
          setComposerFocus((n) => n + 1);
        }}
      />
    </Suspense>
  );
  const result = (
    <section className="result-pane">
      <div className="section-heading">
        <h2>成果</h2>
        {version ? (
          <div className="toolbar">
            <select
              aria-label="成果版本"
              value={version.id}
              onChange={(e) => setSelectedVersion(e.target.value)}
            >
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {versionLabel(v)}
                  {v.author === "user" ? " · 手动编辑" : ""}
                </option>
              ))}
            </select>
            {version.kind !== "method" && version.author === "team" ? (
              <IconButton
                label="沉淀为可复用方法"
                onClick={() => {
                  void (async () => {
                    await command({
                      type: "prepare-process",
                      workId: version.workId,
                      versionId: version.id,
                      mode: "method",
                    });
                    setData(await command<Snapshot>({ type: "snapshot" }));
                    setExtra([]);
                    setComposerEpoch((n) => n + 1);
                    if (viewState.view.focused || window.innerWidth < 900)
                      viewState.update(context, { focused: "decision" });
                    setComposerFocus((n) => n + 1);
                  })().catch(fail);
                }}
              >
                <BookOpen size={17} />
              </IconButton>
            ) : null}
            {!version.kind || version.kind === "result" ? (
              <IconButton
                label="交接与使用反馈"
                onClick={() => setOutcomeVersion(version.id)}
              >
                <ClipboardCheck size={17} />
              </IconButton>
            ) : null}
            <IconButton
              label="导出此版本"
              onClick={() =>
                void command({ type: "export", versionId: version.id }).catch(
                  fail,
                )
              }
            >
              <Download size={17} />
            </IconButton>
            {work?.projectId &&
            data.projects.some((p) => p.id === work.projectId && p.directory) &&
            version.author === "team" &&
            (!version.kind || version.kind === "result") ? (
              <IconButton
                label="写入项目建议"
                onClick={() =>
                  setSuggestion({
                    projectId: work.projectId!,
                    version,
                    ...(selectedPassage?.versionId === version.id
                      ? { excerpt: selectedPassage.text }
                      : {}),
                  })
                }
              >
                <FileOutput size={17} />
              </IconButton>
            ) : null}
          </div>
        ) : null}
      </div>
      {data.candidates
        .filter((c) => c.workId === context)
        .map((c) => (
          <div className="candidate-row" key={c.id}>
            <details>
              <summary>
                {c.status === "pending"
                  ? "待整理的生成内容"
                  : c.status === "resolved"
                    ? "已合并的生成内容"
                    : "已搁置的生成内容"}
              </summary>
              <Markdown>{c.body}</Markdown>
            </details>
            {c.status === "pending" && version ? (
              <>
                <button
                  onClick={() =>
                    void prepareRevision(
                      versions
                        .filter((v) => v.artifactId === c.artifactId)
                        .at(-1)!.id,
                      undefined,
                      c.id,
                    ).catch(fail)
                  }
                >
                  交给 AI 重新整理
                </button>
                <button
                  className="quiet"
                  onClick={() =>
                    void command({
                      type: "dismiss-candidate",
                      candidateId: c.id,
                    }).catch(fail)
                  }
                >
                  保留记录，暂不处理
                </button>
              </>
            ) : null}
          </div>
        ))}
      {version ? (
        <>
          {version.kind === "method" ? (
            <Suspense fallback={null}>
              <MethodActions
                key={version.id}
                data={data}
                version={version}
                onPrepared={useMethodDraft}
                onNavigate={openMethodSource}
              />
            </Suspense>
          ) : null}
          <div className="version-context">
            {data.runs
              .find((r) => r.id === version.runId)
              ?.refs.some((ref) =>
                data.materials.some(
                  (m) =>
                    m.id === ref.materialId &&
                    m.version === ref.version &&
                    outcomeSnapshotChanged(m, data.outcomes),
                ),
              ) ? (
              <span>
                反馈记录已变化 · 此报告保留生成时的依据，可重新复盘或检查
              </span>
            ) : null}
            {version.kind === "readiness" ? (
              <span>AI 检查意见 · 不代表已交接或已验证</span>
            ) : null}
            {data.outcomes.some(
              (r) => r.versionId === version.id && !r.withdrawn,
            ) ? (
              <button
                className="quiet"
                onClick={() => setOutcomeVersion(version.id)}
              >
                交接与反馈 ·{" "}
                {
                  data.outcomes.filter(
                    (r) => r.versionId === version.id && !r.withdrawn,
                  ).length
                }{" "}
                条用户记录
              </button>
            ) : null}
            {data.deliveries.some((d) => d.adoptedVersionId === version.id) ? (
              <span>交付已采用此版本</span>
            ) : null}
            {versions.at(-1)?.id !== version.id ? (
              <button
                className="quiet"
                onClick={() => setSelectedVersion(versions.at(-1)!.id)}
              >
                查看最新 · {versionLabel(versions.at(-1)!)}
              </button>
            ) : null}
          </div>
          <div className="document" data-version-id={version.id}>
            <Markdown>{version.body}</Markdown>
          </div>
          <div className="result-actions">
            {work?.projectId ? (
              <button
                className="quiet"
                onClick={() => {
                  const excerpt =
                    selectedPassage?.versionId === version.id
                      ? selectedPassage.text
                      : undefined;
                  if (excerpt && !version.body.includes(excerpt)) {
                    setError("所选文字不属于准确正文范围，请重新选择");
                    return;
                  }
                  setStandardCandidate({ version, excerpt });
                  setRequirementsProject(work.projectId);
                }}
              >
                采纳为项目标准
              </button>
            ) : null}
            {data.runs
              .find((r) => r.id === version.runId)
              ?.refs.some((ref) =>
                data.materials.some(
                  (m) =>
                    m.id === ref.materialId &&
                    m.version === ref.version &&
                    m.processSource,
                ),
              ) ? (
              <button
                className="quiet"
                onClick={() => {
                  const run = data.runs.find((r) => r.id === version.runId)!;
                  setProcessFocus(
                    run.refs.flatMap(
                      (ref) =>
                        data.materials.find(
                          (m) =>
                            m.id === ref.materialId &&
                            m.version === ref.version,
                        )?.processSource?.contributionIds ?? [],
                    ),
                  );
                  viewState.update(context, {
                    surface: "process",
                    focused: viewState.view.focused ? "process" : null,
                  });
                }}
              >
                查看依据记录
              </button>
            ) : null}
            <button
              disabled={
                versions.filter((v) => v.artifactId === version.artifactId)
                  .length < 2
              }
              onClick={() => setComparing(version.id)}
            >
              比较版本
            </button>
            <button
              onClick={() => {
                const excerpt =
                  selectedPassage?.versionId === version.id
                    ? selectedPassage.text
                    : undefined;
                if (excerpt && !version.body.includes(excerpt)) {
                  setError(
                    "所选文字跨越了正文格式边界，请在引用预览中选择准确范围",
                  );
                  return;
                }
                void prepareRevision(version.id, excerpt).catch(fail);
              }}
            >
              {selectedPassage?.versionId === version.id
                ? "让 AI 整理选段"
                : "让 AI 重新整理"}
            </button>
            {selectedPassage?.versionId === version.id ? (
              <button
                className="quiet"
                onClick={() => {
                  setSelectedPassage(null);
                  window.getSelection()?.removeAllRanges();
                }}
              >
                清除选段
              </button>
            ) : null}
            <button
              disabled={data.assets.some(
                (a) =>
                  a.reference.materialId === version.artifactId &&
                  a.reference.version === version.number &&
                  a.reference.excerpt === undefined,
              )}
              onClick={() =>
                void command<Reference>({
                  type: "reference",
                  versionId: version.id,
                })
                  .then((reference) =>
                    command({
                      type: "asset",
                      reference,
                      label: work?.title ?? "成果",
                    }),
                  )
                  .catch(fail)
              }
            >
              {data.assets.some(
                (a) =>
                  a.reference.materialId === version.artifactId &&
                  a.reference.version === version.number &&
                  a.reference.excerpt === undefined,
              )
                ? "已加入资产"
                : "加入资产"}
            </button>
            {work?.deliveryId &&
            (!version.kind || version.kind === "result") ? (
              <button
                onClick={() =>
                  void command({
                    type: "adopt",
                    deliveryId: work.deliveryId!,
                    versionId: version.id,
                  }).catch(fail)
                }
              >
                <Check size={15} />
                采用此版本
              </button>
            ) : null}
          </div>
        </>
      ) : (
        <div className="empty">
          <h3>成果尚未形成</h3>
          <p>完成分析与核查后，可在这里阅读、修订和导出。</p>
        </div>
      )}
    </section>
  );
  const decision = (
    <section className="decision-pane">
      <div className="conversation">
        <small>当前目标</small>
        <h2>{work?.title ?? "开始一项工作"}</h2>
        {messages.map((m) => (
          <article key={m.id} className={`message ${m.role}`}>
            <small>{m.role === "user" ? "你" : "团队"}</small>
            <Markdown>{m.body}</Markdown>
          </article>
        ))}
        {runs
          .filter((r) => r.status === "unknown")
          .map((r) => (
            <UnknownRunActions
              key={r.id}
              id={r.id}
              kind="work"
              local={r.recovery === "local"}
              onError={fail}
            />
          ))}
        {latestRun?.error ? (
          <p className="error-inline">{latestRun.error}</p>
        ) : null}
      </div>
      {composer}
    </section>
  );
  return (
    <div
      className={`app ${immersive ? "immersive" : ""} ${expanded ? "nav-wide" : ""}`}
    >
      {!immersive ? (
        <aside className="navigation">
          <IconButton
            label="展开或收起导航"
            onClick={() => setExpanded((v) => !v)}
          >
            <Menu size={21} />
          </IconButton>
          <img className="brand" src={productMark} alt="ytriple" />
          <nav>
            {(Object.keys(names) as Page[]).map((p) => {
              const Icon = icons[p];
              return (
                <button
                  key={p}
                  className={page === p ? "selected" : ""}
                  aria-current={page === p ? "page" : undefined}
                  title={names[p]}
                  onClick={() => navigate(p)}
                >
                  <Icon size={21} />
                  <span>{names[p]}</span>
                </button>
              );
            })}
          </nav>
          <small className="local-label" title={data.workspace?.name}>
            {data.workspace?.id && data.workspace.id !== "primary"
              ? data.workspace.name
              : "本地空间"}
          </small>
        </aside>
      ) : null}
      <div className="workspace">
        <header className="topbar">
          {data.workspace?.id && data.workspace.id !== "primary" ? (
            <button
              className="quiet active-space"
              title={`当前工作空间：${data.workspace.name}`}
              aria-label={`管理工作空间 ${data.workspace.name}`}
              onClick={() => {
                setImmersive(false);
                setPage("settings");
              }}
            >
              {data.workspace.name}
            </button>
          ) : null}
          {immersive ? (
            <>
              <button className="quiet" onClick={() => setImmersive(false)}>
                <ArrowLeft size={16} />
                返回{project ? "项目" : names[page]}
              </button>
              <span className="breadcrumb">
                {project?.name ?? "独立工作"} / {work?.title ?? "新工作"}
              </span>
              <div className="toolbar">
                <button onClick={() => setDialog("team")}>团队与流程</button>
              </div>
            </>
          ) : (
            <>
              <strong>ytriple</strong>
              <span className="breadcrumb">/ {names[page]}</span>
              <button
                className="quiet top-search"
                onClick={() => setDialog("search")}
              >
                <Search size={16} />
                查找工作
              </button>
              <span className="service-status">
                {data.model?.mode === "direct"
                  ? `自带 API · ${data.model.label}`
                  : data.service.connected
                    ? "服务已连接"
                    : "本地工作空间"}
              </span>
            </>
          )}
        </header>
        {error ? (
          <div className="error-banner" role="alert">
            {error}
            <IconButton label="关闭提示" onClick={() => setError("")}>
              <X size={15} />
            </IconButton>
          </div>
        ) : null}
        {immersive ? (
          <WorkArea
            view={viewState.view}
            layout={viewState.layout}
            onLayout={viewState.configure}
            onView={(patch) => viewState.update(context, patch)}
            onScroll={(key, top) => viewState.position(context, key, top)}
          >
            {{ decision, process, result }}
          </WorkArea>
        ) : (
          <main
            className={`page page-${page} ${work ? "with-conversation" : ""}`}
          >
            {page === "home" ? (
              <div className="home-content">
                <header className="page-intro">
                  <div>
                    <span className="eyebrow">YTRIPLE / WORKSPACE</span>
                    <h1>你的工作台</h1>
                    <p>接续手头的工作，也看看新的变化。</p>
                  </div>
                  <span className="today-label">
                    {new Date().toLocaleDateString("zh-CN", {
                      month: "long",
                      day: "numeric",
                      weekday: "long",
                    })}
                  </span>
                </header>
                <div className="dashboard">
                  <section>
                    {data.schedules
                      .filter(
                        (s, i, all) =>
                          scheduleProblem(
                            s,
                            data.scheduleOccurrences,
                            data.runs,
                          ) &&
                          all.findIndex(
                            (other) =>
                              other.workId === s.workId &&
                              scheduleProblem(
                                other,
                                data.scheduleOccurrences,
                                data.runs,
                              ),
                          ) === i,
                      )
                      .map((s) => (
                        <article className="schedule-attention" key={s.id}>
                          <small>定时任务需处理</small>
                          <h2>{s.name}</h2>
                          <p>
                            {scheduleProblem(
                              s,
                              data.scheduleOccurrences,
                              data.runs,
                            )}
                          </p>
                          <button
                            className="text-action"
                            onClick={() => {
                              setScheduleId(s.id);
                              setPage("schedules");
                            }}
                          >
                            查看任务
                            <ArrowUpRight size={16} />
                          </button>
                        </article>
                      ))}
                    <div className="section-heading">
                      <h2>
                        <Layers size={17} />
                        继续工作
                      </h2>
                      <small>
                        {works.filter((w) => !w.completedAt).length
                          ? `${works.filter((w) => !w.completedAt).length} 项进行中`
                          : ""}
                      </small>
                    </div>
                    {workList(
                      works
                        .filter(
                          (w) =>
                            !w.completedAt &&
                            !data.schedules.some(
                              (s) =>
                                s.workId === w.id &&
                                scheduleProblem(
                                  s,
                                  data.scheduleOccurrences,
                                  data.runs,
                                ),
                            ),
                        )
                        .slice()
                        .reverse()
                        .sort(
                          (a, b) =>
                            Number(
                              data.decisions.some(
                                (d) =>
                                  d.workId === b.id && d.status === "pending",
                              ),
                            ) -
                            Number(
                              data.decisions.some(
                                (d) =>
                                  d.workId === a.id && d.status === "pending",
                              ),
                            ),
                        )
                        .slice(0, 5),
                    )}
                  </section>
                  <section className="radar-column">
                    <div className="section-heading">
                      <h2>
                        <Radar size={18} />
                        雷达观察
                      </h2>
                      <IconButton
                        label="同步来源材料"
                        disabled={syncing}
                        onClick={() => void sync()}
                      >
                        <RefreshCw size={18} />
                      </IconButton>
                    </div>

                    <RadarHighlights
                      onMaterial={setReading}
                      data={data}
                      onOpen={openRadar}
                      onExplore={() => openRadar(null)}
                    />
                  </section>
                </div>
              </div>
            ) : null}
            {page === "radar" ? (
              <Suspense fallback={<p className="wide-content">打开雷达…</p>}>
                <RadarPanel
                  data={data}
                  selectedId={radarEditionId}
                  onSelect={openRadar}
                  onUse={(edition) => void useRadarEdition(edition).catch(fail)}
                  onMaterial={setReading}
                  onWork={(id) => openWork(id)}
                  onSync={() => void sync()}
                  syncing={syncing}
                  onError={fail}
                />
              </Suspense>
            ) : null}
            {page === "projects" ? (
              <section className="wide-content">
                {project ? (
                  <>
                    <button
                      className="quiet"
                      onClick={() => {
                        setProjectId(null);
                        setSelectedDelivery(null);
                        changeContext("new");
                      }}
                    >
                      <ArrowLeft size={15} />
                      所有项目
                    </button>
                    <header className="page-intro project-intro">
                      <div>
                        <span className="eyebrow">
                          {project.kind === "media" ? "创作项目" : "软件项目"}
                        </span>
                        <h1>{project.name}</h1>
                        <p>{project.goal}</p>
                      </div>
                      <IconButton
                        label="目标、标准与资料"
                        onClick={() => {
                          setStandardCandidate(undefined);
                          setRequirementsProject(project.id);
                        }}
                      >
                        <SlidersHorizontal size={20} />
                      </IconButton>
                    </header>
                    <nav className="section-tabs" aria-label="项目内容">
                      <button
                        aria-pressed={projectTab === "overview"}
                        onClick={() => setProjectTab("overview")}
                      >
                        <Layers size={16} />
                        概览与交付
                      </button>
                      <button
                        aria-pressed={projectTab === "files"}
                        onClick={() => setProjectTab("files")}
                      >
                        <Folder size={16} />
                        项目资料
                      </button>
                    </nav>
                    {projectTab === "files" ? (
                      <div className="project-files-view">
                        <Suspense fallback={null}>
                          <ProjectFolder
                            data={data}
                            project={project}
                            onError={fail}
                          />
                        </Suspense>
                        <div className="project-context-summary">
                          <span>
                            {
                              latestStandards(
                                data.projectStandards,
                                project.id,
                              ).filter((s) => s.enabled).length
                            }{" "}
                            条已采纳标准 ·{" "}
                            {latestBrief(data.projectBriefs, project.id)?.refs
                              .length ?? 0}{" "}
                            份参考资料
                          </span>
                          <button
                            className="quiet"
                            onClick={() => {
                              setStandardCandidate(undefined);
                              setRequirementsProject(project.id);
                            }}
                          >
                            目标、标准与资料
                          </button>
                        </div>
                        {project.kind === "software" &&
                        (!project.directory ||
                          data.initializations.some(
                            (p) => p.input.projectId === project.id,
                          )) ? (
                          <button
                            className="quiet"
                            onClick={() => setInitializing(project.id)}
                          >
                            <FolderGit2 size={17} />
                            {project.directory
                              ? "查看初始化与交接"
                              : "初始化本地项目"}
                          </button>
                        ) : null}
                        {project.directory ? (
                          <Suspense fallback={null}>
                            <ProjectFilesPanel
                              key={project.id + project.directory}
                              data={data}
                              project={project}
                              onError={fail}
                              onWork={(id, versionId) => {
                                openWork(id, versionId);
                                setImmersive(true);
                              }}
                              onDraft={async (draft) => {
                                setData(
                                  await command<Snapshot>({ type: "snapshot" }),
                                );
                                changeContext(draft.id);
                                setProjectId(project.id);
                                setSelectedDelivery(null);
                                setImmersive(true);
                                setComposerFocus((n) => n + 1);
                              }}
                            />
                            <SuggestionLocation
                              data={data}
                              project={project}
                              onError={fail}
                            />
                          </Suspense>
                        ) : null}
                      </div>
                    ) : (
                      <div className="project-overview">
                        <div className="section-heading">
                          <h2>
                            {project.kind === "media"
                              ? "作品与交付"
                              : "版本与交付"}
                          </h2>
                          <button onClick={() => setDialog("delivery")}>
                            <Plus size={15} />
                            新增交付
                          </button>
                        </div>
                        {data.deliveries
                          .filter((d) => d.projectId === project.id)
                          .map((d) => (
                            <article className="delivery" key={d.id}>
                              <button
                                className="work-title"
                                onClick={() => {
                                  const related = works.filter(
                                    (w) => w.deliveryId === d.id,
                                  );
                                  setSelectedDelivery(d.id);
                                  if (related.length === 1)
                                    openWork(related[0].id);
                                  else
                                    changeContext(
                                      (related.length
                                        ? "select:delivery:"
                                        : "new:delivery:") + d.id,
                                    );
                                }}
                              >
                                {d.title}
                                {selectedDelivery === d.id ? (
                                  <Check size={16} />
                                ) : null}
                              </button>
                              {d.adoptedVersionId ? (
                                <button
                                  className="quiet"
                                  onClick={() => {
                                    const adopted = data.versions.find(
                                      (v) => v.id === d.adoptedVersionId,
                                    );
                                    if (adopted) {
                                      openWork(adopted.workId, adopted.id);
                                      setImmersive(true);
                                    }
                                  }}
                                >
                                  已采用 · v
                                  {
                                    data.versions.find(
                                      (v) => v.id === d.adoptedVersionId,
                                    )?.number
                                  }
                                </button>
                              ) : (
                                <p>尚未采用成果版本</p>
                              )}
                              {d.adoptedVersionId ? (
                                <details className="delivery-options">
                                  <summary
                                    aria-label={`交付操作 ${d.title}`}
                                    title="交付操作"
                                  >
                                    <Ellipsis size={18} />
                                  </summary>
                                  <div>
                                    <button
                                      className="quiet"
                                      onClick={() =>
                                        void command({
                                          type: "clear-adoption",
                                          deliveryId: d.id,
                                          expectedVersionId:
                                            d.adoptedVersionId!,
                                        }).catch(fail)
                                      }
                                    >
                                      解除采用
                                    </button>
                                  </div>
                                </details>
                              ) : null}
                            </article>
                          ))}
                        <div className="section-heading">
                          <h2>相关工作</h2>
                          <button
                            onClick={() => {
                              changeContext(
                                selectedDelivery
                                  ? "new:delivery:" + selectedDelivery
                                  : "new:" + project.id,
                              );
                            }}
                          >
                            开始另一项工作
                          </button>
                        </div>
                        {selectedDelivery ? (
                          <p className="muted">
                            {
                              data.deliveries.find(
                                (d) => d.id === selectedDelivery,
                              )?.title
                            }{" "}
                            · 选择要接续的工作{" "}
                            <button
                              className="quiet"
                              onClick={() => {
                                setSelectedDelivery(null);
                                changeContext("new:" + project.id);
                              }}
                            >
                              全部交付
                            </button>
                          </p>
                        ) : null}
                        {workList(
                          works.filter(
                            (w) =>
                              w.projectId === project.id &&
                              (!selectedDelivery ||
                                w.deliveryId === selectedDelivery),
                          ),
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="section-heading page-intro">
                      <div>
                        <small>PROJECTS</small>
                        <h1>持续推进的事</h1>
                      </div>
                      <button
                        className="primary"
                        onClick={() => setDialog("project")}
                      >
                        新建项目
                      </button>
                    </div>
                    <details className="local-project-discovery">
                      <summary>
                        <FolderGit2 size={16} />从 Code 目录关联项目
                      </summary>
                      <Suspense fallback={null}>
                        <LocalProjects data={data} onError={fail} />
                      </Suspense>
                    </details>
                    <div className="project-grid">
                      {data.projects.length ? (
                        data.projects.map((p) => (
                          <article className="project-row" key={p.id}>
                            <div className="project-card-icon">
                              {p.kind === "media" ? (
                                <FileText size={23} />
                              ) : (
                                <FolderGit2 size={23} />
                              )}
                            </div>
                            <button
                              className="work-title"
                              onClick={() => {
                                setProjectId(p.id);
                                setProjectTab("overview");
                                setSelectedDelivery(null);
                                changeContext("new:" + p.id);
                              }}
                            >
                              {p.name}
                              <ArrowUpRight size={20} />
                            </button>
                            <p>{p.goal}</p>
                            <div className="project-card-footer">
                              <small>
                                {p.kind === "media" ? "创作" : "软件"}
                              </small>
                              <span>
                                {
                                  data.deliveries.filter(
                                    (d) => d.projectId === p.id,
                                  ).length
                                }{" "}
                                项交付 ·{" "}
                                {
                                  works.filter(
                                    (w) =>
                                      w.projectId === p.id && !w.completedAt,
                                  ).length
                                }{" "}
                                项进行中
                              </span>
                            </div>
                          </article>
                        ))
                      ) : (
                        <div className="empty">
                          <h2>为持续的目标留一个位置</h2>
                          <p>
                            项目组织作品、版本和相关工作。临时问题可以直接从首页开始。
                          </p>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </section>
            ) : null}
            {page === "assets" ? (
              <Suspense fallback={<p className="wide-content">打开资产…</p>}>
                <AssetLibrary
                  data={data}
                  onMethodPrepared={useMethodDraft}
                  onNavigate={openMethodSource}
                  onError={fail}
                  onUse={async (assetId) => {
                    const draft = await command<import("../core/types").Draft>({
                      type: "asset-use",
                      assetId,
                    });
                    setData(await command<Snapshot>({ type: "snapshot" }));
                    changeContext(draft.id);
                    setProjectId(draft.projectId);
                    setSelectedDelivery(null);
                    setExtra([]);
                    setImmersive(true);
                    setComposerFocus((n) => n + 1);
                  }}
                />
              </Suspense>
            ) : null}
            {page === "schedules" ? (
              <Suspense
                fallback={<p className="wide-content">打开定时任务…</p>}
              >
                <SchedulesPage
                  data={data}
                  onRadar={openRadar}
                  selectedId={scheduleId}
                  onSelect={setScheduleId}
                  onWork={(id, versionId) => {
                    openWork(id, versionId);
                    setImmersive(true);
                  }}
                />
              </Suspense>
            ) : null}
            {page === "settings" ? (
              <section className="settings-content">
                <header className="page-intro">
                  <div>
                    <span className="eyebrow">PREFERENCES</span>
                    <h1>工作空间设置</h1>
                  </div>
                </header>
                <div className="settings-layout">
                  <nav className="settings-nav" aria-label="设置分类">
                    {[
                      ["connection", "服务与模型"],
                      ["files", "本地目录"],
                      ["space", "空间与数据"],
                      ["team", "团队与协作"],
                    ].map(([id, label]) => (
                      <button
                        key={id}
                        aria-pressed={settingsTab === id}
                        onClick={() => setSettingsTab(id)}
                      >
                        {label}
                      </button>
                    ))}
                  </nav>
                  <div className="settings-panel">
                    <Suspense fallback={null}>
                      {settingsTab === "files" ? (
                        <LocalFolderSettings data={data} onError={fail} />
                      ) : null}
                      {settingsTab === "space" ? (
                        <WorkspaceSettings onError={fail} />
                      ) : null}
                      {settingsTab === "connection" ? (
                        <>
                          <AccountSettings data={data} onError={fail} />
                          <ModelSettings data={data} onError={fail} />
                        </>
                      ) : null}
                    </Suspense>
                    {settingsTab === "team" ? (
                      <>
                        <h2>团队与协作</h2>
                        <p>成员搭配与协作流程分别管理。</p>
                        <button onClick={() => setDialog("team")}>
                          管理默认搭配与流程
                          <ArrowUpRight size={16} />
                        </button>
                      </>
                    ) : null}
                    {settingsTab === "space" ? (
                      <>
                        <h2>数据与设备</h2>
                        {data.desktop ? (
                          <details>
                            <summary>
                              ytriple {data.desktop.version} ·{" "}
                              {data.desktop.packaged ? "安装版" : "开发运行"}
                            </summary>
                            <p>
                              {data.desktop.platform} · {data.desktop.arch} ·{" "}
                              {data.desktop.buildId}
                            </p>
                            <p className="local-path">
                              {data.desktop.dataDirectory}
                            </p>
                          </details>
                        ) : null}
                        <p>
                          工作、草稿、材料和成果版本保存在这台设备。尚未开启跨设备同步。
                        </p>
                      </>
                    ) : null}
                  </div>
                </div>
              </section>
            ) : null}
            {work ? (
              <section className="light-conversation">
                <div className="section-heading conversation-heading">
                  <div>
                    <span className="eyebrow">
                      {project?.name ?? "独立工作"}
                    </span>
                    <h1>{work.title}</h1>
                  </div>
                  <IconButton
                    label="收起对话"
                    onClick={() => {
                      changeContext(projectId ? "new:" + projectId : "new");
                    }}
                  >
                    <X size={19} />
                  </IconButton>
                </div>
                <div className="work-view-shortcuts">
                  <button
                    className="team-workspace-entry"
                    onClick={() => setImmersive(true)}
                  >
                    <PanelsTopLeft size={19} />
                    <span>
                      团队工作区<small>决策 · 过程 · 结果</small>
                    </span>
                    <ArrowUpRight size={17} />
                  </button>
                  {version ? (
                    <button
                      onClick={() => {
                        setSelectedVersion(version.id);
                        viewState.update(context, { surface: "result" });
                        setImmersive(true);
                      }}
                    >
                      <FileOutput size={18} />
                      <span>
                        查看成果<small>{versionLabel(version)}</small>
                      </span>
                      <ArrowUpRight size={16} />
                    </button>
                  ) : null}
                </div>
                {messages.slice(-4).map((m) => (
                  <article className={`message ${m.role}`} key={m.id}>
                    <small>{m.role === "user" ? "你" : "团队"}</small>
                    <Markdown>{m.body}</Markdown>
                  </article>
                ))}
                {runs
                  .filter((r) => r.status === "unknown")
                  .map((r) => (
                    <UnknownRunActions
                      key={r.id}
                      id={r.id}
                      kind="work"
                      local={r.recovery === "local"}
                      onError={fail}
                    />
                  ))}
                {latestRun?.error ? (
                  <p className="error-inline">{latestRun.error}</p>
                ) : null}
              </section>
            ) : null}
          </main>
        )}
        {!immersive ? (
          <>
            {" "}
            {(page === "home" ||
              (page === "projects" && project && projectTab === "overview") ||
              (page === "radar" && context.startsWith("new:radar:")) ||
              work) &&
            !context.startsWith("select:delivery:") ? (
              <div
                className={`composer-dock ${work ? "conversation-dock" : ""}`}
              >
                {composer}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
      {reading ? (
        <Dialog title={reading.title} onClose={() => setReading(null)}>
          <small>
            v{reading.version} · {coverageLabel(reading.coverage)}
          </small>
          {reading.url ? <p className="source-url">{reading.url}</p> : null}
          {reading.feedSource ? (
            <p className="muted">
              来自订阅{" "}
              {data.feeds.find((s) => s.id === reading.feedSource?.sourceId)
                ?.name ?? reading.feedSource.sourceUrl}{" "}
              · 读取于 {new Date(reading.feedSource.fetchedAt).toLocaleString()}{" "}
              ·{" "}
              {reading.feedSource.publishedAt
                ? `发布于 ${new Date(reading.feedSource.publishedAt).toLocaleString()}`
                : "发布时间未知"}
              。订阅节选不代表网站全文。
            </p>
          ) : null}
          <div className="reading-body">
            <Markdown>{reading.body}</Markdown>
          </div>
          <div className="dialog-actions">
            <button
              onClick={() =>
                void command({
                  type: "asset",
                  label: reading.title,
                  reference: {
                    materialId: reading.id,
                    version: reading.version,
                    label: reading.title,
                  },
                }).catch(fail)
              }
            >
              加入资产
            </button>
            <button
              className="primary"
              onClick={() => void useMaterial(reading).catch(fail)}
            >
              围绕材料开展工作
            </button>
          </div>
        </Dialog>
      ) : null}
      {dialog === "project" ? (
        <Dialog title="新建项目" onClose={() => setDialog(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void command<Project>({
                type: "project",
                name: String(f.get("name")),
                goal: String(f.get("goal")),
                kind: f.get("kind") as Project["kind"],
              })
                .then((p) => {
                  setProjectId(p.id);
                  setSelectedDelivery(null);
                  changeContext("new:" + p.id);
                  setDialog(null);
                })
                .catch(fail);
            }}
          >
            <label>
              项目名称
              <input autoFocus name="name" required />
            </label>
            <label>
              持续目标
              <textarea name="goal" rows={3} />
            </label>
            <label>
              项目类型
              <select name="kind">
                <option value="software">软件项目</option>
                <option value="media">创作项目</option>
              </select>
            </label>
            <button type="submit" className="primary">
              创建项目
            </button>
          </form>
        </Dialog>
      ) : null}
      {dialog === "delivery" && project ? (
        <Dialog title="新增交付" onClose={() => setDialog(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const title = String(new FormData(e.currentTarget).get("title"));
              void command<Delivery>({
                type: "delivery",
                projectId: project.id,
                title,
              })
                .then(() => setDialog(null))
                .catch(fail);
            }}
          >
            <label>
              这次要交付什么
              <input autoFocus name="title" required />
            </label>
            <button type="submit" className="primary">
              创建交付
            </button>
          </form>
        </Dialog>
      ) : null}
      {dialog === "search" ? (
        <Dialog title="查找工作" onClose={() => setDialog(null)}>
          <input
            autoFocus
            aria-label="搜索工作"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="名称、目标…"
          />
          <label className="search-filters">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            包含已归档
          </label>
          {data.works
            .filter((w) => showArchived || !w.archived)
            .filter((w) => w.title.includes(query))
            .map((w) => (
              <button
                className="search-result"
                key={w.id}
                onClick={() => {
                  openWork(w.id);
                  setDialog(null);
                }}
              >
                {w.title}
                {w.archived ? " · 已归档" : w.completedAt ? " · 已完成" : ""}
                <ArrowUpRight size={16} />
              </button>
            ))}
        </Dialog>
      ) : null}
      {dialog === "team" ? (
        <Dialog title="团队与流程" onClose={() => setDialog(null)}>
          <ConfigurationEditor
            data={data}
            work={work}
            onApplied={() => {
              void command<Snapshot>({ type: "snapshot" })
                .then(setData)
                .catch(fail);
            }}
          />
        </Dialog>
      ) : null}
      {dialog === "work" && work ? (
        <Dialog title="工作名称与归属" onClose={() => setDialog(null)}>
          {!work.archived &&
          !work.completedAt &&
          data.runs.some(
            (r) => r.workId === work.id && r.status === "succeeded",
          ) ? (
            <button
              className="text-action"
              onClick={() => {
                setDialog(null);
                setScheduleWork(work.id);
              }}
            >
              <Clock size={16} />
              设为定时任务
            </button>
          ) : null}
          <WorkEditor
            work={work}
            data={data}
            onSaved={(w) => {
              setProjectId(w.projectId);
              setSelectedDelivery(w.deliveryId);
              setDialog(null);
              if (w.projectId) setPage("projects");
              else setPage("home");
              void command<Snapshot>({ type: "snapshot" })
                .then(setData)
                .catch(fail);
            }}
          />
        </Dialog>
      ) : null}
      {scheduleWork ? (
        <Suspense fallback={null}>
          <ScheduleEditor
            data={data}
            workId={scheduleWork}
            onClose={() => setScheduleWork(null)}
            onSaved={(s) => {
              setScheduleWork(null);
              setScheduleId(s.id);
              setImmersive(false);
              setPage("schedules");
            }}
          />
        </Suspense>
      ) : null}
      {initializing && data.projects.some((p) => p.id === initializing) ? (
        <Suspense fallback={null}>
          <ProjectInitializer
            key={initializing}
            data={data}
            project={data.projects.find((p) => p.id === initializing)!}
            onClose={() => setInitializing(null)}
            onSettings={() => {
              setInitializing(null);
              setImmersive(false);
              setPage("settings");
            }}
          />
        </Suspense>
      ) : null}
      {outcomeVersion && data.versions.some((v) => v.id === outcomeVersion) ? (
        <Suspense fallback={null}>
          <OutcomeDialog
            key={outcomeVersion}
            data={data}
            version={data.versions.find((v) => v.id === outcomeVersion)!}
            onClose={() => setOutcomeVersion(null)}
            onVersion={(id) => {
              setSelectedVersion(id);
              setOutcomeVersion(null);
            }}
            onPrepared={async (draft) => {
              setData(await command<Snapshot>({ type: "snapshot" }));
              setOutcomeVersion(null);
              changeContext(draft.id);
              setExtra([]);
              setComposerEpoch((n) => n + 1);
              if (viewState.view.focused || window.innerWidth < 900)
                viewState.update(draft.id, { focused: "decision" });
              setComposerFocus((n) => n + 1);
            }}
          />
        </Suspense>
      ) : null}
      {suggestion &&
      data.projects.some((p) => p.id === suggestion.projectId) ? (
        <Suspense fallback={null}>
          <SuggestionDialog
            key={suggestion.version.id}
            data={data}
            project={data.projects.find((p) => p.id === suggestion.projectId)!}
            version={suggestion.version}
            excerpt={suggestion.excerpt}
            onClose={() => setSuggestion(null)}
          />
        </Suspense>
      ) : null}
      {requirementsProject &&
      data.projects.find((p) => p.id === requirementsProject) ? (
        <Suspense fallback={<p role="status">打开项目要求…</p>}>
          <ProjectContextEditor
            key={requirementsProject}
            project={data.projects.find((p) => p.id === requirementsProject)!}
            data={data}
            candidate={standardCandidate}
            onClose={() => {
              setRequirementsProject(null);
              setStandardCandidate(undefined);
            }}
          />
        </Suspense>
      ) : null}
      {comparing && data.versions.find((v) => v.id === comparing) ? (
        <Suspense fallback={<p role="status">打开版本比较…</p>}>
          <VersionCompare
            versions={data.versions}
            selected={data.versions.find((v) => v.id === comparing)!}
            onClose={() => setComparing(null)}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
