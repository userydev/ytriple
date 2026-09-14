import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
const storageKey = "ytriple.projects.viewer-width.v1";
const clamp = (value: number) => Math.max(0.35, Math.min(0.8, value));
export function ProjectWorkspace({
  children,
  hidden,
}: {
  children: [ReactNode, ReactNode];
  hidden: boolean;
}) {
  const [ratio, setRatio] = useState(() => {
    try {
      return clamp(Number(window.localStorage.getItem(storageKey)) || 0.65);
    } catch {
      return 0.65;
    }
  });
  const ratioRef = useRef(ratio);
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    left: number;
    width: number;
    initial: number;
    pointerId: number;
    target: HTMLDivElement;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const save = useCallback((value: number) => {
    setRatio(value);
    ratioRef.current = value;
    try {
      window.localStorage.setItem(storageKey, String(value));
    } catch {}
  }, []);
  const finish = useCallback(
    (cancel = false, pointerId?: number) => {
      const current = drag.current;
      if (
        !current ||
        (pointerId !== undefined && current.pointerId !== pointerId)
      )
        return;
      drag.current = null;
      setDragging(false);
      if (current.target.hasPointerCapture?.(current.pointerId))
        current.target.releasePointerCapture(current.pointerId);
      if (cancel) {
        ratioRef.current = current.initial;
        setRatio(current.initial);
      } else save(ratioRef.current);
    },
    [save],
  );
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const current = drag.current;
      if (
        !current ||
        event.pointerId !== current.pointerId ||
        current.width <= 0
      )
        return;
      ratioRef.current = clamp((event.clientX - current.left) / current.width);
      setRatio(ratioRef.current);
    };
    const up = (event: PointerEvent) => finish(false, event.pointerId);
    const mouseup = () => finish();
    const cancel = (event: PointerEvent) => finish(true, event.pointerId);
    const blur = () => finish(true);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("mouseup", mouseup, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("mouseup", mouseup, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("blur", blur);
    };
  }, [finish]);
  useEffect(() => {
    if (hidden) finish(true);
  }, [hidden, finish]);
  return (
    <div
      ref={root}
      className={`projects-layout project-split-layout ${hidden ? "workspace-hidden" : ""}`}
      style={{
        gridTemplateColumns: `minmax(0,${ratio}fr) 7px minmax(0,${1 - ratio}fr)`,
      }}
    >
      {children[0]}
      <div
        className="workspace-divider project-outer-divider"
        role="separator"
        aria-label="调整项目查看区与决策区宽度"
        aria-orientation="vertical"
        aria-valuemin={35}
        aria-valuemax={80}
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuetext={`项目查看区 ${Math.round(ratio * 100)}%，决策区 ${Math.round((1 - ratio) * 100)}%`}
        tabIndex={0}
        onPointerDown={(event) => {
          if (event.button !== 0 || hidden) return;
          const box = root.current?.getBoundingClientRect();
          if (!box || box.width <= 0) return;
          event.currentTarget.focus();
          event.preventDefault();
          drag.current = {
            left: box.left,
            width: box.width,
            initial: ratioRef.current,
            pointerId: event.pointerId,
            target: event.currentTarget,
          };
          event.currentTarget.setPointerCapture?.(event.pointerId);
          setDragging(true);
        }}
        onLostPointerCapture={() => finish(true)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && drag.current) {
            event.preventDefault();
            finish(true);
            return;
          }
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            return;
          event.preventDefault();
          save(
            event.key === "Home"
              ? 0.35
              : event.key === "End"
                ? 0.8
                : clamp(
                    ratioRef.current +
                      (event.key === "ArrowLeft" ? -0.02 : 0.02),
                  ),
          );
        }}
        onDoubleClick={() => save(0.65)}
      >
        <span />
      </div>
      {children[1]}
      {dragging ? <div className="resize-shield" aria-hidden="true" /> : null}
    </div>
  );
}
