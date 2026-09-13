import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import type { Command, DesktopState } from "../src/shared/types.js";
async function withDom(
  run: (context: {
    document: Document;
    window: Window & typeof globalThis;
    root: import("react-dom/client").Root;
    act: typeof import("react").act;
    createElement: typeof import("react").createElement;
  }) => Promise<void>,
) {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id='root'></div></body></html>",
  );
  Object.defineProperty(document, "compatMode", {
    value: "CSS1Compat",
    configurable: true,
  });
  Object.defineProperty(document, "oninput", {
    value: null,
    configurable: true,
  });
  const globals = {
    window,
    document,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const originals = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  const { createRoot } = await import("react-dom/client");
  const { act, createElement } = await import("react");
  const root = createRoot(document.getElementById("root")!);
  try {
    await run({
      document: document as unknown as Document,
      window: window as unknown as Window & typeof globalThis,
      root,
      act,
      createElement,
    });
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}
function click(
  window: Window & typeof globalThis,
  document: Document,
  label: string,
) {
  const button = Array.from(document.querySelectorAll("button")).find(
    (button) =>
      button.textContent?.startsWith(label) ||
      button.getAttribute("aria-label") === label,
  );
  assert.ok(button, label);
  button.dispatchEvent(new window.Event("click", { bubbles: true }));
}

function desktop(rightMode: DesktopState["rightMode"] = "split"): DesktopState {
  return {
    mode: "triple",
    taskId: "active",
    rightMode,
    expanded: null,
    ratios: { main: 0.43, evidence: 0.46 },
    collapsed: { main: false, evidence: false, artifact: false },
    open: { main: true, evidence: true, artifact: true },
  };
}
function inputEvent(
  window: Window & typeof globalThis,
  type: string,
  properties: Record<string, unknown>,
) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(properties))
    Object.defineProperty(event, key, { value });
  return event;
}
function props(
  createElement: typeof import("react").createElement,
  commands: Command[],
) {
  return {
    desktop: desktop(),
    dispatch: async (command: Command) => {
      commands.push(command);
      return null;
    },
    hidden: false,
    decision: createElement("textarea", {
      "aria-label": "讨论输入",
      defaultValue: "保留的草稿",
    }),
    artifact: createElement(
      "article",
      { "data-test": "artifact" },
      "可阅读成果",
    ),
    sources: createElement("p", { "data-test": "sources" }, "真实资料"),
    process: createElement("p", { "data-test": "process" }, "公开分析"),
    context: "artifact" as const,
    onContext: () => undefined,
    sourceCount: 2,
  };
}
function prepareDrag(document: Document) {
  const surface = document.querySelector<HTMLElement>(".work-surface")!;
  const side = document.querySelector<HTMLElement>(".collaboration-right")!;
  surface.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 1000, height: 800 }) as DOMRect;
  side.getBoundingClientRect = () =>
    ({ left: 430, top: 0, width: 570, height: 800 }) as DOMRect;
  for (const separator of document.querySelectorAll<HTMLElement>(
    '[role="separator"]',
  )) {
    const captures = new Set<number>();
    separator.setPointerCapture = (id) => {
      captures.add(id);
    };
    separator.hasPointerCapture = (id) => captures.has(id);
    separator.releasePointerCapture = (id) => {
      captures.delete(id);
    };
  }
  return {
    surface,
    main: document.querySelector<HTMLElement>(".divider-main")!,
    evidence: document.querySelector<HTMLElement>(".divider-evidence")!,
  };
}

test("both separators support keyboard limits and reset without changing panel contents", async () => {
  await withDom(async ({ document, window, root, act, createElement }) => {
    const { WorkSurface } = await import("../src/workbench/WorkSurface.js");
    const commands: Command[] = [];
    await act(async () =>
      root.render(createElement(WorkSurface, props(createElement, commands))),
    );
    const textarea = document.querySelector("textarea")!;
    const { main, evidence } = prepareDrag(document);
    assert.equal(main.getAttribute("aria-orientation"), "vertical");
    assert.equal(evidence.getAttribute("aria-orientation"), "horizontal");
    for (const [separator, arrow, expected] of [
      [main, "ArrowRight", "46"],
      [evidence, "ArrowDown", "49"],
    ] as const) {
      await act(async () =>
        separator.dispatchEvent(inputEvent(window, "keydown", { key: arrow })),
      );
      assert.equal(separator.getAttribute("aria-valuenow"), expected);
      await act(async () =>
        separator.dispatchEvent(inputEvent(window, "keydown", { key: "Home" })),
      );
      assert.equal(separator.getAttribute("aria-valuenow"), "30");
      await act(async () =>
        separator.dispatchEvent(inputEvent(window, "keydown", { key: "End" })),
      );
      assert.equal(separator.getAttribute("aria-valuenow"), "65");
      await act(async () =>
        separator.dispatchEvent(inputEvent(window, "dblclick", {})),
      );
    }
    assert.equal(main.getAttribute("aria-valuenow"), "43");
    assert.equal(evidence.getAttribute("aria-valuenow"), "46");
    assert.equal(document.querySelector("textarea"), textarea);
    assert.ok(commands.every((command) => command.type === "window.resize"));
  });
});

test("pointer cancellation and Escape restore the initial ratio and never commit a cancelled drag", async () => {
  await withDom(async ({ document, window, root, act, createElement }) => {
    const { WorkSurface } = await import("../src/workbench/WorkSurface.js");
    const commands: Command[] = [];
    await act(async () =>
      root.render(createElement(WorkSurface, props(createElement, commands))),
    );
    const { surface, main } = prepareDrag(document);
    const start = async () =>
      act(async () => {
        main.dispatchEvent(
          inputEvent(window, "pointerdown", {
            button: 0,
            pointerId: 3,
            clientX: 430,
          }),
        );
        main.dispatchEvent(
          inputEvent(window, "pointermove", { pointerId: 3, clientX: 600 }),
        );
      });
    await start();
    assert.equal(main.getAttribute("aria-valuenow"), "60");
    await act(async () =>
      window.dispatchEvent(
        inputEvent(window, "pointercancel", { pointerId: 3 }),
      ),
    );
    assert.equal(main.getAttribute("aria-valuenow"), "43");
    assert.equal(surface.classList.contains("is-resizing"), false);
    await start();
    await act(async () =>
      document
        .querySelector("textarea")!
        .dispatchEvent(inputEvent(window, "keydown", { key: "Escape" })),
    );
    assert.equal(
      surface.classList.contains("is-resizing"),
      false,
      "Escape works even when pointerdown did not transfer keyboard focus",
    );
    assert.equal(main.getAttribute("aria-valuenow"), "43");
    assert.deepEqual(commands, []);
  });
});

test("only the active pointer completes resize; changing layout cancels rather than saves an unfinished drag", async () => {
  await withDom(async ({ document, window, root, act, createElement }) => {
    const { WorkSurface } = await import("../src/workbench/WorkSurface.js");
    const commands: Command[] = [];
    await act(async () =>
      root.render(createElement(WorkSurface, props(createElement, commands))),
    );
    const { surface, main } = prepareDrag(document);
    await act(async () => {
      main.dispatchEvent(
        inputEvent(window, "pointerdown", { button: 0, pointerId: 3 }),
      );
      main.dispatchEvent(
        inputEvent(window, "pointermove", { pointerId: 3, clientX: 550 }),
      );
    });
    await act(async () =>
      window.dispatchEvent(inputEvent(window, "pointerup", { pointerId: 8 })),
    );
    assert.equal(
      surface.classList.contains("is-resizing"),
      true,
      "another touch ending cannot release this drag",
    );
    assert.equal(commands.length, 0);
    await act(async () =>
      window.dispatchEvent(inputEvent(window, "pointerup", { pointerId: 3 })),
    );
    assert.equal(surface.classList.contains("is-resizing"), false);
    assert.equal(commands.length, 1);
    assert.ok(
      commands[0]?.type === "window.resize" &&
        Math.abs(commands[0].main - 0.55) < 0.001,
    );
    commands.length = 0;
    await act(async () => {
      main.dispatchEvent(
        inputEvent(window, "pointerdown", { button: 0, pointerId: 4 }),
      );
      main.dispatchEvent(
        inputEvent(window, "pointermove", { pointerId: 4, clientX: 610 }),
      );
    });
    await act(async () => click(window, document, "交流与成果"));
    assert.equal(surface.classList.contains("is-resizing"), false);
    assert.equal(main.getAttribute("aria-valuenow"), "55");
    assert.equal(
      commands.some((command) => command.type === "window.resize"),
      false,
    );
  });
});

test("two and three surfaces focus independently, preserve nodes, and expose narrow-window navigation", async () => {
  await withDom(async ({ document, window, root, act, createElement }) => {
    const { WorkSurface } = await import("../src/workbench/WorkSurface.js");
    const commands: Command[] = [];
    await act(async () =>
      root.render(createElement(WorkSurface, props(createElement, commands))),
    );
    const surface = document.querySelector(".work-surface")!;
    const textarea = document.querySelector("textarea")!;
    const nodes = ["artifact", "sources", "process"].map((id) =>
      document.querySelector(`[data-test="${id}"]`),
    );
    for (const [label, className] of [
      ["交流与成果", "layout-artifact"],
      ["交流与分析", "layout-evidence"],
      ["协作", "layout-split"],
    ]) {
      await act(async () => click(window, document, label!));
      assert.ok(surface.classList.contains(className!));
    }
    for (const [label, panel] of [
      ["专注交流", "main"],
      ["专注分析过程", "evidence"],
      ["专注阅读", "artifact"],
    ]) {
      await act(async () => click(window, document, label!));
      assert.ok(surface.classList.contains(`focus-${panel}`));
      await act(async () =>
        surface.dispatchEvent(inputEvent(window, "keydown", { key: "Escape" })),
      );
      assert.equal(surface.className.includes("focus-"), false);
    }
    assert.equal(document.querySelector("textarea"), textarea);
    assert.deepEqual(
      ["artifact", "sources", "process"].map((id) =>
        document.querySelector(`[data-test="${id}"]`),
      ),
      nodes,
    );
    const narrow = document.querySelector('[aria-label="窄窗口工作切换"]')!;
    assert.deepEqual(
      Array.from(narrow.querySelectorAll("button")).map(
        (button) => button.textContent,
      ),
      ["交流", "分析过程", "成果与资料"],
    );
    await act(async () =>
      narrow
        .querySelectorAll("button")[1]!
        .dispatchEvent(new window.Event("click", { bubbles: true })),
    );
    assert.ok(surface.classList.contains("mobile-evidence"));
    assert.equal(document.querySelector("textarea"), textarea);
  });
});

test("saved two-surface layout survives initial context and an explicit focus request restores the requested panel", async () => {
  await withDom(async ({ document, window, root, act, createElement }) => {
    const { WorkSurface } = await import("../src/workbench/WorkSurface.js");
    const commands: Command[] = [];
    const base = {
      ...props(createElement, commands),
      desktop: desktop("evidence"),
    };
    let active: Element | null = null;
    Object.defineProperty(document, "activeElement", {
      get: () => active,
      configurable: true,
    });
    const originalFocus = Object.getOwnPropertyDescriptor(
      window.HTMLElement.prototype,
      "focus",
    );
    Object.defineProperty(window.HTMLElement.prototype, "focus", {
      configurable: true,
      value: function (this: Element) {
        active = this;
      },
    });
    try {
      await act(async () => root.render(createElement(WorkSurface, base)));
      const surface = document.querySelector(".work-surface")!;
      assert.ok(
        surface.classList.contains("layout-evidence"),
        "a stored analysis layout must not be replaced merely by mounting with artifact context",
      );
      await act(async () => click(window, document, "专注分析过程"));
      assert.ok(surface.classList.contains("focus-evidence"));
      await act(async () =>
        root.render(
          createElement(WorkSurface, {
            ...base,
            focusRequest: { panel: "artifact", sequence: 1 },
          }),
        ),
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      assert.ok(surface.classList.contains("layout-split"));
      assert.equal(surface.className.includes("focus-"), false);
      assert.equal(
        document.activeElement,
        document.querySelector('[data-panel="artifact"]'),
      );
      await act(async () =>
        root.render(
          createElement(WorkSurface, {
            ...base,
            focusRequest: { panel: "main", sequence: 2 },
          }),
        ),
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      assert.equal(document.activeElement, document.querySelector("textarea"));
    } finally {
      if (originalFocus)
        Object.defineProperty(
          window.HTMLElement.prototype,
          "focus",
          originalFocus,
        );
      else Reflect.deleteProperty(window.HTMLElement.prototype, "focus");
    }
  });
});
