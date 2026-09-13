import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import type { Command, ProjectInfo, Snapshot } from "../src/shared/types.js";

const project: ProjectInfo = {
  id: "reading",
  name: "阅读工具",
  series: "y",
  root: "/unused/Code/y/reading",
  devPath: "/unused/Code/y/reading/reading-dev",
  registered: true,
  documents: { entry: "/unused/Code/y/reading/reading-dev/README.md" },
  observation: {
    state: "attention",
    checkedAt: "2026-09-11T12:00:00Z",
    fingerprint: "reading-status",
    issues: ["产品文档尚未找到"],
    worktrees: [
      {
        path: "/unused/Code/y/reading/reading-dev",
        state: "ready",
        branch: "dev",
        changedFiles: 2,
        head: "1234567890abcdef",
      },
    ],
    documents: [
      {
        name: "entry",
        path: "/unused/Code/y/reading/reading-dev/README.md",
        state: "present",
      },
      {
        name: "product",
        path: "/unused/Code/y/reading/reading-dev/docs/product.md",
        state: "missing",
      },
    ],
  },
};

test("project explorer reads selected files without starting work and separates preview from discussion", async () => {
  const otherProject: ProjectInfo = {
    ...project,
    id: "other",
    name: "第二个项目",
    root: "/unused/Code/other",
    devPath: "/unused/Code/other/dev",
    observation: undefined,
    documents: {},
  };
  const snapshot: Snapshot = {
    version: "test",
    dataPath: "/unused",
    tasks: [],
    profiles: [],
    projects: [project, otherProject],
    settings: {
      aiRoot: "/unused/AI",
      codeRoot: "/unused/Code",
      workspaceRoot: "/unused/workspace",
      defaultProfileId: "",
      memberProfiles: { coordinator: "", researcher: "", cto: "" },
      projectMonitoring: true,
    },
    system: {
      state: "ready",
      aiRoot: "/unused/AI",
      codeRoot: "/unused/Code",
      policyPath: "/unused/AI/system/POLICY.md",
      issues: [],
    },
  };
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id='root'></div></body></html>",
  );
  let focusedElement: HTMLElement | null = null;
  const originalFocus = Object.getOwnPropertyDescriptor(
    window.HTMLElement.prototype,
    "focus",
  );
  Object.defineProperty(window.HTMLElement.prototype, "focus", {
    configurable: true,
    value: function (this: HTMLElement) {
      focusedElement = this;
      this.dispatchEvent(new window.Event("focusin", { bubbles: true }));
    },
  });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const stored = new Map<string, string>();
  for (const [key, value] of Object.entries({
    window,
    document,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
    localStorage: {
      getItem: (key: string) => stored.get(key),
      setItem: (key: string, value: string) => stored.set(key, value),
    },
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  }
  const { act, createElement, useState } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ProjectExplorer: Projects } =
    await import("../src/workbench/ProjectExplorer.js");
  const commands: Command[] = [],
    selections: string[] = [],
    discussions: string[] = [];
  let delayedFile: string | undefined;
  let failedDirectory: string | undefined;
  let failedFile: string | undefined;
  let releaseDelayed: (() => void) | undefined;
  const dispatch = async (command: Command): Promise<Snapshot> => {
    commands.push(command);
    if (command.type === "project.read" && command.path === delayedFile) {
      delayedFile = undefined;
      await new Promise<void>((resolve) => {
        releaseDelayed = resolve;
      });
    }
    if (command.type === "project.browse" || command.type === "project.read") {
      const failed =
        command.type === "project.browse"
          ? command.path === failedDirectory && failedDirectory !== undefined
          : command.path === failedFile && failedFile !== undefined;
      if (command.type === "project.browse" && failed)
        failedDirectory = undefined;
      if (command.type === "project.read" && failed) failedFile = undefined;
      const directory =
        command.type === "project.browse"
          ? (command.path ?? "")
          : command.path.split("/").slice(0, -1).join("/");
      return {
        ...snapshot,
        projectBrowser: {
          projectId: command.projectId,
          worktreePath: command.worktreePath ?? project.devPath,
          directory,
          truncated: false,
          error: failed ? "合成读取失败，可重试" : undefined,
          entries: failed
            ? []
            : directory
              ? [{ name: "notes.md", path: "docs/notes.md", kind: "file" }]
              : [
                  { name: "docs", path: "docs", kind: "directory" },
                  { name: "README.md", path: "README.md", kind: "file" },
                ],
          preview:
            command.type === "project.read" && !failed
              ? {
                  path: command.path,
                  name: command.path.split("/").at(-1)!,
                  format: "markdown",
                  content:
                    command.path === "README.md"
                      ? "# 阅读说明\n\n真正的文件正文"
                      : "# 研究笔记\n\n另一份文件",
                  bytes: 40,
                  truncated: false,
                }
              : undefined,
        },
      };
    }
    return snapshot;
  };
  function Harness() {
    const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
      null,
    );
    return createElement(Projects, {
      snapshot,
      selectedProjectId,
      dispatch,
      onSelectProject: (value) => {
        selections.push(value.id);
        setSelectedProjectId(value.id);
      },
      onDiscussProject: (value) => discussions.push(value.id),
    });
  }
  const root = createRoot(document.getElementById("root")!);
  const click = async (element: Element | null | undefined) => {
    assert.ok(element, "requested action exists");
    await act(async () => {
      element.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
  };
  const press = async (element: Element | null, key: string) => {
    assert.ok(element);
    const event = new window.Event("keydown", { bubbles: true });
    Object.defineProperty(event, "key", { value: key });
    await act(async () => element.dispatchEvent(event));
  };
  try {
    await act(async () => root.render(createElement(Harness)));
    assert.equal(commands.length, 0);
    assert.match(
      document.querySelector('[aria-label="项目文件预览"]')!.textContent!,
      /选择一个项目/,
    );
    await click(document.querySelector('[aria-label="选择项目 阅读工具"]'));
    assert.deepEqual(selections, [project.id]);
    assert.deepEqual(commands.at(-1), {
      type: "project.browse",
      projectId: project.id,
      worktreePath: project.devPath,
      path: "",
    });
    assert.match(
      document.querySelector(".project-file-overview")!.textContent!,
      /2 项未提交变更/,
    );
    await click(
      Array.from(
        document.querySelectorAll(".project-overview-actions button"),
      ).find((button) => button.textContent?.includes("讨论项目")),
    );
    assert.deepEqual(discussions, [project.id]);
    assert.equal(
      commands.some(
        (command) =>
          command.type === "task.create" || command.type === "task.run",
      ),
      false,
    );
    await click(document.querySelector('[aria-label="预览文件 README.md"]'));
    assert.deepEqual(commands.at(-1), {
      type: "project.read",
      projectId: project.id,
      worktreePath: project.devPath,
      path: "README.md",
    });
    assert.equal(
      document.querySelector(".project-file-preview .markdown h1")?.textContent,
      "阅读说明",
    );
    assert.match(
      document.querySelector(".project-file-preview")!.textContent!,
      /真正的文件正文/,
    );
    await click(document.querySelector('[aria-label="目录 docs"]'));
    assert.deepEqual(commands.at(-1), {
      type: "project.browse",
      projectId: project.id,
      worktreePath: project.devPath,
      path: "docs",
    });
    assert.equal(
      document.querySelector(".project-file-preview .markdown h1")?.textContent,
      "阅读说明",
      "expanding directory preserves the current preview",
    );
    await click(
      document.querySelector('[aria-label="预览文件 docs/notes.md"]'),
    );
    assert.equal(
      document.querySelector(".project-file-preview .markdown h1")?.textContent,
      "研究笔记",
    );
    assert.ok(
      document
        .querySelector('[aria-label="预览文件 docs/notes.md"]')
        ?.classList.contains("selected"),
    );
    const projectRow = document.querySelector(
      '[aria-label="选择项目 阅读工具"]',
    )!;
    const selectionsBeforeFold = selections.length;
    await click(projectRow);
    assert.equal(projectRow.getAttribute("aria-expanded"), "false");
    assert.equal(document.querySelector('[aria-label="目录 docs"]'), null);
    assert.equal(
      document.querySelector(".project-file-preview .markdown h1")?.textContent,
      "研究笔记",
      "folding a project retains the preview and decision selection",
    );
    assert.equal(selections.length, selectionsBeforeFold);
    await click(projectRow);
    assert.equal(projectRow.getAttribute("aria-expanded"), "true");
    assert.ok(document.querySelector('[aria-label="预览文件 docs/notes.md"]'));
    await click(projectRow.querySelector(".project-tree-disclosure"));
    assert.equal(
      projectRow.getAttribute("aria-expanded"),
      "false",
      "the arrow itself really folds the branch",
    );
    await click(projectRow.querySelector(".project-tree-disclosure"));
    const docsRow = document.querySelector('[aria-label="目录 docs"]')!;
    await press(docsRow, "ArrowRight");
    assert.equal(
      (focusedElement as HTMLElement | null)?.getAttribute("data-tree-path"),
      "docs/notes.md",
    );
    await press(focusedElement, "ArrowLeft");
    assert.equal(
      (focusedElement as HTMLElement | null)?.getAttribute("data-tree-path"),
      "docs",
    );
    await press(docsRow, "ArrowLeft");
    assert.equal(docsRow.getAttribute("aria-expanded"), "false");
    assert.equal(
      document.querySelector('[aria-label="预览文件 docs/notes.md"]'),
      null,
    );
    await press(docsRow, "ArrowRight");
    assert.equal(docsRow.getAttribute("aria-expanded"), "true");
    await press(docsRow, "ArrowDown");
    assert.equal(
      (focusedElement as HTMLElement | null)?.getAttribute("data-tree-path"),
      "docs/notes.md",
    );
    await press(focusedElement, "Home");
    assert.equal(
      (focusedElement as HTMLElement | null)?.getAttribute("data-tree-row"),
      "project:reading",
    );
    await press(focusedElement, "End");
    assert.equal(
      (focusedElement as HTMLElement | null)?.getAttribute("data-tree-row"),
      "project:other",
    );
    await press(focusedElement, "ArrowUp");
    assert.equal(
      (focusedElement as HTMLElement | null)?.getAttribute("data-tree-path"),
      "README.md",
    );
    await press(focusedElement, "Enter");
    assert.equal(
      document.querySelector(".project-file-preview .markdown h1")?.textContent,
      "阅读说明",
    );
    delayedFile = "README.md";
    await click(document.querySelector('[aria-label="预览文件 README.md"]'));
    await click(
      document.querySelector('[aria-label="预览文件 docs/notes.md"]'),
    );
    await act(async () => releaseDelayed?.());
    assert.equal(
      document.querySelector(".project-file-preview .markdown h1")?.textContent,
      "研究笔记",
      "late file reads must not replace the more recently selected document",
    );
    const otherRow = document.querySelector(
      '[aria-label="选择项目 第二个项目"]',
    )!;
    await click(otherRow.querySelector(".project-tree-disclosure"));
    assert.equal(otherRow.getAttribute("aria-expanded"), "true");
    assert.equal(
      projectRow.getAttribute("aria-expanded"),
      "true",
      "separate project branches can remain open together",
    );
    assert.equal(
      selections.length,
      selectionsBeforeFold,
      "disclosing a different project does not change the decision context",
    );
    assert.equal(
      document.querySelector(".project-file-preview .markdown h1")?.textContent,
      "研究笔记",
    );
    await click(document.querySelector('[aria-label="收起全部"]'));
    assert.equal(projectRow.getAttribute("aria-expanded"), "false");
    assert.equal(otherRow.getAttribute("aria-expanded"), "false");
    assert.equal(
      document.querySelector(".project-file-preview .markdown h1")?.textContent,
      "研究笔记",
    );
    await click(document.querySelector('[aria-label="在文件树中定位"]'));
    assert.equal(projectRow.getAttribute("aria-expanded"), "true");
    assert.equal(
      document
        .querySelector('[aria-label="目录 docs"]')
        ?.getAttribute("aria-expanded"),
      "true",
    );
    assert.equal(
      (focusedElement as HTMLElement | null)?.getAttribute("data-tree-path"),
      "docs/notes.md",
    );
    await click(document.querySelector('[aria-label="重新读取文件"]'));
    assert.deepEqual(commands.at(-1), {
      type: "project.read",
      projectId: project.id,
      worktreePath: project.devPath,
      path: "docs/notes.md",
    });
    failedDirectory = "docs";
    await click(document.querySelector('[aria-label="刷新文件树"]'));
    assert.match(
      document.querySelector('[aria-label="项目与文件"]')!.textContent!,
      /合成读取失败/,
    );
    await click(document.querySelector(".project-tree-note.error button"));
    assert.ok(document.querySelector('[aria-label="预览文件 docs/notes.md"]'));
    failedFile = "docs/notes.md";
    await click(document.querySelector('[aria-label="重新读取文件"]'));
    assert.match(
      document.querySelector('.project-preview-error[role="alert"]')!
        .textContent!,
      /notes.md：合成读取失败/,
    );
    assert.equal(
      document.querySelector(".project-file-preview .markdown h1")?.textContent,
      "研究笔记",
      "a failed reload retains the last successful preview",
    );
    await click(
      Array.from(
        document.querySelectorAll(".project-preview-error button"),
      ).find((element) => element.textContent === "重试"),
    );
    assert.equal(
      document.querySelector('.project-preview-error[role="alert"]'),
      null,
    );
    await click(
      Array.from(document.querySelectorAll(".project-preview-bar button")).find(
        (button) => button.textContent === "项目概览",
      ),
    );
    assert.ok(document.querySelector(".project-file-overview"));
    const separator = document.querySelector(
      '[aria-label="调整文件树与预览宽度"]',
    )!;
    const before = Number(separator.getAttribute("aria-valuenow"));
    const event = new window.Event("keydown", { bubbles: true });
    Object.defineProperty(event, "key", { value: "ArrowRight" });
    await act(async () => separator.dispatchEvent(event));
    assert.equal(Number(separator.getAttribute("aria-valuenow")), before + 20);
    assert.equal(stored.get("ytriple.projectTreeWidth"), String(before + 20));
  } finally {
    await act(async () => root.unmount());
    if (originalFocus)
      Object.defineProperty(
        window.HTMLElement.prototype,
        "focus",
        originalFocus,
      );
    else Reflect.deleteProperty(window.HTMLElement.prototype, "focus");
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("project split drag tracks outside movement, cancels safely and preserves the decision draft", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id='root'></div></body></html>",
  );
  const stored = new Map<string, string>();
  const storage = {
    getItem: (key: string) => stored.get(key),
    setItem: (key: string, value: string) => stored.set(key, value),
  };
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
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
  const { act, createElement } = await import("react"),
    { createRoot } = await import("react-dom/client");
  const { ProjectWorkspace } =
    await import("../src/workbench/ProjectWorkspace.js");
  const root = createRoot(document.getElementById("root")!);
  const render = (hidden = false) =>
    createElement(ProjectWorkspace, {
      hidden,
      children: [
        createElement("div", { key: "viewer" }, "文件内容"),
        createElement("textarea", {
          key: "decision",
          defaultValue: "未发送的项目讨论",
          "aria-label": "决策草稿",
        }),
      ],
    });
  const event = async (
    target: EventTarget,
    type: string,
    properties: Record<string, unknown> = {},
  ) => {
    const value = new window.Event(type, { bubbles: true });
    for (const [key, property] of Object.entries(properties))
      Object.defineProperty(value, key, { value: property });
    await act(async () => target.dispatchEvent(value));
  };
  try {
    await act(async () => root.render(render()));
    const draft = document.querySelector(
      '[aria-label="决策草稿"]',
    ) as HTMLTextAreaElement;
    draft.value = "未发送的项目讨论";
    const container = document.querySelector(".project-split-layout")!;
    Object.defineProperty(container, "getBoundingClientRect", {
      value: () => ({ left: 0, width: 1000 }),
    });
    const separator = document.querySelector(
      '[aria-label="调整项目查看区与决策区宽度"]',
    )!;
    await event(separator, "pointerdown", {
      button: 0,
      pointerId: 7,
      clientX: 650,
    });
    await event(window, "pointermove", { pointerId: 7, clientX: 780 });
    assert.equal(separator.getAttribute("aria-valuenow"), "78");
    await event(window, "mouseup");
    assert.equal(stored.get("ytriple.projects.viewer-width.v1"), "0.78");
    assert.equal(document.querySelector(".resize-shield"), null);
    await event(separator, "dblclick");
    assert.equal(separator.getAttribute("aria-valuenow"), "65");
    await event(separator, "pointerdown", {
      button: 0,
      pointerId: 8,
      clientX: 650,
    });
    await event(window, "pointermove", { pointerId: 8, clientX: 400 });
    await event(window, "blur");
    assert.equal(separator.getAttribute("aria-valuenow"), "65");
    assert.equal(stored.get("ytriple.projects.viewer-width.v1"), "0.65");
    await event(separator, "pointerdown", {
      button: 0,
      pointerId: 9,
      clientX: 650,
    });
    await event(window, "pointermove", { pointerId: 9, clientX: 500 });
    await event(window, "pointercancel", { pointerId: 9 });
    assert.equal(separator.getAttribute("aria-valuenow"), "65");
    await event(separator, "pointerdown", {
      button: 0,
      pointerId: 10,
      clientX: 650,
    });
    await event(window, "pointermove", { pointerId: 10, clientX: 500 });
    await act(async () => root.render(render(true)));
    assert.equal(separator.getAttribute("aria-valuenow"), "65");
    assert.equal(document.querySelector(".resize-shield"), null);
    await act(async () => root.render(render(false)));
    assert.equal(
      (document.querySelector('[aria-label="决策草稿"]') as HTMLTextAreaElement)
        .value,
      "未发送的项目讨论",
    );
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("project entry starts from objects and current results, opens files only on demand, and keeps support out of project tabs", async () => {
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
    localStorage: { getItem: () => null, setItem: () => {} },
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  }
  const { act, createElement, useState, Fragment } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { Projects } = await import("../src/workbench/Projects.js");
  const { ProjectSupport } = await import("../src/workbench/ProjectSupport.js");
  const snapshot: Snapshot = {
    version: "test",
    dataPath: "/unused",
    profiles: [],
    projects: [project],
    tasks: [
      {
        id: "project-work",
        projectId: project.id,
        title: "明确阅读器首版",
        goal: "形成可交付范围",
        goalVersion: 1,
        kind: "project",
        member: "cto",
        workspace: "/unused/work",
        status: "completed",
        createdAt: "2026-09-11T12:00:00Z",
        updatedAt: "2026-09-11T12:00:00Z",
        messages: [],
        events: [],
        sources: [],
        artifacts: [
          {
            id: "scope",
            title: "首版范围",
            path: "/unused/work/scope.md",
            format: "md",
            version: 2,
            hash: "a".repeat(64),
            goalVersion: 1,
            updatedAt: "2026-09-11T12:00:00Z",
            versions: [],
          },
        ],
      },
    ],
    settings: {
      aiRoot: "/unused/AI",
      codeRoot: "/unused/Code",
      workspaceRoot: "/unused/workspace",
      defaultProfileId: "",
      memberProfiles: { coordinator: "", researcher: "", cto: "" },
      projectMonitoring: true,
    },
    system: {
      state: "ready",
      aiRoot: "/unused/AI",
      codeRoot: "/unused/Code",
      policyPath: "/unused/AI/system/POLICY.md",
      issues: [],
    },
  };
  const commands: Command[] = [],
    opened: string[] = [],
    artifacts: string[] = [],
    discussions: string[] = [];
  const dispatch = async (command: Command) => {
    commands.push(command);
    return snapshot;
  };
  function Harness() {
    const [id, setId] = useState<string | null>(null);
    const [section, setSection] = useState<"software" | "media">("software");
    return createElement(
      Fragment,
      null,
      createElement(ProjectSupport, {
        snapshot,
        section,
        onSection: setSection,
      }),
      createElement(Projects, {
        snapshot,
        dispatch,
        selectedProjectId: id,
        onSelectProject: (item) => setId(item.id),
        onClearSelection: () => setId(null),
        onTask: (task) => opened.push(task),
        onArtifact: (task, artifact) => artifacts.push(`${task}:${artifact}`),
        onDiscussProject: (item) => discussions.push(item.id),
      }),
    );
  }
  const root = createRoot(document.getElementById("root")!);
  const click = async (text: string) => {
    const button = Array.from(document.querySelectorAll("button")).find(
      (item) =>
        item.textContent?.trim() === text ||
        item.getAttribute("aria-label") === text,
    );
    assert.ok(button, `action ${text} exists`);
    await act(async () =>
      button.dispatchEvent(new window.Event("click", { bubbles: true })),
    );
  };
  try {
    await act(async () => root.render(createElement(Harness)));
    assert.equal(
      commands.length,
      0,
      "listing projects performs no browse or task creation",
    );
    assert.equal(document.querySelector(".project-explorer-layout"), null);
    assert.equal(document.querySelector('[aria-label="项目当前工作"]'), null);
    assert.equal(
      document.querySelectorAll('[aria-label="项目类型"] button').length,
      2,
    );
    assert.doesNotMatch(
      document.querySelector('[aria-label="项目类型"]')!.textContent!,
      /例行|交付|待处理/,
    );
    assert.match(
      document.querySelector(".project-status-table")!.textContent!,
      /项目 \/ 当前目标/,
    );
    assert.match(
      document.querySelector(".project-status-table")!.textContent!,
      /成果可审阅/,
    );
    assert.match(
      document.querySelector(".project-status-table")!.textContent!,
      /形成可交付范围/,
    );
    await click("打开项目 阅读工具");
    assert.match(
      document.querySelector('[aria-label="项目当前成果"]')!.textContent!,
      /首版范围/,
    );
    assert.match(
      document.querySelector('[aria-label="项目当前工作"]')!.textContent!,
      /明确阅读器首版/,
    );
    assert.equal(document.querySelector(".project-explorer-layout"), null);
    assert.equal(
      commands.length,
      0,
      "opening a project presents objects without reading its files",
    );
    await act(async () =>
      document
        .querySelector(".project-result-list button")!
        .dispatchEvent(new window.Event("click", { bubbles: true })),
    );
    assert.deepEqual(artifacts, ["project-work:scope"]);
    await act(async () =>
      document
        .querySelector(".project-work-rows button")!
        .dispatchEvent(new window.Event("click", { bubbles: true })),
    );
    assert.deepEqual(opened, ["project-work"]);
    await click("开始项目工作");
    assert.deepEqual(discussions, [project.id]);
    await click("查看文件与状态");
    assert.ok(document.querySelector(".project-explorer-layout"));
    assert.equal(
      commands.some((command) => command.type === "task.create"),
      false,
    );
    assert.ok(
      commands.some(
        (command) =>
          command.type === "project.browse" && command.projectId === project.id,
      ),
    );
    await click("收起文件与状态");
    assert.equal(
      document.querySelector(".project-file-inspector")?.hasAttribute("hidden"),
      true,
    );
    await click("全部软件项目");
    assert.equal(document.querySelector(".project-explorer-layout"), null);
    assert.ok(document.querySelector('[aria-label="打开项目 阅读工具"]'));
    await click("暂停监控");
    const saved = commands.at(-1);
    assert.ok(saved?.type === "settings.save");
    assert.equal(saved.settings.projectMonitoring, false);
    assert.deepEqual(
      saved.settings.memberProfiles,
      snapshot.settings.memberProfiles,
    );
    await click("刷新状态");
    assert.deepEqual(commands.at(-1), { type: "project.refresh" });
    await click("新建项目");
    assert.match(
      document.querySelector('[role="dialog"]')!.textContent!,
      /从目标准备项目规则、资料和开发目录/,
    );
    assert.ok(document.querySelector('input[placeholder="my-reading-tool"]'));
    const fileRequests: string[] = [],
      intents: string[] = [];
    await act(async () =>
      root.render(
        createElement(Projects, {
          snapshot,
          dispatch,
          selectedProjectId: project.id,
          overviewOnly: true,
          hideHeading: true,
          onShowFiles: (item) => fileRequests.push(item.id),
          onDiscussProject: (item, intent) =>
            intents.push(`${item.id}:${intent}`),
        }),
      ),
    );
    assert.equal(
      document.querySelector(".project-status-page h1"),
      null,
      "embedded status does not repeat the workspace heading",
    );
    assert.ok(document.querySelector('[aria-label="项目状态概览"]'));
    assert.match(
      document.querySelector('[aria-label="项目已确认记录"]')!.textContent!,
      /尚无用户确认/,
    );
    assert.match(
      document.querySelector('[aria-label="项目变化依据"]')!.textContent!,
      /未提交改动文件/,
    );
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await click("查看文件与状态");
    assert.deepEqual(fileRequests, [project.id]);
    assert.equal(
      document.querySelector(".project-explorer-layout"),
      null,
      "the shared workspace owns the requested file surface",
    );
    await click("重新理解状态");
    assert.deepEqual(intents, [`${project.id}:understand`]);
    assert.equal(
      commands.some((command) => command.type === "task.create"),
      false,
      "status understanding is an explicit workspace intent, not automatic work on read",
    );
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
