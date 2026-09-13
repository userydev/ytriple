import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  Columns2,
  LayoutPanelLeft,
  Maximize2,
  Minimize2,
  Rows2,
} from "lucide-react";
import type { DesktopState, WindowKind } from "../shared/types";
import type { Dispatch } from "./common";

export type WorkContext =
  "artifact" | "sources" | "process" | "project" | "files";
const clamp = (ratio: number) => Math.max(0.3, Math.min(0.65, ratio));
type Layout = "split" | "evidence" | "artifact";

/** One work context, three independently readable and focusable surfaces. */
export function WorkSurface({
  desktop,
  dispatch,
  hidden,
  decision,
  artifact,
  sources,
  process,
  project,
  files,
  context,
  onContext,
  sourceCount,
  focusRequest,
}: {
  desktop?: DesktopState;
  dispatch: Dispatch;
  hidden: boolean;
  decision: ReactNode;
  artifact: ReactNode;
  sources: ReactNode;
  process: ReactNode;
  project?: ReactNode;
  files?: ReactNode;
  context: WorkContext;
  onContext: (value: WorkContext) => void;
  sourceCount: number;
  focusRequest?: { panel: WindowKind; sequence: number };
}) {
  const root = useRef<HTMLDivElement>(null);
  const side = useRef<HTMLDivElement>(null);
  const [ratios, setRatios] = useState(() => ({
    main: clamp(desktop?.ratios?.main ?? 0.43),
    evidence: clamp(desktop?.ratios?.evidence ?? 0.46),
  }));
  const ratiosRef = useRef(ratios);
  const [layout, setLayout] = useState<Layout>(desktop?.rightMode ?? "split");
  const [focused, setFocused] = useState<WindowKind | null>(
    desktop?.expanded ?? null,
  );
  const [mobile, setMobile] = useState<WindowKind>("main");
  const [dragging, setDragging] = useState(false);
  const [layoutChosen, setLayoutChosen] = useState(false);
  const drag = useRef<{
    target: HTMLDivElement;
    pointerId: number;
    start: number;
    size: number;
    axis: "main" | "evidence";
    initial: typeof ratios;
  } | null>(null);
  const finish = useCallback(
    (cancel = false) => {
      const current = drag.current;
      if (!current) return;
      drag.current = null;
      setDragging(false);
      if (current.target.hasPointerCapture?.(current.pointerId))
        current.target.releasePointerCapture(current.pointerId);
      if (cancel) {
        setRatios(current.initial);
        ratiosRef.current = current.initial;
      } else void dispatch({ type: "window.resize", ...ratiosRef.current });
    },
    [dispatch],
  );
  useEffect(() => {
    const cancel = () => finish(true);
    const release = (event: PointerEvent) => {
      if (drag.current?.pointerId === event.pointerId) finish();
    };
    const releaseMouse = () => finish();
    window.addEventListener("blur", cancel);
    window.addEventListener("pointerup", release);
    window.addEventListener("mouseup", releaseMouse);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("blur", cancel);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("mouseup", releaseMouse);
      window.removeEventListener("pointercancel", cancel);
    };
  }, [finish]);
  useEffect(() => {
    if (hidden || focused) finish(true);
  }, [hidden, focused, finish]);
  useEffect(() => {
    if (!drag.current && desktop?.ratios) {
      const next = {
        main: clamp(desktop.ratios.main),
        evidence: clamp(desktop.ratios.evidence),
      };
      setRatios(next);
      ratiosRef.current = next;
    }
  }, [desktop?.ratios?.main, desktop?.ratios?.evidence]);
  useEffect(() => {
    if (desktop?.rightMode) setLayout(desktop.rightMode);
  }, [desktop?.rightMode]);
  useEffect(() => {
    setFocused(desktop?.expanded ?? null);
  }, [desktop?.expanded]);
  const focus = (panel: WindowKind | null) => {
    setFocused(panel);
    void dispatch({ type: "window.expand", window: panel });
  };
  const chooseLayout = (next: Layout) => {
    finish(true);
    setLayoutChosen(true);
    setLayout(next);
    focus(null);
    void dispatch({ type: "window.rightMode", mode: next });
  };
  const previousContext = useRef(context);
  useEffect(() => {
    if (previousContext.current === context) return;
    previousContext.current = context;
    if (context === "process") {
      setMobile("evidence");
      setLayout((current) => (current === "artifact" ? "split" : current));
    } else {
      setMobile("artifact");
      setLayout((current) => (current === "evidence" ? "split" : current));
    }
  }, [context]);
  useEffect(() => {
    if (!focusRequest?.sequence || hidden) return;
    setFocused(null);
    setMobile(focusRequest.panel);
    if (focusRequest.panel !== "main")
      setLayout((current) =>
        current === "split" || current === focusRequest.panel
          ? current
          : "split",
      );
    const timer = window.setTimeout(() => {
      const panel = root.current?.querySelector<HTMLElement>(
        `[data-panel="${focusRequest.panel}"]`,
      );
      const target =
        focusRequest.panel === "main"
          ? (panel?.querySelector<HTMLElement>("textarea:not([disabled])") ??
            panel)
          : panel;
      target?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [focusRequest?.sequence, hidden]);
  const visibleLayout =
    !process && !layoutChosen && layout === "split" ? "artifact" : layout;
  const content =
    context === "process" ? (project ? "project" : "artifact") : context;
  const tabs: [WorkContext, string][] = [
    ...(project
      ? ([
          ["project", "项目状态"],
          ["files", "文件"],
        ] as [WorkContext, string][])
      : []),
    ["artifact", "成果"],
    ["sources", `资料${sourceCount ? ` · ${sourceCount}` : ""}`],
  ];
  const maximize = (panel: WindowKind, label: string) => (
    <button
      className="icon-button"
      aria-label={focused === panel ? "恢复并排工作" : label}
      title={focused === panel ? "恢复并排工作（Esc）" : label}
      onClick={() => focus(focused === panel ? null : panel)}
    >
      {focused === panel ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
    </button>
  );
  const divider = (axis: "main" | "evidence") => (
    <div
      className={`work-divider divider-${axis}`}
      role="separator"
      tabIndex={0}
      aria-label={axis === "main" ? "调整交流与内容宽度" : "调整分析与成果高度"}
      aria-orientation={axis === "main" ? "vertical" : "horizontal"}
      aria-valuemin={30}
      aria-valuemax={65}
      aria-valuenow={Math.round(ratios[axis] * 100)}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          finish(true);
          return;
        }
        const previous = axis === "main" ? "ArrowLeft" : "ArrowUp",
          next = axis === "main" ? "ArrowRight" : "ArrowDown";
        if (![previous, next, "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const value = {
          ...ratiosRef.current,
          [axis]: clamp(
            event.key === "Home"
              ? 0.3
              : event.key === "End"
                ? 0.65
                : ratiosRef.current[axis] +
                  (event.key === previous ? -0.03 : 0.03),
          ),
        };
        setRatios(value);
        ratiosRef.current = value;
        void dispatch({ type: "window.resize", ...value });
      }}
      onDoubleClick={() => {
        const value = {
          ...ratiosRef.current,
          [axis]: axis === "main" ? 0.43 : 0.46,
        };
        setRatios(value);
        ratiosRef.current = value;
        void dispatch({ type: "window.resize", ...value });
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const rect = (
          axis === "main" ? root.current : side.current
        )?.getBoundingClientRect();
        if (!rect) return;
        drag.current = {
          target: event.currentTarget,
          pointerId: event.pointerId,
          axis,
          start: axis === "main" ? rect.left : rect.top,
          size: axis === "main" ? rect.width : rect.height,
          initial: ratiosRef.current,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
        event.preventDefault();
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current || current.pointerId !== event.pointerId) return;
        const value = {
          ...ratiosRef.current,
          [axis]: clamp(
            ((axis === "main" ? event.clientX : event.clientY) -
              current.start) /
              current.size,
          ),
        };
        ratiosRef.current = value;
        setRatios(value);
      }}
      onPointerUp={() => finish()}
      onPointerCancel={() => finish(true)}
      onLostPointerCapture={() => finish(true)}
    />
  );
  return (
    <div
      ref={root}
      hidden={hidden}
      className={`work-surface collaboration-surface layout-${visibleLayout} mobile-${mobile} ${focused ? `focus-${focused}` : ""} ${dragging ? "is-resizing" : ""}`}
      style={
        {
          "--discussion-ratio": `${ratios.main * 100}%`,
          "--analysis-ratio": `${ratios.evidence * 100}%`,
        } as CSSProperties
      }
      onKeyDown={(event) => {
        if (event.key === "Escape" && drag.current) {
          event.preventDefault();
          finish(true);
          return;
        }
        if (
          event.key === "Escape" &&
          focused &&
          !document.querySelector('[aria-modal="true"]')
        ) {
          event.preventDefault();
          focus(null);
        }
      }}
    >
      <nav className="collaboration-layout" aria-label="工作区布局">
        <div className="wide-layout-options">
          {(
            [
              ["split", "协作", LayoutPanelLeft],
              ["artifact", "交流与成果", Columns2],
              ["evidence", "交流与分析", Rows2],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              aria-pressed={visibleLayout === id && !focused}
              onClick={() => chooseLayout(id)}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>
        <div className="narrow-layout-options" aria-label="窄窗口工作切换">
          {(
            [
              ["main", "交流"],
              ["evidence", "分析过程"],
              ["artifact", project ? "项目与成果" : "成果与资料"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              aria-pressed={mobile === id}
              onClick={() => {
                setMobile(id);
                setFocused(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {focused ? (
          <button className="restore-layout" onClick={() => focus(null)}>
            <Minimize2 size={14} />
            恢复并排工作
          </button>
        ) : null}
      </nav>
      <section
        className="work-discussion"
        data-panel="main"
        aria-label="交流"
        tabIndex={-1}
      >
        <header className="work-surface-toolbar">
          <span>交流</span>
          {maximize("main", "专注交流")}
        </header>
        {decision}
      </section>
      {divider("main")}
      <div ref={side} className="collaboration-right">
        <section
          className="work-analysis"
          data-panel="evidence"
          aria-label="分析过程"
          tabIndex={-1}
        >
          <header className="work-surface-toolbar">
            <span>分析过程</span>
            {maximize("evidence", "专注分析过程")}
          </header>
          <div className="work-content-body">
            {process ?? (
              <div className="work-empty">
                <p>开始协作后，在这里对照成员的判断、依据与修正。</p>
              </div>
            )}
          </div>
        </section>
        {divider("evidence")}
        <section
          className="work-content"
          data-panel="artifact"
          aria-label="工作内容"
          tabIndex={-1}
        >
          <header className="work-surface-toolbar">
            <nav aria-label="工作内容切换">
              {tabs.map(([id, label]) => (
                <button
                  key={id}
                  className={content === id ? "active" : ""}
                  aria-pressed={content === id}
                  onClick={() => onContext(id)}
                >
                  {label}
                </button>
              ))}
            </nav>
            {maximize("artifact", "专注阅读")}
          </header>
          {(
            [
              ["project", project],
              ["files", files],
              ["artifact", artifact],
              ["sources", sources],
            ] as [WorkContext, ReactNode][]
          ).map(([id, node]) => (
            <div key={id} className="work-content-body" hidden={content !== id}>
              {node}
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
