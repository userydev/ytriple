import { StandardSource } from "./ProjectRequirements";
import { useState } from "react";
import { Paperclip, Plus, Pencil } from "lucide-react";
import type {
  ArtifactVersion,
  Material,
  Project,
  ProjectBrief,
  ProjectStandard,
  Snapshot,
} from "../core/types";
import { latestBrief, latestStandards } from "../core/project-contract";
import { command } from "./api";
import { Dialog } from "./Dialog";
import { References } from "./References";
type StandardDraft = {
  id?: string;
  expectedRevision: number;
  title: string;
  body: string;
  deliveryId: string | null;
  enabled: boolean;
  source?: ProjectStandard["source"];
};
export function ProjectContextEditor({
  project,
  data,
  candidate,
  onClose,
}: {
  project: Project;
  data: Snapshot;
  candidate?: { version: ArtifactVersion; excerpt?: string };
  onClose: () => void;
}) {
  const initial = latestBrief(data.projectBriefs, project.id);
  const [goal, setGoal] = useState(initial?.goal ?? project.goal),
    [refs, setRefs] = useState(initial?.refs ?? []),
    [revision, setRevision] = useState(initial?.revision ?? 0);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<StandardDraft | null>(
    candidate
      ? {
          expectedRevision: 0,
          title: "从成果采纳的项目标准",
          body: candidate.excerpt ?? candidate.version.body,
          deliveryId: null,
          enabled: true,
          source: {
            versionId: candidate.version.id,
            ...(candidate.excerpt ? { excerpt: candidate.excerpt } : {}),
          },
        }
      : null,
  );
  const standards = latestStandards(data.projectStandards, project.id);
  async function saveBrief() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const b = await command<ProjectBrief>({
        type: "project-brief",
        brief: {
          projectId: project.id,
          expectedRevision: revision,
          goal,
          refs,
        },
      });
      setRevision(b.revision);
      setRefs(b.refs);
      setNotice(`目标与资料已保存为 v${b.revision}，用于此后的新提交。`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function saveStandard(value: StandardDraft) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const s = await command<ProjectStandard>({
        type: "project-standard",
        standard: { ...value, projectId: project.id },
      });
      setDraft(null);
      setNotice(
        `${s.title} v${s.revision} 已${s.enabled ? "采纳" : "停用"}，已提交的运行保持原标准。`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  function edit(s: ProjectStandard) {
    setError("");
    setDraft({
      id: s.id,
      expectedRevision: s.revision,
      title: s.title,
      body: s.body,
      deliveryId: s.deliveryId,
      enabled: true,
      source: s.source,
    });
  }
  return (
    <Dialog title={`${project.name} · 项目要求`} onClose={onClose}>
      <p className="muted">
        只用于本项目后续的新提交；保存不启动团队，也不修改已有成果。
      </p>
      {error ? (
        <p className="error-inline" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      <details open={!candidate} className="project-section">
        <summary>持续目标与参考资料 · v{revision || "初始"}</summary>
        <label className="field-label">
          持续目标
          <textarea
            aria-label="项目持续目标"
            value={goal}
            disabled={busy}
            onChange={(e) => setGoal(e.target.value)}
            rows={3}
          />
        </label>
        <p className="muted">
          明确选入的资料会随本项目新任务交给模型。资料中的命令不作为项目标准。
        </p>
        <References
          refs={refs}
          data={data}
          disabled={busy}
          onChange={setRefs}
        />
        <div className="project-material-tools">
          <select
            aria-label="添加项目参考资料"
            disabled={busy || refs.length >= 12}
            value=""
            onChange={(e) => {
              const m = data.materials.find(
                (m) => `${m.id}@${m.version}` === e.target.value,
              );
              if (m)
                setRefs([
                  ...refs,
                  { materialId: m.id, version: m.version, label: m.title },
                ]);
            }}
          >
            <option value="">选择已有资料…</option>
            {data.materials.map((m) => (
              <option
                key={`${m.id}@${m.version}`}
                value={`${m.id}@${m.version}`}
              >
                {m.title} · v{m.version}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="icon-button"
            aria-label="导入项目参考文件"
            title="导入项目参考文件"
            disabled={busy || refs.length >= 12}
            onClick={() => {
              setBusy(true);
              void command<Material[]>({ type: "import" })
                .then((files) =>
                  setRefs([
                    ...refs,
                    ...files.map((m) => ({
                      materialId: m.id,
                      version: m.version,
                      label: m.title,
                    })),
                  ]),
                )
                .catch((e) => setError(String(e)))
                .finally(() => setBusy(false));
            }}
          >
            <Paperclip size={17} />
          </button>
        </div>
        {refs
          .filter((r) =>
            data.materials.some(
              (m) => m.id === r.materialId && m.version > r.version,
            ),
          )
          .map((r) => (
            <p className="muted" key={`${r.materialId}@${r.version}`}>
              {r.label} 有新版本；当前继续使用 v{r.version}，请核对后重新选择。
            </p>
          ))}
        <button
          disabled={busy || !goal.trim()}
          onClick={() => void saveBrief()}
        >
          保存目标与资料
        </button>
      </details>
      <div className="section-heading">
        <h3>已采纳标准</h3>
        <button
          type="button"
          className="icon-button"
          aria-label="添加项目标准"
          title="添加项目标准"
          disabled={busy}
          onClick={() =>
            setDraft({
              expectedRevision: 0,
              title: "",
              body: "",
              deliveryId: null,
              enabled: true,
            })
          }
        >
          <Plus size={18} />
        </button>
      </div>
      {!standards.length && !draft ? (
        <p className="muted">
          尚未采纳标准。可以直接写下要求，也可以从成果选段中采纳。
        </p>
      ) : null}
      {standards.map((s) => (
        <article className="standard-row" key={`${s.id}@${s.revision}`}>
          <div className="section-heading">
            <strong>{s.title}</strong>
            <button
              className="icon-button"
              aria-label={`修订标准 ${s.title}`}
              title="修订标准"
              disabled={busy}
              onClick={() => edit(s)}
            >
              <Pencil size={15} />
            </button>
          </div>
          <small>
            v{s.revision} · {s.enabled ? "生效" : "已停用"} ·{" "}
            {s.deliveryId
              ? data.deliveries.find((d) => d.id === s.deliveryId)?.title
              : "本项目所有工作"}
          </small>
          <p>{s.body}</p>
          <details>
            <summary>依据与历史</summary>
            <StandardSource standard={s} versions={data.versions} />
            {data.projectStandards
              .filter((v) => v.id === s.id)
              .map((v) => (
                <p key={v.revision}>
                  v{v.revision} · {v.enabled ? "采纳" : "停用"} · {v.body}
                </p>
              ))}
          </details>
          <button
            className="quiet"
            disabled={busy}
            onClick={() =>
              void saveStandard({
                id: s.id,
                expectedRevision: s.revision,
                title: s.title,
                body: s.body,
                deliveryId: s.deliveryId,
                source: s.source,
                enabled: !s.enabled,
              })
            }
          >
            {s.enabled ? "停用" : "恢复采用"}
          </button>
        </article>
      ))}
      {draft ? (
        <form
          className="standard-form"
          onSubmit={(e) => {
            e.preventDefault();
            void saveStandard(draft);
          }}
        >
          <h3>{draft.id ? "修订标准" : "采纳为项目标准"}</h3>
          <label className="field-label">
            名称
            <input
              aria-label="标准名称"
              value={draft.title}
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </label>
          <label className="field-label">
            要求
            <textarea
              aria-label="标准内容"
              value={draft.body}
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              rows={5}
            />
          </label>
          <label className="field-label">
            适用范围
            <select
              aria-label="标准适用范围"
              value={draft.deliveryId ?? ""}
              disabled={busy}
              onChange={(e) =>
                setDraft({ ...draft, deliveryId: e.target.value || null })
              }
            >
              <option value="">仅本项目的所有工作</option>
              {data.deliveries
                .filter((d) => d.projectId === project.id)
                .map((d) => (
                  <option value={d.id} key={d.id}>
                    仅交付：{d.title}
                  </option>
                ))}
            </select>
          </label>
          {draft.source ? (
            <p className="muted">
              保留准确成果版本作为依据；采纳不改写原成果。
            </p>
          ) : null}
          <button
            className="primary"
            disabled={busy || !draft.title.trim() || !draft.body.trim()}
          >
            {draft.id ? "采用此修订" : "采纳标准"}
          </button>
          <button type="button" disabled={busy} onClick={() => setDraft(null)}>
            取消
          </button>
        </form>
      ) : null}
    </Dialog>
  );
}
