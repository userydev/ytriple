import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import type { Artifact, Task } from "../src/shared/types.js";
import type {
  DeliveryCommand,
  DeliveryRecord,
} from "../src/shared/delivery.js";

const artifact: Artifact = {
  id: "artifact-test",
  title: "实际脚本",
  path: "/tmp/delivery-test/a.md",
  format: "md",
  version: 2,
  hash: "b".repeat(64),
  goalVersion: 2,
  updatedAt: "2026-09-13T10:00:00Z",
  versions: [],
  content: "第二版正文",
};
const task: Task = {
  id: "task-test",
  title: "脚本研究",
  goal: "让执行者可理解并完成录制",
  goalVersion: 2,
  kind: "research",
  member: "coordinator",
  workspace: "/tmp/delivery-test",
  status: "idle",
  createdAt: "2026-09-13T10:00:00Z",
  updatedAt: "2026-09-13T10:00:00Z",
  messages: [],
  events: [],
  sources: [
    {
      id: "source-one",
      title: "明确选定的证据",
      type: "text",
      location: "用户提供",
      text: "原文",
      addedAt: "2026-09-13T10:00:00Z",
      coverage: "用户提供片段",
    },
  ],
  artifacts: [artifact],
};
const record: DeliveryRecord = {
  id: "delivery-one",
  revision: 3,
  taskId: task.id,
  artifactId: artifact.id,
  artifactTitle: artifact.title,
  artifactVersion: 1,
  artifactHash: "a".repeat(64),
  goalVersion: 1,
  content: "第一版准确正文",
  format: "md",
  sources: [],
  recipient: "剪辑执行者",
  goal: task.goal,
  criteria: "可按说明完成录制",
  missing: "",
  plannedDate: "2026-09-20",
  status: "draft",
  createdAt: "2026-09-13T10:00:00Z",
  updatedAt: "2026-09-13T10:00:00Z",
  history: [
    { status: "draft", recordedAt: "2026-09-13T10:00:00Z", evidence: {} },
  ],
  works: [],
  feedback: [],
  exports: [],
  writebacks: [],
  sourceChanged: true,
};

async function withDOM(
  run: (context: {
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
  // LinkeDOM does not reflect React's initial textarea defaultValue into value.
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
  const original = new Map(
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
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}
function button(document: Document, label: string) {
  const found = [...document.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  assert.ok(found, label);
  return found;
}

test("delivery panel explicitly registers the current hash and prevents duplicate pending submissions", async () => {
  await withDOM(async ({ document, window, root, act, h }) => {
    const { ArtifactDeliveryPanel } =
      await import("../src/workbench/Deliveries.js");
    const commands: DeliveryCommand[] = [];
    let finish!: (result: null) => void;
    const dispatch = async (command: DeliveryCommand) => {
      commands.push(command);
      return new Promise<null>((resolve) => {
        finish = resolve;
      });
    };
    await act(async () =>
      root.render(
        h(ArtifactDeliveryPanel, {
          task,
          artifact,
          snapshot: { tasks: [task], delivery: { records: [] } },
          dispatch,
        }),
      ),
    );
    assert.equal(
      document.querySelector<HTMLElement>(".delivery-panel")!.hidden,
      true,
    );
    await act(async () =>
      button(document, "交接与反馈").dispatchEvent(
        new window.Event("click", { bubbles: true }),
      ),
    );
    assert.equal(
      document.querySelector<HTMLElement>(".delivery-panel")!.hidden,
      false,
    );
    await act(async () =>
      button(document, "登记当前 v2 交付").dispatchEvent(
        new window.Event("click", { bubbles: true }),
      ),
    );
    const form = button(document, "保存交付登记").closest("form")!;
    (form.querySelector('[name="recipient"]') as HTMLInputElement).value =
      "真实剪辑执行者";
    await act(async () =>
      button(document, "关闭").dispatchEvent(
        new window.Event("click", { bubbles: true }),
      ),
    );
    assert.equal(
      document.querySelector<HTMLElement>(".delivery-panel")!.hidden,
      true,
    );
    await act(async () =>
      button(document, "交接与反馈").dispatchEvent(
        new window.Event("click", { bubbles: true }),
      ),
    );
    assert.equal(
      form.querySelector<HTMLInputElement>('[name="recipient"]')!.value,
      "真实剪辑执行者",
    );
    await act(async () => {
      form.dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      );
      form.dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    assert.equal(commands.length, 1);
    const command = commands[0]!;
    assert.equal(command.type, "delivery.register");
    if (command.type === "delivery.register") {
      assert.equal(command.expectedHash, artifact.hash);
      assert.equal(command.spec.recipient, "真实剪辑执行者");
      assert.equal(command.spec.goal, task.goal);
    }
    assert.equal(button(document, "保存交付登记").disabled, true);
    await act(async () => finish(null));
  });
});

test("readiness selects only checked sources and old delivery revisions remain visible without discarding drafts", async () => {
  await withDOM(async ({ document, window, root, act, h }) => {
    const { ArtifactDeliveryPanel, DeliveryOverview } =
      await import("../src/workbench/Deliveries.js");
    const commands: DeliveryCommand[] = [],
      navigations: string[] = [];
    const checked = {
      ...record,
      revision: 4,
      works: [
        {
          id: "request-placeholder",
          taskId: "new-check-task",
          kind: "readiness" as const,
          createdAt: "2026-09-13T11:00:00Z",
          artifactHash: record.artifactHash,
          sourceIds: ["source-one"],
          feedbackIds: [],
          status: "running",
        },
      ],
    };
    const dispatch = async (command: DeliveryCommand) => {
      commands.push(command);
      return {
        tasks: [task],
        delivery: {
          records: [
            {
              ...checked,
              works: checked.works.map((work) => ({
                ...work,
                id: command.requestId,
              })),
            },
          ],
        },
      };
    };
    const props = {
      task,
      artifact,
      snapshot: { tasks: [task], delivery: { records: [record] } },
      dispatch,
      onTask: (id: string) => navigations.push(id),
    };
    await act(async () => root.render(h(ArtifactDeliveryPanel, props)));
    assert.match(document.body.textContent!, /原成果已有新版本/);
    assert.match(document.body.textContent!, /第一版准确正文/);
    const checkForm = button(document, "开始独立就绪检查").closest("form")!;
    const checkbox = checkForm.querySelector<HTMLInputElement>(
      'input[name="sourceIds"]',
    )!;
    assert.equal(Boolean(checkbox.checked), false);
    checkbox.checked = true;
    await act(async () =>
      checkForm.dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      ),
    );
    assert.equal(commands[0]!.type, "delivery.check");
    if (commands[0]!.type === "delivery.check") {
      assert.deepEqual(commands[0]!.sourceIds, ["source-one"]);
      assert.equal(commands[0]!.expectedRevision, record.revision);
    }
    assert.deepEqual(navigations, ["new-check-task"]);
    const metaForm = button(document, "保存目标与日期").closest("form")!;
    const goal = metaForm.querySelector<HTMLTextAreaElement>('[name="goal"]')!;
    goal.value = "正在编辑的目标不应丢失";
    goal.dispatchEvent(new window.Event("input", { bubbles: true }));
    await act(async () =>
      root.render(
        h(ArtifactDeliveryPanel, {
          ...props,
          snapshot: {
            tasks: [task],
            delivery: { records: [{ ...checked, revision: 5 }] },
          },
        }),
      ),
    );
    assert.match(document.body.textContent!, /记录已更新/);
    assert.equal(goal.value, "正在编辑的目标不应丢失");
    assert.equal(
      document.querySelector("fieldset")!.hasAttribute("disabled"),
      true,
    );
    await act(async () =>
      button(document, "已核对，使用最新记录").dispatchEvent(
        new window.Event("click", { bubbles: true }),
      ),
    );
    assert.equal(
      document.querySelector("fieldset")!.hasAttribute("disabled"),
      false,
    );
    await act(async () =>
      root.render(
        h(DeliveryOverview, {
          snapshot: props.snapshot,
          dispatch,
          onTask: props.onTask,
        }),
      ),
    );
    assert.match(document.body.textContent!, /2026-09-20/);
    assert.match(document.body.textContent!, /交付与反馈/);
  });
});
