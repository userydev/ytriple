import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ServiceSettings,
  TaskRemoteAction,
} from "../src/workbench/ServiceSettings.js";
import { workServiceCommandSchema } from "../src/shared/work-service.js";
import type { Snapshot, Task, Command } from "../src/shared/types.js";
import type { WorkJob } from "../services/work-service/contract.js";
const task: Task = {
  id: "original",
  title: "合成栏目",
  goal: "整理已选资料",
  goalVersion: 1,
  kind: "research",
  member: "coordinator",
  status: "completed",
  workspace: "/unused",
  createdAt: "",
  updatedAt: "",
  messages: [],
  events: [],
  artifacts: [],
  sources: [
    {
      id: "source-1",
      title: "测试资料",
      text: "ORCHID 42",
      type: "text",
      location: "",
      addedAt: "",
      coverage: "全文",
    },
  ],
};
const job: WorkJob = {
  id: "job-1",
  title: "远端栏目",
  model: "model-1",
  goal: task.goal,
  materials: [],
  skills: [],
  origin: { taskId: task.id, version: 1 },
  version: 1,
  schedule: { kind: "after_node", delayMinutes: 60, timezone: "UTC" },
  limits: { maxRuns: 10, maxTokens: 100000 },
  state: "uncertain",
  createdAt: "2026-09-13T00:00:00Z",
  updatedAt: "2026-09-13T00:00:00Z",
  runCount: 1,
  tokens: 0,
  runs: [
    {
      id: "run-1",
      state: "uncertain",
      version: 1,
      startedAt: "2026-09-13T00:00:00Z",
      inputHash: "hash",
      meaningful: false,
    },
  ],
  lastError: "上次结果和用量未确认，不自动重试。",
};
function snapshot(): Snapshot {
  return {
    version: "test",
    dataPath: "/unused/test.sqlite",
    projects: [],
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
      policyPath: "/unused/AI/AGENTS.md",
      issues: [],
    },
    tasks: [task],
    profiles: [],
    workService: {
      state: "connected",
      baseURL: "http://127.0.0.1:8790",
      devices: [],
      models: [
        {
          id: "model-1",
          name: "合成服务模型",
          object: "model",
          owned_by: "work-service",
          provider: "openai",
          capabilities: { text: true, tools: true, streaming: true },
          streamingMode: "buffered",
        },
      ],
      jobs: [job],
      exports: [],
      collected: {},
      account: {
        user: { id: "user-1", username: "test-user" },
        entitlement: {
          plan: "test",
          active: true,
          modelIds: ["model-1"],
          tokenLimit: 100000,
          maxConcurrent: 2,
        },
        usage: {
          usedTokens: 0,
          reservedTokens: 10000,
          remainingTokens: 90000,
          unknownRequests: 1,
        },
      },
    },
  };
}
test("remote settings distinguish unknown usage, expose explicit recovery, and preserve local logout uncertainty", () => {
  const state = snapshot();
  const html = renderToStaticMarkup(
    createElement(ServiceSettings, {
      snapshot: state,
      dispatch: async () => null,
    }),
  );
  assert.match(html, /部分用量尚未确认/);
  assert.match(html, /恢复远端执行/);
  assert.match(html, /用量未确认/);
  assert.match(html, /实际发布时间/);
  state.workService = {
    state: "unconfigured",
    error: "本机已退出，远端撤销未确认。",
    devices: [],
    models: [],
    jobs: [],
    exports: [],
    collected: {},
  };
  const loggedOut = renderToStaticMarkup(
    createElement(ServiceSettings, {
      snapshot: state,
      dispatch: async () => null,
    }),
  );
  assert.match(loggedOut, /远端撤销未确认/);
  assert.match(loggedOut, /type="password"/);
  assert.match(loggedOut, /登录服务/);
  const schedules = renderToStaticMarkup(
    createElement(TaskRemoteAction, {
      task,
      snapshot: snapshot(),
      dispatch: async () => null,
      onTask: () => undefined,
    }),
  );
  for (const kind of [
    "once",
    "change",
    "daily",
    "weekly",
    "interval",
    "after_node",
  ])
    assert.ok(schedules.includes(`value="${kind}"`));
});

test("remote UI submits the explicitly selected source with weekly timing and prevents duplicate pending commands", async () => {
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
  const commands: Command[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = snapshot();
  state.workService!.jobs = [];
  const dispatch = async (command: Command) => {
    commands.push(command);
    await blocked;
    return state;
  };
  try {
    await act(async () =>
      root.render(
        createElement(TaskRemoteAction, {
          task,
          snapshot: state,
          dispatch,
          onTask: () => undefined,
        }),
      ),
    );
    const checkbox = document.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    assert.ok(checkbox);
    checkbox.checked = true;
    await act(async () => {
      checkbox.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
    const select = document.querySelector('[aria-label="远端运行安排"]')!;
    for (const option of select.querySelectorAll("option"))
      option.removeAttribute("selected");
    select.querySelector('[value="weekly"]')!.setAttribute("selected", "");
    await act(async () => {
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    assert.ok(document.querySelector('[aria-label="远端执行星期"]'));
    const form = document.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      );
      form.dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    assert.equal(commands.length, 1);
    const command = workServiceCommandSchema.parse(commands[0]);
    assert.equal(command.type, "service.job.create");
    if (command.type !== "service.job.create")
      throw new Error("unexpected command");
    assert.deepEqual(command.sourceIds, ["source-1"]);
    assert.deepEqual(command.skillIds, []);
    assert.equal(command.schedule, "weekly");
    assert.equal(command.weekday, 1);
    assert.equal(command.maxRuns, 10);
    await act(async () => {
      release();
      await blocked;
    });
  } finally {
    release();
    await act(async () => root.unmount());
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
