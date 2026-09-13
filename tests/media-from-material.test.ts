import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { parseHTML } from "linkedom";
import { Store, uid } from "../src/core/store.js";
import { hash } from "../src/core/files.js";
import { handleMediaCommand, mediaSnapshot } from "../src/core/media.js";
import type { FeatureHost } from "../src/core/feature-host.js";
import type { Command, LibraryEntry, Snapshot } from "../src/shared/types.js";
import type { MediaCommand } from "../src/shared/media.js";
import { editorialRevision } from "./fixtures/editorial.js";

async function fixture(
  run: (context: {
    store: Store;
    host: FeatureHost;
    snapshot: () => Snapshot;
    document: Document;
    window: Window & typeof globalThis;
    root: import("react-dom/client").Root;
    h: typeof import("react").createElement;
    act: typeof import("react").act;
  }) => Promise<void>,
) {
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "ytriple-material-media-")),
  );
  const store = new Store(path.join(dir, "data"));
  store.setConfig("settings", {
    ...store.settings(),
    aiRoot: path.join(dir, "AI"),
    codeRoot: path.join(dir, "Code"),
    workspaceRoot: path.join(dir, "work"),
  });
  const dom = parseHTML(
    "<!doctype html><html><body><div id='root'></div></body></html>",
  );
  const replacements = {
    window: dom.window,
    document: dom.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
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
  const { act, createElement: h } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.document.getElementById("root")!);
  const host: FeatureHost = {
    store,
    createWork: async () => {
      throw new Error("Saving a topic must not start model work");
    },
    addSource: async () => undefined,
    runWork: async () => {
      throw new Error("Saving a topic must not run a model");
    },
    stopWork: async () => undefined,
    isRunning: () => false,
  };
  const snapshot = (): Snapshot => ({
    version: "test",
    dataPath: store.dataPath,
    tasks: [],
    profiles: [],
    projects: [],
    settings: store.settings(),
    system: {
      state: "ready",
      aiRoot: store.settings().aiRoot,
      codeRoot: store.settings().codeRoot,
      policyPath: "",
      issues: [],
    },
    media: mediaSnapshot(store),
  });
  try {
    await run({
      store,
      host,
      snapshot,
      document: dom.document as unknown as Document,
      window: dom.window as unknown as Window & typeof globalThis,
      root,
      h,
      act,
    });
  } finally {
    await act(async () => root.unmount());
    for (const [key, original] of originals) {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    }
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}
const button = (document: Document, label: string) => {
  const result = [...document.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  assert.ok(result, label);
  return result;
};
const waitFor = async (condition: () => boolean) => {
  for (let i = 0; i < 100 && !condition(); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), "asynchronous UI action completed");
};
const channel = async (host: FeatureHost) => {
  const id = uid();
  await handleMediaCommand(host, {
    type: "media.channel.save",
    requestId: id,
    expectedRevision: 0,
    input: {
      name: "已有开发频道",
      goal: "解释真实使用条件",
      audience: "独立开发者",
      productionConditions: "",
      expressionStandards: "",
      materials: [],
      accounts: [],
    },
  });
  return id;
};

test("Radar handoff pins the currently read revision through updates, retries the same write, and opens the actual media work", async () => {
  await fixture(
    async ({ store, host, snapshot, document, window, root, h, act }) => {
      const { Radar } = await import("../src/workbench/Radar.js");
      const channelId = await channel(host);
      const first = editorialRevision();
      const latest = editorialRevision({
        id: uid(),
        version: 2,
        takeaway: "新版本内容不可混入旧解读。",
        evidence: [{ ...first.evidence[0]!, excerpt: "新版本依据不可混入。" }],
      });
      let newest = first;
      const state = (): Snapshot =>
        ({
          ...snapshot(),
          radar: {
            editorialIdentity: `material-${store.dataPath}`,
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
                  updatedAt: newest.createdAt,
                  latest: newest,
                  history: newest === first ? [first] : [latest, first],
                  corrections: [],
                },
              ],
            },
            editorialVersions: { [first.id]: first, [latest.id]: latest },
          },
        }) as Snapshot;
      const commands: MediaCommand[] = [],
        opened: string[][] = [];
      let ambiguous = true;
      const dispatch = async (command: Command) => {
        if (command.type.startsWith("media.")) {
          commands.push(command as MediaCommand);
          await handleMediaCommand(host, command as MediaCommand);
          if (ambiguous) {
            ambiguous = false;
            return null;
          }
        }
        return state();
      };
      const render = () =>
        root.render(
          h(Radar, {
            snapshot: state(),
            dispatch,
            connected: true,
            onTask: () => assert.fail("No generic research task"),
            onMediaCreated: (channelId, workId) =>
              opened.push([channelId, workId]),
          }),
        );
      await act(render);
      await act(async () =>
        button(document, "阅读解读").dispatchEvent(
          new window.Event("click", { bubbles: true }),
        ),
      );
      newest = latest;
      await act(render);
      assert.match(
        document.querySelector(".editorial-detail")!.textContent!,
        /第 1 版/,
      );
      await act(async () =>
        button(document, "创建媒体选题").dispatchEvent(
          new window.Event("click", { bubbles: true }),
        ),
      );
      const submit = () =>
        document
          .querySelector('[role="dialog"] form')!
          .dispatchEvent(
            new window.Event("submit", { bubbles: true, cancelable: true }),
          );
      await act(async () => {
        submit();
        submit();
        await waitFor(
          () =>
            commands.length === 1 && mediaSnapshot(store).works.length === 1,
        );
      });
      await act(async () => {
        await waitFor(() => !!document.querySelector('[role="alert"]'));
      });
      assert.equal(opened.length, 0);
      assert.match(document.body.textContent!, /重试会接续同一次创建/);
      await act(async () => {
        submit();
        await waitFor(() => opened.length === 1);
      });
      assert.equal(commands.length, 2);
      assert.deepEqual(commands[0], commands[1]);
      const work = mediaSnapshot(store).works[0]!;
      assert.equal(mediaSnapshot(store).works.length, 1);
      assert.deepEqual(opened, [[channelId, work.id]]);
      const text = work.materials.map((part) => part.text).join("\n");
      assert.match(text, /解读版本：v1/);
      assert.ok(text.includes(first.id));
      assert.ok(text.includes(first.takeaway));
      assert.ok(text.includes(first.evidence[0]!.excerpt));
      assert.ok(text.includes(hash(first.evidence[0]!.excerpt)));
      assert.ok(text.includes(first.evidence[0]!.contentHash));
      assert.match(text, /未取得全文/);
      assert.doesNotMatch(text, /新版本内容不可|新版本依据不可/);
      assert.ok(
        (await fs.readFile(work.documentPath, "utf8")).includes(
          first.evidence[0]!.excerpt,
        ),
      );
      assert.equal(store.tasks().length, 0);
    },
  );
});

test("Lib entry moves exact saved bytes and provenance into a selected channel; mismatched hashes cannot be saved", async () => {
  await fixture(async ({ host, snapshot, document, window, root, h, act }) => {
    const { Library } = await import("../src/workbench/Library.js");
    const { MediaFromMaterial, libraryMediaMaterial } =
      await import("../src/workbench/MediaFromMaterial.js");
    await channel(host);
    const body = "# 已保存的版本\n\n这里保留具体前提。\n";
    const entry: LibraryEntry = {
      id: uid(),
      title: "可复用说明",
      content: body,
      path: "/unused/lib.md",
      format: "md",
      hash: hash(body),
      version: 3,
      savedAt: "2026-09-13T00:00:00Z",
      updatedAt: "2026-09-13T00:00:00Z",
      tags: [],
      note: "",
      versions: [],
      source: {
        taskId: uid(),
        taskTitle: "来源工作",
        artifactId: uid(),
        artifactVersion: 2,
        artifactHash: "a".repeat(64),
        goalVersion: 1,
      },
    };
    const commands: Command[] = [],
      opened: string[] = [];
    const dispatch = async (command: Command) => {
      commands.push(command);
      await handleMediaCommand(host, command as MediaCommand);
      return snapshot();
    };
    await act(async () =>
      root.render(
        h(Library, {
          snapshot: { ...snapshot(), library: [entry] },
          dispatch,
          initialEntryId: entry.id,
          selectedTaskId: null,
          onTask: () => undefined,
          onAdd: () => undefined,
          onMediaCreated: (_channelId, workId) => opened.push(workId),
        }),
      ),
    );
    await act(async () =>
      button(document, "创建媒体选题").dispatchEvent(
        new window.Event("click", { bubbles: true }),
      ),
    );
    await act(async () => {
      document
        .querySelector('[role="dialog"] form')!
        .dispatchEvent(
          new window.Event("submit", { bubbles: true, cancelable: true }),
        );
      await waitFor(() => opened.length === 1);
    });
    const saved = snapshot().media!.works[0]!.materials[0]!;
    assert.ok(saved.text.includes(body));
    assert.ok(saved.text.includes(entry.hash));
    assert.ok(saved.text.includes(entry.source.artifactId));
    assert.match(saved.text, /Lib .* v3/);
    assert.equal(saved.usageRights, "unknown");
    const mismatched = libraryMediaMaterial({
      ...entry,
      id: uid(),
      content: "外部修改",
    })!;
    await act(async () =>
      root.render(
        h(MediaFromMaterial, {
          snapshot: snapshot(),
          dispatch,
          material: mismatched,
        }),
      ),
    );
    await act(async () =>
      button(document, "创建媒体选题").dispatchEvent(
        new window.Event("click", { bubbles: true }),
      ),
    );
    await act(async () => {
      document
        .querySelector('[role="dialog"] form')!
        .dispatchEvent(
          new window.Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    for (let i = 0; i < 100 && !document.querySelector('[role="alert"]'); i++)
      await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
    assert.match(document.body.textContent!, /正文与登记版本不一致/);
    assert.equal(commands.length, 1);
    assert.equal(
      libraryMediaMaterial({ ...entry, format: "png", content: undefined }),
      null,
    );
  });
});

test("without a channel, material handoff only guides channel setup and never silently creates a project", async () => {
  await fixture(async ({ snapshot, document, window, root, h, act }) => {
    const { MediaFromMaterial, radarMediaMaterial } =
      await import("../src/workbench/MediaFromMaterial.js");
    let setups = 0;
    await act(async () =>
      root.render(
        h(MediaFromMaterial, {
          snapshot: snapshot(),
          dispatch: async () => assert.fail("No writes without a channel"),
          material: radarMediaMaterial(editorialRevision(), uid()),
          onMediaSetup: () => setups++,
        }),
      ),
    );
    await act(async () =>
      button(document, "创建媒体选题").dispatchEvent(
        new window.Event("click", { bubbles: true }),
      ),
    );
    assert.match(document.body.textContent!, /先建立一个媒体频道/);
    assert.equal(document.querySelector('[role="dialog"] form'), null);
    await act(async () =>
      button(document, "去创建频道").dispatchEvent(
        new window.Event("click", { bubbles: true }),
      ),
    );
    assert.equal(setups, 1);
    assert.equal(snapshot().media!.channels.length, 0);
  });
});
