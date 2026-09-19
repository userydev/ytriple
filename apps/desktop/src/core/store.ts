import { Skills } from "./skills";
import { captureTools } from "./tool-contract";
import type { WorkspaceData } from "./backup-contract";
import type { Schedule } from "./schedule-contract";
import { resultKind, outputLabels } from "./output";
import {
  initializationSummary,
  type InitializationPlan,
} from "./project-initialization";
import { captureProjectContext } from "./projects";
import {
  defaultLayout,
  layoutSchema,
  viewSchema,
  type Layout,
  type WorkView,
} from "./view";
import {
  radarViewSchema,
  type RadarView,
} from "./radar-contract";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { defaultTeam, defaultWorkflow, adaptiveWorkflow, workbenchTeam, workbenchWorkflow } from "./types";
import { workspaceContextSchema, type WorkspaceContext } from "./workspace-context";
import {
  teamSchema,
  workflowSchema,
  checkCompatibility,
  versionKey,
} from "./configuration";
import type {
  Asset,
  ArtifactVersion,
  ArtifactCandidate,
  Contribution,
  Delivery,
  Draft,
  Material,
  Message,
  Project,
  Run,
  Snapshot,
  SubmitInput,
  Work,
  Team,
  Workflow,
  Reference,
} from "./types";
const now = () => new Date().toISOString();
export class Store {
  private db: DatabaseSync;
  private transactionDepth = 0;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS entities(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS submissions(key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,run_id TEXT NOT NULL);
      PRAGMA user_version=1;`);
  }
  initializeConfiguration() {
    const { team, workflow } = this.configuration();
    const untouched = JSON.stringify(team) === JSON.stringify(defaultTeam) &&
      [defaultWorkflow, adaptiveWorkflow].some((w) => JSON.stringify(w) === JSON.stringify(workflow));
    // Upgrade only the untouched built-in default. Existing work and custom
    // teams retain their own definitions; schedules keep their authorization.
    if (!untouched) return;
    this.transaction(() => {
      for (const work of this.all<Work>("work")) {
        const pinned = this.configuration(work.id);
        this.put("team", versionKey(pinned.team), pinned.team);
        this.put("workflow", versionKey(pinned.workflow), pinned.workflow);
        this.put("work", work.id, { ...work,
          teamKey: work.teamKey ?? versionKey(pinned.team),
          workflowKey: work.workflowKey ?? versionKey(pinned.workflow) });
      }
      this.selectConfiguration(null, versionKey(workbenchTeam), versionKey(workbenchWorkflow));
    });
  }
  configuration(workId?: string) {
    const work = workId ? this.require<Work>("work", workId) : undefined;
    const previous = workId
      ? this.all<Run>("run")
          .filter((r) => r.workId === workId)
          .at(-1)
      : undefined;
    return {
      team: work?.teamKey
        ? this.require<Team>("team", work.teamKey)
        : (previous?.team ?? this.get<Team>("meta", "team") ?? defaultTeam),
      workflow: work?.workflowKey
        ? this.require<Workflow>("workflow", work.workflowKey)
        : (previous?.workflow ??
          this.get<Workflow>("meta", "workflow") ??
          defaultWorkflow),
    };
  }
  configurationVersions() {
    const current = this.configuration();
    const teams = new Map(
      [
        defaultTeam,
        workbenchTeam,
        current.team,
        ...this.all<Run>("run").map((r) => r.team),
        ...this.all<Team>("team"),
      ].map((t) => [versionKey(t), t]),
    );
    const workflows = new Map(
      [
        defaultWorkflow,
        adaptiveWorkflow,
        workbenchWorkflow,
        current.workflow,
        ...this.all<Run>("run").map((r) => r.workflow),
        ...this.all<Workflow>("workflow"),
      ].map((w) => [versionKey(w), w]),
    );
    return { teams: [...teams.values()], workflows: [...workflows.values()] };
  }
  saveTeam(input: Team) {
    const parsed = teamSchema.parse(input);
    return this.transaction(() => {
      const history = this.configurationVersions().teams.filter(
        (t) => t.id === parsed.id,
      );
      if (Math.max(...history.map((t) => t.version), 0) !== parsed.version)
        throw Error("团队已有新版本，请重新打开后编辑");
      for (const old of history) this.put("team", versionKey(old), old);
      const next = { ...parsed, version: parsed.version + 1 };
      return this.put("team", versionKey(next), next);
    });
  }
  saveWorkflow(input: Workflow) {
    const parsed = workflowSchema.parse(input);
    return this.transaction(() => {
      const history = this.configurationVersions().workflows.filter(
        (w) => w.id === parsed.id,
      );
      if (Math.max(...history.map((w) => w.version), 0) !== parsed.version)
        throw Error("流程已有新版本，请重新打开后编辑");
      for (const old of history) this.put("workflow", versionKey(old), old);
      const next = { ...parsed, version: parsed.version + 1 };
      return this.put("workflow", versionKey(next), next);
    });
  }
  selectConfiguration(
    workId: string | null,
    teamKey: string,
    workflowKey: string,
  ) {
    return this.transaction(() => {
      const history = this.configurationVersions();
      const team = history.teams.find((t) => versionKey(t) === teamKey),
        workflow = history.workflows.find((w) => versionKey(w) === workflowKey);
      if (!team || !workflow) throw Error("所选配置版本不存在");
      checkCompatibility(team, workflow);
      this.put("team", teamKey, team);
      this.put("workflow", workflowKey, workflow);
      if (workId) {
        const work = this.require<Work>("work", workId);
        this.put("work", workId, { ...work, teamKey, workflowKey });
      } else {
        this.put("meta", "team", team);
        this.put("meta", "workflow", workflow);
      }
    });
  }
  updateWork(
    workId: string,
    title: string,
    projectId: string | null,
    deliveryId: string | null,
  ) {
    return this.transaction(() => {
      const work = this.require<Work>("work", workId);
      if (!title.trim() || title.trim().length > 200)
        throw Error("工作名称需为 1–200 个字符");
      if (projectId) this.require("project", projectId);
      if (
        deliveryId &&
        this.require<Delivery>("delivery", deliveryId).projectId !== projectId
      )
        throw Error("交付不属于所选项目");
      const moving =
        work.projectId !== projectId || work.deliveryId !== deliveryId;
      if (moving) {
        if (
          this.all<Run>("run").some(
            (r) =>
              r.workId === workId &&
              ["queued", "running", "waiting", "unknown"].includes(r.status),
          )
        )
          throw Error("请先处理该工作的未结束运行与待发补充，再调整归属");
        const adopted = this.all<Delivery>("delivery").some(
          (d) =>
            d.adoptedVersionId &&
            this.get<ArtifactVersion>("version", d.adoptedVersionId)?.workId ===
              workId,
        );
        if (adopted)
          throw Error(
            "该工作的成果已被交付采用；请先在原交付解除采用，再调整归属",
          );
      }
      const next = {
        ...work,
        title: title.trim(),
        projectId,
        deliveryId,
        updatedAt: now(),
      };
      this.put("work", workId, next);
      const draft = this.get<Draft>("draft", workId);
      if (draft) this.put("draft", workId, { ...draft, projectId });
      return next;
    });
  }
  clearAdoption(deliveryId: string, expectedVersionId: string) {
    const d = this.require<Delivery>("delivery", deliveryId);
    if (d.adoptedVersionId !== expectedVersionId)
      throw Error("采用版本已变化，请重新查看交付");
    this.put("delivery", deliveryId, { ...d, adoptedVersionId: null });
  }
  saveLayout(layout: Layout) {
    return this.put("meta", "layout", layoutSchema.parse(layout));
  }
  saveView(view: WorkView) {
    const value = viewSchema.parse(view);
    if (value.versionId) {
      const v = this.require<ArtifactVersion>("version", value.versionId);
      if (v.workId !== value.id) throw Error("版本不属于该工作");
    }
    return this.put("view", value.id, value);
  }
  saveRadarView(view: RadarView) {
    return this.put("meta", "radar-view", radarViewSchema.parse(view));
  }
  close() {
    this.db.close();
  }
  exportState(): WorkspaceData {
    return this.transaction(() => ({
      entities: this.db
        .prepare("SELECT kind,id,data FROM entities ORDER BY rowid")
        .all() as WorkspaceData["entities"],
      submissions: this.db
        .prepare(
          "SELECT key,fingerprint,run_id FROM submissions ORDER BY rowid",
        )
        .all() as WorkspaceData["submissions"],
    }));
  }
  restoreState(data: WorkspaceData) {
    this.transaction(() => {
      if (
        Number(
          this.db.prepare("SELECT count(*) AS n FROM entities").get()!.n,
        ) ||
        Number(
          this.db.prepare("SELECT count(*) AS n FROM submissions").get()!.n,
        )
      )
        throw Error("只能恢复到新的空工作空间");
      const entity = this.db.prepare(
        "INSERT INTO entities(kind,id,data) VALUES(?,?,?)",
      );
      const submission = this.db.prepare(
        "INSERT INTO submissions(key,fingerprint,run_id) VALUES(?,?,?)",
      );
      for (const row of data.entities) entity.run(row.kind, row.id, row.data);
      for (const row of data.submissions)
        submission.run(row.key, row.fingerprint, row.run_id);
    });
  }
  transaction<T>(fn: () => T): T {
    const depth = this.transactionDepth++;
    const point = `nested_${depth}`;
    try {
      this.db.exec(depth ? `SAVEPOINT ${point}` : "BEGIN IMMEDIATE");
      const value = fn();
      this.db.exec(depth ? `RELEASE SAVEPOINT ${point}` : "COMMIT");
      return value;
    } catch (e) {
      if (this.db.isTransaction) {
        if (depth) {
          this.db.exec(`ROLLBACK TO SAVEPOINT ${point}`);
          this.db.exec(`RELEASE SAVEPOINT ${point}`);
        } else this.db.exec("ROLLBACK");
      }
      throw e;
    } finally {
      this.transactionDepth--;
    }
  }
  all<T>(kind: string): T[] {
    return (
      this.db
        .prepare("SELECT data FROM entities WHERE kind=? ORDER BY rowid")
        .all(kind) as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }
  get<T>(kind: string, id: string): T | undefined {
    const r = this.db
      .prepare("SELECT data FROM entities WHERE kind=? AND id=?")
      .get(kind, id) as { data: string } | undefined;
    return r ? JSON.parse(r.data) : undefined;
  }
  put<T>(kind: string, id: string, data: T) {
    this.db
      .prepare(
        "INSERT INTO entities VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
      )
      .run(kind, id, JSON.stringify(data));
    return data;
  }
  remove(kind: string, id: string) {
    this.db.prepare("DELETE FROM entities WHERE kind=? AND id=?").run(kind, id);
  }
  require<T>(kind: string, id: string): T {
    const item = this.get<T>(kind, id);
    if (!item) throw Error("对象不存在或已被移除");
    return item;
  }
  snapshot(): Omit<Snapshot, "service"> {
    return {
      workspaceActions: this.all("workspace-action"),
      workspacePolicy: this.get("meta", "workspace-policy") ?? { direct: false },
      feeds: this.all("feed"),
      feedChecks: this.all("feed-check"),
      schedules: this.all("schedule"),
      scheduleOccurrences: this.all("schedule-occurrence"),
      modelCalls: this.all("model-call"),
      radar: {
        watches: this.all("radar-watch"),
        checks: this.all("radar-auto-check"),
        topics: this.all("radar-topic"),
        editions: this.all("radar-edition"),
        jobs: this.all("radar-job"),
        reading: this.all("radar-reading"),
        view: this.get("meta", "radar-view"),
      },
      ...this.configurationVersions(),
      layout: this.get<Layout>("meta", "layout") ?? defaultLayout,
      views: this.all<WorkView>("view"),
      works: this.all<Work>("work"),
      projects: this.all<Project>("project"),
      outcomes: this.all("outcome"),
      skills: this.all("skill"),
      skillStates: this.all("skill-state"),
      skillAdoptions: this.all("skill-adoption"),
      projectInspections: this.all("project-inspection"),
      suggestionDocuments: this.all("suggestion-document"),
      suggestionReceipts: this.all("suggestion-receipt"),
      initializations: this.all<InitializationPlan>("initialization").map(
        initializationSummary,
      ),
      projectBriefs: this.all("project-brief"),
      projectStandards: this.all("project-standard"),
      localRoots: this.get("meta", "local-roots") ?? {
        aiPath: null,
        codePath: null,
      },
      localInventory: this.get("meta", "local-inventory") ?? null,
      deliveries: this.all<Delivery>("delivery"),
      drafts: this.all<Draft>("draft"),
      messages: this.all<Message>("message"),
      runs: this.all<Run>("run"),
      contributions: this.all<Contribution>("contribution"),
      versions: this.all<ArtifactVersion>("version"),
      candidates: this.all("candidate"),
      decisions: this.all("decision"),
      materials: this.all<Material>("material"),
      assets: this.all<Asset>("asset"),
      sources: this.get("meta", "sources") ?? [],
      team: this.get<Team>("meta", "team") ?? defaultTeam,
      workflow: this.get<Workflow>("meta", "workflow") ?? defaultWorkflow,
    };
  }
  saveDraft(input: Omit<Draft, "updatedAt">) {
    if (input.id !== "new" && !input.id.startsWith("new:"))
      this.require<Work>("work", input.id);
    const previous = this.get<Draft>("draft", input.id);
    const prepared = input.preparedProcess ?? previous?.preparedProcess;
    const preparedProcess =
      prepared && input.refs.some((r) => r.materialId === prepared.materialId)
        ? prepared
        : undefined;
    return this.put("draft", input.id, {
      ...input,
      workspaceContext: input.workspaceContext ?? previous?.workspaceContext,
      teamKey: input.teamKey ?? previous?.teamKey,
      workflowKey: input.workflowKey ?? previous?.workflowKey,
      skillKeys: input.skillKeys ?? previous?.skillKeys,
      preparedProcess,
      updatedAt: now(),
    });
  }
  captureWorkspaceContext(raw?: WorkspaceContext): WorkspaceContext | undefined {
    if (!raw) return undefined;
    const context = workspaceContextSchema.parse(raw);
    const current = this.require<{ revision: number }>(context.kind, context.id);
    return { ...context, revision: current.revision };
  }
  prepareWorkspaceChat(context: string, text: string, target?: WorkspaceContext) {
    return this.transaction(() => {
      const existing = this.get<Draft>("draft", context);
      if (existing?.text.trim() && existing.text !== text)
        throw Error("这里还有未发送的草稿，请先发送或另开一次交流");
      const isNew = context === "new" || context.startsWith("new:");
      const work = isNew ? undefined : this.require<Work>("work", context);
      if (work?.workspaceContext && target &&
          (work.workspaceContext.id !== target.id || work.workspaceContext.kind !== target.kind))
        throw Error("这段交流已关联其他对象，请另开交流");
      const selected = this.configuration(work?.id);
      let { team, workflow } = selected;
      const coordinator = workflow.stages.at(-1)?.role ?? team.members[0].id;
      if (!team.members.some((m) => m.id === coordinator && m.toolKeys?.includes("builtin.workspace@1"))) {
        const id = `${team.id.slice(0, 65)}-workbench`;
        const latest = this.configurationVersions().teams.filter((t) => t.id === id).sort((a,b) => b.version-a.version)[0];
        team = teamSchema.parse({ ...team, id, version: (latest?.version ?? 0) + 1,
          members: team.members.map((m) => m.id === coordinator ? {
            ...m, toolKeys: [...new Set([...(m.toolKeys ?? []), "builtin.workspace@1" as const])],
            instruction: `${m.instruction}\n作为本次工作的对接者，简单操作先读取真实状态并使用工作台能力办理，只在需要时委派，不用文字代替执行结果。`,
          } : m),
        });
        this.put("team", versionKey(team), team);
      }
      // This conversation opts into the new capability; historical runs and
      // user-customized workspace defaults keep their pinned definitions.
      const flowId = `${workflow.id.slice(0, 65)}-workbench`;
      const latestFlow = this.configurationVersions().workflows.filter((w) => w.id === flowId).sort((a,b) => b.version-a.version)[0];
      workflow = workflowSchema.parse({ ...workbenchWorkflow, id: flowId,
        version: (latestFlow?.version ?? 0) + 1,
        stages: [{ ...workbenchWorkflow.stages[0], role: coordinator }],
      });
      this.put("workflow", versionKey(workflow), workflow);
      const workspaceContext = this.captureWorkspaceContext(target ?? work?.workspaceContext ?? existing?.workspaceContext);
      if (work) {
        if (this.all<Run>("run").some((r) => r.workId === work.id && ["queued","running","waiting","unknown"].includes(r.status)))
          throw Error("原工作尚未结束，请先处理当前运行");
        this.selectConfiguration(work.id, versionKey(team), versionKey(workflow));
        this.put("work", work.id, { ...this.require<Work>("work", work.id), workspaceContext });
      }
      return this.saveDraft({ id: context, text, refs: existing?.refs ?? [],
        recipient: null, projectId: work?.projectId ?? existing?.projectId ?? null,
        outputMode: "explanation", workspaceContext,
        teamKey: versionKey(team), workflowKey: versionKey(workflow),
      });
    });
  }
  setWorkState(
    workId: string,
    action: "complete" | "reopen" | "archive" | "restore",
  ) {
    return this.transaction(() => {
      const work = this.require<Work>("work", workId);
      if (
        ["archive", "complete"].includes(action) &&
        this.all<Run>("run").some(
          (r) =>
            r.workId === workId &&
            ["queued", "running", "waiting", "unknown"].includes(r.status),
        )
      )
        throw Error("工作仍有未结束或待核对的运行，请先处理运行与待发内容");
      if (
        action === "complete" &&
        this.all<ArtifactCandidate>("candidate").some(
          (c) => c.workId === workId && c.status === "pending",
        )
      )
        throw Error("还有待整理的生成内容，请先处理或明确搁置");
      const updated = { ...work, updatedAt: now() };
      if (action === "archive") updated.archived = true;
      if (action === "restore") updated.archived = false;
      if (action === "complete") updated.completedAt = now();
      if (action === "reopen") {
        updated.completedAt = null;
        updated.archived = false;
      }
      this.put("work", workId, updated);
      if (action === "archive" || action === "complete")
        for (const schedule of this.all<Schedule>("schedule"))
          if (schedule.workId === workId && schedule.enabled)
            this.put("schedule", schedule.id, {
              ...schedule,
              enabled: false,
              nextAt: null,
              issue: null,
              pauseReason:
                action === "archive"
                  ? "原工作已归档，后续触发已暂停"
                  : "原工作已完成，后续触发已暂停",
              updatedAt: now(),
            });
      this.put("work-event", randomUUID(), {
        workId,
        action,
        createdAt: now(),
      });
      return updated;
    });
  }
  createProject(name: string, goal: string, kind: Project["kind"]) {
    const p: Project = {
      id: randomUUID(),
      name: name.trim(),
      goal: goal.trim(),
      kind,
      createdAt: now(),
    };
    if (!p.name) throw Error("请填写项目名称");
    return this.put("project", p.id, p);
  }
  createDelivery(projectId: string, title: string) {
    this.require("project", projectId);
    if (!title.trim()) throw Error("请填写交付名称");
    const d: Delivery = {
      id: randomUUID(),
      projectId,
      title: title.trim(),
      adoptedVersionId: null,
    };
    return this.put("delivery", d.id, d);
  }
  material(reference: Reference) {
    return this.require<Material>(
      "material",
      `${reference.materialId}@${reference.version}`,
    );
  }
  addMaterial(
    title: string,
    body: string,
    coverage = "local_text",
    url?: string,
  ) {
    const m: Material = {
      id: randomUUID(),
      version: 1,
      title,
      body,
      coverage,
      url,
      createdAt: now(),
    };
    return this.put("material", `${m.id}@1`, m);
  }
  submit(input: SubmitInput, serviceScope?: string): Run {
    if (!input.text.trim()) throw Error("写下想让团队做的事");
    if (Buffer.byteLength(input.text) > 16000)
      throw Error("目标过长，请将长文添加为材料");
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    return this.transaction(() => {
      const old = this.db
        .prepare("SELECT fingerprint,run_id FROM submissions WHERE key=?")
        .get(input.key) as { fingerprint: string; run_id: string } | undefined;
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw Error("同一提交标识不能用于不同内容");
        return this.require<Run>("run", old.run_id);
      }
      input.refs.forEach((r) => {
        const m = this.material(r);
        if (m.readError) throw Error(`材料尚未就绪：${m.title}`);
        if (r.excerpt && !m.body.includes(r.excerpt))
          throw Error("选段不属于指定材料版本");
      });
      if (input.projectId) this.require("project", input.projectId);
      const isNew = input.context === "new" || input.context.startsWith("new:");
      const prepared = this.get<Draft>("draft", input.context);
      const work: Work = isNew
        ? {
            keepResearchReferences: input.context.startsWith("new:radar:"),
            id: randomUUID(),
            title:
              input.projectId &&
              input.context === `new:project-reading:${input.projectId}`
                ? `理解项目 · ${this.require<Project>("project", input.projectId).name}`
                : input.text.trim().slice(0, 44),
            projectId: input.projectId,
            deliveryId: input.deliveryId ?? null,
            createdAt: now(),
            updatedAt: now(),
            archived: false,
            queuePaused: false,
            teamKey: prepared?.teamKey,
            workflowKey: prepared?.workflowKey,
          }
        : this.require("work", input.context);
      if (
        this.all<Run>("run").some(
          (r) => r.workId === work.id && r.status === "waiting",
        )
      )
        throw Error(
          "这项工作正在等待答复，请回答原问题或停止此轮后再发送新目标",
        );
      if (work.deliveryId) {
        const d = this.require<Delivery>("delivery", work.deliveryId);
        if (d.projectId !== work.projectId) throw Error("交付不属于该项目");
      }
      const selected = this.configuration(isNew ? undefined : work.id);
      const team = work.teamKey ? this.require<Team>("team", work.teamKey) : selected.team;
      const workflow = work.workflowKey ? this.require<Workflow>("workflow", work.workflowKey) : selected.workflow;
      const requestedContext = input.workspaceContext ?? prepared?.workspaceContext;
      if (work.workspaceContext && requestedContext &&
          (work.workspaceContext.id !== requestedContext.id || work.workspaceContext.kind !== requestedContext.kind))
        throw Error("这段交流的对象不能在发送时切换，请另开交流");
      work.workspaceContext = this.captureWorkspaceContext(work.workspaceContext ?? requestedContext);
      checkCompatibility(team, workflow);
      // New work pins both definitions. Later default edits do not migrate it.
      work.teamKey ??= versionKey(team);
      work.workflowKey ??= versionKey(workflow);
      this.put("team", versionKey(team), team);
      this.put("workflow", versionKey(workflow), workflow);
      if (
        input.recipient &&
        !team.members.some((m) => m.id === input.recipient)
      )
        throw Error("当前团队中没有这位成员");
      if (
        workflow.stages.some((s) => !team.members.some((m) => m.id === s.role))
      )
        throw Error("团队与流程不兼容");
      const versions = this.all<ArtifactVersion>("version").filter(
        (v) =>
          v.workId === work.id &&
          (v.kind ?? "result") === resultKind(input.outputMode),
      );
      const run: Run = {
        workspacePolicy: this.get("meta", "workspace-policy") ?? { direct: false },
        workspaceContext: work.workspaceContext ? structuredClone(work.workspaceContext) : undefined,
        tools: captureTools(team),
        schedule: input.schedule,
        id: randomUUID(),
        workId: work.id,
        text: input.text.trim(),
        outputMode: input.outputMode,
        refs: input.refs,
        recipient: input.recipient,
        skills: new Skills(this).capture(input.skillKeys ?? [], team),
        requestedSkillKeys: input.skillKeys ?? [],
        status: "queued",
        error: null,
        createdAt: now(),
        team: structuredClone(team),
        workflow: structuredClone(workflow),
        baseVersionId: versions.at(-1)?.id ?? null,
        submissionKey: input.key,
        serviceScope,
        projectContext: captureProjectContext(
          this,
          work.projectId,
          work.deliveryId,
        ),
      };
      work.updatedAt = now();
      if (work.archived || work.completedAt)
        this.put("work-event", randomUUID(), {
          workId: work.id,
          action: "reopened-by-send",
          createdAt: now(),
        });
      work.archived = false;
      work.completedAt = null;
      this.put("work", work.id, work);
      if (
        isNew &&
        input.projectId &&
        input.context === `new:project-reading:${input.projectId}`
      )
        this.put("project-reading-work", input.projectId, { workId: work.id });
      if (isNew) {
        const view = this.get<WorkView>("view", input.context);
        if (view)
          this.put("view", work.id, { ...view, id: work.id, versionId: null });
      }
      this.put("run", run.id, run);
      this.put<Message>("message", run.id, {
        id: run.id,
        workId: work.id,
        runId: run.id,
        role: "user",
        body: run.text,
        refs: run.refs,
        createdAt: now(),
      });
      this.db
        .prepare("INSERT INTO submissions VALUES(?,?,?)")
        .run(input.key, fingerprint, run.id);
      // A late submission may not erase a newer draft edited while IPC was pending.
      const draft = this.get<Draft>("draft", input.context);
      if (
        !input.schedule &&
        (draft?.outputMode ?? "result") === (input.outputMode ?? "result") &&
        draft?.text === input.text &&
        draft.recipient === input.recipient &&
        JSON.stringify(draft.skillKeys ?? []) ===
          JSON.stringify(input.skillKeys ?? []) &&
        draft.projectId === input.projectId &&
        JSON.stringify(draft.refs) === JSON.stringify(input.refs)
      ) {
        this.remove("draft", input.context);
        if (work.keepResearchReferences && !this.get<Draft>("draft", work.id))
          this.saveDraft({
            id: work.id,
            text: "",
            refs: structuredClone(input.refs),
            recipient: null,
            projectId: work.projectId,
            workspaceContext: work.workspaceContext,
            outputMode: work.workspaceContext ? "explanation" : "result",
          });
      }
      return run;
    });
  }
  setRun(id: string, patch: Partial<Run>) {
    return this.put("run", id, {
      ...this.require<Run>("run", id),
      ...patch,
      id,
    });
  }
  pauseQueue(workId: string, paused: boolean) {
    const w = this.require<Work>("work", workId);
    this.put("work", workId, { ...w, queuePaused: paused });
  }
  recover() {
    this.transaction(() => {
      for (const run of this.all<Run>("run")) {
        if (run.status === "running") {
          this.setRun(run.id, {
            status: "unknown",
            error: "应用执行中断，需要核对原运行；不会自动重新调用模型",
          });
          this.pauseQueue(run.workId, true);
        } else if (run.status === "queued") {
          this.setRun(run.id, { resumeRequested: false });
          this.pauseQueue(run.workId, true);
        }
      }
    });
  }
  finish(runId: string, body: string, result: boolean) {
    return this.transaction(() => {
      const run = this.require<Run>("run", runId);
      if (run.status !== "running") throw Error("运行已停止，不能提交迟到成果");
      let version: ArtifactVersion | undefined;
      result =
        run.outputMode === "summary" ||
        run.outputMode === "review" ||
        run.outputMode === "readiness" ||
        run.outputMode === "method"
          ? true
          : result && run.outputMode !== "explanation";
      if (result) {
        const previous = this.all<ArtifactVersion>("version")
          .filter(
            (v) =>
              v.workId === run.workId &&
              (v.kind ?? "result") === resultKind(run.outputMode),
          )
          .at(-1);
        if ((previous?.id ?? null) !== run.baseVersionId) {
          this.put<ArtifactCandidate>("candidate", run.id, {
            id: run.id,
            artifactId: previous!.artifactId,
            workId: run.workId,
            runId,
            baseVersionId: run.baseVersionId,
            body,
            status: "pending",
            resolvedVersionId: null,
            createdAt: now(),
          });
          this.setRun(runId, { status: "succeeded" });
          this.pauseQueue(run.workId, true);
          this.put<Message>("message", `${runId}:reply`, {
            id: `${runId}:reply`,
            workId: run.workId,
            runId,
            role: "assistant",
            body: "生成期间成果出现新版本。两份内容均已保留，可交给 AI 重新整理；待发已暂停。",
            refs: run.refs,
            createdAt: now(),
          });
          return;
        }
        version = {
          id: randomUUID(),
          artifactId: previous?.artifactId ?? randomUUID(),
          workId: run.workId,
          runId,
          parentId: previous?.id ?? null,
          number: (previous?.number ?? 0) + 1,
          body,
          createdAt: now(),
          author: "team",
          kind: resultKind(run.outputMode),
        };
        this.put("version", version.id, version);
      }
      this.setRun(runId, { status: "succeeded" });
      this.put<Message>("message", `${runId}:reply`, {
        id: `${runId}:reply`,
        workId: run.workId,
        runId,
        role: "assistant",
        body: result
          ? `${outputLabels[resultKind(run.outputMode)]}已生成，可在结果面阅读、比较或继续修订。`
          : body,
        refs: run.refs,
        createdAt: now(),
      });
      return version;
    });
  }
  adopt(deliveryId: string, versionId: string) {
    const d = this.require<Delivery>("delivery", deliveryId),
      v = this.require<ArtifactVersion>("version", versionId),
      w = this.require<Work>("work", v.workId);
    if (v.kind && v.kind !== "result")
      throw Error("总结和复盘是支持成果，不能替代交付的主成果");
    if (w.projectId !== d.projectId || w.deliveryId !== d.id)
      throw Error("此成果不属于该交付");
    this.put("delivery", d.id, { ...d, adoptedVersionId: v.id });
  }
  beginQueueEdit(runId: string) {
    const run = this.require<Run>("run", runId);
    if (
      run.status !== "queued" ||
      this.all<Contribution>("contribution").some((c) => c.runId === runId)
    )
      throw Error("本轮已开始执行，不能改写待发内容");
    this.pauseQueue(run.workId, true);
    return this.setRun(runId, {
      queueDraft: run.queueDraft ?? {
        text: run.text,
        refs: run.refs,
        recipient: run.recipient,
      },
    });
  }
  saveQueueDraft(
    runId: string,
    revision: number,
    draft: NonNullable<Run["queueDraft"]>,
  ) {
    const run = this.require<Run>("run", runId);
    if (
      run.status !== "queued" ||
      !run.queueDraft ||
      (run.queueRevision ?? 0) !== revision
    )
      throw Error("待发内容已变化，请重新打开编辑");
    return this.setRun(runId, { queueDraft: draft });
  }
  applyQueueEdit(runId: string, revision: number) {
    return this.transaction(() => {
      const run = this.require<Run>("run", runId),
        draft = run.queueDraft;
      if (
        run.status !== "queued" ||
        !draft ||
        (run.queueRevision ?? 0) !== revision
      )
        throw Error("待发内容已变化，请重新打开编辑");
      if (!draft.text.trim() || Buffer.byteLength(draft.text) > 16000)
        throw Error("请填写 16000 字节以内的目标");
      if (
        draft.recipient &&
        !run.team.members.some((m) => m.id === draft.recipient)
      )
        throw Error("原运行搭配中没有此成员");
      for (const ref of draft.refs) {
        const m = this.material(ref);
        if (m.readError) throw Error("请先修复或移除未就绪材料");
        if (ref.excerpt && !m.body.includes(ref.excerpt))
          throw Error("选段不属于指定材料版本");
      }
      const next = this.setRun(runId, {
        ...draft,
        text: draft.text.trim(),
        queueDraft: undefined,
        queueRevision: revision + 1,
      });
      const msg = this.require<Message>("message", runId);
      this.put("message", runId, { ...msg, body: next.text, refs: next.refs });
      return next;
    });
  }
  discardQueueEdit(runId: string, revision: number) {
    const run = this.require<Run>("run", runId);
    if (run.status !== "queued" || (run.queueRevision ?? 0) !== revision)
      throw Error("待发内容已变化");
    return this.setRun(runId, { queueDraft: undefined });
  }
  withdraw(runId: string) {
    const r = this.require<Run>("run", runId);
    if (r.status !== "queued") throw Error("只有待发补充可以撤回");
    this.setRun(runId, { status: "cancelled", error: "已撤回" });
  }
}
