import type { DesktopState, WindowKind } from "../shared/types.js";

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface WindowLayout {
  version: 2;
  mode: DesktopState["mode"];
  taskId: string | null;
  bounds: Bounds;
  collapsed: Record<WindowKind, boolean>;
  ratios: { main: number; evidence: number };
  expanded: WindowKind | null;
}
export const windowKinds: WindowKind[] = ["main", "evidence", "artifact"];
export const defaultRatios = () => ({ main: 0.52, evidence: 0.5 });
export function defaultBounds(area: Bounds): Bounds {
  const width = Math.min(1520, Math.max(1, area.width - 48));
  const height = Math.min(960, Math.max(1, area.height - 48));
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  };
}
export function clampBounds(bounds: Bounds, area: Bounds): Bounds {
  const width = Math.min(area.width, Math.max(900, bounds.width));
  const height = Math.min(area.height, Math.max(600, bounds.height));
  return {
    x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)),
    width,
    height,
  };
}
function isBounds(value: unknown): value is Bounds {
  if (!value || typeof value !== "object") return false;
  const b = value as Bounds;
  return (
    [b.x, b.y, b.width, b.height].every(
      (n) => typeof n === "number" && Number.isInteger(n) && Number.isFinite(n),
    ) &&
    b.width > 0 &&
    b.height > 0
  );
}
export function restoreLayout(
  input: unknown,
  areas: Bounds[],
  fallback: Bounds,
): WindowLayout {
  const result: WindowLayout = {
    version: 2,
    mode: "triple",
    taskId: null,
    bounds: defaultBounds(fallback),
    collapsed: { main: false, evidence: false, artifact: false },
    ratios: defaultRatios(),
    expanded: null,
  };
  if (!input || typeof input !== "object") return result;
  const raw = input as Partial<WindowLayout>;
  if (
    typeof raw.taskId === "string" &&
    raw.taskId.length > 0 &&
    raw.taskId.length <= 100
  )
    result.taskId = raw.taskId;
  // Legacy geometry describes three separate OS windows. Migrate the selection only;
  // the new workspace starts with a single full-sized container and all three panes.
  if (raw.version !== 2) return result;
  if (raw.mode === "single" || raw.mode === "triple") result.mode = raw.mode;
  if (isBounds(raw.bounds)) {
    const b = raw.bounds;
    const area =
      areas.find(
        (a) =>
          b.x >= a.x &&
          b.x < a.x + a.width &&
          b.y >= a.y &&
          b.y < a.y + a.height,
      ) ?? fallback;
    result.bounds = clampBounds(b, area);
  }
  for (const kind of windowKinds)
    if (typeof raw.collapsed?.[kind] === "boolean")
      result.collapsed[kind] = raw.collapsed[kind];
  for (const key of ["main", "evidence"] as const) {
    const value = raw.ratios?.[key];
    if (typeof value === "number" && Number.isFinite(value))
      result.ratios[key] = Math.min(0.8, Math.max(0.2, value));
  }
  if (raw.expanded && windowKinds.includes(raw.expanded)) {
    result.expanded = raw.expanded;
    result.collapsed[raw.expanded] = false;
    if (raw.expanded !== "main") result.mode = "triple";
  }
  return result;
}
