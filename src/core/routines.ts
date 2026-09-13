import { createHash, randomUUID } from "node:crypto";
import type { Source, Task } from "../shared/types.js";
import {
  ROUTINE_TEMPLATES,
  routineCommandSchema,
  type Routine,
  type RoutineCommand,
  type RoutineRun,
  type RoutineSchedule,
  type RoutineSnapshot,
} from "../shared/routines.js";
import type { FeatureHost } from "./feature-host.js";
import type { Store } from "./store.js";
import { readLibraryEntry } from "./library.js";
import { readOwnedArtifact, writeArtifactData } from "./files.js";
import { validateSkillBindings } from "./skills.js";
import { skillCatalog } from "./skill-policy.js";
import { safeModelError } from "./models.js";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function schema(store: Store) {
  store.db
    .exec(`CREATE TABLE IF NOT EXISTS routines (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS routine_requests (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL, error TEXT);`);
}
function all(store: Store): Routine[] {
  schema(store);
  return (
    store.db.prepare("SELECT body FROM routines ORDER BY rowid DESC").all() as {
      body: string;
    }[]
  ).map((row) => JSON.parse(row.body));
}
function get(store: Store, id: string): Routine {
  const row = store.db
    .prepare("SELECT body FROM routines WHERE id=?")
    .get(id) as { body: string } | undefined;
  if (!row) throw new Error("找不到这项例行工作。");
  return JSON.parse(row.body);
}
function save(store: Store, routine: Routine) {
  store.db
    .prepare(
      "INSERT INTO routines(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
    )
    .run(routine.id, JSON.stringify(routine));
}
export function routineSnapshot(store: Store): RoutineSnapshot {
  return {
    items: all(store),
    templates: ROUTINE_TEMPLATES,
    execution: {
      location: "client",
      availability: "while-client-running",
      notice:
        "客户端运行且电脑唤醒时检查和执行；在设置中启用后台继续后，关闭窗口仍可在菜单栏运行。明确退出客户端或电脑休眠期间暂停。错过多个时点只补查一轮，无新材料不调用模型。",
    },
  };
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function parts(time: number, timezone: string) {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timezone, formatter);
  }
  const result = Object.fromEntries(
    formatter.formatToParts(time).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(result.year),
    month: Number(result.month),
    day: Number(result.day),
    hour: Number(result.hour),
    minute: Number(result.minute),
  };
}
function firstWallInstant(
  date: { year: number; month: number; day: number },
  time: string,
  timezone: string,
): number {
  const [hour, minute] = time.split(":").map(Number) as [number, number];
  const midnight = Date.UTC(date.year, date.month - 1, date.day);
  const offsets = new Set<number>();
  for (const hours of [-36, -24, -12, 0, 12, 24, 36]) {
    const sample = midnight + hours * 3600000;
    const local = parts(sample, timezone);
    offsets.add(
      Date.UTC(
        local.year,
        local.month - 1,
        local.day,
        local.hour,
        local.minute,
      ) - sample,
    );
  }
  // A missing spring-forward wall time advances to the first valid minute that day.
  // A repeated autumn wall time uses its first occurrence, so daily work never runs twice.
  for (let wallMinute = hour * 60 + minute; wallMinute < 1440; wallMinute++) {
    const candidates = [...offsets]
      .map((offset) => midnight + wallMinute * 60000 - offset)
      .filter((candidate) => {
        const local = parts(candidate, timezone);
        return (
          local.year === date.year &&
          local.month === date.month &&
          local.day === date.day &&
          local.hour * 60 + local.minute === wallMinute
        );
      });
    if (candidates.length) return Math.min(...candidates);
  }
  return Infinity;
}
/** Strictly after `after`; timezone wall-clock scheduling handles DST without UI timers. */
export function nextRoutineTime(
  schedule: RoutineSchedule,
  after: Date,
): string | undefined {
  if (!Number.isFinite(after.getTime())) throw new Error("调度时间无效。");
  if (schedule.kind === "after_node") return undefined;
  if (schedule.kind === "change")
    return new Date(
      after.getTime() + schedule.pollMinutes * 60000,
    ).toISOString();
  if (schedule.cadence === "interval")
    return new Date(
      after.getTime() + schedule.everyMinutes! * 60000,
    ).toISOString();
  const start = parts(after.getTime(), schedule.timezone);
  for (let day = 0; day < 9; day++) {
    const date = new Date(
      Date.UTC(start.year, start.month - 1, start.day + day),
    );
    if (schedule.cadence === "weekly" && date.getUTCDay() !== schedule.weekday)
      continue;
    const candidate = firstWallInstant(
      {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
      },
      schedule.time!,
      schedule.timezone,
    );
    if (candidate > after.getTime() && Number.isFinite(candidate))
      return new Date(candidate).toISOString();
  }
  throw new Error("无法确定下次执行时间，请调整时区或时间。");
}
function next(routine: Routine, after: Date) {
  return routine.schedule.kind === "after_node"
    ? routine.node && routine.node.id !== routine.consumedNodeId
      ? new Date(
          Date.parse(routine.node.occurredAt) +
            routine.schedule.delayMinutes * 60000,
        ).toISOString()
      : undefined
    : nextRoutineTime(routine.schedule, after);
}
function permissions(routine: Pick<Routine, "scope" | "taskId">) {
  return hash({
    taskId: routine.taskId,
    scope: routine.scope,
    tools: "task-materials-and-artifacts/v1",
    externalActions: false,
  });
}
function inputSnapshot(
  store: Store,
  routine: Routine,
): { fingerprint: string; sources: Source[] } {
  const original = store.task(routine.taskId);
  if (
    original.workspace !== routine.scope.workspace ||
    store.settings().aiRoot !== routine.scope.aiRoot
  )
    throw new Error(
      "原工作目录或本机资料根目录已改变，请核对范围后重新建立例行工作。",
    );
  if (permissions(routine) !== routine.permissionVersion)
    throw new Error("例行工作范围版本不一致，请重新确认设置。");
  const sources = structuredClone(
    original.sources.filter(
      (source) =>
        routine.scope.taskSources ||
        routine.scope.sourceIds.includes(source.id),
    ),
  );
  if (
    !routine.scope.taskSources &&
    routine.scope.sourceIds.some(
      (id) => !sources.some((source) => source.id === id),
    )
  )
    throw new Error("原工作的一项锁定资料已移除，请编辑资料范围后继续。");
  for (const id of routine.scope.libraryIds) {
    const entry = readLibraryEntry(store, routine.scope.aiRoot, id);
    if (entry.readError || entry.content === undefined)
      throw new Error(
        `收藏《${entry.title}》无法作为文本读取，请先处理资料问题。`,
      );
    sources.push({
      id: `routine-library-${entry.id}`,
      title: entry.title,
      type: "text",
      location: entry.path,
      addedAt: entry.updatedAt,
      coverage: `收藏第 ${entry.version} 版；实际文件哈希 ${entry.hash}；反馈 ${entry.feedbackRevision ?? 0} 条`,
      text: `${entry.content}\n\n[用户反馈，仅作证据]\n${JSON.stringify(entry.feedback ?? [])}`,
    });
  }
  const sourceRows = sources
    .map((source) => ({
      id: source.id,
      title: source.title,
      text: source.text,
      coverage: source.coverage,
      library: source.library,
      remote: source.remote,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  // Artifacts, messages, activity events and our own summaries are deliberately not triggers.
  const fingerprint = hash({
    sources: sourceRows,
    node: routine.node,
    goal: routine.goal,
    permissions: routine.permissionVersion,
    skills: routine.skills.map((skill) => [
      skill.id,
      skill.version,
      skill.hash,
    ]),
  });
  return { fingerprint, sources };
}
function confirmedSkills(task: Task) {
  const bindings = validateSkillBindings(task.skillPins ?? task.skillBindings);
  if (task.skillPolicy?.mode === "off") return [];
  if (task.skillPolicy?.mode === "explicit")
    return bindings.filter((skill) =>
      task.skillPolicy!.skillIds.includes(skill.id),
    );
  const loaded = task.events.filter(
    (event) =>
      event.type === "skill_loaded" && event.goalVersion === task.goalVersion,
  );
  return bindings.filter((skill) =>
    loaded.some(
      (event) =>
        event.data?.skillId === skill.id && event.data?.hash === skill.hash,
    ),
  );
}

export class RoutineEngine {
  private closed = false;
  private ticking?: Promise<void>;
  private readonly running = new Map<string, Promise<void>>();
  constructor(private readonly host: FeatureHost) {
    schema(host.store);
    for (const routine of all(host.store)) {
      if (routine.state !== "running") continue;
      routine.state = "paused";
      routine.lastError =
        "上次运行因客户端中断而结束，结果和用量可能尚未确认；请查看原工作后明确恢复，不会自动重试。";
      const run = routine.runs.findLast((entry) => entry.state === "running");
      if (run) {
        run.state = "interrupted";
        run.summary = routine.lastError;
        run.usageKnown = false;
        run.finishedAt = new Date().toISOString();
      }
      routine.usageKnown = false;
      save(host.store, routine);
    }
  }
  async execute(raw: RoutineCommand): Promise<void> {
    if (this.closed) throw new Error("客户端执行器已经关闭。");
    const command = routineCommandSchema.parse(raw);
    const fingerprint = hash(command);
    const prior = this.host.store.db
      .prepare("SELECT * FROM routine_requests WHERE id=?")
      .get(command.requestId) as
      { fingerprint: string; state: string; error?: string } | undefined;
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new Error("同一请求编号不能用于不同的例行操作。");
      if (prior.state === "failed")
        throw new Error(prior.error ?? "上次操作未完成，请核对后重新操作。");
      return;
    }
    this.host.store.db
      .prepare(
        "INSERT INTO routine_requests(id,fingerprint,state) VALUES(?,?,'started')",
      )
      .run(command.requestId, fingerprint);
    try {
      await this.handle(command);
      this.host.store.db
        .prepare("UPDATE routine_requests SET state='completed' WHERE id=?")
        .run(command.requestId);
    } catch (error) {
      this.host.store.db
        .prepare(
          "UPDATE routine_requests SET state='failed',error=? WHERE id=?",
        )
        .run(safeModelError(error), command.requestId);
      throw error;
    }
  }
  private async handle(command: RoutineCommand) {
    const store = this.host.store,
      now = new Date();
    if (command.type === "routine.create") {
      const task = store.task(command.taskId);
      if (
        task.status !== "completed" ||
        this.host.isRunning(task.id) ||
        (!task.artifacts.length &&
          !task.messages.some((message) => message.role === "assistant"))
      )
        throw new Error("先完成一次有效工作并检查结果，再把它设为例行。");
      const template = ROUTINE_TEMPLATES.find(
        (entry) => entry.id === command.templateId,
      );
      const routine: Routine = {
        id: `routine-${hash(command.requestId).slice(0, 24)}`,
        title: command.title ?? `${task.title} · ${template?.name ?? "例行"}`,
        taskId: task.id,
        projectId: task.projectId,
        templateId: command.templateId,
        version: 1,
        state: "active",
        goal: `${task.goal}${template ? `\n\n本次例行方法：${template.goal}` : ""}`,
        kind: task.kind,
        member: task.member,
        teamMode: (task as Task & { teamMode?: "software" | "media" }).teamMode,
        schedule: command.schedule,
        limits: command.limits ?? { maxRuns: 30, maxTokens: 200000 },
        location: "client",
        scope: {
          taskSources: command.watchTaskSources ?? true,
          sourceIds: task.sources.map((source) => source.id),
          libraryIds: [...new Set(command.libraryIds ?? [])],
          aiRoot: store.settings().aiRoot,
          workspace: task.workspace,
        },
        skills: confirmedSkills(task),
        permissionVersion: "",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        runCount: 0,
        tokens: 0,
        usageKnown: true,
        runs: [],
        outputs: {},
      };
      routine.permissionVersion = permissions(routine);
      const input = inputSnapshot(store, routine);
      // Converting proven work starts with its already-processed input as the baseline.
      // Templates define a new concrete transformation and can perform its initial pass.
      if (!template) routine.lastInputFingerprint = input.fingerprint;
      routine.nextRunAt = next(routine, now);
      save(store, routine);
      return;
    }
    let routine = get(store, command.routineId);
    if (command.type === "routine.pause" || command.type === "routine.stop") {
      routine.state = command.type === "routine.stop" ? "stopped" : "paused";
      routine.updatedAt = now.toISOString();
      save(store, routine);
      if (routine.workTaskId && this.host.isRunning(routine.workTaskId))
        await this.host.stopWork(routine.workTaskId);
      await this.running.get(routine.id);
      return;
    }
    if (routine.state === "running" || this.running.has(routine.id))
      throw new Error("本轮正在执行；请暂停后再编辑或重新运行。");
    if (routine.state === "stopped" && command.type !== "routine.edit")
      throw new Error("这项例行工作已停止；如需继续，请从原工作重新建立。");
    if (command.type === "routine.edit") {
      if (command.expectedVersion !== routine.version)
        throw new Error("例行设置已变化，请刷新后编辑。");
      if (command.title !== undefined) routine.title = command.title;
      if (command.schedule) routine.schedule = command.schedule;
      if (command.limits) routine.limits = command.limits;
      if (command.libraryIds)
        routine.scope.libraryIds = [...new Set(command.libraryIds)];
      if (command.watchTaskSources !== undefined) {
        routine.scope.taskSources = command.watchTaskSources;
        routine.scope.sourceIds = store
          .task(routine.taskId)
          .sources.map((source) => source.id);
      }
      routine.version++;
      routine.permissionVersion = permissions(routine);
      inputSnapshot(store, routine);
      routine.nextRunAt = next(routine, now);
      routine.updatedAt = now.toISOString();
      save(store, routine);
      return;
    }
    if (command.type === "routine.recordNode") {
      if (routine.schedule.kind !== "after_node")
        throw new Error("这项工作不是节点后执行。");
      if (Date.parse(command.occurredAt) > now.getTime())
        throw new Error("未来的计划发布时间不是实际发布节点，不能触发复盘。");
      routine.node = {
        id: hash([command.occurredAt, command.evidence]),
        occurredAt: command.occurredAt,
        evidence: command.evidence,
        recordedAt: now.toISOString(),
      };
      routine.nextRunAt = next(routine, now);
      routine.updatedAt = now.toISOString();
      save(store, routine);
      return;
    }
    if (command.type === "routine.resume") {
      if (routine.location === "server")
        throw new Error(
          "这条旧记录没有创建远端委托。请在原工作的“委托远端处理”中建立服务端例行，再停止这条记录。",
        );
      if (
        routine.runCount >= routine.limits.maxRuns ||
        routine.tokens >= routine.limits.maxTokens
      )
        throw new Error("已经达到运行上限，请先调整上限。");
      routine.state = "active";
      routine.lastError = undefined;
      routine.nextRunAt = next(routine, now);
      routine.updatedAt = now.toISOString();
      save(store, routine);
      return;
    }
    if (command.type === "routine.run") {
      if (routine.location === "server")
        throw new Error(
          "这条旧记录没有创建远端委托，请在原工作的“委托远端处理”中建立服务端例行。",
        );
      if (routine.state === "paused" || routine.state === "failed")
        throw new Error("请先明确恢复这项例行工作，再立即运行。");
      if (
        routine.schedule.kind === "after_node" &&
        (!routine.node || routine.node.id === routine.consumedNodeId)
      )
        throw new Error("还没有新的实际发布节点，不能用计划日期代替。");
      if (
        routine.schedule.kind === "after_node" &&
        routine.nextRunAt &&
        Date.parse(routine.nextRunAt) > now.getTime()
      )
        throw new Error("实际节点后的等待时间尚未到达。");
      await this.start(routine.id, "manual", now);
    }
  }
  tick(now = new Date()): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.ticking) return this.ticking;
    const pending = this.checkDue(now).finally(() => {
      if (this.ticking === pending) this.ticking = undefined;
    });
    this.ticking = pending;
    return pending;
  }
  private async checkDue(now: Date) {
    for (const routine of all(this.host.store)) {
      if (this.closed) return;
      if (
        routine.state !== "active" ||
        routine.location !== "client" ||
        !routine.nextRunAt ||
        Date.parse(routine.nextRunAt) > now.getTime()
      )
        continue;
      await this.start(
        routine.id,
        routine.schedule.kind === "change"
          ? "change"
          : routine.schedule.kind === "after_node"
            ? "node"
            : "schedule",
        now,
      );
    }
  }
  private start(
    id: string,
    trigger: RoutineRun["trigger"],
    now: Date,
  ): Promise<void> {
    const previous = this.running.get(id);
    if (previous) return previous;
    const pending = this.perform(id, trigger, now).finally(() =>
      this.running.delete(id),
    );
    this.running.set(id, pending);
    return pending;
  }
  private async perform(id: string, trigger: RoutineRun["trigger"], now: Date) {
    const store = this.host.store;
    let routine = get(store, id);
    if (!["active", "waiting"].includes(routine.state)) return;
    if (
      routine.runCount >= routine.limits.maxRuns ||
      routine.tokens >= routine.limits.maxTokens
    ) {
      routine.state = "paused";
      routine.lastError = "已达到运行次数或累计 token 上限，后续执行已暂停。";
      save(store, routine);
      return;
    }
    let input: ReturnType<typeof inputSnapshot>;
    try {
      input = inputSnapshot(store, routine);
    } catch (error) {
      routine.state = "waiting";
      routine.lastError = safeModelError(error);
      save(store, routine);
      return;
    }
    routine.lastCheckedAt = now.toISOString();
    routine.nextRunAt = next(routine, now);
    const run: RoutineRun = {
      id: randomUUID(),
      startedAt: now.toISOString(),
      trigger,
      state: "running",
      inputFingerprint: input.fingerprint,
      version: routine.version,
      skillHashes: routine.skills.map((skill) => skill.hash),
      tokens: 0,
      usageKnown: true,
      sourceIds: input.sources.map((source) => source.id),
      artifactIds: [],
      summary: "正在检查新材料。",
      meaningful: false,
    };
    if (input.fingerprint === routine.lastInputFingerprint) {
      run.state = "unchanged";
      run.finishedAt = now.toISOString();
      run.summary = "输入没有变化，未调用模型。";
      if (routine.node) routine.consumedNodeId = routine.node.id;
      routine.nextRunAt = next(routine, now);
      routine.runs = [...routine.runs, run].slice(-200);
      save(store, routine);
      return;
    }
    if (this.host.isRunning(routine.taskId)) {
      routine.lastError = "原工作正在进行，等待它结束后再运行例行工作。";
      save(store, routine);
      return;
    }
    if (!input.sources.some((source) => source.text.trim())) {
      routine.state = "waiting";
      routine.lastError =
        "本轮尚无可读取的资料，等待原工作或选定收藏提供正文。";
      save(store, routine);
      return;
    }
    const enabled = skillCatalog(store);
    if (
      routine.skills.some(
        (skill) =>
          !enabled.some((entry) => entry.id === skill.id && entry.enabled),
      )
    ) {
      routine.state = "waiting";
      routine.lastError =
        "本例行工作确认过的方法已停用；请核对方法设置并明确恢复。";
      save(store, routine);
      return;
    }
    routine.state = "running";
    routine.runCount++;
    routine.runs = [...routine.runs, run].slice(-200);
    routine.lastError = undefined;
    save(store, routine);
    let beforeEvents: Set<string> | undefined;
    let usageApplied = false;
    const accountUsage = () => {
      if (usageApplied || !beforeEvents || !routine.workTaskId) return;
      const usage = store
        .task(routine.workTaskId)
        .events.filter(
          (event) =>
            !beforeEvents!.has(event.id) && event.type === "model_usage",
        );
      run.tokens = usage.reduce(
        (total, event) =>
          total +
          (typeof event.data?.totalTokens === "number"
            ? Math.max(0, event.data.totalTokens)
            : 0),
        0,
      );
      run.usageKnown =
        usage.length > 0 &&
        usage.every((event) => typeof event.data?.totalTokens === "number");
      routine.tokens += run.tokens;
      routine.usageKnown &&= run.usageKnown;
      usageApplied = true;
    };
    try {
      if (!routine.workTaskId) {
        const work = await this.host.createWork({
          requestId: `routine-worker:${id}`,
          isolatedContext: true,
          title: `例行 · ${routine.title}`,
          goal: routine.goal,
          member: routine.member,
          kind: routine.kind,
          projectId: routine.projectId,
          teamMode: routine.teamMode,
          skillPins: routine.skills,
          skillPolicy: routine.skills.length
            ? {
                mode: "explicit",
                skillIds: routine.skills.map((skill) => skill.id),
              }
            : { mode: "off", skillIds: [] },
        });
        routine = get(store, id);
        routine.workTaskId = work.id;
        save(store, routine);
      }
      const original = store.task(routine.taskId);
      const originalGoalVersion = original.goalVersion;
      const work = store.task(routine.workTaskId!);
      beforeEvents = new Set(work.events.map((event) => event.id));
      work.surface = "background";
      work.goalVersion++;
      work.status = "idle";
      work.error = undefined;
      work.sources = input.sources;
      work.skillPins = structuredClone(routine.skills);
      work.skillBindings = structuredClone(routine.skills);
      work.skillPolicy = routine.skills.length
        ? {
            mode: "explicit",
            skillIds: routine.skills.map((skill) => skill.id),
          }
        : { mode: "off", skillIds: [] };
      work.goal = `${routine.goal}\n\n这是一项已确认的例行工作。只处理本轮新资料和变化，成果应保存为可接续版本；没有实质变化时明确说明，不制造进展。沿用上次同一成果 ID。外部发布、发消息、执行任意命令不在本轮权限中。${routine.node ? `\n实际发布记录：${JSON.stringify(routine.node)}` : ""}`;
      store.saveTask(work);
      store.saveCheckpoint(work.id, null);
      const currentState = get(store, id).state;
      if (currentState !== "running" || this.closed)
        throw new Error("例行工作在开始模型调用前已暂停。");
      await this.host.runWork(work.id);
      const finished = store.task(work.id);
      routine = get(store, id);
      accountUsage();
      if (finished.status !== "completed")
        throw new Error(
          finished.error ??
            `执行停在${finished.status === "waiting" ? "等待补充" : "未完成"}状态；已保存的成果保留。`,
        );
      if (store.task(routine.taskId).goalVersion !== originalGoalVersion)
        throw new Error(
          "原工作目标在执行期间变化，本轮结果保留在例行记录中，未覆盖原工作。",
        );
      for (const artifact of finished.artifacts) {
        const currentState = get(store, id).state;
        if (currentState !== "running" || this.closed)
          throw new Error(
            "例行工作已经暂停，模型已有结果保留，未开始后续写回。",
          );
        const prior = routine.outputs[artifact.id];
        if (prior?.sourceHash === artifact.hash) continue;
        const content = await readOwnedArtifact(artifact, finished.workspace);
        const copied = await writeArtifactData(store, routine.taskId, {
          title: artifact.title,
          content,
          format: artifact.format,
          goalVersion: originalGoalVersion,
          artifactId: prior?.artifactId,
          expectedHash: prior?.hash,
          operationId: `routine-output:${run.id}:${artifact.id}:${artifact.hash}`,
        });
        routine.outputs[artifact.id] = {
          artifactId: copied.id,
          hash: copied.hash,
          sourceHash: artifact.hash,
        };
        run.artifactIds.push(copied.id);
        routine.state = get(store, id).state;
        save(store, routine);
      }
      run.state = "completed";
      run.meaningful = run.artifactIds.length > 0;
      const message = finished.messages.findLast(
        (entry) =>
          entry.role === "assistant" &&
          entry.goalVersion === finished.goalVersion,
      )?.content;
      run.summary = run.meaningful
        ? (message?.slice(0, 1200) ?? "新增成果已回到原工作。")
        : "本轮检查完成，没有产生新的成果版本。";
      if (run.meaningful)
        store.event(routine.taskId, {
          type: "routine.result",
          member: routine.member,
          goalVersion: originalGoalVersion,
          summary: `例行工作《${routine.title}》有新结果。`,
          data: {
            routineId: id,
            routineRunId: run.id,
            artifactIds: run.artifactIds,
            summary: run.summary,
            tokens: run.tokens,
            usageKnown: run.usageKnown,
          },
        });
      routine.lastInputFingerprint = input.fingerprint;
      if (routine.node) routine.consumedNodeId = routine.node.id;
      routine.nextRunAt = next(routine, now);
      if (routine.state === "running") routine.state = "active";
      if (!run.usageKnown) {
        routine.state = "paused";
        routine.lastError =
          "本轮用量未完整返回，累计 token 上限无法确认；请检查后明确恢复。";
      } else if (
        routine.runCount >= routine.limits.maxRuns ||
        routine.tokens >= routine.limits.maxTokens
      ) {
        routine.state = "paused";
        routine.lastError = "已达到运行次数或累计 token 上限。";
      }
    } catch (error) {
      try {
        accountUsage();
      } catch {
        run.usageKnown = false;
        routine.usageKnown = false;
      }
      const latest = get(store, id);
      routine.state = ["paused", "stopped"].includes(latest.state)
        ? latest.state
        : "failed";
      run.state = routine.state === "failed" ? "failed" : "interrupted";
      routine.lastError = safeModelError(error);
      run.summary = routine.lastError;
      run.meaningful = true;
      try {
        store.event(routine.taskId, {
          type: "routine.attention",
          member: routine.member,
          goalVersion: store.task(routine.taskId).goalVersion,
          summary: `例行工作《${routine.title}》需要处理。`,
          data: {
            routineId: id,
            routineRunId: run.id,
            reason: routine.lastError,
          },
        });
      } catch {
        /* The original task may have been removed. */
      }
    } finally {
      run.finishedAt = new Date().toISOString();
      const index = routine.runs.findIndex((entry) => entry.id === run.id);
      if (index >= 0) routine.runs[index] = run;
      routine.updatedAt = run.finishedAt;
      save(store, routine);
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const routine of all(this.host.store)) {
      if (routine.state !== "running") continue;
      routine.state = "paused";
      routine.lastError =
        "客户端执行器已退出，本轮执行已暂停；下次启动后请核对结果并明确恢复。";
      save(this.host.store, routine);
      if (routine.workTaskId) await this.host.stopWork(routine.workTaskId);
    }
    await Promise.allSettled([...this.running.values()]);
  }
}
