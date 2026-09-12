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
  const navigationStorage = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    value: {
      getItem: (key: string) => navigationStorage.get(key) ?? null,
      setItem: (key: string, value: string) =>
        navigationStorage.set(key, value),
    },
    configurable: true,
  });
  let current = snapshot;
  const commands: Command[] = [];
  const listeners = new Set<(snapshot: Snapshot) => void>();
  let subscriptions = 0;
  window.ytriple = {
    invoke: async (command) => {
      commands.push(command);
      if (command.type === "task.create") {
        const created = {
          ...taskFixture("project-created", true),
          kind: command.kind ?? "research",
          member: command.member ?? "coordinator",
          title: command.title ?? command.goal,
          goal: command.goal,
          projectId: command.projectId,
          messages: [],
          sources: [],
          artifacts: [],
        };
        current = { ...current, tasks: [created, ...current.tasks] };
      }
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
    assert.ok(!document.querySelector(".workspace-panels.workspace-hidden"));
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
    assert.ok(document.body.textContent?.includes("由统筹委派"));
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

test("pinned navigation remains open across independent configuration pages and project selection does not run work", async () => {
  const snap = workbenchSnapshot([taskFixture("pin-work", true)]);
  await withWorkbench(snap, async ({ document, window, act, commands }) => {
    const click = async (selector: string) => {
      const element = document.querySelector(selector);
      assert.ok(element, selector);
      await act(async () =>
        element.dispatchEvent(new window.Event("click", { bubbles: true })),
      );
    };
    await click('.topbar [aria-label="展开侧栏"]');
    await click('[aria-label="固定侧栏"]');
    assert.equal(
      JSON.parse(window.localStorage.getItem("ytriple.navigation.v1")!).pinned,
      true,
    );
    await click(".configuration-nav button:nth-of-type(1)");
    assert.ok(
      !document.querySelector(".sidebar")!.classList.contains("sidebar-hidden"),
    );
    assert.equal(
      document.querySelector(".settings-page h1")?.textContent,
      "多 Agent 团队",
    );
    assert.equal(document.querySelector(".settings-page .page-tabs"), null);
    await click(".configuration-nav button:nth-of-type(2)");
    assert.equal(
      document.querySelector(".settings-page h1")?.textContent,
      "AI 模型",
    );
    await click(".configuration-nav button:nth-of-type(3)");
    assert.equal(
      document.querySelector(".settings-page h1")?.textContent,
      "本机环境",
    );
    await click('[aria-label="取消固定侧栏"]');
    await click(".primary-nav button:nth-child(1)");
    assert.ok(
      document.querySelector(".sidebar")!.classList.contains("sidebar-hidden"),
    );
    assert.ok(
      !commands.some((command) =>
        ["task.create", "task.run", "settings.save"].includes(command.type),
      ),
    );
  });
});

test("project discussions keep separate drafts, attach a project on send, and leave the workbench task intact", async () => {
  const original = taskFixture("original-decision", true);
  const snap = workbenchSnapshot([original]);
  snap.projects = ["alpha", "beta"].map((id) => ({
    id,
    name: id,
    series: "y",
    root: `/unused/Code/y/${id}`,
    devPath: `/unused/Code/y/${id}/${id}-dev`,
    documents: {},
  }));
  await withWorkbench(snap, async ({ document, window, act, commands }) => {
    const click = async (selector: string) => {
      const element = document.querySelector(selector);
      assert.ok(element, selector);
      await act(async () =>
        element.dispatchEvent(new window.Event("click", { bubbles: true })),
      );
    };
    await click(".primary-nav button:nth-child(2)");
    await click('[aria-label="选择项目 alpha"]');
    assert.equal(
      document.querySelector(".project-decision-header h2")?.textContent,
      "alpha",
    );
    await click(".project-discussion-seeds button:nth-child(1)");
    const draftA = document.querySelector<HTMLTextAreaElement>(
      ".project-decision textarea",
    )!.value;
    await click('[aria-label="选择项目 beta"]');
    assert.equal(
      document.querySelector<HTMLTextAreaElement>(".project-decision textarea")!
        .value,
      "",
    );
    await click(".project-discussion-seeds button:nth-child(2)");
    await click('[aria-label="选择项目 alpha"]');
    assert.equal(
      document.querySelector<HTMLTextAreaElement>(".project-decision textarea")!
        .value ||
        document.querySelector<HTMLTextAreaElement>(
          ".project-decision textarea",
        )!.defaultValue,
      draftA,
    );
    assert.ok(
      !commands.some(
        (command) =>
          command.type === "task.create" || command.type === "task.run",
      ),
    );
    await act(async () =>
      document
        .querySelector(".project-decision .composer")!
        .dispatchEvent(
          new window.Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    const created = commands.find((command) => command.type === "task.create");
    assert.ok(created?.type === "task.create");
    assert.equal(created.projectId, "alpha");
    assert.ok(created.goal.includes("/unused/Code/y/alpha"));
    assert.ok(created.goal.includes(draftA));
    assert.ok(!created.goal.includes("/unused/Code/y/beta"));
    assert.deepEqual(
      commands.filter((command) => command.type === "task.run"),
      [{ type: "task.run", taskId: "project-created" }],
    );
    assert.equal(
      document.querySelector(".pane-main .task-overview h1")?.textContent,
      original.title,
    );
    assert.ok(document.querySelector(".workspace-panels.workspace-hidden"));
    assert.ok(
      !document
        .querySelector(".projects-layout")!
        .classList.contains("workspace-hidden"),
    );
    assert.equal(
      document.querySelector<HTMLTextAreaElement>(".project-decision textarea")!
        .value,
      "",
    );
  });
});

test("a delayed project creation preserves a newer returned-to-project draft and runs only the matching task", async () => {
  const snap = workbenchSnapshot([taskFixture("original-before-delay", true)]);
  snap.projects = ["alpha", "beta"].map((id) => ({
    id,
    name: id,
    series: "y",
    root: `/unused/Code/y/${id}`,
    devPath: `/unused/Code/y/${id}/${id}-dev`,
    documents: {},
  }));
  await withWorkbench(
    snap,
    async ({ document, window, act, commands, emit }) => {
      const click = async (selector: string) => {
        const element = document.querySelector(selector);
        assert.ok(element, selector);
        await act(async () =>
          element.dispatchEvent(new window.Event("click", { bubbles: true })),
        );
      };
      const text = () => {
        const element = document.querySelector<HTMLTextAreaElement>(
          ".project-decision textarea",
        )!;
        return element.value || element.defaultValue;
      };
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let pending: Extract<Command, { type: "task.create" }> | undefined;
      const invoke = window.ytriple!.invoke;
      window.ytriple!.invoke = async (command) => {
        if (command.type !== "task.create") return invoke(command);
        pending = command;
        await gate;
        const result = await invoke(command);
        const otherProject = {
          ...taskFixture("other-project-created", true),
          projectId: "beta",
          goal: command.goal,
        };
        const otherGoal = {
          ...taskFixture("other-alpha-created", true),
          projectId: "alpha",
          goal: "另一条同时创建的项目讨论",
        };
        const concurrent = {
          ...result,
          tasks: [otherProject, otherGoal, ...result.tasks],
        };
        emit(concurrent);
        return concurrent;
      };
      await click(".primary-nav button:nth-child(2)");
      await click('[aria-label="选择项目 alpha"]');
      await click(".project-discussion-seeds button:nth-child(1)");
      const submittedText = text();
      await act(async () =>
        document
          .querySelector(".project-decision .composer")!
          .dispatchEvent(
            new window.Event("submit", { bubbles: true, cancelable: true }),
          ),
      );
      assert.equal(pending?.projectId, "alpha");
      assert.ok(pending?.goal.includes(submittedText));
      assert.equal(
        commands.filter((command) => command.type === "task.run").length,
        0,
      );
      await click('[aria-label="选择项目 beta"]');
      await click('[aria-label="选择项目 alpha"]');
      await click(".project-discussion-seeds button:nth-child(2)");
      const newerText = text();
      assert.notEqual(newerText, submittedText);
      await act(async () => release());
      assert.equal(
        text(),
        newerText,
        "the old component cannot replace the newer mounted draft",
      );
      await click('[aria-label="选择项目 beta"]');
      await click('[aria-label="选择项目 alpha"]');
      assert.equal(
        text(),
        newerText,
        "the old request cannot erase the newer shared draft when it completes",
      );
      assert.equal(
        document.querySelector<HTMLSelectElement>(
          '[aria-label="项目讨论记录"]',
        )!.value,
        "",
        "a newer unsent project draft takes precedence over the newly returned task",
      );
      assert.deepEqual(
        commands.filter((command) => command.type === "task.run"),
        [{ type: "task.run", taskId: "project-created" }],
      );
      assert.equal(
        commands.filter((command) => command.type === "task.create").length,
        1,
      );
    },
  );
});

test("long decision replies open intact in results and saving the detail stays pending until the document returns", async () => {
  const task = taskFixture("decision-detail-regression", false);
  const detail =
    "# 分析报告\n\n" +
    "背景与证据需要保留。".repeat(350) +
    "\n\n## 结论\n\n先完成核心体验，再扩展外围能力。\n\n## 关键依据\n\n核心场景已验证，外围依赖仍不明确。\n\n## 风险\n\n现在扩平台会增加维护成本。\n\n## 附录\n\n完整报告末尾标记：ORCHID-END。";
  task.messages[1]!.content = detail;
  const snap = workbenchSnapshot([task]);
  await withWorkbench(
    snap,
    async ({ document, window, commands, emit, act }) => {
      const decision = document.querySelector(".pane-main .message.assistant")!;
      assert.match(decision.textContent!, /先完成核心体验/);
      assert.doesNotMatch(decision.textContent!, /ORCHID-END/);
      assert.ok(
        decision.textContent!.includes("核心场景已验证") &&
          decision.textContent!.includes("维护成本"),
        "the meeting report must retain evidence and tradeoffs alongside the conclusion",
      );
      assert.equal(
        document.querySelector(".pane-main .task-run-control"),
        null,
        "a completed task must not offer a redundant continue action",
      );
      const invoke = window.ytriple!.invoke;
      let current = snap;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      window.ytriple!.invoke = async (command) => {
        if (command.type === "message.save") {
          commands.push(command);
          await gate;
          const next = structuredClone(current);
          const savedTask = next.tasks.find(
            (item) => item.id === command.taskId,
          )!;
          const source = savedTask.messages.find(
            (item) => item.id === command.messageId,
          )!;
          const artifact = {
            ...savedTask.artifacts[0]!,
            id: "saved-detail-regression",
            title: "完整答复文档",
            content: source.content,
          };
          savedTask.artifacts.push(artifact);
          savedTask.events.push({
            id: "saved-detail-event",
            type: "message.saved",
            summary: "已保存为文档",
            createdAt: savedTask.updatedAt,
            goalVersion: savedTask.goalVersion,
            data: { messageId: command.messageId, artifactId: artifact.id },
          });
          current = next;
          emit(next);
          return next;
        }
        const result = await invoke(command);
        if (command.type === "window.rightMode") {
          result.desktop!.rightMode = command.mode;
          emit(result);
        }
        current = result;
        return result;
      };
      await act(async () =>
        decision
          .querySelector("button")!
          .dispatchEvent(new window.Event("click", { bubbles: true })),
      );
      const right = document.querySelector(
        '.pane-artifact [aria-label="对话完整内容"]',
      )!;
      assert.ok(right, "full answer is shown in the product's result pane");
      assert.match(right.textContent!, /ORCHID-END/);
      assert.ok(
        right.textContent!.includes("背景与证据需要保留。".repeat(350)),
      );
      assert.ok(
        commands.some(
          (command) =>
            command.type === "window.rightMode" && command.mode === "artifact",
        ),
      );
      const save = Array.from(
        right.querySelectorAll<HTMLButtonElement>("button"),
      ).find((button) => button.textContent === "保存为文档")!;
      await act(async () =>
        save.dispatchEvent(new window.Event("click", { bubbles: true })),
      );
      assert.equal(save.disabled, true);
      assert.equal(save.textContent, "保存中…");
      await act(async () =>
        save.dispatchEvent(new window.Event("click", { bubbles: true })),
      );
      assert.equal(
        commands.filter((command) => command.type === "message.save").length,
        1,
        "pending clicks must not create another save request",
      );
      await act(async () => release());
      assert.equal(document.querySelector('[aria-label="对话完整内容"]'), null);
      assert.match(
        document.querySelector(
          ".pane-artifact .artifact-reader > div:not([hidden]) .artifact-heading h3",
        )!.textContent!,
        /完整答复文档/,
      );
      assert.match(
        document.querySelector(".pane-artifact")!.textContent!,
        /ORCHID-END/,
      );
      assert.equal(
        task.messages[1]!.content,
        detail,
        "the original answer remains unchanged",
      );
    },
  );
});

test("a delayed answer save preserves the newer full report in the result pane", async (t) => {
  for (const otherTask of [false, true]) {
    await t.test(
      otherTask ? "after switching tasks" : "within the same task",
      async () => {
        const taskA = taskFixture(`pending-report-a-${otherTask}`, false);
        const taskB = taskFixture(`pending-report-b-${otherTask}`, false);
        taskA.title = "报告 A 所在的研究";
        taskB.title = "报告 B 所在的研究";
        const bodyA = "报告 A 的完整分析与依据。".repeat(300);
        const bodyB = "报告 B 的完整分析与依据。".repeat(300);
        taskA.messages[1]!.content = `# 报告 A\n\n${bodyA}\n\n## 结论\n\n建议 A。\n\n## 附录\n\nREPORT-A-END`;
        taskB.messages[1]!.content = `# 报告 B\n\n${bodyB}\n\n## 结论\n\n建议 B。\n\n## 附录\n\nREPORT-B-END`;
        if (!otherTask) taskA.messages.push(taskB.messages[1]!);
        const snap = workbenchSnapshot(otherTask ? [taskA, taskB] : [taskA]);
        await withWorkbench(
          snap,
          async ({ document, window, commands, emit, act }) => {
            let current = snap;
            let release!: () => void;
            const gate = new Promise<void>((resolve) => {
              release = resolve;
            });
            const invoke = window.ytriple!.invoke;
            window.ytriple!.invoke = async (command) => {
              if (command.type !== "message.save") {
                current = await invoke(command);
                if (command.type === "window.rightMode") {
                  current.desktop!.rightMode = command.mode;
                  emit(current);
                }
                return current;
              }
              commands.push(command);
              await gate;
              const next = structuredClone(current);
              const savedTask = next.tasks.find(
                (item) => item.id === command.taskId,
              )!;
              const source = savedTask.messages.find(
                (item) => item.id === command.messageId,
              )!;
              const artifact = {
                ...savedTask.artifacts[0]!,
                id: "delayed-saved-report-a",
                title: "已经保存的报告 A",
                content: source.content,
              };
              savedTask.artifacts.push(artifact);
              savedTask.events.push({
                id: "delayed-save-completed",
                type: "message.saved",
                summary: "报告 A 已保存为文档",
                createdAt: savedTask.updatedAt,
                goalVersion: savedTask.goalVersion,
                data: { messageId: command.messageId, artifactId: artifact.id },
              });
              current = next;
              emit(next);
              return next;
            };
            const click = async (target: Element | null | undefined) => {
              assert.ok(target);
              await act(async () =>
                target.dispatchEvent(
                  new window.Event("click", { bubbles: true }),
                ),
              );
            };
            const reader = () =>
              document.querySelector(
                '.pane-artifact [aria-label="对话完整内容"]',
              );
            await click(
              document.querySelector(".pane-main .message.assistant button"),
            );
            assert.match(reader()!.textContent!, /REPORT-A-END/);
            const save = Array.from(
              reader()!.querySelectorAll<HTMLButtonElement>("button"),
            ).find((button) => button.textContent === "保存为文档")!;
            await click(save);
            assert.equal(save.disabled, true);
            if (otherTask) {
              await click(
                Array.from(document.querySelectorAll(".work-item")).find(
                  (item) => item.textContent?.includes(taskB.title),
                ),
              );
            }
            await click(
              Array.from(
                document.querySelectorAll(".pane-main .message.assistant"),
              )
                .at(-1)
                ?.querySelector("button"),
            );
            assert.equal(
              reader()!.querySelector(".markdown h1")?.textContent,
              "报告 B",
            );
            assert.equal(
              reader()!.querySelector(".markdown p")?.textContent,
              bodyB,
            );
            await act(async () => release());
            assert.ok(
              reader(),
              "saving an earlier answer must not close the report opened afterwards",
            );
            assert.equal(
              reader()!.querySelector(".markdown h1")?.textContent,
              "报告 B",
            );
            assert.equal(
              reader()!.querySelector(".markdown p")?.textContent,
              bodyB,
            );
            assert.match(reader()!.textContent!, /REPORT-B-END/);
            assert.doesNotMatch(reader()!.textContent!, /REPORT-A-END/);
            assert.equal(
              document.querySelector(".pane-main .task-overview h1")
                ?.textContent,
              otherTask ? taskB.title : taskA.title,
            );
            assert.deepEqual(
              commands.filter((command) => command.type === "message.save"),
              [
                {
                  type: "message.save",
                  taskId: taskA.id,
                  messageId: taskA.messages[1]!.id,
                },
              ],
            );
            assert.equal(
              current.tasks
                .find((item) => item.id === taskA.id)!
                .artifacts.at(-1)?.content,
              taskA.messages[1]!.content,
            );
          },
        );
      },
    );
  }
});

test("recent-work menus restore archives but permanently delete sessions only after confirmation", async () => {
  const task = taskFixture("managed-work-regression", false);
  const snap = workbenchSnapshot([task]);
  await withWorkbench(
    snap,
    async ({ document, window, commands, emit, act }) => {
      const invoke = window.ytriple!.invoke;
      window.ytriple!.invoke = async (command) => {
        const result = await invoke(command);
        if (
          command.type === "task.archive" ||
          command.type === "task.delete" ||
          command.type === "task.restore"
        ) {
          const item = result.tasks.find((item) => item.id === command.taskId)!;
          if (command.type === "task.archive")
            item.archivedAt = "2026-09-11T12:01:00.000Z";
          else if (command.type === "task.delete") {
            result.tasks = result.tasks.filter(
              (task) => task.id !== command.taskId,
            );
            result.desktop!.taskId = null;
          } else {
            delete item.archivedAt;
            delete item.deletedAt;
          }
          emit(result);
        }
        return result;
      };
      const click = async (element: Element | null | undefined) => {
        assert.ok(element);
        await act(async () =>
          element.dispatchEvent(new window.Event("click", { bubbles: true })),
        );
      };
      const menuButton = (text: string) =>
        Array.from(
          document.querySelectorAll(".work-item-row .work-item-popover button"),
        ).find((button) => button.textContent === text);
      await click(document.querySelector('.topbar [aria-label="展开侧栏"]'));
      const menu = document.querySelector(
        '[aria-label="管理工作：' + task.title + '"]',
      );
      assert.ok(menu, "every recent task has an accessible secondary menu");
      await click(menuButton("重命名"));
      assert.ok(document.querySelector('[aria-label="工作名称"]'));
      await click(document.querySelector('[aria-label="取消重命名"]'));
      assert.ok(
        !commands.some((command) => command.type === "task.rename"),
        "canceling a rename does not change the task",
      );
      await click(menuButton("归档"));
      assert.equal(document.querySelector(".work-item"), null);
      assert.match(
        document.querySelector(".work-history")!.textContent!,
        /归档/,
      );
      assert.equal(document.querySelector(".pane-main .task-overview"), null);
      await click(
        document.querySelector('[aria-label="恢复工作：' + task.title + '"]'),
      );
      assert.match(
        document.querySelector(".work-item")!.textContent!,
        new RegExp(task.title),
      );
      await click(document.querySelector(".work-item"));
      await click(menuButton("删除会话"));
      assert.ok(document.querySelector('[role="dialog"]'));
      assert.match(
        document.querySelector('[role="dialog"]')!.textContent!,
        /已保存的成果/,
      );
      assert.ok(!commands.some((command) => command.type === "task.delete"));
      await click(
        Array.from(document.querySelectorAll('[role="dialog"] button')).find(
          (button) => button.textContent === "取消",
        ),
      );
      assert.ok(document.querySelector(".work-item"));
      await click(menuButton("删除会话"));
      await click(
        Array.from(document.querySelectorAll('[role="dialog"] button')).find(
          (button) => button.textContent === "永久删除",
        ),
      );
      assert.equal(document.querySelector(".work-item"), null);
      assert.equal(document.querySelector('[role="dialog"]'), null);
      assert.equal(document.querySelector(".work-history"), null);
      assert.equal(document.querySelector(".pane-main .task-overview"), null);
      assert.doesNotMatch(
        document.querySelector(".sidebar")!.textContent!,
        /最近删除/,
      );
      assert.deepEqual(
        commands.filter((command) =>
          ["task.archive", "task.delete", "task.restore"].includes(
            command.type,
          ),
        ),
        [
          { type: "task.archive", taskId: task.id },
          { type: "task.restore", taskId: task.id },
          { type: "task.delete", taskId: task.id },
        ],
      );
      assert.ok(
        !commands.some(
          (command) =>
            command.type === "task.run" || command.type === "task.send",
        ),
        "restoring work is navigation, not a request to rerun the model",
      );
    },
  );
});

test("project viewer and decision widths support keyboard resizing and restore the saved split on remount", async () => {
  const snap = workbenchSnapshot([
    taskFixture("project-width-regression", true),
  ]);
  await withWorkbench(snap, async ({ document, window, commands, act }) => {
    await act(async () =>
      document
        .querySelector(".primary-nav button:nth-child(2)")!
        .dispatchEvent(new window.Event("click", { bubbles: true })),
    );
    const divider = document.querySelector<HTMLElement>(
      '[aria-label="调整项目查看区与决策区宽度"]',
    )!;
    assert.equal(divider.getAttribute("role"), "separator");
    assert.equal(divider.getAttribute("tabindex"), "0");
    const initial = Number(divider.getAttribute("aria-valuenow"));
    await act(async () =>
      divider.dispatchEvent(keyEvent(window, "ArrowRight")),
    );
    const wider = Number(divider.getAttribute("aria-valuenow"));
    assert.ok(wider > initial);
    const width = window.localStorage.getItem(
      "ytriple.projects.viewer-width.v1",
    );
    assert.ok(
      width && Math.round(Number(width) * 100) === wider,
      "the chosen width is persisted independently from workbench panes",
    );
    assert.ok(
      document
        .querySelector<HTMLElement>(".projects-layout")!
        .style.gridTemplateColumns.includes(`${Number(width)}fr`),
    );
    const { createElement } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { ProjectWorkspace } =
      await import("../src/workbench/ProjectWorkspace.js");
    const mount = document.createElement("div");
    document.body.append(mount);
    const root = createRoot(mount);
    try {
      await act(async () =>
        root.render(
          createElement(ProjectWorkspace, {
            hidden: false,
            children: [
              createElement("div", null, "文件与查看区"),
              createElement("div", null, "决策区"),
            ],
          }),
        ),
      );
      const restored = mount.querySelector('[role="separator"]')!;
      assert.equal(Number(restored.getAttribute("aria-valuenow")), wider);
      await act(async () => restored.dispatchEvent(keyEvent(window, "Home")));
      assert.equal(
        restored.getAttribute("aria-valuenow"),
        restored.getAttribute("aria-valuemin"),
      );
      await act(async () => restored.dispatchEvent(keyEvent(window, "End")));
      assert.equal(
        restored.getAttribute("aria-valuenow"),
        restored.getAttribute("aria-valuemax"),
      );
    } finally {
      await act(async () => root.unmount());
      mount.remove();
    }
    assert.ok(
      !commands.some(
        (command) =>
          command.type === "window.resize" ||
          command.type === "task.run" ||
          command.type === "task.create",
      ),
    );
  });
});
