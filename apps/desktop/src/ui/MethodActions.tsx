import { outcomeSnapshotChanged } from "../core/outcome-contract";
import { useState } from "react";
import { Play, Check } from "lucide-react";
import type { ArtifactVersion, Draft, Snapshot } from "../core/types";
import { skillKey } from "../core/skill-contract";
import { command } from "./api";
export function MethodActions({
  data,
  version,
  onPrepared,
  onNavigate,
}: {
  data: Snapshot;
  version: ArtifactVersion;
  onPrepared: (draft: Draft) => Promise<void>;
  onNavigate: (workId: string, versionId?: string) => void;
}) {
  const [projectId, setProjectId] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [accepting, setAccepting] = useState(false),
    [reason, setReason] = useState(""),
    [trialId, setTrialId] = useState("");
  const method = data.skills.find(
      (s) =>
        s.source.kind === "proposal" && s.proposal?.versionId === version.id,
    ),
    key = method ? skillKey(method) : null;
  const adoption = data.skillAdoptions.find((a) => a.key === key);
  const trials = key
    ? data.runs.filter(
        (r) =>
          r.status === "succeeded" &&
          data.contributions.some(
            (c) =>
              c.runId === r.id &&
              c.status === "succeeded" &&
              c.skills?.some((u) => u.key === key),
          ),
      )
    : [];
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
  const originChanged = data.runs
    .find((r) => r.id === version.runId)
    ?.refs.some((ref) =>
      data.materials.some(
        (m) =>
          m.id === ref.materialId &&
          m.version === ref.version &&
          outcomeSnapshotChanged(m, data.outcomes),
      ),
    );
  return (
    <section className="method-actions">
      {originChanged ? (
        <p role="status">
          来源反馈已变化，草案保留当时依据；请回原工作核对是否需要重新整理。
        </p>
      ) : null}
      <p className="muted">
        {adoption
          ? "已采纳为可复用方法 · 效果仍待验证"
          : trials.length
            ? "已有试用记录 · 尚未采纳为长期方法"
            : "方法草案 · 先试用，再决定是否采纳"}
      </p>
      <div className="dialog-actions">
        <select
          aria-label="方法试用归属"
          value={projectId ?? ""}
          disabled={busy}
          onChange={(e) => setProjectId(e.target.value || null)}
        >
          <option value="">独立试用</option>
          {data.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const draft = await command<Draft>({
                type: "prepare-method-trial",
                versionId: version.id,
                projectId,
              });
              await onPrepared(draft);
            })
          }
        >
          <Play size={15} />
          试用此方法
        </button>
        {!adoption && trials.length ? (
          <button
            disabled={busy}
            onClick={() => {
              setTrialId(trials.at(-1)!.id);
              setAccepting(!accepting);
            }}
          >
            <Check size={15} />
            采纳为可复用方法
          </button>
        ) : null}
      </div>
      {trials.length ? (
        <details>
          <summary>试用与后续使用 · {trials.length} 轮</summary>
          {trials.map((r) => (
            <button
              className="skill-row"
              key={r.id}
              onClick={() =>
                onNavigate(
                  r.workId,
                  data.versions.find((v) => v.runId === r.id)?.id,
                )
              }
            >
              <span>{r.text.slice(0, 90)}</span>
              <small>{new Date(r.createdAt).toLocaleString()}</small>
            </button>
          ))}
        </details>
      ) : null}
      {accepting && !adoption ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await command({
                type: "adopt-method",
                key: key!,
                trialRunId: trialId,
                reason,
              });
              setAccepting(false);
            });
          }}
        >
          <label>
            依据哪轮试用
            <select
              value={trialId}
              onChange={(e) => setTrialId(e.target.value)}
              disabled={busy}
            >
              {trials.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.text.slice(0, 60)}
                </option>
              ))}
            </select>
          </label>
          <label>
            采纳理由与适用限制
            <textarea
              required
              maxLength={1000}
              rows={3}
              value={reason}
              disabled={busy}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <p className="muted">
            采纳后可在成员方法范围中选用；不会自动改写团队、项目标准或定时委托。
          </p>
          <button type="submit" disabled={busy || !reason.trim()}>
            确认采纳此版本
          </button>
        </form>
      ) : null}
      {adoption ? <p>采纳记录：{adoption.reason}</p> : null}
      {error ? (
        <p role="alert" className="error-inline">
          {error}
        </p>
      ) : null}
    </section>
  );
}
