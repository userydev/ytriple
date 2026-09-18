import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { Radar } from "../src/core/radar";
import { Schedules } from "../src/core/schedules";
import { RadarWatches } from "../src/core/radar-watches";
import { WorkspaceActions } from "../src/core/workspace-actions";
import {
  defaultTeam,
  adaptiveWorkflow,
  type Contribution,
  type Run,
  type Work,
} from "../src/core/types";
import type { Model } from "../src/core/ycore";
import { parseToolRequest, type ToolReceipt } from "../src/core/tool-contract";

function fixture(direct: boolean, text = "新建雷达议题", path = ":memory:") {
  const store = new Store(path);
  let scope = "account:test";
  const workId = randomUUID(), runId = randomUUID(), contributionId = `${runId}:0:t0:a0`;
  store.put("meta", "workspace-policy", { direct });
  store.put<Work>("work", workId, {
    id: workId, title: "工作", projectId: null, deliveryId: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    archived: false, queuePaused: false,
  });
  const run: Run = {
    id: runId, workId, text, refs: [], recipient: null, status: "running",
    error: null, createdAt: new Date().toISOString(), team: defaultTeam,
    workflow: adaptiveWorkflow, baseVersionId: null, submissionKey: randomUUID(),
    serviceScope: "account:test", workspacePolicy: { direct },
  };
  store.put("run", run.id, run);
  store.put<Contribution>("contribution", contributionId, {
    id: contributionId, workId, runId, memberId: defaultTeam.members[0].id,
    memberName: defaultTeam.members[0].name, objective: text, body: "", status: "succeeded",
    remoteId: null, error: null, createdAt: new Date().toISOString(),
    task: { key: "top", stage: 0, depth: 0, refs: [] },
  });
  const radar = new Radar(store, () => ({ scope: "account:test" }) as Model);
  const schedules = new Schedules(store, { startQueued() {}, stop() {} }, () => scope);
  const watches = new RadarWatches(store, radar, () => scope);
  const actions = new WorkspaceActions(store, {
    radar, schedules, radarWatches: watches, currentScope: () => scope,
  });
  return { store, run, contributionId, actions, radar, schedules, watches,
    setScope(value: string) { scope = value; } };
}

test("host-approved top-level topic creation applies once and undo archives at the exact revision", () => {
  const f = fixture(true);
  try {
    const material = f.store.addMaterial("来源", "正文");
    const proposal = f.actions.prepare(f.run, f.contributionId, defaultTeam.members[0].id, {
      kind: "radar-topic",
      topic: {
        revision: 0, title: "可靠议题", focus: "只看指定来源",
        sources: [{ materialId: material.id, policy: "keep", reason: "用户指定" }],
      },
    });
    assert.equal(proposal.status, "applied");
    assert.equal(f.store.all("radar-topic").length, 1);
    assert.deepEqual(f.actions.apply(proposal.id), proposal);
    const undone = f.actions.undo(proposal.id);
    assert.equal(undone.status, "undone");
    assert.equal(f.store.require<any>("radar-topic", proposal.result!.id).archived, true);
  } finally { f.store.close(); }
});

test("policy-off, material-influenced, and delegated action intents remain pending", () => {
  for (const [direct, text, refs, depth] of [
    [false, "新建雷达议题", [], 0],
    [true, "根据材料新建雷达议题", [{ materialId: "m", version: 1, label: "m" }], 0],
    [true, "新建雷达议题", [], 1],
  ] as const) {
    const f = fixture(direct, text);
    try {
      f.run.refs = [...refs];
      f.store.put("run", f.run.id, f.run);
      const c = f.store.require<Contribution>("contribution", f.contributionId);
      f.store.put("contribution", c.id, { ...c, task: { ...c.task!, depth } });
      const material = f.store.addMaterial("来源", "正文");
      const proposal = f.actions.prepare(f.run, f.contributionId, c.memberId, {
        kind: "radar-topic",
        topic: { revision: 0, title: "待确认议题", focus: "", sources: [
          { materialId: material.id, policy: "keep", reason: "指定" },
        ] },
      });
      assert.equal(proposal.status, "pending");
      assert.equal(f.store.all("radar-topic").length, 0);
    } finally { f.store.close(); }
  }
});

test("expired or cancelled confirmation cannot mutate the domain and replay is stable", () => {
  const f = fixture(false);
  try {
    const material = f.store.addMaterial("来源", "正文");
    const proposal = f.actions.prepare(f.run, f.contributionId, defaultTeam.members[0].id, {
      kind: "radar-topic",
      topic: { revision: 0, title: "过期待确认", focus: "", sources: [
        { materialId: material.id, policy: "keep", reason: "指定" },
      ] },
    });
    f.store.put("workspace-action", proposal.id, { ...proposal, expiresAt: "2000-01-01T00:00:00.000Z" });
    assert.throws(() => f.actions.apply(proposal.id), /过期/);
    assert.equal(f.store.all("radar-topic").length, 0);
    f.store.put("workspace-action", proposal.id, proposal);
    f.store.put("run", f.run.id, { ...f.run, status: "cancelled" });
    assert.throws(() => f.actions.apply(proposal.id), /已停止/);
    assert.equal(f.store.require<any>("workspace-action", proposal.id).status, "pending");
  } finally { f.store.close(); }
});

function scheduleInput(f: ReturnType<typeof fixture>, more: Record<string, unknown> = {}) {
  return {
    id: randomUUID(), expectedRevision: 0, name: "晨间整理",
    workId: f.run.workId, projectId: null, text: "整理最新进展", refs: [],
    recipient: null, skillKeys: [], outputMode: "summary" as const,
    firstAt: new Date(Date.now() + 3_600_000).toISOString(),
    intervalHours: 24, timezone: "UTC", followLatest: false,
    maxModelCalls: 4, enabled: false, ...more,
  };
}

test("context timing slowdown applies directly, uses an edit summary, and stale undo cannot overwrite later changes", () => {
  const f = fixture(true, "把晨间整理改成每两天运行，时间推后一小时");
  try {
    const original = f.schedules.save(scheduleInput(f));
    f.run.workspaceContext = { kind: "schedule", id: original.id, revision: original.revision };
    f.store.put("run", f.run.id, f.run);
    const proposal = f.actions.prepare(f.run, f.contributionId, defaultTeam.members[0].id, {
      kind: "schedule",
      input: scheduleInput(f, {
        id: original.id,
        expectedRevision: original.revision,
        firstAt: new Date(Date.parse(original.firstAt) + 3_600_000).toISOString(),
        intervalHours: 48,
      }),
    });
    assert.equal(proposal.status, "applied");
    assert.match(proposal.summary, /^修改定时任务/);
    const changed = f.store.require<any>("schedule", original.id);
    assert.equal(changed.intervalHours, 48);
    f.schedules.save(scheduleInput(f, {
      id: changed.id, expectedRevision: changed.revision,
      firstAt: new Date(Date.parse(changed.firstAt) + 3_600_000).toISOString(),
      intervalHours: 72,
    }));
    assert.throws(() => f.actions.undo(proposal.id), /已变化/);
    assert.equal(f.store.require<any>("workspace-action", proposal.id).status, "applied");
  } finally { f.store.close(); }
});

test("unique literal schedule name plus inspect binds the exact revision for a direct pause without page context", () => {
  const f = fixture(true, "暂停晨间整理");
  try {
    const schedule = f.schedules.save(scheduleInput(f, { enabled: true }));
    const receipt: ToolReceipt = {
      id: "tool:inspect", runId: f.run.id, contributionId: "inspect",
      memberId: defaultTeam.members[0].id, fingerprint: "0".repeat(64),
      request: { key: "builtin.workspace@1", purpose: "确认目标", input: { mode: "inspect", query: "晨间整理" } },
      status: "succeeded", output: "{}", createdAt: new Date().toISOString(),
    };
    f.store.put("tool-call", receipt.id, receipt);
    const proposal = f.actions.prepare(f.run, f.contributionId, receipt.memberId, {
      kind: "schedule-enabled", id: schedule.id, revision: schedule.revision, enabled: false,
    });
    assert.equal(proposal.status, "applied");
    assert.equal(f.store.require<any>("schedule", schedule.id).enabled, false);
  } finally { f.store.close(); }
});

test("quoted, negated, and hypothetical operation talk is rejected before any proposal exists", () => {
  for (const text of ["把“暂停安排”写进说明", "不要创建议题", "如果创建议题会怎样？", "暂停会怎样"]) {
    const f = fixture(true, text);
    try {
      const material = f.store.addMaterial("来源", "正文");
      assert.throws(
        () => f.actions.prepare(f.run, f.contributionId, defaultTeam.members[0].id, {
          kind: "radar-topic",
          topic: { revision: 0, title: "不应办理", focus: "", sources: [
            { materialId: material.id, policy: "keep", reason: "指定" },
          ] },
        }),
        /未生成工作区操作/,
      );
      assert.equal(f.store.all("radar-topic").length, 0);
      assert.equal(f.store.all("workspace-action").length, 0, text);
    } finally { f.store.close(); }
  }
});

test("a polite request remains confirmable, and revoking direct policy before a late action prevents direct execution", () => {
  const polite = fixture(true, "可以帮我新建一个雷达议题吗？");
  try {
    const material = polite.store.addMaterial("来源", "正文");
    const proposal = polite.actions.prepare(polite.run, polite.contributionId, defaultTeam.members[0].id, {
      kind: "radar-topic", topic: { revision: 0, title: "礼貌请求", focus: "", sources: [
        { materialId: material.id, policy: "keep", reason: "指定" },
      ] },
    });
    assert.equal(proposal.status, "pending");
  } finally { polite.store.close(); }

  const revoked = fixture(true, "新建雷达议题");
  try {
    revoked.store.put("meta", "workspace-policy", { direct: false });
    const material = revoked.store.addMaterial("来源", "正文");
    const proposal = revoked.actions.prepare(revoked.run, revoked.contributionId, defaultTeam.members[0].id, {
      kind: "radar-topic", topic: { revision: 0, title: "晚到动作", focus: "", sources: [
        { materialId: material.id, policy: "keep", reason: "指定" },
      ] },
    });
    assert.equal(proposal.status, "pending");
    assert.equal(revoked.store.all("radar-topic").length, 0);
  } finally { revoked.store.close(); }
});

test("scope drift and a late domain failure leave a pending proposal with no partial work", () => {
  const scope = fixture(false, "创建定时任务");
  try {
    const proposal = scope.actions.prepare(scope.run, scope.contributionId, defaultTeam.members[0].id, {
      kind: "schedule", input: scheduleInput(scope, { id: undefined }),
    });
    scope.setScope("account:other");
    assert.throws(() => scope.actions.apply(proposal.id), /权限范围已变化/);
    assert.equal(scope.store.all("schedule").length, 0);
    assert.equal(scope.store.require<any>("workspace-action", proposal.id).status, "pending");
  } finally { scope.store.close(); }

  const failed = fixture(false, "创建定时任务");
  try {
    const before = failed.store.all("work").length;
    const proposal = failed.actions.prepare(failed.run, failed.contributionId, defaultTeam.members[0].id, {
      kind: "schedule",
      input: scheduleInput(failed, {
        id: undefined, workId: null, recipient: "missing-member",
      }),
    });
    assert.throws(() => failed.actions.apply(proposal.id), /没有所选负责人/);
    assert.equal(failed.store.all("work").length, before);
    assert.equal(failed.store.all("schedule").length, 0);
    assert.equal(failed.store.require<any>("workspace-action", proposal.id).status, "pending");
  } finally { failed.store.close(); }
});

test("a stale pending edit cannot overwrite a newer topic revision", () => {
  const f = fixture(false, "修改议题");
  try {
    const material = f.store.addMaterial("来源", "正文");
    const original = f.radar.saveTopic({
      revision: 0, title: "版本议题", focus: "原范围", sources: [
        { materialId: material.id, policy: "keep", reason: "指定" },
      ],
    });
    const { updatedAt: _updatedAt, ...topic } = original;
    const proposal = f.actions.prepare(f.run, f.contributionId, defaultTeam.members[0].id, {
      kind: "radar-topic",
      topic: { ...topic, title: "待确认名称", revision: original.revision },
    });
    f.radar.saveTopic({ ...topic, title: "用户较新名称", revision: original.revision });
    assert.throws(() => f.actions.apply(proposal.id), /已变化/);
    assert.equal(f.store.require<any>("radar-topic", original.id).title, "用户较新名称");
    assert.equal(f.store.require<any>("workspace-action", proposal.id).status, "pending");
  } finally { f.store.close(); }
});

test("an applied receipt reopens from disk and replays without duplicating the domain effect", () => {
  const root = mkdtempSync(join(tmpdir(), "ytriple-workspace-actions-"));
  const path = join(root, "workbench.sqlite");
  const f = fixture(true, "新建雷达议题", path);
  let id = "";
  try {
    const material = f.store.addMaterial("来源", "正文");
    const proposal = f.actions.prepare(f.run, f.contributionId, defaultTeam.members[0].id, {
      kind: "radar-topic",
      topic: { revision: 0, title: "重开幂等", focus: "", sources: [
        { materialId: material.id, policy: "keep", reason: "指定" },
      ] },
    });
    id = proposal.id;
    assert.equal(proposal.status, "applied");
  } finally { f.store.close(); }
  const reopened = new Store(path);
  try {
    const radar = new Radar(reopened, () => ({ scope: "account:test" }) as Model);
    const schedules = new Schedules(reopened, { startQueued() {}, stop() {} }, () => "account:test");
    const actions = new WorkspaceActions(reopened, {
      radar, schedules,
      radarWatches: new RadarWatches(reopened, radar, () => "account:test"),
      currentScope: () => "account:test",
    });
    assert.equal(actions.apply(id).status, "applied");
    assert.equal(reopened.all("radar-topic").length, 1);
  } finally {
    reopened.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function topicWithWatch(f: ReturnType<typeof fixture>, enabled: boolean) {
  const material = f.store.addMaterial("监控来源", "正文");
  const topic = f.radar.saveTopic({
    revision: 0, title: "市场监控", focus: "只看变化", sources: [
      { materialId: material.id, policy: "keep", reason: "指定" },
    ],
  });
  const watch = f.watches.save({
    topicId: topic.id, topicRevision: topic.revision, expectedRevision: 0,
    enabled, intervalMinutes: 60, maxCallsPerDay: 8,
  });
  f.run.workspaceContext = { kind: "radar-topic", id: topic.id, revision: topic.revision };
  f.store.put("run", f.run.id, f.run);
  return { topic, watch };
}

test("an authorized contextual radar watch pause applies directly and undo restores without immediate catch-up", () => {
  const f = fixture(true, "暂停这个议题的自动整理");
  try {
    const { topic, watch } = topicWithWatch(f, true);
    const proposal = f.actions.prepare(f.run, f.contributionId, defaultTeam.members[0].id, {
      kind: "radar-watch",
      input: {
        topicId: topic.id, topicRevision: topic.revision,
        expectedRevision: watch.revision, enabled: false,
        intervalMinutes: watch.intervalMinutes, maxCallsPerDay: watch.maxCallsPerDay,
      },
    });
    assert.equal(proposal.status, "applied");
    assert.equal(f.store.require<any>("radar-watch", topic.id).enabled, false);
    const beforeUndo = Date.now();
    assert.equal(f.actions.undo(proposal.id).status, "undone");
    const restored = f.store.require<any>("radar-watch", topic.id);
    assert.equal(restored.enabled, true);
    assert.ok(Date.parse(restored.nextAt) > beforeUndo);
  } finally { f.store.close(); }
});

test("radar watch rate reduction is direct, while first enable remains confirmation-only", () => {
  const reduced = fixture(true, "把市场监控改成每两小时，最多每天四次");
  try {
    const { topic, watch } = topicWithWatch(reduced, true);
    const proposal = reduced.actions.prepare(
      reduced.run, reduced.contributionId, defaultTeam.members[0].id,
      { kind: "radar-watch", input: {
        topicId: topic.id, topicRevision: topic.revision,
        expectedRevision: watch.revision, enabled: true,
        intervalMinutes: 120, maxCallsPerDay: 4,
      } },
    );
    assert.equal(proposal.status, "applied");
    assert.equal(reduced.store.require<any>("radar-watch", topic.id).intervalMinutes, 120);
  } finally { reduced.store.close(); }

  const enabled = fixture(true, "启用市场监控");
  try {
    const { topic, watch } = topicWithWatch(enabled, false);
    const proposal = enabled.actions.prepare(
      enabled.run, enabled.contributionId, defaultTeam.members[0].id,
      { kind: "radar-watch", input: {
        topicId: topic.id, topicRevision: topic.revision,
        expectedRevision: watch.revision, enabled: true,
        intervalMinutes: watch.intervalMinutes, maxCallsPerDay: watch.maxCallsPerDay,
      } },
    );
    assert.equal(proposal.status, "pending");
    assert.equal(enabled.store.require<any>("radar-watch", topic.id).enabled, false);
  } finally { enabled.store.close(); }
});

test("inspect always puts the bound object inside the bounded result even when query does not match", () => {
  const f = fixture(false, "检查当前对象");
  try {
    const material = f.store.addMaterial("来源", "正文");
    const topics = Array.from({ length: 13 }, (_, index) =>
      f.radar.saveTopic({
        revision: 0, title: `议题${index}`, focus: "", sources: [
          { materialId: material.id, policy: "keep", reason: "指定" },
        ],
      }),
    );
    f.run.workspaceContext = {
      kind: "radar-topic", id: topics[12].id, revision: topics[12].revision,
    };
    let inventory = f.actions.inspect(f.run, "完全不匹配");
    assert.equal(inventory.topics[0].id, topics[12].id);
    assert.ok(inventory.topics[0].input);

    const schedules = Array.from({ length: 13 }, (_, index) =>
      f.schedules.save(scheduleInput(f, { id: randomUUID(), name: `任务${index}` })),
    );
    f.run.workspaceContext = {
      kind: "schedule", id: schedules[12].id, revision: schedules[12].revision,
    };
    inventory = f.actions.inspect(f.run, "仍然不匹配");
    assert.equal(inventory.schedules[0].id, schedules[12].id);
    assert.ok(inventory.schedules[0].input);
    assert.ok(inventory.topics.length <= 12 && inventory.schedules.length <= 12);
  } finally { f.store.close(); }
});

test("undo refuses service-scope drift and new recurring objects undo by disabling future work", () => {
  const scoped = fixture(true, "新建雷达议题");
  try {
    const material = scoped.store.addMaterial("来源", "正文");
    const proposal = scoped.actions.prepare(scoped.run, scoped.contributionId, defaultTeam.members[0].id, {
      kind: "radar-topic", topic: { revision: 0, title: "scope议题", focus: "", sources: [
        { materialId: material.id, policy: "keep", reason: "指定" },
      ] },
    });
    scoped.setScope("account:other");
    assert.throws(() => scoped.actions.undo(proposal.id), /权限范围已变化/);
    assert.equal(scoped.store.require<any>("workspace-action", proposal.id).status, "applied");
  } finally { scoped.store.close(); }

  const scheduled = fixture(false, "创建并启用定时任务");
  try {
    const proposal = scheduled.actions.prepare(
      scheduled.run, scheduled.contributionId, defaultTeam.members[0].id,
      { kind: "schedule", input: scheduleInput(scheduled, { id: undefined, enabled: true }) },
    );
    const applied = scheduled.actions.apply(proposal.id);
    assert.equal(scheduled.store.require<any>("schedule", applied.result!.id).enabled, true);
    assert.equal(scheduled.actions.undo(proposal.id).status, "undone");
    assert.equal(scheduled.store.require<any>("schedule", applied.result!.id).enabled, false);
  } finally { scheduled.store.close(); }

  const watched = fixture(false, "首次启用自动整理");
  try {
    const { topic } = topicWithWatch(watched, false);
    watched.store.remove("radar-watch", topic.id);
    const proposal = watched.actions.prepare(
      watched.run, watched.contributionId, defaultTeam.members[0].id,
      { kind: "radar-watch", input: {
        topicId: topic.id, topicRevision: topic.revision, expectedRevision: 0,
        enabled: true, intervalMinutes: 60, maxCallsPerDay: 4,
      } },
    );
    watched.actions.apply(proposal.id);
    assert.equal(watched.actions.undo(proposal.id).status, "undone");
    const watch = watched.store.require<any>("radar-watch", topic.id);
    assert.equal(watch.enabled, false);
    assert.equal(watch.nextAt, null);
  } finally { watched.store.close(); }
});

test("workspace schedule accepts an ISO offset, normalizes it to UTC, and reports bad fields concisely", () => {
  const f = fixture(false, "安排明天九点");
  try {
    const raw = JSON.stringify({ ytriple_tool: {
      key: "builtin.workspace@1", purpose: "安排明确时间", input: {
        mode: "act", action: { kind: "schedule", input: scheduleInput(f, {
          id: undefined,
          firstAt: "2030-09-19T09:00:00-07:00",
          timezone: "America/Los_Angeles",
        }) },
      },
    } });
    const request = parseToolRequest(raw)!;
    assert.equal(request.key, "builtin.workspace@1");
    if (request.key !== "builtin.workspace@1" || request.input.mode !== "act" ||
        request.input.action.kind !== "schedule")
      throw Error("unexpected request");
    assert.equal(request.input.action.input.firstAt, "2030-09-19T16:00:00.000Z");
    assert.throws(
      () => parseToolRequest(raw.replace("2030-09-19T09:00:00-07:00", "tomorrow at nine")),
      (error: Error) =>
        /ytriple_tool\.input\.action\.input\.firstAt/.test(error.message) &&
        !/regex|invalid_format|pattern/i.test(error.message),
    );
  } finally { f.store.close(); }
});
