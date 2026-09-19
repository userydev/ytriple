import { useState } from "react";
import type { Snapshot, Work } from "../core/types";
import { command } from "./api";
export function WorkEditor({
  work,
  data,
  onSaved,
}: {
  work: Work;
  data: Snapshot;
  onSaved: (w: Work) => void;
}) {
  const [title, setTitle] = useState(work.title),
    [projectId, setProject] = useState(work.projectId ?? ""),
    [deliveryId, setDelivery] = useState(work.deliveryId ?? "");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          onSaved(
            await command<Work>({
              type: "update-work",
              workId: work.id,
              title,
              projectId: projectId || null,
              deliveryId: deliveryId || null,
            }),
          );
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        工作名称
        <input
          autoFocus
          required
          maxLength={200}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label>
        归属项目
        <select
          value={projectId}
          onChange={(e) => {
            setProject(e.target.value);
            setDelivery("");
          }}
        >
          <option value="">独立工作</option>
          {data.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {projectId ? (
        <label>
          关联交付
          <select
            value={deliveryId}
            onChange={(e) => setDelivery(e.target.value)}
          >
            <option value="">暂不关联交付</option>
            {data.deliveries
              .filter((d) => d.projectId === projectId)
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                </option>
              ))}
          </select>
        </label>
      ) : null}
      <p className="muted">
        改名或调整归属后，继续使用原工作、草稿与成果版本。
      </p>
      {error ? (
        <p role="alert" className="error-inline">
          {error}
        </p>
      ) : null}
      <button className="primary" disabled={busy || !title.trim()}>
        保存
      </button>
      <div className="work-state-actions">
        {(
          [
            work.completedAt ? "reopen" : "complete",
            work.archived ? "restore" : "archive",
          ] as const
        ).map((action) => (
          <button
            type="button"
            key={action}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError("");
              void command<Work>({
                type: "work-state",
                workId: work.id,
                action,
              })
                .then(onSaved)
                .catch((e) =>
                  setError(e instanceof Error ? e.message : String(e)),
                )
                .finally(() => setBusy(false));
            }}
          >
            {
              {
                complete: "标记工作已完成",
                reopen: "重新开始工作",
                archive: "归档工作",
                restore: "恢复到工作列表",
              }[action]
            }
          </button>
        ))}
      </div>
      {data.schedules.some((s) => s.workId === work.id && s.enabled) ? (
        <p className="muted">
          完成或归档将同时暂停本工作的定时任务；恢复工作后需自行重新启用。
        </p>
      ) : null}
      <p className="muted">
        归档只从日常列表收起，草稿、过程、成果和采用关系保留；可从查找工作恢复。完成与归档不会自动发布成果。
      </p>
    </form>
  );
}
