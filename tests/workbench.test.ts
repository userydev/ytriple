import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import type { Command, Snapshot, Task } from "../src/shared/types.js";

function taskFixture(id: string, learning: boolean): Task {
  const now = "2026-09-11T12:00:00.000Z";
  return {
    id,
    title: learning ? "学习任务：理解光合作用" : "研究任务：比较储能方案",
    goal: learning
      ? "解释植物怎样把光转成能量。"
      : "比较两种储能方案的适用条件。",
    goalVersion: 1,
    kind: learning ? "learning" : "research",
    member: learning ? "researcher" : "coordinator",
    workspace: `/unused/${id}`,
    status: learning ? "idle" : "completed",
    createdAt: now,
    updatedAt: now,
    messages: [
      {
        id: `${id}-user`,
        role: "user",
        member: "coordinator",
        content: learning ? "学习任务独有的提问内容" : "研究任务独有的提问内容",
        createdAt: now,
        goalVersion: 1,
      },
      ...(learning
        ? []
        : [
            {
              id: `${id}-assistant`,
              role: "assistant" as const,
              member: "coordinator" as const,
              content: "研究任务独有的结论：不同储能方案适用条件不同。",
              createdAt: now,
              goalVersion: 1,
            },
          ]),
    ],
    events: [],
    sources: [],
    artifacts: learning
      ? []
      : [
          {
            id: `${id}-artifact`,
            title: "储能方案研究成果",
            path: `/unused/${id}/report.md`,
            format: "md",
            version: 1,
            hash: `${id}-hash`,
            goalVersion: 1,
            updatedAt: now,
            versions: [],
            content: "# 研究报告\n研究任务的独有成果正文。",
          },
        ],
  };
}

test("switching tasks replaces the visible goal and conversation and keeps artifacts aligned", async () => {
  const learning = taskFixture("learning-fixture", true);
  const research = taskFixture("research-fixture", false);
  const snapshot: Snapshot = {
    version: "test",
    dataPath: "/unused/test.sqlite",
    tasks: [learning, research],
    profiles: [],
    settings: {
      aiRoot: "/unused/AI",
      codeRoot: "/unused/Code",
      workspaceRoot: "/unused/workspace",
      defaultProfileId: "",
      memberProfiles: { coordinator: "", cto: "", researcher: "" },
    },
    system: {
      state: "ready",
      aiRoot: "/unused/AI",
      codeRoot: "/unused/Code",
      policyPath: "/unused/AI/AGENTS.md",
      issues: [],
    },
    projects: [],
  };
  const { window, document } = parseHTML(
    "<!doctype html><html><head></head><body><div id='root'></div></body></html>",
  );
  Object.defineProperty(window, "innerWidth", {
    value: 1400,
    configurable: true,
  });
  Object.defineProperty(window, "location", {
    value: { search: "", href: "https://ytriple.test/" },
    configurable: true,
  });
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
    value: () => undefined,
    configurable: true,
  });
  const commands: Command[] = [];
  const listeners = new Set<(snapshot: Snapshot) => void>();
  window.ytriple = {
    invoke: async (command: Command) => {
      commands.push(command);
      assert.equal(
        command.type,
        "snapshot",
        "switching tasks must not start work",
      );
      return structuredClone(snapshot);
    },
    subscribe: (listener: (snapshot: Snapshot) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const replacements = {
    window,
    document,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const originalGlobals = new Map(
    Object.keys(replacements).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(replacements)) {
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  }
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { App } = await import("../src/workbench/App.js");
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(App)));
    for (const current of [learning, research, learning, research]) {
      const other = current.id === learning.id ? research : learning;
      const button = Array.from(document.querySelectorAll(".work-item")).find(
        (element) => element.textContent?.includes(current.title),
      );
      assert.ok(
        button,
        "the requested task must be reachable from the sidebar",
      );
      await act(async () => {
        button.dispatchEvent(new window.Event("click", { bubbles: true }));
      });
      const pane = document.querySelector(".decision-pane")!;
      assert.equal(
        pane.querySelectorAll(".task-overview").length,
        1,
        "only one task overview may remain visible",
      );
      assert.equal(
        pane.querySelector(".task-overview h1")?.textContent,
        current.title,
      );
      assert.equal(
        pane.querySelector(".goal-details p")?.textContent,
        current.goal,
      );
      assert.equal(
        document.querySelector(".topbar-location strong")?.textContent,
        current.title,
      );
      assert.equal(
        document.querySelector(".work-item.active .work-title")?.textContent,
        current.title,
      );
      const messages = pane.querySelector(".messages")!;
      assert.equal(
        messages.querySelectorAll(".message").length,
        current.messages.length,
      );
      for (const message of current.messages)
        assert.ok(messages.textContent?.includes(message.content));
      assert.ok(
        !pane.textContent?.includes(other.title),
        "the previous task title must be removed",
      );
      for (const message of other.messages)
        assert.ok(
          !pane.textContent?.includes(message.content),
          "the previous task messages must be removed",
        );
      const context = document.querySelector(".context-panel")!;
      if (current.artifacts.length) {
        assert.equal(
          context.querySelector(".artifact-heading h3")?.textContent,
          current.artifacts[0].title,
        );
        assert.ok(context.textContent?.includes("研究任务的独有成果正文。"));
      } else {
        assert.equal(context.querySelectorAll(".artifact-view").length, 0);
        assert.ok(!context.textContent?.includes(research.artifacts[0].title));
      }
    }
    assert.equal(commands.length, 1);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
  assert.equal(
    listeners.size,
    0,
    "unmount must release the desktop subscription",
  );
});
