import {
  useEffect,
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  Maximize2,
  Minimize2,
  Minus,
} from "lucide-react";
import type { DesktopState, WindowKind } from "../shared/types";
import type { Dispatch } from "./common";
import { RightModeControls } from "./WindowControls";

export const PANEL_NAMES: Record<WindowKind, string> = {
  main: "决策与讨论",
  evidence: "Agent 过程与资料",
  artifact: "成果工作区",
};
const DEFAULT_RATIOS = { main: 0.52, evidence: 0.5 };
const clamp = (value: number) => Math.max(0.2, Math.min(0.8, value));
type Ratios = { main: number; evidence: number };
type Drag = {
  axis: "main" | "evidence";
  pointerId: number;
  start: number;
  size: number;
  initial: Ratios;
  target: HTMLDivElement;
};
export function WorkspacePanels({
  desktop,
  dispatch,
  decision,
  evidence,
  artifact,
  hidden = false,
  focusRequest,
}: {
  desktop?: DesktopState;
  dispatch: Dispatch;
  decision: ReactNode;
  evidence: ReactNode;
  artifact: ReactNode;
  hidden?: boolean;
  focusRequest?: { panel: WindowKind; sequence: number };
}) {
  const [ratios, setRatios] = useState<Ratios>(
    () => desktop?.ratios ?? DEFAULT_RATIOS,
  );
  const ratiosRef = useRef(ratios);
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState<"main" | "evidence" | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const right = useRef<HTMLDivElement>(null);
  const rightToolbar = useRef<HTMLDivElement>(null);
  const collapsed = desktop?.collapsed ?? {
    main: false,
    evidence: false,
    artifact: false,
  };
  const expanded = desktop?.expanded ?? null;
  const single = desktop?.mode === "single";
  const rightHidden = single || expanded === "main";
  const mainHidden = expanded === "evidence" || expanded === "artifact";
  const rightMode = desktop?.rightMode ?? "split";
  const evidenceHidden = expanded
    ? expanded === "artifact"
    : rightMode === "artifact";
  const artifactHidden = expanded
    ? expanded === "evidence"
    : rightMode === "evidence";
  const rightRail =
    !expanded &&
    (rightMode === "split"
      ? collapsed.evidence && collapsed.artifact
      : collapsed[rightMode]);
  useEffect(() => {
    if (drag.current) return;
    const next = {
      main: clamp(desktop?.ratios?.main ?? DEFAULT_RATIOS.main),
      evidence: clamp(desktop?.ratios?.evidence ?? DEFAULT_RATIOS.evidence),
    };
    ratiosRef.current = next;
    setRatios(next);
  }, [desktop?.ratios?.main, desktop?.ratios?.evidence]);
  useEffect(() => {
    if (!focusRequest || hidden) return;
    container.current
      ?.querySelector<HTMLElement>(`[data-panel="${focusRequest.panel}"]`)
      ?.focus({ preventScroll: true });
  }, [focusRequest?.sequence, focusRequest?.panel, hidden]);
  const finishDrag = useCallback(
    (cancel = false, pointerId?: number) => {
      const current = drag.current;
      if (
        !current ||
        (pointerId !== undefined && current.pointerId !== pointerId)
      )
        return;
      drag.current = null;
      setDragging(null);
      if (current.target.hasPointerCapture?.(current.pointerId))
        current.target.releasePointerCapture(current.pointerId);
      if (cancel) {
        ratiosRef.current = current.initial;
        setRatios(current.initial);
      } else {
        void dispatch({ type: "window.resize", ...ratiosRef.current });
      }
    },
    [dispatch],
  );
  useEffect(() => {
    const current = drag.current;
    if (!current) return;
    const disabled =
      hidden ||
      rightHidden ||
      mainHidden ||
      (current.axis === "main"
        ? collapsed.main || rightRail
        : evidenceHidden ||
          artifactHidden ||
          collapsed.evidence ||
          collapsed.artifact);
    if (!disabled) return;
    finishDrag(true);
    const saved = {
      main: clamp(desktop?.ratios?.main ?? DEFAULT_RATIOS.main),
      evidence: clamp(desktop?.ratios?.evidence ?? DEFAULT_RATIOS.evidence),
    };
    ratiosRef.current = saved;
    setRatios(saved);
  }, [
    hidden,
    rightHidden,
    mainHidden,
    rightRail,
    evidenceHidden,
    artifactHidden,
    collapsed.main,
    collapsed.evidence,
    collapsed.artifact,
    finishDrag,
    desktop?.ratios?.main,
    desktop?.ratios?.evidence,
  ]);
  useEffect(() => {
    const pointerUp = (event: globalThis.PointerEvent) =>
      finishDrag(false, event.pointerId);
    const pointerCancel = (event: globalThis.PointerEvent) =>
      finishDrag(true, event.pointerId);
    const mouseUp = () => finishDrag(false);
    const blur = () => finishDrag(true);
    // Native drag automation and release outside a divider may bypass React's target handler.
    // The shared drag ref makes pointerup + mouseup + lostcapture settle exactly once.
    window.addEventListener("pointerup", pointerUp, true);
    window.addEventListener("pointercancel", pointerCancel, true);
    window.addEventListener("mouseup", mouseUp, true);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("pointerup", pointerUp, true);
      window.removeEventListener("pointercancel", pointerCancel, true);
      window.removeEventListener("mouseup", mouseUp, true);
      window.removeEventListener("blur", blur);
    };
  }, [finishDrag]);
  const update = (next: Ratios) => {
    ratiosRef.current = next;
    setRatios(next);
  };
  const persist = (next: Ratios) => {
    update(next);
    void dispatch({ type: "window.resize", ...next });
  };
  const beginDrag = (
    axis: "main" | "evidence",
    event: PointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0) return;
    const bounds = (
      axis === "main" ? container.current : right.current
    )?.getBoundingClientRect();
    if (!bounds) return;
    const toolbarHeight =
      axis === "evidence"
        ? (rightToolbar.current?.getBoundingClientRect().height ?? 0)
        : 0;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = {
      axis,
      pointerId: event.pointerId,
      start: axis === "main" ? bounds.left : bounds.top + toolbarHeight,
      size: axis === "main" ? bounds.width : bounds.height - toolbarHeight,
      initial: ratiosRef.current,
      target: event.currentTarget,
    };
    setDragging(axis);
  };
  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId || current.size <= 0)
      return;
    const position = current.axis === "main" ? event.clientX : event.clientY;
    update({
      ...ratiosRef.current,
      [current.axis]: clamp((position - current.start) / current.size),
    });
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>, cancel = false) => {
    finishDrag(cancel, event.pointerId);
  };
  const resizeWithKeyboard = (
    axis: "main" | "evidence",
    event: KeyboardEvent<HTMLDivElement>,
  ) => {
    const decrease = axis === "main" ? "ArrowLeft" : "ArrowUp";
    const increase = axis === "main" ? "ArrowRight" : "ArrowDown";
    let value = ratiosRef.current[axis];
    if (event.key === decrease) value -= event.shiftKey ? 0.1 : 0.02;
    else if (event.key === increase) value += event.shiftKey ? 0.1 : 0.02;
    else if (event.key === "Home") value = 0.2;
    else if (event.key === "End") value = 0.8;
    else return;
    event.preventDefault();
    persist({ ...ratiosRef.current, [axis]: clamp(value) });
  };
  const split = (axis: "main" | "evidence", inactive: boolean) => (
    <div
      className={`workspace-divider divider-${axis} ${inactive ? "divider-hidden" : ""}`}
      role="separator"
      aria-label={
        axis === "main" ? "调整决策与右侧面板宽度" : "调整过程与成果面板高度"
      }
      aria-orientation={axis === "main" ? "vertical" : "horizontal"}
      aria-valuemin={20}
      aria-valuemax={80}
      aria-valuenow={Math.round(ratios[axis] * 100)}
      aria-valuetext={`${axis === "main" ? "决策宽度" : "过程高度"} ${Math.round(ratios[axis] * 100)}%`}
      aria-controls={
        axis === "main"
          ? "workspace-main workspace-right"
          : "workspace-evidence workspace-artifact"
      }
      tabIndex={inactive ? -1 : 0}
      aria-hidden={inactive}
      onPointerDown={(event) => {
        if (!inactive) beginDrag(axis, event);
      }}
      onPointerMove={moveDrag}
      onPointerUp={(event) => endDrag(event)}
      onPointerCancel={(event) => endDrag(event, true)}
      onLostPointerCapture={(event) => endDrag(event, true)}
      onKeyDown={(event) => {
        if (!inactive) resizeWithKeyboard(axis, event);
      }}
      onDoubleClick={() =>
        !inactive &&
        persist({ ...ratiosRef.current, [axis]: DEFAULT_RATIOS[axis] })
      }
    >
      <span />
    </div>
  );
  const panel = (kind: WindowKind, content: ReactNode, isHidden = false) => (
    <section
      id={`workspace-${kind}`}
      data-panel={kind}
      tabIndex={-1}
      className={`workspace-panel pane-${kind} ${collapsed[kind] && !expanded ? "panel-collapsed" : ""} ${isHidden ? "panel-hidden" : ""} ${expanded === kind ? "panel-expanded" : ""}`}
      aria-label={PANEL_NAMES[kind]}
    >
      <header className="workspace-panel-header">
        <h2 className="pane-title">
          <span className={`panel-index index-${kind}`} />
          {PANEL_NAMES[kind]}
        </h2>
        <div className="panel-actions">
          <button
            className="icon-button"
            aria-label={
              expanded === kind
                ? `还原${PANEL_NAMES[kind]}`
                : `最大化${PANEL_NAMES[kind]}`
            }
            title={expanded === kind ? "还原面板" : "最大化面板"}
            aria-pressed={expanded === kind}
            onClick={() =>
              void dispatch({
                type: "window.expand",
                window: expanded === kind ? null : kind,
              })
            }
          >
            {expanded === kind ? (
              <Minimize2 size={13} />
            ) : (
              <Maximize2 size={13} />
            )}
          </button>
          <button
            className="icon-button"
            aria-label={`${collapsed[kind] && !expanded ? "展开" : "折叠"}${PANEL_NAMES[kind]}`}
            title={collapsed[kind] && !expanded ? "展开面板" : "折叠面板"}
            aria-expanded={!collapsed[kind] || expanded === kind}
            aria-controls={`panel-body-${kind}`}
            onClick={() =>
              void dispatch({
                type: "window.collapse",
                window: kind,
                collapsed: !(collapsed[kind] && !expanded),
              })
            }
          >
            {collapsed[kind] && !expanded ? (
              kind === "main" || rightRail ? (
                <ChevronRight size={14} />
              ) : (
                <ChevronDown size={14} />
              )
            ) : (
              <Minus size={14} />
            )}
          </button>
        </div>
      </header>
      <div className="workspace-panel-body" id={`panel-body-${kind}`}>
        {content}
      </div>
    </section>
  );
  const columns = rightHidden
    ? "minmax(0,1fr) 0px 0px"
    : mainHidden
      ? "0px 0px minmax(0,1fr)"
      : collapsed.main
        ? "44px 6px minmax(0,1fr)"
        : rightRail
          ? "minmax(0,1fr) 6px 44px"
          : `minmax(0,${ratios.main}fr) 7px minmax(0,${1 - ratios.main}fr)`;
  const rows = evidenceHidden
    ? "0px 0px minmax(0,1fr)"
    : artifactHidden
      ? "minmax(0,1fr) 0px 0px"
      : rightRail
        ? "minmax(0,1fr) 6px minmax(0,1fr)"
        : collapsed.evidence
          ? "38px 6px minmax(0,1fr)"
          : collapsed.artifact
            ? "minmax(0,1fr) 6px 38px"
            : `minmax(0,${ratios.evidence}fr) 7px minmax(0,${1 - ratios.evidence}fr)`;
  return (
    <div
      ref={container}
      className={`workspace-panels ${hidden ? "workspace-hidden" : ""} ${dragging ? `workspace-resizing resizing-${dragging}` : ""} ${expanded ? "has-expanded-panel" : ""}`}
      style={{ gridTemplateColumns: columns } as CSSProperties}
      data-mode={single ? "single" : "triple"}
      data-right-mode={rightMode}
    >
      {panel("main", decision, mainHidden)}
      {split("main", rightHidden || mainHidden || collapsed.main || rightRail)}
      <div
        id="workspace-right"
        ref={right}
        className={`workspace-right ${rightHidden ? "panel-hidden" : ""} ${rightRail ? "right-rail" : ""}`}
      >
        <div
          ref={rightToolbar}
          className={`right-pane-toolbar ${expanded || rightRail ? "right-toolbar-hidden" : ""}`}
        >
          <span>右侧工作区</span>
          <RightModeControls desktop={desktop} dispatch={dispatch} />
        </div>
        <div
          className="workspace-right-content"
          style={{ gridTemplateRows: rows }}
        >
          {panel("evidence", evidence, evidenceHidden)}
          {split(
            "evidence",
            evidenceHidden ||
              artifactHidden ||
              collapsed.evidence ||
              collapsed.artifact,
          )}
          {panel("artifact", artifact, artifactHidden)}
        </div>
      </div>
      {dragging ? <div className="resize-shield" aria-hidden="true" /> : null}
    </div>
  );
}
