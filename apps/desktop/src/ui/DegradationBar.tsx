import type { Degradation } from "@ytriple/shared";
import { useState, type JSX } from "react";

/**
 * Degradations, visible rather than swallowed.
 *
 * A run that quietly gave up strict schemas, or traded grounding for tool
 * calls, looks identical to a clean one unless the UI says otherwise. Identical
 * degradations are grouped with a count, because a JSON-mode provider reports
 * the same one on every call and eight copies of one line is not information.
 */
export interface GroupedDegradation {
  degradation: Degradation;
  count: number;
  agentIds: string[];
}

export function groupDegradations(
  entries: readonly { degradation: Degradation; agentId?: string | undefined }[],
): GroupedDegradation[] {
  const grouped = new Map<string, GroupedDegradation>();

  for (const entry of entries) {
    const key = `${entry.degradation.kind}|${entry.degradation.from}|${entry.degradation.to}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
      if (entry.agentId && !existing.agentIds.includes(entry.agentId)) {
        existing.agentIds.push(entry.agentId);
      }
      continue;
    }
    grouped.set(key, {
      degradation: entry.degradation,
      count: 1,
      agentIds: entry.agentId ? [entry.agentId] : [],
    });
  }

  return [...grouped.values()];
}

const KIND_LABELS: Record<Degradation["kind"], string> = {
  structured_output: "Structured output",
  native_web_search: "Native web search",
  web_search_unavailable: "Web search",
  tool_calling: "Tool calling",
  context_overflow: "Context",
  streaming: "Streaming",
};

export function DegradationBar({
  groups,
  displayNames,
}: {
  groups: GroupedDegradation[];
  displayNames: Record<string, string>;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (groups.length === 0) return null;

  return (
    <div className={`degradation-bar ${open ? "is-open" : ""}`}>
      <button type="button" className="degradation-summary" onClick={() => setOpen(!open)}>
        <span className="brief-chevron">{open ? "▾" : "▸"}</span>
        <span className="tag tag-warn">{groups.length} degradation(s)</span>
        <span className="muted">
          {groups
            .map((group) => `${KIND_LABELS[group.degradation.kind]} → ${group.degradation.to}`)
            .join(" · ")}
        </span>
      </button>

      {open && (
        <ul className="degradation-detail">
          {groups.map((group, index) => (
            <li key={index}>
              <span className="tag tag-warn">{KIND_LABELS[group.degradation.kind]}</span>
              <span className="degradation-transition">
                {group.degradation.from} → {group.degradation.to}
              </span>
              {group.count > 1 && <span className="muted">×{group.count}</span>}
              {group.agentIds.length > 0 && (
                <span className="muted">
                  {group.agentIds.map((agentId) => displayNames[agentId] ?? agentId).join(", ")}
                </span>
              )}
              <p className="muted">{group.degradation.detail}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
