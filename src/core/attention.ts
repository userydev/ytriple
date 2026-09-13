import { createHash } from "node:crypto";
import type { Task } from "../shared/types.js";
import type { DeliveryRecord } from "../shared/delivery.js";
import type { Routine } from "../shared/routines.js";
import type { WorkServiceSnapshot } from "../shared/work-service.js";
import {
  attentionCommandSchema,
  type AttentionCommand,
  type AttentionItem,
  type AttentionMode,
  type AttentionSnapshot,
} from "../shared/attention.js";
import type { FeatureHost } from "./feature-host.js";
import type { Store } from "./store.js";
export { attentionCommandSchema } from "../shared/attention.js";
export type {
  AttentionCommand,
  AttentionSnapshot,
} from "../shared/attention.js";

const KEY = "attention.v1";
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
interface Ledger {
  revision: number;
  mode: AttentionMode;
  decisions: Record<
    string,
    {
      fingerprint: string;
      state: "handled" | "snoozed";
      at: string;
      until?: string;
    }
  >;
  receipts: Record<string, string>;
}
function readConfig<T>(store: Store, key: string, fallback: T): T {
  const row = store.db
    .prepare("SELECT body FROM config WHERE key=?")
    .get(key) as { body: string } | undefined;
  return row ? JSON.parse(row.body) : fallback;
}
function ledger(store: Store): Ledger {
  return readConfig(store, KEY, {
    revision: 0,
    mode: "summary",
    decisions: {},
    receipts: {},
  });
}
function routines(store: Store): Routine[] {
  if (
    !store.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='routines'",
      )
      .get()
  )
    return [];
  return (
    store.db.prepare("SELECT body FROM routines").all() as { body: string }[]
  ).map((row) => JSON.parse(row.body));
}
function currentEvents(task: Task) {
  return task.events.filter((event) => event.goalVersion === task.goalVersion);
}
function taskReason(task: Task): "waiting" | "failed" | undefined {
  if (task.status === "waiting" || task.status === "failed") return task.status;
  // Store recovers interrupted runs as paused. Their unresolved question or need to resume remains visible.
  if (
    task.status === "paused" &&
    currentEvents(task).findLast((event) =>
      [
        "recovered",
        "run_paused",
        "run_completed",
        "run_started",
        "run_failed",
      ].includes(event.type),
    )?.type === "recovered"
  )
    return "waiting";
  return undefined;
}
function taskIssue(task: Task) {
  const waiting = taskReason(task) === "waiting";
  const types = waiting
    ? ["clarification_requested", "agent_waiting", "run_waiting", "recovered"]
    : ["run_failed", "agent_failed", "tool_failed"];
  const history = currentEvents(task);
  const started = history.findLastIndex(
    (event) => event.type === "run_started",
  );
  const events = started >= 0 ? history.slice(started) : history;
  const event = waiting
    ? (events.findLast((item) => item.type === "clarification_requested") ??
      events.findLast((item) => types.includes(item.type)))
    : events.findLast((item) => types.includes(item.type));
  return {
    eventId: event?.id,
    summary:
      task.error ||
      event?.summary ||
      (waiting
        ? "工作等待你补充信息或作出判断。"
        : "工作失败，请查看原过程中的错误与已有成果。"),
    occurredAt: event?.createdAt ?? task.updatedAt,
  };
}

/** Derives attention from original records. Reading this view never creates tasks, feedback or decisions. */
export function attentionSnapshot(
  store: Store,
  at: number = Date.now(),
  workService?: WorkServiceSnapshot,
): AttentionSnapshot {
  const data = ledger(store),
    tasks = store.tasks(),
    taskMap = new Map(tasks.map((task) => [task.id, task]));
  const routineItems = routines(store);
  const deliveries = readConfig<{ records: DeliveryRecord[] }>(
    store,
    "delivery.ledger.v1",
    { records: [] },
  ).records;
  const ownedWorkers = new Set([
    ...routineItems.flatMap((item) =>
      item.workTaskId ? [item.workTaskId] : [],
    ),
    ...deliveries.flatMap((record) => record.works.map((work) => work.taskId)),
  ]);
  const items: AttentionItem[] = [];
  const add = (
    input: Omit<AttentionItem, "fingerprint" | "state">,
    evidence: unknown,
  ) => {
    const fingerprint = digest({ id: input.id, evidence });
    const decision = data.decisions[input.id];
    const applies = decision?.fingerprint === fingerprint;
    const state =
      applies && decision.state === "handled"
        ? "handled"
        : applies &&
            decision.state === "snoozed" &&
            Date.parse(decision.until ?? "") > at
          ? "snoozed"
          : "open";
    items.push({
      ...input,
      fingerprint,
      state,
      ...(state === "handled" ? { handledAt: decision!.at } : {}),
      ...(state === "snoozed" ? { snoozedUntil: decision!.until } : {}),
    });
  };
  for (const task of tasks) {
    const reason = taskReason(task);
    if (
      task.archivedAt ||
      task.surface === "background" ||
      ownedWorkers.has(task.id) ||
      !reason
    )
      continue;
    const issue = taskIssue(task);
    add(
      {
        id: `task:${task.id}`,
        kind: "task",
        reason,
        title: task.title,
        summary: issue.summary,
        importance: "important",
        occurredAt: issue.occurredAt,
        origin: {
          id: task.id,
          taskId: task.id,
          artifactIds: task.artifacts
            .filter((item) => item.goalVersion === task.goalVersion)
            .map((item) => item.id),
          feedbackIds: [],
        },
      },
      {
        status: reason,
        goalVersion: task.goalVersion,
        eventId: issue.eventId,
        summary: issue.summary,
      },
    );
  }
  for (const routine of routineItems) {
    const original = taskMap.get(routine.taskId);
    if (original?.archivedAt || routine.state === "stopped") continue;
    const run = routine.runs.at(-1);
    const blocked =
      ["failed", "waiting"].includes(routine.state) ||
      (routine.state === "paused" && !!routine.lastError);
    if (blocked) {
      const summary =
        routine.lastError ||
        run?.summary ||
        "例行工作需要处理，请查看运行记录。";
      add(
        {
          id: `routine:${routine.id}:issue`,
          kind: "routine",
          reason: routine.state === "failed" ? "failed" : "waiting",
          title: routine.title,
          summary,
          importance: "important",
          occurredAt: run?.finishedAt ?? routine.updatedAt,
          origin: {
            id: routine.id,
            taskId: routine.taskId,
            workTaskId: routine.workTaskId,
            artifactIds: run?.artifactIds ?? [],
            feedbackIds: [],
          },
        },
        {
          version: routine.version,
          state: routine.state,
          summary,
          runId: run?.id,
        },
      );
    }
    const result = routine.runs.findLast(
      (item) =>
        item.state === "completed" &&
        item.meaningful &&
        item.artifactIds.length > 0,
    );
    if (result)
      add(
        {
          id: `routine:${routine.id}:result`,
          kind: "routine",
          reason: "result",
          title: routine.title,
          summary: result.summary,
          importance: "normal",
          occurredAt: result.finishedAt ?? result.startedAt,
          origin: {
            id: routine.id,
            taskId: routine.taskId,
            artifactIds: result.artifactIds,
            feedbackIds: [],
          },
        },
        {
          runId: result.id,
          artifacts: result.artifactIds,
          summary: result.summary,
        },
      );
  }
  for (const record of deliveries) {
    const original = taskMap.get(record.taskId);
    if (original?.archivedAt) continue;
    const origin = {
      id: record.id,
      taskId: record.taskId,
      artifactIds: [record.artifactId],
      feedbackIds: [] as string[],
    };
    if (record.status === "revision_needed") {
      const latest = record.history.at(-1);
      add(
        {
          id: `delivery:${record.id}:revision`,
          kind: "delivery",
          reason: "revision",
          title: record.artifactTitle,
          summary:
            latest?.note ||
            latest?.evidence.observations ||
            "交付已标记待修订，请沿原成果处理。",
          importance: "important",
          occurredAt: latest?.recordedAt ?? record.updatedAt,
          origin,
        },
        { status: record.status, hash: record.artifactHash, latest },
      );
    }
    const feedback = record.feedback.filter(
      (item) => item.decision === "pending",
    );
    if (feedback.length)
      add(
        {
          id: `delivery:${record.id}:feedback`,
          kind: "delivery",
          reason: "feedback",
          title: record.artifactTitle,
          summary: `${feedback.length} 条真实反馈待判断。${feedback[0]!.quote.slice(0, 400)}`,
          importance: "normal",
          occurredAt: feedback.at(-1)!.addedAt,
          origin: { ...origin, feedbackIds: feedback.map((item) => item.id) },
        },
        feedback.map((item) => ({
          id: item.id,
          quote: item.quote,
          location: item.location,
          coverage: item.coverage,
          observedAt: item.observedAt,
        })),
      );
    for (const kind of ["readiness", "feedback"] as const) {
      const work = record.works.findLast((item) => item.kind === kind);
      if (!work) continue;
      const task = taskMap.get(work.taskId);
      if (!task || task.archivedAt) continue;
      const issue = taskIssue(task),
        artifacts = task.artifacts.filter(
          (item) => item.goalVersion === task.goalVersion,
        );
      const blocked = taskReason(task);
      if (!blocked && !(task.status === "completed" && artifacts.length))
        continue;
      add(
        {
          id: `delivery:${record.id}:${kind}`,
          kind: "delivery",
          reason: blocked ?? "check",
          title: `${record.artifactTitle} · ${kind === "readiness" ? "就绪检查" : "反馈整理"}`,
          summary: blocked
            ? issue.summary
            : "检查成果已保存，待你查看结论和仍未解决的问题。检查完成本身不改变交付或反馈状态。",
          importance: blocked ? "important" : "normal",
          occurredAt: blocked ? issue.occurredAt : artifacts.at(-1)!.updatedAt,
          origin: {
            id: record.id,
            taskId: record.taskId,
            workTaskId: task.id,
            artifactIds: artifacts.map((item) => item.id),
            feedbackIds: work.feedbackIds,
          },
        },
        {
          workId: work.id,
          goalVersion: task.goalVersion,
          status: task.status,
          issue: blocked ? issue : undefined,
          artifacts: artifacts.map((item) => ({
            id: item.id,
            hash: item.hash,
          })),
        },
      );
    }
  }
  if (
    workService?.account &&
    workService.baseURL &&
    workService.state !== "unconfigured"
  ) {
    const accountKey = digest([
      workService.baseURL,
      workService.account.user.id,
    ]).slice(0, 24);
    if (workService.error)
      add(
        {
          id: `remote:${accountKey}:connection`,
          kind: "remote",
          reason: "failed",
          title: "当前服务连接需要处理",
          summary: `${workService.error}。远端状态尚未重新确认，不能把连接失败当成没有更新。`,
          importance: "important",
          occurredAt: workService.refreshedAt ?? new Date(at).toISOString(),
          origin: { id: accountKey, artifactIds: [], feedbackIds: [] },
        },
        { error: workService.error },
      );
    for (const job of workService.jobs) {
      const local =
        workService.submissions?.[job.id]?.taskId ??
        workService.collected[job.id]?.taskId;
      // A server-provided origin is descriptive metadata, never permission to address a local task.
      const task = local ? taskMap.get(local) : undefined;
      if (task?.archivedAt) continue;
      const collected = workService.collected[job.id];
      const origin = {
        id: job.id,
        ...(task ? { taskId: task.id } : {}),
        remoteJobId: job.id,
        artifactIds: [] as string[],
        feedbackIds: [] as string[],
      };
      const lastRun = job.runs.at(-1);
      if (
        ["failed", "uncertain", "waiting"].includes(job.state) ||
        (job.state === "paused" && job.lastError)
      ) {
        const summary =
          job.lastError ||
          lastRun?.error ||
          (job.state === "uncertain"
            ? "服务器尚未确认本轮结果或用量，请先核对已有记录。"
            : "远端工作需要补充条件或处理错误。");
        add(
          {
            id: `remote:${accountKey}:${job.id}:issue`,
            kind: "remote",
            reason: job.state === "waiting" ? "waiting" : "failed",
            title: `远端 · ${job.title}`,
            summary,
            importance: "important",
            occurredAt: lastRun?.finishedAt ?? job.updatedAt,
            origin,
          },
          {
            version: job.version,
            state: job.state,
            runId: lastRun?.id,
            summary,
          },
        );
      }
      const result = job.runs.findLast(
        (run) =>
          run.state === "completed" && run.meaningful && !!run.result?.trim(),
      );
      if (result) {
        const artifact =
          collected?.runId === result.id && task?.id === collected.taskId
            ? task.artifacts.find((item) => item.id === collected.artifactId)
            : undefined;
        add(
          {
            id: `remote:${accountKey}:${job.id}:result`,
            kind: "remote",
            reason: "result",
            title: `远端 · ${job.title}`,
            summary: artifact
              ? "服务器本轮成果已收回原工作，可继续查看和修订。"
              : "服务器已保存本轮真实成果，可在远端工作记录中查看并收回本机。",
            importance: "normal",
            occurredAt: result.finishedAt ?? result.startedAt,
            origin: { ...origin, artifactIds: artifact ? [artifact.id] : [] },
          },
          { runId: result.id, resultHash: digest(result.result) },
        );
      }
    }
  }
  items.sort(
    (a, b) =>
      Number(b.importance === "important") -
        Number(a.importance === "important") ||
      b.occurredAt.localeCompare(a.occurredAt) ||
      a.id.localeCompare(b.id),
  );
  const open = items.filter((item) => item.state === "open");
  const important = open.filter((item) => item.importance === "important");
  const notifying =
    data.mode === "muted" ? [] : data.mode === "important" ? important : open;
  return {
    items,
    preferences: { revision: data.revision, mode: data.mode },
    counts: {
      open: open.length,
      important: important.length,
      snoozed: items.filter((item) => item.state === "snoozed").length,
      handled: items.filter((item) => item.state === "handled").length,
    },
    notification: {
      count: notifying.length,
      fingerprint: digest(notifying.map((item) => item.fingerprint).sort()),
      summary:
        data.mode === "muted"
          ? "已静音；原工作状态和重要问题仍在列表中。"
          : notifying.length
            ? `${notifying.length} 项工作需要留意${important.length ? `，其中 ${important.length} 项受阻或待修订` : ""}。`
            : "当前没有需要提示的新事项。",
    },
  };
}

export async function handleAttentionCommand(
  host: Pick<FeatureHost, "store">,
  raw: AttentionCommand,
  at: number = Date.now(),
  workService?: WorkServiceSnapshot,
): Promise<void> {
  const command = attentionCommandSchema.parse(raw),
    data = ledger(host.store),
    fingerprint = digest(command);
  const prior = data.receipts[command.requestId];
  if (prior) {
    if (prior !== fingerprint)
      throw new Error("同一请求不能修改为不同处理动作。");
    return;
  }
  if (command.type === "attention.preferences") {
    if (data.revision !== command.expectedRevision)
      throw new Error("通知偏好已经更新，请查看最新设置后重试。");
    data.mode = command.mode;
    data.revision += 1;
  } else {
    const item = attentionSnapshot(host.store, at, workService).items.find(
      (item) => item.id === command.itemId,
    );
    if (!item || item.fingerprint !== command.expectedFingerprint)
      throw new Error("这项工作的实际情况已经变化，请先查看最新事项。");
    if (command.action === "open") delete data.decisions[item.id];
    else {
      if (command.action === "snoozed") {
        const until = Date.parse(command.snoozedUntil!);
        if (!(until > at && until <= at + 366 * 86400000))
          throw new Error("请选择未来一年内的暂缓时间。");
      }
      data.decisions[item.id] = {
        fingerprint: item.fingerprint,
        state: command.action,
        at: new Date(at).toISOString(),
        ...(command.action === "snoozed"
          ? { until: command.snoozedUntil }
          : {}),
      };
    }
  }
  data.receipts[command.requestId] = fingerprint;
  host.store.setConfig(KEY, data);
}
