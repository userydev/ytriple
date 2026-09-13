import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import {
  editorialPresentation,
  editorialRevision,
} from "./fixtures/editorial.js";
import type { Command, Snapshot, Task } from "../src/shared/types.js";

test("editorial home is readable, details pin evidence across updates, and only explicit handoff creates a task", async () => {
  const { window, document } = parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>',
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
  const { Radar } = await import("../src/workbench/Radar.js");
  const root = createRoot(document.getElementById("root")!);
  const first = editorialRevision();
  first.presentation = editorialPresentation(first);
  const latest = editorialRevision({
    id: "31bbe094-f8ef-4d17-89f0-eedb4e9a3f93",
    version: 2,
    takeaway: "第二版已经补充新的成功率条件。",
    relationship: "第二版用同一批任务比较成功率与重试消耗。",
    changeKind: "update",
    changeSummary: "加入同一组任务的成功率条件。",
    evidence: [{ ...first.evidence[0]!, excerpt: "第二版使用的新材料。" }],
  });
  latest.presentation = editorialPresentation(latest);
  latest.presentation.visual.conclusion = latest.relationship;
  let snapshot = {
    tasks: [],
    radar: {
      editorialIdentity: "editorial-ui-test",
      configured: true,
      connection: "online",
      items: [],
      follows: [],
      recommendedSources: [],
      unreadCount: 0,
      editorial: {
        status: { state: "ready" },
        issues: [
          {
            id: first.issueId,
            focus: "AI",
            createdAt: first.createdAt,
            updatedAt: first.createdAt,
            latest: first,
            history: [first],
            corrections: [],
          },
        ],
      },
      editorialVersions: { [first.id]: first },
    },
  } as unknown as Snapshot;
  const commands: Command[] = [];
  const opened: string[] = [];
  let deferred: ((value: Snapshot) => void) | undefined;
  const dispatch = async (command: Command): Promise<Snapshot> => {
    commands.push(command);
    if (command.type === "radar.discussEditorial")
      return new Promise((resolve) => {
        deferred = resolve;
      });
    return structuredClone(snapshot);
  };
  const render = () =>
    root.render(
      createElement(Radar, {
        snapshot,
        dispatch,
        connected: true,
        onTask: (id: string) => opened.push(id),
      }),
    );
  const click = async (label: string) => {
    const target = Array.from(document.querySelectorAll("button")).find(
      (button) =>
        button.textContent?.includes(label) ||
        button.getAttribute("aria-label") === label,
    );
    assert.ok(target, label);
    await act(async () => {
      target.dispatchEvent(new window.Event("click", { bubbles: true }));
      await Promise.resolve();
    });
  };
  try {
    await act(render);
    assert.match(
      document.querySelector(".editorial-stories")!.textContent!,
      /同一任务和质量标准/,
    );
    assert.equal(commands.length, 0);
    assert.equal(document.querySelector(".radar-reader"), null);
    assert.equal(
      document.querySelector('[aria-label="事实与判断信息图"]'),
      null,
    );
    assert.ok(document.querySelector('[aria-label="解读关系图"]'));
    assert.equal(document.querySelector(".radar-edition img"), null);
    await click("查看依据：单次标价");
    assert.match(
      document.querySelector('[aria-label="就地查看依据"]')!.textContent!,
      /测试公告提供了单价变化/,
    );
    assert.match(
      document.querySelector('[aria-label="就地查看依据"]')!.textContent!,
      /不能当作独立实测/,
    );
    assert.equal(document.querySelector(".editorial-detail"), null);
    assert.equal(commands.length, 0);
    await click("收起依据");
    await click("纠正解读");
    assert.ok(document.querySelector('textarea[aria-label="纠正内容"]'));
    assert.equal(document.querySelector(".editorial-detail"), null);
    await click("关闭对话框");
    assert.equal(
      document.querySelectorAll(".editorial-navigation button").length,
      3,
    );
    assert.equal(
      Array.from(document.querySelectorAll(".radar-edition-focus button")).some(
        (button) => button.textContent === "股票",
      ),
      false,
    );
    await click("阅读解读");
    assert.equal(document.querySelector('[aria-label="本篇脉络"]'), null);
    assert.ok(document.querySelector("#editorial-section-1"));
    assert.match(
      document.querySelector('[aria-label="解读操作"]')!.textContent!,
      /查看依据.*纠正解读.*历史.*继续研究/,
    );
    assert.match(
      document.querySelector(".editorial-detail")!.textContent!,
      /尚不能确定/,
    );
    assert.match(
      document.querySelector(".editorial-conditions")!.textContent!,
      /同一批任务/,
    );
    await act(() =>
      document
        .querySelector(".editorial-citations")!
        .dispatchEvent(new window.Event("click", { bubbles: true })),
    );
    assert.match(
      document.querySelector('[aria-label="段落依据"]')!.textContent!,
      /不能当作独立实测/,
    );
    await act(() =>
      document
        .querySelector(".editorial-citations")!
        .dispatchEvent(new window.Event("click", { bubbles: true })),
    );
    assert.equal(
      commands.some(
        (command) =>
          command.type.includes("Task") || command.type === "radar.digest",
      ),
      false,
    );
    snapshot.radar!.editorial!.issues[0] = {
      ...snapshot.radar!.editorial!.issues[0]!,
      latest,
      history: [latest, first],
    };
    await act(render);
    assert.match(
      document.querySelector(".editorial-lead")!.textContent!,
      /测试材料显示/,
    );
    await click("查看依据");
    assert.match(
      document.querySelector(".editorial-excerpt")!.textContent!,
      /确定性测试材料/,
    );
    await click("关闭对话框");
    assert.match(
      document.querySelector(".editorial-update")!.textContent!,
      /加入同一组任务/,
    );
    await click("阅读当前版本");
    assert.match(
      document.querySelector(".editorial-lead")!.textContent!,
      /第二版已经补充/,
    );
    await click("查看依据");
    assert.match(
      document.querySelector(".editorial-excerpt")!.textContent!,
      /第二版使用的新材料/,
    );
    await click("关闭对话框");
    await click("纠正解读");
    assert.ok(document.querySelector('textarea[aria-label="纠正内容"]'));
    assert.equal(document.querySelector('[role="dialog"] details'), null);
    await click("关闭对话框");
    await click("历史");
    assert.match(
      document.querySelector(".editorial-history")!.textContent!,
      /第 2 版.*第 1 版/,
    );
    await click("阅读这一版");
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await click("纠正解读");
    const submit = Array.from(document.querySelectorAll("button")).find(
      (value) => value.textContent === "提交纠正",
    );
    assert.equal(submit!.disabled, true);
    assert.match(
      document.querySelector('[role="dialog"]')!.textContent!,
      /当前版本/,
    );
    await click("关闭对话框");
    assert.match(
      document.querySelector(".editorial-lead")!.textContent!,
      /测试材料显示/,
    );
    await click("交给团队继续");
    await click("交给团队继续");
    const calls = commands.filter(
      (command) => command.type === "radar.discussEditorial",
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.revisionId, first.id);
    const task = { id: calls[0]!.requestId } as Task;
    await act(async () => {
      deferred?.({ ...snapshot, tasks: [task] });
    });
    assert.deepEqual(opened, [task.id]);
    await click("全部解读");
    assert.equal(
      document.querySelector(".journal-understanding")!.textContent!,
      first.presentation!.summary,
    );
    assert.match(
      document.querySelector(".radar-new-edition")!.textContent!,
      /新理解/,
    );
    await click("查看新版");
    assert.match(
      document.querySelector(".journal-understanding")!.textContent!,
      /第二版用同一批任务/,
    );
    await click("有进展");
    assert.equal(
      document
        .querySelector(".radar-updates-filter")!
        .getAttribute("aria-pressed"),
      "true",
    );
    await click("阅读解读");
    await click("全部解读");
    assert.equal(
      document
        .querySelector(".radar-updates-filter")!
        .getAttribute("aria-pressed"),
      "true",
    );
    await click("来源材料");
    await click("管理来源与订阅");
    assert.ok(document.querySelector("#radar-follow-url"));
    await click("关闭对话框");
    const homeNav = document.querySelector(".editorial-navigation button")!;
    await act(() =>
      homeNav.dispatchEvent(new window.Event("click", { bubbles: true })),
    );
    assert.ok(document.querySelector(".editorial-stories"));
    await click("有进展");
    const additional = Array.from({ length: 10 }, (_, index) => {
      const revision = editorialRevision({
        id: `51000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        issueId: `52000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        title: `金融测试议题 ${index + 1}`,
      });
      return {
        id: revision.issueId,
        focus: "金融" as const,
        createdAt: revision.createdAt,
        updatedAt: revision.createdAt,
        latest: revision,
        history: [revision],
        corrections: [],
      };
    });
    snapshot.radar!.editorial!.issues.push(...additional);
    await act(render);
    await click("金融");
    await click("有进展");
    assert.match(
      document.querySelector(".journal-empty")!.textContent!,
      /没有后续更新/,
    );
    await click("查看全部解读");
    assert.equal(
      document.querySelector(
        '.radar-edition-focus button[aria-current="page"]',
      )!.textContent,
      "全部解读",
    );
    assert.equal(
      document
        .querySelector(".radar-updates-filter")!
        .getAttribute("aria-pressed"),
      "false",
    );
    assert.equal(document.querySelector(".journal-empty"), null);
    await click("再看 2 条解读");
    const lastTopic = document.querySelector(
      `[data-editorial-issue="${additional[9]!.id}"]`,
    )!;
    assert.ok(lastTopic);
    await act(() =>
      lastTopic.dispatchEvent(new window.Event("click", { bubbles: true })),
    );
    await click("全部解读");
    assert.ok(
      document.querySelector(`[data-editorial-issue="${additional[9]!.id}"]`),
    );
    snapshot = {
      ...snapshot,
      radar: {
        ...snapshot.radar!,
        editorialIdentity: "another-editorial-server",
        editorial: { status: { state: "waiting" }, issues: [] },
      },
    };
    await act(render);
    assert.equal(document.querySelector(".editorial-detail"), null);
    assert.doesNotMatch(document.body.textContent!, /测试材料显示/);
    const selectedIssue = additional[0]!;
    selectedIssue.latest.cover = {
      data: "data:image/png;base64,AQID",
      pageUrl: "https://example.com/report",
      imageUrl: "https://example.com/report.png",
      publisher: "Fixture Report",
      description: "来源的报道配图",
      width: 800,
      height: 450,
    };
    snapshot.radar!.editorialIdentity = "edition-order-test";
    snapshot.radar!.editorial = {
      status: { state: "ready" },
      issues: [additional[1]!, selectedIssue],
      edition: {
        id: "de000000-0000-4000-8000-000000000001",
        createdAt: first.createdAt,
        entries: [
          {
            issueId: selectedIssue.id,
            presentation: editorialPresentation(selectedIssue.latest),
            reason: "具有明确可核查的条件。",
          },
        ],
        note: "按新增理解选编。",
      },
    };
    await act(render);
    assert.equal(
      document.querySelector(".journal-source-cover img")?.getAttribute("alt"),
      "来源的报道配图",
    );
    await click("报道配图 · Fixture Report");
    assert.deepEqual(commands.at(-1), {
      type: "url.open",
      url: "https://example.com/report",
    });
    assert.equal(
      document
        .querySelector('[aria-label="重点解读"] [data-editorial-issue]')
        ?.getAttribute("data-editorial-issue"),
      selectedIssue.id,
    );
    assert.equal(
      document.querySelector(`[data-editorial-issue="${additional[1]!.id}"]`),
      null,
    );
    await click("浏览全部议题");
    assert.ok(
      document.querySelector(`[data-editorial-issue="${additional[1]!.id}"]`),
    );
    await click("阅读解读");
    await click("全部解读");
    assert.ok(
      document.querySelector(`[data-editorial-issue="${additional[1]!.id}"]`),
    );
    await click("回到本期选读");
    snapshot.radar!.editorial!.edition!.entries = [];
    await act(render);
    assert.match(
      document.querySelector(".journal-empty")!.textContent!,
      /本期没有新的选读/,
    );
    assert.equal(document.querySelector('[aria-label="重点解读"]'), null);
    await click("浏览全部议题");
    assert.ok(
      document.querySelector(`[data-editorial-issue="${additional[1]!.id}"]`),
    );
    snapshot = {
      ...snapshot,
      radar: {
        configured: false,
        connection: "unconfigured",
        editorialIdentity: "empty-own-materials",
        items: [],
        follows: [],
        recommendedSources: [],
        unreadCount: 0,
      },
    };
    await act(render);
    assert.match(
      document.querySelector(".editorial-empty")!.textContent!,
      /从自己的材料开始阅读/,
    );
    assert.equal(
      document.querySelector(".radar-connect-form"),
      null,
      "the reading home never becomes a service setup form",
    );
    assert.equal(
      document.querySelector(".portable-form"),
      null,
      "imports open only when requested",
    );
    await click("导入链接或收藏");
    assert.ok(document.querySelector(".portable-form"));
    assert.equal(
      document
        .querySelector('[name="fetchURLs"]')
        ?.closest("fieldset")
        ?.hasAttribute("disabled"),
      false,
    );
    await click("返回解读");
    assert.equal(document.querySelector(".portable-form"), null);
    await act(() =>
      document
        .querySelectorAll(".editorial-navigation button")[1]!
        .dispatchEvent(new window.Event("click", { bubbles: true })),
    );
    assert.ok(document.querySelector('[aria-label="来源材料筛选"]'));
    assert.equal(
      document.querySelector(".radar-reader-nav"),
      null,
      "source filters use a compact control row instead of another sidebar",
    );
    await click("导入链接或收藏");
    assert.ok(document.querySelector(".portable-form"));
  } finally {
    await act(() => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
