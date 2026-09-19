import { useState } from "react";
import {
  ArrowUpRight,
  BookOpen,
  RefreshCw,
  Search,
  FileText,
  X,
} from "lucide-react";
import type {
  Snapshot,
  Project,
  Material,
  Reference,
  Draft,
} from "../core/types";
import { command } from "./api";
import { Dialog } from "./Dialog";
import { IconButton } from "./Composer";
const kinds = {
  source: "源码",
  configuration: "配置",
  test: "测试",
  documentation: "文档",
  other: "其他",
};
const states = {
  unread: "未读取",
  captured: "快照与文件一致",
  changed: "文件已变化",
  missing: "文件已移走",
  excluded: "未纳入读取",
  unavailable: "无法读取",
  unchecked: "变化待核对",
};
export function ProjectFilesPanel({
  data,
  project,
  onDraft,
  onWork,
  onError,
}: {
  data: Snapshot;
  project: Project;
  onDraft: (draft: Draft) => Promise<void>;
  onWork: (id: string, versionId?: string) => void;
  onError: (e: unknown) => void;
}) {
  const inspection = data.projectInspections.find(
    (i) => i.projectId === project.id && i.root === project.directory,
  );
  const [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    [page, setPage] = useState(0),
    [preview, setPreview] = useState<Reference | null>(null),
    [notice, setNotice] = useState("");
  async function act(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setNotice("");
    try {
      await fn();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  const entries = inspection?.entries ?? [],
    shown = entries.filter(
      (e) =>
        (filter === "all" || e.kind === filter) &&
        e.path.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
    );
  const current = shown.slice(page * 40, (page + 1) * 40),
    refs = entries
      .filter(
        (e) =>
          selected.includes(e.path) && e.reference && e.state === "captured",
      )
      .map((e) => e.reference!);
  const local = data.materials.filter(
    (m) =>
      m.projectSource?.projectId === project.id &&
      m.projectSource.root === project.directory,
  );
  const runs = data.runs.filter(
    (r) =>
      r.projectContext?.projectId === project.id &&
      r.refs.some((ref) =>
        local.some((m) => m.id === ref.materialId && m.version === ref.version),
      ),
  );
  const completed = runs.filter((r) => r.status === "succeeded"),
    report = data.versions
      .filter((v) => v.runId && completed.some((r) => r.id === v.runId))
      .at(-1);
  const reportRun = report
    ? runs.find((r) => r.id === report.runId)
    : undefined;
  const reportNeedsReview = reportRun?.refs.some((ref) => {
    const source = local.find(
      (m) => m.id === ref.materialId && m.version === ref.version,
    )?.projectSource;
    if (!source) return false;
    const entry = entries.find((e) => e.path === source.path);
    return (
      !entry ||
      ["changed", "missing", "unavailable", "unchecked"].includes(
        entry.state,
      ) ||
      entry.sha256 !== source.sha256
    );
  });
  const snapshot = preview
    ? data.materials.find(
        (m) => m.id === preview.materialId && m.version === preview.version,
      )
    : undefined;
  return (
    <section className="project-files">
      <div className="section-heading">
        <div>
          <h2>项目内容</h2>
          <p className="muted">
            {inspection
              ? `${entries.filter((e) => e.reference).length} 份本地快照 · ${entries.filter((e) => e.state === "unread").length} 份未读 · ${entries.filter((e) => ["changed", "missing", "unchecked"].includes(e.state)).length} 份需核对`
              : "先检查目录，再选择本轮要理解的文件。"}
          </p>
        </div>
        <IconButton
          label={inspection ? "检查项目文件变化" : "检查项目文件目录"}
          disabled={busy || !project.directory}
          onClick={() =>
            void act(async () => {
              await command({
                type: "inspect-project-files",
                projectId: project.id,
              });
              setPage(0);
            })
          }
        >
          <RefreshCw size={17} />
        </IconButton>
      </div>
      {report ? (
        <button
          className="quiet"
          onClick={() => onWork(report.workId, report.id)}
        >
          <FileText size={16} />
          查看已有理解 · v{report.number}
          {reportNeedsReview ? " · 依据需复核" : ""}
        </button>
      ) : null}
      {inspection ? (
        <>
          <p className="muted">
            检查于 {new Date(inspection.inspectedAt).toLocaleString()} ·
            文件快照不等于已被 AI 阅读，也不证明测试已通过。
          </p>
          {inspection.notes.map((n, i) => (
            <p className="muted" key={i}>
              {n}
            </p>
          ))}
          <div className="project-file-controls">
            <label className="asset-search">
              <Search size={15} />
              <input
                aria-label="查找项目文件"
                placeholder="查找文件"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(0);
                }}
              />
            </label>
            <select
              aria-label="项目文件类别"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setPage(0);
              }}
            >
              <option value="all">所有类别</option>
              {Object.entries(kinds).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="section-heading">
            <small>已选 {selected.length} 项</small>
            {selected.length ? (
              <IconButton
                label="清除文件选择"
                disabled={busy}
                onClick={() => setSelected([])}
              >
                <X size={15} />
              </IconButton>
            ) : null}
            <div className="toolbar">
              <IconButton
                label="读取所选文件到本地"
                disabled={busy || !selected.length || selected.length > 20}
                onClick={() =>
                  void act(async () => {
                    const result = await command<Material[]>({
                      type: "read-project-files",
                      projectId: project.id,
                      paths: selected,
                    });
                    setNotice(
                      `已保存 ${result.length} 份本地文件快照，尚未发送。`,
                    );
                  })
                }
              >
                <BookOpen size={17} />
              </IconButton>
              <IconButton
                label="把所选文件交给团队理解"
                disabled={
                  busy || refs.length !== selected.length || !refs.length
                }
                onClick={() =>
                  void act(async () => {
                    const d = await command<Draft>({
                      type: "prepare-project-reading",
                      projectId: project.id,
                      refs,
                    });
                    await onDraft(d);
                  })
                }
              >
                <ArrowUpRight size={18} />
              </IconButton>
            </div>
          </div>
          {notice ? (
            <p role="status" className="muted">
              {notice}
            </p>
          ) : null}
          <div className="project-file-list">
            {current.map((e) => {
              const selectedRuns = completed.filter(
                (r) =>
                  e.reference &&
                  r.refs.some(
                    (ref) =>
                      ref.materialId === e.reference!.materialId &&
                      ref.version === e.reference!.version,
                  ),
              );
              return (
                <div className="project-file-row" key={e.path}>
                  <input
                    type="checkbox"
                    aria-label={`选择文件 ${e.path}`}
                    disabled={
                      busy ||
                      ["excluded", "missing", "unavailable"].includes(e.state)
                    }
                    checked={selected.includes(e.path)}
                    onChange={(event) =>
                      setSelected((old) =>
                        event.target.checked
                          ? [...old, e.path]
                          : old.filter((p) => p !== e.path),
                      )
                    }
                  />
                  <div>
                    <span className="local-path">{e.path}</span>
                    <p className="muted">
                      {kinds[e.kind]} · {states[e.state]}
                      {e.reference ? ` · 快照 v${e.reference.version}` : ""}
                      {selectedRuns.length
                        ? ` · ${selectedRuns.length} 次成功运行引用此版本（范围可查看）`
                        : ""}
                      {e.reason ? ` · ${e.reason}` : ""}
                    </p>
                  </div>
                  {e.reference ? (
                    <IconButton
                      label={`预览 ${e.path} 的保存版本`}
                      onClick={() => setPreview(e.reference!)}
                    >
                      <FileText size={16} />
                    </IconButton>
                  ) : null}
                </div>
              );
            })}
          </div>
          {shown.length > 40 ? (
            <div className="section-heading">
              <button
                className="quiet"
                disabled={page === 0}
                onClick={() => setPage((n) => n - 1)}
              >
                上一页
              </button>
              <small>
                {page + 1} / {Math.ceil(shown.length / 40)} 页
              </small>
              <button
                className="quiet"
                disabled={(page + 1) * 40 >= shown.length}
                onClick={() => setPage((n) => n + 1)}
              >
                下一页
              </button>
            </div>
          ) : null}
          <p className="muted">
            每批最多 20
            个文件。生成目录、秘密文件、符号链接与不支持的格式会列出限制；大文件暂不读取。发送前可以在输入区缩小引用范围。
          </p>
        </>
      ) : null}
      {preview ? (
        <Dialog
          title={`${preview.label} · v${preview.version}`}
          onClose={() => setPreview(null)}
        >
          <p className="muted">
            {snapshot?.projectSource?.root} · 快照保存于{" "}
            {snapshot?.createdAt
              ? new Date(snapshot.createdAt).toLocaleString()
              : "未知"}
          </p>
          <pre className="reference-preview">
            {snapshot?.body ?? "快照不可用"}
          </pre>
          <details>
            <summary>哪些运行引用了这个版本</summary>
            {runs
              .filter((r) =>
                r.refs.some(
                  (ref) =>
                    ref.materialId === preview.materialId &&
                    ref.version === preview.version,
                ),
              )
              .map((r) => (
                <div key={r.id}>
                  <button
                    className="quiet"
                    onClick={() => {
                      setPreview(null);
                      onWork(r.workId);
                    }}
                  >
                    {r.text.slice(0, 60)} ·{" "}
                    {r.status === "succeeded" ? "已完成" : r.status}
                  </button>
                  {r.refs
                    .filter(
                      (ref) =>
                        ref.materialId === preview.materialId &&
                        ref.version === preview.version,
                    )
                    .map((ref, i) => (
                      <pre className="reference-preview" key={i}>
                        {ref.excerpt
                          ? `仅引用选段：\n${ref.excerpt}`
                          : "本轮引用了完整保存快照"}
                      </pre>
                    ))}
                </div>
              ))}
          </details>
        </Dialog>
      ) : null}
    </section>
  );
}
