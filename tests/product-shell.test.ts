import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import type { Command, Snapshot, Task } from "../src/shared/types.js";

const task = (id: string, title = id): Task => ({
  id,
  title,
  goal: `${title}目标`,
  goalVersion: 1,
  kind: "research",
  member: "coordinator",
  workspace: `/unused/${id}`,
  status: "idle",
  createdAt: "2026-09-13T12:00:00Z",
  updatedAt: "2026-09-13T12:00:00Z",
  messages: [],
  events: [],
  sources: [],
  artifacts: [],
});
const initial = (): Snapshot => ({
  version: "test",
  dataPath: "/unused",
  tasks: [task("old", "已有工作")],
  projects: [
    {
      id: "project",
      name: "我的产品",
      series: "y",
      root: "/unused/project",
      devPath: "/unused/project/dev",
      documents: {},
    },
  ],
  profiles: [],
  settings: {
    aiRoot: "/unused/AI",
    codeRoot: "/unused/Code",
    workspaceRoot: "/unused/work",
    defaultProfileId: "",
    memberProfiles: { coordinator: "", cto: "", researcher: "" },
  },
  system: {
    state: "ready",
    aiRoot: "/unused/AI",
    codeRoot: "/unused/Code",
    policyPath: "/unused/AI/system/POLICY.md",
    issues: [],
  },
  desktop: {
    mode: "single",
    taskId: "old",
    collapsed: { main: false, evidence: false, artifact: false },
    open: { main: true, evidence: true, artifact: true },
    revision: 1,
  },
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function setup(
  intercept?: (command: Command, state: Snapshot) => Promise<void>,
) {
  const { window, document } = parseHTML(
    "<!doctype html><html><head></head><body><div id='root'></div></body></html>",
  );
  Object.defineProperty(document, "oninput", {
    configurable: true,
    value: null,
  });
  Object.defineProperty(document, "compatMode", {
    configurable: true,
    value: "CSS1Compat",
  });
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { search: "", href: "https://ytriple.test/" },
  });
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1400,
  });
  let active: HTMLElement | null = null;
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => active,
  });
  Object.defineProperty(window.HTMLElement.prototype, "focus", {
    configurable: true,
    value: function (this: HTMLElement) {
      active = this;
    },
  });
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => {},
  });
  const state = initial();
  const commands: Command[] = [];
  const listeners = new Set<(value: Snapshot) => void>();
  window.ytriple = {
    invoke: async (command: Command) => {
      commands.push(command);
      await intercept?.(command, state);
      if (command.type === "task.create") {
        state.tasks.push({
          ...task(
            `created-${commands.filter((item) => item.type === "task.create").length}`,
            command.title ?? command.goal,
          ),
          goal: command.goal,
          requestId: command.requestId,
          projectId: command.projectId,
          kind: command.kind ?? "research",
          member: command.member ?? "coordinator",
        });
      }
      if (command.type === "window.select")
        state.desktop = {
          ...state.desktop!,
          taskId: command.taskId,
          revision: (state.desktop?.revision ?? 0) + 1,
        };
      return structuredClone(state);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window,
    document,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  const { act, createElement, useState } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  const button = (label: string, scope: ParentNode = document) =>
    Array.from(scope.querySelectorAll("button")).find(
      (item) =>
        item.textContent?.trim() === label ||
        item.getAttribute("aria-label") === label,
    );
  const click = async (
    target: string | Element,
    scope: ParentNode = document,
  ) => {
    const element = typeof target === "string" ? button(target, scope) : target;
    assert.ok(element, `action ${target} exists`);
    await act(async () => {
      if (element.getAttribute("type") === "submit") {
        element
          .closest("form")!
          .dispatchEvent(
            new window.Event("submit", { bubbles: true, cancelable: true }),
          );
      } else
        element.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
  };
  const input = async (
    element: HTMLInputElement | HTMLTextAreaElement,
    value: string,
  ) => {
    assert.ok(element);
    const prototype =
      element.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(prototype, "value")!.set!;
    await act(async () => {
      set.call(element, value);
      element.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  };
  const renderApp = async () => {
    const { App } = await import("../src/workbench/App.js");
    await act(async () => root.render(createElement(App)));
  };
  const close = async () => {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  const home = () => document.querySelector(".home-host")!;
  return {
    window,
    document,
    state,
    commands,
    root,
    act,
    createElement,
    useState,
    button,
    click,
    input,
    renderApp,
    close,
    home,
  };
}

test("home material import creates its own task, retries against that task, and keeps old and home drafts separate", async () => {
  let fail = true;
  const h = await setup(async (command) => {
    if (command.type === "source.addText" && fail) {
      fail = false;
      throw new Error("模拟可重试的读取失败");
    }
  });
  try {
    await h.renderApp();
    assert.equal(h.home().hasAttribute("hidden"), false);
    await h.input(h.home().querySelector("textarea")!, "首页独立草稿");
    await h.click(h.document.querySelector(".home-work-row")!);
    await h.input(
      h.document.querySelector(
        '.work-surface textarea[aria-label="继续讨论或提出修改"]',
      )!,
      "已有工作自己的草稿",
    );
    await h.click("工作台", h.document.querySelector(".primary-nav")!);
    assert.equal(
      (h.home().querySelector("textarea") as HTMLTextAreaElement).value,
      "首页独立草稿",
    );
    await h.click("添加资料", h.home());
    await h.click("粘贴文本");
    await h.input(
      h.document.querySelector('[role="dialog"] textarea')!,
      "仅供首页这次工作的资料",
    );
    await h.click("加入这项工作");
    assert.ok(
      h.document.querySelector('[role="dialog"]'),
      "failed import retains the form",
    );
    await h.click("加入这项工作");
    const creates = h.commands.filter(
      (command) => command.type === "task.create",
    );
    const imports = h.commands.filter(
      (command) => command.type === "source.addText",
    );
    assert.equal(creates.length, 1, "retry must reuse the prepared task");
    assert.equal(imports.length, 2);
    assert.ok(
      imports.every((command) => command.taskId === "created-1"),
      "home sources never attach to the restored old task",
    );
    await h.click(
      Array.from(h.document.querySelectorAll(".work-item")).find((item) =>
        item.textContent?.includes("已有工作"),
      )!,
    );
    assert.equal(
      (
        h.document.querySelector(
          '.work-surface textarea[aria-label="继续讨论或提出修改"]',
        ) as HTMLTextAreaElement
      ).value,
      "已有工作自己的草稿",
    );
  } finally {
    await h.close();
  }
});

test("a late project discussion creation runs the requested task without replacing the user's new page", async () => {
  const gate = deferred();
  const h = await setup(async (command) => {
    if (command.type === "task.create") await gate.promise;
  });
  try {
    await h.renderApp();
    await h.click("项目", h.document.querySelector(".primary-nav")!);
    await h.click("打开项目 我的产品");
    await h.click("开始项目工作");
    await h.input(
      h.document.querySelector(".work-discussion textarea")!,
      "把首版范围讨论清楚",
    );
    await h.click("开始工作", h.document.querySelector(".work-discussion")!);
    assert.equal(
      h.commands.filter((command) => command.type === "task.create").length,
      1,
    );
    assert.equal(
      h.document.querySelector("[role=dialog]"),
      null,
      "project work is a full workspace",
    );
    await h.click("工作台", h.document.querySelector(".primary-nav")!);
    await h.act(async () => {
      gate.resolve();
      await gate.promise;
    });
    assert.equal(
      h.home().hasAttribute("hidden"),
      false,
      "late project creation must not force navigation back to work",
    );
    assert.ok(
      h.commands.some(
        (command) =>
          command.type === "task.run" && command.taskId === "created-1",
      ),
      "the explicitly authorized work still runs",
    );
  } finally {
    gate.resolve();
    await h.close();
  }
});

test("home creation identifies its own request among concurrent tasks and preserves later home input", async () => {
  const gate = deferred();
  const h = await setup(async (command, state) => {
    if (command.type === "task.create") {
      await gate.promise;
      state.tasks.push({
        ...task("concurrent", "别处同时创建的工作"),
        requestId: "other-request",
      });
    }
  });
  try {
    await h.renderApp();
    await h.input(
      h.home().querySelector("textarea")!,
      "提交给团队的第一项工作",
    );
    await h.click("开始工作", h.home());
    await h.input(h.home().querySelector("textarea")!, "稍后要做的第二项工作");
    await h.click("项目", h.document.querySelector(".primary-nav")!);
    await h.act(async () => {
      gate.resolve();
      await gate.promise;
    });
    assert.ok(
      h.commands.some(
        (command) =>
          command.type === "task.run" && command.taskId === "created-1",
      ),
      "only the exact created request is run",
    );
    assert.equal(
      h.commands.some(
        (command) =>
          command.type === "task.run" && command.taskId === "concurrent",
      ),
      false,
    );
    assert.equal(
      h.home().hasAttribute("hidden"),
      true,
      "late completion preserves explicit project navigation",
    );
    assert.equal(
      h.document.querySelector(".work-surface")!.hasAttribute("hidden"),
      true,
    );
    await h.click("工作台", h.document.querySelector(".primary-nav")!);
    assert.equal(
      (h.home().querySelector("textarea") as HTMLTextAreaElement).value,
      "稍后要做的第二项工作",
      "late completion cannot erase newer input",
    );
  } finally {
    gate.resolve();
    await h.close();
  }
});

test("starting fresh work focuses the visible home composer rather than the mounted hidden old work", async () => {
  const h = await setup();
  try {
    await h.renderApp();
    await h.click(h.document.querySelector(".home-work-row")!);
    assert.equal(
      h.document.querySelector(".work-surface")!.hasAttribute("hidden"),
      false,
    );
    await h.click(h.document.querySelector(".new-work")!);
    assert.equal(h.home().hasAttribute("hidden"), false);
    assert.equal(h.document.activeElement, h.home().querySelector("textarea"));
    assert.equal(h.document.activeElement?.closest("[hidden]"), null);
  } finally {
    await h.close();
  }
});

test("Escape closes only the top modal and restores focus within its parent", async () => {
  const h = await setup();
  try {
    const { Modal } = await import("../src/workbench/common.js");
    const closed: string[] = [];
    function Harness() {
      const [outer, setOuter] = h.useState(true),
        [inner, setInner] = h.useState(false);
      return outer
        ? h.createElement(
            Modal,
            {
              title: "项目讨论",
              children: null,
              onClose: () => {
                closed.push("outer");
                setOuter(false);
              },
            },
            h.createElement(
              "button",
              { onClick: () => setInner(true) },
              "添加背景",
            ),
            inner
              ? h.createElement(
                  Modal,
                  {
                    title: "项目资料",
                    children: null,
                    onClose: () => {
                      closed.push("inner");
                      setInner(false);
                    },
                  },
                  h.createElement("input", { "aria-label": "资料内容" }),
                )
              : null,
          )
        : null;
    }
    await h.act(async () => h.root.render(h.createElement(Harness)));
    await h.click("添加背景");
    const key = new h.window.Event("keydown", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(key, "key", { value: "Escape" });
    await h.act(async () => h.document.dispatchEvent(key));
    assert.deepEqual(closed, ["inner"]);
    assert.equal(h.document.querySelectorAll('[role="dialog"]').length, 1);
    assert.ok(h.document.activeElement?.closest('[role="dialog"]'));
    const again = new h.window.Event("keydown", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(again, "key", { value: "Escape" });
    await h.act(async () => h.document.dispatchEvent(again));
    assert.deepEqual(closed, ["inner", "outer"]);
  } finally {
    await h.close();
  }
});

test("a closed source dialog cannot populate or close a newly opened source session when its import finishes late", async () => {
  const gate = deferred();
  let first = true;
  const h = await setup(async (command) => {
    if (command.type === "task.create" && first) {
      first = false;
      await gate.promise;
    }
  });
  try {
    await h.renderApp();
    await h.click("添加资料", h.home());
    await h.click("粘贴文本");
    await h.input(
      h.document.querySelector('[role="dialog"] textarea')!,
      "第一个已提交导入的资料",
    );
    await h.click("加入这项工作");
    await h.click("取消");
    await h.click("添加资料", h.home());
    await h.click("粘贴文本");
    await h.input(
      h.document.querySelector('[role="dialog"] textarea')!,
      "第二个独立导入的资料",
    );
    await h.act(async () => {
      gate.resolve();
      await gate.promise;
    });
    assert.ok(
      h.document.querySelector('[role="dialog"]'),
      "the first import must not close the new dialog",
    );
    assert.equal(
      (
        h.document.querySelector(
          '[role="dialog"] textarea',
        ) as HTMLTextAreaElement
      ).value,
      "第二个独立导入的资料",
    );
    await h.click("加入这项工作");
    const imports = h.commands.filter(
      (command) => command.type === "source.addText",
    );
    assert.deepEqual(
      imports.map((command) => [command.taskId, command.text]),
      [
        ["created-1", "第一个已提交导入的资料"],
        ["created-2", "第二个独立导入的资料"],
      ],
      "each source session keeps its own prepared task",
    );
  } finally {
    gate.resolve();
    await h.close();
  }
});

test("opening another task exits the previous task's reading focus so its discussion remains reachable", async () => {
  const h = await setup();
  h.state.tasks.push(task("next", "尚无成果的新工作"));
  try {
    await h.renderApp();
    await h.click(
      Array.from(h.document.querySelectorAll(".home-work-row")).find((item) =>
        item.textContent?.includes("已有工作"),
      )!,
    );
    await h.click("专注阅读");
    assert.ok(h.document.querySelector(".work-surface.focus-artifact"));
    await h.click(
      Array.from(h.document.querySelectorAll(".work-item")).find((item) =>
        item.textContent?.includes("尚无成果的新工作"),
      )!,
    );
    assert.equal(
      Boolean(h.document.querySelector(".work-surface.focus-artifact")),
      false,
      "a task without artifacts must not inherit the previous reading-only surface",
    );
    assert.match(
      h.document.querySelector(".decision-pane")!.textContent!,
      /尚无成果的新工作/,
    );
  } finally {
    await h.close();
  }
});

test("a dismissed project source import cannot close a replacement editor or steal its task", async () => {
  const gate = deferred();
  const h = await setup(async (command) => {
    if (command.type === "task.create") await gate.promise;
  });
  try {
    await h.renderApp();
    await h.click("项目", h.document.querySelector(".primary-nav")!);
    await h.click("打开项目 我的产品");
    await h.click("开始项目工作");
    const outer = h.document.querySelector(".work-discussion")!;
    await h.click("添加资料", outer);
    await h.click("粘贴文本");
    await h.input(
      h.document.querySelectorAll<HTMLTextAreaElement>(
        '[role="dialog"] textarea',
      )[0]!,
      "先提交的项目资料",
    );
    await h.click("加入这项工作");
    await h.click("取消");
    assert.equal(h.document.querySelectorAll('[role="dialog"]').length, 0);
    await h.click("添加资料", outer);
    await h.click("粘贴文本");
    await h.input(
      h.document.querySelectorAll<HTMLTextAreaElement>(
        '[role="dialog"] textarea',
      )[0]!,
      "继续填写的项目资料",
    );
    await h.act(async () => {
      gate.resolve();
      await gate.promise;
    });
    assert.equal(
      h.document.querySelectorAll('[role="dialog"]').length,
      1,
      "late completion preserves the replacement editor inside the full workspace",
    );
    assert.equal(
      h.document.querySelectorAll<HTMLTextAreaElement>(
        '[role="dialog"] textarea',
      )[0]!.value,
      "继续填写的项目资料",
    );
    await h.click("加入这项工作");
    const imports = h.commands.filter(
      (command) => command.type === "source.addText",
    );
    assert.deepEqual(
      imports.map((command) => [command.taskId, command.text]),
      [
        ["created-1", "先提交的项目资料"],
        ["created-2", "继续填写的项目资料"],
      ],
      "each replacement editor keeps its own explicitly created project work",
    );
  } finally {
    gate.resolve();
    await h.close();
  }
});

test("project work reads its registered document before creating or running and preserves the real source", async () => {
  const h = await setup(async (command, state) => {
    if (command.type === "project.read")
      state.projectBrowser = {
        projectId: command.projectId,
        worktreePath: command.worktreePath!,
        directory: "",
        entries: [],
        truncated: false,
        preview: {
          path: command.path,
          name: "README.md",
          format: "markdown",
          bytes: 42,
          truncated: false,
          content: "# 正式产品依据\n先验证修订接续，再登记交付。",
        },
      };
  });
  h.state.projects[0]!.documents.entry = "/unused/project/dev/README.md";
  try {
    await h.renderApp();
    await h.click("项目", h.document.querySelector(".primary-nav")!);
    await h.click("打开项目 我的产品");
    assert.equal(
      h.commands.some((command) => command.type === "task.create"),
      false,
    );
    await h.input(
      h.document.querySelector(".work-discussion textarea")!,
      "确认当前目标与下一步",
    );
    await h.click("开始工作", h.document.querySelector(".work-discussion")!);
    const actions = h.commands.filter((command) =>
      ["project.read", "task.create", "source.addText", "task.run"].includes(
        command.type,
      ),
    );
    assert.deepEqual(
      actions.map((command) => command.type),
      ["project.read", "task.create", "source.addText", "task.run"],
    );
    const source = actions.find(
      (command) => command.type === "source.addText",
    )!;
    assert.match(source.text, /先验证修订接续，再登记交付/);
    assert.equal(source.taskId, "created-1");
    assert.equal(source.expectedGoalVersion, 1);
    assert.equal(h.document.querySelector('[role="dialog"]'), null);
  } finally {
    await h.close();
  }
});

test("a mismatched project preview cannot start work or erase the submitted request", async () => {
  const h = await setup(async (command, state) => {
    if (command.type === "project.read")
      state.projectBrowser = {
        projectId: "another-project",
        worktreePath: command.worktreePath!,
        directory: "",
        entries: [],
        truncated: false,
        preview: {
          path: command.path,
          name: "README.md",
          format: "markdown",
          bytes: 12,
          truncated: false,
          content: "不属于本项目的正文",
        },
      };
  });
  h.state.projects[0]!.documents.entry = "/unused/project/dev/README.md";
  try {
    await h.renderApp();
    await h.click("项目", h.document.querySelector(".primary-nav")!);
    await h.click("打开项目 我的产品");
    await h.input(
      h.document.querySelector(".work-discussion textarea")!,
      "保留这个项目的真实要求",
    );
    await h.click("开始工作", h.document.querySelector(".work-discussion")!);
    assert.equal(
      h.commands.some((command) =>
        ["task.create", "source.addText", "task.run"].includes(command.type),
      ),
      false,
    );
    assert.equal(
      (
        h.document.querySelector(
          ".work-discussion textarea",
        ) as HTMLTextAreaElement
      ).value,
      "保留这个项目的真实要求",
    );
    assert.match(h.document.body.textContent!, /未能读取项目资料/);
  } finally {
    await h.close();
  }
});

test("a new user goal during project material preparation is never adopted by the old auto-run", async () => {
  const h = await setup(async (command, state) => {
    if (command.type === "project.read")
      state.projectBrowser = {
        projectId: command.projectId,
        worktreePath: command.worktreePath!,
        directory: "",
        entries: [],
        truncated: false,
        preview: {
          path: command.path,
          name: "README.md",
          format: "markdown",
          bytes: 10,
          truncated: false,
          content: "明确的项目正文",
        },
      };
    if (command.type === "source.addText") {
      const created = state.tasks.find((item) => item.id === command.taskId)!;
      created.goalVersion += 2;
      created.goal = "后来修改的目标";
    }
  });
  h.state.projects[0]!.documents.entry = "/unused/project/dev/README.md";
  try {
    await h.renderApp();
    await h.click("项目", h.document.querySelector(".primary-nav")!);
    await h.click("打开项目 我的产品");
    await h.input(
      h.document.querySelector(".work-discussion textarea")!,
      "先前提交的要求",
    );
    await h.click("开始工作", h.document.querySelector(".work-discussion")!);
    assert.equal(
      h.commands.some((command) => command.type === "task.run"),
      false,
    );
    assert.equal(
      h.state.tasks.find((item) => item.id === "created-1")!.goal,
      "后来修改的目标",
    );
  } finally {
    await h.close();
  }
});
