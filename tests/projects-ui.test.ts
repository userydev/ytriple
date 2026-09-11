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

test("project cards select discussion context without starting work and preserve local state actions", async () => {
  const snapshot: Snapshot = {
    version: "test",
    dataPath: "/unused",
    tasks: [],
    profiles: [],
    projects: [
      project,
      {
        ...project,
        id: "local-project",
        name: "本地项目",
        root: "/unused/Code/x/local-project",
        registered: false,
        observation: { ...project.observation!, state: "missing" },
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
  const { act, createElement, useState } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { Projects } = await import("../src/workbench/Projects.js");
  const commands: Command[] = [];
  const selections: string[] = [];
  const discussions: string[] = [];
  function Harness() {
    const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
      null,
    );
    return createElement(Projects, {
      snapshot,
      selectedProjectId,
      dispatch: async (command) => {
        commands.push(command);
        return snapshot;
      },
      onSelectProject: (value) => {
        selections.push(value.id);
        setSelectedProjectId(value.id);
      },
      onDiscussProject: (value) => discussions.push(value.id),
    });
  }
  const root = createRoot(document.getElementById("root")!);
  const click = async (element: Element | null) => {
    assert.ok(element, "the requested action must remain reachable");
    await act(async () => {
      element.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
  };
  try {
    await act(async () => root.render(createElement(Harness)));
    const card = document.querySelector(
      '.local-project-card[aria-label="项目 阅读工具"]',
    )!;
    assert.match(card.textContent!, /2 项未提交变更/);
    assert.equal(card.querySelector(".local-project-details"), null);
    await click(card.querySelector(".local-project-title"));
    assert.deepEqual(selections, [project.id]);
    assert.equal(card.classList.contains("selected"), true);
    assert.equal(commands.length, 0, "selection must not start or change work");
    await click(card.querySelector(".project-discuss-button"));
    assert.deepEqual(discussions, [project.id]);
    assert.equal(commands.length, 0);

    await click(card.querySelector(".project-state-button"));
    assert.match(card.textContent!, /产品文档尚未找到/);
    assert.match(card.textContent!, /12345678/);
    await click(card.querySelector('[aria-label="查看 阅读工具 项目入口"]'));
    assert.deepEqual(commands.at(-1), {
      type: "path.reveal",
      path: project.documents.entry,
    });
    await click(card.querySelector(".project-open-directory"));
    assert.deepEqual(commands.at(-1), {
      type: "path.reveal",
      path: project.devPath,
    });
    assert.ok(
      document
        .querySelector('[aria-label="打开 本地项目 开发目录"]')
        ?.hasAttribute("disabled"),
    );

    const monitor = document.querySelector('[aria-label="项目监控"]')!;
    await click(
      Array.from(monitor.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("暂停"),
      ) ?? null,
    );
    const monitorCommand = commands.at(-1);
    assert.equal(monitorCommand?.type, "settings.save");
    if (monitorCommand?.type === "settings.save") {
      assert.equal(monitorCommand.settings.projectMonitoring, false);
      assert.deepEqual(
        monitorCommand.settings.memberProfiles,
        snapshot.settings.memberProfiles,
      );
    }
    await click(
      Array.from(monitor.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("刷新"),
      ) ?? null,
    );
    assert.deepEqual(commands.at(-1), { type: "project.refresh" });
    await click(
      Array.from(document.querySelectorAll(".project-filter-tabs button")).find(
        (button) => button.textContent === "本地发现",
      ) ?? null,
    );
    assert.equal(document.querySelectorAll(".local-project-card").length, 1);
    assert.match(
      document.querySelector(".local-project-card")!.textContent!,
      /本地项目/,
    );
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
