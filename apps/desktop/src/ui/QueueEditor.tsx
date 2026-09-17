import { outputLabels } from "../core/output";
import { useRef, useState } from "react";
import type { Run, Snapshot } from "../core/types";
import { Dialog } from "./Dialog";
import { References } from "./References";
import { command } from "./api";
export function QueueEditor({
  run,
  data,
  onClose,
}: {
  run: Run;
  data: Snapshot;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(run.queueDraft!),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const pending = useRef<Promise<unknown>>(Promise.resolve()),
    revision = run.queueRevision ?? 0;
  function change(next: typeof draft) {
    setDraft(next);
    setError("");
    pending.current = command({
      type: "queue-draft",
      runId: run.id,
      revision,
      draft: next,
    });
    void pending.current.catch((e) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  }
  async function finish(discard = false) {
    setBusy(true);
    setError("");
    try {
      await pending.current;
      await command({
        type: discard ? "discard-queue-edit" : "apply-queue-edit",
        runId: run.id,
        revision,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const invalid = draft.refs.some((r) => {
    const m = data.materials.find(
      (m) => m.id === r.materialId && m.version === r.version,
    );
    return !m || m.readError;
  });
  return (
    <Dialog title="编辑待发补充" onClose={onClose}>
      <p className="muted">
        本轮输出：{outputLabels[run.outputMode ?? "result"]}
      </p>
      <p className="muted">
        队列已暂停。
        {data.runs.some(
          (r) => r.workId === run.workId && r.status === "running",
        )
          ? "当前正在执行的轮次继续。"
          : ""}
        保存后可明确继续待发。
      </p>
      <label className="field-label">
        交流对象
        <select
          value={draft.recipient ?? ""}
          disabled={busy}
          onChange={(e) =>
            change({ ...draft, recipient: e.target.value || null })
          }
        >
          <option value="">整个团队</option>
          {run.team.members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <References
        refs={draft.refs}
        data={data}
        disabled={busy}
        onChange={(refs) => change({ ...draft, refs })}
      />
      <label className="field-label">
        补充内容
        <textarea
          aria-label="待发补充内容"
          autoFocus
          rows={7}
          disabled={busy}
          value={draft.text}
          onChange={(e) => change({ ...draft, text: e.target.value })}
        />
      </label>
      <label className="field-label">
        补充材料
        <select
          value=""
          disabled={busy || draft.refs.length >= 20}
          onChange={(e) => {
            const m = data.materials.find(
              (m) => `${m.id}@${m.version}` === e.target.value,
            );
            if (m)
              change({
                ...draft,
                refs: [
                  ...draft.refs,
                  { materialId: m.id, version: m.version, label: m.title },
                ],
              });
          }}
        >
          <option value="">选择已有材料…</option>
          {data.materials.map((m) => (
            <option key={`${m.id}@${m.version}`} value={`${m.id}@${m.version}`}>
              {m.title} · v{m.version}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">
        {run.team.name} v{run.team.version} / {run.workflow.name} v
        {run.workflow.version} · 关闭后保留未保存编辑
      </p>
      {error ? (
        <p className="error-inline" role="alert">
          {error}
        </p>
      ) : null}
      <div className="dialog-actions">
        <button disabled={busy} onClick={() => void finish(true)}>
          放弃本次编辑
        </button>
        <button
          className="primary"
          disabled={busy || invalid || !draft.text.trim()}
          onClick={() => void finish()}
        >
          保存待发内容
        </button>
      </div>
    </Dialog>
  );
}
