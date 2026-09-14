import { useState, type JSX } from "react";
import type { HistoryRecord } from "../host/types.js";
import { PrdPreview } from "./PrdPreview.js";

export function HistoryView({
  records,
  canReveal,
  onReveal,
}: {
  records: HistoryRecord[];
  canReveal: boolean;
  onReveal(taskId: string): void;
}): JSX.Element {
  const [selected, setSelected] = useState<string | undefined>(records[0]?.taskId);
  const record = records.find((entry) => entry.taskId === selected);

  if (records.length === 0) {
    return (
      <div className="single-pane">
        <div className="empty-state">
          <p>No tasks yet.</p>
          <p className="muted">Completed tasks appear here with the document they produced.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="history-layout">
      <aside className="pane history-list">
        <header className="pane-header">
          <h2>History</h2>
          <span className="muted">{records.length} task(s)</span>
        </header>
        <div className="pane-scroll">
          {records.map((entry) => (
            <button
              key={entry.taskId}
              type="button"
              className={`history-item ${entry.taskId === selected ? "is-selected" : ""}`}
              onClick={() => setSelected(entry.taskId)}
            >
              <span className="history-title">{entry.title}</span>
              <span className="muted">
                {new Date(entry.createdAt).toLocaleString()} · {entry.status} ·{" "}
                {entry.memberIds.length} member(s) · {entry.eventCount} events
              </span>
            </button>
          ))}
        </div>
      </aside>

      {record?.prdMarkdown ? (
        <PrdPreview
          filename="prd.md"
          path={record.prdPath ?? ""}
          markdown={record.prdMarkdown}
          canReveal={canReveal}
          onReveal={() => onReveal(record.taskId)}
        />
      ) : (
        <div className="single-pane">
          <div className="empty-state">
            <p>This task produced no document.</p>
            <p className="muted">Status: {record?.status ?? "unknown"}</p>
          </div>
        </div>
      )}
    </div>
  );
}
