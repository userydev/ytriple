import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import type { Command, Snapshot, Task } from "../src/shared/types.js";
import {
  restoreLayout,
  layoutDesktopState,
  setRightPaneMode,
  setPanelLayout,
  focusLayoutPane,
  type WindowLayout,
} from "../src/desktop/window-layout.js";

let fixtureSequence = 0;
const area = { x: 0, y: 28, width: 1440, height: 900 };
async function withPanels(
  run: (context: {
    document: Document;
    window: Window & typeof globalThis;
    commands: Command[];
    layout: () => WindowLayout;
    dispatch: (command: Command) => Promise<Snapshot | null>;
    act: typeof import("react").act;
  }) => Promise<void>,
) {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id='root'></div></body></html>",
  );
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window,
    document,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  }
  const { act, createElement, useCallback, useRef, useState } =
    await import("react");
  const { createRoot } = await import("react-dom/client");
  const { WorkspacePanels } =
    await import("../src/workbench/WorkspacePanels.js");
  const { WorkspaceControls } =
    await import("../src/workbench/WindowControls.js");
  const { ArtifactView } = await import("../src/workbench/Artifacts.js");
  const task: Task = {
    id: `pane-mode-${++fixtureSequence}`,
    title: "右侧模式验收",
    goal: "继续完善有依据的结论",
    goalVersion: 1,
    kind: "research",
    member: "coordinator",
    workspace: "/unused",
    status: "completed",
    createdAt: "2026-09-11T12:00:00Z",
    updatedAt: "2026-09-11T12:00:00Z",
    messages: [],
    events: [],
    sources: [],
    artifacts: [
      {
        id: `artifact-${fixtureSequence}`,
        title: "可继续编辑的成果",
        path: "/unused/report.md",
        format: "md",
        version: 1,
        hash: "artifact-hash",
        goalVersion: 1,
        updatedAt: "2026-09-11T12:00:00Z",
        versions: [],
        content: "# 我的成果\n切换视图不会丢掉这份正文。",
      },
    ],
  };
  const snapshot: Snapshot = {
    version: "test",
    dataPath: "/unused",
    tasks: [task],
    profiles: [],
    projects: [],
    settings: {
      aiRoot: "/unused/AI",
      codeRoot: "/unused/Code",
      workspaceRoot: "/unused",
      defaultProfileId: "",
      memberProfiles: { coordinator: "", researcher: "", cto: "" },
    },
    system: {
      state: "ready",
      aiRoot: "/unused/AI",
      codeRoot: "/unused/Code",
      policyPath: "/unused/AI/system/POLICY.md",
      issues: [],
    },
  };
  const commands: Command[] = [];
  let currentLayout = restoreLayout(
    { version: 2, taskId: task.id, ratios: { main: 0.46, evidence: 0.4 } },
    [area],
    area,
  );
  let invoke!: (command: Command) => Promise<Snapshot | null>;
  function Harness() {
    const [layout, setLayout] = useState(currentLayout);
    const current = useRef(layout);
    current.current = layout;
    const dispatch = useCallback(async (command: Command) => {
      commands.push(command);
      const next = structuredClone(current.current);
      if (command.type === "window.rightMode")
        setRightPaneMode(next, command.mode);
      if (command.type === "window.layout")
        setPanelLayout(next, command.mode, command.reset);
      if (command.type === "window.focus")
        focusLayoutPane(next, command.window);
      if (command.type === "window.resize")
        next.ratios = { main: command.main, evidence: command.evidence };
      if (command.type === "window.collapse") {
        next.collapsed[command.window] = command.collapsed;
        if (next.expanded === command.window && command.collapsed)
          next.expanded = null;
      }
      if (command.type === "window.expand") {
        next.expanded = command.window;
        if (command.window) {
          next.collapsed[command.window] = false;
          if (command.window !== "main") next.mode = "triple";
        }
      }
      current.current = next;
      currentLayout = next;
      setLayout(next);
      return {
        ...snapshot,
        desktop: layoutDesktopState(next, commands.length),
      };
    }, []);
    invoke = dispatch;
    const desktop = layoutDesktopState(layout, commands.length);
    return createElement(
      "div",
      null,
      createElement(WorkspaceControls, { desktop, dispatch }),
      createElement(WorkspacePanels, {
        desktop,
        dispatch,
        decision: createElement(
          "p",
          { id: "left-decision-content" },
          "左侧决策始终保留",
        ),
        evidence: createElement(
          "p",
          { id: "research-content" },
          "公开研究过程",
        ),
        artifact: createElement(ArtifactView, {
          artifact: task.artifacts[0],
          task,
          dispatch,
        }),
      }),
    );
  }
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(Harness)));
    await run({
      document: document as unknown as Document,
      window: window as unknown as Window & typeof globalThis,
      commands,
      layout: () => currentLayout,
      dispatch: (command) => invoke(command),
      act,
    });
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}
function click(window: Window & typeof globalThis, element: Element | null) {
  assert.ok(element);
  element.dispatchEvent(new window.Event("click", { bubbles: true }));
}
function pointer(
  window: Window & typeof globalThis,
  type: string,
  x: number,
  y: number,
) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    button: { value: 0 },
    clientX: { value: x },
    clientY: { value: y },
  });
  return event;
}

test("right-side modes keep the same left decision and unsaved artifact editor mounted", async () => {
  await withPanels(async ({ document, window, layout, act }) => {
    const main = document.querySelector(".pane-main")!;
    const leftContent = document.querySelector("#left-decision-content");
    const originalColumns =
      document.querySelector<HTMLElement>(".workspace-panels")!.style
        .gridTemplateColumns;
    const artifact = document.querySelector(".pane-artifact")!;
    await act(async () =>
      click(
        window,
        Array.from(artifact.querySelectorAll("button")).find(
          (button) => button.textContent === "编辑",
        )!,
      ),
    );
    const editor =
      artifact.querySelector<HTMLTextAreaElement>(".artifact-editor")!;
    const initial = editor.value || editor.defaultValue;
    for (const [mode, label] of [
      ["evidence", "右侧只看过程"],
      ["artifact", "右侧只看成果"],
      ["split", "右侧上下分割"],
    ] as const) {
      await act(async () =>
        click(
          window,
          document.querySelector(
            `.right-mode-controls [aria-label="${label}"]`,
          ),
        ),
      );
      assert.equal(layout().rightMode, mode);
      assert.equal(
        document.querySelector("#left-decision-content"),
        leftContent,
      );
      assert.ok(
        !main.classList.contains("panel-hidden"),
        "a right-only mode cannot hide the decision pane",
      );
      assert.equal(
        document.querySelector<HTMLElement>(".workspace-panels")!.style
          .gridTemplateColumns,
        originalColumns,
      );
      assert.equal(
        document
          .querySelector(".pane-evidence")!
          .classList.contains("panel-hidden"),
        mode === "artifact",
      );
      assert.equal(
        artifact.classList.contains("panel-hidden"),
        mode === "evidence",
      );
      assert.equal(
        artifact.querySelector(".artifact-editor"),
        editor,
        "view changes keep the actual editor mounted",
      );
      assert.equal(editor.value || editor.defaultValue, initial);
      assert.deepEqual(layout().ratios, { main: 0.46, evidence: 0.4 });
    }
  });
});
test("full-workspace expansion, folding and hidden-panel focus compose with right-only mode", async () => {
  await withPanels(async ({ document, window, layout, dispatch, act }) => {
    await act(async () =>
      dispatch({ type: "window.rightMode", mode: "artifact" }),
    );
    await act(async () =>
      click(window, document.querySelector('[aria-label="最大化成果工作区"]')),
    );
    assert.equal(layout().expanded, "artifact");
    assert.ok(
      document.querySelector(".pane-main")!.classList.contains("panel-hidden"),
    );
    await act(async () =>
      click(window, document.querySelector('[aria-label="还原成果工作区"]')),
    );
    assert.equal(layout().rightMode, "artifact");
    assert.ok(
      !document.querySelector(".pane-main")!.classList.contains("panel-hidden"),
    );
    await act(async () =>
      click(window, document.querySelector('[aria-label="折叠成果工作区"]')),
    );
    assert.ok(
      document
        .querySelector(".pane-artifact")!
        .classList.contains("panel-collapsed"),
    );
    await act(async () =>
      click(window, document.querySelector('[aria-label="前往成果面板"]')),
    );
    assert.ok(
      !document
        .querySelector(".pane-artifact")!
        .classList.contains("panel-collapsed"),
    );
    await act(async () =>
      click(window, document.querySelector('[aria-label="前往过程面板"]')),
    );
    assert.equal(layout().rightMode, "evidence");
    assert.ok(
      !document
        .querySelector(".pane-evidence")!
        .classList.contains("panel-hidden"),
    );
    assert.ok(
      document
        .querySelector(".pane-artifact")!
        .classList.contains("panel-hidden"),
    );
    await act(async () =>
      dispatch({ type: "window.layout", mode: "triple", reset: true }),
    );
    assert.equal(layout().rightMode, "split");
    assert.deepEqual(layout().ratios, { main: 0.52, evidence: 0.5 });
    assert.ok(
      !document
        .querySelector(".pane-artifact")!
        .classList.contains("panel-hidden"),
    );
  });
});
test("the width divider works in a right-only mode and returning to split restores the independent height ratio", async () => {
  await withPanels(
    async ({ document, window, commands, layout, dispatch, act }) => {
      const workspace =
        document.querySelector<HTMLElement>(".workspace-panels")!;
      Object.defineProperty(workspace, "getBoundingClientRect", {
        value: () => ({ left: 0, top: 0, width: 1000, height: 800 }),
      });
      const right = document.querySelector<HTMLElement>(".workspace-right")!;
      Object.defineProperty(right, "getBoundingClientRect", {
        value: () => ({ left: 460, top: 0, width: 540, height: 800 }),
      });
      const bar = document.querySelector<HTMLElement>(".right-pane-toolbar")!;
      Object.defineProperty(bar, "getBoundingClientRect", {
        value: () => ({ height: 36 }),
      });
      const width = document.querySelector(".divider-main")!,
        height = document.querySelector(".divider-evidence")!;
      await act(async () =>
        dispatch({ type: "window.rightMode", mode: "artifact" }),
      );
      assert.equal(height.getAttribute("tabindex"), "-1");
      await act(async () =>
        width.dispatchEvent(pointer(window, "pointerdown", 460, 300)),
      );
      await act(async () =>
        width.dispatchEvent(pointer(window, "pointermove", 550, 300)),
      );
      assert.equal(
        commands.filter((command) => command.type === "window.resize").length,
        0,
      );
      await act(async () => window.dispatchEvent(new window.Event("mouseup")));
      assert.deepEqual(layout().ratios, { main: 0.55, evidence: 0.4 });
      assert.equal(document.querySelector(".resize-shield"), null);
      await act(async () =>
        dispatch({ type: "window.rightMode", mode: "split" }),
      );
      assert.equal(height.getAttribute("aria-valuenow"), "40");
      assert.equal(height.getAttribute("tabindex"), "0");
      await act(async () =>
        height.dispatchEvent(pointer(window, "pointerdown", 700, 341.6)),
      );
      await act(async () =>
        height.dispatchEvent(pointer(window, "pointermove", 700, 418)),
      );
      await act(async () => window.dispatchEvent(new window.Event("mouseup")));
      assert.deepEqual(
        layout().ratios,
        { main: 0.55, evidence: 0.5 },
        "height ratio uses the content area below the new view toolbar",
      );
    },
  );
});

test("changing the right view cancels an unfinished height drag and disables the hidden divider", async () => {
  await withPanels(async ({ document, window, commands, dispatch, act }) => {
    const right = document.querySelector<HTMLElement>(".workspace-right")!;
    Object.defineProperty(right, "getBoundingClientRect", {
      value: () => ({ left: 460, top: 0, width: 540, height: 800 }),
    });
    const height = document.querySelector(".divider-evidence")!;
    await act(async () =>
      height.dispatchEvent(pointer(window, "pointerdown", 700, 320)),
    );
    await act(async () =>
      height.dispatchEvent(pointer(window, "pointermove", 700, 500)),
    );
    assert.ok(document.querySelector(".resize-shield"));
    await act(async () =>
      dispatch({ type: "window.rightMode", mode: "evidence" }),
    );
    assert.equal(document.querySelector(".resize-shield"), null);
    assert.equal(height.getAttribute("aria-valuenow"), "40");
    assert.equal(height.getAttribute("aria-hidden"), "true");
    await act(async () =>
      height.dispatchEvent(pointer(window, "pointerdown", 700, 320)),
    );
    await act(async () =>
      height.dispatchEvent(pointer(window, "pointermove", 700, 600)),
    );
    await act(async () => window.dispatchEvent(new window.Event("mouseup")));
    assert.equal(
      commands.filter((command) => command.type === "window.resize").length,
      0,
      "hidden separators cannot change a saved ratio",
    );
  });
});
