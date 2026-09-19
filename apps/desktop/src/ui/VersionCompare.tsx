import { useMemo, useState } from "react";
import { diffLines } from "diff";
import type { ArtifactVersion } from "../core/types";
import { Dialog } from "./Dialog";

function TextDiff({ before, after }: { before: string; after: string }) {
  const changes = useMemo(
    () => diffLines(before, after, { timeout: 40, maxEditLength: 4000 }),
    [before, after],
  );
  if (!changes)
    return (
      <div className="version-comparison">
        <p>差异较大，保留两份完整正文供对照。</p>
        <h3>比较前</h3>
        <pre>{before}</pre>
        <h3>比较后</h3>
        <pre>{after}</pre>
      </div>
    );
  return (
    <div className="version-comparison" aria-label="正文差异">
      {before === after ? <p>正文相同</p> : null}
      {changes.map((c, i) => (
        <div className="diff-part" key={i}>
          <small>{c.added ? "＋ 新增" : c.removed ? "− 移除" : "保留"}</small>
          <pre>
            {c.removed ? (
              <del>{c.value}</del>
            ) : c.added ? (
              <ins>{c.value}</ins>
            ) : (
              c.value
            )}
          </pre>
        </div>
      ))}
    </div>
  );
}
export function VersionCompare({
  versions,
  selected,
  onClose,
}: {
  versions: ArtifactVersion[];
  selected: ArtifactVersion;
  onClose: () => void;
}) {
  const history = versions.filter((v) => v.artifactId === selected.artifactId);
  const [beforeId, setBefore] = useState(selected.parentId ?? history[0].id);
  const [afterId, setAfter] = useState(selected.id);
  const before = history.find((v) => v.id === beforeId)!,
    after = history.find((v) => v.id === afterId)!;
  return (
    <Dialog title="比较成果版本" onClose={onClose}>
      <div className="comparison-selectors">
        <label>
          比较前
          <select
            aria-label="比较前版本"
            value={beforeId}
            onChange={(e) => setBefore(e.target.value)}
          >
            {history.map((v) => (
              <option value={v.id} key={v.id}>
                v{v.number} · {v.author === "user" ? "手动编辑" : "团队生成"}
              </option>
            ))}
          </select>
        </label>
        <label>
          比较后
          <select
            aria-label="比较后版本"
            value={afterId}
            onChange={(e) => setAfter(e.target.value)}
          >
            {history.map((v) => (
              <option value={v.id} key={v.id}>
                v{v.number} · {v.author === "user" ? "手动编辑" : "团队生成"}
              </option>
            ))}
          </select>
        </label>
      </div>
      <TextDiff before={before.body} after={after.body} />
    </Dialog>
  );
}
