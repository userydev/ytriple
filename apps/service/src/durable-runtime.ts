import { Runtime } from "../../desktop/src/core/runtime.ts";
import type { Store } from "../../desktop/src/core/store.ts";
import type { Model } from "../../desktop/src/core/ycore.ts";
import type { SubmitInput, Work } from "../../desktop/src/core/types.ts";
import type { Identity } from "./auth.ts";
import { ExecutionLeases, type Lease } from "./execution-lease.ts";
import { hydrate } from "./workspaces.ts";

// Internal execution host, deliberately not an HTTP submit endpoint. Its model must
// eventually carry a revocable background grant, never the desktop refresh token.
export class DurableRuntime {
  readonly runtime: Runtime;
  private generation = 0;
  private persisted = 0;
  private pending: Promise<void> | null = null;
  private failure: Error | null = null;
  private closing = false;
  private closingTask: Promise<void> | undefined;
  private stopped = new AbortController();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private renewing = false;
  private constructor(
    readonly leases: ExecutionLeases,
    readonly lease: Lease,
    readonly store: Store,
    private revision: number,
    model: Model,
  ) {
    const host = this;
    const guarded: Model = {
      scope: model.scope,
      recovery: "remote",
      identity: model.identity,
      lookup: model.lookup
        ? async (id) => {
            await host.barrier();
            return model.lookup!(id);
          }
        : undefined,
      lookupByKey: async (key) => {
        await host.barrier();
        return model.lookupByKey!(key);
      },
      async *stream(prompt, key, signal) {
        // Commit submission, contribution identity and earlier tool outcomes before
        // any provider can observe this request. Failure here makes zero new calls.
        await host.barrier();
        const combined = AbortSignal.any([signal, host.stopped.signal]);
        combined.throwIfAborted();
        for await (const event of model.stream(prompt, key, combined)) {
          host.assertLive();
          combined.throwIfAborted();
          yield event;
          // The shared Runtime has consumed the event and notified changed().
          await host.flush();
        }
      },
    };
    this.runtime = new Runtime(
      store,
      () => guarded,
      () => this.changed(),
    );
  }
  static async open(
    leases: ExecutionLeases,
    identity: Identity,
    workspaceId: string,
    model: Model,
  ) {
    if (!model.scope || model.recovery === "local" || !model.lookupByKey)
      throw Error(
        "Remote execution requires a stable model scope and lookup by original key",
      );
    const acquired = await leases.acquire(identity, workspaceId);
    let store: Store | undefined;
    try {
      store = hydrate(acquired.state);
      const host = new DurableRuntime(
        leases,
        acquired.lease,
        store,
        acquired.revision,
        model,
      );
      // Restored active work is uncertain, queued work is paused. Acquiring a lease
      // never means replaying a paid call or silently starting an old queue.
      store.recover();
      host.changed();
      await host.flush();
      host.heartbeat = setInterval(() => {
        void host.renew();
      }, 10000);
      host.heartbeat.unref();
      return host;
    } catch (error) {
      store?.close();
      await leases.release(acquired.lease).catch(() => {});
      throw error;
    }
  }
  private assertLive() {
    if (this.failure) throw this.failure;
    if (this.closing) throw Error("Execution host is closing");
  }
  private fail(error: unknown) {
    if (this.failure) return;
    this.failure =
      error instanceof Error ? error : Error("Execution persistence failed");
    this.stopped.abort();
    this.runtime.shutdown();
    if (this.heartbeat) clearInterval(this.heartbeat);
  }
  private async renew() {
    if (this.renewing || this.closing || this.failure) return;
    this.renewing = true;
    try {
      await this.leases.renew(this.lease);
    } catch (error) {
      this.fail(error);
    } finally {
      this.renewing = false;
    }
  }
  private changed() {
    if (this.failure) return;
    this.generation++;
    this.persist();
  }
  private persist() {
    if (this.pending || this.failure) return;
    this.pending = Promise.resolve()
      .then(async () => {
        while (this.persisted < this.generation && !this.failure) {
          const generation = this.generation;
          this.revision = await this.leases.checkpoint(
            this.lease,
            this.revision,
            this.store,
          );
          this.persisted = generation;
        }
      })
      .catch((error) => this.fail(error))
      .finally(() => {
        this.pending = null;
        if (!this.failure && this.persisted < this.generation) this.persist();
      });
  }
  async flush() {
    while (this.pending) await this.pending;
    if (this.failure) throw this.failure;
  }
  private async barrier() {
    this.assertLive();
    // Some domain internals record input/tool metadata without another UI change
    // notification. Snapshot at the external boundary regardless of notifications.
    this.changed();
    await this.flush();
    try {
      await this.leases.renew(this.lease);
    } catch (error) {
      this.fail(error);
      throw error;
    }
    this.assertLive();
  }
  async submit(input: SubmitInput) {
    this.assertLive();
    const run = this.runtime.submit(input);
    await this.flush();
    return run;
  }
  async settled(workId: string) {
    await this.runtime.settled(workId);
    await this.flush();
  }
  async reconcile(runId: string) {
    this.assertLive();
    await this.runtime.reconcile(runId);
    await this.flush();
  }
  async answerDecision(input: Parameters<Runtime["answerDecision"]>[0]) {
    this.assertLive();
    const run = this.runtime.answerDecision(input);
    await this.flush();
    return run;
  }
  async resume(workId: string) {
    this.assertLive();
    this.runtime.resume(workId);
    await this.flush();
  }
  async stop(workId: string) {
    this.assertLive();
    this.runtime.stop(workId);
    await this.flush();
  }
  close() {
    return (this.closingTask ??= this.closeHost());
  }
  private async closeHost() {
    this.closing = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.stopped.abort();
    this.runtime.shutdown();
    this.changed();
    // Keep the in-memory store alive until all model callbacks have exited.
    const works = this.store.all<Work>("work");
    await Promise.all(works.map((work) => this.runtime.settled(work.id)));
    try {
      await this.flush();
    } finally {
      await this.leases.release(this.lease).catch(() => {});
      this.store.close();
    }
  }
}
