import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Archive,
  ArrowUpRight,
  BookOpen,
  BookmarkPlus,
  Sparkles,
  ArrowRight,
  Check,
  ChevronDown,
  Download,
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
import type { Artifact, Source, Task } from "../shared/types";
import { formatDate, formatTime, Markdown, type Dispatch } from "./common";
import { useDocumentDraft } from "./drafts";

export function SourceList({
  sources,
  dispatch,
  onAdd,
}: {
  sources: Source[];
  dispatch: Dispatch;
  onAdd?: () => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
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
      {sources.map((source, index) => (
        <article className="source-item" key={source.id}>
          <button
            className="source-title"
            onClick={() =>
              setExpanded(expanded === source.id ? null : source.id)
            }
            aria-expanded={expanded === source.id}
          >
            <span className="source-number">
              {String(index + 1).padStart(2, "0")}
            </span>
            <span>{source.title}</span>
            <ChevronDown
              size={14}
              className={expanded === source.id ? "rotated" : ""}
            />
          </button>
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
          <p className="coverage">{source.coverage || "内容范围待核实"}</p>
          {expanded === source.id ? (
            <div className="source-expanded">
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
}: {
  artifact: Artifact;
  task: Task;
  dispatch: Dispatch;
  compact?: boolean;
}) {
  const {
    draft: editState,
    setDraft: setEditState,
    changedExternally,
  } = useDocumentDraft(
    `artifact:${task.id}:${artifact.id}`,
    artifact.content ?? "",
    artifact.hash,
  );
  const { editing, content: draft, baseHash } = editState;
  const setEditing = (editing: boolean) =>
    setEditState((current) => ({ ...current, editing }));
  const [refining, setRefining] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [processing, setProcessing] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [collectedHash, setCollectedHash] = useState<string | null>(null);
  const [refineHash, setRefineHash] = useState(artifact.hash);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState(false);
  const [saved, setSaved] = useState(false);
  const [exporting, setExporting] = useState<"png" | "pptx" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const beginEdit = () => {
    setEditState({
      content: artifact.content ?? "",
      baseHash: artifact.hash,
      editing: true,
    });
    setSaved(false);
  };
  const save = async () => {
    if (saving) return;
    setSaving(true);
    const result = await dispatch({
      type: "artifact.save",
      taskId: task.id,
      artifactId: artifact.id,
      content: draft,
      expectedHash: baseHash,
    });
    setSaving(false);
    if (result) {
      setEditing(false);
      setSaved(true);
      timer.current = setTimeout(() => setSaved(false), 2400);
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
    if (!instruction.trim() || processing) return;
    setProcessing(true);
    const result = await dispatch({
      type: "artifact.refine",
      taskId: task.id,
      artifactId: artifact.id,
      instruction: instruction.trim(),
      expectedHash: refineHash,
    });
    setProcessing(false);
    if (result) {
      setInstruction("");
      setRefining(false);
    }
  };
  return (
    <div className={`artifact-view ${compact ? "compact" : ""}`}>
      <div className="artifact-heading">
        <div>
          <span className="eyebrow">
            {artifact.format.toUpperCase()} · 版本 {artifact.version}
          </span>
          <h3>{artifact.title}</h3>
        </div>
      </div>
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
          {!editing &&
          (artifact.format === "md" || artifact.format === "html") ? (
            <ArtifactActionMenu
              label={exporting ? "导出中…" : "导出"}
              accessibleLabel="导出成果"
              icon={<Download size={14} />}
            >
              <span className="action-menu-label">生成其他格式</span>
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
            </ArtifactActionMenu>
          ) : null}
          <ArtifactActionMenu
            label="管理"
            accessibleLabel="管理成果"
            icon={<Archive size={14} />}
          >
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
                      ? "已收藏到 Lib"
                      : "收藏到 Lib"}
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
  compact = false,
  preferredArtifactId,
}: {
  task: Task;
  dispatch: Dispatch;
  compact?: boolean;
  preferredArtifactId?: string;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (preferredArtifactId) setSelected(preferredArtifactId);
  }, [preferredArtifactId]);
  const artifact =
    task.artifacts.find((item) => item.id === selected) ??
    task.artifacts.at(-1);
  if (!artifact)
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
  return (
    <>
      {task.artifacts.length > 1 ? (
        <label className="artifact-selector">
          <span className="sr-only">选择成果</span>
          <select
            value={artifact.id}
            onChange={(event) => setSelected(event.target.value)}
          >
            {task.artifacts.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title} · {item.format.toUpperCase()} · v{item.version}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <ArtifactView
        key={artifact.id}
        artifact={artifact}
        task={task}
        dispatch={dispatch}
        compact={compact}
      />
    </>
  );
}
