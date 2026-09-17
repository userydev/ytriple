import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Store } from "../src/core/store";
import { Feeds } from "../src/core/feeds";
import { Radar } from "../src/core/radar";
import type { FeedSnapshot, FeedCheck } from "../src/core/feed-contract";
import type { Prompt, Model } from "../src/core/ycore";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const snapshot = (body = "第一条观测", count = 1): FeedSnapshot => ({
  kind: "feed",
  title: "观测订阅",
  requested_url: "https://example.org/feed",
  resolved_url: "https://example.org/feed",
  fetched_at: "2026-09-17T12:00:00.000Z",
  raw_sha256: sha(body),
  total_items: count,
  omitted_items: 0,
  limit_reason: null,
  items: Array.from({ length: count }, (_, i) => ({
    url: `https://example.org/${i}`,
    upstream_id: String(i),
    title: `观测 ${i}`,
    text: body + i,
    coverage: "summary",
    full_article: false,
    published_at: new Date(
      Date.parse("2026-09-17T00:00:00Z") + i * 60000,
    ).toISOString(),
    publisher: "Fixture",
    content_hash: sha(body + i),
  })),
});
function fixture() {
  const store = new Store(":memory:");
  let response = snapshot(),
    now = Date.parse("2026-09-17T12:00:00Z"),
    scope = "original";
  let failure = false,
    calls = 0;
  const feeds = new Feeds(
    store,
    () => ({
      scope,
      readFeed: async () => {
        calls++;
        if (failure) throw Error("来源不可达");
        return response;
      },
    }),
    () => {},
    () => now,
  );
  return {
    store,
    feeds,
    calls: () => calls,
    set: (value: FeedSnapshot) => {
      response = value;
    },
    fail: () => {
      failure = true;
    },
    scope: (value: string) => {
      scope = value;
    },
    advance: (minutes: number) => {
      now += minutes * 60000;
    },
    async close() {
      feeds.shutdown();
      await feeds.settled();
      store.close();
    },
  };
}
test("preview never imports or invokes a model; add is idempotent and refresh preserves old versions while skipping equal content", async () => {
  const f = fixture();
  try {
    const preview = await f.feeds.preview("https://example.org/feed");
    assert.equal(f.store.snapshot().materials.length, 0);
    const source = f.feeds.add(preview.id, "观测", 30, true);
    assert.equal(f.feeds.add(preview.id, "观测", 30, true).id, source.id);
    assert.equal(f.store.snapshot().feeds.length, 1);
    assert.equal(f.store.snapshot().materials.length, 1);
    const first = f.store.snapshot().materials[0];
    f.set({ ...snapshot(), fetched_at: "2026-09-17T12:30:00.000Z" });
    const same = await f.feeds.refresh(source.id);
    assert.equal(same.unchanged, 1);
    assert.equal(same.updated, 0);
    assert.deepEqual(f.store.snapshot().materials[0], first);
    f.set(snapshot("第二条观测"));
    const changed = await f.feeds.refresh(source.id);
    assert.equal(changed.updated, 1);
    assert.equal(changed.added, 0);
    assert.equal(f.store.snapshot().materials[1].id, first.id);
    assert.equal(f.store.snapshot().materials[1].version, 2);
    assert.equal(f.store.snapshot().runs.length, 0);
    assert.equal(f.store.snapshot().radar.jobs.length, 0);
  } finally {
    await f.close();
  }
});
test("automatic checks coalesce missed periods, reentrant refresh joins one request, pause/archive preserve materials", async () => {
  const f = fixture();
  try {
    const p = await f.feeds.preview("https://example.org/feed"),
      s = f.feeds.add(p.id, "观测", 30, true);
    f.advance(5000);
    f.feeds.tick();
    f.feeds.tick();
    await f.feeds.settled();
    assert.equal(f.calls(), 2);
    assert.equal(f.store.snapshot().feedChecks.length, 2);
    assert.equal(f.store.snapshot().feedChecks[1].trigger, "clock");
    const first = f.feeds.refresh(s.id),
      second = f.feeds.refresh(s.id);
    assert.equal(first, second);
    await first;
    const paused = f.feeds.update(s.id, 1, {
      name: s.name,
      intervalMinutes: 30,
      enabled: false,
      archived: false,
    });
    f.advance(1000);
    f.feeds.tick();
    await f.feeds.settled();
    assert.equal(f.calls(), 3);
    f.feeds.update(s.id, paused.revision, {
      name: s.name,
      intervalMinutes: 30,
      enabled: false,
      archived: true,
    });
    assert.throws(() => f.feeds.refresh(s.id), /停用/);
    assert.equal(f.store.snapshot().materials.length, 1);
    assert.throws(
      () =>
        f.feeds.update(s.id, 1, {
          name: s.name,
          intervalMinutes: 30,
          enabled: true,
          archived: false,
        }),
      /已变化/,
    );
  } finally {
    await f.close();
  }
});
test("failed/invalid refresh and account drift retain exact materials and last successful observation", async () => {
  const f = fixture();
  try {
    const p = await f.feeds.preview("https://example.org/feed"),
      s = f.feeds.add(p.id, "观测", 60, true);
    const previous = f.store.snapshot().materials;
    f.fail();
    f.advance(60);
    f.feeds.tick();
    await f.feeds.settled();
    assert.equal(f.store.snapshot().feedChecks.at(-1)?.status, "failed");
    assert.equal(f.store.snapshot().feeds[0].lastSuccessAt, s.lastSuccessAt);
    assert.deepEqual(f.store.snapshot().materials, previous);
    f.scope("different-account");
    const calls = f.calls();
    assert.match((await f.feeds.refresh(s.id)).error!, /连接已变化/);
    assert.equal(f.calls(), calls);
    assert.throws(() => f.feeds.add(p.id, "观测", 60, true), /连接已变化/);
  } finally {
    await f.close();
  }
});
test("stop discards a late response and startup makes interrupted observations explicit without fabricating new material", async () => {
  const store = new Store(":memory:");
  let release!: () => void;
  const feeds = new Feeds(store, () => ({
    scope: "test",
    readFeed: async (_url, signal) => {
      if (!signal) return snapshot();
      await new Promise<void>((r) => {
        release = r;
      });
      return snapshot("late");
    },
  }));
  try {
    const p = await feeds.preview("https://example.org/feed"),
      s = feeds.add(p.id, "test", 30, true);
    const job = feeds.refresh(s.id);
    await Promise.resolve();
    feeds.stop(s.id);
    release();
    assert.equal((await job).status, "cancelled");
    assert.equal(store.snapshot().materials.length, 1);
    const old = store.snapshot().feedChecks.at(-1)!;
    store.put<FeedCheck>("feed-check", old.id, {
      ...old,
      status: "running",
      finishedAt: null,
    });
    feeds.recover();
    assert.equal(store.snapshot().feedChecks.at(-1)?.status, "interrupted");
    assert.match(store.snapshot().feeds[0].error!, /中断/);
  } finally {
    feeds.shutdown();
    await feeds.settled();
    store.close();
  }
});
test("feed response is atomic and cannot partially replace materials or report rolled-back import counts", async () => {
  const f = fixture();
  try {
    const p = await f.feeds.preview("https://example.org/feed"),
      s = f.feeds.add(p.id, "test", 30, false);
    const invalid = snapshot("changed", 2);
    invalid.items[1].url = "file:///private";
    f.set(invalid);
    const failed = await f.feeds.refresh(s.id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.added, 0);
    assert.equal(failed.updated, 0);
    assert.equal(f.store.snapshot().materials.length, 1);
    assert.match(f.store.snapshot().materials[0].body, /第一条/);
  } finally {
    await f.close();
  }
});
test("subscribed topics choose bounded recent read articles, incorporate real changes and retain the old editorial source snapshots", async () => {
  const f = fixture();
  const prompts: Prompt[] = [];
  const model: Model = {
    scope: "original",
    async *stream(prompt, key) {
      prompts.push(prompt);
      yield {
        type: "text.delta",
        run_id: key,
        text: JSON.stringify({
          changed: true,
          title: "观测解读",
          summary: "只依据订阅节选",
          sections: [
            { heading: "变化", body: "当前样例尚待核对", sources: ["S1"] },
          ],
          changes: ["本轮变化"],
          limitations: ["只覆盖已读取样例"],
          screening: [
            { source: "S1", keep: true, reason: "相关" },
            { source: "S2", keep: true, reason: "相关" },
          ],
        }),
      };
      yield { type: "run.completed", run_id: key };
    },
  };
  const radar = new Radar(f.store, () => model);
  try {
    f.set(snapshot("材料正文", 5));
    const p = await f.feeds.preview("https://example.org/feed"),
      s = f.feeds.add(p.id, "观测", 60, true);
    const topic = radar.saveTopic({
      revision: 0,
      title: "订阅变化",
      focus: "保留未知",
      sources: [],
      feedIds: [s.id],
      feedLimit: 2,
    });
    const job = radar.refresh(topic.id);
    await radar.settled(job.id);
    assert.equal(job.sources.length, 2);
    assert.equal(job.supply?.omitted, 3);
    assert.match(job.sources[0].title, /4/);
    assert.equal(job.sources[0].reference.version, 1);
    const previous = f.store.snapshot().radar.editions[0];
    assert.ok(previous);
    f.set(snapshot("材料变化", 6));
    await f.feeds.refresh(s.id);
    assert.equal(f.store.snapshot().radar.jobs.length, 1);
    const next = radar.refresh(topic.id);
    await radar.settled(next.id);
    assert.equal(next.sources.length, 2);
    assert.match(next.sources[0].title, /5/);
    assert.equal(next.sources[1].reference.version, 2);
    assert.deepEqual(f.store.snapshot().radar.editions[0], previous);
    assert.equal(radar.refresh(topic.id).id, next.id);
    assert.equal(prompts.length, 2);
    assert.equal(JSON.parse(prompts[1].messages[1].content).supply.omitted, 4);
  } finally {
    radar.shutdown();
    await f.close();
  }
});
