import { useState, useSyncExternalStore, type SetStateAction } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  FileText,
  FolderOpen,
  Link2,
  Pencil,
  Plus,
  Save,
  Search,
  X,
} from "lucide-react";
import type { LibraryEntry, Snapshot } from "../shared/types";
import { formatDate, Markdown, type Dispatch } from "./common";
import { useDocumentDraft } from "./drafts";
import { LibraryFeedbackPanel } from "./LibraryFeedback";
import { SkillCatalog } from "./Skills";
import { PortablePanel } from "./Portable";
import {
  MediaFromMaterial,
  libraryMediaMaterial,
  type MediaMaterialNavigation,
} from "./MediaFromMaterial";
import {
  LIBRARY_ASSESSMENT_LABELS,
  libraryAssessment,
  unresolvedLibraryFeedback,
} from "../shared/library";

type EditMetadata = {
  title: string;
  tags: string;
  note: string;
  resolvedFeedbackIds: string[];
};
const editMetadata = new Map<string, EditMetadata>();
const pendingActions = new Set<string>();
const editListeners = new Set<() => void>();
function subscribeEdits(listener: () => void) {
  editListeners.add(listener);
  return () => {
    editListeners.delete(listener);
  };
}
function announceEdits() {
  editListeners.forEach((listener) => listener());
}

function LibraryDocument({
  entry,
  snapshot,
  dispatch,
  onTask,
  selectedTaskId,
  onMediaCreated,
  onMediaSetup,
}: {
  entry: LibraryEntry;
  snapshot: Snapshot;
  dispatch: Dispatch;
  onTask: (id: string) => void;
  selectedTaskId: string | null;
} & MediaMaterialNavigation) {
  const key = `${snapshot.settings.aiRoot}:${entry.id}`;
  const { draft, setDraft, completeDraft, changedExternally } =
    useDocumentDraft(`library:${key}`, entry.content ?? "", entry.hash);
  const metadata = useSyncExternalStore(
    subscribeEdits,
    () => editMetadata.get(key),
    () => undefined,
  );
  const pending = useSyncExternalStore(
    subscribeEdits,
    () => pendingActions.has(key),
    () => false,
  );
  const { title, tags, note, resolvedFeedbackIds } = metadata ?? {
    title: entry.title,
    tags: entry.tags.join("，"),
    note: entry.note,
    resolvedFeedbackIds: [],
  };
  const setMetadata = (patch: Partial<EditMetadata>) => {
    editMetadata.set(key, {
      title,
      tags,
      note,
      resolvedFeedbackIds,
      ...editMetadata.get(key),
      ...patch,
    });
    announceEdits();
  };
  const setTitle = (title: string) => setMetadata({ title });
  const setTags = (tags: string) => setMetadata({ tags });
  const setNote = (note: string) => setMetadata({ note });
  const setResolvedFeedbackIds = (value: SetStateAction<string[]>) =>
    setMetadata({
      resolvedFeedbackIds:
        typeof value === "function" ? value(resolvedFeedbackIds) : value,
    });
  const setPending = (value: boolean) => {
    if (value) pendingActions.add(key);
    else pendingActions.delete(key);
    announceEdits();
  };
  const [target, setTarget] = useState(selectedTaskId ?? "new");
  const editable = entry.format === "md" || entry.format === "html";
  const save = async () => {
    if (pendingActions.has(key)) return;
    const submitted = draft;
    const submittedMetadata = editMetadata.get(key);
    setPending(true);
    try {
      const result = await dispatch({
        type: "library.save",
        entryId: entry.id,
        content: draft.content,
        expectedHash: draft.baseHash,
        title: title.trim(),
        tags: tags
          .split(/[,，]/)
          .map((item) => item.trim())
          .filter(Boolean),
        note,
        resolvedFeedbackIds,
      });
      if (result) {
        completeDraft(submitted);
        if (editMetadata.get(key) === submittedMetadata)
          editMetadata.delete(key);
      }
    } finally {
      setPending(false);
    }
  };
  const reuse = async (instruction?: string) => {
    if (pendingActions.has(key)) return;
    setPending(true);
    try {
      let id = target;
      if (id === "new" || !snapshot.tasks.some((task) => task.id === id)) {
        const before = new Set(snapshot.tasks.map((task) => task.id));
        const next = await dispatch({
          type: "task.create",
          goal:
            instruction ??
            `基于「${entry.title}」继续研究与加工。先理解这份已有成果，等待我补充具体方向。`,
          title: `接着用 · ${entry.title}`,
          kind: "research",
        });
        id = next?.tasks.find((task) => !before.has(task.id))?.id ?? "";
      }
      if (id) {
        const result = await dispatch({
          type: "library.reuse",
          entryId: entry.id,
          taskId: id,
        });
        if (result) {
          if (instruction)
            await dispatch({
              type: "task.send",
              taskId: id,
              text: instruction,
            });
          onTask(id);
        }
      }
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="library-document">
      <div className="artifact-heading">
        <div>
          <span className="eyebrow">
            {entry.format.toUpperCase()} · 资产版本 {entry.version}
          </span>
          <h3>{entry.title}</h3>
        </div>
        <button
          className="icon-button"
          aria-label="在访达显示收藏"
          onClick={() =>
            void dispatch({ type: "path.reveal", path: entry.path })
          }
        >
          <FolderOpen size={16} />
        </button>
      </div>
      <p className="library-provenance">
        来自「{entry.source.taskTitle}」· 成果 v{entry.source.artifactVersion} ·{" "}
        {formatDate(entry.savedAt)} 收藏
      </p>
      {!draft.editing && unresolvedLibraryFeedback(entry).length ? (
        <div className="inline-notice warning">
          这项资产有 {unresolvedLibraryFeedback(entry).length}{" "}
          条修正或使用问题待处理，阅读时请结合反馈判断。
          <button
            className="text-button"
            onClick={() =>
              document
                .getElementById(`library-feedback-${entry.id}`)
                ?.scrollIntoView({ block: "start", behavior: "smooth" })
            }
          >
            查看反馈
          </button>
        </div>
      ) : null}
      <div className="artifact-actions">
        {editable ? (
          draft.editing ? (
            <>
              <button
                className="button primary small"
                disabled={pending || changedExternally}
                onClick={() => void save()}
              >
                <Save size={13} />
                {pending ? "保存中" : "保存资产"}
              </button>
              <button
                className="text-button"
                disabled={pending}
                onClick={() =>
                  setDraft((current) => ({ ...current, editing: false }))
                }
              >
                <X size={13} />
                取消
              </button>
            </>
          ) : (
            <button
              className="button secondary small"
              disabled={
                pending ||
                Boolean(entry.readError) ||
                entry.content === undefined
              }
              onClick={() => {
                setTitle(entry.title);
                setTags(entry.tags.join("，"));
                setNote(entry.note);
                setResolvedFeedbackIds([]);
                setDraft({
                  content: entry.content ?? "",
                  baseHash: entry.hash,
                  editing: true,
                });
              }}
            >
              <Pencil size={13} />
              修改收藏
            </button>
          )
        ) : null}
        <button
          className="text-button"
          onClick={() => onTask(entry.source.taskId)}
        >
          回到来源工作
          <ArrowUpRight size={13} />
        </button>
        {!draft.editing && (
          <MediaFromMaterial
            snapshot={snapshot}
            dispatch={dispatch}
            material={libraryMediaMaterial(entry)}
            disabled={pending}
            onMediaCreated={onMediaCreated}
            onMediaSetup={onMediaSetup}
          />
        )}
      </div>
      {entry.readError ? (
        <div className="inline-notice warning">{entry.readError}</div>
      ) : null}
      {changedExternally ? (
        <div className="inline-notice warning">
          收藏已有新版本，你的草稿仍保留。请核对后重新编辑。
        </div>
      ) : null}
      {draft.editing ? (
        <fieldset disabled={pending} className="library-edit-fields">
          <div className="library-edit-meta">
            <label className="field">
              名称
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label className="field">
              标签
              <input
                value={tags}
                onChange={(event) => setTags(event.target.value)}
                placeholder="用逗号分隔"
              />
            </label>
            <label className="field">
              备注
              <input
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="记下它为什么值得留下"
              />
            </label>
          </div>
          <textarea
            className="artifact-editor"
            aria-label="收藏正文编辑"
            value={draft.content}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                content: event.target.value,
              }))
            }
          />
          {unresolvedLibraryFeedback(entry).length ? (
            <div className="library-resolutions">
              <p>这次正文修订处理了哪些反馈？仅勾选已落实的项目。</p>
              {unresolvedLibraryFeedback(entry).map((feedback) => (
                <label key={feedback.id}>
                  <input
                    type="checkbox"
                    checked={resolvedFeedbackIds.includes(feedback.id)}
                    onChange={(event) =>
                      setResolvedFeedbackIds((current) =>
                        event.target.checked
                          ? [...current, feedback.id]
                          : current.filter((id) => id !== feedback.id),
                      )
                    }
                  />
                  {feedback.note}
                </label>
              ))}
            </div>
          ) : null}
        </fieldset>
      ) : (
        <>
          {entry.note ? <p className="library-note">{entry.note}</p> : null}
          {entry.tags.length ? (
            <div className="library-tags">
              {entry.tags.map((tag) => (
                <span key={tag}>{tag}</span>
              ))}
            </div>
          ) : null}
          {entry.format === "md" ? (
            <Markdown dispatch={dispatch}>
              {entry.content ?? "正文暂不可读。"}
            </Markdown>
          ) : entry.format === "html" ? (
            <iframe
              className="html-artifact"
              title={entry.title}
              sandbox=""
              srcDoc={`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">${entry.content ?? ""}`}
            />
          ) : entry.format === "png" && entry.previewURL ? (
            <img
              className="png-artifact"
              src={entry.previewURL}
              alt={entry.title}
            />
          ) : (
            <div className="inline-notice">
              {entry.format.toUpperCase()}{" "}
              已保存在本机。可回到源文档修改，再重新导出。
            </div>
          )}
        </>
      )}
      {!draft.editing ? (
        <LibraryFeedbackPanel
          entry={entry}
          snapshot={snapshot}
          selectedTaskId={selectedTaskId}
          dispatch={dispatch}
          onContinue={() =>
            void reuse(
              `请阅读「${entry.title}」的最新正文和已记录的用途、条件、使用结果及用户修正。按反馈重新判断，说明新增、补充或冲突，为当前用途保存一份可继续编辑的修订说明书。保留真实依据和未验证的部分，不将旧判断继续当成已验证结论。`,
            )
          }
        />
      ) : null}
      {!draft.editing ? (
        <div className="library-reuse">
          <div>
            <strong>把这份积累接着用</strong>
            <p>
              {editable
                ? "会作为资料加入所选工作，再由你提出方向。"
                : "会加入文件引用，图片或演示文稿正文暂未解析。"}
            </p>
          </div>
          <div className="library-reuse-actions">
            <select
              aria-label="复用到哪项工作"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            >
              <option value="new">开启新工作</option>
              {snapshot.tasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
            </select>
            <button
              className="button primary small"
              disabled={pending || Boolean(entry.readError)}
              onClick={() => void reuse()}
            >
              加入工作
              <ArrowRight size={13} />
            </button>
          </div>
        </div>
      ) : null}
      {entry.versions.length ? (
        <details className="library-history">
          <summary>版本记录 · {entry.versions.length}</summary>
          {entry.versions.map((version) => (
            <div key={`${version.version}:${version.hash}`}>
              <span>
                v{version.version} · {version.summary}
              </span>
              <button
                className="icon-button"
                aria-label={`查看收藏版本 ${version.version}`}
                onClick={() =>
                  void dispatch({ type: "path.reveal", path: version.path })
                }
              >
                <ArrowUpRight size={13} />
              </button>
            </div>
          ))}
        </details>
      ) : null}
    </section>
  );
}

export function Library({
  snapshot,
  dispatch,
  onTask,
  onAdd,
  selectedTaskId,
  initialEntryId,
  onMediaCreated,
  onMediaSetup,
}: {
  snapshot: Snapshot | null;
  dispatch: Dispatch;
  onTask: (id: string) => void;
  onAdd: () => void;
  selectedTaskId: string | null;
  initialEntryId?: string | null;
} & MediaMaterialNavigation) {
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"saved" | "sources" | "skills">("saved");
  const [management, setManagement] = useState<
    "imports" | "backup" | "recall" | null
  >(null);
  const [selected, setSelected] = useState<string | null>(
    initialEntryId ?? null,
  );
  const [recallPending, setRecallPending] = useState(false);
  const entries = snapshot?.library ?? [];
  const query = search.toLowerCase();
  const filtered = entries.filter((entry) =>
    `${entry.title} ${entry.note} ${entry.tags.join(" ")} ${entry.content ?? ""}`
      .toLowerCase()
      .includes(query),
  );
  const sources =
    snapshot?.tasks
      .flatMap((task) => task.sources.map((source) => ({ task, source })))
      .filter(({ source }) =>
        `${source.title} ${source.text}`.toLowerCase().includes(query),
      ) ?? [];
  const entry = entries.find((item) => item.id === selected);
  const skillCount = (snapshot?.skills ?? []).filter((skill) =>
    `${skill.name} ${skill.description} ${skill.instructions}`
      .toLowerCase()
      .includes(query),
  ).length;
  return (
    <div className="collection-page library-page asset-library-page">
      <div className="page-heading">
        <div className="heading-with-action">
          <h1>资产</h1>
          <button
            className="button secondary"
            onClick={() =>
              setManagement((current) =>
                current === "imports" ? null : "imports",
              )
            }
            aria-expanded={management === "imports"}
          >
            <Plus size={15} />
            导入资料
          </button>
        </div>
        <p>查找已有积累，接着使用。</p>
      </div>
      <div className="asset-management-bar">
        <button
          className="text-button"
          onClick={() =>
            setManagement((current) => (current === "backup" ? null : "backup"))
          }
          aria-expanded={management === "backup"}
        >
          备份与恢复
        </button>
        <button
          className="text-button"
          onClick={() =>
            setManagement((current) => (current === "recall" ? null : "recall"))
          }
          aria-expanded={management === "recall"}
        >
          自动复用设置
        </button>
      </div>
      {management && snapshot ? (
        <section className="asset-management-surface" aria-label="资产管理">
          <div className="asset-management-heading">
            <h2>
              {management === "imports"
                ? "导入资料"
                : management === "backup"
                  ? "备份与恢复"
                  : "自动复用"}
            </h2>
            <button
              className="icon-button"
              aria-label="关闭资产管理"
              onClick={() => setManagement(null)}
            >
              <X size={16} />
            </button>
          </div>
          {management === "recall" ? (
            <label className="library-recall-toggle">
              <input
                type="checkbox"
                checked={snapshot.settings.libraryRecall !== false}
                disabled={recallPending}
                onChange={async (event) => {
                  const libraryRecall = event.target.checked;
                  setRecallPending(true);
                  try {
                    await dispatch({
                      type: "settings.save",
                      settings: { ...snapshot.settings, libraryRecall },
                    });
                  } finally {
                    setRecallPending(false);
                  }
                }}
              />
              为工作查找资产中的相关资料
              <span>
                只在任务运行时选入少量文字资产，正文由所选模型按需阅读。
              </span>
            </label>
          ) : (
            <>
              {management === "imports" ? (
                <button className="text-button" onClick={onAdd}>
                  添加单份资料到工作
                </button>
              ) : null}
              <PortablePanel
                snapshot={snapshot}
                dispatch={dispatch}
                mode={management}
                onTask={onTask}
                onReveal={(path) =>
                  void dispatch({ type: "path.reveal", path })
                }
              />
            </>
          )}
        </section>
      ) : null}
      {!management ? (
        <>
          <label className="library-search">
            <Search size={16} />
            <input
              aria-label="搜索本地资产"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索知识、说明书或方法"
            />
            <span>
              {tab === "saved"
                ? filtered.length
                : tab === "skills"
                  ? skillCount
                  : sources.length}{" "}
              项
            </span>
          </label>
          <div className="library-tabbar panel-tabs">
            <button
              className={tab === "saved" ? "active" : ""}
              onClick={() => setTab("saved")}
            >
              知识与说明书 <span>{entries.length}</span>
            </button>
            <button
              className={tab === "sources" ? "active" : ""}
              onClick={() => setTab("sources")}
            >
              工作资料
            </button>
            <button
              className={tab === "skills" ? "active" : ""}
              onClick={() => setTab("skills")}
            >
              Skills <span>{snapshot?.skills?.length ?? 0}</span>
            </button>
          </div>
          {tab === "skills" ? (
            snapshot ? (
              <SkillCatalog
                snapshot={snapshot}
                dispatch={dispatch}
                query={query}
                onTask={onTask}
              />
            ) : null
          ) : tab === "saved" ? (
            <>
              {entry && snapshot ? (
                <>
                  <button
                    className="text-button library-back"
                    onClick={() => setSelected(null)}
                  >
                    ← 返回收藏
                  </button>
                  <LibraryDocument
                    key={`lib:${entry.id}`}
                    entry={entry}
                    snapshot={snapshot}
                    dispatch={dispatch}
                    onTask={onTask}
                    selectedTaskId={selectedTaskId}
                    onMediaCreated={onMediaCreated}
                    onMediaSetup={onMediaSetup}
                  />
                </>
              ) : filtered.length ? (
                <div className="saved-library-list asset-library-rows">
                  {filtered.map((item) => (
                    <button
                      className="saved-library-card"
                      key={item.id}
                      onClick={() => setSelected(item.id)}
                    >
                      <div>
                        <span className="library-format">
                          {item.format.toUpperCase()}
                        </span>
                        <span>
                          v{item.version} ·{" "}
                          {LIBRARY_ASSESSMENT_LABELS[libraryAssessment(item)]}
                        </span>
                        <ArrowUpRight size={15} />
                      </div>
                      <h3>{item.title}</h3>
                      <p>
                        {item.note ||
                          (item.format === "md"
                            ? item.content?.replace(/[#*`]/g, "").slice(0, 110)
                            : "") ||
                          `来自「${item.source.taskTitle}」`}
                      </p>
                      <footer>
                        <span>{formatDate(item.updatedAt)}</span>
                        <span>
                          {item.tags.slice(0, 2).join(" · ") || "已保存在本机"}
                        </span>
                      </footer>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="collection-empty">
                  <BookOpen size={37} strokeWidth={1.2} />
                  <h2>
                    {query ? "没有找到这份资产" : "留下可以再次使用的成果"}
                  </h2>
                  <p>
                    {query
                      ? "换个名称或关键词试试。"
                      : "在成果旁选择「收藏为资产」，之后可以在这里查找、修订和复用。"}
                  </p>
                </div>
              )}
            </>
          ) : (
            <div className="library-list">
              {sources.length ? (
                sources.map(({ task, source }) => (
                  <article
                    className="library-row"
                    key={`${task.id}:${source.id}`}
                  >
                    <div className="library-row-heading">
                      <FileText size={18} />
                      <h3>{source.title}</h3>
                      <time>{formatDate(source.addedAt)}</time>
                    </div>
                    <p>{source.text.slice(0, 160)}</p>
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
                <div className="collection-empty">
                  <FileText size={30} />
                  <h2>为工作加入一些背景</h2>
                  <p>已导入的文章、笔记与文档会集中在这里。</p>
                </div>
              )}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
