import { useState } from "react";
import { command } from "./api";
import { Dialog } from "./Dialog";
export function UnknownRunActions({
  id,
  kind,
  local,
  onError,
}: {
  id: string;
  kind: "work" | "radar";
  local: boolean;
  onError: (e: unknown) => void;
}) {
  const [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false);
  async function invoke(abandon: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      await command(
        kind === "work"
          ? abandon
            ? { type: "abandon-local-run", runId: id }
            : { type: "reconcile", runId: id }
          : abandon
            ? { type: "abandon-local-radar", jobId: id }
            : { type: "radar-reconcile", jobId: id },
      );
      setConfirm(false);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button disabled={busy} onClick={() => void invoke(false)}>
        {local
          ? "核对本地记录"
          : kind === "work"
            ? "核对中断运行"
            : "核对原整理"}
      </button>
      {local ? (
        <button
          className="quiet"
          disabled={busy}
          onClick={() => setConfirm(true)}
        >
          结束本地等待
        </button>
      ) : null}
      {confirm ? (
        <Dialog
          title="结束本地等待"
          onClose={() => {
            if (!busy) setConfirm(false);
          }}
        >
          <p>
            兼容接口无法确认远端最终状态，原请求可能已产生用量。此操作仅结束本地等待，保留部分输出和请求记录，不取消或重发远端请求。
          </p>
          <p>如需再次尝试，请明确发起新的一轮工作。</p>
          <button disabled={busy} onClick={() => void invoke(true)}>
            保留记录并结束等待
          </button>
        </Dialog>
      ) : null}
    </>
  );
}
