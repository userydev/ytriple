import { createHash } from "node:crypto";
import type { Store } from "./store";
import type { Radar } from "./radar";
import type { RadarJob, RadarTopic, RadarEdition } from "./radar-contract";
import type { FeedCheck } from "./feed-contract";
import {
  radarWatchInput,
  type RadarWatchInput,
  type RadarWatch,
  type RadarAutoCheck,
} from "./radar-watch-contract";

const day = 86400000;
export class RadarWatches {
  private timer?: ReturnType<typeof setInterval>;
  private pending = new Set<Promise<void>>();
  constructor(
    readonly store: Store,
    readonly radar: Radar,
    private scope: () => string | undefined,
    private changed: () => void = () => {},
    private clock = Date.now,
  ) {}

  save(raw: RadarWatchInput) {
    const input = radarWatchInput.parse(raw);
    const topic = this.store.require<RadarTopic>("radar-topic", input.topicId);
    const old = this.store.get<RadarWatch>("radar-watch", input.topicId);
    if (
      (old?.revision ?? 0) !== input.expectedRevision ||
      topic.revision !== input.topicRevision
    )
      throw Error("议题或自动整理设置已变化，请重新打开");
    const scope = this.scope();
    if (input.enabled && !scope) throw Error("先连接模型服务，再启用自动整理");
    if (
      input.enabled &&
      this.store
        .all<RadarJob>("radar-job")
        .some((j) => j.topic.id === topic.id && j.status === "unknown")
    )
      throw Error("先在议题中核对原整理结果，再启用自动整理");
    const value: RadarWatch = {
      id: topic.id,
      revision: (old?.revision ?? 0) + 1,
      topicRevision: topic.revision,
      serviceScope: scope ?? old?.serviceScope ?? "",
      enabled: input.enabled,
      intervalMinutes: input.intervalMinutes,
      maxCallsPerDay: input.maxCallsPerDay,
      nextAt: input.enabled ? new Date(this.clock()).toISOString() : null,
      lastCheckedAt: old?.lastCheckedAt ?? null,
      error: null,
    };
    this.store.put("radar-watch", value.id, value);
    this.changed();
    return value;
  }

  private pause(watch: RadarWatch, message: string) {
    const current = this.store.require<RadarWatch>("radar-watch", watch.id);
    if (current.revision === watch.revision && current.enabled)
      this.store.put("radar-watch", current.id, {
        ...current,
        revision: current.revision + 1,
        enabled: false,
        nextAt: null,
        error: message,
      });
  }

  private settle(check: RadarAutoCheck) {
    if (!["checking", "running", "unknown"].includes(check.status)) return;
    const job = check.jobId
      ? this.store.get<RadarJob>("radar-job", check.jobId)
      : this.store
          .all<RadarJob>("radar-job")
          .find((j) => j.automatic?.checkId === check.id);
    if (!job) return;
    if (job.status === "running") return;
    if (job.status === "unknown" && check.status === "unknown") return;
    const updated: RadarAutoCheck = {
      ...check,
      jobId: job.id,
      modelSubmitted: job.automatic?.checkId === check.id,
      finishedAt: new Date(this.clock()).toISOString(),
      status:
        job.status === "succeeded"
          ? !check.modelSubmitted && job.automatic?.checkId !== check.id
            ? "unchanged"
            : this.store
                  .all<RadarEdition>("radar-edition")
                  .some((e) => e.jobId === job.id)
              ? "updated"
              : "no_change"
          : job.status === "unknown"
            ? "unknown"
            : "failed",
      error: job.error,
    };
    this.store.put("radar-auto-check", check.id, updated);
    if (["failed", "unknown"].includes(updated.status)) {
      const watch = this.store.require<RadarWatch>(
        "radar-watch",
        check.watchId,
      );
      if (watch.revision === check.watchRevision)
        this.pause(
          watch,
          job.error ?? "自动整理未完成，请处理原运行后重新启用",
        );
    }
    this.changed();
  }

  recover() {
    for (const check of this.store.all<RadarAutoCheck>("radar-auto-check")) {
      if (
        ["checking", "running"].includes(check.status) &&
        !this.store
          .all<RadarJob>("radar-job")
          .some(
            (j) => j.id === check.jobId || j.automatic?.checkId === check.id,
          )
      ) {
        this.store.put("radar-auto-check", check.id, {
          ...check,
          status: "interrupted",
          finishedAt: new Date(this.clock()).toISOString(),
          error: "上次检查未能关联原运行；不会自动重试",
        });
        const watch = this.store.require<RadarWatch>(
          "radar-watch",
          check.watchId,
        );
        if (watch.revision === check.watchRevision)
          this.pause(watch, "上次检查被中断，请查看记录后重新启用");
      } else this.settle(check);
    }
  }

  tick() {
    for (const check of this.store.all<RadarAutoCheck>("radar-auto-check"))
      this.settle(check);
    const watches = this.store
      .all<RadarWatch>("radar-watch")
      .filter(
        (w) => w.enabled && w.nextAt && Date.parse(w.nextAt) <= this.clock(),
      )
      .sort((a, b) => a.nextAt!.localeCompare(b.nextAt!));
    for (const watch of watches) {
      if (
        this.store
          .all<RadarJob>("radar-job")
          .filter((j) => j.status === "running").length >= 2
      )
        break;
      const topic = this.store.require<RadarTopic>("radar-topic", watch.id);
      if (
        topic.revision !== watch.topicRevision ||
        this.scope() !== watch.serviceScope
      ) {
        this.pause(
          watch,
          topic.revision !== watch.topicRevision
            ? "议题范围已变化，请重新确认自动整理设置"
            : "服务连接已变化，请重新确认自动整理设置",
        );
        this.changed();
        continue;
      }
      const active = this.store
        .all<RadarJob>("radar-job")
        .find(
          (j) =>
            j.topic.id === watch.id &&
            ["running", "unknown"].includes(j.status),
        );
      if (active) {
        if (active.status === "unknown") {
          this.pause(watch, "原整理结果待核对，自动整理已暂停");
          this.changed();
        }
        continue;
      }
      if (
        this.store
          .all<FeedCheck>("feed-check")
          .some(
            (c) =>
              c.status === "running" && topic.feedIds?.includes(c.sourceId),
          )
      )
        continue;
      this.check(watch);
    }
  }

  private check(watch: RadarWatch) {
    const at = new Date(this.clock()).toISOString();
    const id = createHash("sha256")
      .update(JSON.stringify([watch.id, watch.revision, watch.nextAt]))
      .digest("hex");
    if (this.store.get("radar-auto-check", id)) return;
    let check: RadarAutoCheck = {
      id,
      watchId: watch.id,
      watchRevision: watch.revision,
      topicRevision: watch.topicRevision,
      dueAt: watch.nextAt!,
      startedAt: at,
      finishedAt: null,
      status: "checking",
      jobId: null,
      modelSubmitted: false,
      error: null,
    };
    this.store.transaction(() => {
      this.store.put("radar-auto-check", id, check);
      this.store.put("radar-watch", watch.id, {
        ...watch,
        lastCheckedAt: at,
        nextAt: new Date(
          this.clock() + watch.intervalMinutes * 60000,
        ).toISOString(),
      });
    });
    try {
      const same = this.radar.matchingJob(watch.id);
      const recent = this.store
        .all<RadarJob>("radar-job")
        .filter(
          (j) =>
            j.automatic?.watchId === watch.id &&
            Date.parse(j.createdAt) > this.clock() - day,
        );
      if (!same && recent.length >= watch.maxCallsPerDay) {
        check = {
          ...check,
          status: "limited",
          finishedAt: at,
          error: "滚动 24 小时的自动模型调用已达上限；旧解读保留",
        };
        this.store.put("radar-auto-check", id, check);
        const current = this.store.require<RadarWatch>("radar-watch", watch.id);
        const available =
          Math.min(...recent.map((j) => Date.parse(j.createdAt))) + day + 1;
        this.store.put("radar-watch", watch.id, {
          ...current,
          nextAt: new Date(
            Math.max(available, Date.parse(current.nextAt!)),
          ).toISOString(),
        });
      } else {
        const job = this.radar.refresh(watch.id, false, {
          watchId: watch.id,
          watchRevision: watch.revision,
          checkId: id,
        });
        check = {
          ...check,
          jobId: job.id,
          modelSubmitted: job.automatic?.checkId === id,
          status: "running",
        };
        this.store.put("radar-auto-check", id, check);
        this.settle(check);
        const promise = this.radar
          .settled(job.id)
          .then(() => {
            this.settle(
              this.store.require<RadarAutoCheck>("radar-auto-check", id),
            );
            this.changed();
          })
          .finally(() => this.pending.delete(promise));
        this.pending.add(promise);
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.store.put("radar-auto-check", id, {
        ...check,
        status: "failed",
        error,
        finishedAt: at,
      });
      this.pause(watch, error);
    }
    this.changed();
  }
  start() {
    if (!this.timer) {
      this.tick();
      this.timer = setInterval(() => this.tick(), 30000);
      this.timer.unref();
    }
  }
  shutdown() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  async settled() {
    await Promise.all([...this.pending]);
  }
}
