import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import type { PortableCommand } from "../src/shared/portable.js";

async function domTest(
  run: (ctx: {
    document: Document;
    window: Window & typeof globalThis;
    root: import("react-dom/client").Root;
    act: typeof import("react").act;
    h: typeof import("react").createElement;
  }) => Promise<void>,
) {
  const dom = parseHTML(
    "<!doctype html><html><body><div id='root'></div></body></html>",
  );
  const textarea = dom.window.HTMLTextAreaElement.prototype;
  const originalValue = Object.getOwnPropertyDescriptor(textarea, "value")!;
  const originalDefault = Object.getOwnPropertyDescriptor(
    textarea,
    "defaultValue",
  );
  const edited = new WeakSet<object>();
  Object.defineProperty(textarea, "value", {
    configurable: true,
    get() {
      return originalValue.get!.call(this);
    },
    set(next: string) {
      edited.add(this);
      originalValue.set!.call(this, next);
    },
  });
  Object.defineProperty(textarea, "defaultValue", {
    configurable: true,
    get() {
      return originalValue.get!.call(this);
    },
    set(next: string) {
      if (!edited.has(this)) originalValue.set!.call(this, next);
    },
  });
  const replacements = {
    window: dom.window,
    document: dom.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
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
  const { act, createElement: h } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.document.getElementById("root")!);
  try {
    await run({
      document: dom.document as unknown as Document,
      window: dom.window as unknown as Window & typeof globalThis,
      root,
      act,
      h,
    });
  } finally {
    await act(async () => root.unmount());
    Object.defineProperty(textarea, "value", originalValue);
    if (originalDefault)
      Object.defineProperty(textarea, "defaultValue", originalDefault);
    else Reflect.deleteProperty(textarea, "defaultValue");
    for (const [key, original] of previous) {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}
const findButton = (document: Document, title: string) => {
  const button = [...document.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === title,
  );
  assert.ok(button, title);
  return button;
};

test("Radar import mode keeps backups out and requires an explicit checkbox for public-page reads", async () => {
  await domTest(async ({ document, window, root, act, h }) => {
    const { PortablePanel } = await import("../src/workbench/Portable.js");
    const commands: PortableCommand[] = [];
    let finish!: (value: null) => void;
    const dispatch = async (command: PortableCommand) => {
      commands.push(command);
      return new Promise<null>((resolve) => {
        finish = resolve;
      });
    };
    await act(async () =>
      root.render(
        h(PortablePanel, {
          snapshot: {
            tasks: [],
            portable: {
              backups: [
                {
                  id: "backup",
                  path: "/tmp/backup.json",
                  createdAt: "2026-09-13",
                  tasks: 1,
                  assets: 1,
                  bytes: 1,
                },
              ],
              restores: [],
              imports: [],
            },
          },
          dispatch,
          mode: "imports",
        }),
      ),
    );
    assert.match(document.body.textContent!, /导入收藏与材料/);
    assert.doesNotMatch(
      document.body.textContent!,
      /生成本地备份|备份文件|恢复的副本/,
    );
    const form = findButton(document, "导入粘贴的资料").closest("form")!;
    const checkbox =
      form.querySelector<HTMLInputElement>('[name="fetchURLs"]')!;
    assert.equal(Boolean(checkbox.checked), false);
    checkbox.checked = true;
    form.querySelector<HTMLTextAreaElement>('[name="content"]')!.value =
      "https://example.org/article";
    await act(async () => {
      form.dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      );
      form.dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    assert.equal(commands.length, 1);
    assert.equal(commands[0]!.type, "portable.importBookmarks");
    if (commands[0]!.type === "portable.importBookmarks") {
      assert.equal(commands[0]!.fetchURLs, true);
      assert.equal(commands[0]!.content, "https://example.org/article");
      assert.match(commands[0]!.goal, /实际提供/);
    }
    await act(async () => finish(null));
  });
});

test("restore uses a native selection command without a renderer-supplied path and shows actual import failures", async () => {
  await domTest(async ({ document, window, root, act, h }) => {
    const { PortablePanel } = await import("../src/workbench/Portable.js");
    const commands: PortableCommand[] = [],
      opened: string[] = [];
    const dispatch = async (command: PortableCommand) => {
      commands.push(command);
      return null;
    };
    await act(async () =>
      root.render(
        h(PortablePanel, {
          snapshot: {
            tasks: [],
            portable: {
              backups: [],
              restores: [],
              imports: [
                {
                  id: "import",
                  taskId: "work-id",
                  createdAt: "2026-09-13",
                  added: 2,
                  duplicates: 0,
                  skipped: 0,
                  fetched: 1,
                  coverage: "仅取得一份实际正文；另一份保留书签",
                  failures: [
                    {
                      url: "https://example.org/login",
                      message: "来源需要登录，本次未取得正文",
                    },
                  ],
                },
              ],
            },
          },
          dispatch,
          onTask: (id: string) => opened.push(id),
        }),
      ),
    );
    await act(async () =>
      findButton(document, "备份与恢复").dispatchEvent(
        new window.Event("click", { bubbles: true }),
      ),
    );
    await act(async () =>
      findButton(document, "选择备份并恢复副本").dispatchEvent(
        new window.Event("click", { bubbles: true }),
      ),
    );
    assert.equal(commands[0]!.type, "portable.restore");
    assert.deepEqual(Object.keys(commands[0]!).sort(), ["requestId", "type"]);
    await act(async () =>
      findButton(document, "导入材料").dispatchEvent(
        new window.Event("click", { bubbles: true }),
      ),
    );
    assert.match(document.body.textContent!, /来源需要登录/);
    await act(async () =>
      findButton(document, "打开资料工作").dispatchEvent(
        new window.Event("click", { bubbles: true }),
      ),
    );
    assert.deepEqual(opened, ["work-id"]);
  });
});

test("collection purpose and scope survive navigation while pending, and an uncertain retry retains its request", async () => {
  await domTest(async ({ document, window, root, act, h }) => {
    const { PortablePanel } = await import("../src/workbench/Portable.js");
    const commands: PortableCommand[] = [];
    let finish!: (value: null) => void;
    const snapshot = {
      tasks: [],
      settings: { aiRoot: "/unused/portable-draft-test" },
    };
    const dispatch = async (command: PortableCommand) => {
      commands.push(command);
      return new Promise<null>((resolve) => {
        finish = resolve;
      });
    };
    const render = () =>
      root.render(h(PortablePanel, { snapshot, dispatch, mode: "imports" }));
    await act(render);
    const form = document.querySelector("form")!;
    form.querySelector<HTMLInputElement>('[name="title"]')!.value = "指定批次";
    form.querySelector<HTMLTextAreaElement>('[name="goal"]')!.value =
      "保留我写的比较条件";
    form.querySelector<HTMLTextAreaElement>('[name="content"]')!.value =
      "https://example.com/article";
    form.querySelector<HTMLInputElement>('[name="fetchURLs"]')!.checked = true;
    form.querySelector<HTMLInputElement>('[name="run"]')!.checked = false;
    await act(async () =>
      form.dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      ),
    );
    await act(async () => root.render(null));
    await act(render);
    assert.equal(
      document.querySelector<HTMLInputElement>('[name="title"]')!.value,
      "指定批次",
    );
    assert.equal(
      document.querySelector<HTMLTextAreaElement>('[name="goal"]')!.value,
      "保留我写的比较条件",
    );
    assert.equal(
      document.querySelector<HTMLInputElement>('[name="fetchURLs"]')!.checked,
      true,
    );
    assert.equal(
      document.querySelector<HTMLInputElement>('[name="run"]')!.checked,
      false,
    );
    assert.equal(
      document.querySelector("fieldset")!.hasAttribute("disabled"),
      true,
    );
    await act(async () =>
      document
        .querySelector("form")!
        .dispatchEvent(
          new window.Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    assert.equal(commands.length, 1);
    await act(async () => finish(null));
    assert.equal(
      document.querySelector("fieldset")!.hasAttribute("disabled"),
      false,
    );
    await act(async () =>
      document
        .querySelector("form")!
        .dispatchEvent(
          new window.Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    assert.equal(commands.length, 2);
    assert.deepEqual(commands[0], commands[1]);
    await act(async () => finish(null));
  });
});
