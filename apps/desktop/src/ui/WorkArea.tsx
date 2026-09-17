import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  PanelsTopLeft,
  Maximize2,
  Minimize2,
  GripVertical,
  ArrowLeft,
  ArrowRight,
  RotateCcw,
} from "lucide-react";
import {
  defaultLayout,
  reorder,
  resizePair,
  surfaces,
  type Surface,
  type Layout,
  type WorkView,
} from "../core/view";
import { IconButton } from "./Composer";
const titles: Record<Surface, string> = {
  decision: "决策",
  process: "过程",
  result: "结果",
};
const modes = {
  split: "左右双区",
  mixed: "一主两辅",
  columns: "三面横排",
  rows: "三面竖排",
} as const;
export function WorkArea({
  view,
  layout,
  onView,
  onLayout,
  onScroll,
  children,
}: {
  view: WorkView;
  layout: Layout;
  onView: (patch: Partial<WorkView>) => void;
  onLayout: (value: Layout) => void;
  onScroll: (key: string, top: number) => void;
  children: Record<Surface, ReactNode>;
}) {
  const root = useRef<HTMLDivElement>(null),
    menuRef = useRef<HTMLDivElement>(null),
    dragged = useRef<Surface | null>(null),
    restoring = useRef(false);
  const [menu, setMenu] = useState(false),
    [available, setAvailable] = useState({ width: 0, height: 0 });
  const resizing = useRef<{
    kind: "split" | "stacked" | "first" | "second";
    axis: "x" | "y";
  } | null>(null);
  const current = useRef({ layout, onLayout });
  current.current = { layout, onLayout };
  useEffect(() => {
    const movePointer = (e: PointerEvent) => {
      const active = resizing.current,
        el = root.current;
      if (!active || !el) return;
      const rect = el.getBoundingClientRect();
      resize(
        active.kind,
        active.axis === "x"
          ? ((e.clientX - rect.left) / rect.width) * 100
          : ((e.clientY - rect.top) / rect.height) * 100,
      );
    };
    const endPointer = (e: PointerEvent) => {
      const from = dragged.current;
      dragged.current = null;
      resizing.current = null;
      const target = document
        .elementFromPoint(e.clientX, e.clientY)
        ?.closest<HTMLElement>("[data-surface]")?.dataset.surface as
        Surface | undefined;
      if (from && target && from !== target) {
        const latest = current.current;
        latest.onLayout({
          ...latest.layout,
          order: reorder(latest.layout.order, from, target),
        });
      }
    };
    const cancel = () => {
      dragged.current = null;
      resizing.current = null;
    };
    window.addEventListener("pointermove", movePointer);
    window.addEventListener("pointerup", endPointer);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("pointermove", movePointer);
      window.removeEventListener("pointerup", endPointer);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
    };
  }, []);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const observer = new ResizeObserver(() =>
      setAvailable({ width: el.clientWidth, height: el.clientHeight }),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const decisionIndex = layout.order.indexOf("decision");
  const decisionFraction =
    layout.mode === "rows"
      ? layout.sizes[decisionIndex] / 100
      : layout.mode === "mixed" && decisionIndex > 0
        ? (decisionIndex === 1 ? layout.stacked : 100 - layout.stacked) / 100
        : 1;
  const compact =
    available.width > 0 &&
    (available.width < 900 || available.height * decisionFraction < 220);
  const solo = view.focused ?? (compact ? view.surface : null);
  const rightSurface = view.surface === "result" ? "result" : "process";
  const signature =
    layout.mode + layout.order.join(",") + String(solo) + view.surface;
  useLayoutEffect(() => {
    restoring.current = true;
    for (const name of surfaces) {
      const node = root.current?.querySelector<HTMLElement>(
        `[data-surface="${name}"] ${name === "decision" ? ".conversation" : "." + name + "-pane"}`,
      );
      if (node?.clientHeight) {
        const key =
          name === "result" ? `result:${view.versionId ?? "latest"}` : name;
        node.scrollTop = view.scroll[key] ?? 0;
      }
    }
    const frame = requestAnimationFrame(() => {
      restoring.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [view.id, signature, view.versionId]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menu]);
  function move(from: Surface, to: Surface) {
    onLayout({ ...layout, order: reorder(layout.order, from, to) });
  }
  function resize(
    kind: "split" | "stacked" | "first" | "second",
    value: number,
  ) {
    const valueLayout = current.current.layout;
    current.current.onLayout(
      kind === "split"
        ? { ...valueLayout, split: Math.max(25, Math.min(65, value)) }
        : kind === "stacked"
          ? { ...valueLayout, stacked: Math.max(20, Math.min(80, value)) }
          : {
              ...valueLayout,
              sizes: resizePair(
                valueLayout.sizes,
                kind === "first" ? 0 : 1,
                value,
              ),
            },
    );
  }
  function handle(
    kind: "split" | "stacked" | "first" | "second",
    axis: "x" | "y",
    position: number,
    extra: CSSProperties = {},
  ) {
    return (
      <div
        key={kind}
        role="separator"
        tabIndex={0}
        aria-label={
          kind === "stacked" ? "调整上下工作面比例" : "调整工作面比例"
        }
        aria-orientation={axis === "x" ? "vertical" : "horizontal"}
        aria-valuemin={20}
        aria-valuemax={80}
        aria-valuenow={Math.round(position)}
        className={`pane-resizer ${axis}`}
        style={{ [axis === "x" ? "left" : "top"]: `${position}%`, ...extra }}
        onKeyDown={(e) => {
          const negative = axis === "x" ? "ArrowLeft" : "ArrowUp",
            positive = axis === "x" ? "ArrowRight" : "ArrowDown";
          if (e.key === negative || e.key === positive) {
            e.preventDefault();
            resize(kind, position + (e.key === negative ? -2 : 2));
          }
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.focus();
          resizing.current = { kind, axis };
        }}
      />
    );
  }
  function placement(name: Surface): CSSProperties {
    if (solo)
      return {
        gridColumn: "1",
        gridRow: "1",
        display: name === solo ? "flex" : "none",
      };
    if (layout.mode === "split")
      return name === "decision"
        ? { gridColumn: 1, gridRow: 1 }
        : {
            gridColumn: 2,
            gridRow: 1,
            display: name === rightSurface ? "flex" : "none",
          };
    const i = layout.order.indexOf(name);
    if (layout.mode === "columns") return { gridColumn: i + 1, gridRow: 1 };
    if (layout.mode === "rows") return { gridColumn: 1, gridRow: i + 1 };
    return i === 0
      ? { gridColumn: 1, gridRow: "1 / 3" }
      : { gridColumn: 2, gridRow: i };
  }
  const style: CSSProperties = solo
    ? { gridTemplateColumns: "1fr", gridTemplateRows: "minmax(0,1fr)" }
    : layout.mode === "split"
      ? {
          gridTemplateColumns: `minmax(0,${layout.split}fr) minmax(0,${100 - layout.split}fr)`,
          gridTemplateRows: "minmax(0,1fr)",
        }
      : layout.mode === "columns"
        ? {
            gridTemplateColumns: layout.sizes
              .map((n) => `minmax(0,${n}fr)`)
              .join(" "),
            gridTemplateRows: "minmax(0,1fr)",
          }
        : layout.mode === "rows"
          ? {
              gridTemplateColumns: "1fr",
              gridTemplateRows: layout.sizes
                .map((n) => `minmax(0,${n}fr)`)
                .join(" "),
            }
          : {
              gridTemplateColumns: `minmax(0,${layout.split}fr) minmax(0,${100 - layout.split}fr)`,
              gridTemplateRows: `minmax(0,${layout.stacked}fr) minmax(0,${100 - layout.stacked}fr)`,
            };
  return (
    <div className="work-area">
      <div className="area-toolbar">
        <div
          className="surface-switcher"
          title={compact ? "空间不足时单面显示，放大窗口可恢复布局" : undefined}
        >
          {solo ? (
            surfaces.map((name) => (
              <button
                key={name}
                aria-pressed={name === solo}
                onClick={() =>
                  onView({
                    surface: name,
                    ...(view.focused ? { focused: name } : {}),
                  })
                }
              >
                {titles[name]}
              </button>
            ))
          ) : (
            <span className="muted">{modes[layout.mode]}</span>
          )}
        </div>
        <div className="layout-menu-anchor" ref={menuRef}>
          <IconButton
            label="工作区布局"
            aria-expanded={menu}
            onClick={() => setMenu((v) => !v)}
          >
            <PanelsTopLeft size={18} />
          </IconButton>
          {view.focused ? (
            <IconButton
              label="还原工作区"
              onClick={() => onView({ focused: null })}
            >
              <Minimize2 size={18} />
            </IconButton>
          ) : null}
          {menu ? (
            <div
              className="layout-menu"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setMenu(false);
                  menuRef.current
                    ?.querySelector<HTMLElement>("button")
                    ?.focus();
                }
              }}
            >
              {(Object.keys(modes) as Layout["mode"][]).map((mode) => (
                <button
                  key={mode}
                  aria-pressed={layout.mode === mode}
                  onClick={() => {
                    onLayout({ ...layout, mode });
                    onView({ focused: null });
                    setMenu(false);
                  }}
                >
                  {modes[mode]}
                </button>
              ))}
              <button
                onClick={() => {
                  onLayout(structuredClone(defaultLayout));
                  onView({ focused: null });
                  setMenu(false);
                }}
              >
                <RotateCcw size={15} />
                恢复默认布局
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <div
        className="work-area-grid"
        ref={root}
        style={style}
        onScrollCapture={(e) => {
          if (
            restoring.current ||
            !(e.target instanceof HTMLElement) ||
            !e.target.clientHeight ||
            !e.target.matches(".conversation,.process-pane,.result-pane")
          )
            return;
          const name = e.target.closest<HTMLElement>("[data-surface]")?.dataset
            .surface as Surface;
          onScroll(
            name === "result" ? `result:${view.versionId ?? "latest"}` : name,
            e.target.scrollTop,
          );
        }}
      >
        {(layout.mode === "split" ? surfaces : layout.order).map((name) => (
          <section
            key={name}
            data-surface={name}
            className="surface-frame"
            style={placement(name)}
            aria-label={`${titles[name]}工作面`}
            onDragOver={(e) => {
              if (dragged.current) e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragged.current && layout.mode !== "split")
                move(dragged.current, name);
              dragged.current = null;
            }}
          >
            <header
              className="surface-heading"
              data-draggable={!solo && layout.mode !== "split"}
              onPointerDown={(e) => {
                if (
                  solo ||
                  layout.mode === "split" ||
                  e.button !== 0 ||
                  (e.target as HTMLElement).closest("button")
                )
                  return;
                e.preventDefault();
                dragged.current = name;
              }}
            >
              {layout.mode === "split" && name !== "decision" && !solo ? (
                <div className="surface-switcher">
                  {(["process", "result"] as const).map((s) => (
                    <button
                      key={s}
                      aria-pressed={rightSurface === s}
                      onClick={() => onView({ surface: s })}
                    >
                      {titles[s]}
                    </button>
                  ))}
                </div>
              ) : (
                <strong>
                  {!solo && layout.mode !== "split" ? (
                    <GripVertical size={14} />
                  ) : null}
                  {titles[name]}
                </strong>
              )}
              <div className="tool-group">
                {!solo && layout.mode !== "split" ? (
                  <>
                    <IconButton
                      label={`前移${titles[name]}工作面`}
                      disabled={layout.order.indexOf(name) === 0}
                      onClick={() =>
                        move(name, layout.order[layout.order.indexOf(name) - 1])
                      }
                    >
                      <ArrowLeft size={14} />
                    </IconButton>
                    <IconButton
                      label={`后移${titles[name]}工作面`}
                      disabled={layout.order.indexOf(name) === 2}
                      onClick={() =>
                        move(name, layout.order[layout.order.indexOf(name) + 1])
                      }
                    >
                      <ArrowRight size={14} />
                    </IconButton>
                  </>
                ) : null}
                <IconButton
                  label={
                    view.focused === name ? "还原工作区" : `聚焦${titles[name]}`
                  }
                  onClick={() =>
                    onView({
                      focused: view.focused === name ? null : name,
                      surface: name === "decision" ? view.surface : name,
                    })
                  }
                >
                  {view.focused === name ? (
                    <Minimize2 size={15} />
                  ) : (
                    <Maximize2 size={15} />
                  )}
                </IconButton>
              </div>
            </header>
            <div className="surface-content">{children[name]}</div>
          </section>
        ))}
        {!solo ? (
          layout.mode === "split" ? (
            handle("split", "x", layout.split)
          ) : layout.mode === "mixed" ? (
            <>
              {handle("split", "x", layout.split)}
              {handle("stacked", "y", layout.stacked, {
                left: `${layout.split}%`,
                width: `${100 - layout.split}%`,
              })}
            </>
          ) : (
            <>
              {handle(
                "first",
                layout.mode === "rows" ? "y" : "x",
                layout.sizes[0],
              )}
              {handle(
                "second",
                layout.mode === "rows" ? "y" : "x",
                layout.sizes[0] + layout.sizes[1],
              )}
            </>
          )
        ) : null}
      </div>
    </div>
  );
}
