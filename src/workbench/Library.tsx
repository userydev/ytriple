import { useState } from "react";
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

function LibraryDocument({
  entry,
  snapshot,
  dispatch,
  onTask,
  selectedTaskId,
}: {
  entry: LibraryEntry;
  snapshot: Snapshot;
  dispatch: Dispatch;
  onTask: (id: string) => void;
  selectedTaskId: string | null;
}) {
  const { draft, setDraft, changedExternally } = useDocumentDraft(
    `library:${entry.id}`,
    entry.content ?? "",
    entry.hash,
  );
  const [title, setTitle] = useState(entry.title);
  const [tags, setTags] = useState(entry.tags.join("，"));
  const [note, setNote] = useState(entry.note);
  const [pending, setPending] = useState(false);
  const [target, setTarget] = useState(selectedTaskId ?? "new");
  const editable = entry.format === "md" || entry.format === "html";
  const save = async () => {
    setPending(true);
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
    });
    setPending(false);
    if (result) setDraft((current) => ({ ...current, editing: false }));
  };
  const reuse = async () => {
    setPending(true);
    let id = target;
    if (id === "new" || !snapshot.tasks.some((task) => task.id === id)) {
      const before = new Set(snapshot.tasks.map((task) => task.id));
      const next = await dispatch({
        type: "task.create",
        goal: `基于「${entry.title}」继续研究与加工。先理解这份已有成果，等待我补充具体方向。`,
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
      if (result) onTask(id);
    }
    setPending(false);
  };
  return (
    <section className="library-document">
      <div className="artifact-heading">
        <div>
          <span className="eyebrow">
            {entry.format.toUpperCase()} · Lib 版本 {entry.version}
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
                {pending ? "保存中" : "保存到 Lib"}
              </button>
              <button
                className="text-button"
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
              disabled={Boolean(entry.readError) || entry.content === undefined}
              onClick={() => {
                setTitle(entry.title);
                setTags(entry.tags.join("，"));
                setNote(entry.note);
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
        <>
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
        </>
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
}: {
  snapshot: Snapshot | null;
  dispatch: Dispatch;
  onTask: (id: string) => void;
  onAdd: () => void;
  selectedTaskId: string | null;
}) {
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"saved" | "sources">("saved");
  const [selected, setSelected] = useState<string | null>(null);
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
  return (
    <div className="collection-page library-page">
      <div className="page-heading">
        <span className="eyebrow">LOCAL LIBRARY</span>
        <div className="heading-with-action">
          <h1>积累，可以接着用</h1>
          <button className="button secondary" onClick={onAdd}>
            <Plus size={15} />
            添加资料
          </button>
        </div>
        <p>留下有用的成果，简单修改，再带入下一项工作。</p>
      </div>
      <div className="library-tabbar panel-tabs">
        <button
          className={tab === "saved" ? "active" : ""}
          onClick={() => setTab("saved")}
        >
          我的收藏 <span>{entries.length}</span>
        </button>
        <button
          className={tab === "sources" ? "active" : ""}
          onClick={() => setTab("sources")}
        >
          工作资料
        </button>
      </div>
      <label className="library-search">
        <Search size={16} />
        <input
          aria-label="搜索本地 Lib"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索名称、标签或正文"
        />
        <span>{tab === "saved" ? filtered.length : sources.length} 项</span>
      </label>
      {tab === "saved" ? (
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
              />
            </>
          ) : filtered.length ? (
            <div className="saved-library-list">
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
                    <span>v{item.version}</span>
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
                {query ? "没有找到这份收藏" : "把值得留下的成果，放进 Lib"}
              </h2>
              <p>
                {query
                  ? "换个名称或关键词试试。"
                  : "在成果面板点击「收藏到 Lib」，就能在这里修改、归档和复用。"}
              </p>
            </div>
          )}
        </>
      ) : (
        <div className="library-list">
          {sources.length ? (
            sources.map(({ task, source }) => (
              <article className="library-row" key={`${task.id}:${source.id}`}>
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
    </div>
  );
}
