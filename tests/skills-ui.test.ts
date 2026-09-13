import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import type { Command, Snapshot, Task } from "../src/shared/types.js";
import type { SkillCatalogEntry } from "../src/shared/skills.js";

const methods: SkillCatalogEntry[] = [
  "material-digest",
  "script-review",
  "handoff-review",
].map((id, index) => ({
  id,
  name: ["资料消化", "脚本核查", "制作交接"][index]!,
  description: `方法用途 ${index}`,
  version: "1.0.0",
  hash: `hash-${id}`,
  source: "builtin",
  enabled: true,
  validation: "unverified",
  instructions: `# ${id}\n方法正文：区分来源证据和未验证判断。`,
}));
function taskFixture(id: string): Task {
  return {
    id,
    title: `工作 ${id}`,
    goal: "整理已有资料",
    kind: "research",
    member: "coordinator",
    workspace: `/unused/${id}`,
    status: "paused",
    createdAt: "2026-09-13T12:00:00Z",
    updatedAt: "2026-09-13T12:00:00Z",
    goalVersion: 1,
    messages: [],
    events: [],
    sources: [],
    artifacts: [],
    skillPolicy: { mode: "auto", skillIds: [] },
  };
}
function snapshotFixture(id: string): Snapshot {
  return {
    version: "test",
    dataPath: "/unused/test.sqlite",
    tasks: [],
    profiles: [],
    projects: [],
    library: [],
    skills: methods.map((skill) => ({ ...skill })),
    settings: {
      aiRoot: `/unused/${id}/AI`,
      codeRoot: "/unused/Code",
      workspaceRoot: "/unused/workspaces",
      defaultProfileId: "",
      memberProfiles: { coordinator: "", researcher: "", cto: "" },
    },
    system: {
      state: "ready",
      aiRoot: "/unused/AI",
      codeRoot: "/unused/Code",
      policyPath: "/unused/AI/AGENTS.md",
      issues: [],
    },
    desktop: {
      mode: "triple",
      taskId: null,
      revision: 1,
      collapsed: { main: false, evidence: false, artifact: false },
      open: { main: true, evidence: true, artifact: true },
    },
  };
}
async function withDom(
  run: (context: {
    document: Document;
    window: Window & typeof globalThis;
    root: import("react-dom/client").Root;
    act: typeof import("react").act;
    createElement: typeof import("react").createElement;
    click: (element: Element | null | undefined) => Promise<void>;
    choose: (value: string) => Promise<void>;
    check: (name: string, value?: boolean) => Promise<void>;
  }) => Promise<void>,
) {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id='root'></div></body></html>",
  );
  Object.defineProperty(document, "oninput", {
    value: null,
    configurable: true,
  });
  Object.defineProperty(document, "compatMode", {
    configurable: true,
    value: "CSS1Compat",
  });
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1200,
  });
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { search: "", href: "https://ytriple.test/" },
  });
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => undefined,
  });
  const storage = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
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
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  const click = async (element: Element | null | undefined) => {
    assert.ok(element, "requested control exists");
    await act(async () => {
      element.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
  };
  const choose = async (value: string) => {
    const select = document.querySelector('[aria-label="Skill 选择方式"]')!;
    assert.ok(select);
    for (const option of select.querySelectorAll("option"))
      option.removeAttribute("selected");
    select
      .querySelector(`option[value="${value}"]`)!
      .setAttribute("selected", "");
    await act(async () => {
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
  };
  const check = async (name: string, value = true) => {
    const input = document.querySelector(
      `[aria-label="使用 ${name}"]`,
    ) as HTMLInputElement;
    assert.ok(input);
    input.checked = value;
    await click(input);
  };
  try {
    await run({
      document: document as unknown as Document,
      window: window as unknown as Window & typeof globalThis,
      root,
      act,
      createElement,
      click,
      choose,
      check,
    });
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test("new work sends the selected method policy in the actual task creation command", async () => {
  await withDom(
    async ({
      document,
      window,
      root,
      act,
      createElement,
      click,
      choose,
      check,
    }) => {
      let current = snapshotFixture("creation");
      const commands: Command[] = [];
      window.ytriple = {
        subscribe: () => () => undefined,
        invoke: async (command) => {
          commands.push(command);
          if (command.type === "task.create")
            current = {
              ...current,
              tasks: [
                {
                  ...taskFixture("created"),
                  goal: command.goal,
                  skillPolicy: command.skillPolicy,
                },
                ...current.tasks,
              ],
            };
          return structuredClone(current);
        },
      };
      const { App } = await import("../src/workbench/App.js");
      await act(async () => root.render(createElement(App)));
      const home = document.querySelector<HTMLElement>(".home-host")!;
      assert.equal(home.hidden, false);
      assert.ok(
        !commands.some(
          (command) =>
            command.type === "task.create" || command.type === "task.run",
        ),
      );
      const textarea = home.querySelector<HTMLTextAreaElement>("textarea")!;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      assert.ok(setter);
      await act(async () => {
        setter.call(textarea, "消化现有资料并核查脚本依据。");
        textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
      await click(home.querySelector(".work-skills summary"));
      await choose("explicit");
      assert.equal(
        document
          .querySelector('.home-host [aria-label="开始工作"]')
          ?.hasAttribute("disabled"),
        true,
      );
      await check("资料消化");
      await check("脚本核查");
      assert.equal(
        document
          .querySelector('.home-host [aria-label="开始工作"]')
          ?.hasAttribute("disabled"),
        false,
      );
      await act(async () => {
        document
          .querySelector(".home-host form.composer")!
          .dispatchEvent(
            new window.Event("submit", { bubbles: true, cancelable: true }),
          );
      });
      const created = commands.find(
        (command) => command.type === "task.create",
      );
      assert.ok(created?.type === "task.create");
      assert.equal(created.goal, "消化现有资料并核查脚本依据。");
      assert.deepEqual(created.skillPolicy, {
        mode: "explicit",
        skillIds: ["material-digest", "script-review"],
      });
      assert.ok(commands.some((command) => command.type === "task.run"));
    },
  );
});

test("task skill drafts survive switching and a delayed save, preserving boundary rules", async () => {
  await withDom(
    async ({ document, root, act, createElement, click, choose, check }) => {
      const { TaskSkills } = await import("../src/workbench/Skills.js");
      const snapshot = snapshotFixture("task-draft");
      let first = taskFixture("first");
      const second = taskFixture("second");
      const commands: Command[] = [];
      let resolve!: (snapshot: Snapshot | null) => void;
      const dispatch = async (command: Command) => {
        commands.push(command);
        return new Promise<Snapshot | null>((done) => {
          resolve = done;
        });
      };
      const render = async (task: Task | null) =>
        act(async () =>
          root.render(
            task
              ? createElement(TaskSkills, {
                  task,
                  snapshot,
                  dispatch,
                  connected: true,
                })
              : null,
          ),
        );
      await render(first);
      await choose("explicit");
      await check("制作交接");
      await render(second);
      assert.equal(
        (
          document.querySelector(
            '[aria-label="Skill 选择方式"]',
          ) as HTMLSelectElement
        ).value,
        "auto",
      );
      await render(first);
      assert.equal(
        (
          document.querySelector(
            '[aria-label="使用 制作交接"]',
          ) as HTMLInputElement
        ).checked,
        true,
      );
      const save = () =>
        Array.from(document.querySelectorAll("button")).find(
          (button) => button.textContent === "保存方法选择",
        );
      await click(save());
      assert.deepEqual(commands[0], {
        type: "task.setSkills",
        taskId: first.id,
        policy: { mode: "explicit", skillIds: ["handoff-review"] },
      });
      await render(null);
      await render(first);
      assert.equal(
        document.querySelector("fieldset")?.hasAttribute("disabled"),
        true,
        "a remount cannot duplicate a pending update",
      );
      await act(async () => resolve(null));
      assert.ok(save(), "failed saves retain the choice");
      await click(save());
      first = {
        ...first,
        skillPolicy: { mode: "explicit", skillIds: ["handoff-review"] },
      };
      await render(null);
      await act(async () => resolve({ ...snapshot, tasks: [first] }));
      await render(first);
      assert.equal(
        save(),
        undefined,
        "successful unmounted save clears only the submitted draft",
      );
      for (const status of ["running", "waiting"] as const) {
        await render({ ...first, status });
        assert.equal(
          document.querySelector("fieldset")?.hasAttribute("disabled"),
          true,
        );
        assert.match(document.body.textContent!, /先暂停工作/);
      }
      await render(first);
      await choose("off");
      assert.ok(save());
      await click(save());
      assert.deepEqual(commands.at(-1), {
        type: "task.setSkills",
        taskId: first.id,
        policy: { mode: "off", skillIds: [] },
      });
      await act(async () => resolve(null));
    },
  );
});

test("asset catalog exposes the full method and toggle command; binding alone is not usage", async () => {
  await withDom(async ({ document, root, act, createElement, click }) => {
    const { Library } = await import("../src/workbench/Library.js");
    const { ProcessView } = await import("../src/workbench/ProcessView.js");
    const snapshot = snapshotFixture("catalog");
    const task = { ...taskFixture("evidence"), skillBindings: [methods[0]!] };
    const commands: Command[] = [];
    const dispatch = async (command: Command) => {
      commands.push(command);
      return snapshot;
    };
    await act(async () =>
      root.render(
        createElement(Library, {
          snapshot,
          dispatch,
          onTask: () => undefined,
          onAdd: () => undefined,
          selectedTaskId: null,
        }),
      ),
    );
    assert.ok(document.querySelector('[aria-label="搜索本地资产"]'));
    assert.equal(document.querySelector(".portable-panel"), null);
    assert.equal(document.querySelector(".skill-import-tools"), null);
    await click(
      [...document.querySelectorAll("button")].find(
        (button) => button.textContent === "备份与恢复",
      ),
    );
    assert.ok(document.querySelector('[aria-label="资产管理"]'));
    assert.ok(
      document.querySelector(".portable-form")!.closest("[hidden]"),
      "backup management has a single visible operation surface",
    );
    await click(document.querySelector('[aria-label="关闭资产管理"]'));
    assert.equal(document.querySelector(".portable-panel"), null);
    await click(
      Array.from(document.querySelectorAll(".library-tabbar button")).find(
        (button) => button.textContent?.startsWith("Skills"),
      ),
    );
    assert.equal(
      document.querySelector(".skill-card"),
      null,
      "the method directory is a list, not a stack of full configuration cards",
    );
    await click(document.querySelector('[aria-label="查看 资料消化"]'));
    assert.match(
      document.querySelector('[aria-label="Skill 资产"]')!.textContent!,
      /方法正文：区分来源证据和未验证判断/,
    );
    assert.match(
      document.querySelector(".skill-card")!.textContent!,
      /内置 · v1.0.0 · 待验证/,
    );
    assert.match(
      document.querySelector(".skill-card")!.textContent!,
      /还没有实际加载证据/,
    );
    await click(document.querySelector('[aria-label="停用 资料消化"]'));
    assert.deepEqual(commands.at(-1), {
      type: "skill.setEnabled",
      skillId: "material-digest",
      enabled: false,
    });
    await act(async () =>
      root.render(createElement(ProcessView, { task, dispatch })),
    );
    assert.equal(
      document.querySelector('[aria-label="实际加载的 Skills"]'),
      null,
      "binding is only eligibility",
    );
    const event = {
      id: "loaded",
      type: "skill_loaded",
      member: "researcher" as const,
      summary: "读取方法正文",
      createdAt: task.createdAt,
      goalVersion: 1,
      data: {
        skillId: methods[0]!.id,
        name: methods[0]!.name,
        version: "1.0.0",
        hash: methods[0]!.hash,
        purpose: "为当前资料归纳证据",
        sourceIds: ["candidate-source"],
      },
    };
    await act(async () =>
      root.render(
        createElement(ProcessView, {
          task: { ...task, events: [event] },
          dispatch,
        }),
      ),
    );
    const usage = document.querySelector('[aria-label="实际加载的 Skills"]')!;
    assert.match(usage.textContent!, /资料消化/);
    assert.match(usage.textContent!, /v1.0.0 · 研究员/);
    assert.match(usage.textContent!, /为当前资料归纳证据/);
    assert.match(usage.textContent!, /资料读取、工具执行、成果与验证另看/);
    await act(async () =>
      root.render(
        createElement(ProcessView, {
          task: { ...task, goalVersion: 2, events: [event] },
          dispatch,
        }),
      ),
    );
    const scope = document.querySelector<HTMLSelectElement>(
      '[aria-label="过程范围"]',
    )!;
    Object.defineProperty(scope, "value", {
      value: "goal",
      writable: true,
      configurable: true,
    });
    await act(async () =>
      scope.dispatchEvent(new window.Event("change", { bubbles: true })),
    );
    assert.equal(
      document.querySelector('[aria-label="实际加载的 Skills"]'),
      null,
      "previous goal use is excluded when the user selects the current goal",
    );
  });
});

test("method selection enforces the limit and lets a disabled saved choice be removed", async () => {
  await withDom(
    async ({ document, root, act, createElement, choose, check }) => {
      const { useState } = await import("react");
      const { SkillPolicyPicker, validSkillSelection } =
        await import("../src/workbench/Skills.js");
      const catalog = [
        ...methods,
        { ...methods[0]!, id: "fourth", name: "合成第四方法" },
      ];
      function Harness() {
        const [policy, setPolicy] = useState<
          import("../src/shared/skills.js").SkillPolicy
        >({ mode: "auto", skillIds: [] });
        return createElement(SkillPolicyPicker, {
          policy,
          catalog,
          onChange: setPolicy,
        });
      }
      await act(async () => root.render(createElement(Harness)));
      await choose("explicit");
      for (const skill of methods) await check(skill.name);
      assert.equal(
        document
          .querySelector('[aria-label="使用 合成第四方法"]')
          ?.hasAttribute("disabled"),
        true,
      );
      await check("资料消化", false);
      assert.equal(
        document
          .querySelector('[aria-label="使用 合成第四方法"]')
          ?.hasAttribute("disabled"),
        false,
      );
      const disabledCatalog = methods.map((skill) => ({
        ...skill,
        enabled: skill.id !== "material-digest",
      }));
      const policy = {
        mode: "explicit" as const,
        skillIds: ["material-digest"],
      };
      let updated: import("../src/shared/skills.js").SkillPolicy | undefined;
      await act(async () =>
        root.render(
          createElement(SkillPolicyPicker, {
            policy,
            catalog: disabledCatalog,
            onChange: (value) => {
              updated = value;
            },
          }),
        ),
      );
      assert.equal(validSkillSelection(policy, disabledCatalog), false);
      assert.equal(
        document
          .querySelector('[aria-label="使用 资料消化"]')
          ?.hasAttribute("disabled"),
        false,
        "a saved disabled method must remain removable",
      );
      assert.match(document.body.textContent!, /已停用或不可用/);
      await check("资料消化", false);
      assert.deepEqual(updated, { mode: "explicit", skillIds: [] });
      assert.equal(validSkillSelection(updated!, disabledCatalog), false);
      assert.equal(
        validSkillSelection({ mode: "off", skillIds: [] }, disabledCatalog),
        true,
      );
    },
  );
});
