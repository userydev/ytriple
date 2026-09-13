import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import type {
  Command,
  RadarItem,
  Snapshot,
  Task,
} from "../src/shared/types.js";

const observedAt = "2026-09-12T18:10:00.000Z";

function publishedAt(dayOffset: number): string {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + dayOffset);
  return date.toISOString();
}

const todayPublishedAt = publishedAt(0);
const yesterdayPublishedAt = publishedAt(-1);

function radarItem(
  id: string,
  origin: RadarItem["origin"],
  title: string,
  overrides: Partial<RadarItem> = {},
): RadarItem {
  return {
    id,
    serverInstanceId: "source-service-test",
    tenantId: "tenant-test",
    sourceId: `source-${id}`,
    remoteItemId: id,
    followId: origin === "user" ? "follow-user" : undefined,
    origin,
    sourceTitle: origin === "user" ? "用户指定站点" : "产品与工具观察",
    title,
    url: `https://example.com/${id}`,
    excerpt: `${title}的真实接收片段`,
    content: `${title}的真实接收正文`,
    receivedAt: observedAt,
    observedAt,
    latestRevisionId: `revision-${id}`,
    contentHash: id.padEnd(64, "0").slice(0, 64),
    coverageLevel: "fulltext",
    missing: [],
    revisionCount: 1,
    isUpdated: false,
    taskIds: [],
    sourceAssetIds: [],
    ...overrides,
  };
}

function snapshotFixture(): Snapshot {
  const digestedUser = radarItem(
    "digested-user",
    "user",
    "Agents SDK 工具调用协议更新",
    {
      latestRevisionId: "revision-digested-user-v2",
      revisionCount: 2,
      isUpdated: true,
      ...({
        summary: "不得从 RadarItem 读取的伪摘要",
        topics: ["不得从 RadarItem 读取的伪主题"],
      } as unknown as Partial<RadarItem>),
    },
  );
  const digestedServer = radarItem(
    "digested-server",
    "server",
    "服务端观察到相同协议的兼容性变化",
  );
  const filtered = radarItem(
    "filtered-low",
    "server",
    "重复转载且没有新增事实",
  );
  const rawUser = radarItem(
    "raw-user",
    "user",
    "用户收藏中正在消化的原始信号",
    {
      ...({
        summary: "原始条目里的字段不能让它变成主题",
      } as unknown as Partial<RadarItem>),
    },
  );
  const rawServer = radarItem(
    "raw-server",
    "server",
    "服务器刚推送的待判断信号",
  );
  const failed = radarItem("failed-item", "server", "上次整理失败的信号");
  const paused = radarItem("paused-item", "user", "团队暂停中的信号");
  const unpublished = radarItem(
    "unpublished-item",
    "server",
    "任务完成但没有发布的信号",
  );
  return {
    version: "test",
    dataPath: "/unused/test.sqlite",
    tasks: [],
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
      policyPath: "/unused/AI/system/POLICY.md",
      issues: [],
    },
    projects: [],
    library: [
      {
        id: "lib-agent-runtime",
        title: "成员协作边界",
        path: "/unused/lib/agent-runtime.md",
        format: "md",
        hash: "a".repeat(64),
        version: 2,
        savedAt: observedAt,
        updatedAt: observedAt,
        tags: ["agent"],
        note: "",
        source: {
          taskId: "source-task",
          taskTitle: "成员运行时研究",
          artifactId: "artifact-agent-runtime",
          artifactVersion: 2,
          artifactHash: "a".repeat(64),
          goalVersion: 1,
        },
        versions: [],
      },
    ],
    radar: {
      configured: true,
      connection: "online",
      lastSyncAt: observedAt,
      unreadCount: 5,
      follows: [
        {
          id: "follow-user",
          sourceId: "source-user",
          origin: "user",
          name: "用户指定站点",
          category: "web",
          url: "https://example.com/feed",
          state: "active",
          refreshIntervalMinutes: 60,
          createdAt: observedAt,
          updatedAt: observedAt,
          lastSuccessAt: observedAt,
        },
      ],
      recommendedSources: [
        {
          id: "recommended-tools",
          name: "产品与工具观察",
          description: "服务端提供的通用工具变化来源",
          category: "tools",
          url: "https://example.org/tools",
        },
      ],
      items: [
        digestedUser,
        digestedServer,
        filtered,
        rawUser,
        rawServer,
        failed,
        paused,
        unpublished,
      ],
      evidenceRevisions: {
        [digestedUser.id]: {
          "revision-digested-user-v1": {
            sourceId: "locked-source-user",
            remoteItemId: digestedUser.remoteItemId,
            revisionId: "revision-digested-user-v1",
            title: "Agents SDK 工具调用协议更新",
            url: digestedUser.url,
            content: "第一版锁定的真实正文：旧参数需要恢复令牌。",
            contentHash: "1".repeat(64),
            observedAt: "2026-09-11T18:10:00.000Z",
            coverageLevel: "fulltext",
            missing: [],
          },
        },
        [digestedServer.id]: {
          [digestedServer.latestRevisionId]: {
            sourceId: "locked-source-server",
            remoteItemId: digestedServer.remoteItemId,
            revisionId: digestedServer.latestRevisionId,
            title: digestedServer.title,
            url: digestedServer.url,
            content: "服务器来源锁定的真实正文：第二个来源确认兼容变化。",
            contentHash: digestedServer.contentHash,
            observedAt: digestedServer.observedAt,
            coverageLevel: digestedServer.coverageLevel,
            missing: [],
          },
        },
        [filtered.id]: {
          [filtered.latestRevisionId]: {
            sourceId: "locked-source-filtered",
            remoteItemId: filtered.remoteItemId,
            revisionId: filtered.latestRevisionId,
            title: filtered.title,
            url: filtered.url,
            content: "筛选判断所用的锁定正文：这是一条重复转载。",
            contentHash: filtered.contentHash,
            observedAt: filtered.observedAt,
            coverageLevel: filtered.coverageLevel,
            missing: [],
          },
        },
      },
      digestions: [
        {
          id: "run-published",
          taskId: "background-published",
          goalVersion: 1,
          serverInstanceId: "source-service-test",
          tenantId: "tenant-test",
          state: "published",
          taskStatus: "completed",
          createdAt: "2026-09-12T18:00:00.000Z",
          publishedAt: todayPublishedAt,
          items: [
            {
              radarItemId: digestedUser.id,
              sourceId: "locked-source-user",
              remoteItemId: digestedUser.remoteItemId,
              revisionId: "revision-digested-user-v1",
              contentHash: "1".repeat(64),
            },
            {
              radarItemId: digestedServer.id,
              sourceId: "locked-source-server",
              remoteItemId: digestedServer.remoteItemId,
              revisionId: digestedServer.latestRevisionId,
              contentHash: digestedServer.contentHash,
            },
            {
              radarItemId: filtered.id,
              sourceId: "locked-source-filtered",
              remoteItemId: filtered.remoteItemId,
              revisionId: filtered.latestRevisionId,
              contentHash: filtered.contentHash,
            },
          ],
          contextSources: [
            {
              sourceId: "context-lib-agent-runtime",
              kind: "library",
              referenceId: "lib-agent-runtime",
              version: 2,
              hash: "a".repeat(64),
            },
          ],
        },
        {
          id: "run-running",
          taskId: "background-running",
          goalVersion: 1,
          serverInstanceId: "source-service-test",
          tenantId: "tenant-test",
          state: "pending",
          taskStatus: "running",
          createdAt: observedAt,
          items: [
            {
              radarItemId: rawUser.id,
              sourceId: "locked-source-raw-user",
              remoteItemId: rawUser.remoteItemId,
              revisionId: rawUser.latestRevisionId,
              contentHash: rawUser.contentHash,
            },
          ],
          contextSources: [],
        },
        ...[
          [failed, "failed"],
          [paused, "paused"],
          [unpublished, "completed"],
        ].map(([item, taskStatus], index) => ({
          id: `run-${(item as RadarItem).id}`,
          taskId: `background-${(item as RadarItem).id}`,
          goalVersion: 1,
          serverInstanceId: "source-service-test",
          tenantId: "tenant-test",
          state: "pending" as const,
          taskStatus: taskStatus as "failed" | "paused" | "completed",
          error: taskStatus === "failed" ? "模型连接中断" : undefined,
          createdAt: `2026-09-12T18:0${index + 1}:00.000Z`,
          items: [
            {
              radarItemId: (item as RadarItem).id,
              sourceId: `locked-source-${(item as RadarItem).id}`,
              remoteItemId: (item as RadarItem).remoteItemId,
              revisionId: (item as RadarItem).latestRevisionId,
              contentHash: (item as RadarItem).contentHash,
            },
          ],
          contextSources: [],
        })),
      ],
      digests: [
        {
          id: "digest-agent-runtime",
          runId: "run-published",
          taskId: "background-published",
          goalVersion: 1,
          serverInstanceId: "source-service-test",
          tenantId: "tenant-test",
          title: "Agent 协作基础设施",
          summary:
            "工具调用协议加入更稳定的中断恢复语义，同时旧版恢复参数开始退出；两条独立来源共同确认了迁移方向。",
          whyItMatters:
            "这会影响 ytriple 的任务接续、失败恢复和证据留存方式，需要核对当前成员运行时的兼容边界。",
          topics: ["Agent 协作", "恢复协议"],
          evidence: [
            {
              sourceId: "locked-source-user",
              revisionId: "revision-digested-user-v1",
              note: "官方变更记录说明了新的恢复语义。",
            },
            {
              sourceId: "locked-source-server",
              revisionId: digestedServer.latestRevisionId,
              note: "第二条官方来源确认旧参数退出。",
            },
          ],
          context: [
            {
              sourceId: "context-lib-agent-runtime",
              relation: "extends",
              note: "补充了既有协作边界中尚未覆盖的中断恢复条件。",
            },
          ],
          disagreements: ["旧参数的最终停用日期尚未一致"],
          gaps: ["还缺少一次本机恢复回归验证"],
          publishedAt: todayPublishedAt,
        },
      ],
      dispositions: [
        {
          id: "disposition-filtered",
          runId: "run-published",
          taskId: "background-published",
          goalVersion: 1,
          serverInstanceId: "source-service-test",
          tenantId: "tenant-test",
          sourceId: "locked-source-filtered",
          kind: "duplicate",
          reason: "内容只是已引用官方来源的重复转载，没有新增事实。",
          publishedAt: observedAt,
        },
      ],
      events: [],
    },
  };
}

function createdTask(): Task {
  return {
    id: "radar-task",
    title: "继续研究雷达信号",
    goal: "理解雷达信号",
    goalVersion: 1,
    kind: "research",
    member: "coordinator",
    workspace: "/unused/radar-task",
    status: "idle",
    createdAt: observedAt,
    updatedAt: observedAt,
    messages: [],
    events: [],
    sources: [],
    artifacts: [],
  };
}

test("Radar opens server information for reading and retains earlier team topics", async () => {
  const snapshot = snapshotFixture();
  const currentDigest = snapshot.radar!.digests![0]!;
  snapshot.radar!.digests!.push({
    ...structuredClone(currentDigest),
    id: "digest-agent-runtime-history",
    title: "昨日的 Agent 协作判断",
    publishedAt: yesterdayPublishedAt,
  });
  snapshot.radar!.digestionError = "团队模型连接暂不可用";
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id='root'></div></body></html>",
  );
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

  const commands: Command[] = [];
  const openedTasks: string[] = [];
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { Radar } = await import("../src/workbench/Radar.js");
  const dispatch = async (command: Command): Promise<Snapshot> => {
    commands.push(command);
    if (command.type === "radar.createTask")
      return { ...structuredClone(snapshot), tasks: [createdTask()] };
    return structuredClone(snapshot);
  };
  const root = createRoot(document.getElementById("root")!);
  const button = (label: string, within: ParentNode = document) =>
    Array.from(within.querySelectorAll("button")).find((item) =>
      item.textContent?.includes(label),
    );
  const click = async (element: Element | null | undefined) => {
    assert.ok(element, "requested Radar action exists");
    await act(async () => {
      element.dispatchEvent(new window.Event("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  try {
    await act(async () =>
      root.render(
        createElement(Radar, {
          snapshot,
          dispatch,
          connected: true,
          onTask: (taskId: string) => openedTasks.push(taskId),
        }),
      ),
    );

    assert.equal(document.querySelector(".radar-page h1")?.textContent, "雷达");
    assert.match(document.body.textContent!, /信息源服务在线/);
    assert.ok(
      document.querySelector(".radar-reader"),
      "received server content is readable before any team run",
    );
    assert.ok(document.querySelectorAll(".radar-reading-card").length > 0);
    await click(button("团队处理记录"));
    await click(button("今日理解"));
    assert.match(document.body.textContent!, /今日主题理解/);
    assert.doesNotMatch(document.body.textContent!, /昨日的 Agent 协作判断/);
    assert.doesNotMatch(document.body.textContent!, /最新信号/);
    assert.equal(document.querySelectorAll(".radar-feed-card").length, 0);

    const digest = document.querySelector(".radar-digest");
    const themeCards = digest?.querySelectorAll(".radar-theme-card") ?? [];
    assert.ok(digest, "topic understanding is the primary Radar canvas");
    assert.equal(themeCards.length, 1, "a published digest becomes one theme");
    const theme = themeCards[0]!;
    assert.match(theme.textContent!, /Agent 协作基础设施/);
    assert.match(
      theme.textContent!,
      /工具调用协议加入更稳定的中断恢复语义，同时旧版恢复参数开始退出/,
    );
    assert.match(
      theme.textContent!,
      /这会影响 ytriple 的任务接续、失败恢复和证据留存方式/,
    );
    assert.match(theme.textContent!, /为什么重要|为何值得关注/);
    assert.match(theme.textContent!, /2 条锁定证据/);
    assert.match(theme.textContent!, /成员协作边界/);
    assert.match(theme.textContent!, /补充了既有协作边界/);
    assert.match(theme.textContent!, /旧参数的最终停用日期尚未一致/);
    assert.match(theme.textContent!, /还缺少一次本机恢复回归验证/);
    assert.doesNotMatch(theme.textContent!, /不得从 RadarItem 读取的伪摘要/);
    assert.doesNotMatch(theme.textContent!, /不得从 RadarItem 读取的伪主题/);
    assert.doesNotMatch(theme.textContent!, /原始条目里的字段不能让它变成主题/);

    const evidenceButton = button("查看证据", theme);
    assert.equal(evidenceButton?.getAttribute("aria-expanded"), "false");
    await click(evidenceButton);
    const evidence = theme.querySelector(".radar-theme-evidence");
    assert.ok(evidence);
    assert.match(evidence.textContent!, /Agents SDK 工具调用协议更新/);
    assert.match(evidence.textContent!, /服务端观察到相同协议的兼容性变化/);
    assert.match(evidence.textContent!, /用户指定站点/);
    assert.match(evidence.textContent!, /产品与工具观察/);
    assert.match(evidence.textContent!, /来源已有新修订/);
    assert.match(evidence.textContent!, /当前一致/);
    assert.match(evidence.textContent!, /判断所用修订正文/);
    assert.match(
      evidence.textContent!,
      /第一版锁定的真实正文：旧参数需要恢复令牌/,
    );
    assert.match(evidence.textContent!, /当前最新修订/);
    assert.doesNotMatch(
      evidence.textContent!,
      /Agents SDK 工具调用协议更新的真实接收正文/,
    );

    await click(button("和团队核对", theme));
    const verification = commands.find(
      (command) =>
        command.type === "radar.createTask" &&
        command.title?.startsWith("核对 Radar 理解"),
    );
    assert.ok(verification && verification.type === "radar.createTask");
    assert.deepEqual(verification.itemIds, [
      "digested-user",
      "digested-server",
    ]);
    assert.match(verification.instruction ?? "", /不自动修改当前简报/);
    assert.deepEqual(openedTasks, ["radar-task"]);

    const inbox = document.querySelector(".radar-inbox");
    assert.ok(inbox, "raw arrivals remain available as a secondary queue");
    assert.deepEqual(
      Array.from(document.querySelectorAll(".radar-digest, .radar-inbox")),
      [digest, inbox],
      "digested themes render before the raw-signal queue",
    );
    assert.match(inbox.textContent!, /待消化/);
    assert.equal(inbox.querySelectorAll(".radar-inbox-item").length, 4);
    assert.match(inbox.textContent!, /用户收藏中正在消化的原始信号/);
    assert.match(inbox.textContent!, /服务器刚推送的待判断信号/);
    assert.match(inbox.textContent!, /团队处理中/);
    assert.match(inbox.textContent!, /整理失败/);
    assert.match(inbox.textContent!, /Agents SDK 工具调用协议更新/);
    assert.match(inbox.textContent!, /来源新修订/);
    assert.doesNotMatch(inbox.textContent!, /重复转载且没有新增事实/);
    const digestionError = inbox.querySelector(".radar-digestion-error");
    assert.ok(digestionError);
    assert.equal(digestionError.getAttribute("role"), "status");
    assert.match(digestionError.textContent!, /团队自动消化暂时停住/);
    assert.match(digestionError.textContent!, /团队模型连接暂不可用/);
    assert.match(digestionError.textContent!, /来源仍会继续接收/);
    await click(button("交给团队整理这批", inbox));
    assert.deepEqual(commands.at(-1), {
      type: "radar.digest",
      itemIds: ["digested-user", "raw-server"],
    });
    assert.ok(document.querySelector(".radar-page"), "digest stays on Radar");

    await click(button("待团队消化"));
    const fullInbox = document.querySelector(".radar-inbox.full");
    assert.ok(fullInbox);
    assert.equal(fullInbox.querySelectorAll(".radar-inbox-item").length, 6);
    assert.match(fullInbox.textContent!, /团队已暂停/);
    assert.match(fullInbox.textContent!, /任务结束，未发布/);
    assert.equal(
      fullInbox.querySelectorAll(".radar-digestion-error").length,
      1,
    );

    await click(button("历史理解"));
    const insightHistory = document.querySelector(
      '[aria-labelledby="radar-insight-history-title"]',
    );
    assert.ok(insightHistory);
    assert.match(insightHistory.textContent!, /昨日的 Agent 协作判断/);
    assert.doesNotMatch(insightHistory.textContent!, /Agent 协作基础设施/);
    assert.equal(
      insightHistory.querySelectorAll(".radar-theme-card").length,
      1,
    );

    await click(button("筛选记录"));
    const filteredHistory = document.querySelector(".radar-disposition-list");
    assert.ok(filteredHistory);
    assert.match(filteredHistory.textContent!, /重复转载且没有新增事实/);
    assert.match(filteredHistory.textContent!, /重复/);
    assert.match(
      filteredHistory.textContent!,
      /内容只是已引用官方来源的重复转载，没有新增事实/,
    );
    await click(button("查看证据", filteredHistory));
    assert.match(filteredHistory.textContent!, /判断所用修订正文/);
    assert.match(
      filteredHistory.textContent!,
      /筛选判断所用的锁定正文：这是一条重复转载/,
    );

    await click(button("今日理解"));
    assert.match(document.body.textContent!, /Agent 协作基础设施/);
    assert.doesNotMatch(document.body.textContent!, /昨日的 Agent 协作判断/);

    assert.equal(
      document.querySelector(".radar-source-panel"),
      null,
      "source management does not occupy the daily reading canvas",
    );
    await click(button("来源与关注"));
    const sourcePanel = document.querySelector(".radar-source-panel");
    assert.ok(sourcePanel);
    assert.equal(sourcePanel.getAttribute("aria-label"), "来源与关注");
    assert.match(sourcePanel.textContent!, /用户关注/);
    assert.match(sourcePanel.textContent!, /服务器推荐/);

    const input =
      sourcePanel.querySelector<HTMLInputElement>("#radar-follow-url")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      assert.ok(setter);
      setter.call(input, "https://new.example.com/feed");
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await act(async () => {
      sourcePanel
        .querySelector(".radar-follow-form")!
        .dispatchEvent(
          new window.Event("submit", { bubbles: true, cancelable: true }),
        );
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(commands.at(-1), {
      type: "radar.follow",
      url: "https://new.example.com/feed",
    });

    await click(button("手动刷新", sourcePanel));
    assert.deepEqual(commands.at(-1), { type: "radar.refresh" });

    const userSource = Array.from(
      sourcePanel.querySelectorAll(".radar-source-card"),
    ).find((element) => element.textContent?.includes("用户指定站点"));
    await click(button("暂停", userSource));
    assert.deepEqual(commands.at(-1), {
      type: "radar.setFollowState",
      followId: "follow-user",
      state: "paused",
    });

    await click(button("开始接收", sourcePanel));
    assert.deepEqual(commands.at(-1), {
      type: "radar.follow",
      recommendedSourceId: "recommended-tools",
    });

    await click(document.querySelector('button[aria-label="关闭对话框"]'));
    assert.equal(document.querySelector(".radar-source-panel"), null);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("recommended source reports real observation failure and schedule", async () => {
  const snapshot = snapshotFixture();
  snapshot.radar!.follows.push({
    id: "follow-recommended",
    sourceId: "source-server-item",
    origin: "recommended",
    recommendedSourceId: "recommended-tools",
    name: "产品与工具观察",
    category: "tools",
    url: "https://example.org/tools",
    state: "active",
    refreshIntervalMinutes: 60,
    createdAt: observedAt,
    updatedAt: "2026-09-12T18:12:00.000Z",
    lastAttemptAt: "2026-09-12T18:12:00.000Z",
    lastSuccessAt: "2026-09-12T17:05:00.000Z",
    nextRefreshAt: "2026-09-12T19:12:00.000Z",
    lastError: "本次返回不支持的内容类型",
  });
  snapshot.radar!.recommendedSources[0] = {
    ...snapshot.radar!.recommendedSources[0]!,
    followed: true,
    followId: "follow-recommended",
  };
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id='root'></div></body></html>",
  );
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
  const { Radar } = await import("../src/workbench/Radar.js");
  const root = createRoot(document.getElementById("root")!);
  const button = (label: string, within: ParentNode = document) =>
    Array.from(within.querySelectorAll("button")).find((item) =>
      item.textContent?.includes(label),
    );
  try {
    await act(async () =>
      root.render(
        createElement(Radar, {
          snapshot,
          dispatch: async () => snapshot,
          connected: true,
          onTask: () => undefined,
        }),
      ),
    );
    await act(async () => {
      const trigger = button("来源与关注");
      assert.ok(trigger);
      trigger.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
    const sourcePanel = document.querySelector(".radar-source-panel");
    assert.ok(sourcePanel);
    const sourceCard = Array.from(
      sourcePanel.querySelectorAll(".radar-source-card"),
    ).find((element) => element.textContent?.includes("产品与工具观察"));
    assert.ok(sourceCard);
    assert.match(sourceCard.textContent!, /观察失败/);
    assert.match(sourceCard.textContent!, /最近尝试/);
    assert.match(sourceCard.textContent!, /最近成功/);
    assert.match(sourceCard.textContent!, /计划下次/);
    assert.match(
      sourceCard.textContent!,
      /最近观察失败：本次返回不支持的内容类型/,
    );
    assert.doesNotMatch(sourceCard.textContent!, /服务器监控中|服务器推送中/);
    assert.equal(
      sourceCard.querySelector(".radar-source-error")?.getAttribute("role"),
      "status",
    );
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("Radar empty state never invents recommended content", async () => {
  const snapshot = snapshotFixture();
  const radar = snapshot.radar!;
  radar.items = [];
  radar.digests = [];
  radar.digestions = [];
  radar.dispositions = [];
  radar.follows = [];
  radar.recommendedSources = [];
  radar.unreadCount = 0;
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id='root'></div></body></html>",
  );
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
  const { Radar } = await import("../src/workbench/Radar.js");
  const root = createRoot(document.getElementById("root")!);
  const button = (label: string, within: ParentNode = document) =>
    Array.from(within.querySelectorAll("button")).find((item) =>
      item.textContent?.includes(label),
    );
  try {
    await act(async () =>
      root.render(
        createElement(Radar, {
          snapshot,
          dispatch: async () => snapshot,
          connected: true,
          onTask: () => undefined,
        }),
      ),
    );
    assert.match(document.body.textContent!, /正在等待来源更新/);
    assert.equal(document.querySelectorAll(".radar-reading-card").length, 0);
    assert.equal(document.querySelectorAll(".radar-theme-card").length, 0);
    assert.equal(document.querySelectorAll(".radar-inbox-item").length, 0);
    assert.doesNotMatch(document.body.textContent!, /服务端暂未提供推荐来源/);
    assert.equal(document.querySelectorAll(".radar-source-card").length, 0);
    await act(async () => {
      const trigger = button("来源与关注");
      assert.ok(trigger);
      trigger.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
    assert.match(document.body.textContent!, /服务端暂未提供推荐来源/);
    assert.equal(document.querySelectorAll(".radar-source-card").length, 0);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("the app exposes Radar as a primary navigation destination", async () => {
  const snapshot = snapshotFixture();
  const currentSnapshot = structuredClone(snapshot);
  const invoked: Command[] = [];
  const { window, document } = parseHTML(
    "<!doctype html><html><head></head><body><div id='root'></div></body></html>",
  );
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
    value: () => undefined,
    configurable: true,
  });
  window.ytriple = {
    invoke: async (command) => {
      invoked.push(command);
      return structuredClone(currentSnapshot);
    },
    subscribe: () => () => undefined,
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
    const radarNav = Array.from(
      document.querySelectorAll(".primary-nav button"),
    ).find((element) => element.textContent?.trim().startsWith("雷达"));
    assert.ok(radarNav);
    await act(async () =>
      radarNav.dispatchEvent(new window.Event("click", { bubbles: true })),
    );
    assert.equal(
      document
        .querySelector(".primary-nav button.active")
        ?.textContent?.trim()
        .startsWith("雷达"),
      true,
    );
    assert.equal(document.querySelector(".radar-page h1")?.textContent, "雷达");
    assert.match(
      document.querySelector(".topbar-location")?.textContent ?? "",
      /每日情报与信息源/,
    );

    const topicsTab = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("团队处理记录"),
    );
    assert.ok(topicsTab);
    await act(async () => {
      topicsTab.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
    const handoff = Array.from(
      document.querySelectorAll(".radar-inbox button"),
    ).find((element) => element.textContent?.includes("交给团队整理这批"));
    assert.ok(handoff);
    await act(async () => {
      handoff.dispatchEvent(new window.Event("click", { bubbles: true }));
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
    assert.deepEqual(
      invoked.find((command) => command.type === "radar.digest"),
      {
        type: "radar.digest",
        itemIds: ["digested-user", "raw-server"],
      },
    );
    assert.equal(
      document
        .querySelector(".primary-nav button.active")
        ?.textContent?.trim()
        .startsWith("雷达"),
      true,
    );
    assert.ok(document.querySelector(".radar-page"));
    assert.match(
      document.querySelector(".topbar-location")?.textContent ?? "",
      /每日情报与信息源/,
    );
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
