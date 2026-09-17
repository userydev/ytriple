import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../src/core/store";
import { Radar } from "../src/core/radar";
import { RadarWatches } from "../src/core/radar-watches";
import {
  ServiceError,
  type Model,
  type Prompt,
  type StreamEvent,
} from "../src/core/ycore";
import type { RadarTopic, RadarJob } from "../src/core/radar-contract";
import type {
  RadarWatch,
  RadarAutoCheck,
} from "../src/core/radar-watch-contract";

class FixtureModel implements Model {
  scope = "fixture";
  calls = 0;
  fail = false;
  interrupt = false;
  noChange = false;
  output = "";
  gate: Promise<void> | null = null;
  async *stream(
    prompt: Prompt,
    key: string,
    _signal: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    this.calls++;
    if (this.gate) await this.gate;
    if (this.fail) throw Error("fixture provider failed");
    const data = JSON.parse(prompt.messages[1].content);
    this.output = JSON.stringify({
      changed: !this.noChange,
      title: "自动整理测试",
      summary: "测试资料限定下的认识",
      sections: this.noChange
        ? []
        : [
            {
              heading: "证据",
              body: "这是测试，不是实际研究结论",
              sources: data.sources.map((s: any) => s.id),
            },
          ],
      changes: data.previous ? ["补充测试条件"] : [],
      limitations: ["固定测试材料"],
      screening: data.sources.map((s: any) => ({
        source: s.id,
        keep: true,
        reason: "属于议题",
      })),
    });
    if (this.interrupt)
      throw new ServiceError("STREAM_INTERRUPTED", "fixture first event lost");
    yield { type: "run.started", run_id: key };
    yield { type: "text.delta", run_id: key, text: this.output };
    yield { type: "run.completed", run_id: key };
  }
  async lookupByKey(key: string) {
    return {
      id: key,
      status: "succeeded",
      result: { text: this.output },
      error: null,
    };
  }
}
function setup() {
  const store = new Store(":memory:"),
    model = new FixtureModel();
  let timestamp = Date.now();
  const clock = () => timestamp;
  const radar = new Radar(
    store,
    () => model,
    () => {},
    clock,
  );
  const material = store.addMaterial(
    "测试材料",
    "实际材料明确区分计划和实绩。",
    "summary",
  );
  const topic = radar.saveTopic({
    revision: 0,
    title: "持续观察",
    focus: "证据",
    sources: [{ materialId: material.id, policy: "auto", reason: "" }],
  });
  const watches = new RadarWatches(
    store,
    radar,
    () => model.scope,
    () => {},
    clock,
  );
  const config = (enabled = true, limit = 2) =>
    watches.save({
      topicId: topic.id,
      topicRevision: store.require<RadarTopic>("radar-topic", topic.id)
        .revision,
      expectedRevision:
        store.get<RadarWatch>("radar-watch", topic.id)?.revision ?? 0,
      enabled,
      intervalMinutes: 30,
      maxCallsPerDay: limit,
    });
  const update = (v: number) =>
    store.put("material", `${material.id}@${v}`, {
      ...material,
      version: v,
      body: `新的实际测试条件 ${v}`,
    });
  return {
    store,
    model,
    radar,
    topic,
    watches,
    config,
    update,
    clock,
    advance: (ms = 1800001) => {
      timestamp += ms;
    },
    current: () => store.require<RadarWatch>("radar-watch", topic.id),
    checks: () => store.all<RadarAutoCheck>("radar-auto-check"),
  };
}
test("automatic radar freezes input, coalesces checks, skips unchanged and enforces rolling budget across reauthorization", async () => {
  const f = setup();
  try {
    f.config();
    f.watches.tick();
    f.watches.tick();
    await f.watches.settled();
    assert.equal(f.model.calls, 1);
    assert.equal(f.checks()[0].status, "updated");
    const original = f.store.snapshot().radar.editions[0];
    f.advance(8 * 3600000);
    f.watches.tick();
    await f.watches.settled();
    assert.equal(f.checks().length, 2);
    assert.equal(f.checks()[1].status, "unchanged");
    assert.equal(f.checks()[1].modelSubmitted, false);
    assert.equal(f.model.calls, 1);
    f.update(2);
    f.advance();
    f.watches.tick();
    await f.watches.settled();
    assert.equal(f.model.calls, 2);
    assert.equal(original.sources[0].reference.version, 1);
    assert.equal(
      f.store.snapshot().radar.editions[1].sources[0].reference.version,
      2,
    );
    f.update(3);
    f.config(false);
    f.config();
    f.watches.tick();
    await f.watches.settled();
    assert.equal(f.model.calls, 2);
    assert.equal(f.checks().at(-1)?.status, "limited");
    f.advance(86400001);
    f.watches.tick();
    await f.watches.settled();
    assert.equal(f.model.calls, 3);
    assert.equal(f.store.snapshot().works.length, 0);
  } finally {
    f.store.close();
  }
});
test("changed topic or service pauses authorization; stale settings reject and disabled watches never submit", async () => {
  const f = setup();
  try {
    f.config(false);
    f.watches.tick();
    assert.equal(f.model.calls, 0);
    const old = f.config();
    f.model.scope = "other";
    f.watches.tick();
    assert.equal(f.current().enabled, false);
    assert.match(f.current().error!, /服务连接/);
    assert.equal(f.model.calls, 0);
    assert.throws(
      () =>
        f.watches.save({
          topicId: f.topic.id,
          topicRevision: 1,
          expectedRevision: old.revision,
          enabled: true,
          intervalMinutes: 30,
          maxCallsPerDay: 2,
        }),
      /变化/,
    );
    f.config();
    const { updatedAt: _updatedAt, ...input } = f.topic;
    f.radar.saveTopic({ ...input, title: "改变议题" });
    assert.equal(f.current().enabled, false);
    f.watches.tick();
    assert.equal(f.current().enabled, false);
    assert.match(f.current().error!, /议题范围/);
    f.config();
    f.watches.tick();
    await f.watches.settled();
    assert.equal(f.model.calls, 1);
  } finally {
    f.store.close();
  }
});
test("uncertain run is found by original key after recovery and never automatically replayed", async () => {
  const f = setup();
  try {
    f.model.interrupt = true;
    f.config();
    f.watches.tick();
    await f.watches.settled();
    const job = f.store.all<RadarJob>("radar-job")[0];
    assert.equal(job.remoteId, null);
    assert.equal(f.checks()[0].status, "unknown");
    assert.equal(f.current().enabled, false);
    f.radar.recover();
    let notifications = 0;
    const restarted = new RadarWatches(
      f.store,
      f.radar,
      () => f.model.scope,
      () => {
        notifications++;
      },
      f.clock,
    );
    restarted.recover();
    f.advance();
    restarted.tick();
    assert.equal(f.model.calls, 1);
    assert.throws(() => f.config(), /核对/);
    await f.radar.reconcile(job.id);
    const beforeSettle = notifications;
    restarted.tick();
    assert.ok(notifications > beforeSettle);
    const afterSettle = notifications;
    restarted.tick();
    assert.equal(notifications, afterSettle);
    assert.equal(f.checks()[0].status, "updated");
    assert.equal(f.current().enabled, false);
    f.config();
    f.watches.tick();
    await f.watches.settled();
    assert.equal(f.model.calls, 1);
    assert.equal(f.checks().at(-1)?.status, "unchanged");
  } finally {
    f.store.close();
  }
});
test("failed automatic update pauses future work while retaining previous edition and no-change result emits no edition", async () => {
  const f = setup();
  try {
    f.config(true, 5);
    f.watches.tick();
    await f.watches.settled();
    const original = f.store.snapshot().radar.editions[0];
    f.model.noChange = true;
    f.update(2);
    f.advance();
    f.watches.tick();
    await f.watches.settled();
    assert.equal(f.checks().at(-1)?.status, "no_change");
    assert.equal(f.store.snapshot().radar.editions.length, 1);
    f.model.fail = true;
    f.update(3);
    f.advance();
    f.watches.tick();
    await f.watches.settled();
    assert.equal(f.current().enabled, false);
    assert.equal(f.checks().at(-1)?.status, "failed");
    f.advance(86400000);
    f.watches.tick();
    assert.equal(f.model.calls, 3);
    assert.deepEqual(f.store.snapshot().radar.editions[0], original);
  } finally {
    f.store.close();
  }
});
test("interruption before job persistence is visible, pauses the watch and does not claim a submitted model request", () => {
  const f = setup();
  try {
    const w = f.config();
    f.store.put<RadarAutoCheck>("radar-auto-check", "interrupted", {
      id: "interrupted",
      watchId: w.id,
      watchRevision: w.revision,
      topicRevision: 1,
      dueAt: w.nextAt!,
      startedAt: w.nextAt!,
      finishedAt: null,
      status: "checking",
      jobId: null,
      modelSubmitted: false,
      error: null,
    });
    f.watches.recover();
    f.watches.tick();
    assert.equal(f.current().enabled, false);
    assert.equal(f.checks()[0].status, "interrupted");
    assert.equal(f.checks()[0].modelSubmitted, false);
    assert.equal(f.model.calls, 0);
  } finally {
    f.store.close();
  }
});
test("waiting for feed reads and in-flight model work avoids duplicate submissions; pause does not cancel current result", async () => {
  const f = setup();
  try {
    const feedId = randomUUID();
    f.store.put("feed", feedId, {
      id: feedId,
      name: "fixture",
      lastSuccessAt: null,
      enabled: true,
    });
    f.store.put("radar-topic", f.topic.id, { ...f.topic, feedIds: [feedId] });
    f.store.put("feed-check", "pending", {
      id: "pending",
      sourceId: feedId,
      status: "running",
    });
    f.config();
    f.watches.tick();
    assert.equal(f.checks().length, 0);
    f.store.put("feed-check", "pending", {
      id: "pending",
      sourceId: feedId,
      status: "succeeded",
    });
    let release!: () => void;
    f.model.gate = new Promise<void>((r) => {
      release = r;
    });
    f.watches.tick();
    await Promise.resolve();
    f.advance();
    f.watches.tick();
    assert.equal(f.model.calls, 1);
    f.config(false);
    release();
    await f.watches.settled();
    assert.equal(f.current().enabled, false);
    assert.equal(f.checks()[0].status, "updated");
    assert.equal(f.store.snapshot().radar.editions.length, 1);
  } finally {
    f.store.close();
  }
});
