import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { Store, uid, now } from "../src/core/store.js";
import {
  attentionSnapshot,
  handleAttentionCommand,
} from "../src/core/attention.js";
import type { AttentionCommand } from "../src/shared/attention.js";
import type { Command, Snapshot, Task } from "../src/shared/types.js";

test("attention UI preserves failed preference drafts, routes original work, and saves snooze and handling through the real store", async () => {
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "ytriple-attention-ui-")),
  );
  const store = new Store(path.join(dir, "data"));
  store.setConfig("settings", {
    ...store.settings(),
    aiRoot: path.join(dir, "AI"),
    codeRoot: path.join(dir, "Code"),
    workspaceRoot: path.join(dir, "work"),
  });
  const task: Task = {
    id: uid(),
    title: "媒体原作品",
    goal: "核对作品受众",
    goalVersion: 1,
    kind: "research",
    member: "editor",
    workspace: path.join(dir, "work", uid()),
    status: "waiting",
    createdAt: now(),
    updatedAt: now(),
    sources: [],
    artifacts: [],
    messages: [],
    events: [
      {
        id: uid(),
        type: "clarification_requested",
        summary: "请确认这项作品的目标受众。",
        goalVersion: 1,
        createdAt: now(),
      },
    ],
  };
  store.saveTask(task);
  const persisted = store.task(task.id);
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id='root'></div></body></html>",
  );
  Object.defineProperty(document, "compatMode", {
    configurable: true,
    value: "CSS1Compat",
  });
  const replacements = {
    window,
    document,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const originals = new Map(
    Object.keys(replacements).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(replacements))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  const { createElement, act } = await import("react"),
    { createRoot } = await import("react-dom/client"),
    { Attention } = await import("../src/workbench/Attention.js");
  const root = createRoot(document.getElementById("root")!);
  const commands: Command[] = [],
    navigations: string[] = [];
  let operation = Promise.resolve(),
    failNext = false;
  const snapshot = (): Snapshot => ({
    version: "test",
    dataPath: store.dataPath,
    tasks: store.tasks(),
    profiles: [],
    projects: [],
    settings: store.settings(),
    attention: attentionSnapshot(store),
    system: {
      state: "ready",
      aiRoot: path.join(dir, "AI"),
      codeRoot: path.join(dir, "Code"),
      policyPath: path.join(dir, "AI", "AGENTS.md"),
      issues: [],
    },
  });
  const dispatch = async (command: Command) => {
    commands.push(command);
    if (failNext) {
      failNext = false;
      return null;
    }
    operation = handleAttentionCommand({ store }, command as AttentionCommand);
    await operation;
    render();
    return snapshot();
  };
  const render = () =>
    root.render(
      createElement(Attention, {
        snapshot: snapshot(),
        dispatch,
        onTask: (id) => navigations.push(id),
      }),
    );
  const click = async (label: string) => {
    const button = Array.from(document.querySelectorAll("button")).find(
      (item) => item.textContent?.trim() === label,
    );
    assert.ok(button, label);
    await act(async () => {
      button.dispatchEvent(new window.Event("click", { bubbles: true }));
      await operation;
    });
  };
  const select = async (label: string, value: string) => {
    const element = document.querySelector(`select[aria-label="${label}"]`)!;
    assert.ok(element, label);
    for (const option of element.querySelectorAll("option"))
      option.removeAttribute("selected");
    element
      .querySelector(`option[value="${value}"]`)!
      .setAttribute("selected", "");
    await act(async () => {
      element.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
  };
  try {
    await act(async () => render());
    assert.match(document.body.textContent!, /请确认这项作品的目标受众/);
    await click("查看原工作");
    assert.deepEqual(navigations, [task.id]);
    await select("应用内通知偏好", "muted");
    failNext = true;
    await click("保存通知偏好");
    assert.match(
      document.querySelector('[role="alert"]')!.textContent!,
      /选择已保留/,
    );
    const first = commands.at(-1)!;
    await act(async () => root.render(null));
    await act(async () => render());
    assert.equal(
      document
        .querySelector('select[aria-label="应用内通知偏好"]')!
        .getAttribute("value") ??
        (
          document.querySelector(
            'select[aria-label="应用内通知偏好"]',
          ) as unknown as HTMLSelectElement
        ).value,
      "muted",
    );
    await click("保存通知偏好");
    assert.deepEqual(
      commands.at(-1),
      first,
      "retry keeps the same command id after remount",
    );
    assert.equal(attentionSnapshot(store).preferences.mode, "muted");
    assert.equal(attentionSnapshot(store).notification.count, 0);
    assert.match(
      document.body.textContent!,
      /媒体原作品/,
      "muting keeps the important item visible",
    );
    await click("暂缓一天");
    assert.equal(attentionSnapshot(store).counts.snoozed, 1);
    assert.equal(store.task(task.id).status, "waiting");
    await select("待处理事项筛选", "snoozed");
    assert.match(document.body.textContent!, /暂缓至/);
    await click("重新提醒");
    await select("待处理事项筛选", "open");
    await click("标记本次已处理");
    assert.equal(attentionSnapshot(store).counts.handled, 1);
    assert.deepEqual(store.task(task.id), persisted);
    store.event(task.id, {
      type: "clarification_requested",
      goalVersion: 1,
      summary: "新的问题：请确认实际平台。",
    });
    await act(async () => render());
    assert.match(document.body.textContent!, /新的问题/);
    assert.equal(attentionSnapshot(store).counts.open, 1);
  } finally {
    await act(async () => root.unmount());
    for (const key of Object.keys(replacements)) {
      const original = originals.get(key);
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    }
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
