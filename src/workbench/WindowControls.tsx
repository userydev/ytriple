import { useRef } from "react";
import {
  ChevronDown,
  ChevronUp,
  Columns3,
  LayoutGrid,
  PanelLeft,
  RotateCcw,
} from "lucide-react";
import type { Command, DesktopState, WindowKind } from "../shared/types";
import type { Dispatch } from "./common";

const labels: Record<WindowKind, string> = {
  main: "决策",
  evidence: "过程",
  artifact: "成果",
};
export function WindowControls({
  desktop,
  kind,
  dispatch,
}: {
  desktop?: DesktopState;
  kind: WindowKind;
  dispatch: Dispatch;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const changeLayout = (command: Command) => {
    menu.current?.removeAttribute("open");
    void dispatch(command);
  };
  const triple = desktop?.mode === "triple";
  const collapsed = desktop?.collapsed[kind] ?? false;
  return (
    <div className="window-controls">
      <div className="window-switcher" aria-label="工作窗口">
        {(["main", "evidence", "artifact"] as const)
          .filter((target) => target !== kind && (triple || target === "main"))
          .map((target) => (
            <button
              className="text-button"
              key={target}
              title={`展开并前往${labels[target]}窗口`}
              aria-label={`前往${labels[target]}窗口`}
              onClick={() =>
                void dispatch({ type: "window.focus", window: target })
              }
            >
              <span className={`window-position position-${target}`} />
              {labels[target]}
            </button>
          ))}
      </div>
      <details className="layout-menu" ref={menu}>
        <summary title="调整窗口布局" aria-label="调整窗口布局">
          <Columns3 size={16} />
        </summary>
        <div className="layout-popover">
          <span>工作窗口</span>
          <button
            onClick={() =>
              changeLayout({ type: "window.layout", mode: "triple" })
            }
          >
            <LayoutGrid size={15} />
            左主窗 · 右侧上下双窗{triple ? <span>✓</span> : null}
          </button>
          <button
            onClick={() =>
              changeLayout({ type: "window.layout", mode: "single" })
            }
          >
            <PanelLeft size={15} />
            单窗工作{!triple ? <span>✓</span> : null}
          </button>
          <button
            onClick={() =>
              changeLayout({
                type: "window.layout",
                mode: triple ? "triple" : "single",
                reset: true,
              })
            }
          >
            <RotateCcw size={15} />
            恢复默认位置与大小
          </button>
          <p>拖动窗口边缘即可调整大小。</p>
        </div>
      </details>
      <button
        className="icon-button"
        title={collapsed ? "展开当前窗口" : "折叠当前窗口"}
        aria-label={collapsed ? "展开当前窗口" : "折叠当前窗口"}
        onClick={() =>
          void dispatch({
            type: "window.collapse",
            window: kind,
            collapsed: !collapsed,
          })
        }
      >
        {collapsed ? <ChevronDown size={17} /> : <ChevronUp size={17} />}
      </button>
    </div>
  );
}
