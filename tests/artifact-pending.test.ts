import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import type { Command, Snapshot, Task } from "../src/shared/types.js";

function fixture(id: string): Task {
  return {
    id,
    title: "异步成果交互",
    goal: "合成回归测试",
    goalVersion: 1,
    kind: "research",
    member: "coordinator",
    status: "completed",
    workspace: "/unused",
    createdAt: "2026-09-11T12:00:00Z",
    updatedAt: "2026-09-11T12:00:00Z",
    messages: [],
    events: [],
    sources: [],
    artifacts: [
      {
        id: `${id}-document`,
        title: "方案说明",
        format: "md",
        content: "# 初稿\n\n原始正文。",
        hash: "original-hash",
        path: "/unused/note.md",
        version: 1,
        goalVersion: 1,
        versions: [],
        updatedAt: "2026-09-11T12:00:00Z",
      },
    ],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
type Dom = {
  document: Document;
  window: Window & typeof globalThis;
  root: import("react-dom/client").Root;
  act: typeof import("react").act;
  createElement: typeof import("react").createElement;
  input: (element: HTMLTextAreaElement, value: string) => void;
  click: (label: string) => void;
};
async function withDom(run: (context: Dom) => Promise<void>) {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id='root'></div></body></html>",
  );
  Object.defineProperty(document, "compatMode", {
    value: "CSS1Compat",
    configurable: true,
  });
  Object.defineProperty(document, "oninput", {
    value: null,
    configurable: true,
  });
  // React initializes textareas through defaultValue. LinkeDOM omits that
  // browser property, so provide its initial-value reflection for remount tests.
  const textarea = window.HTMLTextAreaElement.prototype;
  const originalValue = Object.getOwnPropertyDescriptor(textarea, "value")!;
  const originalDefault = Object.getOwnPropertyDescriptor(
    textarea,
    "defaultValue",
  );
  const values = new WeakMap<object, string>(),
    defaults = new WeakMap<object, string>();
  Object.defineProperty(textarea, "value", {
    configurable: true,
    get() {
      return values.get(this) ?? originalValue.get!.call(this);
    },
    set(value: string) {
      values.set(this, String(value));
      originalValue.set!.call(this, value);
    },
  });
  Object.defineProperty(textarea, "defaultValue", {
    configurable: true,
    get() {
      return defaults.get(this) ?? originalValue.get!.call(this);
    },
    set(value: string) {
      defaults.set(this, String(value));
      if (!values.has(this)) originalValue.set!.call(this, value);
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
      value,
      configurable: true,
      writable: true,
    });
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  const click = (label: string) => {
    const element = Array.from(document.querySelectorAll("button")).find(
      (button) =>
        button.textContent?.trim() === label ||
        button.getAttribute("aria-label") === label,
    );
    assert.ok(element, `button ${label} is present`);
    element.dispatchEvent(new window.Event("click", { bubbles: true }));
  };
  const input = (element: HTMLTextAreaElement, value: string) => {
    // Invoke the browser property's setter without React's value tracker, then
    // dispatch the same input event produced by typing into an enabled textarea.
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    assert.ok(setter);
    setter.call(element, value);
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
  };
  try {
    await run({
      document: document as unknown as Document,
      window: window as unknown as Window & typeof globalThis,
      root,
      act,
      createElement,
      input,
      click,
    });
  } finally {
    await act(async () => root.unmount());
    Object.defineProperty(textarea, "value", originalValue);
    if (originalDefault)
      Object.defineProperty(textarea, "defaultValue", originalDefault);
    else Reflect.deleteProperty(textarea, "defaultValue");
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test("artifact save disables editing and cancellation until the saved document returns", async () =>
  withDom(async ({ document, root, act, createElement, input, click }) => {
    const { ArtifactView, discardTaskArtifactDrafts } =
      await import("../src/workbench/Artifacts.js");
    const { useState } = await import("react");
    const initial = fixture("save-pending"),
      saved = deferred<Snapshot | null>();
    const commands: Command[] = [];
    function Harness() {
      const [task, setTask] = useState(initial);
      return createElement(ArtifactView, {
        task,
        artifact: task.artifacts[0],
        dispatch: async (command) => {
          commands.push(command);
          const result = await saved.promise;
          if (result?.tasks[0]) setTask(result.tasks[0]);
          return result;
        },
      });
    }
    await act(async () => root.render(createElement(Harness)));
    await act(async () => click("编辑"));
    const editor =
      document.querySelector<HTMLTextAreaElement>(".artifact-editor")!;
    const revised = "# 已修订\n\n提交前完成的正文。";
    await act(async () => input(editor, revised));
    await act(async () => click("保存修改"));
    assert.deepEqual(commands, [
      {
        type: "artifact.save",
        taskId: initial.id,
        artifactId: initial.artifacts[0].id,
        content: revised,
        expectedHash: "original-hash",
      },
    ]);
    assert.equal(editor.disabled, true);
    const cancel = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "取消",
    )!;
    assert.equal(cancel.disabled, true);
    await act(async () => {
      click("保存中");
      click("取消");
    });
    assert.equal(commands.length, 1);
    assert.equal(document.querySelector(".artifact-editor"), editor);
    assert.equal(editor.value, revised);
    const next = structuredClone(initial);
    next.artifacts[0] = {
      ...next.artifacts[0],
      content: revised,
      hash: "saved-hash",
      version: 2,
    };
    await act(async () => saved.resolve({ tasks: [next] } as Snapshot));
    assert.equal(document.querySelector(".artifact-editor"), null);
    assert.equal(
      document.querySelector(".artifact-view .markdown h1")?.textContent,
      "已修订",
    );
    assert.match(
      document.querySelector(".artifact-view .markdown")!.textContent!,
      /提交前完成的正文/,
    );
    discardTaskArtifactDrafts(initial.id);
  }));

test("artifact refinement locks its inputs and controls while pending and retains instructions on failure", async () =>
  withDom(
    async ({ document, window, root, act, createElement, input, click }) => {
      const { ArtifactView, discardTaskArtifactDrafts } =
        await import("../src/workbench/Artifacts.js");
      const task = fixture("refine-pending"),
        pending = deferred<Snapshot | null>();
      const commands: Command[] = [];
      await act(async () =>
        root.render(
          createElement(ArtifactView, {
            task,
            artifact: task.artifacts[0],
            dispatch: async (command) => {
              commands.push(command);
              return pending.promise;
            },
          }),
        ),
      );
      await act(async () => click("继续加工"));
      const editor = document.querySelector<HTMLTextAreaElement>(
        ".refine-form textarea",
      )!;
      const instruction = "保留结论，补充两条反方观点。\n";
      await act(async () => input(editor, instruction));
      const form = document.querySelector(".refine-form")!;
      await act(async () =>
        form.dispatchEvent(
          new window.Event("submit", { bubbles: true, cancelable: true }),
        ),
      );
      assert.deepEqual(commands, [
        {
          type: "artifact.refine",
          taskId: task.id,
          artifactId: task.artifacts[0].id,
          instruction: instruction.trim(),
          expectedHash: "original-hash",
        },
      ]);
      assert.equal(editor.disabled, true);
      for (const label of ["编辑", "继续加工", "正在交给团队…"]) {
        const button = Array.from(document.querySelectorAll("button")).find(
          (item) => item.textContent?.trim() === label,
        )!;
        assert.ok(button, label);
        assert.equal(
          button.disabled,
          true,
          `${label} must be disabled while submitting`,
        );
      }
      await act(async () => {
        click("编辑");
        click("继续加工");
        click("正在交给团队…");
        form.dispatchEvent(
          new window.Event("submit", { bubbles: true, cancelable: true }),
        );
      });
      assert.equal(commands.length, 1);
      assert.equal(document.querySelector(".refine-form textarea"), editor);
      assert.equal(document.querySelector(".artifact-editor"), null);
      await act(async () => pending.resolve(null));
      assert.equal(editor.disabled, false);
      assert.equal(
        editor.value,
        instruction,
        "unsuccessful dispatch retains the complete original instruction",
      );
      assert.ok(document.querySelector(".refine-form"));
      const toggle = Array.from(document.querySelectorAll("button")).find(
        (item) => item.textContent?.trim() === "继续加工",
      )!;
      assert.equal(toggle.disabled, false);
      assert.equal(toggle.getAttribute("aria-expanded"), "true");
      discardTaskArtifactDrafts(task.id);
    },
  ));

for (const returnWhilePending of [false, true]) {
  test(`a saved draft cannot revive after leaving its pane${returnWhilePending ? " and returning while pending" : " until success"}`, async () =>
    withDom(async ({ document, root, act, createElement, input, click }) => {
      const { ArtifactView, discardTaskArtifactDrafts } =
        await import("../src/workbench/Artifacts.js");
      const { useState } = await import("react");
      const task = fixture(`save-remount-${returnWhilePending}`),
        first = deferred<Snapshot | null>(),
        retry = deferred<Snapshot | null>();
      const commands: Command[] = [];
      let navigate!: (visible: boolean) => void;
      function Harness() {
        const [current, setCurrent] = useState(task),
          [visible, setVisible] = useState(true);
        navigate = setVisible;
        return visible
          ? createElement(ArtifactView, {
              task: current,
              artifact: current.artifacts[0],
              dispatch: async (command) => {
                commands.push(command);
                const result = await (commands.length === 1
                  ? first.promise
                  : retry.promise);
                if (result?.tasks[0]) setCurrent(result.tasks[0]);
                return result;
              },
            })
          : createElement("div", null, "另一个工作页面");
      }
      await act(async () => root.render(createElement(Harness)));
      await act(async () => click("编辑"));
      const body = "# 保存后的正文\n\n离开页面也要完整保存。";
      await act(async () =>
        input(
          document.querySelector<HTMLTextAreaElement>(".artifact-editor")!,
          body,
        ),
      );
      await act(async () => click("保存修改"));
      await act(async () => navigate(false));
      assert.equal(document.querySelector(".artifact-view"), null);
      if (returnWhilePending) {
        await act(async () => navigate(true));
        const editor =
          document.querySelector<HTMLTextAreaElement>(".artifact-editor")!;
        assert.ok(editor);
        assert.equal(editor.value, body);
        assert.equal(editor.disabled, true);
        await act(async () => {
          click("保存中");
          click("取消");
        });
        assert.equal(commands.length, 1);
        assert.equal(document.querySelector(".artifact-editor"), editor);
      }
      const updated = structuredClone(task);
      updated.artifacts[0] = {
        ...updated.artifacts[0],
        content: body,
        hash: "saved-version-two",
        version: 2,
      };
      await act(async () => first.resolve({ tasks: [updated] } as Snapshot));
      if (!returnWhilePending) await act(async () => navigate(true));
      assert.equal(document.querySelector(".artifact-editor"), null);
      assert.equal(
        document.querySelector(".artifact-view .markdown h1")?.textContent,
        "保存后的正文",
      );
      assert.doesNotMatch(
        document.querySelector(".artifact-view")!.textContent!,
        /原文已有新版本/,
      );
      await act(async () => navigate(false));
      await act(async () => navigate(true));
      assert.equal(
        document.querySelector(".artifact-editor"),
        null,
        "later remounts must not restore the completed draft",
      );
      await act(async () => click("编辑"));
      assert.equal(
        document.querySelector<HTMLTextAreaElement>(".artifact-editor")?.value,
        body,
      );
      await act(async () =>
        input(
          document.querySelector<HTMLTextAreaElement>(".artifact-editor")!,
          body + "\n第二次编辑。",
        ),
      );
      await act(async () => click("保存修改"));
      const command = commands.at(-1)!;
      assert.equal(command.type, "artifact.save");
      if (command.type === "artifact.save")
        assert.equal(
          command.expectedHash,
          "saved-version-two",
          "new editing must start from the saved revision",
        );
      await act(async () => retry.resolve(null));
      await act(async () => discardTaskArtifactDrafts(task.id));
    }));

  test(`successful refinement clears old instructions after leaving its pane${returnWhilePending ? " and returning while pending" : " until success"}`, async () =>
    withDom(
      async ({ document, window, root, act, createElement, input, click }) => {
        const { ArtifactView, discardTaskArtifactDrafts } =
          await import("../src/workbench/Artifacts.js");
        const { useState } = await import("react");
        const task = fixture(`refine-remount-${returnWhilePending}`),
          first = deferred<Snapshot | null>(),
          retry = deferred<Snapshot | null>();
        const commands: Command[] = [];
        let navigate!: (visible: boolean) => void;
        function Harness() {
          const [current, setCurrent] = useState(task),
            [visible, setVisible] = useState(true);
          navigate = setVisible;
          return visible
            ? createElement(ArtifactView, {
                task: current,
                artifact: current.artifacts[0],
                dispatch: async (command) => {
                  commands.push(command);
                  const result = await (commands.length === 1
                    ? first.promise
                    : retry.promise);
                  if (result?.tasks[0]) setCurrent(result.tasks[0]);
                  return result;
                },
              })
            : createElement("div", null, "另一个工作页面");
        }
        const submit = async () =>
          act(async () =>
            document
              .querySelector(".refine-form")!
              .dispatchEvent(
                new window.Event("submit", { bubbles: true, cancelable: true }),
              ),
          );
        await act(async () => root.render(createElement(Harness)));
        await act(async () => click("继续加工"));
        const instruction = "保留已经确认的结论，增加反方观点。\n";
        await act(async () =>
          input(
            document.querySelector<HTMLTextAreaElement>(
              ".refine-form textarea",
            )!,
            instruction,
          ),
        );
        await submit();
        await act(async () => navigate(false));
        if (returnWhilePending) {
          await act(async () => navigate(true));
          const editor = document.querySelector<HTMLTextAreaElement>(
            ".refine-form textarea",
          )!;
          assert.equal(editor.value, instruction);
          assert.equal(editor.disabled, true);
          await act(async () => {
            click("编辑");
            click("继续加工");
          });
          await submit();
          assert.equal(commands.length, 1);
          assert.equal(document.querySelector(".refine-form textarea"), editor);
        }
        const updated = structuredClone(task);
        updated.artifacts[0] = {
          ...updated.artifacts[0],
          content: "# 加工后的正文",
          hash: "refined-version-two",
          version: 2,
        };
        await act(async () => first.resolve({ tasks: [updated] } as Snapshot));
        if (!returnWhilePending) await act(async () => navigate(true));
        assert.equal(document.querySelector(".refine-form"), null);
        await act(async () => navigate(false));
        await act(async () => navigate(true));
        assert.equal(
          document.querySelector(".refine-form"),
          null,
          "finished instructions must not be resurrected from the cache",
        );
        await act(async () => click("继续加工"));
        const editor = document.querySelector<HTMLTextAreaElement>(
          ".refine-form textarea",
        )!;
        assert.equal(editor.value, "");
        await submit();
        assert.equal(
          commands.length,
          1,
          "the old instruction must not silently resubmit",
        );
        await act(async () => input(editor, "新的加工要求。"));
        await submit();
        const command = commands.at(-1)!;
        assert.equal(command.type, "artifact.refine");
        if (command.type === "artifact.refine") {
          assert.equal(command.expectedHash, "refined-version-two");
          assert.equal(command.instruction, "新的加工要求。");
        }
        await act(async () => retry.resolve(null));
        await act(async () => discardTaskArtifactDrafts(task.id));
      },
    ));
}

for (const action of ["save", "refine"] as const) {
  test(`a failed ${action} reply while unmounted retains input and the original version for retry`, async () =>
    withDom(
      async ({ document, window, root, act, createElement, input, click }) => {
        const { ArtifactView, discardTaskArtifactDrafts } =
          await import("../src/workbench/Artifacts.js");
        const task = fixture(`failure-remount-${action}`),
          pending = deferred<Snapshot | null>();
        const commands: Command[] = [];
        const render = () =>
          createElement(ArtifactView, {
            task,
            artifact: task.artifacts[0],
            dispatch: async (command: Command) => {
              commands.push(command);
              return pending.promise;
            },
          });
        const selector =
          action === "save" ? ".artifact-editor" : ".refine-form textarea";
        const submit = async () =>
          act(async () => {
            if (action === "save") click("保存修改");
            else
              document.querySelector(".refine-form")!.dispatchEvent(
                new window.Event("submit", {
                  bubbles: true,
                  cancelable: true,
                }),
              );
          });
        await act(async () => root.render(render()));
        await act(async () => click(action === "save" ? "编辑" : "继续加工"));
        const original = "这段输入在失败后也必须保留。\n\n";
        await act(async () =>
          input(
            document.querySelector<HTMLTextAreaElement>(selector)!,
            original,
          ),
        );
        await submit();
        await act(async () => root.render(null));
        await act(async () => pending.resolve(null));
        await act(async () => root.render(render()));
        const editor = document.querySelector<HTMLTextAreaElement>(selector)!;
        assert.ok(editor);
        assert.equal(editor.disabled, false);
        assert.equal(editor.value, original);
        assert.doesNotMatch(
          document.querySelector(".artifact-view")!.textContent!,
          /原文已有新版本/,
        );
        await submit();
        assert.equal(commands.length, 2);
        const command = commands[1];
        assert.ok(
          command.type === "artifact.save" ||
            command.type === "artifact.refine",
        );
        assert.equal(command.expectedHash, "original-hash");
        if (command.type === "artifact.save")
          assert.equal(command.content, original);
        else assert.equal(command.instruction, original.trim());
        await act(async () => discardTaskArtifactDrafts(task.id));
      },
    ));
}
