import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  Archive,
  ArrowUpRight,
  BookOpen,
  BookmarkPlus,
  Sparkles,
  ArrowRight,
  Check,
  ChevronDown,
  FileText,
  FolderOpen,
  History,
  Image,
  Pencil,
  Plus,
  Presentation,
  Save,
  X,
} from "lucide-react";
import type { Artifact, Source, Task, Snapshot } from "../shared/types";
import { ArtifactDeliveryPanel } from "./Deliveries";
import { formatDate, formatTime, Markdown, type Dispatch } from "./common";
import { discardTaskDocumentDrafts, useDocumentDraft } from "./drafts";
import { LIBRARY_ASSESSMENT_LABELS } from "../shared/library";

const refinementDrafts = new Map<
  string,
  { instruction: string; hash: string }
>();
const pendingEdits = new Map<string, "save" | "refine">();
const pendingListeners = new Set<() => void>();
const subscribePending = (listener: () => void) => {
  pendingListeners.add(listener);
  return () => {
    pendingListeners.delete(listener);
  };
};
function setPending(key: string, action?: "save" | "refine") {
  if (action) pendingEdits.set(key, action);
  else pendingEdits.delete(key);
  pendingListeners.forEach((listener) => listener());
}
export function discardTaskArtifactDrafts(taskId: string) {
  discardTaskDocumentDrafts(taskId);
  for (const key of refinementDrafts.keys()) {
    if (key.startsWith(`${taskId}:`)) refinementDrafts.delete(key);
  }
}

export function SourceList({
  sources,
  dispatch,
  onAdd,
  onLibrary,
}: {
  sources: Source[];
  dispatch: Dispatch;
  onAdd?: () => void;
  onLibrary?: (entryId: string) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(
    () => sources[0]?.id ?? null,
  );
  if (!sources.length)
    return (
      <div className="panel-empty">
        <div className="empty-symbol">
          <BookOpen size={24} strokeWidth={1.3} />
        </div>
        <h3>让讨论有据可依</h3>
        <p>
          放入一篇文章、一份文档，
          <br />
          或者你已经整理好的想法。
        </p>
        {onAdd ? (
          <button className="button secondary small" onClick={onAdd}>
            <Plus size={14} />
            添加资料
          </button>
        ) : null}
      </div>
    );
  return (
    <div className="source-list">
      {sources.map((source) => (
        <article
          className={`source-item ${source.library?.supersededAt ? "library-historical" : ""}`}
          key={source.id}
        >
          <button
            className="source-title"
            onClick={() =>
              setExpanded(expanded === source.id ? null : source.id)
            }
            aria-expanded={expanded === source.id}
          >
            <span>{source.title}</span>
            <ChevronDown
              size={14}
              className={expanded === source.id ? "rotated" : ""}
            />
          </button>
          {expanded === source.id ? (
            <div className="source-expanded">
              <div className="source-meta">
                <span>
                  {source.type === "url"
                    ? "网页"
                    : source.type === "file"
                      ? "本地文件"
                      : "文本"}
                </span>
                <span>{formatDate(source.addedAt)}</span>
              </div>
              <p className="coverage">
                {source.library
                  ? "来自本地资产 的正文快照，保留原成果与版本关联。"
                  : source.coverage || "内容范围待核实"}
              </p>
              {source.library ? (
                <div className="source-library-context">
                  <strong>
                    {source.library.supersededAt
                      ? "历史资产快照 · 本轮不再使用"
                      : source.library.selection === "recalled"
                        ? "为当前问题找到的资产"
                        : "选入的资产"}{" "}
                    · v{source.library.version}
                  </strong>
                  <p>
                    {LIBRARY_ASSESSMENT_LABELS[source.library.assessment]} ·{" "}
                    {source.library.feedbackRevision} 条反馈
                  </p>
                  <p>{source.library.reason}</p>
                  {onLibrary ? (
                    <button
                      className="text-button"
                      onClick={() => onLibrary(source.library!.entryId)}
                    >
                      查看资产与记录反馈 <ArrowUpRight size={13} />
                    </button>
                  ) : null}
                </div>
              ) : null}
              {source.library ? (
                <details>
                  <summary>来源与版本记录</summary>
                  <p className="source-excerpt">{source.coverage}</p>
                </details>
              ) : null}
              {source.library?.feedback.map((feedback) => (
                <p key={feedback.id} className="source-excerpt">
                  用户反馈 · v{feedback.targetVersion}：{feedback.note}
                  {feedback.conditions
                    ? `（条件：${feedback.conditions}）`
                    : ""}
                </p>
              ))}
              <p className="source-excerpt">
                {source.text || "此资料暂未取得可阅读内容。"}
              </p>
              <button
                className="text-button"
                onClick={() =>
                  void dispatch(
                    source.type === "url"
                      ? { type: "url.open", url: source.location }
                      : { type: "path.reveal", path: source.location },
                  )
                }
                disabled={source.type === "text"}
              >
                查看来源
                <ArrowUpRight size={13} />
              </button>
            </div>
          ) : null}
        </article>
      ))}
    </div>
  );
}

function ArtifactActionMenu({
  label,
  accessibleLabel,
  icon,
  children,
}: {
  label: string;
  accessibleLabel: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  const close = (restoreFocus = false) => {
    if (!details.current) return;
    details.current.open = false;
    if (restoreFocus) details.current.querySelector("summary")?.focus();
  };
  return (
    <details
      ref={details}
      className="artifact-action-menu"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close(true);
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) close();
      }}
    >
      <summary aria-label={accessibleLabel}>
        {icon}
        {label}
        <ChevronDown size={12} />
      </summary>
      <div
        className="artifact-action-options"
        onClick={(event) => {
          const button = (event.target as HTMLElement).closest("button");
          if (button && !button.disabled) close(true);
        }}
      >
        {children}
      </div>
    </details>
  );
}

export function ArtifactView({
  artifact,
  task,
  dispatch,
  compact = false,
  delivery,
}: {
  artifact: Artifact;
  task: Task;
  dispatch: Dispatch;
  compact?: boolean;
  delivery?: ReactNode;
}) {
  const {
    draft: editState,
    setDraft: setEditState,
    completeDraft,
    changedExternally,
  } = useDocumentDraft(
    `artifact:${task.id}:${artifact.id}`,
    artifact.content ?? "",
    artifact.hash,
  );
  const { editing, content: draft, baseHash } = editState;
  const setEditing = (editing: boolean) =>
    setEditState((current) => ({ ...current, editing }));
  const refinementKey = `${task.id}:${artifact.id}`;
  const readPending = useCallback(
    () => pendingEdits.get(refinementKey),
    [refinementKey],
  );
  const pending = useSyncExternalStore(
    subscribePending,
    readPending,
    readPending,
  );
  const saving = pending === "save";
  const processing = pending === "refine";
  const [refining, setRefining] = useState(() =>
    refinementDrafts.has(refinementKey),
  );
  const [instruction, setInstruction] = useState(
    () => refinementDrafts.get(refinementKey)?.instruction ?? "",
  );
  const [collecting, setCollecting] = useState(false);
  const [collectedHash, setCollectedHash] = useState<string | null>(null);
  const [refineHash, setRefineHash] = useState(
    () => refinementDrafts.get(refinementKey)?.hash ?? artifact.hash,
  );
  useEffect(() => {
    if (instruction)
      refinementDrafts.set(refinementKey, { instruction, hash: refineHash });
    else refinementDrafts.delete(refinementKey);
  }, [refinementKey, instruction, refineHash]);
  useEffect(() => {
    if (!pending && !refinementDrafts.has(refinementKey)) {
      setInstruction("");
      setRefining(false);
    }
  }, [pending, refinementKey]);
  const [history, setHistory] = useState(false);
  const [saved, setSaved] = useState(false);
  const [exporting, setExporting] = useState<"png" | "pptx" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  const beginEdit = () => {
    setEditState({
      content: artifact.content ?? "",
      baseHash: artifact.hash,
      editing: true,
    });
    setSaved(false);
  };
  const save = async () => {
    if (pendingEdits.has(refinementKey)) return;
    setPending(refinementKey, "save");
    try {
      const result = await dispatch({
        type: "artifact.save",
        taskId: task.id,
        artifactId: artifact.id,
        content: draft,
        expectedHash: baseHash,
      });
      if (result) {
        completeDraft(editState);
        if (mounted.current) {
          setSaved(true);
          timer.current = setTimeout(() => setSaved(false), 2400);
        }
      }
    } finally {
      setPending(refinementKey);
    }
  };
  const exportArtifact = async (format: "png" | "pptx") => {
    if (exporting) return;
    setExporting(format);
    await dispatch({
      type: "artifact.export",
      taskId: task.id,
      artifactId: artifact.id,
      format,
    });
    setExporting(null);
  };
  const collect = async () => {
    setCollecting(true);
    const result = await dispatch({
      type: "library.collect",
      taskId: task.id,
      artifactId: artifact.id,
      expectedHash: artifact.hash,
    });
    setCollecting(false);
    if (result) setCollectedHash(artifact.hash);
  };
  const refine = async () => {
    if (!instruction.trim() || pendingEdits.has(refinementKey)) return;
    setPending(refinementKey, "refine");
    try {
      const result = await dispatch({
        type: "artifact.refine",
        taskId: task.id,
        artifactId: artifact.id,
        instruction: instruction.trim(),
        expectedHash: refineHash,
      });
      if (result) {
        refinementDrafts.delete(refinementKey);
        setInstruction("");
        setRefining(false);
      }
    } finally {
      setPending(refinementKey);
    }
  };
  return (
    <div className={`artifact-view ${compact ? "compact" : ""}`}>
      <div className="artifact-actions grouped-artifact-actions">
        <div
          className="artifact-edit-actions"
          role="group"
          aria-label="编辑与加工"
        >
          {artifact.format === "md" || artifact.format === "html" ? (
            editing ? (
              <>
                <button
                  className="button primary small"
                  disabled={saving || changedExternally}
                  onClick={() => void save()}
                >
                  <Save size={13} />
                  {saving ? "保存中" : "保存修改"}
                </button>
                <button
                  className="text-button"
                  disabled={saving}
                  onClick={() => setEditing(false)}
                >
                  <X size={13} />
                  取消
                </button>
              </>
            ) : (
              <>
                <button
                  className="button secondary small"
                  disabled={
                    processing ||
                    Boolean(artifact.readError) ||
                    artifact.content === undefined
                  }
                  onClick={beginEdit}
                >
                  <Pencil size={13} />
                  编辑
                </button>
                <button
                  className={`button secondary small ${refining ? "selected" : ""}`}
                  aria-expanded={refining}
                  aria-controls={`refine-form-${artifact.id}`}
                  disabled={
                    processing ||
                    Boolean(artifact.readError) ||
                    artifact.content === undefined
                  }
                  onClick={() => {
                    if (!refining) setRefineHash(artifact.hash);
                    setRefining(!refining);
                  }}
                >
                  <Sparkles size={13} />
                  继续加工
                </button>
              </>
            )
          ) : null}
          {saved ? (
            <span className="saved-label" role="status">
              <Check size={13} />
              已保存
            </span>
          ) : null}
        </div>
        <div
          className="artifact-secondary-actions"
          role="group"
          aria-label="导出与管理"
        >
          {delivery}
          <ArtifactActionMenu
            label={exporting ? "导出中…" : "更多"}
            accessibleLabel="更多成果操作"
            icon={<Archive size={14} />}
          >
            {!editing &&
            (artifact.format === "md" || artifact.format === "html") ? (
              <>
                <span className="action-menu-label">导出</span>
                <button
                  disabled={exporting !== null || Boolean(artifact.readError)}
                  onClick={() => void exportArtifact("pptx")}
                >
                  <Presentation size={14} />
                  演示文稿 · PPTX
                </button>
                <button
                  disabled={exporting !== null || Boolean(artifact.readError)}
                  onClick={() => void exportArtifact("png")}
                >
                  <Image size={14} />
                  信息图 · PNG
                </button>
              </>
            ) : null}
            {!editing ? (
              <>
                <span className="action-menu-label">本地资产</span>
                <button
                  disabled={collecting || Boolean(artifact.readError)}
                  onClick={() => void collect()}
                >
                  <BookmarkPlus size={14} />
                  {collecting
                    ? "收藏中…"
                    : collectedHash === artifact.hash
                      ? "已收藏为资产"
                      : "收藏为资产"}
                </button>
              </>
            ) : null}
            <span className="action-menu-label">版本与文件</span>
            <button
              className={history ? "selected" : ""}
              aria-label="查看版本记录"
              aria-expanded={history}
              aria-controls={`artifact-versions-${artifact.id}`}
              onClick={() => setHistory(!history)}
            >
              <History size={14} />
              {history ? "收起版本记录" : "查看版本记录"}
            </button>
            <button
              aria-label="在访达显示成果"
              onClick={() =>
                void dispatch({ type: "path.reveal", path: artifact.path })
              }
            >
              <FolderOpen size={14} />
              在访达显示
            </button>
          </ArtifactActionMenu>
        </div>
      </div>
      <div className="artifact-document-heading" title={artifact.title}>
        <span className="work-content-muted">
          v{artifact.version} · {artifact.format.toUpperCase()}
        </span>
        {artifact.format !== "md" ||
        !/^#\s+\S/m.test(artifact.content ?? "") ? (
          <h3>{artifact.title}</h3>
        ) : (
          <span className="sr-only">{artifact.title}</span>
        )}
      </div>
      {refining && !editing ? (
        <form
          id={`refine-form-${artifact.id}`}
          className="refine-form"
          onSubmit={(event) => {
            event.preventDefault();
            void refine();
          }}
        >
          <label htmlFor={`refine-${artifact.id}`}>
            让团队接着完善这份成果
          </label>
          <textarea
            id={`refine-${artifact.id}`}
            disabled={processing}
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder="例如：保留结论，补上反方观点；或把第二段改得更简洁。"
            rows={3}
          />
          <div>
            <span>修订会保留版本记录</span>
            <button
              className="button primary small"
              disabled={!instruction.trim() || processing}
            >
              {processing ? "正在交给团队…" : "开始加工"}
              <ArrowRight size={13} />
            </button>
          </div>
        </form>
      ) : null}
      {artifact.format === "png" || artifact.format === "pptx" ? (
        <p className="editor-footnote">
          需要修改时，可选择对应的 MD / HTML 源文档，继续加工并重新导出。
        </p>
      ) : null}
      {artifact.goalVersion !== task.goalVersion ? (
        <div className="inline-notice">
          这是目标版本 {artifact.goalVersion} 下的成果，当前目标已更新。
        </div>
      ) : null}
      {changedExternally ? (
        <div className="inline-notice warning">
          原文已有新版本。你的编辑仍保留，请先复制需要的内容，再取消并重新编辑。
        </div>
      ) : null}
      {artifact.readError ? (
        <div className="inline-notice warning">{artifact.readError}</div>
      ) : null}
      {history ? (
        <ol id={`artifact-versions-${artifact.id}`} className="version-list">
          {artifact.versions.map((version) => (
            <li key={`${version.version}-${version.hash}-${version.path}`}>
              <span className="version-badge">v{version.version}</span>
              <div>
                <strong>{version.summary || "保存成果"}</strong>
                <span>
                  {formatDate(version.createdAt)}{" "}
                  {formatTime(version.createdAt)}
                </span>
              </div>
              <button
                className="icon-button"
                aria-label={`在访达显示版本 ${version.version}`}
                onClick={() =>
                  void dispatch({ type: "path.reveal", path: version.path })
                }
              >
                <ArrowUpRight size={14} />
              </button>
            </li>
          ))}
        </ol>
      ) : null}
      {editing ? (
        <textarea
          className="artifact-editor"
          disabled={saving}
          aria-label={
            artifact.format === "html" ? "HTML 原文编辑" : "Markdown 原文编辑"
          }
          value={draft}
          onChange={(event) =>
            setEditState((current) => ({
              ...current,
              content: event.target.value,
            }))
          }
          spellCheck={false}
        />
      ) : artifact.format === "md" ? (
        <Markdown dispatch={dispatch}>
          {artifact.content || "此成果没有可预览的正文。"}
        </Markdown>
      ) : artifact.format === "html" ? (
        <iframe
          className="html-artifact"
          title={artifact.title}
          sandbox=""
          srcDoc={`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">${artifact.content ?? ""}`}
        />
      ) : artifact.format === "png" && artifact.previewURL ? (
        <img
          className="png-artifact"
          src={artifact.previewURL}
          alt={artifact.title}
        />
      ) : (
        <div className="file-artifact">
          <div className="empty-symbol">
            {artifact.format === "pptx" ? (
              <Presentation size={32} strokeWidth={1.2} />
            ) : (
              <Image size={32} strokeWidth={1.2} />
            )}
          </div>
          <h3>
            {artifact.format === "pptx" ? "演示文稿已保存" : "图片已保存"}
          </h3>
          <p>{artifact.path}</p>
          <button
            className="button secondary small"
            onClick={() =>
              void dispatch({ type: "path.reveal", path: artifact.path })
            }
          >
            在访达中查看
            <ArrowUpRight size={13} />
          </button>
        </div>
      )}
      {editing ? (
        <div className="editor-footnote">
          保留原文版本后保存；写入前核对文件是否被其他操作修改。
        </div>
      ) : null}
    </div>
  );
}

export function ArtifactList({
  task,
  dispatch,
  snapshot,
  onTask,
  compact = false,
  preferredArtifactId,
  detail,
  onCloseDetail,
  onSaveDetail,
}: {
  task: Task;
  dispatch: Dispatch;
  snapshot?: Snapshot;
  onTask?: (id: string) => void;
  compact?: boolean;
  preferredArtifactId?: string;
  detail?: { id: string; title: string; content: string };
  onCloseDetail?: () => void;
  onSaveDetail?: () => void | Promise<void>;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [savingDetail, setSavingDetail] = useState(false);
  const [visited, setVisited] = useState<Set<string>>(() => new Set());
  const reader = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, number>());
  useEffect(() => {
    if (preferredArtifactId) setSelected(preferredArtifactId);
  }, [preferredArtifactId]);
  const artifact =
    task.artifacts.find((item) => item.id === selected) ??
    task.artifacts.at(-1);
  const readingKey = detail ? `detail:${detail.id}` : artifact?.id;
  useLayoutEffect(() => {
    if (reader.current && readingKey)
      reader.current.scrollTop = positions.current.get(readingKey) ?? 0;
  }, [readingKey]);
  useEffect(() => {
    if (artifact) {
      setSelected((current) =>
        task.artifacts.some((item) => item.id === current)
          ? current
          : artifact.id,
      );
      setVisited((current) =>
        current.has(artifact.id) ? current : new Set([...current, artifact.id]),
      );
    }
  }, [artifact?.id]);
  if (!artifact && !detail)
    return (
      <div className="panel-empty">
        <div className="empty-symbol">
          <FileText size={24} strokeWidth={1.3} />
        </div>
        <h3>成果会留在这里</h3>
        <p>
          团队产出的文档与图示，
          <br />
          可以查看、修改，也可以继续讨论。
        </p>
        <span className="empty-footnote">从一项真实工作开始</span>
      </div>
    );
  const choose = (id: string) => {
    setSelected(id);
    onCloseDetail?.();
  };
  const saveDetail = async () => {
    if (savingDetail || !onSaveDetail) return;
    setSavingDetail(true);
    try {
      await onSaveDetail();
    } finally {
      setSavingDetail(false);
    }
  };
  return (
    <section className="artifact-workspace" aria-label="成果阅读与编辑">
      {task.artifacts.length > 1 ? (
        <div className="artifact-choice-row">
          <label>
            <span className="sr-only">选择成果</span>
            <select
              aria-label="选择成果"
              value={artifact?.id ?? ""}
              onChange={(event) => choose(event.target.value)}
            >
              {task.artifacts.toReversed().map((item) => (
                <option value={item.id} key={item.id}>
                  {item.title} · v{item.version}
                  {item.goalVersion !== task.goalVersion
                    ? ` · 旧目标 v${item.goalVersion}`
                    : ""}
                </option>
              ))}
            </select>
          </label>
          <span>{task.artifacts.length} 份成果</span>
        </div>
      ) : null}
      <div
        className="artifact-reader"
        ref={reader}
        onScroll={(event) => {
          if (readingKey)
            positions.current.set(readingKey, event.currentTarget.scrollTop);
        }}
      >
        {detail ? (
          <div
            className="artifact-view conversation-detail"
            aria-label="对话完整内容"
          >
            <div className="artifact-heading">
              <div>
                <span className="eyebrow">对话详情</span>
                <h3>{detail.title}</h3>
              </div>
            </div>
            <div className="artifact-actions">
              <button
                className="button secondary small"
                disabled={savingDetail || !onSaveDetail}
                onClick={() => void saveDetail()}
              >
                <Save size={13} />
                {savingDetail ? "保存中…" : "保存为文档"}
              </button>
              <button className="text-button" onClick={onCloseDetail}>
                <X size={13} />
                关闭详情
              </button>
            </div>
            <Markdown
              dispatch={dispatch}
              onArtifactLink={(id) => {
                if (task.artifacts.some((item) => item.id === id)) choose(id);
              }}
            >
              {detail.content}
            </Markdown>
          </div>
        ) : null}
        {task.artifacts
          .filter((item) => item.id === artifact?.id || visited.has(item.id))
          .map((item) => (
            <div
              hidden={Boolean(detail) || item.id !== artifact?.id}
              key={item.id}
            >
              <ArtifactView
                artifact={item}
                task={task}
                dispatch={dispatch}
                compact={compact}
                delivery={
                  snapshot ? (
                    <ArtifactDeliveryPanel
                      task={task}
                      artifact={item}
                      snapshot={snapshot}
                      dispatch={dispatch}
                      onTask={onTask}
                    />
                  ) : undefined
                }
              />
            </div>
          ))}
      </div>
    </section>
  );
}
