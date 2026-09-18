import { Check, CircleDashed, LoaderCircle, Pause, X } from "lucide-react";
import type { Contribution, Run } from "../core/types";

const labels = {
  succeeded: "已完成",
  running: "处理中",
  waiting: "待答复",
  queued: "待发",
  failed: "失败",
  cancelled: "已停止",
  unknown: "待核实",
};

/** Actual top-level records in recorded order, not an inferred completion percentage. */
export function TeamTrace({
  run,
  records,
  onRecord,
  compact = false,
}: {
  run: Run;
  records: Contribution[];
  compact?: boolean;
  onRecord: (id: string) => void;
}) {
  const entries = records.filter(
    (c) => c.runId === run.id && !c.task?.parentId,
  );
  if (!entries.length) return null;
  return (
    <div className={`team-trace ${compact ? "compact" : ""}`}>
      <div className="trace-heading">
        <span>{run.team.name}</span>
        <small>协作记录 · {entries.length}</small>
      </div>
      <ol aria-label="本轮协作记录，按记录顺序排列">
        {entries.map((c, i) => {
          const Icon =
            c.status === "succeeded"
              ? Check
              : c.status === "running"
                ? LoaderCircle
                : c.status === "waiting"
                  ? Pause
                  : c.status === "failed"
                    ? X
                    : CircleDashed;
          return (
            <li key={c.id}>
              <button
                onClick={() => onRecord(c.id)}
                title={`${c.memberName} · ${labels[c.status]}：${c.objective}`}
              >
                <span className={`trace-node ${c.status}`}>
                  <span>{String(i + 1).padStart(2, "0")}</span>
                  <Icon
                    size={12}
                    className={c.status === "running" ? "spinning" : undefined}
                  />
                </span>
                <strong>{c.memberName}</strong>
                <small>{labels[c.status]}</small>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
