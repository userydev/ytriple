import type { DesktopState, WindowKind } from "../shared/types.js";

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface WindowLayout {
  mode: DesktopState["mode"];
  taskId: string | null;
  bounds: Record<WindowKind, Bounds>;
  collapsed: Record<WindowKind, boolean>;
}
export const windowKinds: WindowKind[] = ["main", "evidence", "artifact"];
export const foldedHeight = 96;
export function tileWindows(area: Bounds): Record<WindowKind, Bounds> {
  const gap = 8;
  const width = Math.max(1, area.width - gap * 2);
  const height = Math.max(1, area.height - gap * 2);
  const left = Math.round((width - gap) * 0.52);
  const top = Math.floor((height - gap) / 2);
  const x = area.x + gap,
    y = area.y + gap;
  return {
    main: { x, y, width: left, height },
    evidence: { x: x + left + gap, y, width: width - left - gap, height: top },
    artifact: {
      x: x + left + gap,
      y: y + top + gap,
      width: width - left - gap,
      height: height - top - gap,
    },
  };
}
export function clampBounds(bounds: Bounds, area: Bounds): Bounds {
  const width = Math.min(area.width, Math.max(300, bounds.width));
  const height = Math.min(area.height, Math.max(220, bounds.height));
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
      (n) => typeof n === "number" && Number.isFinite(n) && Number.isInteger(n),
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
    mode: "triple",
    taskId: null,
    bounds: tileWindows(fallback),
    collapsed: { main: false, evidence: false, artifact: false },
  };
  if (!input || typeof input !== "object") return result;
  const raw = input as Partial<WindowLayout>;
  if (raw.mode === "single" || raw.mode === "triple") result.mode = raw.mode;
  if (typeof raw.taskId === "string" && raw.taskId.length < 101)
    result.taskId = raw.taskId;
  for (const kind of windowKinds) {
    const b = raw.bounds?.[kind];
    if (isBounds(b)) {
      const area =
        areas.find(
          (a) =>
            b.x >= a.x &&
            b.x < a.x + a.width &&
            b.y >= a.y &&
            b.y < a.y + a.height,
        ) ?? fallback;
      result.bounds[kind] = clampBounds(b, area);
    }
    if (typeof raw.collapsed?.[kind] === "boolean")
      result.collapsed[kind] = raw.collapsed[kind];
  }
  return result;
}
