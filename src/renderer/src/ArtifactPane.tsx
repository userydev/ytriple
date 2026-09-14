import { useLayoutEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  FileText,
  History,
  LoaderCircle,
  Pencil,
  Quote,
  Save,
  X,
} from "lucide-react";
import type {
  Artifact,
  PublicEvent,
  Reference,
  ViewState,
  WorkDetail,
} from "../../shared/contracts";
import { dateText, Empty, Markdown } from "./common";
import { ScrollArea } from "./ScrollArea";
import "./ArtifactPane.css";
interface EditorDraft {
  schema: 1;
  content: string;
  baseVersion: number;
}
const kindLabel = {
  deliverable: "成果",
  summary: "过程总结",
  reflection: "工作复盘",
};
const evidenceTypes = new Set([
  "plan",
  "delegation",
  "analysis",
  "review",
  "revision",
]);
function evidenceKind(type: PublicEvent["type"]) {
  return type === "analysis"
    ? "分析"
    : type === "review"
      ? "核查"
      : type === "revision"
        ? "意见处理"
        : type === "delegation"
          ? "委派"
          : "规划";
}
function VersionEvidence({
  version,
  detail,
}: {
  version: NonNullable<Artifact["versions"][number]>;
  detail: WorkDetail;
}) {
  const run = version.runId
    ? detail.runs.find((item) => item.id === version.runId)
    : undefined;
  const runEvents = run
    ? detail.events.filter(
        (event) => event.runId === run.id && evidenceTypes.has(event.type),
      )
    : [];
  const eventIds = new Set<string>();
  const queue = [...runEvents];
  if (run?.reference?.kind === "event")
    queue.push(
      ...detail.events.filter((event) => event.id === run.reference?.id),
    );
  while (queue.length) {
    const event = queue.shift()!;
    if (eventIds.has(event.id)) continue;
    eventIds.add(event.id);
    for (const relatedId of event.relatedEventIds ?? []) {
      const related = detail.events.find(
        (candidate) => candidate.id === relatedId,
      );
      if (related && evidenceTypes.has(related.type)) queue.push(related);
    }
  }
  const events = [
    ...runEvents,
    ...[...eventIds]
      .map((id) => detail.events.find((event) => event.id === id))
      .filter(
        (event): event is PublicEvent => !!event && event.runId !== run?.id,
      ),
  ];
  return (
    <details className="artifact-evidence">
      <summary>查看本版依据</summary>
      {run ? (
        <div className="artifact-evidence-content">
          <p>
            <strong>
              第 {detail.runs.indexOf(run) + 1} 轮 · {run.strategyVersion}
            </strong>{" "}
            · 目标版本 v{run.goalRevision} · {dateText(run.createdAt)}
          </p>
          <p>本轮输入：{run.prompt}</p>
          <p>
            成员快照：
            {run.settings.team.members
              .map(
                (member) => `${member.name}（${member.role || "未设置职责"}）`,
              )
              .join("、")}
          </p>
          {run.materials.length ? (
            <div>
              <strong>输入材料</strong>
              <ul>
                {run.materials.map((material) => (
                  <li key={material.id}>
                    <details>
                      <summary>{material.title}</summary>
                      <Markdown>{material.content}</Markdown>
                    </details>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p>本轮没有输入材料。</p>
          )}
          {events.length ? (
            <div>
              <strong>实际过程记录</strong>
              <ul>
                {events.map((event) => (
                  <li key={event.id}>
                    <span className="evidence-kind">
                      {evidenceKind(event.type)}
                    </span>
                    <span className="evidence-origin">
                      {event.runId === run.id
                        ? "本轮"
                        : `第 ${detail.runs.findIndex((item) => item.id === event.runId) + 1} 轮`}
                    </span>
                    <span className="evidence-member">
                      {detail.runs
                        .find((item) => item.id === event.runId)
                        ?.settings.team.members.find(
                          (member) => member.id === event.memberId,
                        )?.name ?? "团队"}
                    </span>
                    <span>{event.title}</span>
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => {
                        const target = document.getElementById(
                          `artifact-evidence-${event.id}`,
                        );
                        if (target instanceof HTMLDetailsElement)
                          target.open = true;
                        target?.scrollIntoView({ block: "nearest" });
                      }}
                    >
                      {event.body ? "展开正文" : "无正文"}
                    </button>
                    <details id={`artifact-evidence-${event.id}`}>
                      <summary>原始公开正文</summary>
                      <Markdown>{event.body}</Markdown>
                    </details>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p>本轮没有可关联的公开过程记录。</p>
          )}
          <p className="evidence-note">
            依据关联到运行与公开记录；没有结构化到段落的引用时，不宣称逐句溯源。
          </p>
        </div>
      ) : (
        <div className="artifact-evidence-content">
          <p>
            <strong>手工编辑版本</strong> · 基于 v{version.baseVersion}
          </p>
          <p>
            此版本由本机编辑保存，没有对应的团队运行记录，因此不表示本版经过团队核查。
          </p>
        </div>
      )}
    </details>
  );
}
export function ArtifactPane({
  detail,
  view,
  namespace,
  onView,
  onReference,
  onError,
  onSaved,
}: {
  detail: WorkDetail;
  view: ViewState;
  namespace: string;
  onView(value: Partial<ViewState>): void;
  onReference(
    reference: Reference,
    memberId: undefined,
    intent: "revise",
  ): void;
  onError(error: unknown): void;
  onSaved(artifact: Artifact): Promise<void>;
}) {
  const artifact =
    detail.artifacts.find((item) => item.id === view.artifactId) ??
    (!view.artifactId ? detail.artifacts[0] : undefined);
  const version = artifact?.versions.find(
    (item) =>
      item.version ===
      (view.artifactVersion ??
        (artifact.currentVersion || artifact.versions.at(-1)?.version)),
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<EditorDraft>();
  const [saving, setSaving] = useState(false);
  const [selection, setSelection] = useState("");
  const [selectionHint, setSelectionHint] = useState("");
  const contentRef = useRef<HTMLDivElement>(null);
  const identity = `${artifact?.id ?? "none"}:${version?.version ?? 0}`;
  const storageKey = `ytriple:artifact-editor:v1:${namespace}:${detail.work.id}:${identity}`;
  useLayoutEffect(() => {
    setSelection("");
    setSelectionHint("");
    setEditing(false);
    setDraft(undefined);
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const saved = JSON.parse(raw) as EditorDraft;
        if (
          saved.schema === 1 &&
          typeof saved.content === "string" &&
          saved.baseVersion === version?.version
        ) {
          setDraft(saved);
          setEditing(true);
        }
      }
    } catch (e) {
      onError(e);
    }
  }, [identity, storageKey]);
  function persist(value: EditorDraft) {
    setDraft(value);
    try {
      localStorage.setItem(storageKey, JSON.stringify(value));
    } catch (e) {
      onError(e);
    }
  }
  async function save() {
    if (!artifact || !draft) return;
    setSaving(true);
    try {
      const updated = await window.ytriple.saveArtifact({
        workId: detail.work.id,
        artifactId: artifact.id,
        baseVersion: draft.baseVersion,
        content: draft.content,
      });
      localStorage.removeItem(storageKey);
      setDraft(undefined);
      setEditing(false);
      await onSaved(updated);
      const savedVersion = updated.versions.at(-1);
      onView({
        artifactId: updated.id,
        artifactVersion: savedVersion?.version ?? updated.currentVersion,
      });
    } catch (e) {
      onError(e);
    } finally {
      setSaving(false);
    }
  }
  function startEditing() {
    if (!version) return;
    if (!draft)
      persist({
        schema: 1,
        content: version.content,
        baseVersion: version.version,
      });
    setEditing(true);
  }
  if (!artifact || !version)
    return (
      <Empty icon={<FileText size={30} />} title="还没有成果">
        完成一次协作后，这里会显示主成果；过程总结和复盘单独保留。
      </Empty>
    );
  const latestVersion = Math.max(
    ...artifact.versions.map((item) => item.version),
  );
  const scrollKey = `result:${identity}`;
  return (
    <>
      <div className="artifact-toolbar">
        <label className="artifact-picker">
          <span className="sr-only">选择成果</span>
          <select
            aria-label="选择成果"
            value={artifact.id}
            onChange={(e) => {
              const selected = detail.artifacts.find(
                (item) => item.id === e.target.value,
              )!;
              onView({
                artifactId: selected.id,
                artifactVersion:
                  selected.currentVersion || selected.versions.at(-1)?.version,
              });
            }}
            disabled={saving}
          >
            {(["deliverable", "summary", "reflection"] as const).map((kind) => {
              const items = detail.artifacts.filter(
                (item) => item.kind === kind,
              );
              return items.length ? (
                <optgroup
                  label={kind === "deliverable" ? "主成果" : kindLabel[kind]}
                  key={kind}
                >
                  {items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title}
                    </option>
                  ))}
                </optgroup>
              ) : null;
            })}
          </select>
        </label>
        <label>
          <span className="sr-only">成果版本</span>
          <select
            aria-label="成果版本"
            disabled={saving}
            value={version.version}
            onChange={(e) =>
              onView({
                artifactId: artifact.id,
                artifactVersion: Number(e.target.value),
              })
            }
          >
            {[...artifact.versions].reverse().map((item) => (
              <option key={item.version} value={item.version}>
                v{item.version} ·{" "}
                {item.status === "current"
                  ? "当前"
                  : item.status === "proposal"
                    ? "待合并草案"
                    : "历史"}
              </option>
            ))}
          </select>
        </label>
      </div>
      {latestVersion > version.version ? (
        <button
          className="version-notice"
          disabled={saving}
          onClick={() =>
            onView({ artifactId: artifact.id, artifactVersion: latestVersion })
          }
        >
          <History size={14} />
          另有 v{latestVersion} 可查看；当前阅读位置与编辑草稿已保留
          <ArrowUpRight size={13} />
        </button>
      ) : null}
      {version.status === "proposal" ? (
        <div className="inline-warning">
          这个版本是冲突草案，未覆盖当前成果。请对照当前版本处理差异。
        </div>
      ) : version.status === "history" ? (
        <div className="inline-note small">
          正在阅读历史版本。团队后续成果不会替换这里的正文。
        </div>
      ) : null}
      <div className="artifact-meta">
        <span className="badge">
          {artifact.kind === "deliverable"
            ? "主成果"
            : kindLabel[artifact.kind]}
        </span>
        <span>v{version.version}</span>
        <time>{dateText(version.createdAt)}</time>
        <span>{version.runId ? "来自团队运行" : "手工编辑"}</span>
      </div>
      <VersionEvidence version={version} detail={detail} />
      <div className="editor-actions">
        <button
          className={`text-button ${editing ? "selected-text" : ""}`}
          onClick={() => (editing ? setEditing(false) : startEditing())}
          disabled={saving}
        >
          {editing ? <FileText size={14} /> : <Pencil size={14} />}{" "}
          {editing ? "阅读预览" : draft ? "继续编辑草稿" : "编辑正文"}
        </button>
        {draft ? (
          <>
            <span className="draft-label">
              <Check size={12} />
              本机草稿已保留 · 基于 v{draft.baseVersion}
            </span>
            <button
              className="text-button"
              disabled={saving || draft.content === version.content}
              onClick={() => void save()}
            >
              {saving ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <Save size={14} />
              )}
              保存新版本
            </button>
          </>
        ) : null}
      </div>
      {editing && draft ? (
        <div className="artifact-editor">
          <label className="sr-only" htmlFor="artifact-content">
            编辑成果正文
          </label>
          <textarea
            id="artifact-content"
            value={draft.content}
            onChange={(e) => persist({ ...draft, content: e.target.value })}
            spellCheck={false}
          />
          <p>编辑草稿按工作与基线版本保留。保存时检查版本冲突。</p>
        </div>
      ) : (
        <ScrollArea
          identity={scrollKey}
          initial={view.scroll[scrollKey] ?? 0}
          changeToken={identity}
          onPosition={(top) =>
            onView({ scroll: { ...view.scroll, [scrollKey]: top } })
          }
        >
          <div
            ref={contentRef}
            className="artifact-body"
            onMouseUp={() => {
              const selected = window.getSelection();
              if (
                !draft &&
                selected?.anchorNode &&
                selected.focusNode &&
                contentRef.current?.contains(selected.anchorNode) &&
                contentRef.current.contains(selected.focusNode)
              ) {
                const quote = selected.toString().trim();
                if (quote && !version.content.includes(quote)) {
                  setSelection("");
                  setSelectionHint(
                    "这段选择跨越了正文格式。请选择一段连续原文，或使用编辑正文。",
                  );
                } else {
                  setSelection(quote);
                  setSelectionHint("");
                }
              }
            }}
          >
            <h1>{artifact.title}</h1>
            <Markdown>{draft?.content ?? version.content}</Markdown>
          </div>
        </ScrollArea>
      )}
      <div className="artifact-footer">
        {draft ? (
          <span>当前预览包含未保存的草稿。保存新版本后可引用准确段落。</span>
        ) : selection ? (
          <>
            <p className="selection-quote">
              “{selection.slice(0, 150)}
              {selection.length > 150 ? "…" : ""}”
            </p>
            <button
              className="primary-button"
              onClick={() =>
                onReference(
                  {
                    kind: "artifact",
                    id: artifact.id,
                    version: version.version,
                    quote: selection,
                  },
                  undefined,
                  "revise",
                )
              }
            >
              <Quote size={14} />
              引用选段修订
            </button>
            <button
              className="icon-button"
              aria-label="取消选段"
              onClick={() => setSelection("")}
            >
              <X size={14} />
            </button>
          </>
        ) : (
          <>
            <span>
              <Quote size={14} />
              {selectionHint || "选择正文段落，把问题交给团队"}
            </span>
            <button
              className="text-button"
              onClick={() =>
                onReference(
                  {
                    kind: "artifact",
                    id: artifact.id,
                    version: version.version,
                  },
                  undefined,
                  "revise",
                )
              }
            >
              修订这个版本
              <ArrowUpRight size={14} />
            </button>
          </>
        )}
      </div>
    </>
  );
}
