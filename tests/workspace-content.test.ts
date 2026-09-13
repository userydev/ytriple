import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import type { Task } from "../src/shared/types.js";

let fixtureSequence = 0;
function fixture(): Task {
  return {
    id: `content-fixture-${++fixtureSequence}`,
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

test("compact artifact selection keeps the live editor mounted through result selection and conversation details", async () => {
  await withDom(async ({ document, window, root, act, createElement }) => {
    const { ArtifactList } = await import("../src/workbench/Artifacts.js");
    const task = fixture();
    task.id = "mounted-editor-selection";
    let saved = 0;
    const props = {
      task,
      dispatch: async () => null,
      preferredArtifactId: "doc-a",
      onSaveDetail: () => {
        saved++;
      },
    };
    await act(async () => root.render(createElement(ArtifactList, props)));
    assert.equal(document.querySelector(".artifact-catalog"), null);
    assert.equal(
      document.querySelectorAll('[aria-label="选择成果"] option').length,
      2,
    );
    assert.match(
      document.querySelector('[aria-label="选择成果"]')!.textContent!,
      /旧目标 v1/,
    );
    await act(async () => click(window, document, "编辑"));
    const editor =
      document.querySelector<HTMLTextAreaElement>(".artifact-editor")!;
    assert.ok(editor);
    const reader = document.querySelector<HTMLElement>(".artifact-reader")!;
    reader.scrollTop = 320;
    reader.dispatchEvent(new window.Event("scroll"));
    await act(async () =>
      root.render(
        createElement(ArtifactList, {
          ...props,
          detail: {
            id: "message-detail",
            title: "完整回复",
            content: "# 长回复\n真实原文",
          },
        }),
      ),
    );
    assert.equal(document.querySelector(".artifact-editor"), editor);
    assert.ok(editor.closest("[hidden]"));
    assert.equal(reader.scrollTop, 0);
    assert.match(
      document.querySelector(".conversation-detail")!.textContent!,
      /真实原文/,
    );
    await act(async () => click(window, document, "保存为文档"));
    assert.equal(saved, 1);
    await act(async () => root.render(createElement(ArtifactList, props)));
    assert.equal(document.querySelector(".artifact-editor"), editor);
    assert.equal(editor.closest("[hidden]"), null);
    assert.equal(reader.scrollTop, 320);
    const selector = document.querySelector<HTMLSelectElement>(
      '[aria-label="选择成果"]',
    )!;
    Object.defineProperty(selector, "value", {
      value: "image-b",
      writable: true,
      configurable: true,
    });
    await act(async () =>
      selector.dispatchEvent(new window.Event("change", { bubbles: true })),
    );
    assert.ok(editor.closest("[hidden]"));
    selector.value = "doc-a";
    await act(async () =>
      selector.dispatchEvent(new window.Event("change", { bubbles: true })),
    );
    assert.equal(document.querySelector(".artifact-editor"), editor);
    assert.equal(editor.closest("[hidden]"), null);
  });
});

test("new artifacts do not displace the selected document and a document heading supersedes the versioned metadata title", async () => {
  await withDom(async ({ document, root, act, createElement }) => {
    const { ArtifactList } = await import("../src/workbench/Artifacts.js");
    const task = fixture();
    task.id = "new-artifacts-stay-selected";
    task.artifacts = [
      {
        ...task.artifacts[0]!,
        title: "方案说明 · 修订 v2",
        content: "# 方案说明\n直接阅读正文",
      },
    ];
    const props = { task, dispatch: async () => null };
    await act(async () => root.render(createElement(ArtifactList, props)));
    assert.equal(document.querySelector('[aria-label="选择成果"]'), null);
    assert.equal(document.querySelector(".artifact-document-heading h3"), null);
    assert.match(
      document.querySelector(".markdown")!.textContent!,
      /直接阅读正文/,
    );
    await act(async () =>
      root.render(
        createElement(ArtifactList, {
          ...props,
          task: {
            ...task,
            artifacts: [
              ...task.artifacts,
              { ...task.artifacts[0]!, id: "new", title: "后续成果" },
            ],
          },
        }),
      ),
    );
    assert.equal(
      document.querySelector<HTMLSelectElement>('[aria-label="选择成果"]')!
        .value,
      "doc-a",
    );
    assert.match(
      document.querySelector(".markdown")!.textContent!,
      /直接阅读正文/,
    );
  });
});

test("process shows substantive updates and actual contributions directly while raw execution is opened on demand", async () => {
  await withDom(async ({ document, window, root, act, createElement }) => {
    const { ProcessView } = await import("../src/workbench/ProcessView.js");
    const task = fixture();
    task.events = [
      {
        id: "plan",
        type: "progress_reported",
        summary: "先确认是否必须离线使用。",
        member: "coordinator",
        goalVersion: 2,
        createdAt: task.createdAt,
        data: {
          stage: "framing",
          invocationId: "main",
          reasoning: "PRIVATE_CHAIN",
        },
      },
      {
        id: "tool",
        type: "tool_completed",
        summary: "执行日志专有内容",
        member: "coordinator",
        goalVersion: 2,
        createdAt: task.createdAt,
        data: {
          invocationId: "main",
          callId: "read",
          tool: "read_source",
          result: "PRIVATE_TOOL_BODY",
        },
      },
      {
        id: "delegate",
        type: "delegation_completed",
        summary: "已收到协作结果",
        member: "coordinator",
        goalVersion: 2,
        createdAt: task.createdAt,
        data: {
          invocationId: "main",
          callId: "peer",
          receiver: "cto",
          request: "比较离线可行性。",
          result: "第一种方案可以离线使用。",
          thought: "PRIVATE_THOUGHT",
        },
      },
    ];
    await act(async () =>
      root.render(
        createElement(ProcessView, { task, dispatch: async () => null }),
      ),
    );
    assert.match(
      document.querySelector('[aria-label="公开分析脉络"]')!.textContent!,
      /先确认是否必须离线使用/,
    );
    assert.doesNotMatch(
      document.body.textContent!,
      /执行日志专有内容|PRIVATE_/,
    );
    assert.equal(document.querySelector(".process-layer-tabs"), null);
    assert.match(
      document.querySelector('[aria-label="成员分析与贡献"]')!.textContent!,
      /比较离线可行性/,
    );
    assert.match(
      document.querySelector('[aria-label="成员分析与贡献"]')!.textContent!,
      /第一种方案可以离线使用/,
    );
    assert.doesNotMatch(document.body.textContent!, /PRIVATE_/);
    await act(async () => click(window, document, "排障记录"));
    assert.match(
      document.querySelector('[aria-label="排障记录"]')!.textContent!,
      /执行日志专有内容/,
    );
    assert.doesNotMatch(document.body.textContent!, /PRIVATE_/);
  });
});

test("Markdown routes relative documents, real artifacts and local heading anchors independently", async () => {
  await withDom(async ({ document, window, root, act, createElement }) => {
    const { Markdown } = await import("../src/workbench/common.js");
    const relative: string[] = [],
      artifacts: string[] = [],
      external: string[] = [];
    await act(async () =>
      root.render(
        createElement(Markdown, {
          children:
            "[Doc](docs/guide.md) [Result](artifact:doc-a) [Heading](#结论) [Web](https://example.com)\n\n# 结论",
          dispatch: async (command) => {
            if (command.type === "url.open") external.push(command.url);
            return null;
          },
          onDocumentLink: (href) => relative.push(href),
          onArtifactLink: (id) => artifacts.push(id),
        }),
      ),
    );
    const heading = document.querySelector("h1")!;
    let scrolled = false;
    heading.scrollIntoView = () => {
      scrolled = true;
    };
    for (const anchor of document.querySelectorAll("a"))
      await act(async () =>
        anchor.dispatchEvent(
          new window.Event("click", { bubbles: true, cancelable: true }),
        ),
      );
    assert.deepEqual(relative, ["docs/guide.md"]);
    assert.deepEqual(artifacts, ["doc-a"]);
    assert.deepEqual(external, ["https://example.com"]);
    assert.equal(scrolled, true);
  });
});

test("process keeps the current-goal analysis across runs and narrows to the latest paused run explicitly", async () => {
  await withDom(async ({ document, window, root, act, createElement }) => {
    const { ProcessView } = await import("../src/workbench/ProcessView.js");
    const task = fixture();
    task.status = "paused";
    const event = (
      id: string,
      type: string,
      runId: string,
      summary: string,
      data: Record<string, unknown> = {},
    ) => ({
      id,
      type,
      summary,
      member: "coordinator" as const,
      goalVersion: 2,
      createdAt: task.createdAt,
      data: { runId, invocationId: runId, ...data },
    });
    task.events = [
      event("old-start", "run_started", "old", "开始第一轮"),
      event(
        "old-report",
        "progress_reported",
        "old",
        "前次已经确认离线使用的依据。",
        { stage: "evidence" },
      ),
      event("old-peer", "delegation_completed", "old", "收到旧轮协作结果", {
        callId: "peer",
        receiver: "cto",
        request: "先核查资料。",
        result: "历史协作已完成且保留回复。",
      }),
      event("old-end", "run_completed", "old", "第一轮已完成"),
      event("new-start", "run_started", "new", "开始后续处理"),
      event("new-agent", "agent_started", "new", "统筹开始后续处理"),
      event("new-pause", "run_paused", "new", "后续处理已暂停"),
    ];
    await act(async () =>
      root.render(
        createElement(ProcessView, { task, dispatch: async () => null }),
      ),
    );
    assert.match(
      document.querySelector('[aria-label="公开分析脉络"]')!.textContent!,
      /前次已经确认离线使用的依据/,
    );
    assert.equal(document.querySelectorAll(".process-member").length, 1);
    assert.match(
      document.querySelector('[aria-label="本次成员状态"]')!.textContent!,
      /已暂停/,
    );
    const select = Array.from(document.querySelectorAll("select")).find(
      (select) => select.parentElement?.textContent?.includes("过程范围"),
    )!;
    assert.ok(select);
    Object.defineProperty(select, "value", {
      value: "run",
      writable: true,
      configurable: true,
    });
    await act(async () =>
      select.dispatchEvent(new window.Event("change", { bubbles: true })),
    );
    assert.doesNotMatch(
      document.querySelector('[aria-label="公开分析脉络"]')!.textContent!,
      /前次已经确认离线使用的依据/,
    );
    assert.match(
      document.querySelector('[aria-label="公开分析脉络"]')!.textContent!,
      /尚未留下可展示的公开分析/,
    );
    await act(async () => click(window, document, "排障记录"));
    assert.match(
      document.querySelector('[aria-label="排障记录"]')!.textContent!,
      /后续处理已暂停/,
    );
    assert.doesNotMatch(
      document.querySelector('[aria-label="排障记录"]')!.textContent!,
      /第一轮已完成/,
    );
    select.value = "goal";
    await act(async () =>
      select.dispatchEvent(new window.Event("change", { bubbles: true })),
    );
    assert.equal(document.querySelector(".process-layer-tabs"), null);
    assert.match(
      document.querySelector('[aria-label="成员分析与贡献"]')!.textContent!,
      /历史协作已完成且保留回复/,
    );
    assert.ok(document.querySelector('[data-provenance="public_reply"]'));
    assert.doesNotMatch(
      document.querySelector('[aria-label="公开分析脉络"]')!.textContent!,
      /此记录没有保留完整回复/,
    );
  });
});

test("rich public process details collapse independently and websites keep truthful source states", async () => {
  await withDom(async ({ document, window, root, act, createElement }) => {
    const { ProcessView } = await import("../src/workbench/ProcessView.js");
    const task = fixture();
    task.events = [
      {
        id: "analysis",
        type: "progress_reported",
        summary: "先核查样本是否可比。",
        member: "coordinator",
        goalVersion: 2,
        createdAt: task.createdAt,
        data: {
          stage: "method",
          detail: "公开详细说明：比较样本、时间范围与统计口径。",
          method: "检查原始定义并交叉对照。",
          questions: ["是否缺少样本？"],
          privateReasoning: "PRIVATE_CHAIN",
        },
      },
      {
        id: "google",
        type: "progress_reported",
        summary: "返回搜索资料",
        member: "researcher",
        goalVersion: 2,
        createdAt: task.createdAt,
        data: {
          hosted: true,
          progressKind: "source",
          queries: ["sample comparison methods"],
          webSources: [
            {
              title: "仅搜索命中",
              url: "https://example.com/hit",
              status: "searched",
              snippet: "Search snippet",
            },
            {
              title: "已核查网站",
              url: "https://example.com/read",
              status: "read",
              snippet: "A verified excerpt",
            },
          ],
        },
      },
    ];
    const commands: string[] = [];
    await act(async () =>
      root.render(
        createElement(ProcessView, {
          task,
          dispatch: async (command) => {
            if (command.type === "url.open") commands.push(command.url);
            return null;
          },
        }),
      ),
    );
    const details = document.querySelector<HTMLDetailsElement>(
      ".analysis-full-detail",
    )!;
    assert.ok(details);
    assert.equal(Boolean(details.open), false);
    assert.match(details.textContent!, /检查原始定义并交叉对照/);
    assert.match(details.textContent!, /是否缺少样本/);
    assert.doesNotMatch(document.body.textContent!, /PRIVATE_CHAIN/);
    details.open = true;
    assert.equal(details.open, true);
    details.open = false;
    assert.equal(details.open, false);
    assert.equal(document.querySelector('[aria-label="核查资料与网站"]'), null);
    await act(async () => click(window, document, "查看依据"));
    const cards = Array.from(document.querySelectorAll(".process-source-card"));
    assert.equal(cards.length, 2);
    assert.match(
      cards[0].querySelector(".source-read-state")!.textContent!,
      /搜索结果/,
    );
    assert.match(
      cards[1].querySelector(".source-read-state")!.textContent!,
      /已读取/,
    );
    assert.match(
      document.querySelector(".process-search-queries")!.textContent!,
      /sample comparison methods/,
    );
    await act(async () =>
      cards[0]
        .querySelector("button")!
        .dispatchEvent(new window.Event("click", { bubbles: true })),
    );
    assert.deepEqual(commands, ["https://example.com/hit"]);
  });
});

test("operational evidence stays available without fabricating analysis and exact saved revisions retain their identity", async () => {
  await withDom(async ({ document, window, root, act, createElement }) => {
    const { ProcessView } = await import("../src/workbench/ProcessView.js");
    const task = fixture();
    const event = (
      id: string,
      type: string,
      summary: string,
      data: Record<string, unknown> = {},
      goalVersion = 2,
    ) => ({
      id,
      type,
      summary,
      data,
      goalVersion,
      member: "coordinator" as const,
      createdAt: task.createdAt,
    });
    task.events = [
      event(
        "old",
        "artifact_written",
        "OLD_GOAL_SAVED",
        { artifactId: "doc-a" },
        1,
      ),
      event("requested", "tool_started", "REQUESTED_ONLY", {
        tool: "read_source",
        sourceId: "not-read",
      }),
      event("loaded", "skill_loaded", "已加载资料消化方法 v1.0.0", {
        skillId: "material-digest",
        name: "资料消化",
        version: "1.0.0",
        hash: "method-hash",
        sourceIds: ["not-read"],
        purpose: "核查既有材料",
      }),
      event("read", "tool_completed", "已读取原资料第 1 至 1200 字。", {
        tool: "read_source",
        sourceId: "read-material",
        readStart: 0,
        readEnd: 1200,
        totalCharacters: 2400,
        result: "PRIVATE_TOOL_BODY",
      }),
      event("read-artifact", "tool_completed", "已读取原成果第 2 版。", {
        tool: "read_artifact",
        artifactId: "doc-a",
      }),
      event("saved", "artifact_written", "已保存《方案说明》第 3 版。", {
        artifactId: "doc-a",
        version: 3,
      }),
      event("failed", "tool_failed", "另一份资料暂未能读取。", {
        tool: "read_source",
        sourceId: "not-read",
        reasoning: "PRIVATE_REASONING",
      }),
      event("waiting", "clarification_requested", "需要确认发布对象。"),
    ];
    const opened: string[] = [];
    await act(async () =>
      root.render(
        createElement(ProcessView, {
          task,
          dispatch: async () => null,
          onArtifactOpen: (id) => opened.push(id),
        }),
      ),
    );
    const narrative = document.querySelector('[aria-label="公开分析脉络"]')!;
    assert.match(narrative.textContent!, /需要确认发布对象/);
    assert.doesNotMatch(
      document.querySelector('[aria-label="成员分析与贡献"]')!.textContent!,
      /已读取原资料|已读取原成果|已加载资料消化方法|REQUESTED_ONLY|PRIVATE_/,
    );
    assert.equal(document.querySelector(".work-milestones"), null);
    const context = document.querySelector<HTMLDetailsElement>(
      ".process-context-history",
    )!;
    assert.ok(context);
    assert.equal(Boolean(context.open), false);
    assert.match(context.textContent!, /方案说明/);
    assert.equal(document.querySelector('[aria-label="排障记录"]'), null);
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
    await act(async () => click(window, document, "方案说明 · v3"));
    assert.match(
      document.querySelector('[aria-label="过程依据详情"]')!.textContent!,
      /历史版本未保留/,
    );
    assert.deepEqual(
      opened,
      [],
      "a missing v3 must not open the current v2 as if it were the referenced revision",
    );
    await act(async () => click(window, document, "排障记录"));
    const records = document.querySelector('[aria-label="排障记录"]')!;
    assert.match(records.textContent!, /REQUESTED_ONLY/);
    assert.match(records.textContent!, /已读取原资料第 1 至 1200 字/);
    assert.match(records.textContent!, /另一份资料暂未能读取/);
    assert.doesNotMatch(records.textContent!, /PRIVATE_|OLD_GOAL/);
  });
});
