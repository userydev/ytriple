import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import type { Command, Snapshot, LibraryEntry } from "../src/shared/types.js";
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

function entryFixture(id: string): LibraryEntry {
  return {
    id,
    title: "深度阅读方法",
    format: "md",
    path: `/unused/AI/knowledge/lib/${id}.md`,
    content: "# 深度阅读方法\n旧正文",
    hash: "a".repeat(64),
    version: 1,
    tags: [],
    note: "",
    savedAt: "2026-09-12T10:00:00Z",
    updatedAt: "2026-09-12T10:00:00Z",
    versions: [],
    feedback: [],
    feedbackRevision: 0,
    source: {
      taskId: "origin",
      taskTitle: "原工作",
      artifactId: "artifact-1",
      artifactVersion: 1,
      artifactHash: "a".repeat(64),
      goalVersion: 1,
    },
  };
}
function snapshotFixture(entry: LibraryEntry): Snapshot {
  return {
    version: "test",
    dataPath: "/unused",
    tasks: [],
    profiles: [],
    settings: {
      aiRoot: "/unused/AI",
      codeRoot: "/unused/Code",
      workspaceRoot: "/unused/work",
      defaultProfileId: "",
      memberProfiles: { coordinator: "", researcher: "", cto: "" },
    },
    system: {
      state: "ready",
      aiRoot: "/unused/AI",
      codeRoot: "/unused/Code",
      policyPath: "/unused/AI/system/POLICY.md",
      issues: [],
    },
    projects: [],
    library: [entry],
  };
}

test("feedback draft and pending state survive remount; failures and version changes preserve user corrections", async () =>
  withDom(async ({ document, root, act, createElement, input, click }) => {
    const { LibraryFeedbackPanel } =
      await import("../src/workbench/LibraryFeedback.js");
    const entry = entryFixture("feedback-remount"),
      snapshot = snapshotFixture(entry);
    const requests: Command[] = [];
    const response = deferred<Snapshot | null>();
    const render = async (current = entry) =>
      act(async () => {
        root.render(
          createElement(LibraryFeedbackPanel, {
            entry: current,
            snapshot,
            selectedTaskId: null,
            dispatch: async (command) => {
              requests.push(command);
              return response.promise;
            },
            onContinue() {},
          }),
        );
      });
    await render();
    await act(async () => click("修正判断"));
    await act(async () =>
      input(
        document.querySelector("textarea[aria-label='反馈内容']")!,
        "新手应每二十分钟做理解检查",
      ),
    );
    await act(async () => root.render(createElement("p", null, "另一项工作")));
    await render();
    assert.equal(
      document.querySelector<HTMLTextAreaElement>(
        "textarea[aria-label='反馈内容']",
      )!.value,
      "新手应每二十分钟做理解检查",
    );
    await act(async () => click("记录到这项资产"));
    assert.equal(requests.length, 1);
    await act(async () => root.render(createElement("p", null, "离开反馈")));
    await render();
    assert.equal(
      document
        .querySelector<HTMLFieldSetElement>("fieldset")!
        .hasAttribute("disabled"),
      true,
    );
    await act(async () => click("记录中…"));
    assert.equal(
      requests.length,
      1,
      "repeat submission is blocked after remount",
    );
    await act(async () => response.resolve(null));
    assert.equal(
      document
        .querySelector<HTMLFieldSetElement>("fieldset")!
        .hasAttribute("disabled"),
      false,
    );
    assert.match(document.querySelector("[role=alert]")!.textContent!, /保留/);
    await render({
      ...entry,
      hash: "b".repeat(64),
      version: 2,
      feedbackRevision: 1,
    });
    assert.match(document.body.textContent!, /资产或反馈已更新/);
    assert.ok(
      Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "记录到这项资产",
      )!.disabled,
    );
    assert.equal(
      document.querySelector<HTMLTextAreaElement>(
        "textarea[aria-label='反馈内容']",
      )!.value,
      "新手应每二十分钟做理解检查",
    );
    await act(async () => click("已核对，按当前版本记录"));
    assert.ok(
      !Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "记录到这项资产",
      )!.disabled,
    );
    await act(async () => click("取消"));
  }));

test("successful feedback clears the submitted draft while unmounted and keeps the asset association", async () =>
  withDom(async ({ document, root, act, createElement, input, click }) => {
    const { LibraryFeedbackPanel } =
      await import("../src/workbench/LibraryFeedback.js");
    const entry = entryFixture("feedback-success"),
      snapshot = snapshotFixture(entry),
      response = deferred<Snapshot | null>();
    let request: Command | undefined;
    const render = async () =>
      act(async () =>
        root.render(
          createElement(LibraryFeedbackPanel, {
            entry,
            snapshot,
            selectedTaskId: null,
            dispatch: async (command) => {
              request = command;
              return response.promise;
            },
            onContinue() {},
          }),
        ),
      );
    await render();
    await act(async () => click("修正判断"));
    await act(async () =>
      input(document.querySelector("textarea")!, "限定在新手阅读条件下"),
    );
    await act(async () => click("记录到这项资产"));
    assert.equal(request?.type, "library.feedback");
    if (request?.type !== "library.feedback")
      throw new Error("feedback request missing");
    assert.equal(request.entryId, entry.id);
    assert.equal(request.expectedHash, entry.hash);
    await act(async () => root.render(createElement("p", null, "其他页面")));
    await act(async () => response.resolve(snapshot));
    await render();
    assert.equal(document.querySelector("textarea"), null);
    assert.match(document.body.textContent!, /尚无使用证据/);
  }));

test("Lib saving locks the remounted editor and clears the submitted draft", async () =>
  withDom(async ({ document, root, act, createElement, input, click }) => {
    const { Library } = await import("../src/workbench/Library.js");
    const entry = entryFixture("lib-edit-remount"),
      snapshot = snapshotFixture(entry),
      response = deferred<Snapshot | null>();
    let request: Command | undefined;
    const render = async (current = snapshot) =>
      act(async () =>
        root.render(
          createElement(Library, {
            snapshot: current,
            initialEntryId: entry.id,
            selectedTaskId: null,
            dispatch: async (command) => {
              request = command;
              return response.promise;
            },
            onTask() {},
            onAdd() {},
          }),
        ),
      );
    await render();
    await act(async () => click("修改收藏"));
    await act(async () =>
      input(
        document.querySelector("textarea[aria-label='收藏正文编辑']")!,
        "# 新正文\n二十分钟检查",
      ),
    );
    await act(async () => click("保存资产"));
    assert.equal(request?.type, "library.save");
    await act(async () => root.render(createElement("p", null, "其他页面")));
    await render();
    assert.equal(
      document
        .querySelector<HTMLFieldSetElement>(".library-edit-fields")!
        .hasAttribute("disabled"),
      true,
    );
    await act(async () =>
      response.resolve({
        ...snapshot,
        library: [
          {
            ...entry,
            content: "# 新正文\n二十分钟检查",
            hash: "b".repeat(64),
            version: 2,
          },
        ],
      }),
    );
    await act(async () => root.render(createElement("p", null, "其他页面")));
    await render({
      ...snapshot,
      library: [
        {
          ...entry,
          content: "# 新正文\n二十分钟检查",
          hash: "b".repeat(64),
          version: 2,
        },
      ],
    });
    assert.equal(
      document.querySelector("textarea[aria-label='收藏正文编辑']"),
      null,
    );
    assert.match(document.body.textContent!, /二十分钟检查/);
  }));
