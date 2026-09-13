import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import type { Task } from "../src/shared/types.js";

function fixture(): Task {
  return {
    id: "content-fixture",
    title: "比较方案",
    goal: "比较两项方案",
    goalVersion: 2,
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
        id: "doc-a",
        title: "方案说明",
        format: "md",
        content: "# 完整说明\n原始正文",
        hash: "hash-a",
        path: "/unused/a.md",
        version: 2,
        goalVersion: 2,
        versions: [],
        updatedAt: "2026-09-11T12:00:00Z",
      },
      {
        id: "image-b",
        title: "方案图片",
        format: "png",
        hash: "hash-b",
        path: "/unused/b.png",
        version: 1,
        goalVersion: 1,
        versions: [],
        updatedAt: "2026-09-10T12:00:00Z",
      },
    ],
  };
}
async function withDom(
  run: (context: {
    document: Document;
    window: Window & typeof globalThis;
    root: import("react-dom/client").Root;
    act: typeof import("react").act;
    createElement: typeof import("react").createElement;
  }) => Promise<void>,
) {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id='root'></div></body></html>",
  );
  Object.defineProperty(document, "compatMode", {
    value: "CSS1Compat",
    configurable: true,
  });
  const globals = {
    window,
    document,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const originals = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  const { createRoot } = await import("react-dom/client");
  const { act, createElement } = await import("react");
  const root = createRoot(document.getElementById("root")!);
  try {
    await run({
      document: document as unknown as Document,
      window: window as unknown as Window & typeof globalThis,
      root,
      act,
      createElement,
    });
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}
function click(
  window: Window & typeof globalThis,
  document: Document,
  label: string,
) {
  const button = Array.from(document.querySelectorAll("button")).find(
    (button) =>
      button.textContent?.startsWith(label) ||
      button.getAttribute("aria-label") === label,
  );
  assert.ok(button, label);
  button.dispatchEvent(new window.Event("click", { bubbles: true }));
}

let narrativeSequence = 0;
function narrativeTask(): Task {
  const task = fixture();
  task.id = `process-story-${++narrativeSequence}`;
  task.goal = "修正方案，必须离线可用";
  task.artifacts[0].version = 3;
  task.artifacts[0].versions = [
    {
      version: 2,
      hash: "hash-v2",
      path: "/unused/a-v2.md",
      createdAt: task.createdAt,
      summary: "保留修订前的方案",
    },
  ];
  task.sources = [
    {
      id: "model-card",
      title: "离线能力原始材料",
      text: "0123456789",
      coverage: "仅提供模型卡片中的离线能力说明",
      type: "text",
      location: "pasted",
      addedAt: task.createdAt,
    },
  ];
  task.messages = [
    {
      id: "original-goal",
      role: "user",
      member: "coordinator",
      goalVersion: 1,
      content: "比较候选方案。",
      createdAt: "2026-09-11T10:00:00Z",
    },
    {
      id: "correction",
      role: "user",
      member: "coordinator",
      goalVersion: 2,
      content: "原方案忽略了离线条件，请修正这一点。",
      createdAt: "2026-09-11T12:00:00Z",
    },
  ];
  const event = (
    id: string,
    type: string,
    summary: string,
    data: Record<string, unknown>,
    goalVersion = 2,
    member: Task["member"] = "coordinator",
  ) => ({
    id,
    type,
    summary,
    data: { invocationId: "main", ...data },
    goalVersion,
    member,
    createdAt: task.createdAt,
  });
  task.events = [
    event(
      "earlier",
      "public_response",
      "成员已回复",
      { content: "## 初步判断\n先选在线方案，因为当时没有离线要求。" },
      1,
    ),
    event("refine", "artifact_refine_requested", "用户要求修订", {
      artifactId: "doc-a",
      version: 2,
      hash: "hash-v2",
      instruction: "原方案忽略了离线条件，请修正这一点。",
    }),
    event("read", "tool_completed", "RAW_EXECUTION_ONLY", {
      tool: "read_source",
      sourceId: "model-card",
      readStart: 2,
      readEnd: 6,
      result: "PRIVATE_TOOL_BODY",
      reasoning: "PRIVATE_REASONING",
    }),
    event("analysis", "progress_reported", "必须先区分离线推理与在线服务。", {
      stage: "evidence",
      detail:
        "公开分析的具体依据：模型卡片只证明可本地推理，下载和首次授权仍需联网。",
      method: "逐条对照离线部署说明与授权条件。",
      questions: ["首次授权后是否仍依赖联网？"],
      sourceIds: ["model-card"],
      thought: "PRIVATE_THOUGHT",
    }),
    event("peer", "delegation_completed", "已收到协作结果", {
      callId: "peer",
      receiver: "cto",
      request: "检查首次授权条件。",
      result: "## CTO 判断\n首次授权需要联网，不能承诺从安装开始全程离线。",
    }),
    event("final", "public_response", "成员已回复", {
      content:
        "## 修正后的判断\n选择本地推理方案，并把首次联网授权列为明确前提。\n\n## 做得好的地方\n分开了安装条件与实际使用条件，避免错误承诺。",
    }),
    event("saved", "artifact_written", "保存了对应版本", {
      artifactId: "doc-a",
      version: 2,
      hash: "hash-v2",
    }),
  ];
  return task;
}

test("process reads the actual analysis and changes by goal, with member focus and explicit retrospective", async () => {
  await withDom(async ({ document, window, root, act, createElement }) => {
    const { ProcessView } = await import("../src/workbench/ProcessView.js");
    const task = narrativeTask();
    await act(async () =>
      root.render(
        createElement(ProcessView, { task, dispatch: async () => null }),
      ),
    );
    const narrative = document.querySelector('[aria-label="公开分析脉络"]')!;
    assert.match(narrative.textContent!, /当时没有离线要求/);
    assert.match(narrative.textContent!, /原方案忽略了离线条件/);
    assert.match(narrative.textContent!, /公开分析的具体依据/);
    assert.match(narrative.textContent!, /首次授权需要联网/);
    assert.match(narrative.textContent!, /选择本地推理方案/);
    assert.match(
      narrative.querySelector(".process-story-entry")!.textContent!,
      /选择本地推理方案/,
      "the latest actual judgment leads the first screen",
    );
    assert.equal(
      Boolean(
        document.querySelector<HTMLDetailsElement>(".process-context-history")!
          .open,
      ),
      false,
      "long original requests and revision metadata do not displace analysis",
    );
    assert.equal(
      Boolean(
        document.querySelector<HTMLDetailsElement>(".process-story-history")!
          .open,
      ),
      false,
      "earlier goals remain available on demand",
    );
    assert.doesNotMatch(narrative.textContent!, /RAW_EXECUTION_ONLY|PRIVATE_/);
    const detailText = Array.from(narrative.querySelectorAll(".markdown")).find(
      (node) => node.textContent?.includes("公开分析的具体依据"),
    )!;
    assert.equal(
      detailText.closest("details"),
      null,
      "substantive public explanation is directly readable",
    );
    assert.equal(document.querySelector('[aria-label="排障记录"]'), null);
    assert.equal(document.querySelector(".work-milestones"), null);
    assert.equal(document.querySelector(".process-layer-tabs"), null);
    const save = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("总结并保存"),
    )!;
    assert.equal(save.closest("details"), null);
    const focus = document.querySelector<HTMLSelectElement>(
      '[aria-label="关注成员观点"]',
    )!;
    Object.defineProperty(focus, "value", {
      value: "cto",
      writable: true,
      configurable: true,
    });
    await act(async () =>
      focus.dispatchEvent(new window.Event("change", { bubbles: true })),
    );
    assert.match(
      document.querySelector(".process-story")!.textContent!,
      /CTO 判断/,
    );
    assert.doesNotMatch(
      document.querySelector(".process-story")!.textContent!,
      /公开分析的具体依据/,
    );
    focus.value = "all";
    await act(async () =>
      focus.dispatchEvent(new window.Event("change", { bubbles: true })),
    );
    await act(async () => click(window, document, "回看得失"));
    const review = document.querySelector('[aria-label="过程复盘"]')!;
    assert.match(review.textContent!, /问题与修正/);
    assert.match(review.textContent!, /原方案忽略了离线条件/);
    assert.match(review.textContent!, /首次授权后是否仍依赖联网/);
    await act(async () => click(window, document, "排障记录"));
    assert.match(
      document.querySelector('[aria-label="排障记录"]')!.textContent!,
      /RAW_EXECUTION_ONLY/,
    );
    assert.doesNotMatch(document.body.textContent!, /PRIVATE_/);
  });
});

test("story evidence opens the actual source range and frozen artifact version instead of today's result", async () => {
  await withDom(async ({ document, window, root, act, createElement }) => {
    const { ProcessView } = await import("../src/workbench/ProcessView.js");
    const paths: string[] = [],
      opened: string[] = [];
    await act(async () =>
      root.render(
        createElement(ProcessView, {
          task: narrativeTask(),
          dispatch: async (command) => {
            if (command.type === "path.reveal") paths.push(command.path);
            return null;
          },
          onArtifactOpen: (id) => opened.push(id),
        }),
      ),
    );
    await act(async () => click(window, document, "离线能力原始材料"));
    let inspector = document.querySelector('[aria-label="过程依据详情"]')!;
    assert.match(inspector.textContent!, /第 3–6 字符/);
    assert.equal(
      inspector.querySelector(".process-source-text")!.textContent,
      "2345",
    );
    assert.match(inspector.textContent!, /实际读取以所记录的范围为准/);
    await act(async () => click(window, document, "方案说明 · v2"));
    assert.equal(
      document.querySelectorAll('[aria-label="过程依据详情"]').length,
      1,
    );
    inspector = document.querySelector('[aria-label="过程依据详情"]')!;
    assert.match(inspector.textContent!, /hash-v2/);
    assert.doesNotMatch(inspector.textContent!, /阅读这一版成果/);
    await act(async () => click(window, document, "定位成果 v2 文件"));
    assert.deepEqual(paths, ["/unused/a-v2.md"]);
    assert.deepEqual(opened, []);
  });
});

test("process save keeps the selected scope, blocks duplicate clicks across remount and permits retry after failure", async () => {
  await withDom(async ({ document, window, root, act, createElement }) => {
    const { ProcessView } = await import("../src/workbench/ProcessView.js");
    const task = { ...narrativeTask(), id: "process-save-retry" };
    const commands: unknown[] = [];
    let complete!: (value: null) => void;
    const dispatch: import("../src/workbench/common.js").Dispatch = async (
      command,
    ) => {
      commands.push(command);
      return new Promise((resolve) => {
        complete = resolve;
      });
    };
    const render = async () =>
      act(async () =>
        root.render(createElement(ProcessView, { task, dispatch })),
      );
    await render();
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
    assert.doesNotMatch(
      document.querySelector(".process-story")!.textContent!,
      /当时没有离线要求/,
    );
    await act(async () => {
      click(window, document, "总结并保存");
      click(window, document, "总结并保存");
    });
    assert.deepEqual(commands, [
      { type: "process.save", taskId: task.id, scope: "goal" },
    ]);
    await act(async () => root.render(null));
    await render();
    assert.equal(
      document.querySelector<HTMLButtonElement>(".process-save")!.disabled,
      true,
    );
    await act(async () => complete(null));
    assert.match(
      document.querySelector('[role="alert"]')!.textContent!,
      /过程总结未保存/,
    );
    assert.equal(
      document.querySelector<HTMLButtonElement>(".process-save")!.disabled,
      false,
    );
    await act(async () => click(window, document, "总结并保存"));
    assert.equal(commands.length, 2);
    await act(async () => complete(null));
  });
});

test("each task restores its analysis scope, native disclosure and reading position after switching", async () => {
  await withDom(async ({ document, window, root, act, createElement }) => {
    const { ProcessView } = await import("../src/workbench/ProcessView.js");
    const first = narrativeTask(),
      second = narrativeTask();
    const render = async (task: Task) =>
      act(async () =>
        root.render(
          createElement(
            "div",
            { className: "work-content-body" },
            createElement(ProcessView, { task, dispatch: async () => null }),
          ),
        ),
      );
    await render(first);
    const scroller = document.querySelector<HTMLElement>(".work-content-body")!;
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
    const details = document.querySelector<HTMLDetailsElement>(
      ".analysis-full-detail",
    )!;
    details.open = true;
    await act(async () =>
      // Linkedom does not propagate capture-only events; bubbling exercises the
      // same delegated listener as a native browser's non-bubbling toggle.
      details.dispatchEvent(new window.Event("toggle", { bubbles: true })),
    );
    await act(async () => click(window, document, "回看得失"));
    scroller.scrollTop = 176;
    scroller.dispatchEvent(new window.Event("scroll"));
    await render(second);
    assert.equal(
      document.querySelector<HTMLSelectElement>('[aria-label="过程范围"]')!
        .value,
      "all",
    );
    assert.equal(scroller.scrollTop, 0);
    assert.equal(
      Boolean(
        document.querySelector<HTMLDetailsElement>(".analysis-full-detail")!
          .open,
      ),
      false,
    );
    assert.equal(document.querySelector('[aria-label="过程复盘"]'), null);
    scroller.scrollTop = 31;
    scroller.dispatchEvent(new window.Event("scroll"));
    await render(first);
    assert.equal(
      document.querySelector<HTMLSelectElement>('[aria-label="过程范围"]')!
        .value,
      "goal",
    );
    assert.equal(scroller.scrollTop, 176);
    assert.equal(
      Boolean(
        document.querySelector<HTMLDetailsElement>(".analysis-full-detail")!
          .open,
      ),
      true,
    );
    assert.ok(document.querySelector('[aria-label="过程复盘"]'));
    await render(second);
    assert.equal(scroller.scrollTop, 31);
  });
});
