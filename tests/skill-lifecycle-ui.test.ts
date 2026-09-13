import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { Store, uid, now } from "../src/core/store.js";
import { handleSkillCommand } from "../src/core/skill-library.js";
import { skillCatalog, setSkillEnabled } from "../src/core/skill-policy.js";
import type { FeatureHost } from "../src/core/feature-host.js";
import type { SkillCommand } from "../src/shared/skill-library.js";
import type { Command, Snapshot, Task } from "../src/shared/types.js";

test("Skill lifecycle UI imports, edits dependencies, narrows member scope and records conditional use through real handlers", async () => {
  const temporary = await fs.mkdtemp(
      path.join(os.tmpdir(), "ytriple-skill-lifecycle-ui-"),
    ),
    dir = await fs.realpath(temporary);
  const store = new Store(path.join(dir, "data"));
  store.setConfig("settings", {
    ...store.settings(),
    aiRoot: path.join(dir, "AI"),
    codeRoot: path.join(dir, "Code"),
    workspaceRoot: path.join(dir, "work"),
  });
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id='root'></div></body></html>",
  );
  Object.defineProperty(document, "oninput", {
    configurable: true,
    value: null,
  });
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
    { SkillCatalog } = await import("../src/workbench/Skills.js");
  const root = createRoot(document.getElementById("root")!);
  const commands: Command[] = [];
  let operation: Promise<void> = Promise.resolve(),
    failNext = false;
  const host: FeatureHost = {
    store,
    createWork: async (input) => {
      const task: Task = {
        id: uid(),
        goal: input.goal,
        title: input.title,
        kind: "research",
        member: "coordinator",
        workspace: path.join(dir, "work", uid()),
        status: "idle",
        goalVersion: 1,
        createdAt: now(),
        updatedAt: now(),
        sources: input.sources ?? [],
        messages: [],
        events: [],
        artifacts: [],
      };
      store.saveTask(task);
      return task;
    },
    runWork: async () => undefined,
    stopWork: async () => undefined,
    addSource: async () => undefined,
    isRunning: () => false,
  };
  const snapshot = (): Snapshot => ({
    version: "test",
    dataPath: store.dataPath,
    profiles: [],
    tasks: store.tasks(),
    projects: [],
    skills: skillCatalog(store),
    settings: store.settings(),
    system: {
      state: "ready",
      aiRoot: path.join(dir, "AI"),
      codeRoot: path.join(dir, "Code"),
      policyPath: path.join(dir, "AI", "AGENTS.md"),
      issues: [],
    },
  });
  const render = () =>
    root.render(
      createElement(SkillCatalog, {
        snapshot: snapshot(),
        dispatch,
        onTask: () => undefined,
      }),
    );
  const dispatch = async (command: Command) => {
    commands.push(command);
    if (failNext) {
      failNext = false;
      return null;
    }
    if (command.type === "skill.setEnabled")
      setSkillEnabled(store, command.skillId, command.enabled);
    else if (command.type.startsWith("skill.")) {
      operation = handleSkillCommand(host, command as SkillCommand);
      await operation;
    }
    render();
    return snapshot();
  };
  const click = async (label: string, scope: ParentNode = document) => {
    const element = Array.from(scope.querySelectorAll("button")).find(
      (button) =>
        button.textContent?.trim() === label ||
        button.getAttribute("aria-label") === label,
    );
    assert.ok(element, `button ${label}`);
    await act(async () => {
      element.dispatchEvent(new window.Event("click", { bubbles: true }));
      await operation;
    });
  };
  const input = async (
    label: string,
    value: string,
    scope: ParentNode = document,
  ) => {
    const element = scope.querySelector(
      `input[aria-label="${label}"], textarea[aria-label="${label}"]`,
    ) as HTMLInputElement | HTMLTextAreaElement;
    assert.ok(element, `input ${label}`);
    if (element.tagName === "INPUT" && !element.getAttribute("type"))
      element.setAttribute("type", "text");
    const prototype =
      element.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")!.set!;
    await act(async () => {
      setter.call(element, value);
      element.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  };
  const submit = async (label: string) => {
    const form = document.querySelector(`form[aria-label="${label}"]`);
    assert.ok(form, `form ${label}`);
    await act(async () => {
      form.dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      );
      await operation;
    });
  };
  const ownCard = () =>
    Array.from(document.querySelectorAll(".skill-card")).find(
      (card) => card.querySelector("h3")?.textContent === "我的实际方法",
    )!;
  const select = async (
    label: string,
    value: string,
    scope: ParentNode = document,
  ) => {
    const element = scope.querySelector(`[aria-label="${label}"]`)!;
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
    await click("导入或提炼方法");
    await input("导入方法名称", "我的实际方法");
    await input("导入方法用途", "按真实证据整理关键判断");
    await input("方法来源链接", "https://example.com/actual-method");
    await input(
      "导入 Skill 正文",
      "# 方法\n输入：用户提供的真实资料。步骤：读取、核对、形成可修订说明。输出：有证据和缺口的说明。边界：不扩大工具权限。",
    );
    failNext = true;
    await submit("导入 Skill 正文");
    assert.match(
      document.querySelector('[role="alert"]')!.textContent!,
      /草稿已保留/,
    );
    await act(async () => root.render(null));
    await act(async () => render());
    await click("导入或提炼方法");
    assert.equal(
      (
        document.querySelector(
          '[aria-label="导入方法名称"]',
        ) as HTMLInputElement
      ).value,
      "我的实际方法",
    );
    await submit("导入 Skill 正文");
    await click("← 返回方法库");
    await click("查看 我的实际方法");
    assert.ok(ownCard());
    assert.match(
      ownCard().textContent!,
      /自己的方法 · v0.1.0 · 待验证 · 已停用/,
    );
    const imported = skillCatalog(store).find(
      (entry) => entry.name === "我的实际方法",
    )!;
    assert.equal(
      imported.origin?.location,
      "https://example.com/actual-method",
    );
    await click("启用 我的实际方法");
    await click("版本与管理");
    await click("添加实际依赖", ownCard());
    await input("依赖 1 名称", "已提供的阅读工具", ownCard());
    await submit("编辑方法 我的实际方法");
    assert.match(ownCard().textContent!, /缺依赖/);
    await select("依赖 1 状态", "available", ownCard());
    await input("依赖 1 依据", "在当前工作中实际取得资料正文", ownCard());
    await submit("编辑方法 我的实际方法");
    assert.equal(
      skillCatalog(store).find((entry) => entry.id === imported.id)!
        .availability,
      "ready",
    );
    const coordinator = ownCard().querySelector(
      '[aria-label="允许 统筹 使用 我的实际方法"]',
    ) as HTMLInputElement;
    assert.ok(coordinator);
    coordinator.checked = false;
    await act(async () => {
      coordinator.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
    await click("保存成员范围", ownCard());
    assert.equal(
      skillCatalog(store)
        .find((entry) => entry.id === imported.id)!
        .allowedMembers?.includes("coordinator"),
      false,
    );
    await input(
      "方法验证条件",
      "完整提供两篇短文，接收方只看最后的说明",
      ownCard(),
    );
    await input("方法实际观察", "接收方能够正确复述来源和不同判断", ownCard());
    await input("方法验证依据", "我已对照两篇原文核对其复述结果", ownCard());
    await submit("记录 我的实际方法 使用反馈");
    assert.match(ownCard().textContent!, /用户在记录条件下反馈有效/);
    assert.match(ownCard().textContent!, /完整提供两篇短文/);
    const history = ownCard().querySelectorAll(".skill-version-row");
    assert.equal(history.length, 4);
    await click("选为当前版本", history[0]!);
    assert.equal(
      skillCatalog(store).find((entry) => entry.id === imported.id)!.hash,
      imported.hash,
    );
    assert.match(ownCard().textContent!, /对应历史内容版本/);
    assert.equal(
      commands.filter((command) => command.type === "skill.importText").length,
      2,
    );
    assert.equal(
      store.tasks().length,
      0,
      "catalog editing never fabricates a model run",
    );
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
