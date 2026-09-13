import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import type {
  Command,
  RadarItem,
  RadarSnapshot,
  Snapshot,
  Task,
} from "../src/shared/types.js";

test("server topic evidence leads to reading without a task, pins the reading version, and hands off only on request", async () => {
  const { window, document } = parseHTML(
    '<html><body><div id="root"></div></body></html>',
  );
  const replacements = {
    window,
    document,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
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
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { RadarReader } = await import("../src/workbench/RadarReader.js");
  const root = createRoot(document.getElementById("root")!);
  const timestamp = "2026-09-12T12:00:00.000Z";
  const item: RadarItem = {
    id: "local-reader-item",
    remoteItemId: "remote-reader-item",
    serverInstanceId: "server-reader-test",
    tenantId: "reader-test",
    sourceId: "source-reader",
    origin: "recommended",
    sourceTitle: "实际订阅",
    category: "开发工具",
    title: "可阅读的工具变化",
    url: "https://example.com/reader",
    excerpt: "最新来源摘录",
    content: "发布时间：2026-09-10T10:00:00.000Z\n\n来源正文第二版。",
    latestRevisionId: "revision-2",
    contentHash: "b".repeat(64),
    coverageLevel: "fulltext",
    missing: [],
    revisionCount: 2,
    isUpdated: true,
    taskIds: [],
    sourceAssetIds: [],
    receivedAt: timestamp,
    observedAt: timestamp,
  };
  const radar: RadarSnapshot = {
    configured: true,
    connection: "online",
    serviceURL: "https://reader.example.com",
    follows: [],
    recommendedSources: [],
    digests: [],
    digestions: [],
    dispositions: [],
    events: [],
    unreadCount: 1,
    items: [item],
    readingTopics: [
      {
        id: "reading-topic",
        category: "开发工具",
        title: "服务器整理的重点",
        summary: "根据取得的材料形成的主题。",
        generatedAt: timestamp,
        model: "fixture",
        inputHash: "a".repeat(64),
        points: [
          {
            title: "需关注的变化",
            detail: "只来自已取得的证据。",
            sourceIds: [item.remoteItemId],
          },
        ],
        caveats: ["不能推定未读取内容。"],
        evidence: [
          {
            itemId: item.remoteItemId,
            revisionId: "revision-1",
            title: item.title,
            url: item.url,
            coverage: "metadata",
            excerpt: "整理时的原始摘要第一版。",
          },
        ],
      },
    ],
  };
  const before = { id: "previous-task" } as Task;
  const created = {
    id: "new-reading-task",
    sources: [{ remote: { itemId: item.remoteItemId } }],
  } as Task;
  const commands: Command[] = [];
  const opened: string[] = [];
  const render = () =>
    root.render(
      createElement(RadarReader, {
        radar,
        tasks: [before],
        onSources: () => {},
        onTask: (id: string) => opened.push(id),
        dispatch: async (command: Command) => {
          commands.push(command);
          return { tasks: [before, created] } as Snapshot;
        },
      }),
    );
  const click = async (label: string, selector = "button") => {
    const target = Array.from(document.querySelectorAll(selector)).find(
      (node) => node.textContent?.includes(label),
    );
    assert.ok(target, `action exists: ${label}`);
    await act(async () => {
      target.dispatchEvent(new window.Event("click", { bubbles: true }));
      await Promise.resolve();
    });
  };
  try {
    await act(render);
    assert.match(document.body.textContent!, /服务器整理的重点/);
    assert.match(
      document.querySelector(".radar-topic-evidence")!.textContent!,
      /整理时的原始摘要第一版/,
    );
    assert.match(
      document.querySelector(".radar-topic-source")!.textContent!,
      /来源已更新/,
    );
    assert.equal(commands.length, 0);
    await click("可阅读的工具变化", ".radar-topic-source");
    assert.match(
      document.querySelector(".radar-article-body")!.textContent!,
      /正文第二版/,
    );
    assert.match(
      document.querySelector(".radar-article-meta")!.textContent!,
      /发布于/,
    );
    assert.deepEqual(
      commands.map((command) => command.type),
      ["radar.markRead"],
    );
    radar.items = [
      {
        ...item,
        content: "来源正文第三版。",
        latestRevisionId: "revision-3",
        contentHash: "c".repeat(64),
      },
    ];
    await act(render);
    assert.match(
      document.querySelector(".radar-article-body")!.textContent!,
      /正文第二版/,
    );
    assert.match(document.body.textContent!, /来源已有新版本/);
    const handoff = Array.from(document.querySelectorAll("button")).find(
      (node) => node.textContent?.includes("交给团队"),
    )!;
    assert.equal(handoff.hasAttribute("disabled"), true);
    await click("阅读最新版本");
    assert.match(
      document.querySelector(".radar-article-body")!.textContent!,
      /正文第三版/,
    );
    await click("交给团队");
    assert.deepEqual(opened, [created.id]);
    const request = commands.find(
      (command) => command.type === "radar.createTask",
    );
    assert.ok(request?.type === "radar.createTask");
    assert.deepEqual(request.itemIds, [item.id]);
  } finally {
    await act(() => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
