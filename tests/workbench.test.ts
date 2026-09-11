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
      assert.ok(
        command.type === "snapshot" || command.type === "window.select",
        "switching tasks may synchronize panels but must not start work",
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
      const context = document.querySelector(".pane-artifact")!;
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
    assert.equal(
      commands.filter((command) => command.type === "snapshot").length,
      1,
    );
    assert.equal(
      commands.filter((command) => command.type === "window.select").length,
      4,
    );
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

function workbenchSnapshot(
  tasks: Task[],
  taskId: string | null = tasks[0]?.id ?? null,
): Snapshot {
  return {
    version: "test",
    dataPath: "/unused/test.sqlite",
    tasks,
    profiles: [],
    projects: [],
    library: [],
    settings: {
      aiRoot: "/unused/AI",
      codeRoot: "/unused/Code",
      workspaceRoot: "/unused/workspace",
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
    desktop: {
      mode: "triple",
      taskId,
      revision: 1,
      collapsed: { main: false, evidence: false, artifact: false },
      open: { main: true, evidence: true, artifact: true },
    },
  };
}
async function withWorkbench(
  snapshot: Snapshot,
  run: (context: {
    document: Document;
    window: Window & typeof globalThis;
    commands: Command[];
    emit: (snapshot: Snapshot) => void;
    act: typeof import("react").act;
  }) => Promise<void>,
) {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id='root'></div></body></html>",
  );
  Object.defineProperty(window, "innerWidth", {
    value: 560,
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
  let current = snapshot;
  const commands: Command[] = [];
  const listeners = new Set<(snapshot: Snapshot) => void>();
  let subscriptions = 0;
  window.ytriple = {
    invoke: async (command) => {
      commands.push(command);
      if (command.type === "window.select")
        current = {
          ...current,
          desktop: {
            ...current.desktop!,
            taskId: command.taskId,
            revision: (current.desktop?.revision ?? 0) + 1,
          },
        };
      if (
        current.desktop &&
        command.type.startsWith("window.") &&
        command.type !== "window.select"
      ) {
        const desktop = structuredClone(current.desktop);
        desktop.revision = (desktop.revision ?? 0) + 1;
        if (command.type === "window.resize")
          desktop.ratios = { main: command.main, evidence: command.evidence };
        if (command.type === "window.collapse") {
          desktop.collapsed[command.window] = command.collapsed;
          desktop.expanded = null;
        }
        if (command.type === "window.expand") {
          desktop.expanded = command.window;
          if (command.window) {
            desktop.mode = "triple";
            desktop.collapsed[command.window] = false;
          }
        }
        if (command.type === "window.layout") {
          desktop.mode = command.mode;
          desktop.expanded = null;
          if (command.reset) {
            desktop.collapsed = {
              main: false,
              evidence: false,
              artifact: false,
            };
            desktop.ratios = { main: 0.52, evidence: 0.5 };
          }
        }
        if (command.type === "window.focus") {
          desktop.collapsed[command.window] = false;
          if (command.window !== "main") desktop.mode = "triple";
          if (desktop.expanded && desktop.expanded !== command.window)
            desktop.expanded = null;
        }
        current = { ...current, desktop };
      }
      return structuredClone(current);
    },
    subscribe: (listener) => {
      subscriptions += 1;
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
  const { App } = await import("../src/workbench/App.js");
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await run({
      document: document as unknown as Document,
      window: window as unknown as Window & typeof globalThis,
      commands,
      emit: (value) => {
        current = value;
        listeners.forEach((listener) => listener(value));
      },
      act,
    });
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
  assert.equal(listeners.size, 0);
  assert.equal(subscriptions, 1, "all panels share one App subscription");
}

test("one App contains three panels and selection synchronizes them without starting work", async () => {
  const first = taskFixture("triple-first", true),
    second = taskFixture("triple-second", false);
  await withWorkbench(
    workbenchSnapshot([first, second]),
    async ({ document, window, commands, act, emit }) => {
      assert.equal(document.querySelectorAll(".context-panel").length, 0);
      assert.equal(document.querySelectorAll(".workspace-panel").length, 3);
      assert.ok(document.querySelector(".pane-evidence"));
      assert.ok(document.querySelector(".pane-artifact"));
      assert.ok(document.querySelector(".sidebar-hidden"));
      assert.equal(
        document.querySelector(".task-overview h1")?.textContent,
        first.title,
      );
      await act(async () =>
        document
          .querySelector('[aria-label="展开侧栏"]')!
          .dispatchEvent(new window.Event("click", { bubbles: true })),
      );
      assert.ok(!document.querySelector(".sidebar-hidden"));
      const select = Array.from(document.querySelectorAll(".work-item")).find(
        (element) => element.textContent?.includes(second.title),
      )!;
      await act(async () =>
        select.dispatchEvent(new window.Event("click", { bubbles: true })),
      );
      assert.equal(
        document.querySelector(".task-overview h1")?.textContent,
        second.title,
      );
      assert.ok(
        document.querySelector(".sidebar-hidden"),
        "selecting a task dismisses the navigation overlay",
      );
      const old = workbenchSnapshot([first, second], first.id);
      await act(async () => emit(old));
      assert.equal(
        document.querySelector(".task-overview h1")?.textContent,
        second.title,
        "old updates must not undo a local task selection",
      );
      assert.deepEqual(
        commands.filter((command) => command.type !== "snapshot"),
        [{ type: "window.select", taskId: second.id }],
      );
    },
  );
});

test("folding, maximizing and page navigation keep the same artifact editor mounted", async () => {
  const first = taskFixture("aux-first", false),
    second = taskFixture("aux-second", true);
  const original = workbenchSnapshot([first, second]);
  await withWorkbench(original, async ({ document, window, act, emit }) => {
    assert.equal(
      document.querySelector(".artifact-heading h3")?.textContent,
      first.artifacts[0].title,
    );
    const edit = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "编辑",
    )!;
    await act(async () =>
      edit.dispatchEvent(new window.Event("click", { bubbles: true })),
    );
    const editor =
      document.querySelector<HTMLTextAreaElement>(".artifact-editor")!;
    // linkedom does not mirror textarea.defaultValue into value at mount.
    assert.equal(
      editor.value || editor.defaultValue,
      first.artifacts[0].content,
    );
    const folded = structuredClone(original);
    folded.desktop!.revision = 2;
    folded.desktop!.collapsed.artifact = true;
    await act(async () => emit(folded));
    assert.ok(document.querySelector(".pane-artifact.panel-collapsed"));
    assert.equal(
      document.querySelector(".artifact-editor"),
      editor,
      "folding keeps the editor mounted",
    );
    const changed = structuredClone(folded);
    changed.desktop!.revision = 3;
    changed.desktop!.collapsed.artifact = false;
    changed.tasks[0].artifacts[0].hash = "new-external-hash";
    changed.tasks[0].artifacts[0].content = "其他窗口的新内容";
    await act(async () => emit(changed));
    assert.equal(
      document.querySelector<HTMLTextAreaElement>(".artifact-editor")?.value ||
        document.querySelector<HTMLTextAreaElement>(".artifact-editor")
          ?.defaultValue,
      first.artifacts[0].content,
      "external snapshots do not replace the active draft",
    );
    assert.ok(
      Array.from(document.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("保存修改"),
      )?.disabled,
    );
    const maximize = document.querySelector('[aria-label="最大化成果工作区"]')!;
    await act(async () =>
      maximize.dispatchEvent(new window.Event("click", { bubbles: true })),
    );
    assert.ok(document.querySelector(".pane-artifact.panel-expanded"));
    assert.equal(document.querySelector(".artifact-editor"), editor);
    const library = document.querySelector(".primary-nav button:nth-child(3)")!;
    await act(async () =>
      library.dispatchEvent(new window.Event("click", { bubbles: true })),
    );
    assert.ok(document.querySelector(".workspace-hidden"));
    assert.equal(
      document.querySelector(".artifact-editor"),
      editor,
      "navigating to Lib keeps document editing state mounted",
    );
    const backToWork = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("回到工作区"),
    )!;
    await act(async () =>
      backToWork.dispatchEvent(new window.Event("click", { bubbles: true })),
    );
    assert.ok(!document.querySelector(".workspace-hidden"));
    const selectSecond = Array.from(
      document.querySelectorAll(".work-item"),
    ).find((button) => button.textContent?.includes(second.title))!;
    await act(async () =>
      selectSecond.dispatchEvent(new window.Event("click", { bubbles: true })),
    );
    assert.equal(document.querySelectorAll(".artifact-view").length, 0);
    await act(async () => emit(original));
    assert.equal(
      document.querySelectorAll(".artifact-view").length,
      0,
      "a late snapshot cannot replace the user selection",
    );
    const selectFirst = Array.from(
      document.querySelectorAll(".work-item"),
    ).find((button) => button.textContent?.includes(first.title))!;
    await act(async () =>
      selectFirst.dispatchEvent(new window.Event("click", { bubbles: true })),
    );
    assert.equal(
      document.querySelector<HTMLTextAreaElement>(".artifact-editor")?.value ||
        document.querySelector<HTMLTextAreaElement>(".artifact-editor")
          ?.defaultValue,
      first.artifacts[0].content,
      "switching back restores unsaved editing state",
    );
  });
});

test("process view exposes real delegation and public summaries without raw reasoning payloads", async () => {
  const task = taskFixture("process-fixture", false);
  task.status = "running";
  const now = task.createdAt;
  task.events = [
    {
      id: "run",
      type: "run_started",
      summary: "开始工作",
      createdAt: now,
      goalVersion: 1,
      data: { runId: "run-1" },
    },
    {
      id: "coordinator",
      type: "agent_started",
      member: "coordinator",
      summary: "统筹开始梳理任务",
      createdAt: now,
      goalVersion: 1,
      data: { runId: "run-1", invocationId: "main", scope: "coordinator" },
    },
    {
      id: "delegate",
      type: "delegation_started",
      member: "coordinator",
      summary: "请研究员核查材料",
      createdAt: now,
      goalVersion: 1,
      data: {
        runId: "run-1",
        invocationId: "main",
        scope: "coordinator",
        callId: "call-1",
        receiver: "researcher",
        childInvocationId: "research",
      },
    },
    {
      id: "research",
      type: "agent_started",
      member: "researcher",
      summary: "研究员正在检查资料",
      createdAt: now,
      goalVersion: 1,
      data: {
        runId: "run-1",
        invocationId: "research",
        scope: "coordinator/researcher",
        parentInvocationId: "main",
      },
    },
    {
      id: "finding",
      type: "progress_reported",
      member: "researcher",
      summary: "两份资料的统计口径不同，需要分别比较。",
      createdAt: now,
      goalVersion: 1,
      data: {
        runId: "run-1",
        invocationId: "research",
        scope: "coordinator/researcher",
        stage: "finding",
        reasoning: "PRIVATE_INTERNAL_CHAIN_DO_NOT_DISPLAY",
      },
    },
  ];
  await withWorkbench(workbenchSnapshot([task]), async ({ document }) => {
    assert.equal(document.querySelectorAll(".agent-lane").length, 2);
    assert.ok(document.body.textContent?.includes("统筹 委派"));
    assert.ok(
      document.body.textContent?.includes(
        "两份资料的统计口径不同，需要分别比较。",
      ),
    );
    assert.ok(
      !document.body.textContent?.includes(
        "PRIVATE_INTERNAL_CHAIN_DO_NOT_DISPLAY",
      ),
    );
    assert.ok(
      !document.querySelector(".member-cto"),
      "an unused member must not be shown working",
    );
  });
});

test("artifact collection captures the displayed version and offers real follow-up actions", async () => {
  const task = taskFixture("collect-fixture", false);
  await withWorkbench(
    workbenchSnapshot([task]),
    async ({ document, window, commands, act }) => {
      const collect = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "收藏到 Lib",
      )!;
      await act(async () =>
        collect.dispatchEvent(new window.Event("click", { bubbles: true })),
      );
      assert.deepEqual(
        commands.find((command) => command.type === "library.collect"),
        {
          type: "library.collect",
          taskId: task.id,
          artifactId: task.artifacts[0].id,
          expectedHash: task.artifacts[0].hash,
        },
      );
      const refine = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "继续加工",
      )!;
      await act(async () =>
        refine.dispatchEvent(new window.Event("click", { bubbles: true })),
      );
      assert.ok(document.querySelector(".refine-form textarea"));
      assert.ok(
        Array.from(document.querySelectorAll("button")).find((button) =>
          button.textContent?.includes("开始加工"),
        )?.disabled,
        "an empty instruction cannot start AI work",
      );
    },
  );
});

test("local Lib keeps provenance, exposes editing, and reuses the chosen entry as real task material", async () => {
  const task = taskFixture("library-fixture", false);
  const snapshot = workbenchSnapshot([task]);
  snapshot.library = [
    {
      id: "saved-fixture",
      title: "值得留下的研究结论",
      path: "/unused/lib/saved.md",
      format: "md",
      hash: "lib-hash",
      version: 1,
      savedAt: task.createdAt,
      updatedAt: task.updatedAt,
      tags: ["能源"],
      note: "用于下一轮研究",
      source: {
        taskId: task.id,
        taskTitle: task.title,
        artifactId: task.artifacts[0].id,
        artifactVersion: 3,
        artifactHash: "original-hash",
        goalVersion: 1,
      },
      versions: [],
      content: "# 收藏正文\n已有的依据和结论。",
    },
  ];
  await withWorkbench(snapshot, async ({ document, window, commands, act }) => {
    const nav = Array.from(
      document.querySelectorAll(".primary-nav button"),
    ).find((button) => button.textContent?.includes("本地 Lib"))!;
    await act(async () =>
      nav.dispatchEvent(new window.Event("click", { bubbles: true })),
    );
    assert.ok(document.querySelector(".sidebar-hidden"));
    const card = document.querySelector(".saved-library-card")!;
    await act(async () =>
      card.dispatchEvent(new window.Event("click", { bubbles: true })),
    );
    assert.ok(
      document
        .querySelector(".library-provenance")
        ?.textContent?.includes("成果 v3"),
    );
    assert.ok(
      document
        .querySelector(".library-document")
        ?.textContent?.includes("已有的依据和结论。"),
    );
    assert.ok(
      Array.from(document.querySelectorAll("button")).some(
        (button) => button.textContent === "修改收藏",
      ),
    );
    const reuse = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "加入工作",
    )!;
    await act(async () =>
      reuse.dispatchEvent(new window.Event("click", { bubbles: true })),
    );
    assert.deepEqual(
      commands.find((command) => command.type === "library.reuse"),
      { type: "library.reuse", entryId: "saved-fixture", taskId: task.id },
    );
    assert.equal(
      commands.filter(
        (command) =>
          command.type === "task.run" || command.type === "task.send",
      ).length,
      0,
      "reusing material lets the user supply direction before model work starts",
    );
    assert.equal(
      document.querySelector(".task-overview h1")?.textContent,
      task.title,
    );
  });
});

test("initial restored work seeds the saved member and model without starting it again", async () => {
  const task = taskFixture("restored-config-fixture", false);
  task.member = "cto";
  task.profileId = "saved-profile";
  const snapshot = workbenchSnapshot([task]);
  snapshot.profiles = [
    {
      id: "saved-profile",
      name: "本次指定模型",
      provider: "gemini",
      protocol: "google",
      baseURL: "",
      modelId: "model-fixture",
      apiKeyEnv: "FIXTURE_KEY",
      hasKey: true,
      status: "ready",
    },
  ];
  await withWorkbench(snapshot, async ({ document, commands }) => {
    assert.equal(
      document.querySelector<HTMLSelectElement>(".select-member select")?.value,
      "cto",
    );
    assert.equal(
      document.querySelector<HTMLSelectElement>(".select-model select")?.value,
      "saved-profile",
    );
    assert.equal(
      document.querySelector(".task-overview h1")?.textContent,
      task.title,
    );
    assert.deepEqual(commands, [{ type: "snapshot" }]);
  });
});

function pointerEvent(
  window: Window & typeof globalThis,
  type: string,
  x: number,
  y: number,
) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    button: { value: 0 },
    clientX: { value: x },
    clientY: { value: y },
  });
  return event;
}
function keyEvent(
  window: Window & typeof globalThis,
  key: string,
  shiftKey = false,
) {
  const event = new window.Event("keydown", {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperties(event, {
    key: { value: key },
    shiftKey: { value: shiftKey },
  });
  return event;
}
test("both separators resize locally during pointer movement, persist on release, and support keyboard adjustment", async () => {
  const task = taskFixture("split-resize-fixture", false);
  const snapshot = workbenchSnapshot([task]);
  snapshot.desktop!.ratios = { main: 0.52, evidence: 0.5 };
  await withWorkbench(snapshot, async ({ document, window, commands, act }) => {
    const workspace = document.querySelector<HTMLElement>(".workspace-panels")!;
    const right = document.querySelector<HTMLElement>(".workspace-right")!;
    const bounds = {
      left: 0,
      top: 0,
      width: 1000,
      height: 800,
      right: 1000,
      bottom: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
    Object.defineProperty(workspace, "getBoundingClientRect", {
      value: () => bounds,
    });
    Object.defineProperty(right, "getBoundingClientRect", {
      value: () => ({ ...bounds, left: 520, width: 480 }),
    });
    const horizontal = document.querySelector<HTMLElement>(".divider-main")!;
    const vertical = document.querySelector<HTMLElement>(".divider-evidence")!;
    await act(async () =>
      horizontal.dispatchEvent(pointerEvent(window, "pointerdown", 520, 200)),
    );
    for (const x of [550, 610, 650])
      await act(async () =>
        horizontal.dispatchEvent(pointerEvent(window, "pointermove", x, 200)),
      );
    assert.equal(horizontal.getAttribute("aria-valuenow"), "65");
    assert.ok(workspace.style.gridTemplateColumns.includes("0.65fr"));
    assert.equal(
      commands.filter((command) => command.type === "window.resize").length,
      0,
      "pointer movements do not call IPC per frame",
    );
    await act(async () =>
      horizontal.dispatchEvent(pointerEvent(window, "pointerup", 650, 200)),
    );
    assert.deepEqual(
      commands.filter((command) => command.type === "window.resize"),
      [{ type: "window.resize", main: 0.65, evidence: 0.5 }],
    );
    assert.equal(document.querySelector(".resize-shield"), null);
    await act(async () =>
      vertical.dispatchEvent(pointerEvent(window, "pointerdown", 700, 400)),
    );
    await act(async () =>
      vertical.dispatchEvent(pointerEvent(window, "pointermove", 700, 320)),
    );
    await act(async () =>
      vertical.dispatchEvent(pointerEvent(window, "pointerup", 700, 320)),
    );
    assert.deepEqual(
      commands.filter((command) => command.type === "window.resize").at(-1),
      { type: "window.resize", main: 0.65, evidence: 0.4 },
    );
    await act(async () =>
      horizontal.dispatchEvent(keyEvent(window, "ArrowLeft")),
    );
    assert.equal(horizontal.getAttribute("aria-valuenow"), "63");
    await act(async () =>
      vertical.dispatchEvent(keyEvent(window, "ArrowDown", true)),
    );
    assert.equal(vertical.getAttribute("aria-valuenow"), "50");
    await act(async () => horizontal.dispatchEvent(keyEvent(window, "Home")));
    assert.equal(horizontal.getAttribute("aria-valuenow"), "20");
    await act(async () => horizontal.dispatchEvent(keyEvent(window, "End")));
    assert.equal(horizontal.getAttribute("aria-valuenow"), "80");
  });
});

test("lost pointer capture and app blur cancel the resize shield without committing unfinished layout", async () => {
  const snapshot = workbenchSnapshot([
    taskFixture("cancel-resize-fixture", false),
  ]);
  snapshot.desktop!.ratios = { main: 0.52, evidence: 0.5 };
  await withWorkbench(snapshot, async ({ document, window, commands, act }) => {
    const workspace = document.querySelector<HTMLElement>(".workspace-panels")!;
    Object.defineProperty(workspace, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 1000, height: 800 }),
    });
    const divider = document.querySelector<HTMLElement>(".divider-main")!;
    for (const cancellation of ["lostpointercapture", "blur"]) {
      await act(async () =>
        divider.dispatchEvent(pointerEvent(window, "pointerdown", 520, 200)),
      );
      await act(async () =>
        divider.dispatchEvent(pointerEvent(window, "pointermove", 720, 200)),
      );
      assert.ok(document.querySelector(".resize-shield"));
      await act(async () =>
        cancellation === "blur"
          ? window.dispatchEvent(new window.Event("blur"))
          : divider.dispatchEvent(
              pointerEvent(window, "lostpointercapture", 720, 200),
            ),
      );
      assert.equal(document.querySelector(".resize-shield"), null);
      assert.equal(divider.getAttribute("aria-valuenow"), "52");
      await act(async () =>
        divider.dispatchEvent(pointerEvent(window, "pointerup", 720, 200)),
      );
    }
    assert.equal(
      commands.filter((command) => command.type === "window.resize").length,
      0,
    );
  });
});

test("releasing away from a divider clears the shield on pointerup or mouseup and commits only once", async () => {
  const snapshot = workbenchSnapshot([
    taskFixture("global-release-fixture", false),
  ]);
  snapshot.desktop!.ratios = { main: 0.52, evidence: 0.5 };
  await withWorkbench(snapshot, async ({ document, window, commands, act }) => {
    const workspace = document.querySelector<HTMLElement>(".workspace-panels")!;
    Object.defineProperty(workspace, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 1000, height: 800 }),
    });
    const divider = document.querySelector<HTMLElement>(".divider-main")!;
    await act(async () =>
      divider.dispatchEvent(pointerEvent(window, "pointerdown", 520, 200)),
    );
    await act(async () =>
      divider.dispatchEvent(pointerEvent(window, "pointermove", 620, 200)),
    );
    await act(async () =>
      window.dispatchEvent(pointerEvent(window, "pointerup", 620, 200)),
    );
    await act(async () => window.dispatchEvent(new window.Event("mouseup")));
    await act(async () =>
      divider.dispatchEvent(
        pointerEvent(window, "lostpointercapture", 620, 200),
      ),
    );
    assert.equal(document.querySelector(".resize-shield"), null);
    assert.equal(
      commands.filter((command) => command.type === "window.resize").length,
      1,
    );
    await act(async () =>
      divider.dispatchEvent(pointerEvent(window, "pointerdown", 620, 200)),
    );
    await act(async () =>
      divider.dispatchEvent(pointerEvent(window, "pointermove", 570, 200)),
    );
    await act(async () => window.dispatchEvent(new window.Event("mouseup")));
    assert.equal(
      document.querySelector(".resize-shield"),
      null,
      "mouse-only release cannot swallow the following click",
    );
    assert.deepEqual(
      commands.filter((command) => command.type === "window.resize"),
      [
        { type: "window.resize", main: 0.62, evidence: 0.5 },
        { type: "window.resize", main: 0.57, evidence: 0.5 },
      ],
    );
    const edit = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "编辑",
    )!;
    await act(async () =>
      edit.dispatchEvent(new window.Event("click", { bubbles: true })),
    );
    assert.ok(
      document.querySelector(".artifact-editor"),
      "the first click after releasing can open the editor",
    );
  });
});
