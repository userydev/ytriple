import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, act } from "react";
import { TaskRoutineAction, RoutinesPanel } from "../src/workbench/Routines.js";
import {
  ROUTINE_TEMPLATES,
  routineCommandSchema,
  type Routine,
  type RoutineCommand,
} from "../src/shared/routines.js";
import type { Task } from "../src/shared/types.js";

const task: Task = {
  id: "original",
  title: "栏目说明",
  goal: "消化资料",
  goalVersion: 1,
  kind: "research",
  member: "coordinator",
  workspace: "/unused",
  status: "completed",
  createdAt: "",
  updatedAt: "",
  sources: [],
  artifacts: [],
  events: [],
  messages: [
    {
      id: "m",
      role: "assistant",
      member: "coordinator",
      goalVersion: 1,
      content: "已完成资料说明。",
      createdAt: "",
    },
  ],
};
const routine: Routine = {
  id: "routine-1",
  taskId: task.id,
  title: "栏目例行",
  version: 1,
  state: "active",
  goal: task.goal,
  kind: task.kind,
  member: task.member,
  schedule: { kind: "change", timezone: "Asia/Shanghai", pollMinutes: 30 },
  location: "client",
  limits: { maxRuns: 30, maxTokens: 200000 },
  scope: {
    taskSources: true,
    sourceIds: [],
    libraryIds: [],
    workspace: "/unused",
    aiRoot: "/unused",
  },
  skills: [],
  permissionVersion: "v1",
  createdAt: "",
  updatedAt: "",
  nextRunAt: "2026-09-14T01:00:00Z",
  runCount: 0,
  tokens: 0,
  usageKnown: true,
  outputs: {},
  runs: [
    {
      id: "check",
      state: "unchanged",
      startedAt: "2026-09-13T01:00:00Z",
      finishedAt: "2026-09-13T01:00:00Z",
      trigger: "change",
      inputFingerprint: "hash",
      version: 1,
      skillHashes: [],
      tokens: 0,
      usageKnown: true,
      sourceIds: [],
      artifactIds: [],
      summary: "输入没有变化，未调用模型。",
      meaningful: false,
    },
  ],
};
const snapshot = {
  tasks: [task],
  library: [],
  routines: {
    items: [routine],
    templates: ROUTINE_TEMPLATES,
    execution: {
      location: "client" as const,
      availability: "while-client-running" as const,
      notice: "退出或休眠期间暂停，无新材料不调用模型。",
    },
  },
};

test("routine management presents client execution limits, quiet checks, original destination and explicit usage history", () => {
  const html = renderToStaticMarkup(
    createElement(RoutinesPanel, {
      snapshot,
      dispatch: async () => undefined,
      onTask: () => undefined,
    }),
  );
  assert.match(html, /退出或休眠期间暂停/);
  assert.match(html, /未调用模型/);
  assert.match(html, /回到《栏目说明》/);
  assert.match(html, /Asia\/Shanghai/);
  assert.match(html, /立即检查/);
  assert.match(html, /委托远端处理/);
  assert.match(html, /最多|200,000/);
  const ineligible = renderToStaticMarkup(
    createElement(TaskRoutineAction, {
      task: { ...task, status: "running" },
      snapshot,
      dispatch: async () => undefined,
    }),
  );
  assert.match(ineligible, /disabled/);
  assert.match(ineligible, /先完成一次工作/);
});

test("setting proven work as a routine sends a validated scoped command and management buttons act on the same routine", async () => {
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
      configurable: true,
      writable: true,
      value,
    });
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  const commands: RoutineCommand[] = [];
  const dispatch = async (command: RoutineCommand) => {
    commands.push(routineCommandSchema.parse(command));
  };
  const click = async (text: string) => {
    const button = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === text,
    );
    assert.ok(button);
    await act(async () => {
      button.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
  };
  try {
    await act(async () => {
      root.render(
        createElement(TaskRoutineAction, { task, snapshot, dispatch }),
      );
    });
    await click("设为例行");
    await act(async () => {
      document
        .querySelector("form")!
        .dispatchEvent(
          new window.Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    const create = commands[0]!;
    assert.equal(create.type, "routine.create");
    if (create.type !== "routine.create") throw new Error("unexpected command");
    assert.equal(create.taskId, task.id);
    assert.equal(create.watchTaskSources, true);
    assert.deepEqual(create.libraryIds, []);
    assert.equal(create.schedule.kind, "change");
    assert.ok(create.requestId);
    await act(async () => {
      root.render(
        createElement(RoutinesPanel, {
          snapshot,
          dispatch,
          onTask: () => undefined,
        }),
      );
    });
    await click("暂停");
    assert.equal(commands.at(-1)?.type, "routine.pause");
    assert.equal(
      (commands.at(-1) as { routineId: string }).routineId,
      routine.id,
    );
    await click("立即检查");
    assert.equal(commands.at(-1)?.type, "routine.run");
    await click("停止");
    assert.equal(commands.at(-1)?.type, "routine.stop");
  } finally {
    await act(async () => {
      root.unmount();
    });
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
