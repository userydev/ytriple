import { createHash, randomUUID } from "node:crypto";
import type { Store } from "./store";
import type { Material } from "./types";
import {
  feedReadResult,
  type FeedSource,
  type FeedCheck,
  type FeedPreview,
  type FeedSnapshot,
} from "./feed-contract";

type Reader = {
  scope: string;
  readFeed: (url: string, signal?: AbortSignal) => Promise<FeedSnapshot>;
};
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class Feeds {
  private active = new Map<
    string,
    { controller: AbortController; job: Promise<FeedCheck> }
  >();
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    readonly store: Store,
    private reader: () => Reader,
    private changed: () => void = () => {},
    private clock = Date.now,
  ) {}
  async preview(url: string) {
    const reader = this.reader();
    const snapshot = feedReadResult.parse(await reader.readFeed(url));
    const requested = new URL(url);
    requested.hash = "";
    if (snapshot.requested_url !== requested.toString())
      throw Error("服务返回的订阅身份不符");
    const preview: FeedPreview = {
      id: randomUUID(),
      scope: reader.scope,
      expiresAt: new Date(this.clock() + 600000).toISOString(),
      snapshot,
    };
    for (const p of this.store.all<FeedPreview>("feed-preview"))
      if (Date.parse(p.expiresAt) < this.clock())
        this.store.remove("feed-preview", p.id);
    for (const old of this.store.all<FeedPreview>("feed-preview").slice(0, -9))
      this.store.remove("feed-preview", old.id);
    this.store.put("feed-preview", preview.id, preview);
    return preview;
  }
  add(
    previewId: string,
    name: string,
    intervalMinutes: number,
    enabled: boolean,
  ) {
    const p = this.store.require<FeedPreview>("feed-preview", previewId);
    if (this.reader().scope !== p.scope)
      throw Error("服务连接已变化，请重新读取来源");
    const old = this.store
      .all<FeedSource>("feed")
      .find(
        (s) => s.url === p.snapshot.requested_url && s.serviceScope === p.scope,
      );
    if (old) {
      if (old.archived) throw Error("该订阅已停用，请从来源历史恢复");
      return old;
    }
    if (Date.parse(p.expiresAt) < this.clock())
      throw Error("预览已过期，请重新读取");
    this.validate(name, intervalMinutes);
    const source: FeedSource = {
      id: randomUUID(),
      name: name.trim(),
      url: p.snapshot.requested_url,
      revision: 1,
      serviceScope: p.scope,
      enabled,
      intervalMinutes,
      archived: false,
      nextAt: enabled
        ? new Date(this.clock() + intervalMinutes * 60000).toISOString()
        : null,
      lastCheckedAt: null,
      lastSuccessAt: null,
      error: null,
      createdAt: new Date(this.clock()).toISOString(),
    };
    this.store.transaction(() => {
      this.store.put("feed", source.id, source);
      const check = this.newCheck(source, "add");
      this.apply(source, check, p.snapshot);
    });
    this.changed();
    return this.store.require<FeedSource>("feed", source.id);
  }
  private validate(name: string, interval: number) {
    if (!name.trim() || name.trim().length > 120)
      throw Error("来源名称需为 1–120 个字符");
    if (!Number.isInteger(interval) || interval < 30 || interval > 10080)
      throw Error("更新间隔需为 30–10080 分钟");
  }
  update(
    id: string,
    revision: number,
    patch: {
      name: string;
      intervalMinutes: number;
      enabled: boolean;
      archived: boolean;
    },
  ) {
    const source = this.store.require<FeedSource>("feed", id);
    if (source.revision !== revision) throw Error("来源已变化，请重新打开");
    this.validate(patch.name, patch.intervalMinutes);
    if (patch.enabled && this.reader().scope !== source.serviceScope)
      throw Error("请恢复添加订阅时的服务连接");
    const updated = {
      ...source,
      ...patch,
      name: patch.name.trim(),
      revision: revision + 1,
      enabled: patch.enabled && !patch.archived,
      nextAt:
        patch.enabled && !patch.archived
          ? new Date(this.clock() + patch.intervalMinutes * 60000).toISOString()
          : null,
    };
    if (patch.archived) this.stop(id);
    this.store.put("feed", id, updated);
    this.changed();
    return updated;
  }
  private newCheck(
    source: FeedSource,
    trigger: FeedCheck["trigger"],
  ): FeedCheck {
    return {
      id: randomUUID(),
      sourceId: source.id,
      sourceRevision: source.revision,
      trigger,
      startedAt: new Date(this.clock()).toISOString(),
      finishedAt: null,
      status: "running",
      added: 0,
      updated: 0,
      unchanged: 0,
      totalItems: 0,
      omittedItems: 0,
      note: null,
      error: null,
    };
  }
  private apply(source: FeedSource, check: FeedCheck, snapshot: FeedSnapshot) {
    check = { ...check };
    return this.store.transaction(() => {
      const seen = new Set<string>();
      for (const item of snapshot.items) {
        const url = new URL(item.url);
        url.hash = "";
        if (
          !["https:", "http:"].includes(url.protocol) ||
          url.username ||
          url.password
        )
          throw Error("来源条目包含不支持的链接");
        const id = `feed:${source.id}:${digest(url.toString())}`;
        if (seen.has(id)) {
          check.unchanged++;
          continue;
        }
        seen.add(id);
        const previous = this.store
          .all<Material>("material")
          .filter((m) => m.id === id)
          .sort((a, b) => b.version - a.version)[0];
        // Hash locally as well: service timestamps and feed ordering do not create revisions.
        const contentHash = digest({
          title: item.title,
          body: item.text,
          coverage: item.coverage,
          url: url.toString(),
          publishedAt: item.published_at,
          ...(item.image ? { image: item.image } : {}),
        });
        if (previous?.feedSource?.contentHash === contentHash) {
          check.unchanged++;
          continue;
        }
        const material: Material = {
          id,
          version: (previous?.version ?? 0) + 1,
          title: item.title,
          body: item.text,
          coverage: item.coverage,
          url: url.toString(),
          createdAt: new Date(this.clock()).toISOString(),
          feedSource: {
            sourceId: source.id,
            checkId: check.id,
            sourceUrl: source.url,
            resolvedUrl: snapshot.resolved_url,
            contentHash,
            rawHash: snapshot.raw_sha256,
            publishedAt: item.published_at,
            fetchedAt: snapshot.fetched_at,
            publisher: item.publisher,
          },
          ...(item.image
            ? {
                image: {
                  url: item.image.url,
                  origin: item.image.origin,
                  credit: item.image.credit,
                },
              }
            : {}),
        };
        this.store.put("material", `${id}@${material.version}`, material);
        if (previous) check.updated++;
        else check.added++;
      }
      const completed: FeedCheck = {
        ...check,
        finishedAt: new Date(this.clock()).toISOString(),
        status: "succeeded",
        totalItems: snapshot.total_items,
        omittedItems: snapshot.omitted_items,
        note: snapshot.omitted_items
          ? "本次只读取有界条目；部分条目因格式或大小限制未纳入，不代表完整历史。"
          : null,
        snapshotHash: snapshot.raw_sha256,
        resolvedUrl: snapshot.resolved_url,
      };
      this.store.put("feed-check", completed.id, completed);
      const current = this.store.require<FeedSource>("feed", source.id);
      this.store.put("feed", source.id, {
        ...current,
        lastCheckedAt: completed.finishedAt,
        lastSuccessAt: completed.finishedAt,
        error: null,
      });
      return completed;
    });
  }
  refresh(id: string, trigger: "clock" | "manual" = "manual") {
    const active = this.active.get(id);
    if (active) return active.job;
    const source = this.store.require<FeedSource>("feed", id);
    if (source.archived) throw Error("来源已停用，请先恢复");
    const controller = new AbortController(),
      check = this.newCheck(source, trigger);
    this.store.transaction(() => {
      this.store.put("feed-check", check.id, check);
      this.store.put("feed", id, {
        ...source,
        lastCheckedAt: check.startedAt,
        nextAt: source.enabled
          ? new Date(
              this.clock() + source.intervalMinutes * 60000,
            ).toISOString()
          : null,
      });
    });
    const job = (async () => {
      await Promise.resolve();
      try {
        const reader = this.reader();
        if (reader.scope !== source.serviceScope)
          throw Error("服务连接已变化，请恢复原连接后刷新此订阅");
        const snapshot = feedReadResult.parse(
          await reader.readFeed(source.url, controller.signal),
        );
        if (controller.signal.aborted)
          throw new DOMException("已停止更新", "AbortError");
        if (this.reader().scope !== source.serviceScope)
          throw Error("读取期间服务连接改变，未应用此次响应");
        if (snapshot.requested_url !== source.url)
          throw Error("服务返回的订阅身份不符");
        return this.apply(source, check, snapshot);
      } catch (e) {
        const failed: FeedCheck = {
          ...check,
          finishedAt: new Date(this.clock()).toISOString(),
          status: controller.signal.aborted ? "cancelled" : "failed",
          error: e instanceof Error ? e.message : "来源读取失败",
        };
        this.store.put("feed-check", check.id, failed);
        const current = this.store.require<FeedSource>("feed", id);
        this.store.put("feed", id, { ...current, error: failed.error });
        return failed;
      } finally {
        this.active.delete(id);
        this.changed();
      }
    })();
    this.active.set(id, { controller, job });
    this.changed();
    return job;
  }
  stop(id: string) {
    this.active.get(id)?.controller.abort();
  }
  recover() {
    for (const check of this.store.all<FeedCheck>("feed-check"))
      if (check.status === "running") {
        this.store.put("feed-check", check.id, {
          ...check,
          status: "interrupted",
          finishedAt: new Date(this.clock()).toISOString(),
          error: "上次读取被中断，已有材料保留",
        });
        const source = this.store.require<FeedSource>("feed", check.sourceId);
        this.store.put("feed", source.id, {
          ...source,
          error: "上次读取被中断，等待下次检查或手动刷新",
        });
      }
  }
  tick() {
    for (const source of this.store.all<FeedSource>("feed")) {
      if (this.active.size >= 2) break;
      if (
        !source.archived &&
        source.enabled &&
        source.nextAt &&
        Date.parse(source.nextAt) <= this.clock()
      )
        void this.refresh(source.id, "clock");
    }
  }
  start() {
    if (!this.timer) {
      this.tick();
      this.timer = setInterval(() => this.tick(), 30000);
      this.timer.unref();
    }
  }
  async settled() {
    await Promise.all([...this.active.values()].map((a) => a.job));
  }
  shutdown() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const a of this.active.values()) a.controller.abort();
  }
}
