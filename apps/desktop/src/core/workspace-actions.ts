import { createHash } from "node:crypto";
import type { Store } from "./store";
import type { Run } from "./types";
import type { Radar } from "./radar";
import type { Schedules } from "./schedules";
import type { RadarWatches } from "./radar-watches";
import type { RadarTopic } from "./radar-contract";
import type { Schedule } from "./schedule-contract";
import type { FeedSource } from "./feed-contract";
import type { RadarWatch } from "./radar-watch-contract";
import type { Contribution } from "./types";
import type { Project, Source, Work } from "./types";
import type { ToolReceipt } from "./tool-contract";
import {
  workspaceActionRequestSchema,
  type WorkspaceAction,
  type WorkspaceActionProposal,
  type WorkspaceActionRequest,
  type WorkspaceToolInput,
} from "./workspace-action-contract";

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const now = () => new Date().toISOString();
const proposalLifetime = 30 * 60 * 1000;
const uuidFor = (value: string) => {
  const hex = digest(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
type ActionRun = Run & { workspaceContext?: import("./workspace-context").WorkspaceContext };
type Adapters = {
  radar: Pick<Radar, "saveTopic"> & {
    archiveTopic?: (id: string, revision: number, archived: boolean) => RadarTopic;
  };
  schedules: Pick<Schedules, "save" | "setEnabled">;
  radarWatches: Pick<RadarWatches, "save">;
  currentScope?: () => string | undefined;
};

export class WorkspaceActions {
  constructor(
    readonly store: Store,
    private adapters?: Adapters,
  ) {}

  executeRequest(
    run: Run,
    contributionId: string,
    memberId: string,
    input: WorkspaceToolInput,
  ) {
    if (input.mode === "inspect") return this.inspect(run, input.query);
    return this.prepare(run, contributionId, memberId, input.action);
  }

  inspect(run: Run, query?: string) {
    const needle = query?.toLocaleLowerCase();
    const matches = (text: string) => !needle || text.toLocaleLowerCase().includes(needle);
    const context = (run as ActionRun).workspaceContext ?? null;
    const bounded = <T extends { id: string }>(preferred: T[], rest: T[]) => {
      const seen = new Set<string>();
      return [...preferred, ...rest]
        .filter((item) => !seen.has(item.id) && !!seen.add(item.id))
        .slice(0, 12);
    };
    const storedTopics = this.store
      .all<RadarTopic>("radar-topic")
      .filter((t) => !t.archived);
    const matchingTopics = storedTopics.filter((t) => matches(`${t.title} ${t.focus}`));
    const exactTopicNames = query
      ? storedTopics.filter((topic) => topic.title.toLocaleLowerCase() === query.toLocaleLowerCase())
      : [];
    const contextTopic =
      context?.kind === "radar-topic"
        ? storedTopics.filter((topic) => topic.id === context.id)
        : [];
    const topics = bounded([...contextTopic, ...exactTopicNames], matchingTopics)
      .map((t) => ({
        id: t.id,
        revision: t.revision,
        title: t.title,
        focus: t.focus.slice(0, 240),
        feedIds: t.feedIds ?? [],
        sourceIds: (t as RadarTopic & { sourceIds?: string[] }).sourceIds ?? [],
        keywords: (t as RadarTopic & { keywords?: string[] }).keywords ?? [],
        sources: t.sources,
        watch: this.store.get<{
          revision: number;
          enabled: boolean;
          intervalMinutes: number;
          maxCallsPerDay: number;
        }>("radar-watch", t.id) ?? null,
        input:
          (context?.kind === "radar-topic" && context.id === t.id) ||
          (exactTopicNames.length === 1 && exactTopicNames[0].id === t.id)
            ? (() => {
                const { updatedAt: _updatedAt, archived: _archived, ...input } = t;
                return input;
              })()
            : undefined,
      }));
    const storedSchedules = this.store.all<Schedule>("schedule");
    const matchingSchedules = storedSchedules.filter((s) => matches(s.name));
    const exactScheduleNames = query
      ? storedSchedules.filter((s) => s.name.toLocaleLowerCase() === query.toLocaleLowerCase())
      : [];
    const contextSchedule =
      context?.kind === "schedule"
        ? storedSchedules.filter((schedule) => schedule.id === context.id)
        : [];
    const schedules = bounded([...contextSchedule, ...exactScheduleNames], matchingSchedules)
      .map((s) => ({
        id: s.id,
        revision: s.revision,
        name: s.name,
        enabled: s.enabled,
        firstAt: s.firstAt,
        intervalHours: s.intervalHours,
        timezone: s.timezone,
        nextAt: s.nextAt,
        workId: s.workId,
        projectId: s.projectId,
        input:
          (context?.kind === "schedule" && context.id === s.id) ||
          (exactScheduleNames.length === 1 && exactScheduleNames[0].id === s.id)
            ? this.boundedScheduleInput(s)
            : undefined,
      }));
    const feeds = this.store
      .all<FeedSource>("feed")
      .filter((f) => !f.archived && matches(f.name))
      .slice(0, 12)
      .map((f) => ({ id: f.id, revision: f.revision, name: f.name, enabled: f.enabled }));
    const configuration = this.store.configuration(run.workId);
    const publicSources = (this.store.get<Source[]>("meta", "sources") ?? [])
      .filter((source) => matches(source.name))
      .slice(0, 20)
      .map(({ id, name, status }) => ({ id, name, status }));
    const currentWork = this.store.get<Work>("work", run.workId);
    const projects = this.store
      .all<Project>("project")
      .filter((project) => matches(project.name))
      .slice(0, 12)
      .map(({ id, name }) => ({ id, name }));
    return {
      kind: "workspace-inventory" as const,
      context,
      clock: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      topics,
      schedules,
      feeds,
      publicSources,
      currentWork: currentWork
        ? { id: currentWork.id, title: currentWork.title, projectId: currentWork.projectId }
        : null,
      projects,
      availableReferences: run.refs.map(({ materialId, version, label, excerpt }) => ({
        materialId,
        version,
        label,
        fixedExcerpt: !!excerpt,
      })),
      team: {
        id: configuration.team.id,
        version: configuration.team.version,
        name: configuration.team.name,
        members: configuration.team.members.map((m) => ({ id: m.id, name: m.name })),
      },
      capabilities: {
        direct: ["radar-topic-create", "radar-topic-narrow-context", "schedule-pause-context"],
        confirmation: ["schedule-create", "schedule-enable", "radar-watch", "scope-broadening"],
        limitations: ["本机定时任务仅在桌面应用运行时检查", "没有删除或立即运行能力"],
      },
      limited:
        topics.length === 12 ||
        schedules.length === 12 ||
        feeds.length === 12 ||
        publicSources.length === 20 ||
        projects.length === 12,
    };
  }

  prepare(
    run: Run,
    contributionId: string,
    memberId: string,
    raw: WorkspaceActionRequest,
  ): WorkspaceActionProposal {
    const request = workspaceActionRequestSchema.parse(raw);
    const action = this.normalize(contributionId, request);
    if (this.rejectedNonActionIntent(run.text, action))
      throw Error(
        "用户当前是在否定、引用或假设讨论这项操作；未生成工作区操作，也没有修改任何设置",
      );
    const context = (run as ActionRun).workspaceContext ?? null;
    this.currentRun = run;
    this.currentContribution = contributionId;
    const execution = this.execution(action, context);
    this.currentRun = undefined;
    this.currentContribution = undefined;
    const fingerprint = digest({ runId: run.id, contributionId, action, context });
    const id = `workspace-action:${contributionId}`;
    return this.store.transaction(() => {
      const existing = this.store.get<WorkspaceActionProposal>("workspace-action", id);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw Error("同一成员记录提出的工作区操作已变化");
        return existing;
      }
      const proposal: WorkspaceActionProposal = {
        id,
        runId: run.id,
        workId: run.workId,
        contributionId,
        memberId,
        status: "pending",
        execution,
        action,
        summary: this.summary(action),
        fingerprint,
        serviceScope: run.serviceScope ?? null,
        context,
        createdAt: now(),
        expiresAt: new Date(Date.now() + proposalLifetime).toISOString(),
      };
      this.store.put("workspace-action", id, proposal);
      if (execution === "direct") return this.applyStored(proposal);
      return proposal;
    });
  }

  apply(id: string) {
    return this.store.transaction(() => this.applyStored(this.store.require("workspace-action", id)));
  }

  dismiss(id: string) {
    return this.store.transaction(() => {
      const item = this.store.require<WorkspaceActionProposal>("workspace-action", id);
      if (item.status === "dismissed") return item;
      if (item.status !== "pending") throw Error("只有待确认操作可以忽略");
      return this.store.put("workspace-action", id, {
        ...item,
        status: "dismissed",
        dismissedAt: now(),
      } satisfies WorkspaceActionProposal);
    });
  }

  undo(id: string) {
    return this.store.transaction(() => {
      const item = this.store.require<WorkspaceActionProposal>("workspace-action", id);
      if (item.status === "undone") return item;
      if (item.status !== "applied" || !item.reversal || !item.undo?.available)
        throw Error("此操作当前不可撤销");
      this.checkScope(item, true);
      const adapters = this.requiredAdapters();
      const reversal = item.reversal;
      if (reversal.kind === "archive-created-radar-topic") {
        if (!adapters.radar.archiveTopic) throw Error("当前版本暂不支持撤销新建议题");
        adapters.radar.archiveTopic(reversal.id, reversal.expectedRevision, true);
      } else if (reversal.kind === "restore-radar-topic") {
        const { updatedAt: _updatedAt, ...topic } = reversal.topic;
        adapters.radar.saveTopic({ ...topic, revision: reversal.expectedRevision });
      } else if (reversal.kind === "restore-schedule-enabled") {
        const current = this.store.require<Schedule>("schedule", reversal.id);
        if (
          current.revision !== reversal.expectedRevision ||
          current.updatedAt !== reversal.expectedUpdatedAt
        )
          throw Error("定时任务已变化，不能撤销旧操作");
        adapters.schedules.setEnabled(current.id, current.revision, reversal.enabled);
      } else if (reversal.kind === "restore-schedule") {
        const current = this.store.require<Schedule>("schedule", reversal.input.id);
        if (
          current.revision !== reversal.input.expectedRevision ||
          current.updatedAt !== reversal.expectedUpdatedAt
        )
          throw Error("定时任务已变化，不能撤销旧操作");
        adapters.schedules.save(reversal.input);
      } else {
        const restored = adapters.radarWatches.save(reversal.input);
        const nextAt = restored.enabled
          ? reversal.nextAt && Date.parse(reversal.nextAt) > Date.now()
            ? reversal.nextAt
            : new Date(Date.now() + restored.intervalMinutes * 60_000).toISOString()
          : null;
        this.store.put("radar-watch", restored.id, { ...restored, nextAt });
      }
      return this.store.put("workspace-action", id, {
        ...item,
        status: "undone",
        undoneAt: now(),
        undo: { available: false, reason: "已撤销" },
      } satisfies WorkspaceActionProposal);
    });
  }

  private applyStored(item: WorkspaceActionProposal): WorkspaceActionProposal {
    if (item.status === "applied") return item;
    if (item.status !== "pending") throw Error("此操作已结束，不能再次应用");
    const run = this.store.require<Run>("run", item.runId);
    if (run.status === "cancelled") throw Error("原交流已停止，不能应用旧操作");
    if (item.execution === "confirmation" && Date.parse(item.expiresAt) <= Date.now())
      throw Error("操作确认已过期，请根据当前状态重新提出");
    this.checkScope(item);
    const adapters = this.requiredAdapters();
    let result: WorkspaceActionProposal["result"];
    let reversal: WorkspaceActionProposal["reversal"];
    if (item.action.kind === "radar-topic") {
      const old = item.action.topic.id
        ? this.store.get<RadarTopic>("radar-topic", item.action.topic.id)
        : undefined;
      const saved = adapters.radar.saveTopic(item.action.topic);
      result = { kind: "radar-topic", id: saved.id, revision: saved.revision };
      reversal = old
        ? { kind: "restore-radar-topic", topic: old, expectedRevision: saved.revision }
        : { kind: "archive-created-radar-topic", id: saved.id, expectedRevision: saved.revision };
    } else if (item.action.kind === "schedule") {
      const old = this.store.get<Schedule>("schedule", item.action.input.id);
      const saved = adapters.schedules.save(item.action.input);
      result = { kind: "schedule", id: saved.id, revision: saved.revision };
      if (old)
        reversal = {
          kind: "restore-schedule",
          input: this.scheduleInput(old, saved.revision),
          expectedUpdatedAt: saved.updatedAt,
        };
      else
        reversal = {
          kind: "restore-schedule-enabled",
          id: saved.id,
          expectedRevision: saved.revision,
          expectedUpdatedAt: saved.updatedAt,
          enabled: false,
        };
    } else if (item.action.kind === "schedule-enabled") {
      const old = this.store.require<Schedule>("schedule", item.action.id);
      const saved = adapters.schedules.setEnabled(item.action.id, item.action.revision, item.action.enabled);
      result = { kind: "schedule", id: saved.id, revision: saved.revision };
      reversal = {
        kind: "restore-schedule-enabled",
        id: old.id,
        expectedRevision: saved.revision,
        expectedUpdatedAt: saved.updatedAt,
        enabled: old.enabled,
      };
    } else {
      const old = this.store.get<RadarWatch>("radar-watch", item.action.input.topicId);
      const saved = adapters.radarWatches.save(item.action.input);
      result = { kind: "radar-watch", id: saved.id, revision: saved.revision };
      if (old)
        reversal = {
          kind: "restore-radar-watch",
          input: {
            topicId: old.id,
            topicRevision: old.topicRevision,
            expectedRevision: saved.revision,
            enabled: old.enabled,
            intervalMinutes: old.intervalMinutes,
            maxCallsPerDay: old.maxCallsPerDay,
          },
          nextAt: old.nextAt,
        };
      else
        reversal = {
          kind: "restore-radar-watch",
          input: {
            topicId: saved.id,
            topicRevision: saved.topicRevision,
            expectedRevision: saved.revision,
            enabled: false,
            intervalMinutes: saved.intervalMinutes,
            maxCallsPerDay: saved.maxCallsPerDay,
          },
          nextAt: null,
        };
    }
    return this.store.put("workspace-action", item.id, {
      ...item,
      status: "applied",
      appliedAt: now(),
      result,
      reversal,
      undo: reversal
        ? { available: true }
        : { available: false, reason: "此操作需要在设置中另行修改" },
    } satisfies WorkspaceActionProposal);
  }

  private normalize(contributionId: string, request: WorkspaceActionRequest): WorkspaceAction {
    if (request.kind !== "schedule") return request;
    return {
      kind: "schedule",
      input: { ...request.input, id: request.input.id ?? uuidFor(`schedule:${contributionId}`) },
    };
  }

  private scheduleInput(schedule: Schedule, expectedRevision: number) {
    return {
      id: schedule.id,
      expectedRevision,
      name: schedule.name,
      workId: schedule.workId,
      projectId: schedule.projectId,
      text: schedule.text,
      refs: schedule.refs,
      recipient: schedule.recipient,
      skillKeys: schedule.skillKeys,
      outputMode: schedule.outputMode,
      firstAt: schedule.firstAt,
      intervalHours: schedule.intervalHours,
      timezone: schedule.timezone,
      followLatest: schedule.followLatest,
      maxModelCalls: schedule.maxModelCalls,
      enabled: schedule.enabled,
    };
  }

  private boundedScheduleInput(schedule: Schedule) {
    const input = this.scheduleInput(schedule, schedule.revision);
    return JSON.stringify(input).length <= 12000 ? input : undefined;
  }

  private execution(
    action: WorkspaceAction,
    context: import("./workspace-context").WorkspaceContext | null,
  ): "direct" | "confirmation" {
    if (!this.directAllowed(action, context)) return "confirmation";
    if (action.kind === "radar-topic") {
      if (!action.topic.id && action.topic.revision === 0) return "direct";
      const old = action.topic.id
        ? this.store.get<RadarTopic>("radar-topic", action.topic.id)
        : undefined;
      if (!old || old.revision !== action.topic.revision) return "confirmation";
      return old && this.topicNarrows(old, action.topic) ? "direct" : "confirmation";
    }
    if (action.kind === "schedule-enabled")
      return !action.enabled &&
        this.store.get<Schedule>("schedule", action.id)?.revision === action.revision
        ? "direct"
        : "confirmation";
    if (action.kind === "schedule") {
      const old = this.store.get<Schedule>("schedule", action.input.id);
      if (!old || old.revision !== action.input.expectedRevision) return "confirmation";
      if (!this.knownTarget(old.name, old.id, context, "schedule")) return "confirmation";
      const newInterval = action.input.intervalHours;
      const intervalSafe =
        old.intervalHours === null
          ? newInterval === null
          : newInterval !== null && newInterval >= old.intervalHours;
      const fixedSame =
        old.id === action.input.id &&
        old.revision === action.input.expectedRevision &&
        old.name === action.input.name &&
        old.workId === action.input.workId &&
        old.projectId === action.input.projectId &&
        old.text === action.input.text &&
        JSON.stringify(old.refs) === JSON.stringify(action.input.refs) &&
        old.recipient === action.input.recipient &&
        JSON.stringify(old.skillKeys) === JSON.stringify(action.input.skillKeys) &&
        old.outputMode === action.input.outputMode &&
        old.timezone === action.input.timezone &&
        old.followLatest === action.input.followLatest &&
        old.maxModelCalls === action.input.maxModelCalls &&
        old.enabled === action.input.enabled;
      return intervalSafe && fixedSame
        ? "direct"
        : "confirmation";
    }
    if (action.kind === "radar-watch") {
      const old = this.store.get<RadarWatch>("radar-watch", action.input.topicId);
      if (
        !old ||
        old.revision !== action.input.expectedRevision ||
        old.topicRevision !== action.input.topicRevision
      )
        return "confirmation";
      const topic = this.store.get<RadarTopic>("radar-topic", old.id);
      if (!topic || topic.revision !== action.input.topicRevision) return "confirmation";
      if (!this.knownTarget(topic.title, topic.id, context, "radar-topic"))
        return "confirmation";
      const doesNotEnable = old.enabled || !action.input.enabled;
      const reducesRate =
        action.input.intervalMinutes >= old.intervalMinutes &&
        action.input.maxCallsPerDay <= old.maxCallsPerDay;
      return doesNotEnable && reducesRate ? "direct" : "confirmation";
    }
    return "confirmation";
  }

  private directAllowed(
    action: WorkspaceAction,
    context: import("./workspace-context").WorkspaceContext | null,
  ) {
    const proposalId = this.store
      .all<WorkspaceActionProposal>("workspace-action")
      .filter((p) => p.runId === this.currentRun!.id && p.execution === "direct" && p.status === "applied")
      .length;
    if (proposalId >= 3) return false;
    const current = this.store.get<{ direct: boolean }>("meta", "workspace-policy");
    const captured = this.currentRun as Run & { workspacePolicy?: { direct: boolean } };
    if (!current?.direct || !captured.workspacePolicy?.direct) return false;
    if (this.currentRun!.refs.length) return false;
    const owner = this.store.require<Contribution>("contribution", this.currentContribution!);
    if ((owner.task?.depth ?? 0) !== 0) return false;
    if (this.ambiguousIntent(this.currentRun!.text, action)) return false;
    if (action.kind === "radar-topic" && action.topic.id)
      return this.knownTarget(
        this.store.get<RadarTopic>("radar-topic", action.topic.id)?.title ?? "",
        action.topic.id,
        context,
        "radar-topic",
      );
    if (action.kind === "schedule-enabled")
      return this.knownTarget(
        this.store.get<Schedule>("schedule", action.id)?.name ?? "",
        action.id,
        context,
        "schedule",
      );
    if (action.kind === "radar-watch")
      return this.knownTarget(
        this.store.get<RadarTopic>("radar-topic", action.input.topicId)?.title ?? "",
        action.input.topicId,
        context,
        "radar-topic",
      );
    return true;
  }

  private currentRun?: Run;
  private currentContribution?: string;

  private knownTarget(
    name: string,
    id: string,
    context: import("./workspace-context").WorkspaceContext | null,
    kind: "radar-topic" | "schedule",
  ) {
    if (context?.kind === kind && context.id === id) return true;
    if (!name || !this.currentRun!.text.includes(name)) return false;
    const sameNames =
      kind === "radar-topic"
        ? this.store.all<RadarTopic>("radar-topic").filter((x) => !x.archived && x.title === name)
        : this.store.all<Schedule>("schedule").filter((x) => x.name === name);
    if (sameNames.length !== 1 || sameNames[0].id !== id) return false;
    return this.store
      .all<ToolReceipt>("tool-call")
      .some(
        (receipt) =>
          receipt.runId === this.currentRun!.id &&
          receipt.status === "succeeded" &&
          receipt.request.key === "builtin.workspace@1" &&
          receipt.request.input.mode === "inspect",
      );
  }

  private ambiguousIntent(text: string, action: WorkspaceAction) {
    const term =
      action.kind === "schedule-enabled"
        ? action.enabled
          ? "启用"
          : "暂停"
        : action.kind === "radar-topic"
          ? action.topic.id
            ? "修改"
            : "新建"
          : "设置";
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return (
      this.rejectedNonActionIntent(text, action) ||
      /[？?]/.test(text) ||
      new RegExp(`[‘'“\"]${escaped}[’'”\"]`).test(text)
    );
  }

  private rejectedNonActionIntent(text: string, _action: WorkspaceAction) {
    return (
      /(?:先别|不要|别|无需|请勿|不用).{0,12}(?:暂停|停用|启用|开启|新建|创建|新增|修改|调整|设置|安排)/.test(text) ||
      /(?:如果|假如|假设).{0,24}(?:暂停|停用|启用|开启|新建|创建|新增|修改|调整|设置|安排)|(?:暂停|停用|启用|开启|新建|创建|新增|修改|调整|设置|安排).{0,12}(?:会怎样|会如何|怎么办)/.test(text) ||
      /[‘'“\"](?:暂停|停用|启用|开启|新建|创建|新增|修改|调整|设置|安排)[^’'”\"]{0,24}[’'”\"]/.test(text)
    );
  }

  private topicNarrows(
    old: RadarTopic,
    next: Extract<WorkspaceAction, { kind: "radar-topic" }>["topic"],
  ) {
    const subset = (a: string[], b: string[]) => a.every((value) => b.includes(value));
    const oldExtra = old as RadarTopic & { sourceIds?: string[]; keywords?: string[] };
    const nextExtra = next as typeof next & { sourceIds?: string[]; keywords?: string[] };
    const oldKeywords = oldExtra.keywords ?? [];
    const nextKeywords = nextExtra.keywords ?? [];
    const oldSources = new Map(old.sources.map((source) => [source.materialId, source]));
    return (
      old.focus === next.focus &&
      subset(next.feedIds ?? [], old.feedIds ?? []) &&
      subset(nextExtra.sourceIds ?? [], oldExtra.sourceIds ?? []) &&
      subset(nextKeywords, oldKeywords) &&
      (oldKeywords.length === 0 || nextKeywords.length > 0) &&
      next.sources.every((source) => {
        const previous = oldSources.get(source.materialId);
        return !!previous &&
          (source.policy === previous.policy || source.policy === "exclude");
      }) &&
      (next.feedLimit ?? 8) <= (old.feedLimit ?? 8)
    );
  }

  private summary(action: WorkspaceAction) {
    if (action.kind === "radar-topic")
      return `${action.topic.id ? "修改" : "新建"}雷达议题“${action.topic.title}”`;
    if (action.kind === "schedule")
      return `${this.store.get("schedule", action.input.id) ? "修改" : "新建"}定时任务“${action.input.name}”`;
    if (action.kind === "schedule-enabled")
      return `${action.enabled ? "启用" : "暂停"}定时任务`;
    return `${action.input.enabled ? "启用" : "修改"}雷达自动整理`;
  }

  private checkScope(item: WorkspaceActionProposal, force = false) {
    const requiresScope =
      item.action.kind === "schedule" ||
      item.action.kind === "radar-watch" ||
      (item.action.kind === "schedule-enabled" && item.action.enabled);
    if (!force && !requiresScope) return;
    if (!item.serviceScope) return;
    const current = this.adapters?.currentScope?.();
    if (!current || current !== item.serviceScope)
      throw Error("模型服务账号或权限范围已变化，请重新提出操作");
  }

  private requiredAdapters() {
    if (!this.adapters) throw Error("当前入口未连接工作区操作执行器");
    return this.adapters;
  }
}
