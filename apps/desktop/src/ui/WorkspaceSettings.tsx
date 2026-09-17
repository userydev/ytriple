import { useEffect, useRef, useState } from "react";
import { Download, Upload, ArrowUpRight } from "lucide-react";
import type {
  BackupPreview,
  SpaceEntry,
  SpaceInfo,
} from "../core/backup-contract";
import { command } from "./api";
import { IconButton } from "./Composer";
import { Dialog } from "./Dialog";

const countLabels: Record<string, string> = {
  work: "工作",
  project: "项目",
  version: "成果版本",
  draft: "草稿",
  material: "材料版本",
  "radar-topic": "雷达议题",
  "radar-edition": "雷达解读",
  schedule: "定时任务",
  feed: "订阅",
  skill: "方法版本",
};
export function WorkspaceSettings({
  onError,
}: {
  onError: (error: unknown) => void;
}) {
  const [info, setInfo] = useState<SpaceInfo>();
  const [preview, setPreview] = useState<BackupPreview>();
  const [name, setName] = useState("");
  const [switchTo, setSwitchTo] = useState<SpaceEntry>();
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  useEffect(() => {
    let alive = true;
    command<SpaceInfo>({ type: "workspace-info" })
      .then((data) => {
        if (alive) setInfo(data);
      })
      .catch((error) => {
        if (alive) onError(error);
      });
    return () => {
      alive = false;
    };
  }, [onError]);
  async function act(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setNotice("");
    try {
      await action();
    } catch (error) {
      onError(error);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="workspace-settings">
      <div className="section-heading">
        <h2>备份与空间</h2>
        <div className="toolbar">
          <IconButton
            label="备份当前空间"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const result = await command<{ path: string } | undefined>({
                  type: "workspace-export",
                });
                if (result) setNotice(`备份已保存：${result.path}`);
              })
            }
          >
            <Download size={18} />
          </IconButton>
          <IconButton
            label="从备份恢复空间"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const next = await command<BackupPreview | undefined>({
                  type: "workspace-inspect",
                });
                if (next) {
                  setPreview(next);
                  setName(
                    `恢复 · ${new Date(next.createdAt).toLocaleDateString()}`,
                  );
                }
              })
            }
          >
            <Upload size={18} />
          </IconButton>
        </div>
      </div>
      <p>保存工作、成果、草稿和引用关系；恢复为独立空间。</p>
      <p className="muted">
        包含已读材料与项目关联，不复制 AI、Code 的原始文件或服务凭据。
      </p>
      {info?.startupError ? <p role="status">{info.startupError}</p> : null}
      {info?.spaces.map((space) => (
        <div className="local-folder-row" key={space.id}>
          <div>
            <strong>{space.name}</strong>
            <small className="muted">
              {space.id === info.currentId
                ? " · 当前空间"
                : space.createdAt
                  ? ` · ${new Date(space.createdAt).toLocaleString()}`
                  : ""}
            </small>
          </div>
          {space.id !== info.currentId ? (
            <IconButton
              label={`打开 ${space.name}`}
              disabled={busy}
              onClick={() => setSwitchTo(space)}
            >
              <ArrowUpRight size={18} />
            </IconButton>
          ) : null}
        </div>
      ))}
      {notice ? (
        <p role="status" className="workspace-notice">
          {notice}
        </p>
      ) : null}
      {preview ? (
        <Dialog
          title="恢复工作空间"
          onClose={() => {
            if (!busy) setPreview(undefined);
          }}
        >
          <p>
            {preview.name} · {new Date(preview.createdAt).toLocaleString()}
          </p>
          <dl className="backup-counts">
            {Object.entries(countLabels)
              .filter(([kind]) => preview.counts[kind])
              .map(([kind, label]) => (
                <div key={kind}>
                  <dt>{label}</dt>
                  <dd>{preview.counts[kind]}</dd>
                </div>
              ))}
          </dl>
          <label>
            新空间名称
            <input
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
            />
          </label>
          <p>
            自动任务和工作队列将暂停；本地文件写入需重新预览。原空间保持可用。
          </p>
          <p className="muted">
            已读内容可直接查看。AI、Code
            路径只在与当前配置相同时沿用，其他位置需要重新选择；服务连接单独配置。
          </p>
          <details>
            <summary>原目录与校验信息</summary>
            <p className="local-path">
              AI：{preview.roots.aiPath ?? "未配置"}
              <br />
              Code：{preview.roots.codePath ?? "未配置"}
            </p>
            <p className="workspace-notice">SHA-256：{preview.sha256}</p>
          </details>
          <button
            className="primary"
            disabled={busy || !name.trim()}
            onClick={() =>
              void act(async () => {
                const restored = await command<SpaceEntry>({
                  type: "workspace-restore",
                  previewId: preview.id,
                  name: name.trim(),
                });
                setPreview(undefined);
                setInfo(await command<SpaceInfo>({ type: "workspace-info" }));
                setNotice(
                  `已恢复「${restored.name}」。打开后可核对成果和草稿。`,
                );
              })
            }
          >
            {busy ? "正在恢复…" : "恢复为新空间"}
          </button>
        </Dialog>
      ) : null}
      {switchTo ? (
        <Dialog
          title={`打开 ${switchTo.name}`}
          onClose={() => {
            if (!busy) setSwitchTo(undefined);
          }}
        >
          <p>应用将重新启动并打开此空间。当前空间保留，可随时从设置返回。</p>
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await command({ type: "workspace-switch", id: switchTo.id });
                setNotice("正在重新打开应用…");
              })
            }
          >
            重新启动并打开
          </button>
        </Dialog>
      ) : null}
    </section>
  );
}
