import { useState } from "react";
import type { ArtifactVersion, Draft, Snapshot, WorkflowCandidate } from "../core/types";
import { command } from "./api";
import { versionLabel } from "../core/output";

export function WorkflowCandidateActions({
  data,
  version,
  onPrepared,
  onRefresh,
}: {
  data: Snapshot;
  version: ArtifactVersion;
  onPrepared: (draft: Draft) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const refresh = onRefresh;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const candidates = data.workflowCandidates.filter(
    (c) => c.sourceVersionId === version.id,
  );
  const latest = candidates.at(-1);
  async function act(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="workflow-candidate-actions">
      <h3>可执行流程候选</h3>
      <p className="muted">
        从本份{versionLabel(version)}提炼协作步骤草案，需你显式保存为独立流程版本后再在配置中应用；不会自动改写默认团队或历史运行。
      </p>
      <div className="dialog-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const draft = await command<Draft>({
                type: "prepare-workflow-candidate",
                sourceVersionId: version.id,
              });
              await onPrepared(draft);
            })
          }
        >
          准备 AI 流程候选
        </button>
      </div>
      {latest ? (
        <CandidatePreview
          candidate={latest}
          members={data.runs.find(r => r.id === latest.runId)?.team.members ?? []}
          busy={busy}
          onSave={() =>
            act(async () => {
              await command({
                type: "save-workflow-candidate",
                candidateId: latest.id,
              });
              await refresh();
            })
          }
        />
      ) : (
        <p className="muted">尚无流程候选；发送准备后的草稿并由 AI 回答后会出现预览。</p>
      )}
      {error ? <p className="error-inline">{error}</p> : null}
    </section>
  );
}

function CandidatePreview({
  candidate,
  members,
  busy,
  onSave,
}: {
  candidate: WorkflowCandidate;
  members: { id: string; name: string }[];
  busy: boolean;
  onSave: () => void;
}) {
  if (candidate.parseError) return <p role="alert" className="error-inline">未能生成可用流程：{candidate.parseError}。可调整草稿后重新提炼。</p>;
  return (
    <div className="workflow-candidate-preview">
      <p>
        <strong>{candidate.preview.name}</strong>
        {candidate.status === "saved"
          ? " · 已保存；请在团队与流程中选择并应用"
          : " · 待保存"}
      </p>
      <p className="muted">{candidate.preview.applicability}</p>
      <ol>
        {candidate.preview.stages.map((s, i) => (
          <li key={i}>
            {members.find(m => m.id === s.role)?.name ?? s.role} · {s.objective}
            {s.result ? " · 形成成果" : ""}
          </li>
        ))}
      </ol>
      {candidate.preview.unverified.length ? (
        <p className="muted">
          待验证：{candidate.preview.unverified.join("；")}
        </p>
      ) : null}
      <p className="muted">依据说明：{candidate.preview.sourceNotes}</p>
      {candidate.status === "draft" ? (
        <button type="button" disabled={busy} onClick={onSave}>
          保存为独立流程版本
        </button>
      ) : null}
    </div>
  );
}
