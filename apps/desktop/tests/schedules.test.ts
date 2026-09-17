import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { Runtime } from "../src/core/runtime";
import { Schedules } from "../src/core/schedules";
import {
  scheduleInput,
  type Schedule,
  type ScheduleInput,
  type ScheduleOccurrence,
} from "../src/core/schedule-contract";
import type { Model } from "../src/core/ycore";
import type { Draft, Run, Work } from "../src/core/types";
import { defaultWorkflow } from "../src/core/types";
import { commandSchema } from "../src/core/commands";

function fixture(path = ":memory:", override?: Model) {
  const store = new Store(path);
  store.initializeConfiguration();
  let now = Date.parse("2026-09-17T12:00:00Z"),
    scope = "server-account-a";
  const calls: string[] = [];
  const model: Model = override ?? {
    scope,
    async *stream(_prompt, key) {
      calls.push(key);
      yield {
        type: "text.delta",
        run_id: key,
        text: "已核对所选材料，未声称读取其他文件。",
      };
      yield { type: "run.completed", run_id: key };
    },
  };
  const runtime = new Runtime(store, () => model);
  const schedules = new Schedules(
    store,
    runtime,
    () => scope,
    () => {},
    () => now,
  );
  const material = store.addMaterial("观测记录", "第一版，只有一条观测。");
  const input: ScheduleInput = {
    id: randomUUID(),
    expectedRevision: 0,
    name: "观测简报",
    workId: null,
    projectId: null,
    text: "比较观测中的新增认识",
    refs: [{ materialId: material.id, version: 1, label: material.title }],
    recipient: null,
    skillKeys: [],
    outputMode: "result",
    firstAt: "2026-09-17T13:00:00.000Z",
    intervalHours: 1,
    timezone: "America/Los_Angeles",
    followLatest: true,
    maxModelCalls: 8,
    enabled: true,
  };
  return {
    store,
    schedules,
    runtime,
    input,
    material,
    calls,
    setTime: (at: string) => {
      now = Date.parse(at);
    },
    setScope: (value: string) => {
      scope = value;
    },
    async close() {
      schedules.shutdown();
      runtime.shutdown();
      for (const w of store.all<Work>("work")) await runtime.settled(w.id);
      store.close();
    },
  };
}
test("clock trigger is atomic and idempotent, follows read material versions, skips equal content and preserves unsent drafts", async () => {
  const f = fixture();
  try {
    const s = f.schedules.save(f.input);
    assert.equal(f.schedules.save(f.input).workId, s.workId);
    f.store.saveDraft({
      id: s.workId,
      text: s.text,
      refs: s.refs,
      recipient: s.recipient,
      projectId: null,
    });
    const draft = f.store.get<Draft>("draft", s.workId);
    f.setTime(s.firstAt);
    f.schedules.tick();
    f.schedules.tick();
    await f.runtime.settled(s.workId);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.store.get<Draft>("draft", s.workId), draft);
    const first = f.store.snapshot().runs[0];
    assert.equal(first.status, "succeeded");
    assert.equal(first.schedule?.revision, 1);
    assert.equal(f.store.snapshot().modelCalls.length, 1);
    f.setTime("2026-09-17T14:00:00Z");
    f.schedules.tick();
    assert.equal(
      f.store.snapshot().scheduleOccurrences.at(-1)?.state,
      "unchanged",
    );
    f.store.put("material", `${f.material.id}@2`, {
      ...f.material,
      version: 2,
    });
    f.setTime("2026-09-17T15:00:00Z");
    f.schedules.tick();
    assert.equal(
      f.store.snapshot().scheduleOccurrences.at(-1)?.state,
      "unchanged",
    );
    f.store.put("material", `${f.material.id}@3`, {
      ...f.material,
      version: 3,
      body: "出现第二个不同观测，尚不能证明因果。",
    });
    f.setTime("2026-09-17T16:00:00Z");
    f.schedules.tick();
    await f.runtime.settled(s.workId);
    assert.equal(f.calls.length, 2);
    assert.equal(f.store.snapshot().works.length, 1);
    assert.equal(f.store.snapshot().runs.at(-1)?.refs[0].version, 3);
    assert.equal(f.store.snapshot().runs[0].refs[0].version, 1);
    const key = randomUUID();
    const manual = f.schedules.runNow(s.id, 1, key);
    assert.equal(f.schedules.runNow(s.id, 1, key).id, manual.id);
    await f.runtime.settled(s.workId);
    assert.equal(f.calls.length, 3);
    assert.equal(f.store.snapshot().versions.length, 3);
  } finally {
    await f.close();
  }
});
test("missed periods have a bounded receipt and never issue catch-up model requests; pause is independent of run-now", async () => {
  const f = fixture();
  try {
    const s = f.schedules.save(f.input);
    f.setTime("2026-09-18T13:30:00Z");
    f.schedules.tick();
    assert.equal(f.store.snapshot().scheduleOccurrences[0].missedCount, 25);
    assert.equal(
      f.store.snapshot().schedules[0].nextAt,
      "2026-09-18T14:00:00.000Z",
    );
    assert.equal(f.calls.length, 0);
    f.schedules.setEnabled(s.id, 1, false);
    f.setTime("2026-09-18T14:00:00Z");
    f.schedules.tick();
    assert.equal(f.store.snapshot().scheduleOccurrences.length, 1);
    f.schedules.runNow(s.id, 1, randomUUID());
    await f.runtime.settled(s.workId);
    assert.equal(f.calls.length, 1);
    assert.equal(f.store.snapshot().schedules[0].enabled, false);
    f.schedules.setEnabled(s.id, 1, true);
    assert.equal(
      f.store.snapshot().schedules[0].nextAt,
      "2026-09-18T15:00:00.000Z",
    );
  } finally {
    await f.close();
  }
});
test("permission/configuration drift blocks unattended calls, revision edits preserve exact historical authorization", async () => {
  const f = fixture();
  try {
    const s = f.schedules.save(f.input);
    f.setScope("server-account-b");
    f.setTime(s.firstAt);
    f.schedules.tick();
    assert.equal(f.calls.length, 0);
    assert.match(f.store.snapshot().schedules[0].issue!, /权限已变化/);
    assert.equal(f.store.snapshot().schedules[0].enabled, false);
    assert.throws(() => f.schedules.setEnabled(s.id, 1, true), /权限已变化/);
    const revision = f.schedules.save({
      ...f.input,
      workId: s.workId,
      expectedRevision: 1,
      firstAt: "2026-09-17T14:00:00.000Z",
    });
    assert.equal(revision.serviceScope, "server-account-b");
    assert.equal(
      f.store.require<Schedule>("schedule-version", `${s.id}@1`).serviceScope,
      "server-account-a",
    );
    assert.throws(() => f.schedules.runNow(s.id, 1, randomUUID()), /已变化/);
  } finally {
    await f.close();
  }
});
test("model-call ceiling applies across team steps; terminal failure is not retried on later triggers", async () => {
  const f = fixture();
  try {
    f.store.selectConfiguration(null, "editorial@1", `${defaultWorkflow.id}@1`);
    const s = f.schedules.save({ ...f.input, maxModelCalls: 2 });
    f.setTime(s.firstAt);
    f.schedules.tick();
    await f.runtime.settled(s.workId);
    assert.equal(f.calls.length, 2);
    assert.equal(f.store.snapshot().runs[0].status, "failed");
    assert.match(f.store.snapshot().runs[0].error!, /次数上限/);
    f.setTime("2026-09-17T14:00:00Z");
    f.schedules.tick();
    assert.equal(f.calls.length, 2);
    assert.equal(f.store.snapshot().schedules[0].enabled, false);
  } finally {
    await f.close();
  }
});
test("unknown remote outcome remains the original run across scheduler restart and repeated manual submission", async () => {
  let attempts = 0;
  const f = fixture(":memory:", {
    scope: "server-account-a",
    async *stream(_p, key) {
      attempts++;
      yield { type: "run.started", run_id: key };
      throw new TypeError("network interrupted");
    },
  });
  try {
    const s = f.schedules.save(f.input),
      key = randomUUID();
    const receipt = f.schedules.runNow(s.id, 1, key);
    await f.runtime.settled(s.workId);
    assert.equal(f.store.snapshot().runs[0].status, "unknown");
    const restarted = new Schedules(
      f.store,
      f.runtime,
      () => "server-account-a",
    );
    assert.equal(restarted.runNow(s.id, 1, key).id, receipt.id);
    assert.equal(restarted.runNow(s.id, 1, randomUUID()).state, "blocked");
    assert.equal(attempts, 1);
    assert.equal(f.store.snapshot().runs.length, 1);
  } finally {
    await f.close();
  }
});
test("stop only targets the selected occurrence; paused future triggers never cancel an active request", async () => {
  let release: (() => void) | undefined;
  const f = fixture(":memory:", {
    scope: "server-account-a",
    async *stream(_p, key, signal) {
      yield { type: "run.started", run_id: key };
      await new Promise<void>((resolve) => {
        release = resolve;
        signal.addEventListener("abort", resolve.bind(null, undefined), {
          once: true,
        });
      });
      if (signal.aborted) throw new DOMException("stopped", "AbortError");
      yield { type: "text.delta", run_id: key, text: "result" };
      yield { type: "run.completed", run_id: key };
    },
  });
  try {
    const s = f.schedules.save(f.input);
    const occurrence = f.schedules.runNow(s.id, 1, randomUUID());
    await new Promise((resolve) => setImmediate(resolve));
    f.schedules.setEnabled(s.id, 1, false);
    assert.equal(
      f.store.require<Run>("run", occurrence.runId!).status,
      "running",
    );
    f.schedules.stopOccurrence(occurrence.id);
    await f.runtime.settled(s.workId);
    assert.equal(
      f.store.require<Run>("run", occurrence.runId!).status,
      "cancelled",
    );
    f.store.pauseQueue(s.workId, false);
    const another = f.runtime.submit({
      key: randomUUID(),
      context: s.workId,
      text: "manual work",
      refs: [],
      recipient: null,
      projectId: null,
    });
    await new Promise((resolve) => setImmediate(resolve));
    f.schedules.stopOccurrence(occurrence.id);
    assert.equal(f.store.require<Run>("run", another.id).status, "running");
    release!();
    await f.runtime.settled(s.workId);
  } finally {
    release?.();
    await f.close();
  }
});
test("restart after durable queue commit keeps the exact occurrence and never resubmits it automatically", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ytriple-schedules-"));
  const f = fixture(join(dir, "workbench.sqlite"));
  let s: Schedule, receipt: ScheduleOccurrence;
  try {
    s = f.schedules.save(f.input);
    const stalled = new Schedules(
      f.store,
      { startQueued() {}, stop() {} },
      () => "server-account-a",
    );
    receipt = stalled.runNow(s.id, 1, "persisted-key");
  } finally {
    await f.close();
  }
  const reopened = fixture(join(dir, "workbench.sqlite"));
  try {
    reopened.store.recover();
    assert.equal(
      reopened.schedules.runNow(s!.id, 1, "persisted-key").runId,
      receipt!.runId,
    );
    assert.equal(reopened.calls.length, 0);
    assert.equal(reopened.store.snapshot().runs.length, 1);
    assert.equal(reopened.store.snapshot().works[0].queuePaused, true);
    reopened.runtime.resume(s!.workId);
    await reopened.runtime.settled(s!.workId);
    assert.equal(reopened.calls.length, 1);
    assert.equal(reopened.store.snapshot().runs.length, 1);
  } finally {
    await reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("invalid scope/material and nested failures roll back new work and partial submission", async () => {
  const f = fixture();
  try {
    assert.throws(
      () =>
        f.schedules.save({
          ...f.input,
          followLatest: true,
          refs: [{ ...f.input.refs[0], excerpt: "第一版" }],
        }),
      /选段/,
    );
    assert.throws(
      () => f.schedules.save({ ...f.input, recipient: "missing-member" }),
      /负责人/,
    );
    assert.equal(f.store.snapshot().works.length, 0);
    const s = f.schedules.save(f.input);
    const submit = f.store.submit.bind(f.store);
    f.store.submit = (...args) =>
      f.store.transaction(() => {
        submit(...args);
        throw Error("after submit failure");
      });
    const receipt = f.schedules.runNow(s.id, 1, randomUUID());
    assert.equal(receipt.state, "blocked");
    assert.equal(f.store.snapshot().runs.length, 0);
    assert.equal(f.store.snapshot().messages.length, 0);
    assert.equal(f.calls.length, 0);
    assert.equal(
      scheduleInput.safeParse({ ...f.input, timezone: "not/a/timezone" })
        .success,
      false,
    );
    assert.equal(
      commandSchema.safeParse({
        type: "schedule-now",
        id: s.id,
        revision: 1,
        key: "bad",
      }).success,
      false,
    );
  } finally {
    await f.close();
  }
});

test("archive/complete pause associated future triggers and restoration never silently reauthorizes them", async () => {
  const f = fixture();
  try {
    const s = f.schedules.save(f.input);
    f.store.setWorkState(s.workId, "archive");
    assert.equal(f.store.snapshot().schedules[0].enabled, false);
    assert.equal(f.store.snapshot().schedules[0].issue, null);
    assert.throws(() => f.schedules.setEnabled(s.id, 1, true), /恢复原工作/);
    f.store.setWorkState(s.workId, "restore");
    assert.equal(f.store.snapshot().schedules[0].enabled, false);
    f.schedules.setEnabled(s.id, 1, true);
    f.store.setWorkState(s.workId, "complete");
    assert.equal(f.store.snapshot().schedules[0].enabled, false);
    f.setTime(s.firstAt);
    f.schedules.tick();
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test("remote reconciliation updates usage confirmation and resumes the same charged step without replay", async () => {
  let attempts = 0;
  const f = fixture(":memory:", {
    scope: "server-account-a",
    async *stream(_p, key) {
      attempts++;
      yield { type: "run.started", run_id: key };
      throw new TypeError("interrupted");
    },
    async lookup() {
      return {
        status: "succeeded",
        result: { text: "真实远端终态正文" },
        error: null,
      };
    },
  });
  try {
    const s = f.schedules.save(f.input),
      receipt = f.schedules.runNow(s.id, 1, randomUUID());
    await f.runtime.settled(s.workId);
    assert.equal(f.store.snapshot().modelCalls[0].state, "attempted");
    await f.runtime.reconcile(receipt.runId!);
    assert.equal(f.store.snapshot().modelCalls[0].state, "completed");
    f.runtime.resume(s.workId);
    await f.runtime.settled(s.workId);
    assert.equal(f.store.snapshot().runs[0].status, "succeeded");
    assert.equal(attempts, 1);
    assert.equal(f.store.snapshot().versions[0].body, "真实远端终态正文");
  } finally {
    await f.close();
  }
});
