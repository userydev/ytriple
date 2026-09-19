import { createHash } from "node:crypto";
import type { Store } from "./store";
import type { Runtime } from "./runtime";
import { Skills } from "./skills";
import { captureProjectContext } from "./projects";
import { versionKey } from "./configuration";
import {
  scheduleInput,
  type ScheduleInput,
  type Schedule,
  type ScheduleOccurrence,
} from "./schedule-contract";
import type { Material, Run, Work } from "./types";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const pending = new Set(["queued", "running", "waiting", "unknown"]);
export class Schedules {
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    readonly store: Store,
    readonly runtime: Pick<Runtime, "startQueued" | "stop">,
    private scope: () => string | undefined,
    private changed: () => void = () => {},
    private clock: () => number = Date.now,
  ) {}
  private authorization(workId: string, keys: string[]) {
    const work = this.store.require<Work>("work", workId);
    const { team, workflow } = this.store.configuration(workId);
    const skills = new Skills(this.store).capture(keys, team);
    const serviceScope = this.scope();
    if (!serviceScope) throw Error("先连接模型服务，再授权本机定时任务");
    const projectContext = captureProjectContext(
      this.store,
      work.projectId,
      work.deliveryId,
    );
    return {
      team,
      workflow,
      skills,
      serviceScope,
      authorizationHash: hash({
        team,
        workflow,
        skills,
        serviceScope,
        projectContext,
        projectId: work.projectId,
        deliveryId: work.deliveryId,
      }),
    };
  }
  save(raw: ScheduleInput) {
    const input = scheduleInput.parse(raw),
      requestHash = hash(input);
    if (Buffer.byteLength(input.text) > 16000)
      throw Error("目标过长，请缩小范围");
    const saved = this.store.transaction(() => {
      const old = this.store.get<Schedule>("schedule", input.id);
      if (
        old?.revision === input.expectedRevision + 1 &&
        old.requestHash === requestHash
      )
        return old;
      if ((old?.revision ?? 0) !== input.expectedRevision)
        throw Error("任务已变化，请重新打开后编辑");
      if (Date.parse(input.firstAt) <= this.clock())
        throw Error("首次执行时间需要在未来");
      if (input.followLatest && input.refs.some((r) => r.excerpt))
        throw Error("选段需固定在原版本；要跟随新版本，请先改为整份材料");
      input.refs.forEach((ref) => {
        const m = this.store.material(ref);
        if (m.readError || !m.body.trim())
          throw Error(`材料尚未就绪：${m.title}`);
        if (ref.excerpt && !m.body.includes(ref.excerpt))
          throw Error("选段不属于指定材料版本");
      });
      if (old && input.workId !== old.workId)
        throw Error("任务的原工作不可更换，请另建委托");
      const timestamp = new Date(this.clock()).toISOString();
      let work: Work;
      if (input.workId) work = this.store.require<Work>("work", input.workId);
      else {
        if (this.store.get("work", input.id))
          throw Error("任务标识与已有工作冲突，请重新新建");
        if (input.projectId) this.store.require("project", input.projectId);
        const { team, workflow } = this.store.configuration();
        this.store.put("team", versionKey(team), team);
        this.store.put("workflow", versionKey(workflow), workflow);
        work = this.store.put<Work>("work", input.id, {
          id: input.id,
          title: input.name,
          projectId: input.projectId,
          deliveryId: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          archived: false,
          queuePaused: false,
          teamKey: versionKey(team),
          workflowKey: versionKey(workflow),
        });
      }
      if (work.projectId !== input.projectId)
        throw Error("项目归属已变化，请重新打开任务");
      if (work.archived || work.completedAt)
        throw Error("先在原工作中恢复，再设置定时任务");
      const approved = this.authorization(work.id, input.skillKeys);
      if (
        input.recipient &&
        !approved.team.members.some((m) => m.id === input.recipient)
      )
        throw Error("团队中没有所选负责人");
      const { expectedRevision, ...definition } = input;
      const schedule: Schedule = {
        ...definition,
        ...approved,
        workId: work.id,
        revision: expectedRevision + 1,
        nextAt: input.enabled ? input.firstAt : null,
        issue: null,
        requestHash,
        createdAt: old?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      this.store.put(
        "schedule-version",
        `${schedule.id}@${schedule.revision}`,
        schedule,
      );
      return this.store.put("schedule", schedule.id, schedule);
    });
    this.changed();
    return saved;
  }
  setEnabled(id: string, revision: number, enabled: boolean) {
    const schedule = this.store.require<Schedule>("schedule", id);
    if (schedule.revision !== revision) throw Error("任务已变化，请重新打开");
    if (enabled) {
      const work = this.store.require<Work>("work", schedule.workId);
      if (work.archived || work.completedAt)
        throw Error("先恢复原工作，再启用任务");
      this.checkAuthorization(schedule);
      if (
        !schedule.intervalHours &&
        Date.parse(schedule.firstAt) <= this.clock()
      )
        throw Error("单次触发时间已过，请编辑时间或立即运行");
    }
    const nextAt = enabled ? this.nextFuture(schedule) : null;
    const saved = this.store.put<Schedule>("schedule", id, {
      ...schedule,
      enabled,
      nextAt,
      issue: enabled ? null : schedule.issue,
      pauseReason: enabled ? undefined : "用户已暂停后续触发",
      updatedAt: new Date(this.clock()).toISOString(),
    });
    this.changed();
    return saved;
  }
  private nextFuture(schedule: Schedule) {
    const first = Date.parse(schedule.firstAt),
      now = this.clock();
    if (first > now) return schedule.firstAt;
    if (!schedule.intervalHours) return null;
    const step = schedule.intervalHours * 3600000;
    return new Date(
      first + (Math.floor((now - first) / step) + 1) * step,
    ).toISOString();
  }
  private checkAuthorization(schedule: Schedule) {
    const current = this.authorization(schedule.workId, schedule.skillKeys);
    if (current.authorizationHash !== schedule.authorizationHash)
      throw Error(
        "团队、方法、项目要求或服务权限已变化；请编辑任务，核对后重新保存授权",
      );
  }
  runNow(id: string, revision: number, key: string) {
    const schedule = this.store.require<Schedule>("schedule", id);
    if (schedule.revision !== revision) throw Error("任务已变化，请重新打开");
    return this.trigger(
      schedule,
      "manual",
      key,
      new Date(this.clock()).toISOString(),
    );
  }
  private trigger(
    schedule: Schedule,
    trigger: "manual" | "clock",
    key: string,
    dueAt: string,
    missedCount = 0,
  ) {
    const id = hash([schedule.id, schedule.revision, trigger, key]);
    let submitted: Run | undefined;
    const occurrence = this.store.transaction(() => {
      const old = this.store.get<ScheduleOccurrence>("schedule-occurrence", id);
      if (old) return old;
      const record: ScheduleOccurrence = {
        id,
        scheduleId: schedule.id,
        revision: schedule.revision,
        dueAt,
        checkedAt: new Date(this.clock()).toISOString(),
        trigger,
        state: "blocked",
        detail: "",
        runId: null,
      };
      if (missedCount) {
        record.state = "missed";
        record.missedCount = missedCount;
        record.detail = `错过 ${missedCount} 次触发，未补跑；可手动立即运行`;
      } else
        try {
          this.checkAuthorization(schedule);
          const work = this.store.require<Work>("work", schedule.workId);
          const runs = this.store
            .all<Run>("run")
            .filter((r) => r.workId === work.id);
          if (work.archived || work.completedAt)
            throw Error("原工作已完成或归档，请先恢复工作");
          if (runs.some((r) => ["waiting", "unknown"].includes(r.status)))
            throw Error("原工作有待答复或待核对运行，请先在原工作中处理");
          if (work.queuePaused)
            throw Error("原工作队列已暂停，请先在原工作中处理并继续队列");
          if (runs.some((r) => pending.has(r.status))) {
            record.state = "busy";
            record.detail = "原工作仍在执行，本次未追加运行";
          } else {
            const refs = schedule.refs.map((ref) => {
              if (!schedule.followLatest) return ref;
              const latest = this.store
                .all<Material>("material")
                .filter((m) => m.id === ref.materialId)
                .sort((a, b) => b.version - a.version)[0];
              if (!latest) throw Error(`材料不存在：${ref.label}`);
              return { ...ref, version: latest.version, label: latest.title };
            });
            const materialInput = refs.map((ref) => {
              const m = this.store.material(ref);
              if (m.readError || !m.body.trim())
                throw Error(`材料尚未就绪：${m.title}`);
              return {
                id: m.id,
                body: ref.excerpt ?? m.body,
                coverage: m.coverage,
              };
            });
            record.inputHash = hash({
              text: schedule.text,
              outputMode: schedule.outputMode,
              recipient: schedule.recipient,
              authorization: schedule.authorizationHash,
              materialInput,
            });
            const previous = this.store
              .all<ScheduleOccurrence>("schedule-occurrence")
              .filter(
                (o) =>
                  o.scheduleId === schedule.id &&
                  o.runId &&
                  this.store.get<Run>("run", o.runId)?.status === "succeeded",
              )
              .at(-1);
            if (
              trigger === "clock" &&
              previous?.inputHash === record.inputHash
            ) {
              record.state = "unchanged";
              record.detail = "已选材料与目标未变化，未调用模型";
            } else {
              submitted = this.store.submit(
                {
                  key: `schedule-${id}`,
                  context: work.id,
                  text: schedule.text,
                  refs,
                  recipient: schedule.recipient,
                  projectId: work.projectId,
                  deliveryId: work.deliveryId,
                  outputMode: schedule.outputMode,
                  skillKeys: schedule.skillKeys,
                  schedule: {
                    scheduleId: schedule.id,
                    revision: schedule.revision,
                    occurrenceId: id,
                    maxModelCalls: schedule.maxModelCalls,
                  },
                },
                schedule.serviceScope,
              );
              record.state = "submitted";
              record.runId = submitted.id;
              record.detail =
                trigger === "manual"
                  ? "用户要求立即重跑；复用原工作"
                  : "按已授权条件提交原工作";
            }
          }
        } catch (error) {
          record.state = "blocked";
          record.detail = error instanceof Error ? error.message : "触发失败";
        }
      // Persist the trigger receipt, run and next trigger in one SQLite transaction.
      // Runtime is only started after commit; a crash cannot lose the dedup receipt.
      this.store.put("schedule-occurrence", id, record);
      const current = this.store.require<Schedule>("schedule", schedule.id);
      const nextAt =
        trigger === "clock" ? this.nextFuture(schedule) : current.nextAt;
      this.store.put<Schedule>("schedule", schedule.id, {
        ...current,
        nextAt: record.state === "blocked" ? null : nextAt,
        enabled:
          record.state === "blocked" || (trigger === "clock" && !nextAt)
            ? false
            : current.enabled,
        issue: record.state === "blocked" ? record.detail : null,
      });
      return record;
    });
    if (submitted) this.runtime.startQueued(submitted.workId);
    this.changed();
    return occurrence;
  }
  stopOccurrence(id: string) {
    const occurrence = this.store.require<ScheduleOccurrence>(
      "schedule-occurrence",
      id,
    );
    if (!occurrence.runId) throw Error("该次触发没有运行");
    const run = this.store.require<Run>("run", occurrence.runId);
    if (run.schedule?.occurrenceId !== id) throw Error("运行归属不符");
    if (run.status === "unknown")
      throw Error("停止状态尚未确认，请在原工作中核对");
    if (run.status === "queued")
      this.store.setRun(run.id, {
        status: "cancelled",
        error: "用户停止本次定时运行",
      });
    else if (["running", "waiting"].includes(run.status))
      this.runtime.stop(run.workId);
    this.changed();
  }
  tick() {
    for (const schedule of this.store.all<Schedule>("schedule")) {
      if (
        !schedule.enabled ||
        !schedule.nextAt ||
        Date.parse(schedule.nextAt) > this.clock()
      )
        continue;
      const late = this.clock() - Date.parse(schedule.nextAt);
      // Two-minute tolerance covers timer jitter. Older triggers are explicit missed checks.
      const missed =
        late > 120000
          ? schedule.intervalHours
            ? Math.floor(late / (schedule.intervalHours * 3600000)) + 1
            : 1
          : 0;
      this.trigger(schedule, "clock", schedule.nextAt, schedule.nextAt, missed);
    }
  }
  start() {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), 15000);
    this.timer.unref();
  }
  shutdown() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
