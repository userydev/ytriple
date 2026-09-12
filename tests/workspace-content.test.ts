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
      button.textContent === label ||
      button.getAttribute("aria-label") === label,
  );
  assert.ok(button, label);
  button.dispatchEvent(new window.Event("click", { bubbles: true }));
}

test("artifact catalog keeps the live editor mounted through result selection and conversation details", async () => {
  await withDom(async ({ document, window, root, act, createElement }) => {
    const { ArtifactList } = await import("../src/workbench/Artifacts.js");
    const task = fixture();
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
    assert.equal(
      document.querySelectorAll(".artifact-catalog-group").length,
      2,
    );
    assert.match(
      document.querySelector(".artifact-catalog")!.textContent!,
      /旧目标 v1/,
    );
    await act(async () => click(window, document, "编辑"));
    const editor =
      document.querySelector<HTMLTextAreaElement>(".artifact-editor")!;
    assert.ok(editor);
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
    assert.match(
      document.querySelector(".conversation-detail")!.textContent!,
      /真实原文/,
    );
    await act(async () => click(window, document, "保存为文档"));
    assert.equal(saved, 1);
    await act(async () => root.render(createElement(ArtifactList, props)));
    assert.equal(document.querySelector(".artifact-editor"), editor);
    assert.equal(editor.closest("[hidden]"), null);
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          '.artifact-catalog-item[title="方案图片"]',
        )!
        .dispatchEvent(new window.Event("click", { bubbles: true })),
    );
    assert.ok(editor.closest("[hidden]"));
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          '.artifact-catalog-item[title="方案说明"]',
        )!
        .dispatchEvent(new window.Event("click", { bubbles: true })),
    );
    assert.equal(document.querySelector(".artifact-editor"), editor);
    assert.equal(editor.closest("[hidden]"), null);
  });
});

test("process layers separate actual reasoning summaries, teammate dialogue and execution records", async () => {
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
      document.querySelector('[aria-label="公开分析摘要"]')!.textContent!,
      /先确认是否必须离线使用/,
    );
    assert.doesNotMatch(
      document.body.textContent!,
      /执行日志专有内容|PRIVATE_/,
    );
    const conversation = Array.from(
      document.querySelectorAll(".process-layer-tabs button"),
    ).find((button) => button.textContent?.startsWith("成员对话"))!;
    await act(async () =>
      conversation.dispatchEvent(new window.Event("click", { bubbles: true })),
    );
    assert.match(
      document.querySelector('[aria-label="实际成员对话"]')!.textContent!,
      /比较离线可行性/,
    );
    assert.match(
      document.querySelector('[aria-label="实际成员对话"]')!.textContent!,
      /第一种方案可以离线使用/,
    );
    assert.doesNotMatch(document.body.textContent!, /PRIVATE_/);
    await act(async () => click(window, document, "执行记录"));
    assert.match(
      document.querySelector('[aria-label="执行记录"]')!.textContent!,
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

test("process defaults to all current-goal history and can switch to the latest paused run", async () => {
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
      document.querySelector('[aria-label="公开分析摘要"]')!.textContent!,
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
      document.querySelector('[aria-label="公开分析摘要"]')!.textContent!,
      /前次已经确认离线使用的依据/,
    );
    assert.match(
      document.querySelector('[aria-label="公开分析摘要"]')!.textContent!,
      /还没有公开分析摘要/,
    );
    select.value = "goal";
    await act(async () =>
      select.dispatchEvent(new window.Event("change", { bubbles: true })),
    );
    const conversation = Array.from(
      document.querySelectorAll(".process-layer-tabs button"),
    ).find((button) => button.textContent?.startsWith("成员对话"))!;
    await act(async () =>
      conversation.dispatchEvent(new window.Event("click", { bubbles: true })),
    );
    assert.match(
      document.querySelector('[aria-label="实际成员对话"]')!.textContent!,
      /历史协作已完成且保留回复/,
    );
    assert.match(
      document.querySelector(".exchange-status")!.textContent!,
      /已完成/,
    );
  });
});
