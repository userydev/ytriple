import { useState } from "react";
import {
  FilePlus2,
  FolderOpen,
  Link,
  RefreshCw,
  FileOutput,
} from "lucide-react";
import type { ArtifactVersion, Project, Snapshot } from "../core/types";
import type {
  SuggestionPreview,
  SuggestionReceipt,
} from "../core/project-suggestions";
import { command } from "./api";
import { IconButton } from "./Composer";
import { Dialog } from "./Dialog";

export function SuggestionLocation({
  data,
  project,
  onError,
  onChange,
  disabled = false,
}: {
  data: Snapshot;
  project: Project;
  onError: (e: unknown) => void;
  onChange?: () => void;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const doc = data.suggestionDocuments.find((d) => d.projectId === project.id);
  const last = data.suggestionReceipts
    .filter((r) => r.projectId === project.id && r.path === doc?.path)
    .at(-1);
  async function choose(mode: "existing" | "new") {
    if (busy || disabled) return;
    setBusy(true);
    try {
      const selected = await command<unknown>({
        type: "choose-suggestion-document",
        projectId: project.id,
        mode,
      });
      if (selected) onChange?.();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="suggestion-location">
      <div className="section-heading">
        <h2>项目建议</h2>
        <div className="toolbar">
          <IconButton
            label="关联已有建议文档"
            disabled={busy || disabled}
            onClick={() => void choose("existing")}
          >
            <Link size={17} />
          </IconButton>
          <IconButton
            label="选择新建议文档位置"
            disabled={busy || disabled}
            onClick={() => void choose("new")}
          >
            <FilePlus2 size={17} />
          </IconButton>
          {doc ? (
            <IconButton
              label="在 Finder 显示建议文档"
              disabled={busy || disabled}
              onClick={() =>
                void command({
                  type: "reveal-suggestion-document",
                  projectId: project.id,
                }).catch(onError)
              }
            >
              <FolderOpen size={17} />
            </IconButton>
          ) : null}
        </div>
      </div>
      <p className="local-path">
        {doc?.path ?? "关联已有建议文档，或选择一个固定位置。"}
      </p>
      {doc && doc.root !== project.directory ? (
        <p role="status">项目目录已变化，请重新关联建议文档。</p>
      ) : null}
      <p className="muted">
        从成果中选择“写入项目建议”，预览后追加到这里。
        {last
          ? ` 最近写入：${new Date(last.writtenAt).toLocaleString()}。`
          : ""}
      </p>
    </section>
  );
}

export function SuggestionDialog({
  data,
  project,
  version,
  excerpt,
  onClose,
}: {
  data: Snapshot;
  project: Project;
  version: ArtifactVersion;
  excerpt?: string;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<SuggestionPreview | null>(null);
  const [receipt, setReceipt] = useState<SuggestionReceipt | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const doc = data.suggestionDocuments.find((d) => d.projectId === project.id);
  const fail = (e: unknown) =>
    setError(e instanceof Error ? e.message : String(e));
  async function refresh() {
    if (busy) return;
    setBusy(true);
    setError("");
    setPreview(null);
    setReceipt(null);
    try {
      setPreview(
        await command<SuggestionPreview>({
          type: "preview-project-suggestion",
          projectId: project.id,
          versionId: version.id,
          excerpt,
        }),
      );
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  async function publish() {
    if (busy || !preview) return;
    setBusy(true);
    setError("");
    try {
      setReceipt(
        await command<SuggestionReceipt>({
          type: "publish-project-suggestion",
          previewId: preview.id,
        }),
      );
    } catch (e) {
      fail(e);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title="写入项目建议"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <SuggestionLocation
        data={data}
        project={project}
        onError={fail}
        disabled={busy}
        onChange={() => {
          setPreview(null);
          setReceipt(null);
        }}
      />
      <p>
        主成果 v{version.number} · {excerpt ? "所选段落" : "完整成果"}
      </p>
      <p className="muted">
        写入只记录建议，采纳或执行情况需另行确认。修改内容请返回工作让 AI 整理。
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {receipt ? (
        <p role="status">建议已写入 {receipt.path}，原内容保留。</p>
      ) : (
        <>
          <pre className="suggestion-preview">
            {preview?.addition ?? excerpt ?? version.body}
          </pre>
          {preview ? (
            <details>
              <summary>原文档内容（保留）</summary>
              <pre className="suggestion-preview">
                {preview.existing || "文档尚无内容。"}
              </pre>
            </details>
          ) : null}
          <div className="toolbar">
            <button
              className="quiet"
              disabled={busy || !doc || doc.root !== project.directory}
              onClick={() => void refresh()}
            >
              <RefreshCw size={16} />
              {preview ? "重新预览" : "预览追加"}
            </button>
            {preview ? (
              <button
                disabled={busy || preview.document.id !== doc?.id}
                onClick={() => void publish()}
              >
                <FileOutput size={16} />
                追加到建议文档
              </button>
            ) : null}
          </div>
        </>
      )}
    </Dialog>
  );
}
