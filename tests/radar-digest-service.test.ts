import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponder,
} from "@openai/agents/testing";
import { WorkbenchService } from "../src/core/service.js";
import { parseCommand } from "../src/desktop/commands.js";
import type { ModelProfile, Source } from "../src/shared/types.js";
import type {
  SourceGateway,
  SourceReceiveSink,
} from "../src/core/source-gateway.js";

const identity = {
  serverInstanceId: "71fb60c7-f5ee-4cfc-91a8-fb4ddfa3b33d",
  tenantId: "tenant-radar-digest",
};

test("a pushed Radar revision is automatically digested and only structured publication reaches the page", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ytriple-radar-digest-"),
  );
  let sink: SourceReceiveSink | undefined;
  const gateway: SourceGateway = {
    addURL: async () => {
      throw new Error("not used");
    },
    startReceiving: (receiver) => {
      sink = receiver;
    },
  };
  const profile: ModelProfile = {
    id: "radar-model",
    name: "Radar synthetic model",
    provider: "compatible",
    protocol: "openai",
    baseURL: "https://example.test/v1",
    modelId: "radar-synthetic",
    apiKeyEnv: "RADAR_TEST_KEY",
    hasKey: true,
    status: "ready",
    capabilities: { text: true, tools: true, streaming: true },
  };
  let service!: WorkbenchService;
  const model = new ScriptedModel([
    modelResponder(() => {
      const task = service.store
        .tasks()
        .find((candidate) => candidate.surface === "background");
      assert.ok(task, "automatic digestion creates a hidden team task");
      const source = task.sources.find((candidate) => candidate.remote);
      assert.ok(source);
      return [
        functionCall(
          "read_source",
          { sourceId: source.id, start: 0, maxCharacters: 24_000 },
          { callId: "read-pushed-source" },
        ),
      ];
    }),
    modelResponder(() => {
      const run = service.store.radarDigestions(identity)[0];
      assert.ok(run);
      const evidence = run.items[0]!;
      return [
        functionCall(
          "publish_radar_digest",
          {
            runId: run.id,
            themes: [
              {
                title: "来源服务器出现了可核查的新变化",
                summary:
                  "团队读取了服务器推送的完整正文，并将变化合并成一项主题判断。",
                whyItMatters:
                  "这证明 Radar 的价值链已经从接收推进到本机团队消化，而不是停在信息流列表。",
                topics: ["Radar 闭环"],
                evidence: [
                  {
                    sourceId: evidence.sourceId,
                    revisionId: evidence.revisionId,
                    note: "服务器推送的锁定修订",
                  },
                ],
              },
            ],
            dispositions: [],
          },
          { callId: "publish-radar-theme" },
        ),
      ];
    }),
    [assistantMessage("结构化主题已经发布。")],
  ]);
  service = new WorkbenchService(
    path.join(root, "data"),
    () => "synthetic-key",
    () => {},
    {
      sourceGateway: gateway,
      modelFactory: () => model,
      radarDigestDelayMs: 0,
    },
  );
  t.after(async () => {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  service.store.setConfig("profiles", [profile]);
  service.store.setConfig("settings", {
    ...service.store.settings(),
    aiRoot: path.join(root, "AI"),
    codeRoot: path.join(root, "Code"),
    workspaceRoot: path.join(root, "work"),
    defaultProfileId: profile.id,
    memberProfiles: {
      coordinator: profile.id,
      cto: profile.id,
      researcher: profile.id,
    },
    projectMonitoring: false,
  });
  await service.initialize();
  assert.ok(sink);

  const text = "这是信息源服务器主动推送并由本机团队读取的完整正文。";
  const source: Source = {
    id: "radar-source-material-1",
    title: "信息源服务器推送的新变化",
    type: "url",
    location: "https://example.com/radar-change",
    text,
    addedAt: "2026-09-12T18:00:00.000Z",
    coverage: "网页正文（fulltext）",
    remote: {
      ...identity,
      sourceId: "remote-source-1",
      itemId: "remote-item-1",
      revisionId: "remote-revision-1",
      contentHash: createHash("sha256").update(text).digest("hex"),
      observedAt: "2026-09-12T18:00:00.000Z",
      coverageLevel: "fulltext",
      missing: [],
    },
  };
  await sink.commit({
    ...identity,
    nextCursor: "digest_cursor.signature",
    sources: [source],
  });
  const pushedItem = service.store.radarItems(identity)[0]!;
  const concurrentManual = service
    .execute({ type: "radar.digest", itemIds: [pushedItem.id] })
    .catch((error: unknown) => error);

  const deadline = Date.now() + 3_000;
  let snapshot = await service.snapshot();
  while (!snapshot.radar?.digests?.length && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    snapshot = await service.snapshot();
  }
  const manualResult = await concurrentManual;
  if (manualResult instanceof Error)
    assert.match(
      manualResult.message,
      /已有团队消化任务正在处理|已经形成主题理解/,
    );

  assert.equal(
    snapshot.tasks.length,
    0,
    "background digestion is not a user task",
  );
  assert.equal(
    snapshot.radar?.digests?.length,
    1,
    JSON.stringify(
      service.store.tasks().map((task) => ({
        status: task.status,
        error: task.error,
        events: task.events.map((event) => ({
          type: event.type,
          summary: event.summary,
        })),
      })),
    ),
  );
  assert.match(snapshot.radar!.digests![0]!.summary, /团队读取/);
  assert.equal(snapshot.radar?.digestions?.[0]?.state, "published");
  assert.equal(snapshot.radar?.digestions?.[0]?.taskStatus, "completed");
  assert.equal(snapshot.radar?.digestionError, undefined);
  assert.ok(snapshot.radar?.items[0]?.readAt);
  assert.equal(snapshot.radar?.unreadCount, 0);
  assert.equal(snapshot.radar?.items[0]?.taskIds.length, 0);
  assert.equal(service.store.radarDigestions(identity).length, 1);
  assert.equal(service.store.tasks().length, 1);
  assert.equal(service.store.tasks()[0]?.surface, "background");
  assert.equal(service.store.tasks()[0]?.status, "completed");

  const updatedText =
    "这是同一条来源随后抵达的第二版正文，不能替代发布判断所用的第一版。";
  service.store.commitRemoteSourcePage({
    ...identity,
    nextCursor: "digest_updated_cursor.signature",
    sources: [
      {
        ...source,
        id: "radar-source-material-2",
        text: updatedText,
        remote: {
          ...source.remote!,
          revisionId: "remote-revision-2",
          contentHash: createHash("sha256").update(updatedText).digest("hex"),
          observedAt: "2026-09-12T18:10:00.000Z",
        },
      },
    ],
  });
  const foreignIdentity = {
    serverInstanceId: identity.serverInstanceId,
    tenantId: "tenant-radar-digest-foreign",
  };
  const foreignText = "另一个租户的正文不得进入当前 Radar 证据投影。";
  service.store.commitRemoteSourcePage({
    ...foreignIdentity,
    nextCursor: "foreign_cursor.signature",
    sources: [
      {
        ...source,
        id: "foreign-radar-source",
        text: foreignText,
        remote: {
          ...source.remote!,
          ...foreignIdentity,
          itemId: "foreign-item",
          revisionId: "foreign-revision",
          contentHash: createHash("sha256").update(foreignText).digest("hex"),
        },
      },
    ],
  });

  snapshot = await service.snapshot();
  const currentItem = snapshot.radar!.items.find(
    (item) => item.remoteItemId === source.remote!.itemId,
  )!;
  const publishedEvidence =
    snapshot.radar!.evidenceRevisions?.[currentItem.id]?.[
      source.remote!.revisionId
    ];
  assert.equal(currentItem.latestRevisionId, "remote-revision-2");
  assert.equal(publishedEvidence?.content, text);
  assert.equal(publishedEvidence?.contentHash, source.remote!.contentHash);
  assert.equal(
    snapshot.radar!.evidenceRevisions?.[currentItem.id]?.["remote-revision-2"],
    undefined,
    "an unreferenced latest revision is not exposed as published evidence",
  );
  const foreignItem = service.store.radarItems(foreignIdentity)[0]!;
  assert.equal(snapshot.radar!.evidenceRevisions?.[foreignItem.id], undefined);

  service.store.db
    .prepare(
      `DELETE FROM remote_source_revisions
       WHERE server_instance_id=? AND tenant_id=? AND item_id=? AND revision_id=?`,
    )
    .run(
      identity.serverInstanceId,
      identity.tenantId,
      source.remote!.itemId,
      source.remote!.revisionId,
    );
  snapshot = await service.snapshot();
  assert.equal(
    snapshot.radar!.evidenceRevisions?.[currentItem.id]?.[
      source.remote!.revisionId
    ],
    undefined,
    "a missing historical row leaves an unavailable evidence slot instead of breaking the snapshot",
  );
});

test("concurrent manual digestion requests coalesce without duplicate runs or hidden tasks", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ytriple-radar-digest-race-"),
  );
  const profile: ModelProfile = {
    id: "radar-model",
    name: "Radar synthetic model",
    provider: "compatible",
    protocol: "openai",
    baseURL: "https://example.test/v1",
    modelId: "radar-synthetic",
    apiKeyEnv: "RADAR_TEST_KEY",
    hasKey: true,
    status: "ready",
    capabilities: { text: true, tools: true, streaming: true },
  };
  const service = new WorkbenchService(
    path.join(root, "data"),
    () => "synthetic-key",
    () => {},
    {
      autoDigestRadar: false,
      modelFactory: () =>
        new ScriptedModel([[assistantMessage("没有结构化发布的合成回复。")]]),
    },
  );
  t.after(async () => {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  service.store.setConfig("profiles", [profile]);
  service.store.setConfig("settings", {
    ...service.store.settings(),
    aiRoot: path.join(root, "AI"),
    codeRoot: path.join(root, "Code"),
    workspaceRoot: path.join(root, "work"),
    defaultProfileId: profile.id,
    memberProfiles: {
      coordinator: profile.id,
      cto: profile.id,
      researcher: profile.id,
    },
    projectMonitoring: false,
  });
  await service.initialize();
  const body = "同一修订只能建立一个仍在工作的后台消化批次。";
  service.store.commitRemoteSourcePage({
    ...identity,
    nextCursor: "race_cursor.signature",
    sources: [
      {
        id: "race-source-material",
        title: "并发消化信号",
        type: "url",
        location: "https://example.com/radar-race",
        text: body,
        addedAt: "2026-09-12T19:00:00.000Z",
        coverage: "网页正文（fulltext）",
        remote: {
          ...identity,
          sourceId: "race-remote-source",
          itemId: "race-remote-item",
          revisionId: "race-remote-revision",
          contentHash: createHash("sha256").update(body).digest("hex"),
          observedAt: "2026-09-12T19:00:00.000Z",
          coverageLevel: "fulltext",
          missing: [],
        },
      },
    ],
  });
  const item = service.store.radarItems(identity)[0]!;
  const command = { type: "radar.digest" as const, itemIds: [item.id] };

  await Promise.all([service.execute(command), service.execute(command)]);

  assert.equal(service.store.radarDigestions(identity).length, 1);
  assert.equal(
    service.store.tasks().filter((task) => task.surface === "background")
      .length,
    1,
  );

  const deadline = Date.now() + 1_000;
  while (service.store.tasks()[0]?.status !== "failed" && Date.now() < deadline)
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  assert.equal(service.store.tasks()[0]?.status, "failed");
  assert.equal(service.store.radarItems(identity)[0]?.readAt, undefined);
  const workspacesBefore = await fs.readdir(path.join(root, "work"));
  await assert.rejects(service.execute(command), /使用明确的重试操作/);
  assert.deepEqual(
    await fs.readdir(path.join(root, "work")),
    workspacesBefore,
    "a rejected duplicate must not leave an empty workspace",
  );

  const firstRun = service.store.radarDigestions(identity)[0]!;
  await service.execute({ ...command, retry: true });
  const runs = service.store.radarDigestions(identity);
  assert.equal(runs.length, 2);
  assert.equal(runs[0]?.retryOfRunId, firstRun.id);
  assert.equal(service.store.tasks().length, 2);
});

test("automatic digestion exposes an independent error and requires explicitly verified tools", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ytriple-radar-digest-capability-"),
  );
  let sink: SourceReceiveSink | undefined;
  const gateway: SourceGateway = {
    addURL: async () => {
      throw new Error("not used");
    },
    startReceiving: (receiver) => {
      sink = receiver;
    },
  };
  const profile: ModelProfile = {
    id: "radar-unverified-tools",
    name: "Radar model without verified tools",
    provider: "compatible",
    protocol: "openai",
    baseURL: "https://example.test/v1",
    modelId: "radar-unverified-tools",
    apiKeyEnv: "RADAR_TEST_KEY",
    hasKey: true,
    status: "ready",
  };
  let releaseModel = () => {};
  const modelGate = new Promise<void>((resolve) => {
    releaseModel = resolve;
  });
  let modelFactoryCalls = 0;
  const service = new WorkbenchService(
    path.join(root, "data"),
    () => "synthetic-key",
    () => {},
    {
      sourceGateway: gateway,
      radarDigestDelayMs: 0,
      modelFactory: () => {
        modelFactoryCalls += 1;
        return new ScriptedModel([
          modelResponder(async () => {
            await modelGate;
            return [assistantMessage("未调用结构化发布工具。")];
          }),
        ]);
      },
    },
  );
  t.after(async () => {
    releaseModel();
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  service.store.setConfig("profiles", [profile]);
  service.store.setConfig("settings", {
    ...service.store.settings(),
    aiRoot: path.join(root, "AI"),
    codeRoot: path.join(root, "Code"),
    workspaceRoot: path.join(root, "work"),
    defaultProfileId: profile.id,
    memberProfiles: {
      coordinator: profile.id,
      cto: profile.id,
      researcher: profile.id,
    },
    projectMonitoring: false,
  });
  await service.initialize();
  assert.ok(sink);

  const text = "工具能力尚未经过明确验证时，这条信号必须保持未读。";
  await sink.commit({
    ...identity,
    nextCursor: "capability_cursor.signature",
    sources: [
      {
        id: "unverified-tools-source",
        title: "等待可靠自动消化的信号",
        type: "url",
        location: "https://example.com/unverified-tools",
        text,
        addedAt: "2026-09-12T20:00:00.000Z",
        coverage: "网页正文（fulltext）",
        remote: {
          ...identity,
          sourceId: "unverified-tools-remote-source",
          itemId: "unverified-tools-item",
          revisionId: "unverified-tools-revision",
          contentHash: createHash("sha256").update(text).digest("hex"),
          observedAt: "2026-09-12T20:00:00.000Z",
          coverageLevel: "fulltext",
          missing: [],
        },
      },
    ],
  });

  const deadline = Date.now() + 2_000;
  let snapshot = await service.snapshot();
  while (!snapshot.radar?.digestionError && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    snapshot = await service.snapshot();
  }
  assert.equal(snapshot.radar?.connection, "online");
  assert.equal(snapshot.radar?.error, undefined);
  assert.match(snapshot.radar?.digestionError ?? "", /支持工具调用/);
  assert.equal(snapshot.radar?.items[0]?.readAt, undefined);
  assert.equal(snapshot.radar?.unreadCount, 1);
  assert.equal(service.store.tasks().length, 0);
  assert.equal(modelFactoryCalls, 0);

  service.store.setConfig("profiles", [
    {
      ...profile,
      capabilities: { text: true, tools: true, streaming: true },
    },
  ]);
  const launched = await service.execute({
    type: "radar.digest",
    itemIds: [snapshot.radar!.items[0]!.id],
  });
  assert.equal(launched.radar?.digestionError, undefined);
  assert.equal(launched.radar?.items[0]?.readAt, undefined);

  releaseModel();
  const failureDeadline = Date.now() + 2_000;
  snapshot = await service.snapshot();
  while (!snapshot.radar?.digestionError && Date.now() < failureDeadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    snapshot = await service.snapshot();
  }
  assert.match(
    snapshot.radar?.digestionError ?? "",
    /未调用 publish_radar_digest/,
  );
  assert.equal(snapshot.radar?.items[0]?.readAt, undefined);
  assert.equal(snapshot.radar?.unreadCount, 1);
});

test("the desktop command boundary preserves an explicit Radar retry", () => {
  assert.deepEqual(
    parseCommand({
      type: "radar.digest",
      itemIds: ["radar-item"],
      retry: true,
    }),
    {
      type: "radar.digest",
      itemIds: ["radar-item"],
      retry: true,
    },
  );
});
