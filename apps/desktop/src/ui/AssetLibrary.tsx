import { SkillLibrary } from "./SkillLibrary";
import { useState } from "react";
import Markdown from "./Markdown";
import {
  ArrowUpRight,
  Download,
  FolderOpen,
  RefreshCw,
  Upload,
  Search,
} from "lucide-react";
import type { Asset, Snapshot, Draft } from "../core/types";
import type { AssetFileStatus } from "../core/assets";
import { command } from "./api";
import { IconButton } from "./Composer";
import { Dialog } from "./Dialog";
import { LocalAssets } from "./LocalFolders";
import { coverageLabel } from "../core/radar-contract";
export function AssetLibrary({
  data,
  onUse,
  onError,
  onMethodPrepared,
  onNavigate,
}: {
  data: Snapshot;
  onMethodPrepared: (draft: Draft) => Promise<void>;
  onNavigate: (workId: string, versionId?: string) => void;
  onUse: (assetId: string) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [query, setQuery] = useState(""),
    [preview, setPreview] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [fileStates, setFileStates] = useState<Record<string, AssetFileStatus[]>>(
      {},
    );
  const act = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setNotice("");
    try {
      await fn();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };
  const source = (asset: Asset) => {
    if (asset.importedOrigin) return asset.importedOrigin;
    const material = data.materials.find(
      (m) =>
        m.id === asset.reference.materialId &&
        m.version === asset.reference.version,
    );
    const version = data.versions.find(
      (v) => v.artifactId === material?.id && v.number === material?.version,
    );
    const work = data.works.find((w) => w.id === version?.workId);
    return {
      coverage: material?.coverage ?? "unknown",
      workTitle: work?.title,
      projectName: data.projects.find((p) => p.id === work?.projectId)?.name,
      version: asset.reference.version,
      selected: asset.reference.excerpt !== undefined,
    };
  };
  const rows = data.assets.filter((a) =>
    [a.label, source(a).workTitle, source(a).projectName].some((s) =>
      s?.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
    ),
  );
  const selected = data.assets.find((a) => a.id === preview),
    material = selected
      ? data.materials.find(
          (m) =>
            m.id === selected.reference.materialId &&
            m.version === selected.reference.version,
        )
      : undefined;
  return (
    <section className="wide-content">
      <small>LIBRARY</small>
      <h1>可以再次用到的积累</h1>
      <SkillLibrary
        data={data}
        onError={onError}
        onPrepared={onMethodPrepared}
        onNavigate={onNavigate}
      />
      <LocalAssets data={data} onError={onError} />
      <div className="section-heading">
        <label className="asset-search">
          <Search size={16} />
          <input
            aria-label="查找资产或来源"
            placeholder="查找资产或来源"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <IconButton
          label="从文件恢复资产"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const restored = await command<Asset | undefined>({
                type: "asset-restore",
              });
              if (restored) {
                setQuery("");
                setNotice(
                  `已恢复：${restored.label}。来源记录随文件保留，未改变项目要求。`,
                );
              }
            })
          }
        >
          <Upload size={18} />
        </IconButton>
      </div>
      {notice ? (
        <p role="status" className="muted">
          {notice}
        </p>
      ) : null}
      {rows.map((asset) => {
        const origin = source(asset);
        return (
          <article className="asset-row" key={asset.id}>
            <div className="section-heading">
              <button
                className="work-title"
                onClick={() => setPreview(asset.id)}
              >
                {asset.label}
              </button>
              <div className="toolbar">
                <IconButton
                  label={`保存 ${asset.label} 到 AI 目录`}
                  disabled={busy || !data.localRoots.aiPath}
                  onClick={() =>
                    void act(async () => {
                      const saved = await command<Asset | undefined>({
                        type: "asset-export",
                        assetId: asset.id,
                      });
                      if (saved) {
                        setNotice(`已保存：${saved.files?.at(-1)?.path}`);
                        setFileStates((old) => ({ ...old, [asset.id]: [] }));
                      }
                    })
                  }
                >
                  <Download size={17} />
                </IconButton>
                <IconButton
                  label={`引用 ${asset.label} 的保存版本`}
                  disabled={busy}
                  onClick={() => void act(() => onUse(asset.id))}
                >
                  <ArrowUpRight size={18} />
                </IconButton>
              </div>
            </div>
            <p className="muted">
              {[origin.projectName, origin.workTitle]
                .filter(Boolean)
                .join(" / ") || "独立材料"}{" "}
              · v{origin.version}
              {origin.selected ? " · 选段" : ""} ·{" "}
              {coverageLabel(origin.coverage)}
              {asset.importedOrigin ? " · 来源随文件导入" : ""}
            </p>
            {asset.files?.length ? (
              <details>
                <summary>本地文件 · {asset.files.length}</summary>
                {asset.files.map((file) => {
                  const status = fileStates[asset.id]?.find(
                    (s) => s.path === file.path,
                  );
                  return (
                    <div className="local-folder-row" key={file.path}>
                      <div>
                        <p className="local-path">{file.path}</p>
                        <small>
                          {status
                            ? {
                                unchanged: "与保存快照一致",
                                changed: "外部文件已变化，原快照仍保留",
                                missing: "文件已移走或删除，原快照仍保留",
                                unavailable: "文件不可访问或不在当前 AI 目录",
                              }[status.state]
                            : "尚未检查外部变化"}
                          {status
                            ? ` · ${new Date(status.checkedAt).toLocaleTimeString()}`
                            : ""}
                        </small>
                      </div>
                      <IconButton
                        label={`在 Finder 显示 ${asset.label}`}
                        disabled={busy}
                        onClick={() =>
                          void act(() =>
                            command({
                              type: "reveal-local-asset",
                              path: file.path,
                            }),
                          )
                        }
                      >
                        <FolderOpen size={17} />
                      </IconButton>
                    </div>
                  );
                })}
                <button
                  className="quiet"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      const statuses = await command<AssetFileStatus[]>({
                        type: "asset-files",
                        assetId: asset.id,
                      });
                      setFileStates((old) => ({
                        ...old,
                        [asset.id]: statuses,
                      }));
                    })
                  }
                >
                  <RefreshCw size={15} />
                  检查文件变化
                </button>
              </details>
            ) : null}
          </article>
        );
      })}
      {!rows.length ? (
        <p className="empty">
          {query
            ? "没有匹配的资产"
            : "在成果或材料中选择加入资产，再从这里复用或保存到 AI 目录。"}
        </p>
      ) : null}
      {selected ? (
        <Dialog title={selected.label} onClose={() => setPreview(null)}>
          <p className="muted">
            保存版本 v{source(selected).version}
            {source(selected).selected ? " · 选段" : ""} ·{" "}
            {coverageLabel(source(selected).coverage)}
          </p>
          <div className="reading-body">
            <Markdown>
              {selected.reference.excerpt ?? material?.body ?? "本地快照不可用"}
            </Markdown>
          </div>
          <div className="dialog-actions">
            <button
              className="primary"
              disabled={busy || !material}
              onClick={() =>
                void act(async () => {
                  await onUse(selected.id);
                  setPreview(null);
                })
              }
            >
              引用保存版本
            </button>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}
