import { useState } from "react";
import { ClipboardCheck, Paperclip, Plus, Undo2 } from "lucide-react";
import type {
  ArtifactVersion,
  Draft,
  Material,
  Reference,
  Snapshot,
} from "../core/types";
import {
  outcomeLabels,
  outcomeSnapshotChanged,
  type OutcomeRecord,
} from "../core/outcome-contract";
import { processSnapshotStaleData } from "../core/process-scope-stale";
import { versionLabel } from "../core/output";
import { Dialog } from "./Dialog";
import { IconButton } from "./Composer";
import { References } from "./References";
import { command } from "./api";
export function OutcomeDialog({
  data,
  version,
  onClose,
  onPrepared,
  onVersion,
}: {
  data: Snapshot;
  version: ArtifactVersion;
  onClose: () => void;
  onPrepared: (draft: Draft) => Promise<void>;
  onVersion: (id: string) => void;
}) {
  const records = data.outcomes.filter((r) => r.versionId === version.id);
  const latest = records.filter((r) => !r.withdrawn).at(-1);
  const [recipient, setRecipient] = useState(latest?.recipient ?? "");
  const [purpose, setPurpose] = useState(latest?.purpose ?? "");
  const [recording, setRecording] = useState(false);
  const [kind, setKind] = useState<OutcomeRecord["kind"]>("handoff");
  const [occurredOn, setOccurredOn] = useState(() => {
    const now = new Date();
    return new Date(now.getTime() - now.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 10);
  });
  const [body, setBody] = useState("");
  const [refs, setRefs] = useState<Reference[]>([]);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [withdraw, setWithdraw] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const ready = !!recipient.trim() && !!purpose.trim();
  const checks = data.versions.filter(
    (v) =>
      v.kind === "readiness" &&
      v.workId === version.workId &&
      data.runs
        .find((r) => r.id === v.runId)
        ?.refs.some((ref) =>
          data.materials.some(
            (m) =>
              m.id === ref.materialId &&
              m.version === ref.version &&
              m.readinessSource?.versionId === version.id,
          ),
        ),
  );
  async function act(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={`交接与反馈 · ${versionLabel(version)}`}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p className="muted">
        记录只属于此版本。AI 检查是意见，交接、使用和验证分别记录。
      </p>
      <fieldset className="outcome-form" disabled={busy}>
        <label>
          接收或使用对象
          <input
            value={recipient}
            maxLength={300}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="例如：开发同事、视频剪辑师"
          />
        </label>
        <label>
          用途
          <textarea
            value={purpose}
            maxLength={2000}
            rows={2}
            onChange={(e) => setPurpose(e.target.value)}
            placeholder="对方拿到这个版本后，需要完成什么"
          />
        </label>
        <div className="toolbar">
          <button
            disabled={!ready}
            onClick={() =>
              void act(async () => {
                const draft = await command<Draft>({
                  type: "prepare-readiness",
                  input: { versionId: version.id, recipient, purpose },
                });
                await onPrepared(draft);
              })
            }
          >
            <ClipboardCheck size={17} />
            检查是否准备好
          </button>
          <button
            className="quiet"
            aria-expanded={recording}
            onClick={() => setRecording(!recording)}
          >
            <Plus size={17} />
            记录交接或反馈
          </button>
        </div>
        <small className="muted">
          检查要求加入原工作草稿，发送后由团队处理。
        </small>
        {recording ? (
          <div className="outcome-entry">
            <div className="outcome-fields">
              <label>
                记录类型
                <select
                  value={kind}
                  onChange={(e) =>
                    setKind(e.target.value as OutcomeRecord["kind"])
                  }
                >
                  {Object.entries(outcomeLabels).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                发生日期
                <input
                  type="date"
                  value={occurredOn}
                  onChange={(e) => setOccurredOn(e.target.value)}
                />
              </label>
            </div>
            <label>
              {kind === "handoff"
                ? "交接方式与接收情况"
                : kind === "validation"
                  ? "验证方法、结果与限制"
                  : kind === "revision"
                    ? "需要修订的地方"
                    : "实际使用情况与反馈"}
              <textarea
                rows={4}
                maxLength={8000}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder={
                  kind === "handoff"
                    ? "例如：把此版本文件交给剪辑师；对方是否收到"
                    : "描述实际发生的情况，并保留不确定之处"
                }
              />
            </label>
            <References
              refs={refs}
              data={data}
              onChange={setRefs}
              disabled={busy}
            />
            <div className="toolbar">
              <IconButton
                label="添加反馈证据"
                disabled={busy || refs.length >= 5}
                onClick={() =>
                  void act(async () => {
                    const materials = await command<Material[]>({
                      type: "import",
                    });
                    const additions = materials
                      .filter(
                        (m) =>
                          !refs.some(
                            (r) =>
                              r.materialId === m.id && r.version === m.version,
                          ),
                      )
                      .map((m) => ({
                        materialId: m.id,
                        version: m.version,
                        label: m.title,
                      }));
                    if (refs.length + additions.length > 5)
                      throw Error(
                        "最多附加 5 份证据；材料已导入，可从下方选择",
                      );
                    setRefs([...refs, ...additions]);
                  })
                }
              >
                <Paperclip size={17} />
              </IconButton>
              <select
                aria-label="选择已有反馈证据"
                value=""
                disabled={refs.length >= 5}
                onChange={(e) => {
                  const m = data.materials.find(
                    (m) => `${m.id}@${m.version}` === e.target.value,
                  );
                  if (
                    m &&
                    !refs.some(
                      (r) => r.materialId === m.id && r.version === m.version,
                    )
                  )
                    setRefs([
                      ...refs,
                      { materialId: m.id, version: m.version, label: m.title },
                    ]);
                }}
              >
                <option value="">选择已有证据</option>
                {data.materials
                  .filter(
                    (m) =>
                      !m.readError &&
                      m.body.trim() &&
                      !refs.some(
                        (r) => r.materialId === m.id && r.version === m.version,
                      ),
                  )
                  .map((m) => (
                    <option
                      key={`${m.id}@${m.version}`}
                      value={`${m.id}@${m.version}`}
                    >
                      {m.title} · v{m.version}
                    </option>
                  ))}
              </select>
              <button
                className="primary"
                disabled={!ready || !body.trim() || !occurredOn}
                onClick={() =>
                  void act(async () => {
                    await command({
                      type: "record-outcome",
                      input: {
                        key,
                        versionId: version.id,
                        recipient,
                        purpose,
                        kind,
                        occurredOn,
                        body,
                        refs,
                      },
                    });
                    setKey(crypto.randomUUID());
                    setBody("");
                    setRefs([]);
                    setRecording(false);
                    setNotice(
                      "已保存用户记录；未发送给接收方，也未自动认定验证通过。",
                    );
                  })
                }
              >
                保存记录
              </button>
            </div>
          </div>
        ) : null}
      </fieldset>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {checks.length ? (
        <section className="outcome-history">
          <h3>AI 检查意见</h3>
          {checks.map((v) => (
            <button
              className="quiet"
              key={v.id}
              disabled={busy}
              onClick={() => onVersion(v.id)}
            >
              {versionLabel(v)} · {new Date(v.createdAt).toLocaleString()}
              {data.runs
                .find((r) => r.id === v.runId)
                ?.refs.some((ref) => {
                  const m = data.materials.find(
                    (row) =>
                      row.id === ref.materialId &&
                      row.version === ref.version,
                  );
                  if (!m) return false;
                  if (m.processSource)
                    return (
                      processSnapshotStaleData(m, data).status !== "current"
                    );
                  return outcomeSnapshotChanged(m, data.outcomes);
                })
                ? " · 依据或反馈已变化"
                : ""}
            </button>
          ))}
        </section>
      ) : null}
      <section className="outcome-history">
        <div className="section-heading">
          <h3>此版本记录 · {records.filter((r) => !r.withdrawn).length}</h3>
          {records.length ? (
            <button
              className="quiet"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const draft = await command<Draft>({
                    type: "prepare-process",
                    workId: version.workId,
                    mode: "review",
                    versionId: version.id,
                    ...(version.runId ? { runId: version.runId } : {}),
                  });
                  await onPrepared(draft);
                })
              }
            >
              带回团队复盘
            </button>
          ) : null}
        </div>
        {!records.length ? (
          <p className="muted">
            尚无交接与使用记录；其他版本的记录不会继承到这里。
          </p>
        ) : null}
        {records.toReversed().map((r) => (
          <details key={r.id}>
            <summary>
              {outcomeLabels[r.kind]} · {r.recipient} · {r.occurredOn}
              {r.withdrawn ? " · 已撤回" : " · 用户记录"}
            </summary>
            <p>{r.purpose}</p>
            <p className="outcome-body">{r.body}</p>
            {r.evidence.map(({ reference, material }) => (
              <details key={`${material.id}@${material.version}`}>
                <summary>
                  {material.title} · v{material.version}
                </summary>
                <pre className="suggestion-preview">
                  {reference.excerpt ?? material.body}
                </pre>
              </details>
            ))}
            {!r.evidence.length ? (
              <small className="muted">无附件证据，仅有用户陈述。</small>
            ) : null}
            <p className="muted">
              保存于 {new Date(r.recordedAt).toLocaleString()}
            </p>
            {r.withdrawn ? (
              <p>撤回原因：{r.withdrawn.reason}</p>
            ) : (
              <IconButton
                label={`撤回${outcomeLabels[r.kind]}`}
                disabled={busy}
                onClick={() => {
                  setWithdraw(r.id);
                  setReason("");
                }}
              >
                <Undo2 size={16} />
              </IconButton>
            )}
            {withdraw === r.id ? (
              <div className="outcome-entry">
                <label>
                  撤回原因
                  <input
                    value={reason}
                    maxLength={2000}
                    disabled={busy}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </label>
                <button
                  disabled={busy || !reason.trim()}
                  onClick={() =>
                    void act(async () => {
                      await command({
                        type: "withdraw-outcome",
                        id: r.id,
                        reason,
                      });
                      setWithdraw(null);
                      setNotice(
                        "已保留原记录并标记撤回；此前生成的复盘仍是历史快照。",
                      );
                    })
                  }
                >
                  确认撤回记录
                </button>
              </div>
            ) : null}
          </details>
        ))}
      </section>
    </Dialog>
  );
}
