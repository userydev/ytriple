import { delegationKey, isDelegationId } from "./delegation";
import { executeAgentRun } from "./agent-executor";
import { resultKind } from "./output";
import { Decisions } from "./decisions";
import { Store } from "./store";
import {
  isUncertainExecution,
  ServiceError,
  type Model,
} from "./ycore";
import type {
  ArtifactVersion,
  Contribution,
  Decision,
  Run,
  SubmitInput,
  Work,
} from "./types";
import type { ModelCall } from "./schedule-contract";
import { createHash } from "node:crypto";
import type { WorkspaceActions } from "./workspace-actions";
import { resolveRunContext } from "./workspace-exchange";
import { attachPublicProcessToContribution } from "./team-response";
import { DEFAULT_KERNEL, type KernelReference } from "./agent-kernel-contract";
export class Runtime {
  private active = new Map<string, AbortController>();
  private jobs = new Map<string, Promise<void>>();
  private readonly kernelReference: Readonly<KernelReference>;
  constructor(
    readonly store: Store,
    private model: () => Model,
    private changed: () => void = () => {},
    private workspaceActions?: WorkspaceActions,
    kernelReference: KernelReference = DEFAULT_KERNEL,
  ) { this.kernelReference = Object.freeze({ ...kernelReference }); }
  submit(input: SubmitInput) {
    const model = this.model();
    const submitted = this.store.submit(input, model.scope, this.kernelReference);
    const run = submitted.recovery
      ? submitted
      : this.store.setRun(submitted.id, {
          recovery: model.recovery ?? "remote",
          modelIdentity: model.identity,
        });
    this.changed();
    this.pump(run.workId);
    return run;
  }
  startQueued(workId: string) {
    this.pump(workId);
  }
  private boundedModel(run: Run, model: Model): Model {
    if (!run.schedule) return model;
    const store = this.store,
      changed = this.changed;
    return {
      scope: model.scope,
      recovery: model.recovery,
      identity: model.identity,
      lookup: model.lookup?.bind(model),
      lookupByKey: model.lookupByKey?.bind(model),
      async *stream(prompt, key, signal) {
        const id = createHash("sha256")
          .update(`${run.id}:${key}`)
          .digest("hex");
        if (store.get("model-call", id))
          throw new ServiceError(
            "RUN_ALREADY_EXISTS",
            "本次模型请求已有提交记录，请核对原运行",
          );
        if (
          store.all<ModelCall>("model-call").filter((c) => c.runId === run.id)
            .length >= run.schedule!.maxModelCalls
        )
          throw Error(
            "本次运行已达到模型请求次数上限，已保留过程；需调整限制后再委托",
          );
        const call: ModelCall = {
          id,
          runId: run.id,
          key,
          createdAt: new Date().toISOString(),
          state: "attempted",
        };
        store.put("model-call", id, call);
        changed();
        for await (const event of model.stream(prompt, key, signal)) {
          call.remoteId = event.run_id;
          if (event.type === "run.completed") call.state = "completed";
          if (
            event.type === "run.failed" &&
            !isUncertainExecution(event.error?.code)
          )
            call.state = "failed";
          store.put("model-call", id, call);
          yield event;
        }
      },
    };
  }
  answerDecision(input: Parameters<Decisions["answer"]>[0]) {
    const decision = this.store.require<Decision>("decision", input.decisionId);
    this.checkProvider(
      this.store.require<Run>("run", decision.runId),
      this.model(),
    );
    const run = new Decisions(this.store).answer(input);
    this.changed();
    if (run.status === "queued") this.pump(run.workId);
    return run;
  }
  assertCanChangeProvider(scope: string) {
    if (
      this.store
        .all<Run>("run")
        .some(
          (r) =>
            ["running", "queued", "waiting", "unknown"].includes(r.status) &&
            r.serviceScope !== scope,
        )
    )
      throw Error("仍有原服务的未结束运行；请先停止、核对或撤回，再切换服务");
  }
  private checkProvider(run: Run, model: Model) {
    if (run.serviceScope && run.serviceScope !== model.scope)
      throw Error("该运行属于另一服务连接，请恢复原连接后接续");
  }
  async settled(workId: string) {
    await this.jobs.get(workId);
  }
  resume(workId: string) {
    if (
      this.store
        .all<Run>("run")
        .some((r) => r.workId === workId && r.status === "waiting")
    )
      throw Error("先回答原待决或停止该轮，再继续待发");
    if (
      this.store
        .all<Run>("run")
        .some((r) => r.workId === workId && r.status === "unknown")
    )
      throw Error("先核对中断运行的服务状态，再继续待发补充");
    if (
      this.store
        .all<Run>("run")
        .some(
          (r) => r.workId === workId && r.status === "queued" && r.queueDraft,
        )
    )
      throw Error("先保存或放弃待发编辑，再继续队列");
    const model = this.model();
    for (const run of this.store
      .all<Run>("run")
      .filter((r) => r.workId === workId && r.status === "queued"))
      this.checkProvider(run, model);
    this.store.pauseQueue(workId, false);
    this.pump(workId);
    this.changed();
  }
  stop(workId: string) {
    this.store.pauseQueue(workId, true);
    this.active.get(workId)?.abort();
    new Decisions(this.store).cancel(workId);
    for (const r of this.store.all<Run>("run"))
      if (r.workId === workId && r.status === "queued" && r.resumeRequested)
        this.store.setRun(r.id, {
          status: "cancelled",
          resumeRequested: false,
        });
    this.changed();
  }
  shutdown() {
    const pending = new Set(
      this.store
        .all<Run>("run")
        .filter((r) => r.status === "running" || r.status === "queued")
        .map((r) => r.workId),
    );
    for (const workId of pending) {
      this.store.pauseQueue(workId, true);
      this.active.get(workId)?.abort();
      for (const r of this.store.all<Run>("run"))
        if (r.workId === workId && r.status === "queued")
          this.store.setRun(r.id, { resumeRequested: false });
    }
  }
  abandonLocal(runId: string) {
    const run = this.store.require<Run>("run", runId);
    if (run.status !== "unknown" || run.recovery !== "local")
      throw Error("仅可结束待核对直连运行的本地等待");
    if (this.active.has(run.workId))
      throw Error("本地请求仍在退出，请稍后再试");
    const calls = this.store
      .all<import("./model-contract").DirectCall>("direct-call")
      .filter(
        (c) =>
          c.scope === run.serviceScope &&
          (c.key.startsWith(run.id + "-") ||
            c.key.startsWith(run.id + ":") ||
            c.key.startsWith("delegation-" + run.id + "-")),
      );
    const unknown = this.store
      .all<Contribution>("contribution")
      .filter((c) => c.runId === runId && c.status === "unknown");
    if (
      unknown.some(
        (c) =>
          c.remoteId &&
          this.store.get<import("./model-contract").DirectCall>(
            "direct-call",
            c.remoteId,
          )?.status === "succeeded",
      )
    )
      throw Error("本地已有完整结果，请先核对原运行");
    if (!calls.length) throw Error("缺少本地直连提交证据，保留原记录");
    this.store.setRun(runId, {
      status: "cancelled",
      abandonedAt: new Date().toISOString(),
      error: "已结束本地等待；远端结果及用量仍未知，未取消或重新发送远端请求",
    });
    this.store.pauseQueue(run.workId, true);
    this.changed();
  }
  async reconcile(runId: string) {
    const run = this.store.require<Run>("run", runId);
    if (run.status !== "unknown") throw Error("该运行不需要状态核对");
    const records = this.store
      .all<Contribution>("contribution")
      .filter((c) => c.runId === runId);
    const contribution =
      records.filter((c) => c.status === "unknown").at(-1) ?? records.at(-1);
    const model = this.model();
    this.checkProvider(run, model);
    if (!contribution)
      throw Error("尚无可查询的服务提交；保留原记录，不能自动重试");
    const stage = contribution.id.slice(run.id.length + 1);
    if (
      !contribution.id.startsWith(run.id + ":") ||
      (!/^\d+(?::\d+)?$/.test(stage) &&
        !(contribution.task && isDelegationId(run.id, contribution.id)))
    )
      throw Error("原提交标识不完整，不能查询其他运行");
    if (contribution.remoteId ? !model.lookup : !model.lookupByKey)
      throw Error("当前服务不支持找回原提交，请保留记录并检查服务版本");
    const remote = contribution.remoteId
      ? await model.lookup!(contribution.remoteId)
      : await model.lookupByKey!(
          contribution.remoteKey ??
            (contribution.task
              ? delegationKey(contribution.id)
              : `${run.id}-${stage.replace(":", "-answer-")}`),
        );
    if (this.store.require<Run>("run", runId).status !== "unknown") return;
    if (
      !contribution.remoteId &&
      "id" in remote &&
      typeof remote.id === "string"
    ) {
      contribution.remoteId = remote.id;
      this.store.put("contribution", contribution.id, contribution);
    }
    if (["queued", "running", "unknown"].includes(remote.status))
      throw Error("服务尚未给出可确认的终态，请稍后核对");
    if (remote.status === "succeeded") {
      const result = remote.result as { text?: unknown } | null;
      if (typeof result?.text !== "string" || !result.text.trim())
        throw Error("已完成的服务记录缺少正文");
      this.store.put("contribution", contribution.id, {
        ...contribution,
        body: result.text,
        status: "succeeded",
        error: null,
      });
      // Resume only after an explicit user action, skipping the already paid stage.
      this.store.setRun(runId, { status: "queued", error: null });
    } else if (remote.status === "failed" || remote.status === "cancelled") {
      this.store.put("contribution", contribution.id, {
        ...contribution,
        status: remote.status,
        error: remote.error?.message ?? null,
      });
      this.store.setRun(runId, {
        status:
          remote.status === "failed" && contribution.task?.parentId
            ? "queued"
            : remote.status,
        error: remote.error?.message ?? null,
      });
    } else throw Error("无法识别服务运行状态");
    if (run.schedule) {
      const key =
        contribution.remoteKey ??
        (contribution.task
          ? delegationKey(contribution.id)
          : `${run.id}-${stage.replace(":", "-answer-")}`);
      const call = this.store
        .all<ModelCall>("model-call")
        .find((c) => c.runId === run.id && c.key === key);
      if (call)
        this.store.put<ModelCall>("model-call", call.id, {
          ...call,
          remoteId: contribution.remoteId ?? call.remoteId,
          state:
            remote.status === "succeeded"
              ? "completed"
              : (remote.status as "failed" | "cancelled"),
        });
    }
    this.store.pauseQueue(run.workId, true);
    this.changed();
  }
  private pump(workId: string) {
    if (this.jobs.has(workId)) return;
    const job = this.drain(workId).finally(() => {
      this.jobs.delete(workId);
      this.active.delete(workId);
      this.changed();
    });
    this.jobs.set(workId, job);
  }
  private async drain(workId: string) {
    // Defer to let pump register this job before the first model request.
    await Promise.resolve();
    while (true) {
      const work = this.store.require<Work>("work", workId);
      const runs = this.store
        .all<Run>("run")
        .filter((r) => r.workId === workId);
      if (runs.some((r) => r.status === "waiting" || r.status === "unknown"))
        return;
      const requested = runs.find(
        (r) => r.status === "queued" && r.resumeRequested,
      );
      if (work.queuePaused && !requested) return;
      const next = requested ?? runs.find((r) => r.status === "queued");
      if (!next || next.queueDraft) return;
      const latest = this.store
        .all<ArtifactVersion>("version")
        .filter(
          (v) =>
            v.workId === workId &&
            (v.kind ?? "result") === resultKind(next.outputMode),
        )
        .at(-1);
      const resuming = this.store
        .all<Contribution>("contribution")
        .some((c) => c.runId === next.id);
      const base = resuming
        ? next.baseVersionId
          ? this.store.get<ArtifactVersion>("version", next.baseVersionId)
          : undefined
        : latest;
      const run = this.store.setRun(next.id, {
        status: "running",
        resumeRequested: false,
        baseVersionId: base?.id ?? null,
      });
      const controller = new AbortController();
      this.active.set(workId, controller);
      let contribution: Contribution | undefined;
      let model: Model | undefined;
      try {
        model = this.boundedModel(run, this.model());
        this.checkProvider(run, model);
        if (!run.recovery) {
          run.recovery = model.recovery ?? "remote";
          this.store.setRun(run.id, {
            recovery: run.recovery,
            modelIdentity: model.identity,
          });
        }
        if (!run.serviceScope && model.scope)
          this.store.setRun(run.id, { serviceScope: model.scope });
        const { context } = resolveRunContext(
          this.store,
          run,
          base,
        );
        const execution = await executeAgentRun({
          store: this.store,
          model,
          run,
          context,
          signal: controller.signal,
          workspaceActions: this.workspaceActions,
          onContribution: (current) => {
            contribution = current;
            this.changed();
          },
        });
        if (execution.waiting) return;
        const finalContribution = this.store
          .all<import("./types").Contribution>("contribution")
          .filter((c) => c.runId === run.id && c.status === "succeeded")
          .at(-1);
        if (finalContribution)
          attachPublicProcessToContribution(
            this.store,
            run,
            finalContribution.id,
          );
        const hasWorkspaceAction = this.store
          .all<{ runId: string }>("workspace-action")
          .some((action) => action.runId === run.id);
        this.store.finish(
          run.id,
          execution.final,
          execution.result &&
            run.outputMode !== "explanation" &&
            !hasWorkspaceAction,
        );
        this.changed();
        continue;
      } catch (e) {
        const error = e instanceof Error ? e.message : "运行失败";
        const uncertain =
          e instanceof TypeError ||
          (e instanceof DOMException && e.name === "TimeoutError") ||
          (e instanceof ServiceError && isUncertainExecution(e.code)) ||
          (e instanceof ServiceError &&
            [
              "STREAM_INTERRUPTED",
              "INVALID_STREAM",
              "RUN_ALREADY_EXISTS",
            ].includes(e.code));
        const remoteStop =
          controller.signal.aborted &&
          !!contribution &&
          (!contribution.task || contribution.status === "running") &&
          ((!!contribution.remoteId && !!model?.lookup) ||
            !!model?.lookupByKey);
        const status = remoteStop
          ? "unknown"
          : controller.signal.aborted
            ? "cancelled"
            : uncertain
              ? "unknown"
              : "failed";
        this.store.setRun(run.id, {
          status,
          error: remoteStop
            ? "已请求停止，请核对服务端终态；待发已暂停"
            : error,
        });
        this.store.pauseQueue(workId, true);
        if (
          contribution &&
          !(
            contribution.task &&
            controller.signal.aborted &&
            contribution.status === "succeeded"
          )
        ) {
          contribution.status = status;
          contribution.error = error;
          if (e instanceof ServiceError && e.runId)
            contribution.remoteId = e.runId;
          this.store.put("contribution", contribution.id, contribution);
        }
        this.changed();
        return;
      } finally {
        this.active.delete(workId);
      }
    }
  }
}
