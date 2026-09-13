import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { Store, now, uid } from "../src/core/store.js";
import { handleMediaCommand, mediaSnapshot } from "../src/core/media.js";
import { writeArtifact } from "../src/core/files.js";
import type { FeatureHost } from "../src/core/feature-host.js";
import type { Command, Snapshot, Task } from "../src/shared/types.js";
import type { MediaCommand } from "../src/shared/media.js";

test("media UI creates a channel and work, runs selected stage, records publication and imports actual comments", async () => {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "ytriple-media-ui-"),
  );
  const dir = await fs.realpath(temporary);
  const store = new Store(path.join(dir, "data"));
  store.setConfig("settings", {
    ...store.settings(),
    aiRoot: path.join(dir, "AI"),
    codeRoot: path.join(dir, "Code"),
    workspaceRoot: path.join(dir, "work"),
  });
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id='root'></div></body></html>",
  );
  Object.defineProperty(document, "oninput", {
    configurable: true,
    value: null,
  });
  Object.defineProperty(document, "compatMode", {
    configurable: true,
    value: "CSS1Compat",
  });
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
      configurable: true,
      writable: true,
      value,
    });
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { MediaProjects } = await import("../src/workbench/MediaProjects.js");
  const root = createRoot(document.getElementById("root")!);
  const commands: Command[] = [],
    opened: string[] = [];
  let failNext = false;
  let active = true;
  let startGate: Promise<void> | null = null;
  let releaseStart: (() => void) | undefined;
  let operation: Promise<void> = Promise.resolve();
  const snapshot = (): Snapshot => ({
    version: "test",
    dataPath: store.dataPath,
    tasks: store.tasks(),
    profiles: [],
    projects: [],
    settings: store.settings(),
    system: {
      state: "ready",
      aiRoot: path.join(dir, "AI"),
      codeRoot: path.join(dir, "Code"),
      policyPath: path.join(dir, "AI", "AGENTS.md"),
      issues: [],
    },
    media: mediaSnapshot(store),
  });
  const host: FeatureHost = {
    store,
    createWork: async (input) => {
      const task: Task = {
        id: uid(),
        title: input.title,
        goal: input.goal,
        teamMode: input.teamMode,
        skillPolicy: input.skillPolicy,
        kind: "research",
        member: "coordinator",
        workspace: path.join(dir, "work", uid()),
        goalVersion: 1,
        createdAt: now(),
        updatedAt: now(),
        status: "idle",
        messages: [],
        sources: input.sources ?? [],
        events: [],
        artifacts: [],
      };
      store.saveTask(task);
      return task;
    },
    runWork: async () => undefined,
    stopWork: async () => undefined,
    addSource: async () => undefined,
    isRunning: () => false,
  };
  const dispatch = async (command: Command) => {
    commands.push(command);
    if (failNext) {
      failNext = false;
      return null;
    }
    if (command.type.startsWith("media.")) {
      operation = (async () => {
        if (command.type === "media.work.start" && startGate) await startGate;
        await handleMediaCommand(host, command as MediaCommand);
      })();
      await operation;
    }
    const result = snapshot();
    root.render(
      createElement(MediaProjects, {
        snapshot: result,
        dispatch,
        onTask: (id) => opened.push(id),
        active,
      }),
    );
    return result;
  };
  const button = (label: string) =>
    Array.from(document.querySelectorAll("button")).find(
      (element) =>
        element.textContent?.trim() === label ||
        element.getAttribute("aria-label") === label,
    );
  const click = async (label: string) => {
    const element = button(label);
    assert.ok(element, `button ${label}`);
    await act(async () => {
      element.dispatchEvent(new window.Event("click", { bubbles: true }));
      await operation;
    });
  };
  const input = async (label: string, value: string) => {
    const element = document.querySelector(`[aria-label="${label}"]`) as
      HTMLInputElement | HTMLTextAreaElement;
    assert.ok(element, `input ${label}`);
    if (element.tagName === "INPUT" && !element.getAttribute("type"))
      element.setAttribute("type", "text");
    const prototype =
      element.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    assert.ok(setter);
    await act(async () => {
      setter.call(element, value);
      element.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  };
  const submit = async (label: string) => {
    const form = document.querySelector(`form[aria-label="${label}"]`);
    assert.ok(form);
    await act(async () => {
      form.dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      );
      await operation;
    });
  };
  try {
    await act(async () =>
      root.render(
        createElement(MediaProjects, {
          snapshot: snapshot(),
          dispatch,
          onTask: (id) => opened.push(id),
          active,
        }),
      ),
    );
    await click("新建频道");
    await input("频道名称", "作品测试频道");
    await input("频道目标", "把复杂问题解释清楚");
    await input("频道受众", "独立创作者");
    await click("添加代表材料");
    await input("材料 1 名称", "真实代表材料");
    await input("材料 1 正文", "代表作品原文与实际表达限制");
    failNext = true;
    await submit("新建频道");
    const attempted = commands.at(-1);
    assert.ok(attempted?.type === "media.channel.save");
    assert.equal(attempted.input.name, "作品测试频道");
    assert.match(
      document.querySelector('[role="alert"]')!.textContent!,
      /草稿已保留/,
    );
    await click("稍后继续");
    await click("新建频道");
    assert.equal(
      (document.querySelector('[aria-label="频道名称"]') as HTMLInputElement)
        .value,
      "作品测试频道",
      "closing a form preserves its draft",
    );
    await submit("新建频道");
    assert.equal(
      mediaSnapshot(store).channels.length,
      1,
      document.querySelector('[role="alert"]')?.textContent ??
        "channel was saved",
    );
    assert.match(
      document.querySelector(".media-object-header")!.textContent!,
      /作品测试频道/,
    );
    assert.equal(document.querySelector(".media-start"), null);
    await click("全部频道");
    assert.equal(
      document.querySelector(".media-object-header"),
      null,
      "channel list does not select the first channel",
    );
    assert.equal(document.querySelector(".media-start"), null);
    await act(async () => {
      document
        .querySelector('[aria-label="打开频道 作品测试频道"]')!
        .dispatchEvent(new window.Event("click", { bubbles: true }));
    });
    const firstCreate = commands.filter(
      (command) => command.type === "media.channel.save",
    );
    assert.equal(firstCreate.length, 2);
    assert.equal(
      (firstCreate[0] as MediaCommand).requestId,
      (firstCreate[1] as MediaCommand).requestId,
      "a retry uses the same idempotency key",
    );
    await click("新建作品");
    await input("作品名称", "解释性短片");
    await input("作品角度", "一个概念、两个例子");
    await input("作品目标日期", "2026-10-02");
    await click("添加平台或语言版本");
    await input("版本 2 平台", "TikTok");
    await input("版本 2 语言", "English");
    await submit("新建作品");
    const work = mediaSnapshot(store).works[0]!;
    assert.equal(work.variants.length, 2);
    assert.equal(work.variants[1]!.basedOnId, work.variants[0]!.id);
    assert.equal(
      document.querySelector(".media-start"),
      null,
      "work overview does not mount the stage form",
    );
    await click("与团队推进");
    await click("研究与脚本");
    await input("媒体工作要求", "做一份可交接的原创脚本");
    await click("开始媒体工作");
    assert.equal(opened.length, 1);
    assert.equal(
      document.querySelector('[role="dialog"]'),
      null,
      "a created stage immediately leaves the input panel for the shared workspace callback",
    );
    const started = commands.find(
      (command) => command.type === "media.work.start",
    );
    assert.ok(started?.type === "media.work.start");
    assert.equal(started.stage, "script");
    assert.equal(started.materialIds.length, 1);
    assert.match(
      store
        .task(opened[0]!)
        .sources.map((source) => source.text)
        .join("\n"),
      /代表作品原文/,
    );
    const firstScript = await writeArtifact(store, opened[0]!, {
      title: "可拍摄脚本",
      content: "# 初稿",
      format: "md",
      goalVersion: 1,
    });
    const script = await writeArtifact(store, opened[0]!, {
      artifactId: firstScript.id,
      expectedHash: firstScript.hash,
      title: firstScript.title,
      content: "# 已编辑脚本\n真实保存的镜头安排。",
      format: "md",
      goalVersion: 1,
    });
    await act(async () =>
      root.render(
        createElement(MediaProjects, {
          snapshot: snapshot(),
          dispatch,
          onTask: (id) => opened.push(id),
          active,
        }),
      ),
    );
    assert.equal(document.querySelector(".media-start"), null);
    assert.match(
      document.querySelector(".project-result-list")!.textContent!,
      /可拍摄脚本/,
    );
    await click("与团队推进");
    const choice = document.querySelector(
      `[aria-label="承接成果 ${script.title} v2"]`,
    ) as HTMLInputElement;
    assert.ok(choice);
    assert.equal(
      choice.checked,
      true,
      "latest saved artifact is selected by default",
    );
    await click("制作说明");
    await click("发布准备");
    await click("制作说明");
    await click("开始媒体工作");
    assert.equal(opened.length, 2);
    const production = commands.findLast(
      (command) => command.type === "media.work.start",
    );
    assert.ok(production?.type === "media.work.start");
    assert.deepEqual(production.artifacts, [
      {
        taskId: opened[0],
        artifactId: script.id,
        version: 2,
        hash: script.hash,
      },
    ]);
    assert.match(
      store
        .task(opened[1]!)
        .sources.map((source) => source.text)
        .join("\n"),
      /真实保存的镜头安排/,
    );
    await click("登记发布");
    await input("实际发布链接", "https://example.com/released-video");
    await input("实际发布时间", "2026-10-01T11:30");
    await submit("登记发布");
    assert.equal(mediaSnapshot(store).works[0]!.publications.length, 1);
    assert.equal(mediaSnapshot(store).works[0]!.targetDate, "2026-10-02");
    await click("导入反馈");
    await input("复盘资料名称", "观众实际评论");
    await input("复盘资料正文", "真实评论：第二个例子很有用，希望补充反例。");
    await submit("导入复盘资料");
    assert.equal(
      mediaSnapshot(store).works[0]!.feedback[0]!.range,
      "provided-text",
    );
    assert.match(
      document.querySelector(".media-feedback-record")!.textContent!,
      /真实评论：第二个例子/,
    );
    await click("与团队推进");
    await click("作品复盘");
    await click("开始媒体工作");
    assert.equal(opened.length, 3);
    assert.match(
      store
        .task(opened[2]!)
        .sources.map((source) => source.text)
        .join("\n"),
      /真实评论：第二个例子/,
    );
    assert.match(
      document.querySelector(".media-publication")!.textContent!,
      /用户登记发布时间/,
    );
    const repaint = async () =>
      act(async () =>
        root.render(
          createElement(MediaProjects, {
            snapshot: snapshot(),
            dispatch,
            onTask: (id) => opened.push(id),
            active,
          }),
        ),
      );
    for (const id of opened)
      store.saveTask({ ...store.task(id), status: "completed" });
    store.saveTask({ ...store.task(opened[0]!), status: "running" });
    await repaint();
    const beforeBrowse = commands.filter(
      (command) => command.type === "media.work.start",
    ).length;
    await click("作品测试频道");
    const resumedWork = document.querySelector(
      '[aria-label="打开作品 解释性短片"]',
    )!;
    assert.match(
      resumedWork.querySelector(".media-work-current-status")!.textContent!,
      /研究与脚本.*进行中/,
      "resuming the earlier script must replace the later-created completed review as the current status",
    );
    await click("打开作品 解释性短片");
    assert.match(
      document.querySelector(".project-work-list button")!.textContent!,
      /研究与脚本/,
      "work history follows actual update time",
    );
    await click("作品测试频道");
    assert.equal(
      commands.filter((command) => command.type === "media.work.start").length,
      beforeBrowse,
      "browsing channel and work does not create team work",
    );
    await click("与团队讨论频道");
    assert.match(
      document.querySelector('[role="dialog"] h2')!.textContent!,
      /准备媒体工作/,
    );
    assert.equal(
      document.querySelector('[role="dialog"] .composer'),
      null,
      "the input panel does not replace the full discussion workspace",
    );
    await click("开始媒体工作");
    assert.equal(opened.length, 4);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    store.saveTask({ ...store.task(opened[3]!), status: "running" });
    store.saveTask({
      ...store.task(opened[2]!),
      status: "running",
      archivedAt: now(),
    });
    await repaint();
    await click("全部频道");
    assert.match(
      document.querySelector(".media-channel-work-state")!.textContent!,
      /2 项工作推进中/,
      "channel status includes its own strategy task and the work task, excluding archived work",
    );
    store.saveTask({ ...store.task(opened[0]!), status: "waiting" });
    await repaint();
    assert.match(
      document.querySelector(".media-channel-work-state")!.textContent!,
      /1 项工作推进中.*1 项等待判断/,
    );
    await click("打开频道 作品测试频道");
    await click("打开作品 解释性短片");
    await click("与团队推进");
    await input("媒体工作要求", "稍后继续的制作准备");
    active = false;
    await repaint();
    assert.equal(
      document.querySelector('[role="dialog"]'),
      null,
      "leaving the media page closes its portal",
    );
    active = true;
    await repaint();
    assert.equal(
      document.querySelector('[role="dialog"]'),
      null,
      "returning to media does not reopen an old overlay",
    );
    await click("与团队推进");
    const restoredInstruction = document.querySelector(
      '[aria-label="媒体工作要求"]',
    ) as HTMLTextAreaElement;
    assert.equal(
      restoredInstruction.value || restoredInstruction.defaultValue,
      "稍后继续的制作准备",
    );
    startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    await act(async () =>
      button("开始媒体工作")!.dispatchEvent(
        new window.Event("click", { bubbles: true }),
      ),
    );
    active = false;
    await repaint();
    await act(async () => {
      releaseStart!();
      await operation;
    });
    assert.equal(
      opened.length,
      4,
      "a stage created after its preparation panel was dismissed cannot take over the user's new page",
    );
    const lateStart = commands.findLast(
      (command) => command.type === "media.work.start",
    );
    assert.ok(lateStart?.type === "media.work.start");
    assert.equal(
      lateStart.instruction,
      "稍后继续的制作准备",
      "the preserved preparation draft is the actual goal passed to the new work",
    );
    assert.equal(
      mediaSnapshot(store).works[0]!.taskLinks.length,
      4,
      "the explicitly submitted work still exists after its late creation",
    );
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
