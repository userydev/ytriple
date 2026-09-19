import { useState, useRef, useEffect } from "react";
import { FileText, X, RefreshCw } from "lucide-react";
import type { Reference, Snapshot } from "../core/types";
import { Dialog } from "./Dialog";
import { command } from "./api";
const coverage: Record<string, string> = {
  local_text: "本地文本",
  artifact: "成果正文",
  readiness_snapshot: "交接检查快照",
  process_snapshot: "公开过程快照",
  project_file: "项目文件快照",
  summary: "来源摘要",
  feed_excerpt: "来源节选",
  link_only: "仅链接，未读取正文",
  unread: "尚未读取",
};
export function References({
  refs,
  data,
  onChange,
  disabled = false,
}: {
  refs: Reference[];
  data: Snapshot;
  onChange: (refs: Reference[]) => void;
  disabled?: boolean;
}) {
  const [all, setAll] = useState(false),
    [preview, setPreview] = useState<number | null>(null),
    [error, setError] = useState(""),
    [retrying, setRetrying] = useState(false);
  const previewBody = useRef<HTMLPreElement>(null),
    [selection, setSelection] = useState("");
  useEffect(() => {
    setSelection("");
    const capture = () => {
      const s = window.getSelection();
      if (
        s?.anchorNode &&
        s.focusNode &&
        previewBody.current?.contains(s.anchorNode) &&
        previewBody.current.contains(s.focusNode) &&
        s.toString().trim()
      )
        setSelection(s.toString());
    };
    document.addEventListener("selectionchange", capture);
    return () => document.removeEventListener("selectionchange", capture);
  }, [preview]);
  const ref = preview === null ? undefined : refs[preview];
  const material = ref
    ? data.materials.find(
        (m) => m.id === ref.materialId && m.version === ref.version,
      )
    : undefined;
  function replace(next: Reference) {
    if (preview === null) return;
    onChange(refs.map((r, i) => (i === preview ? next : r)));
    setError("");
  }
  return (
    <>
      {refs.length ? (
        <div className="references">
          {(all ? refs : refs.slice(0, 2)).map((r, i) => {
            const m = data.materials.find(
              (m) => m.id === r.materialId && m.version === r.version,
            );
            return (
              <span
                className="reference"
                key={`${r.materialId}@${r.version}:${i}`}
              >
                <button
                  type="button"
                  className="reference-label"
                  onClick={() => {
                    setPreview(i);
                    setError("");
                  }}
                >
                  <FileText size={13} />
                  {r.label.endsWith(`v${r.version}`)
                    ? r.label
                    : `${r.label} · v${r.version}`}
                  {r.excerpt ? " · 选段" : ""}
                  {m?.readError ? " · 读取失败" : !m ? " · 准备中" : ""}
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`移除引用 ${r.label}`}
                  title="移除引用"
                  disabled={disabled}
                  onClick={() => onChange(refs.filter((_, n) => n !== i))}
                >
                  <X size={13} />
                </button>
              </span>
            );
          })}
          {refs.length > 2 ? (
            <button
              type="button"
              className="quiet"
              onClick={() => setAll((v) => !v)}
            >
              {all ? "收起材料" : `另 ${refs.length - 2} 项`}
            </button>
          ) : null}
        </div>
      ) : null}
      {ref ? (
        <Dialog
          title={
            ref.label.endsWith(`v${ref.version}`)
              ? ref.label
              : `${ref.label} · v${ref.version}`
          }
          onClose={() => setPreview(null)}
        >
          <p className="muted">
            {material
              ? (coverage[material.coverage] ?? material.coverage)
              : "材料仍在载入"}
            {ref.excerpt ? " · 本轮只引用所选范围" : ""}
          </p>
          {material?.readError ? (
            <div>
              <p role="alert" className="error-inline">
                {material.readError}
              </p>
              <button
                disabled={disabled || retrying}
                onClick={async () => {
                  setRetrying(true);
                  try {
                    await command({
                      type: "retry-import",
                      materialId: ref.materialId,
                      version: ref.version,
                    });
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                  } finally {
                    setRetrying(false);
                  }
                }}
              >
                <RefreshCw size={15} />
                重新读取
              </button>
            </div>
          ) : (
            <pre className="reference-preview" ref={previewBody}>
              {ref.excerpt ?? material?.body ?? ""}
            </pre>
          )}
          {material?.url ? <p className="source-url">{material.url}</p> : null}
          {error ? (
            <p role="alert" className="error-inline">
              {error}
            </p>
          ) : null}
          {material && !material.readError ? (
            <div className="dialog-actions">
              <button
                disabled={disabled}
                onClick={() => {
                  const selected = selection;
                  if (
                    !selected?.trim() ||
                    !(ref.excerpt ?? material.body).includes(selected)
                  ) {
                    setError("请先在上面的材料正文中选择连续文字");
                    return;
                  }
                  replace({ ...ref, excerpt: selected });
                }}
              >
                只引用选中内容
              </button>
              {ref.excerpt ? (
                <button
                  disabled={disabled}
                  onClick={() => {
                    const { excerpt, ...whole } = ref;
                    replace(whole);
                  }}
                >
                  引用整个已读取范围
                </button>
              ) : null}
              <button className="primary" onClick={() => setPreview(null)}>
                完成
              </button>
            </div>
          ) : null}
        </Dialog>
      ) : null}
    </>
  );
}
