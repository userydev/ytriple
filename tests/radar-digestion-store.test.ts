import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/core/store.js";
import type {
  RadarDigestPublicationInput,
  RemoteSourceIdentity,
  Source,
  Task,
} from "../src/shared/types.js";

const identity: RemoteSourceIdentity = {
  serverInstanceId: "97a24852-9fc4-4fd9-ab8d-d391196c1b67",
  tenantId: "radar-digestion-test",
};

async function fixture(t: { after(fn: () => unknown): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ytriple-digestion-"));
  const store = new Store(path.join(root, "data"));
  t.after(async () => {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, store };
}

function remoteSource(
  itemId: string,
  revisionId: string,
  text: string,
): Source {
  return {
    id: `source-${itemId}-${revisionId}`,
    title: `资料 ${itemId}`,
    type: "url",
    location: `https://example.com/${itemId}`,
    text,
    addedAt: "2026-09-12T05:00:00.000Z",
    coverage: "网页正文（fulltext）",
    remote: {
      ...identity,
      sourceId: `remote-source-${itemId}`,
      itemId,
      revisionId,
      contentHash: createHash("sha256").update(text).digest("hex"),
      observedAt: "2026-09-12T04:59:00.000Z",
      coverageLevel: "fulltext",
      missing: [],
    },
  };
}

function task(id: string, workspace: string, sources: Source[] = []): Task {
  const createdAt = "2026-09-12T05:01:00.000Z";
  return {
    id,
    title: "Radar 团队消化",
    goal: "按主题消化资料，并与已有 Lib 对照。",
    goalVersion: 1,
    kind: "research",
    member: "coordinator",
    workspace,
    status: "idle",
    createdAt,
    updatedAt: createdAt,
    messages: [],
    events: [],
    sources,
    artifacts: [],
  };
}

function markRead(store: Store, taskId: string, sourceIds: string[]) {
  store.updateTask(taskId, (current) => {
    for (const sourceId of sourceIds) {
      const source = current.sources.find((entry) => entry.id === sourceId);
      assert.ok(source, `missing test source ${sourceId}`);
      current.events.push({
        id: `read-${sourceId}`,
        type: "tool_completed",
        summary: `已读取 ${sourceId}`,
        createdAt: "2026-09-12T05:02:00.000Z",
        goalVersion: current.goalVersion,
        data: {
          tool: "read_source",
          sourceId,
          readStart: 0,
          readEnd: source.text.length,
          totalCharacters: source.text.length,
        },
      });
    }
  });
}

function markReadRange(
  store: Store,
  taskId: string,
  sourceId: string,
  readStart: number,
  readEnd: number,
  totalCharacters?: number,
) {
  store.updateTask(taskId, (current) => {
    const source = current.sources.find((entry) => entry.id === sourceId);
    assert.ok(source, `missing test source ${sourceId}`);
    current.events.push({
      id: `read-${sourceId}-${readStart}-${readEnd}`,
      type: "tool_completed",
      summary: `已读取 ${sourceId} 的 ${readStart}-${readEnd}`,
      createdAt: "2026-09-12T05:02:00.000Z",
      goalVersion: current.goalVersion,
      data: {
        tool: "read_source",
        sourceId,
        readStart,
        readEnd,
        totalCharacters: totalCharacters ?? source.text.length,
      },
    });
  });
}

test("Radar digestion atomically locks revisions and keeps background work out of item task references", async (t) => {
  const { root, store } = await fixture(t);
  const first = remoteSource("item-a", "revision-a1", "第一条完整正文");
  const second = remoteSource("item-b", "revision-b1", "第二条完整正文");
  store.commitRemoteSourcePage({
    ...identity,
    nextCursor: "cursor-1.signature",
    sources: [first, second],
  });
  const items = store.radarItems(identity);
  const itemA = items.find((item) => item.remoteItemId === "item-a")!;
  const itemB = items.find((item) => item.remoteItemId === "item-b")!;
  const selected = store.radarSources([itemA.id, itemB.id]);
  const context: Source = {
    id: "lib-context-source",
    title: "已有 Lib 判断",
    type: "file",
    location: path.join(root, "AI", "knowledge.md"),
    text: "已有判断正文",
    addedAt: "2026-09-12T05:00:30.000Z",
    coverage: "Lib 正文快照",
  };
  const created = task("digest-task", path.join(root, "work"), [context]);
  const run = store.createTaskFromRadar(created, selected, {
    identity,
    itemIds: [itemA.id, itemB.id],
    contextSources: [
      {
        sourceId: context.id,
        kind: "library",
        referenceId: "lib-entry-1",
        version: 3,
        hash: "lib-hash-3",
      },
    ],
  });

  assert.ok(run);
  assert.equal(run.state, "pending");
  assert.deepEqual(
    run.items.map((item) => [item.radarItemId, item.revisionId]),
    [
      [itemA.id, "revision-a1"],
      [itemB.id, "revision-b1"],
    ],
  );
  const storedTask = store.task(created.id);
  assert.equal(storedTask.surface, "background");
  assert.equal(storedTask.sources.length, 3);
  assert.deepEqual(
    storedTask.events.find((event) => event.type === "radar.digest_requested")
      ?.data,
    {
      runId: run.id,
      sourceIds: run.items.map((item) => item.sourceId),
    },
  );
  assert.equal(store.pendingRadarItems(identity).length, 0);
  for (const item of store.radarItems(identity)) {
    assert.deepEqual(item.taskIds, []);
    assert.deepEqual(item.sourceAssetIds, []);
  }
  assert.deepEqual(store.radarDigestions(identity), [run]);
});

test("Radar digest publication is validated, atomic, persistent and idempotent", async (t) => {
  const { root, store } = await fixture(t);
  const first = remoteSource("item-a", "revision-a1", "第一条完整正文");
  const second = remoteSource("item-b", "revision-b1", "第二条完整正文");
  store.commitRemoteSourcePage({
    ...identity,
    nextCursor: "cursor-1.signature",
    sources: [first, second],
  });
  const items = store.radarItems(identity);
  const itemA = items.find((item) => item.remoteItemId === "item-a")!;
  const itemB = items.find((item) => item.remoteItemId === "item-b")!;
  const context: Source = {
    id: "lib-context-source",
    title: "已有 Lib 判断",
    type: "text",
    location: "lib:entry-1",
    text: "已有判断正文",
    addedAt: "2026-09-12T05:00:30.000Z",
    coverage: "Lib 正文快照",
  };
  const run = store.createTaskFromRadar(
    task("digest-task", path.join(root, "work"), [context]),
    store.radarSources([itemA.id, itemB.id]),
    {
      identity,
      itemIds: [itemA.id, itemB.id],
      contextSources: [
        {
          sourceId: context.id,
          kind: "library",
          referenceId: "lib-entry-1",
          version: 1,
        },
      ],
    },
  )!;
  const sourceA = run.items.find((item) => item.remoteItemId === "item-a")!;
  const sourceB = run.items.find((item) => item.remoteItemId === "item-b")!;
  markRead(store, run.taskId, [sourceA.sourceId, sourceB.sourceId, context.id]);
  assert.equal(
    store.radarItems(identity).every((item) => item.readAt === undefined),
    true,
    "starting a digestion must not mark its inputs as read",
  );
  const input: RadarDigestPublicationInput = {
    runId: run.id,
    themes: [
      {
        title: "主题化的新变化",
        summary: "第一条资料形成了一项可复用的新判断。",
        whyItMatters: "它补充了当前目标所缺少的证据。",
        topics: ["能力线索", "能力线索"],
        evidence: [
          {
            sourceId: sourceA.sourceId,
            revisionId: sourceA.revisionId,
            note: "完整正文中的直接依据",
          },
        ],
        context: [
          {
            sourceId: context.id,
            relation: "extends",
            note: "在已有 Lib 判断上增加了新证据。",
          },
        ],
        disagreements: ["仍缺少另一来源交叉验证"],
        gaps: ["长期效果未知"],
      },
    ],
    dispositions: [
      {
        sourceId: sourceB.sourceId,
        kind: "duplicate",
        reason: "与第一条资料描述同一变化，没有独立新增证据。",
      },
    ],
  };
  const result = store.publishRadarDigest(
    run.taskId,
    run.goalVersion,
    "publish-operation-1",
    input,
  );

  assert.equal(result.digests.length, 1);
  assert.deepEqual(result.digests[0]!.topics, ["能力线索"]);
  assert.equal(result.dispositions[0]!.kind, "duplicate");
  assert.equal(store.radarDigestions(identity)[0]!.state, "published");
  assert.deepEqual(store.radarDigests(identity), result.digests);
  assert.deepEqual(store.radarDispositions(identity), result.dispositions);
  assert.equal(
    store.radarItems(identity).every((item) => Boolean(item.readAt)),
    true,
    "a successful structured publication marks the locked current revisions read",
  );
  assert.deepEqual(
    store.publishRadarDigest(
      run.taskId,
      run.goalVersion,
      "publish-operation-1",
      input,
    ),
    result,
  );
  assert.throws(
    () =>
      store.publishRadarDigest(
        run.taskId,
        run.goalVersion,
        "publish-operation-1",
        { ...input, dispositions: [] },
      ),
    /操作 ID 已用于不同内容/,
  );
});

test("Radar digest rejects unread, stale, uncovered and unmapped claims without partial writes", async (t) => {
  const { root, store } = await fixture(t);
  const source = remoteSource("item-a", "revision-a1", "可核查的完整正文");
  store.commitRemoteSourcePage({
    ...identity,
    nextCursor: "cursor-1.signature",
    sources: [source],
  });
  const item = store.radarItems(identity)[0]!;
  const run = store.createTaskFromRadar(
    task("digest-task", path.join(root, "work")),
    store.radarSources([item.id]),
    { identity, itemIds: [item.id] },
  )!;
  const locked = run.items[0]!;
  const validTheme = {
    title: "真实主题",
    summary: "由正文支持的主题判断。",
    whyItMatters: "与当前目标直接相关。",
    evidence: [{ sourceId: locked.sourceId, revisionId: locked.revisionId }],
  };

  assert.throws(
    () =>
      store.publishRadarDigest(run.taskId, 1, "unread", {
        runId: run.id,
        themes: [validTheme],
        dispositions: [],
      }),
    /尚未读到非空正文/,
  );
  assert.equal(store.radarDigests(identity).length, 0);
  assert.equal(store.radarDigestions(identity)[0]!.state, "pending");
  markRead(store, run.taskId, [locked.sourceId]);
  assert.throws(
    () =>
      store.publishRadarDigest(run.taskId, 1, "stale", {
        runId: run.id,
        themes: [
          {
            ...validTheme,
            evidence: [
              { sourceId: locked.sourceId, revisionId: "other-revision" },
            ],
          },
        ],
        dispositions: [],
      }),
    /修订与锁定值不一致/,
  );
  assert.throws(
    () =>
      store.publishRadarDigest(run.taskId, 1, "unmapped", {
        runId: run.id,
        themes: [
          {
            ...validTheme,
            context: [
              {
                sourceId: "unknown-context",
                relation: "supports",
                note: "不存在的对照资料",
              },
            ],
          },
        ],
        dispositions: [],
      }),
    /未映射的对照资料/,
  );
  assert.throws(
    () =>
      store.publishRadarDigest(run.taskId, 1, "uncovered", {
        runId: run.id,
        themes: [],
        dispositions: [],
      }),
    /必须进入主题或给出筛选理由/,
  );
  assert.equal(store.radarDigests(identity).length, 0);
  assert.equal(store.radarDispositions(identity).length, 0);
  assert.equal(
    store.radarItems(identity)[0]?.readAt,
    undefined,
    "failed publication validation keeps the item unread",
  );
});

test("publishing an older locked revision does not mark a newer revision read", async (t) => {
  const { root, store } = await fixture(t);
  const first = remoteSource("item-a", "revision-a1", "第一版完整正文");
  store.commitRemoteSourcePage({
    ...identity,
    nextCursor: "cursor-old-revision.signature",
    sources: [first],
  });
  const item = store.radarItems(identity)[0]!;
  const run = store.createTaskFromRadar(
    task("digest-stale-current", path.join(root, "work")),
    store.radarSources([item.id]),
    { identity, itemIds: [item.id] },
  )!;
  const locked = run.items[0]!;
  markRead(store, run.taskId, [locked.sourceId]);

  store.commitRemoteSourcePage({
    ...identity,
    nextCursor: "cursor-new-revision.signature",
    sources: [
      remoteSource("item-a", "revision-a2", "第二版完整正文，仍需单独消化"),
    ],
  });
  store.publishRadarDigest(
    run.taskId,
    run.goalVersion,
    "publish-old-revision",
    {
      runId: run.id,
      themes: [
        {
          title: "第一版判断",
          summary: "这是针对第一版锁定正文形成的判断。",
          whyItMatters: "旧版发布不能代替对新修订的阅读。",
          evidence: [
            { sourceId: locked.sourceId, revisionId: locked.revisionId },
          ],
        },
      ],
      dispositions: [],
    },
  );

  const current = store.radarItems(identity)[0]!;
  assert.equal(current.latestRevisionId, "revision-a2");
  assert.equal(current.readAt, undefined);
  assert.equal(store.radarDigestions(identity)[0]?.state, "published");

  const historical = store.radarSourceRevision(
    identity,
    "item-a",
    "revision-a1",
  );
  assert.ok(historical);
  assert.equal(historical.text, "第一版完整正文");
  assert.equal(historical.remote?.revisionId, "revision-a1");
  assert.equal(
    store.radarSourceRevision(
      { ...identity, tenantId: "another-tenant" },
      "item-a",
      "revision-a1",
    ),
    undefined,
  );

  store.db
    .prepare(
      `UPDATE remote_source_revisions SET body=?
       WHERE server_instance_id=? AND tenant_id=? AND item_id=? AND revision_id=?`,
    )
    .run(
      JSON.stringify({ ...historical, text: "被篡改的旧正文" }),
      identity.serverInstanceId,
      identity.tenantId,
      "item-a",
      "revision-a1",
    );
  assert.throws(
    () => store.radarSourceRevision(identity, "item-a", "revision-a1"),
    /正文与内容哈希不一致/,
  );
  store.db
    .prepare(
      `UPDATE remote_source_revisions SET body=?
       WHERE server_instance_id=? AND tenant_id=? AND item_id=? AND revision_id=?`,
    )
    .run(
      JSON.stringify({
        ...historical,
        remote: { ...historical.remote!, tenantId: "another-tenant" },
      }),
      identity.serverInstanceId,
      identity.tenantId,
      "item-a",
      "revision-a1",
    );
  assert.throws(
    () => store.radarSourceRevision(identity, "item-a", "revision-a1"),
    /身份与索引不一致/,
  );
});

test("Radar digest merges paginated reads and permits partial reads only for incomplete or deferred", async (t) => {
  const { root, store } = await fixture(t);
  store.commitRemoteSourcePage({
    ...identity,
    nextCursor: "cursor-ranges.signature",
    sources: [
      remoteSource("item-a", "revision-a1", "A".repeat(30)),
      remoteSource("item-b", "revision-b1", "B".repeat(20)),
      remoteSource("item-c", "revision-c1", "C".repeat(25)),
    ],
  });
  const items = store.radarItems(identity);
  const run = store.createTaskFromRadar(
    task("digest-range-task", path.join(root, "work")),
    store.radarSources(items.map((item) => item.id)),
    { identity, itemIds: items.map((item) => item.id) },
  )!;
  const byRemoteId = new Map(
    run.items.map((item) => [item.remoteItemId, item]),
  );
  const lockedA = byRemoteId.get("item-a")!;
  const lockedB = byRemoteId.get("item-b")!;
  const lockedC = byRemoteId.get("item-c")!;
  markReadRange(store, run.taskId, lockedA.sourceId, 0, 10);
  markReadRange(store, run.taskId, lockedB.sourceId, 0, 1);
  markReadRange(store, run.taskId, lockedC.sourceId, 5, 8);
  const publication: RadarDigestPublicationInput = {
    runId: run.id,
    themes: [
      {
        title: "需要全文支持的主题",
        summary: "不能用一个字符冒充已完整核查。",
        whyItMatters: "主题会进入用户的长期知识判断。",
        evidence: [
          {
            sourceId: lockedA.sourceId,
            revisionId: lockedA.revisionId,
          },
        ],
      },
    ],
    dispositions: [
      {
        sourceId: lockedB.sourceId,
        kind: "low_value",
        reason: "确定性筛选同样需要全文。",
      },
      {
        sourceId: lockedC.sourceId,
        kind: "incomplete",
        reason: "已读到非空片段，但现有正文不足以形成结论。",
      },
    ],
  };

  assert.throws(
    () =>
      store.publishRadarDigest(
        run.taskId,
        run.goalVersion,
        "partial-publication",
        publication,
      ),
    /完整分页读取/,
  );
  markReadRange(store, run.taskId, lockedA.sourceId, 11, 30);
  markReadRange(store, run.taskId, lockedB.sourceId, 1, 20);
  assert.throws(
    () =>
      store.publishRadarDigest(
        run.taskId,
        run.goalVersion,
        "gapped-publication",
        publication,
      ),
    /完整分页读取/,
  );
  markReadRange(store, run.taskId, lockedA.sourceId, 10, 11);
  const published = store.publishRadarDigest(
    run.taskId,
    run.goalVersion,
    "complete-publication",
    publication,
  );
  assert.equal(published.digests.length, 1);
  assert.equal(published.dispositions.length, 2);
  assert.equal(
    published.dispositions.find((entry) => entry.sourceId === lockedC.sourceId)
      ?.kind,
    "incomplete",
  );
});

test("Radar digest ignores legacy, empty, out-of-range and wrong-total read attestations", async (t) => {
  const { root, store } = await fixture(t);
  store.commitRemoteSourcePage({
    ...identity,
    nextCursor: "cursor-invalid-read.signature",
    sources: [remoteSource("item-a", "revision-a1", "可核查的完整正文")],
  });
  const item = store.radarItems(identity)[0]!;
  const context: Source = {
    id: "context-invalid-read",
    title: "本地上下文",
    type: "text",
    location: "lib:context-invalid-read",
    text: "本地旧判断",
    addedAt: "2026-09-12T05:00:30.000Z",
    coverage: "Lib 正文快照",
  };
  const run = store.createTaskFromRadar(
    task("digest-invalid-read-task", path.join(root, "work"), [context]),
    store.radarSources([item.id]),
    {
      identity,
      itemIds: [item.id],
      contextSources: [
        {
          sourceId: context.id,
          kind: "library",
          referenceId: "context-invalid-read",
          version: 1,
        },
      ],
    },
  )!;
  const locked = run.items[0]!;
  store.updateTask(run.taskId, (current) => {
    current.events.push(
      {
        id: "legacy-read",
        type: "tool_completed",
        summary: "旧版只有 sourceId 的读取事件",
        createdAt: "2026-09-12T05:02:00.000Z",
        goalVersion: current.goalVersion,
        data: { tool: "read_source", sourceId: locked.sourceId },
      },
      {
        id: "empty-context-read",
        type: "tool_completed",
        summary: "空范围读取",
        createdAt: "2026-09-12T05:02:01.000Z",
        goalVersion: current.goalVersion,
        data: {
          tool: "read_source",
          sourceId: context.id,
          readStart: context.text.length,
          readEnd: context.text.length,
          totalCharacters: context.text.length,
        },
      },
      {
        id: "wrong-total-read",
        type: "tool_completed",
        summary: "与正文长度不符的范围",
        createdAt: "2026-09-12T05:02:02.000Z",
        goalVersion: current.goalVersion,
        data: {
          tool: "read_source",
          sourceId: locked.sourceId,
          readStart: 99,
          readEnd: 100,
          totalCharacters: 100,
        },
      },
    );
  });
  const publication: RadarDigestPublicationInput = {
    runId: run.id,
    themes: [
      {
        title: "必须经过真实读取的主题",
        summary: "伪造或空范围不能形成读取证明。",
        whyItMatters: "避免未经核查的内容进入雷达。",
        evidence: [
          {
            sourceId: locked.sourceId,
            revisionId: locked.revisionId,
          },
        ],
        context: [
          {
            sourceId: context.id,
            relation: "supports",
            note: "上下文也必须先读到非空正文。",
          },
        ],
      },
    ],
    dispositions: [],
  };

  assert.throws(
    () =>
      store.publishRadarDigest(
        run.taskId,
        run.goalVersion,
        "invalid-context-read",
        publication,
      ),
    /对照资料尚未读到非空正文/,
  );
  markReadRange(store, run.taskId, context.id, 0, 1);
  assert.throws(
    () =>
      store.publishRadarDigest(
        run.taskId,
        run.goalVersion,
        "invalid-locked-read",
        publication,
      ),
    /锁定资料尚未读到非空正文/,
  );
  markReadRange(store, run.taskId, locked.sourceId, 0, 1);
  assert.throws(
    () =>
      store.publishRadarDigest(
        run.taskId,
        run.goalVersion,
        "partial-locked-read",
        publication,
      ),
    /完整分页读取/,
  );
  assert.equal(store.radarDigests(identity).length, 0);
  assert.equal(store.radarDispositions(identity).length, 0);
});

test("a Radar revision has one live digestion and only an explicit terminal retry can replace it", async (t) => {
  const { root, store } = await fixture(t);
  const source = remoteSource("item-a", "revision-a1", "需要并发保护的正文");
  store.commitRemoteSourcePage({
    ...identity,
    nextCursor: "cursor-race.signature",
    sources: [source],
  });
  const item = store.radarItems(identity)[0]!;
  const selected = store.radarSources([item.id]);
  const first = store.createTaskFromRadar(
    task("digest-live", path.join(root, "work-live")),
    selected,
    { identity, itemIds: [item.id] },
  )!;

  assert.throws(
    () =>
      store.createTaskFromRadar(
        task("digest-duplicate", path.join(root, "work-duplicate")),
        selected,
        { identity, itemIds: [item.id] },
      ),
    /已有团队消化任务正在处理/,
  );
  assert.equal(store.tasks().length, 1);
  assert.equal(store.radarDigestions(identity).length, 1);

  store.updateTask(first.taskId, (current) => {
    current.status = "paused";
  });
  assert.throws(
    () =>
      store.createTaskFromRadar(
        task("digest-paused-retry", path.join(root, "work-paused")),
        selected,
        {
          identity,
          itemIds: [item.id],
          retryOfRunId: first.id,
        },
      ),
    /只有失败或已结束但未发布/,
  );
  assert.equal(store.tasks().length, 1);

  store.updateTask(first.taskId, (current) => {
    current.status = "failed";
    current.error = "synthetic failure";
  });
  assert.throws(
    () =>
      store.createTaskFromRadar(
        task("digest-implicit-retry", path.join(root, "work-implicit")),
        selected,
        { identity, itemIds: [item.id] },
      ),
    /使用明确的重试操作/,
  );
  const retry = store.createTaskFromRadar(
    task("digest-explicit-retry", path.join(root, "work-retry")),
    selected,
    {
      identity,
      itemIds: [item.id],
      retryOfRunId: first.id,
    },
  )!;
  assert.equal(retry.retryOfRunId, first.id);
  assert.equal(store.tasks().length, 2);
  assert.equal(store.radarDigestions(identity).length, 2);

  assert.throws(
    () =>
      store.createTaskFromRadar(
        task("digest-concurrent-retry", path.join(root, "work-concurrent")),
        selected,
        {
          identity,
          itemIds: [item.id],
          retryOfRunId: first.id,
        },
      ),
    /已有团队消化任务正在处理/,
  );
  assert.equal(store.tasks().length, 2);
  assert.equal(store.radarDigestions(identity).length, 2);
});
