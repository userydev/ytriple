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
  const snapshot: Snapshot = {
    version: "test",
    dataPath: "/unused",
    tasks: [],
    profiles: [],
    projects: [project],
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
  const { Projects } = await import("../src/workbench/Projects.js");
  const commands: Command[] = [],
    selections: string[] = [],
    discussions: string[] = [];
  let delayedFile: string | undefined;
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
      const directory =
        command.type === "project.browse"
          ? (command.path ?? "")
          : command.path.split("/").slice(0, -1).join("/");
      return {
        ...snapshot,
        projectBrowser: {
          projectId: project.id,
          worktreePath: project.devPath,
          directory,
          truncated: false,
          entries: directory
            ? [{ name: "notes.md", path: "docs/notes.md", kind: "file" }]
            : [
                { name: "docs", path: "docs", kind: "directory" },
                { name: "README.md", path: "README.md", kind: "file" },
              ],
          preview:
            command.type === "project.read"
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
    await click(
      Array.from(document.querySelectorAll(".project-preview-bar button")).find(
        (button) => button.textContent === "项目概览",
      ),
    );
    assert.ok(document.querySelector(".project-file-overview"));
    const monitor = document.querySelector('[aria-label="项目监控"]')!;
    await click(
      Array.from(monitor.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("暂停"),
      ),
    );
    const saved = commands.at(-1);
    assert.equal(saved?.type, "settings.save");
    if (saved?.type === "settings.save") {
      assert.equal(saved.settings.projectMonitoring, false);
      assert.deepEqual(
        saved.settings.memberProfiles,
        snapshot.settings.memberProfiles,
      );
    }
    await click(
      Array.from(monitor.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("刷新状态"),
      ),
    );
    assert.deepEqual(commands.at(-1), { type: "project.refresh" });
    const separator = document.querySelector(
      '[aria-label="调整文件树与预览宽度"]',
    )!;
    const before = Number(separator.getAttribute("aria-valuenow"));
    const event = new window.Event("keydown", { bubbles: true });
    Object.defineProperty(event, "key", { value: "ArrowRight" });
    await act(async () => separator.dispatchEvent(event));
    assert.equal(Number(separator.getAttribute("aria-valuenow")), before + 20);
    assert.equal(stored.get("ytriple.projectTreeWidth"), String(before + 20));
    await click(
      Array.from(document.querySelectorAll(".project-ide-heading button")).find(
        (button) => button.textContent?.includes("新建项目"),
      ),
    );
    assert.match(
      document.querySelector('[role="dialog"]')!.textContent!,
      /已有项目可直接在文件树中打开/,
    );
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
