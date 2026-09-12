import { useEffect, useRef, useState, type ReactNode } from "react";
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
  ratioRef.current = ratio;
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    left: number;
    width: number;
    initial: number;
    pointerId: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const save = (value: number) => {
    setRatio(value);
    ratioRef.current = value;
    try {
      window.localStorage.setItem(storageKey, String(value));
    } catch {}
  };
  useEffect(() => {
    const finish = (event: PointerEvent) => {
      if (!drag.current || event.pointerId !== drag.current.pointerId) return;
      drag.current = null;
      setDragging(false);
      save(ratioRef.current);
    };
    const cancel = () => {
      if (!drag.current) return;
      const initial = drag.current.initial;
      drag.current = null;
      setRatio(initial);
      setDragging(false);
    };
    window.addEventListener("pointerup", finish);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("blur", cancel);
    };
  }, []);
  useEffect(() => {
    if (hidden && drag.current) {
      setRatio(drag.current.initial);
      drag.current = null;
      setDragging(false);
    }
  }, [hidden]);
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
        tabIndex={0}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.focus();
          const box = root.current!.getBoundingClientRect();
          drag.current = {
            left: box.left,
            width: box.width,
            initial: ratio,
            pointerId: event.pointerId,
          };
          event.currentTarget.setPointerCapture?.(event.pointerId);
          setDragging(true);
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (!current || event.pointerId !== current.pointerId) return;
          const next = clamp((event.clientX - current.left) / current.width);
          setRatio(next);
          ratioRef.current = next;
        }}
        onPointerCancel={() => {
          if (drag.current) {
            setRatio(drag.current.initial);
            drag.current = null;
            setDragging(false);
          }
        }}
        onLostPointerCapture={() => {
          if (drag.current) {
            setRatio(drag.current.initial);
            drag.current = null;
            setDragging(false);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            save(clamp(ratio + (event.key === "ArrowLeft" ? -0.02 : 0.02)));
          } else if (event.key === "Home") {
            event.preventDefault();
            save(0.35);
          } else if (event.key === "End") {
            event.preventDefault();
            save(0.8);
          }
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
