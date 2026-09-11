import { useRef } from "react";
import {
  Columns3,
  Rows2,
  Layers2,
  FileText,
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
export function WorkspaceControls({
  desktop,
  dispatch,
}: {
  desktop?: DesktopState;
  dispatch: Dispatch;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const changeLayout = (command: Command) => {
    menu.current?.removeAttribute("open");
    void dispatch(command);
  };
  const triple = desktop?.mode !== "single";
  return (
    <div className="workspace-controls">
      <nav className="panel-switcher" aria-label="工作面板">
        {(["main", "evidence", "artifact"] as const).map((kind) => (
          <button
            className={`text-button ${desktop?.expanded === kind ? "selected" : ""}`}
            key={kind}
            title={`展开并前往${labels[kind]}面板`}
            aria-label={`前往${labels[kind]}面板`}
            onClick={() =>
              void dispatch({ type: "window.focus", window: kind })
            }
          >
            <span className={`window-position position-${kind}`} />
            {labels[kind]}
            {desktop?.collapsed[kind] ? (
              <span className="collapsed-indicator" />
            ) : null}
          </button>
        ))}
      </nav>
      <details className="layout-menu" ref={menu}>
        <summary title="调整面板布局" aria-label="调整面板布局">
          <Columns3 size={16} />
        </summary>
        <div className="layout-popover">
          <span>工作区布局</span>
          {RIGHT_MODES.map((item) => (
            <button
              key={item.id}
              onClick={() =>
                changeLayout({ type: "window.rightMode", mode: item.id })
              }
            >
              <item.icon size={15} />
              {item.description}
              {triple &&
              !desktop?.expanded &&
              (desktop?.rightMode ?? "split") === item.id ? (
                <span>✓</span>
              ) : null}
            </button>
          ))}
          <button
            onClick={() =>
              changeLayout({ type: "window.layout", mode: "single" })
            }
          >
            <PanelLeft size={15} />
            专注决策{!triple ? <span>✓</span> : null}
          </button>
          <button
            onClick={() =>
              changeLayout({
                type: "window.layout",
                mode: "triple",
                reset: true,
              })
            }
          >
            <RotateCcw size={15} />
            还原默认布局
          </button>
          <p>拖动分隔线调整大小。选中分隔线后也可用方向键微调。</p>
        </div>
      </details>
    </div>
  );
}

const RIGHT_MODES = [
  { id: "split", label: "上下", description: "右侧上下分割", icon: Rows2 },
  { id: "evidence", label: "过程", description: "右侧只看过程", icon: Layers2 },
  {
    id: "artifact",
    label: "成果",
    description: "右侧只看成果",
    icon: FileText,
  },
] as const;
export function RightModeControls({
  desktop,
  dispatch,
}: {
  desktop?: DesktopState;
  dispatch: Dispatch;
}) {
  const mode = desktop?.rightMode ?? "split";
  return (
    <div
      className="right-mode-controls"
      role="group"
      aria-label="右侧工作区显示方式"
    >
      {RIGHT_MODES.map((item) => (
        <button
          key={item.id}
          className={mode === item.id ? "active" : ""}
          aria-label={item.description}
          aria-pressed={mode === item.id}
          title={item.description}
          onClick={() =>
            void dispatch({ type: "window.rightMode", mode: item.id })
          }
        >
          <item.icon size={12} />
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );
}
