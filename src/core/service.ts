import path from "node:path";
import { attentionSnapshot, handleAttentionCommand } from "./attention.js";
import { attentionCommandSchema } from "../shared/attention.js";
import { fetchAndNormalizePublicURL } from "../../services/source-service/src/connectors/public-url.js";
import type { FeatureHost, FeatureTaskInput } from "./feature-host.js";
import { validateSkillBindings } from "./skills.js";
import {
  handleMediaCommand,
  mediaSnapshot,
  mediaCommandSchema,
} from "./media.js";
import { handleDeliveryCommand, deliverySnapshot } from "./delivery.js";
import { deliveryCommandSchema } from "../shared/delivery.js";
import { RoutineEngine, routineSnapshot } from "./routines.js";
import { routineCommandSchema } from "../shared/routines.js";
import { WorkServiceClient } from "./work-service.js";
import type { WorkGateway } from "./work-gateway.js";
import { workServiceCommandSchema } from "../shared/work-service.js";
import { handleSkillCommand } from "./skill-library.js";
import { handlePortableCommand, portableSnapshot } from "./portable.js";
import {
  portableCommandSchema,
  portableInternalCommandSchema,
  type PortableInternalCommand,
} from "../shared/portable.js";
import {
  skillCommandSchema,
  type SkillInternalCommand,
} from "../shared/skill-library.js";
import type {
  EditorialRevision,
  EditorialResponse,
} from "@ytriple/source-contract";
import { editorialDocument } from "../shared/editorial.js";
import { rmdir } from "node:fs/promises";
import {
  normalizeMemberSettings,
  normalizeTeamSettings,
} from "../shared/member-settings.js";
import { buildProcessDocument } from "./process-document.js";
import { ProjectFiles } from "./project-files.js";
import { ProjectDiscovery, inspectImportedProject } from "./projects.js";
import { createGoogleAgentModel } from "./google-agents.js";
import { Agent, Runner } from "@openai/agents";
import type {
  AppSettings,
  Command,
  ModelProfile,
  RadarConnectionState,
  RadarDigestionRun,
  RadarEvidenceRevision,
  RadarItem,
  RemoteSourceDeliveryPage,
  RemoteSourceIdentity,
  Snapshot,
  Source,
  Task,
} from "../shared/types.js";
import { presentation } from "./exports.js";
import { Store, uid, now } from "./store.js";
import {
  writeArtifact,
  recoverArtifacts,
  textSource,
  within,
  hydrateArtifact,
  ensureOwnedDirectory,
  writeArtifactData,
  hydrateArtifactSync,
  readOwnedArtifactSync,
  hash,
} from "./files.js";
import {
  collectArtifact,
  librarySource,
  listLibrary,
  recoverLibrary,
  saveLibraryEntry,
  recordLibraryFeedback,
  migrateLibrarySources,
} from "./library.js";
import {
  assertLibraryContextCurrent,
  prepareLibraryRecall,
} from "./library-recall.js";
import { importFile } from "./sources.js";
import type {
  CreateRadarFollowInput,
  SourceGateway,
} from "./source-gateway.js";
import { TeamRuntime, type RuntimeCheckpoint } from "./runtime.js";
import {
  bindTaskSkills,
  mergeTaskSkillPins,
  setSkillEnabled,
  skillCatalog,
  validateSkillPolicy,
} from "./skill-policy.js";
import { probeProfile, type ModelFactory } from "./models.js";
import { inspectSystem, bootstrapSystem, initializeProject } from "./system.js";

export type InternalCommand =
  | Command
  | SkillInternalCommand
  | PortableInternalCommand
  | { type: "project.import.path"; path: string }
  | { type: "profile.save"; profile: ModelProfile; keyChanged?: boolean }
  | { type: "source.import.paths"; taskId: string; paths: string[] }
  | {
      type: "artifact.exportPNG";
      taskId: string;
      artifactId: string;
      expectedHash: string;
      goalVersion: number;
      png: Uint8Array;
    };
type HostedProbeResult = {
  capabilities: { text: boolean; tools: boolean; streaming: boolean };
  error?: string;
  incomplete?: boolean;
};
export class WorkbenchService {
  private readonly featureCreates = new Map<
    string,
    { fingerprint: string; promise: Promise<Snapshot> }
  >();
  private readonly featureWorks = new Map<
    string,
    { fingerprint: string; promise: Promise<Task> }
  >();
  private readonly featureCommands = new Set<Promise<Snapshot>>();
  readonly store: Store;
  readonly runtime: TeamRuntime;
  private readonly routines: RoutineEngine;
  private readonly workService: WorkServiceClient;
  private workTimer?: ReturnType<typeof setTimeout>;
  private routineTimer?: ReturnType<typeof setTimeout>;
  private routineTick?: Promise<void>;
  private system?: Snapshot["system"];
  private readonly projectScanner = new ProjectDiscovery();
  private importedProjects: Snapshot["projects"] = [];
  private projects(): Snapshot["projects"] {
    const discovered = this.projectScanner.snapshot.projects;
    return [
      ...discovered.filter(
        (project) =>
          !this.importedProjects.some((item) => item.root === project.root),
      ),
      ...this.importedProjects,
    ];
  }
  private readonly projectFiles = new ProjectFiles();
  private projectBrowser?: Snapshot["projectBrowser"];
  private browserSequence = 0;
  private browserScope = 0;
  private readonly taskCommands = new Map<string, Set<Promise<Snapshot>>>();
  private readonly taskDeletions = new Map<string, Promise<Snapshot>>();
  private readonly documentSaves = new Map<string, Promise<void>>();
  private readonly projectInitializations = new Map<string, Promise<void>>();
  private readonly sourceAdds = new Map<string, Promise<void>>();
  private readonly sourceReceives = new Set<Promise<void>>();
  private radarConnection: RadarConnectionState;
  private radarIdentity?: RemoteSourceIdentity;
  private radarError?: string;
  private radarDigestionError?: string;
  private radarTimer?: ReturnType<typeof setTimeout>;
  private radarCatalogRefresh?: Promise<void>;
  private radarDigestTimer?: ReturnType<typeof setTimeout>;
  private radarDigestion?: Promise<void>;
  private radarDigestionCreation: Promise<void> = Promise.resolve();
  private readonly radarDigestionRequests = new Map<
    string,
    Promise<RadarDigestionRun>
  >();
  private projectTimer?: ReturnType<typeof setTimeout>;
  private scanning?: Promise<void>;
  private closing = false;
  private readonly probes = new Map<
    string,
    { controller: AbortController; promise: Promise<HostedProbeResult> }
  >();
  private updateTimer?: ReturnType<typeof setTimeout>;
  constructor(
    dataPath: string,
    readonly readKey: (
      profile: ModelProfile,
    ) => string | undefined | Promise<string | undefined>,
    readonly changed: (snapshot: Snapshot) => void = () => {},
    readonly options: {
      googleAgentFactory?: typeof createGoogleAgentModel;
      modelFactory?: ModelFactory;
      sourceGateway?: SourceGateway;
      sourceServiceURL?: string;
      radarRefreshIntervalMs?: number;
      radarDigestDelayMs?: number;
      autoDigestRadar?: boolean;
      routinePollIntervalMs?: number;
      workGateway?: WorkGateway;
      publicURLFetcher?: typeof fetchAndNormalizePublicURL;
    } = {},
  ) {
    this.store = new Store(dataPath);
    this.radarIdentity = this.store.radarIdentity();
    this.radarConnection = options.sourceGateway
      ? "connecting"
      : "unconfigured";
    this.runtime = new TeamRuntime(
      {
        getTask: (id) => this.runtimeTask(id),
        getGoalVersion: (id) => this.store.task(id).goalVersion,
        getProfile: (task, member) => {
          const settings = this.store.settings();
          const id =
            task.profileId ||
            settings.memberProfiles[member] ||
            (member === "editor" ? settings.memberProfiles.researcher : "") ||
            settings.defaultProfileId;
          const profile = this.store.profiles().find((p) => p.id === id);
          if (!profile) throw new Error("请先在设置中选择有效的模型连接。");
          return profile;
        },
        getMemberSettings: (member) =>
          normalizeMemberSettings(
            this.store.settings().memberSettings?.[member],
            member,
          ),
        readKey,
        appendEvent: (id, event) => {
          if (!this.store.hasTask(id)) return;
          this.store.event(id, event);
          this.notify();
        },
        addAssistantMessage: (id, member, content, goalVersion) => {
          if (!this.store.hasTask(id)) return;
          assertLibraryContextCurrent(this.store, this.store.task(id));
          this.store.updateTask(id, (task) => {
            if (task.goalVersion !== goalVersion) return;
            task.messages.push({
              id: uid(),
              role: "assistant",
              member,
              content,
              goalVersion,
              createdAt: now(),
            });
          });
          this.notify();
        },
        writeArtifact: async (id, input) => {
          const task = this.store.task(id);
          assertLibraryContextCurrent(this.store, task);
          const selected = task.events.findLast(
            (event) =>
              event.type === "artifact.refine_requested" &&
              event.goalVersion === input.goalVersion,
          )?.data?.artifactId;
          if (selected && input.artifactId !== selected)
            throw new Error(
              `本轮正在修订用户选定的成果 ${selected}；请先读取该成果，再用原 artifactId 保存，不要另建文档。`,
            );
          const result = await writeArtifact(this.store, id, input);
          this.notify();
          return result;
        },
        publishRadarDigest: async (id, goalVersion, operationId, input) => {
          const result = this.store.publishRadarDigest(
            id,
            goalVersion,
            operationId,
            input,
          );
          this.radarDigestionError = undefined;
          this.notify();
          return result;
        },
        loadCheckpoint: (id) => this.store.checkpoint<RuntimeCheckpoint>(id),
        saveCheckpoint: (id, checkpoint) => {
          if (this.store.hasTask(id)) this.store.saveCheckpoint(id, checkpoint);
        },
        setStatus: (id, status, error) => {
          if (!this.store.hasTask(id)) return;
          this.store.updateTask(id, (task) => {
            task.status = status;
            task.error = error;
          });
          if (status === "failed" && error) {
            const identity = this.radarIdentity ?? this.store.radarIdentity();
            if (
              identity &&
              this.store
                .radarDigestions(identity)
                .some((run) => run.taskId === id && run.state === "pending")
            )
              this.radarDigestionError = error;
          }
          this.notify();
        },
      },
      {
        googleAgentFactory: options.googleAgentFactory,
        modelFactory: options.modelFactory,
      },
    );
    this.routines = new RoutineEngine(this.featureHost());
    this.workService = new WorkServiceClient(this.featureHost());
  }
  private featureHost(): FeatureHost {
    return {
      store: this.store,
      createWork: (input) => this.createFeatureWork(input),
      addSource: (id, source) => this.addSource(id, source),
      readURL: (url) => this.readURL(url),
      runWork: async (id) => {
        this.start(id);
        await this.runtime.run(id);
        const task = this.store.task(id);
        if (task.status === "failed")
          throw new Error(task.error || "本轮处理失败。");
        this.notify();
      },
      stopWork: (id) => this.runtime.stop(id),
      isRunning: (id) => this.runtime.isRunning(id),
    };
  }
  private async createFeatureWork(input: FeatureTaskInput): Promise<Task> {
    const requestId = input.requestId ?? uid();
    const fingerprint = hash(JSON.stringify(input));
    const previous = this.featureWorks.get(requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new Error("同一请求不能绑定不同的工作输入。");
      return previous.promise;
    }
    const promise = (async () => {
      const key = `feature.creation:${requestId}`;
      const saved = this.store.config<string | null>(key, () => null);
      if (saved && saved !== fingerprint)
        throw new Error("这项工作已使用其他输入创建，请重新发起。");
      const pins = input.skillPins
        ? validateSkillBindings(input.skillPins)
        : undefined;
      this.store.setConfig(key, fingerprint);
      await this.execute({
        type: "task.create",
        requestId,
        goal: input.goal,
        title: input.title,
        kind: input.kind,
        member: input.member,
        projectId: input.projectId,
        teamMode: input.teamMode,
        isolatedContext: input.isolatedContext,
        skillPolicy: input.skillPolicy,
      });
      const creation = this.store.config<{ id: string } | null>(
        `task.creation:${requestId}`,
        () => null,
      );
      if (!creation) throw new Error("未能保存工作创建记录。");
      if (pins)
        this.store.updateTask(creation.id, (task) => {
          task.skillPins = pins;
          task.skillBindings = bindTaskSkills(this.store, task);
        });
      for (const source of input.sources ?? [])
        await this.addSource(creation.id, source);
      this.notify();
      return this.store.task(creation.id);
    })();
    this.featureWorks.set(requestId, { fingerprint, promise });
    try {
      return await promise;
    } finally {
      this.featureWorks.delete(requestId);
    }
  }
  private async readURL(url: string): Promise<Source> {
    if (this.options.sourceGateway)
      return this.options.sourceGateway.addURL(url);
    const page = await (
      this.options.publicURLFetcher ?? fetchAndNormalizePublicURL
    )(url, { syntheticDNSFallback: "cloudflare" });
    if (this.closing) throw new Error("工作台正在关闭，未添加网页资料。");
    return {
      id: uid(),
      title: page.title,
      type: "url",
      location: page.canonicalUrl,
      text: page.content,
      addedAt: page.observedAt,
      coverage: "本机实际提取的公开网页文字；不含登录内容、视频画面或音频。",
    };
  }
  private scheduleRoutines(delay: number): void {
    if (this.routineTimer) clearTimeout(this.routineTimer);
    if (this.closing) return;
    this.routineTimer = setTimeout(
      () => {
        this.routineTimer = undefined;
        const before = JSON.stringify(routineSnapshot(this.store));
        this.routineTick = this.routines
          .tick()
          .then(() => {
            if (
              !this.closing &&
              JSON.stringify(routineSnapshot(this.store)) !== before
            )
              this.notify();
          })
          .catch((error) => {
            if (!this.closing) {
              this.store.setConfig("routines.engineError", safeError(error));
              this.notify();
            }
          })
          .finally(() => {
            this.routineTick = undefined;
            if (!this.closing)
              this.scheduleRoutines(
                this.options.routinePollIntervalMs ?? 30_000,
              );
          });
      },
      Math.max(0, delay),
    );
    this.routineTimer.unref?.();
  }
  async initialize(): Promise<Snapshot> {
    await recoverArtifacts(this.store);
    await recoverLibrary(this.store, this.store.settings().aiRoot);
    migrateLibrarySources(this.store, this.store.settings().aiRoot);
    const root = path.resolve(this.store.settings().aiRoot);
    for (const entry of listLibrary(this.store, root)) {
      if (
        this.store.tasks().some(
          (task) =>
            task.surface !== "background" &&
            task.sources.some((source) => {
              const reference = source.library;
              return (
                reference &&
                !reference.supersededAt &&
                reference.root === root &&
                reference.entryId === entry.id &&
                (reference.hash !== entry.hash ||
                  reference.version !== entry.version ||
                  reference.feedbackRevision !== entry.feedbackRevision)
              );
            }),
        )
      )
        await this.invalidateLibraryTasks(
          entry.id,
          `observed:${entry.version}:${entry.hash}:${entry.feedbackRevision}`,
        );
    }
    await this.refreshSystem();
    this.scheduleProjects();
    this.startSourceReceiver();
    this.scheduleRadarRefresh(0);
    this.scheduleRadarDigestion(this.options.radarDigestDelayMs ?? 800);
    this.scheduleRoutines(0);
    if (this.options.workGateway)
      await this.connectWorkService(this.options.workGateway);
    return this.snapshot();
  }
  private scheduleWorkRefresh(): void {
    if (this.workTimer) clearTimeout(this.workTimer);
    if (this.closing || !this.options.workGateway) return;
    this.workTimer = setTimeout(() => {
      void this.workService.refresh().finally(() => {
        if (!this.closing) {
          this.notify();
          this.scheduleWorkRefresh();
        }
      });
    }, 30_000);
    this.workTimer.unref?.();
  }
  async connectWorkService(gateway: WorkGateway): Promise<Snapshot> {
    this.options.workGateway = gateway;
    await this.workService.connect(gateway);
    this.scheduleWorkRefresh();
    return this.snapshot();
  }
  async disconnectWorkService(notice?: string): Promise<Snapshot> {
    if (this.workTimer) clearTimeout(this.workTimer);
    await this.runtime.stopAll();
    await this.workService.disconnect(notice);
    this.options.workGateway = undefined;
    return this.snapshot();
  }
  async connectSourceService(
    gateway: SourceGateway,
    baseURL: string,
  ): Promise<Snapshot> {
    const previous = this.options.sourceGateway;
    this.options.sourceGateway = gateway;
    this.options.sourceServiceURL = baseURL;
    if (this.radarTimer) clearTimeout(this.radarTimer);
    await previous?.close?.();
    await this.radarCatalogRefresh?.catch(() => undefined);
    this.radarIdentity = undefined;
    this.radarConnection = "connecting";
    this.radarError = undefined;
    this.radarDigestionError = undefined;
    this.startSourceReceiver();
    await this.refreshRadarCatalog();
    this.scheduleRadarRefresh(this.options.radarRefreshIntervalMs ?? 30_000);
    return this.snapshot();
  }
  private startSourceReceiver(): void {
    const gateway = this.options.sourceGateway;
    gateway?.startReceiving?.({
      cursorFor: (identity) => this.store.remoteSourceCursor(identity),
      commit: (page) =>
        gateway === this.options.sourceGateway
          ? this.trackSourcePage(page)
          : Promise.reject(new Error("信息源连接已切换。")),
      reportStatus: (state, identity) => {
        if (gateway !== this.options.sourceGateway || this.closing) return;
        if (identity) {
          this.radarIdentity = identity;
          this.store.saveRadarIdentity(identity);
        }
        this.radarConnection = state;
        if (state === "online") this.radarError = undefined;
        this.notify();
      },
      reportError: (message) => {
        if (gateway !== this.options.sourceGateway || this.closing) return;
        this.radarConnection = "offline";
        this.radarError = message;
        this.notify();
      },
    });
  }
  private trackSourcePage(page: RemoteSourceDeliveryPage): Promise<void> {
    const pending = this.receiveSourcePage(page);
    this.sourceReceives.add(pending);
    void pending
      .finally(() => this.sourceReceives.delete(pending))
      .catch(() => undefined);
    return pending;
  }
  private async receiveSourcePage(
    page: RemoteSourceDeliveryPage,
  ): Promise<void> {
    if (this.closing) throw new Error("工作台正在关闭。");
    this.radarIdentity = {
      serverInstanceId: page.serverInstanceId,
      tenantId: page.tenantId,
    };
    const result = this.store.commitRemoteSourcePage(page);
    this.radarConnection = "online";
    this.radarError = undefined;
    if (result.added) {
      this.notify();
      this.scheduleRadarDigestion(this.options.radarDigestDelayMs ?? 800);
    }
  }
  private async refreshRadarCatalog(): Promise<void> {
    if (this.radarCatalogRefresh) return this.radarCatalogRefresh;
    const pending = this.performRadarCatalogRefresh();
    this.radarCatalogRefresh = pending;
    try {
      await pending;
    } finally {
      if (this.radarCatalogRefresh === pending)
        this.radarCatalogRefresh = undefined;
    }
  }
  private async performRadarCatalogRefresh(): Promise<void> {
    const gateway = this.options.sourceGateway;
    if (!gateway?.radarCatalog) return;
    try {
      const catalog = await gateway.radarCatalog();
      if (this.closing || gateway !== this.options.sourceGateway) return;
      this.radarIdentity = {
        serverInstanceId: catalog.serverInstanceId,
        tenantId: catalog.tenantId,
      };
      this.store.replaceRadarCatalog(
        this.radarIdentity,
        catalog.follows,
        catalog.recommendedSources,
      );
      this.store.setConfig(
        `radar.reading:${catalog.serverInstanceId}:${catalog.tenantId}`,
        catalog.readingTopics ?? [],
      );
      this.store.setConfig(
        `radar.editorial:${catalog.serverInstanceId}:${catalog.tenantId}`,
        catalog.editorial ?? null,
      );
      this.radarConnection = "online";
      this.radarError = undefined;
      this.notify();
    } catch (error) {
      if (this.closing || gateway !== this.options.sourceGateway) return;
      this.radarConnection = "offline";
      this.radarError = safeError(error);
      this.notify();
      throw error;
    }
  }
  private async loadEditorialRevision(
    issueId: string,
    revisionId: string,
  ): Promise<EditorialRevision> {
    const identity = await this.requireRadarIdentity();
    const key = `radar.editorialVersions:${identity.serverInstanceId}:${identity.tenantId}`;
    const versions = this.store.config<Record<string, EditorialRevision>>(
      key,
      () => ({}),
    );
    if (versions[revisionId]?.issueId === issueId) return versions[revisionId];
    const feed = this.store.config<Omit<EditorialResponse, "meta"> | null>(
      `radar.editorial:${identity.serverInstanceId}:${identity.tenantId}`,
      () => null,
    );
    let revision = feed?.issues.find(
      (issue) => issue.id === issueId && issue.latest.id === revisionId,
    )?.latest;
    if (!revision) {
      const gateway = this.options.sourceGateway;
      if (!gateway?.editorialRevision)
        throw new Error("此版本尚未保存到本机，请连接信息源服务后重试。");
      const result = await gateway.editorialRevision(issueId, revisionId);
      if (
        this.closing ||
        gateway !== this.options.sourceGateway ||
        result.serverInstanceId !== identity.serverInstanceId ||
        result.tenantId !== identity.tenantId
      )
        throw new Error("信息源连接已改变，请重新打开解读。");
      revision = result.revision;
    }
    this.store.setConfig(key, {
      ...this.store.config<Record<string, EditorialRevision>>(key, () => ({})),
      [revisionId]: revision,
    });
    return revision;
  }

  private scheduleRadarRefresh(delay: number): void {
    if (this.radarTimer) clearTimeout(this.radarTimer);
    const gateway = this.options.sourceGateway;
    if (this.closing || !gateway?.radarCatalog) return;
    this.radarTimer = setTimeout(
      () => {
        this.radarTimer = undefined;
        void this.refreshRadarCatalog()
          .catch(() => undefined)
          .finally(() => {
            if (!this.closing)
              this.scheduleRadarRefresh(
                this.options.radarRefreshIntervalMs ?? 30_000,
              );
          });
      },
      Math.max(0, delay),
    );
    this.radarTimer.unref?.();
  }
  private scheduleRadarDigestion(delay: number): void {
    if (this.radarDigestTimer) clearTimeout(this.radarDigestTimer);
    if (this.closing || this.options.autoDigestRadar === false) return;
    this.radarDigestTimer = setTimeout(
      () => {
        this.radarDigestTimer = undefined;
        void this.digestPendingRadarItems().catch((error) => {
          if (this.closing) return;
          this.radarDigestionError = safeError(error);
          this.notify();
        });
      },
      Math.max(0, delay),
    );
    this.radarDigestTimer.unref?.();
  }
  private radarDigestProfile(): ModelProfile | undefined {
    const settings = this.store.settings();
    const profileId =
      settings.memberProfiles.coordinator || settings.defaultProfileId;
    return this.store.profiles().find((profile) => profile.id === profileId);
  }
  private async requireRadarDigestProfile(): Promise<ModelProfile> {
    const profile = this.radarDigestProfile();
    if (
      !profile ||
      profile.status !== "ready" ||
      profile.execution === "google-agent" ||
      profile.capabilities?.tools !== true ||
      !(await this.readKey(profile))
    )
      throw new Error(
        "Radar 需要一个已验证、支持工具调用的本机团队模型连接，才能形成可回写的主题理解。",
      );
    return profile;
  }
  private radarContextSources(): {
    sources: Source[];
    contextSources: RadarDigestionRun["contextSources"];
  } {
    const settings = this.store.settings();
    const sources: Source[] = [];
    const contextSources: RadarDigestionRun["contextSources"] = [];
    const library = listLibrary(this.store, settings.aiRoot)
      .filter(
        (entry) =>
          (entry.format === "md" || entry.format === "html") &&
          !entry.readError,
      )
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 8);
    for (const entry of library) {
      const source = librarySource(this.store, settings.aiRoot, entry.id);
      sources.push(source);
      contextSources.push({
        sourceId: source.id,
        kind: "library",
        referenceId: entry.id,
        version: entry.version,
        hash: entry.hash,
      });
    }

    const activeTasks = this.store
      .tasks()
      .filter(
        (task) =>
          task.surface !== "background" && !task.archivedAt && !task.deletedAt,
      )
      .slice(0, 6);
    const projects = this.projects().slice(0, 12);
    if (activeTasks.length || projects.length) {
      const lines = [
        "# 本地工作上下文（仅登记信息）",
        "",
        "以下只包含工作目标与项目登记元数据；除非另有资料，不代表已经读取项目正文。",
        "",
        "## 最近工作",
        ...(activeTasks.length
          ? activeTasks.map(
              (task) =>
                `- ${task.title}：${task.goal.replace(/\s+/g, " ").slice(0, 480)}`,
            )
          : ["- 暂无"]),
        "",
        "## 已登记项目",
        ...(projects.length
          ? projects.map(
              (project) =>
                `- ${project.name}（${project.id}）${project.lifecycle ? `：${project.lifecycle}` : ""}`,
            )
          : ["- 暂无"]),
      ];
      const source = textSource(
        "当前工作与项目索引",
        lines.join("\n"),
        "text",
        "ytriple 本机登记信息",
      );
      source.coverage = "工作目标与项目登记元数据；未读取项目正文";
      sources.push(source);
      contextSources.push({
        sourceId: source.id,
        kind: "task",
        referenceId: "workspace-overview",
        version: 1,
        hash: hash(source.text),
      });
    }
    return { sources, contextSources };
  }
  private createRadarDigestion(
    itemIds: string[],
    retryOfRunId?: string,
  ): Promise<RadarDigestionRun> {
    const uniqueIds = [...new Set(itemIds)].toSorted();
    const requestKey = `${retryOfRunId ?? "new"}\0${uniqueIds.join("\0")}`;
    const existing = this.radarDigestionRequests.get(requestKey);
    if (existing) return existing;
    const pending = this.radarDigestionCreation
      .catch(() => undefined)
      .then(() => this.performCreateRadarDigestion(uniqueIds, retryOfRunId));
    this.radarDigestionCreation = pending.then(
      () => undefined,
      () => undefined,
    );
    this.radarDigestionRequests.set(requestKey, pending);
    void pending
      .finally(() => {
        if (this.radarDigestionRequests.get(requestKey) === pending)
          this.radarDigestionRequests.delete(requestKey);
      })
      .catch(() => undefined);
    return pending;
  }
  private async performCreateRadarDigestion(
    uniqueIds: string[],
    retryOfRunId?: string,
  ): Promise<RadarDigestionRun> {
    if (this.closing) throw new Error("工作台正在关闭。");
    const identity = this.radarIdentity ?? this.store.radarIdentity();
    if (!identity)
      throw new Error("还没有可消化的信息源记录，请先接收真实来源内容。");
    const profile = await this.requireRadarDigestProfile();
    if (!uniqueIds.length) throw new Error("没有可交给团队消化的 Radar 信号。");
    const radarSources = this.store.radarSources(uniqueIds);
    const settings = this.store.settings();
    if (
      within(settings.aiRoot, settings.workspaceRoot) &&
      this.system?.state === "missing"
    ) {
      this.system = await bootstrapSystem(settings.aiRoot, settings.codeRoot);
      if (this.system.state !== "ready")
        throw new Error("本机 AI 规则尚未就绪，请在设置中检查。");
    }
    const id = uid();
    const workspace = await ensureOwnedDirectory(
      path.join(settings.workspaceRoot, id),
    );
    try {
      const createdAt = now();
      const instruction = [
        `消化 Radar 本批次 ${radarSources.length} 条真实信号。`,
        "逐条读取信号正文；按问题或主题合并有用内容，说明关键变化、为何值得关注、分歧与证据缺口。",
        "结合实际读取过的本地 Lib 或工作上下文，区分新增、支持、补充、重复与冲突；未读取的内容不能声称已经对照。",
        "每条信号必须进入某个主题的证据，或明确记录为重复、过时、低价值、不相关、不完整或延期。",
        "最后必须使用 Radar 结构化发布工具回写；普通回复和文档不能代替发布。",
      ].join("\n");
      const context = this.radarContextSources();
      if (this.closing) throw new Error("工作台正在关闭。");
      const run = this.store.createTaskFromRadar(
        {
          id,
          title: `Radar 自动消化 · ${radarSources.length} 条信号`,
          goal: instruction,
          goalVersion: 1,
          kind: "research",
          member: "coordinator",
          profileId: profile.id,
          surface: "background",
          workspace,
          status: "idle",
          createdAt,
          updatedAt: createdAt,
          messages: [
            {
              id: uid(),
              role: "user",
              member: "coordinator",
              content: instruction,
              createdAt,
              goalVersion: 1,
            },
          ],
          events: [],
          sources: context.sources,
          artifacts: [],
        },
        radarSources,
        {
          identity,
          itemIds: uniqueIds,
          contextSources: context.contextSources,
          retryOfRunId,
        },
      );
      if (!run) throw new Error("Radar 消化批次没有建立成功。");
      const task = this.store.task(id);
      if (
        !task.events.some(
          (event) =>
            event.type === "radar.digest_requested" &&
            event.goalVersion === task.goalVersion,
        )
      )
        this.store.event(id, {
          type: "radar.digest_requested",
          goalVersion: task.goalVersion,
          summary: `开始消化 ${run.items.length} 条 Radar 信号`,
          data: {
            runId: run.id,
            sourceIds: run.items.map((item) => item.sourceId),
          },
        });
      this.start(id);
      this.radarDigestionError = undefined;
      this.notify();
      return run;
    } catch (error) {
      // A rejected competing claim must not leave an empty, invisible workspace.
      if (!this.store.hasTask(id))
        await rmdir(workspace).catch(() => undefined);
      throw error;
    }
  }
  private async digestPendingRadarItems(): Promise<void> {
    if (this.closing || !this.radarIdentity) return;
    if (this.radarDigestion) return this.radarDigestion;
    const pending = (async () => {
      const identity = this.radarIdentity!;
      const incomplete = this.store
        .radarDigestions(identity)
        .toSorted((left, right) =>
          right.createdAt.localeCompare(left.createdAt),
        )
        .find((run) => run.state === "pending");
      if (incomplete && this.store.hasTask(incomplete.taskId)) {
        const task = this.store.task(incomplete.taskId);
        if (this.runtime.isRunning(task.id)) return;
        if (task.status === "idle" || task.status === "paused") {
          await this.requireRadarDigestProfile();
          this.start(task.id);
          this.radarDigestionError = undefined;
          this.notify();
          return;
        }
        if (task.status === "running" || task.status === "waiting") return;
      }
      const items = this.store
        .pendingRadarItems(identity)
        .filter((item: RadarItem) => !item.archivedAt)
        .slice(0, 12);
      if (!items.length) return;
      await this.createRadarDigestion(items.map((item) => item.id));
    })();
    this.radarDigestion = pending;
    try {
      await pending;
    } finally {
      if (this.radarDigestion === pending) this.radarDigestion = undefined;
    }
  }
  private async requireRadarIdentity(): Promise<RemoteSourceIdentity> {
    if (!this.options.sourceGateway)
      throw new Error("信息源服务尚未配置，请先完成 Radar 连接。");
    if (!this.radarIdentity) await this.refreshRadarCatalog();
    if (!this.radarIdentity)
      throw new Error("信息源服务身份尚未确认，请稍后重试。");
    return this.radarIdentity;
  }
  private runtimeTask(id: string): Task {
    const task = this.store.task(id);
    task.sources = task.sources.filter(
      (source) => !source.library?.supersededAt,
    );
    task.artifacts = task.artifacts.map((a) =>
      hydrateArtifactSync(a, task.workspace),
    );
    return task;
  }
  private notify(): void {
    if (this.closing || this.updateTimer) return;
    this.updateTimer = setTimeout(() => {
      this.updateTimer = undefined;
      void this.snapshot()
        .then(this.changed)
        .catch(() => {});
    }, 120);
  }
  private async refreshSystem(): Promise<void> {
    const settings = this.store.settings();
    this.system = await inspectSystem(settings.aiRoot, settings.codeRoot);
    await this.refreshProjects();
  }
  private async refreshProjects(): Promise<void> {
    if (this.scanning) {
      await this.scanning;
      if (this.closing) return;
      const settings = this.store.settings();
      const last = this.projectScanner.snapshot.discovery;
      if (
        last.aiRoot === settings.aiRoot &&
        last.codeRoot === settings.codeRoot
      )
        return;
    }
    if (this.closing) return;
    const settings = this.store.settings();
    this.scanning = this.projectScanner
      .refresh(settings.aiRoot, settings.codeRoot)
      .then(async () => {
        const roots = this.store.config<string[]>(
          `projects.imported:${settings.aiRoot}`,
          () => [],
        );
        const observations = await Promise.allSettled(
          roots.map((directory) => inspectImportedProject(directory)),
        );
        if (this.store.settings().aiRoot !== settings.aiRoot) return;
        this.importedProjects = observations.flatMap((result, index) =>
          result.status === "fulfilled"
            ? [result.value]
            : [
                {
                  id: `imported-${hash(roots[index]!).slice(0, 24)}`,
                  name: path.basename(roots[index]!),
                  series: "local",
                  root: roots[index]!,
                  devPath: roots[index]!,
                  registered: false,
                  imported: true,
                  documents: {},
                  observation: {
                    state: "missing" as const,
                    checkedAt: now(),
                    worktrees: [],
                    documents: [],
                    issues: ["导入目录已不可读取，请检查文件位置与权限。"],
                    fingerprint: hash(String(result.reason)),
                  },
                },
              ],
        );
      });
    try {
      await this.scanning;
    } finally {
      this.scanning = undefined;
    }
  }
  private scheduleProjects(): void {
    if (this.projectTimer) clearTimeout(this.projectTimer);
    if (this.closing || this.store.settings().projectMonitoring === false)
      return;
    this.projectTimer = setTimeout(() => {
      this.projectTimer = undefined;
      void this.refreshProjects()
        .then(() => {
          if (!this.closing) this.notify();
        })
        .catch(() => {})
        .finally(() => this.scheduleProjects());
    }, 30_000);
    this.projectTimer.unref();
  }
  private publishedRadarEvidence(
    identity: RemoteSourceIdentity,
    items: RadarItem[],
    runs: RadarDigestionRun[],
  ): Record<string, Record<string, RadarEvidenceRevision>> {
    const result: Record<string, Record<string, RadarEvidenceRevision>> = {};
    const itemById = new Map(items.map((item) => [item.id, item]));
    for (const run of runs) {
      if (run.state !== "published") continue;
      if (
        run.serverInstanceId !== identity.serverInstanceId ||
        run.tenantId !== identity.tenantId
      )
        throw new Error("Radar 已发布记录不属于当前信息源身份。");
      for (const locked of run.items) {
        const item = itemById.get(locked.radarItemId);
        if (
          !item ||
          item.serverInstanceId !== identity.serverInstanceId ||
          item.tenantId !== identity.tenantId ||
          item.remoteItemId !== locked.remoteItemId
        )
          throw new Error("Radar 已发布证据条目与当前身份不一致。");
        const source = this.store.radarSourceRevision(
          identity,
          locked.remoteItemId,
          locked.revisionId,
        );
        if (!source) continue;
        const remote = source.remote;
        if (
          !remote ||
          source.id !== locked.sourceId ||
          remote.serverInstanceId !== identity.serverInstanceId ||
          remote.tenantId !== identity.tenantId ||
          remote.sourceId !== item.sourceId ||
          remote.itemId !== locked.remoteItemId ||
          remote.revisionId !== locked.revisionId ||
          remote.contentHash !== locked.contentHash
        )
          throw new Error("Radar 已发布证据与锁定修订不一致。");
        const revision: RadarEvidenceRevision = {
          sourceId: source.id,
          remoteItemId: remote.itemId,
          revisionId: remote.revisionId,
          title: source.title,
          url: source.location,
          content: source.text,
          contentHash: remote.contentHash,
          observedAt: remote.observedAt,
          coverageLevel: remote.coverageLevel,
          missing: [...remote.missing],
        };
        const revisions = (result[locked.radarItemId] ??= {});
        const existing = revisions[locked.revisionId];
        if (existing && JSON.stringify(existing) !== JSON.stringify(revision))
          throw new Error("Radar 已发布证据修订存在冲突。");
        revisions[locked.revisionId] = revision;
      }
    }
    return result;
  }
  async snapshot(): Promise<Snapshot> {
    if (!this.system) await this.refreshSystem();
    const tasks = await Promise.all(
      this.store.tasks().map(async (task) => ({
        ...task,
        artifacts: await Promise.all(
          task.artifacts.map((a) => hydrateArtifact(a, task.workspace)),
        ),
      })),
    );
    const profiles = await Promise.all(
      this.store
        .profiles()
        .map(async (p) => ({ ...p, hasKey: Boolean(await this.readKey(p)) })),
    );
    const identity = this.radarIdentity;
    const follows = identity ? this.store.radarFollows(identity) : [];
    const recommendedSources = identity
      ? this.store.radarRecommendedSources(identity).map((source) => {
          const follow = follows.find(
            (candidate) => candidate.recommendedSourceId === source.id,
          );
          return {
            ...source,
            followed: Boolean(follow),
            followId: follow?.id,
          };
        })
      : [];
    const radarItems = identity ? this.store.radarItems(identity) : [];
    const radarDigestions = identity
      ? this.store.radarDigestions(identity).map((run) => {
          const task = this.store.hasTask(run.taskId)
            ? this.store.task(run.taskId)
            : undefined;
          return {
            ...run,
            taskStatus: task?.status,
            error: task?.error,
          };
        })
      : [];
    const radarEvidenceRevisions = identity
      ? this.publishedRadarEvidence(identity, radarItems, radarDigestions)
      : {};
    return {
      version: "0.1.0",
      dataPath: this.store.dataPath,
      tasks: tasks.filter(
        (task) => this.store.hasTask(task.id) && task.surface !== "background",
      ),
      profiles,
      settings: this.store.settings(),
      system: this.system!,
      projects: this.projects(),
      projectDiscovery: this.projectScanner.snapshot.discovery,
      projectBrowser: this.projectBrowser,
      library: listLibrary(this.store, this.store.settings().aiRoot),
      skills: skillCatalog(this.store),
      media: mediaSnapshot(this.store),
      delivery: deliverySnapshot(this.store),
      routines: routineSnapshot(this.store),
      workService: this.workService.snapshot(),
      portable: portableSnapshot(this.store),
      attention: attentionSnapshot(
        this.store,
        Date.now(),
        this.workService.snapshot(),
      ),
      radar: {
        configured: Boolean(this.options.sourceGateway),
        serviceURL: this.options.sourceServiceURL,
        editorialIdentity: identity
          ? `${identity.serverInstanceId}:${identity.tenantId}`
          : undefined,
        editorial: identity
          ? (this.store.config<Omit<EditorialResponse, "meta"> | null>(
              `radar.editorial:${identity.serverInstanceId}:${identity.tenantId}`,
              () => null,
            ) ?? undefined)
          : undefined,
        editorialVersions: identity
          ? this.store.config<Record<string, EditorialRevision>>(
              `radar.editorialVersions:${identity.serverInstanceId}:${identity.tenantId}`,
              () => ({}),
            )
          : undefined,
        readingTopics: identity
          ? this.store.config(
              `radar.reading:${identity.serverInstanceId}:${identity.tenantId}`,
              () => [],
            )
          : [],
        connection: this.radarConnection,
        follows,
        recommendedSources,
        items: radarItems,
        digestions: radarDigestions,
        evidenceRevisions: radarEvidenceRevisions,
        digests: identity ? this.store.radarDigests(identity) : [],
        dispositions: identity ? this.store.radarDispositions(identity) : [],
        events: identity ? this.store.radarEvents(identity) : [],
        unreadCount: radarItems.filter(
          (item) => !item.readAt && !item.archivedAt,
        ).length,
        lastSyncAt: identity ? this.store.radarLastSyncAt(identity) : undefined,
        error: this.radarError,
        digestionError: this.radarDigestionError,
      },
    };
  }
  private start(id: string): void {
    const task = this.store.task(id);
    if (this.taskDeletions.has(id)) throw new Error("这项工作正在永久删除。");
    if (task.archivedAt) throw new Error("请先恢复这项工作，再继续处理。");
    if (this.runtime.isRunning(id)) return;
    const skillBindings = bindTaskSkills(this.store, task);
    const skillPins = mergeTaskSkillPins(task, skillBindings);
    this.store.updateTask(id, (current) => {
      current.skillPins = skillPins;
      current.skillBindings = skillBindings;
    });
    if (!task.isolatedContext) prepareLibraryRecall(this.store, id);
    void this.runtime
      .run(id)
      .catch((error) => {
        if (!this.store.hasTask(id)) return;
        const message = safeError(error);
        this.store.updateTask(id, (task) => {
          task.status = "failed";
          task.error = message;
        });
        const identity = this.radarIdentity ?? this.store.radarIdentity();
        if (
          identity &&
          this.store
            .radarDigestions(identity)
            .some((run) => run.taskId === id && run.state === "pending")
        )
          this.radarDigestionError = message;
        this.notify();
      })
      .finally(() => {
        if (!this.closing && this.store.hasTask(id)) {
          const finished = this.store.task(id);
          if (finished.surface === "background")
            this.scheduleRadarDigestion(this.options.radarDigestDelayMs ?? 800);
        }
      });
  }
  private async addSource(
    id: string,
    source: Source,
    expectedGoalVersion?: number,
  ): Promise<void> {
    const assertExpectedGoal = () => {
      if (
        expectedGoalVersion !== undefined &&
        this.store.task(id).goalVersion !== expectedGoalVersion
      )
        throw new Error(
          "工作目标已变化，旧准备资料未加入，也不会启动新的目标。请在原工作确认后继续。",
        );
    };
    assertExpectedGoal();
    const previous = this.sourceAdds.get(id) ?? Promise.resolve();
    const pending = previous
      .catch(() => {})
      .then(async () => {
        // A preparation queued behind another import must check the current
        // goal before stopping its runtime, as well as before the sync commit.
        assertExpectedGoal();
        if (this.store.hasTaskSource(id, source)) {
          this.store.recordRemoteRevision(source);
          return;
        }
        await this.runtime.stop(id);
        assertExpectedGoal();
        this.store.commitTaskSource(id, source);
      });
    this.sourceAdds.set(id, pending);
    try {
      await pending;
    } finally {
      if (this.sourceAdds.get(id) === pending) this.sourceAdds.delete(id);
    }
  }
  private async invalidateLibraryTasks(
    entryId: string,
    token: string,
  ): Promise<void> {
    const root = path.resolve(this.store.settings().aiRoot);
    const affected: string[] = [];
    // Fence all affected goals synchronously before waiting for any in-flight operation.
    for (const task of this.store.tasks()) {
      if (
        task.surface === "background" ||
        !task.sources.some(
          (source) =>
            source.library?.entryId === entryId &&
            source.library.root === root &&
            !source.library.supersededAt,
        ) ||
        task.events.some(
          (event) =>
            event.type === "library.changed" &&
            event.data?.entryId === entryId &&
            event.data?.token === token,
        )
      )
        continue;
      this.store.updateTask(task.id, (current) => {
        current.goalVersion++;
        current.status = "paused";
        current.error = undefined;
        current.events.push({
          id: uid(),
          createdAt: now(),
          type: "library.changed",
          goalVersion: current.goalVersion,
          summary:
            "本项工作使用的 Lib 已有修订或反馈。旧成果保留；继续时会读取最新内容并重新判断。",
          data: {
            entryId,
            token,
            continuedUserMessageId: current.messages.findLast(
              (message) => message.role === "user",
            )?.id,
          },
        });
      });
      this.store.saveCheckpoint(task.id, null);
      affected.push(task.id);
    }
    for (const id of affected) await this.runtime.stop(id);
  }
  async execute(command: InternalCommand): Promise<Snapshot> {
    if (this.closing) throw new Error("工作台正在关闭。");
    if (command.type === "task.create" && command.requestId) {
      const previous = this.featureCreates.get(command.requestId);
      const fingerprint = JSON.stringify(command);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new Error("同一请求不能创建不同内容的工作。");
        return previous.promise;
      }
      const pending = this.executeTrackedCommand(command);
      this.featureCreates.set(command.requestId, {
        fingerprint,
        promise: pending,
      });
      try {
        return await pending;
      } finally {
        this.featureCreates.delete(command.requestId);
      }
    }
    const taskId =
      command.type === "library.feedback"
        ? undefined
        : "taskId" in command
          ? command.taskId
          : command.type === "project.initialize"
            ? command.input.taskId
            : undefined;
    if (command.type === "task.delete") {
      const existing = this.taskDeletions.get(command.taskId);
      if (existing) return existing;
      this.store.task(command.taskId);
      // Register deletion synchronously, before a queued send/save can start new work.
      const pending = Promise.resolve().then(async () => {
        await this.runtime.stop(command.taskId);
        await Promise.allSettled([
          ...(this.taskCommands.get(command.taskId) ?? []),
        ]);
        await this.runtime.stop(command.taskId);
        this.store.deleteTask(command.taskId);
        if (this.closing) throw new Error("工作台正在关闭。");
        const snapshot = await this.snapshot();
        this.changed(snapshot);
        return snapshot;
      });
      this.taskDeletions.set(command.taskId, pending);
      try {
        return await pending;
      } finally {
        if (this.taskDeletions.get(command.taskId) === pending)
          this.taskDeletions.delete(command.taskId);
      }
    }
    if (taskId) {
      if (this.taskDeletions.has(taskId))
        throw new Error("这项工作正在永久删除，请等待删除完成。");
      this.store.task(taskId);
    }
    const pending = this.executeTrackedCommand(command);
    if (!taskId) return pending;
    const commands =
      this.taskCommands.get(taskId) ?? new Set<Promise<Snapshot>>();
    commands.add(pending);
    this.taskCommands.set(taskId, commands);
    try {
      return await pending;
    } finally {
      commands.delete(pending);
      if (!commands.size && this.taskCommands.get(taskId) === commands)
        this.taskCommands.delete(taskId);
    }
  }
  private executeTrackedCommand(command: InternalCommand): Promise<Snapshot> {
    const pending = Promise.resolve().then(() => this.executeCommand(command));
    this.featureCommands.add(pending);
    return pending.finally(() => this.featureCommands.delete(pending));
  }
  private async executeCommand(command: InternalCommand): Promise<Snapshot> {
    if (this.closing) throw new Error("工作台正在关闭。");
    let browserReply: Snapshot["projectBrowser"];
    let replyScope: number | undefined;
    if (command.type.startsWith("attention.")) {
      await handleAttentionCommand(
        this.featureHost(),
        attentionCommandSchema.parse(command),
        Date.now(),
        this.workService.snapshot(),
      );
      const snapshot = await this.snapshot();
      this.changed(snapshot);
      return snapshot;
    }
    if (command.type.startsWith("portable.")) {
      await handlePortableCommand(
        this.featureHost(),
        command.type.endsWith(".path")
          ? portableInternalCommandSchema.parse(command)
          : portableCommandSchema.parse(command),
      );
      const snapshot = await this.snapshot();
      this.changed(snapshot);
      return snapshot;
    }
    if (
      command.type.startsWith("skill.") &&
      command.type !== "skill.setEnabled"
    ) {
      await handleSkillCommand(
        this.featureHost(),
        command.type === "skill.importLocal.path"
          ? command
          : skillCommandSchema.parse(command),
      );
      const snapshot = await this.snapshot();
      this.changed(snapshot);
      return snapshot;
    }
    if (command.type.startsWith("service.")) {
      if (command.type === "service.model.select") await this.runtime.stopAll();
      await this.workService.execute(workServiceCommandSchema.parse(command));
      const snapshot = await this.snapshot();
      this.changed(snapshot);
      return snapshot;
    }
    if (command.type.startsWith("routine.")) {
      await this.routines.execute(routineCommandSchema.parse(command));
      const snapshot = await this.snapshot();
      this.changed(snapshot);
      return snapshot;
    }
    if (command.type.startsWith("media.")) {
      await handleMediaCommand(
        this.featureHost(),
        mediaCommandSchema.parse(command),
      );
      const snapshot = await this.snapshot();
      this.changed(snapshot);
      return snapshot;
    }
    if (command.type.startsWith("delivery.")) {
      await handleDeliveryCommand(
        this.featureHost(),
        deliveryCommandSchema.parse(command),
      );
      const snapshot = await this.snapshot();
      this.changed(snapshot);
      return snapshot;
    }
    switch (command.type) {
      case "project.import":
        throw new Error("请通过桌面选择已有项目目录。");
      case "project.import.path": {
        await this.scanning;
        const project = await inspectImportedProject(command.path);
        if (!this.projects().some((item) => item.root === project.root)) {
          const key = `projects.imported:${this.store.settings().aiRoot}`;
          const roots = this.store.config<string[]>(key, () => []);
          if (roots.length >= 50)
            throw new Error(
              "导入目录已达50个，请使用统一Code目录的自动发现管理更多项目。",
            );
          this.store.setConfig(key, [...new Set([...roots, project.root])]);
          this.importedProjects.push(project);
        }
        break;
      }
      case "skill.setEnabled":
        setSkillEnabled(this.store, command.skillId, command.enabled);
        break;
      case "task.setSkills": {
        const current = this.store.task(command.taskId);
        if (current.archivedAt)
          throw new Error("请先恢复这项工作，再更改 Skill。");
        if (
          this.runtime.isRunning(current.id) ||
          ["running", "waiting"].includes(current.status)
        )
          throw new Error("请先暂停当前工作，再更改本次使用的方法。");
        const policy = validateSkillPolicy(command.policy);
        const bindings = bindTaskSkills(this.store, {
          ...current,
          skillPolicy: policy,
        });
        if (
          JSON.stringify(
            current.skillPolicy ?? { mode: "auto", skillIds: [] },
          ) === JSON.stringify(policy)
        )
          break;
        const pins = mergeTaskSkillPins(current, bindings);
        this.store.updateTask(current.id, (task) => {
          task.skillPolicy = policy;
          task.skillPins = pins;
          task.skillBindings = bindings;
          task.goalVersion++;
          task.status = "paused";
          task.error = undefined;
          task.events.push({
            id: uid(),
            createdAt: now(),
            type: "skill.policy_changed",
            goalVersion: task.goalVersion,
            summary: "工作方法已更新，已有成果保留；继续处理时应用本次选择。",
            data: {
              mode: policy.mode,
              skillIds: policy.skillIds,
              continuedUserMessageId: task.messages.findLast(
                (message) => message.role === "user",
              )?.id,
            },
          });
        });
        this.store.saveCheckpoint(current.id, null);
        break;
      }
      case "snapshot":
        break;
      case "project.refresh":
        await this.refreshProjects();
        break;
      case "project.browse":
      case "project.read": {
        const project = this.projects().find(
          (item) => item.id === command.projectId,
        );
        if (!project) throw new Error("项目列表已变化，请刷新项目。");
        const request = ++this.browserSequence;
        const scope = this.browserScope;
        const codeRoot = this.store.settings().codeRoot;
        const browser =
          command.type === "project.read"
            ? await this.projectFiles.read(
                project,
                codeRoot,
                command.worktreePath,
                command.path,
              )
            : await this.projectFiles.browse(
                project,
                codeRoot,
                command.worktreePath,
                command.path,
              );
        if (this.closing) throw new Error("工作台正在关闭。");
        if (
          scope !== this.browserScope ||
          this.store.settings().codeRoot !== codeRoot
        )
          throw new Error("项目目录设置已变化，请重新选择文件。");
        if (request === this.browserSequence) this.projectBrowser = browser;
        // Every request needs its own directory result, even if a newer request
        // already owns the shared preview. Broadcast only the latest selection.
        browserReply = browser;
        replyScope = scope;
        break;
      }
      case "task.rename":
        this.store.updateTask(command.taskId, (task) => {
          task.title = requireText(command.title, 120, "工作名称");
        });
        break;
      case "task.archive":
      case "task.restore": {
        await this.runtime.stop(command.taskId);
        this.store.updateTask(command.taskId, (task) => {
          if (command.type === "task.restore") {
            if (!task.archivedAt)
              throw new Error("这项工作没有归档，无需恢复。");
            delete task.archivedAt;
          } else task.archivedAt = now();
        });
        break;
      }
      case "message.save": {
        const key = `${command.taskId}:${command.messageId}`;
        let pending = this.documentSaves.get(key);
        if (!pending) {
          pending = (async () => {
            const task = this.store.task(command.taskId);
            const message = task.messages.find(
              (item) =>
                item.id === command.messageId && item.role === "assistant",
            );
            if (!message) throw new Error("找不到这份对话详情。");
            const artifact = await writeArtifact(this.store, task.id, {
              title: `${task.title} · 对话详情`,
              content: message.content,
              format: "md",
              goalVersion: task.goalVersion,
              operationId: `message-document:${task.id}:${message.id}:${hash(message.content)}`,
            });
            if (
              !task.events.some(
                (event) =>
                  event.type === "message.saved" &&
                  event.data?.messageId === message.id,
              )
            )
              this.store.event(task.id, {
                type: "message.saved",
                goalVersion: task.goalVersion,
                summary: "已将对话详情保存为文档。",
                data: { messageId: message.id, artifactId: artifact.id },
              });
          })();
          this.documentSaves.set(key, pending);
        }
        try {
          await pending;
        } finally {
          if (this.documentSaves.get(key) === pending)
            this.documentSaves.delete(key);
        }
        break;
      }
      case "process.save": {
        const task = this.store.task(command.taskId);
        const document = buildProcessDocument(task, command.member, {
          scope: command.scope ?? "all",
        });
        await writeArtifact(this.store, task.id, {
          ...document,
          format: "md",
          goalVersion: task.goalVersion,
          operationId: uid(),
        });
        break;
      }
      case "task.create": {
        const creationKey = command.requestId
          ? `task.creation:${command.requestId}`
          : undefined;
        const creationFingerprint = JSON.stringify({
          goal: command.goal,
          title: command.title,
          kind: command.kind,
          member: command.member,
          projectId: command.projectId,
          teamMode: command.teamMode,
          isolatedContext: command.isolatedContext,
          skillPolicy: command.skillPolicy,
        });
        const previousCreation = creationKey
          ? this.store.config<{ id: string; fingerprint: string } | null>(
              creationKey,
              () => null,
            )
          : null;
        if (previousCreation) {
          if (previousCreation.fingerprint !== creationFingerprint)
            throw new Error("这次工作请求已使用不同内容创建，请使用新的请求。");
          if (!this.store.hasTask(previousCreation.id))
            throw new Error("这次请求对应的工作已删除，不能自动重建。");
          break;
        }
        const skillPolicy = validateSkillPolicy(command.skillPolicy);
        const skillBindings = bindTaskSkills(this.store, {
          skillPolicy,
          goal: command.goal,
          member: command.member ?? "coordinator",
          teamMode: command.teamMode,
        } as Task);
        if (
          command.projectId &&
          !this.projects().some((project) => project.id === command.projectId)
        )
          throw new Error("项目列表已变化，请刷新并重新选择项目。");
        const goal = requireText(command.goal, 40000, "工作目标");
        const settings = this.store.settings();
        if (
          within(settings.aiRoot, settings.workspaceRoot) &&
          this.system?.state === "missing"
        ) {
          this.system = await bootstrapSystem(
            settings.aiRoot,
            settings.codeRoot,
          );
          if (this.system.state !== "ready")
            throw new Error("本机 AI 规则尚未就绪，请在设置中检查。");
        }
        const id = uid();
        const workspace = await ensureOwnedDirectory(
          path.join(settings.workspaceRoot, id),
        );
        this.store.db.exec("BEGIN IMMEDIATE");
        try {
          this.store.saveTask({
            id,
            requestId: command.requestId,
            isolatedContext: command.isolatedContext,
            teamMode: command.teamMode,
            title: (command.title || goal).slice(0, 60),
            skillPolicy,
            skillPins: structuredClone(skillBindings),
            skillBindings,
            goal,
            goalVersion: 1,
            kind: command.kind ?? "research",
            member: command.member ?? "coordinator",
            profileId: command.profileId,
            projectId: command.projectId,
            workspace,
            status: "idle",
            createdAt: now(),
            updatedAt: now(),
            messages: [
              {
                id: uid(),
                role: "user",
                member: command.member ?? "coordinator",
                content: goal,
                createdAt: now(),
                goalVersion: 1,
              },
            ],
            events: [],
            sources: [],
            artifacts: [],
          });
          if (creationKey)
            this.store.setConfig(creationKey, {
              id,
              fingerprint: creationFingerprint,
            });
          this.store.db.exec("COMMIT");
        } catch (error) {
          this.store.db.exec("ROLLBACK");
          throw error;
        }
        break;
      }
      case "task.send": {
        const existingTask = this.store.task(command.taskId);
        if (existingTask.archivedAt)
          throw new Error("请先恢复这项工作，再发送消息。");
        const content = requireText(command.text, 40000, "消息");
        bindTaskSkills(this.store, existingTask);
        await this.runtime.stop(command.taskId);
        const stoppedTask = this.store.task(command.taskId);
        if (this.closing) throw new Error("工作台正在关闭。");
        if (this.taskDeletions.has(command.taskId))
          throw new Error("这项工作正在永久删除。");
        if (stoppedTask.archivedAt)
          throw new Error("请先恢复这项工作，再发送消息。");
        bindTaskSkills(this.store, stoppedTask);
        this.store.updateTask(command.taskId, (task) => {
          task.goalVersion++;
          if (command.reviseGoal) task.goal = content;
          if (command.member) task.member = command.member;
          if (command.profileId !== undefined)
            task.profileId = command.profileId || undefined;
          task.messages.push({
            id: uid(),
            role: "user",
            member: task.member,
            content,
            createdAt: now(),
            goalVersion: task.goalVersion,
          });
          task.status = "idle";
          task.error = undefined;
        });
        this.store.saveCheckpoint(command.taskId, null);
        this.start(command.taskId);
        break;
      }
      case "task.run":
        this.store.task(command.taskId);
        this.start(command.taskId);
        break;
      case "task.stop":
        await this.runtime.stop(command.taskId);
        break;
      case "source.addText":
        await this.addSource(
          command.taskId,
          textSource(
            requireText(command.title, 200, "资料标题"),
            requireText(command.text, 2_000_000, "资料正文"),
          ),
          command.expectedGoalVersion,
        );
        break;
      case "source.addURL":
        await this.addSource(command.taskId, await this.readURL(command.url));
        break;
      case "source.import.paths":
        for (const sourcePath of command.paths)
          await this.addSource(command.taskId, await importFile(sourcePath));
        break;
      case "radar.reload":
        await this.refreshRadarCatalog();
        break;
      case "radar.editorialVersion":
        await this.loadEditorialRevision(command.issueId, command.revisionId);
        break;
      case "radar.correctEditorial": {
        const identity = await this.requireRadarIdentity();
        const gateway = this.options.sourceGateway;
        if (!gateway?.correctEditorial)
          throw new Error("当前信息源服务尚不支持纠正。");
        const result = await gateway.correctEditorial(
          command.issueId,
          { revisionId: command.revisionId, text: command.text.trim() },
          command.requestId,
        );
        if (
          this.closing ||
          gateway !== this.options.sourceGateway ||
          result.serverInstanceId !== identity.serverInstanceId ||
          result.tenantId !== identity.tenantId
        )
          throw new Error("信息源连接已改变，请重新打开解读。");
        const key = `radar.editorial:${identity.serverInstanceId}:${identity.tenantId}`;
        const feed = this.store.config<Omit<EditorialResponse, "meta"> | null>(
          key,
          () => null,
        );
        if (feed)
          this.store.setConfig(key, {
            ...feed,
            issues: feed.issues.map((issue) =>
              issue.id === command.issueId
                ? {
                    ...issue,
                    corrections: [
                      result.correction,
                      ...issue.corrections.filter(
                        (correction) => correction.id !== result.correction.id,
                      ),
                    ].slice(0, 30),
                  }
                : issue,
            ),
          });
        break;
      }
      case "radar.follow": {
        const gateway = this.options.sourceGateway;
        if (!gateway?.follow)
          throw new Error("当前信息源服务尚不支持来源关注。");
        const identity = await this.requireRadarIdentity();
        const common = {
          name: command.name,
          refreshIntervalMinutes: command.refreshIntervalMinutes,
        };
        const input: CreateRadarFollowInput = command.url
          ? { ...common, url: command.url }
          : { ...common, recommendedSourceId: command.recommendedSourceId! };
        const follow = await gateway.follow(input);
        this.store.saveRadarFollow(identity, follow);
        this.store.appendRadarEvent(identity, {
          id: uid(),
          type: "follow.created",
          summary: `Radar 已关注：${follow.name}`,
          createdAt: now(),
          followId: follow.id,
        });
        this.radarConnection = "online";
        this.radarError = undefined;
        break;
      }
      case "radar.setFollowState": {
        const gateway = this.options.sourceGateway;
        if (!gateway?.setFollowState)
          throw new Error("当前信息源服务尚不支持暂停或继续关注。");
        const identity = await this.requireRadarIdentity();
        const follow = await gateway.setFollowState(
          command.followId,
          command.state,
        );
        this.store.saveRadarFollow(identity, follow);
        this.store.appendRadarEvent(identity, {
          id: uid(),
          type: "follow.updated",
          summary: `${follow.state === "active" ? "已继续关注" : "已暂停关注"}：${follow.name}`,
          createdAt: now(),
          followId: follow.id,
        });
        this.radarConnection = "online";
        this.radarError = undefined;
        break;
      }
      case "radar.refresh": {
        const gateway = this.options.sourceGateway;
        if (!gateway?.refreshFollow)
          throw new Error("当前信息源服务尚不支持刷新关注来源。");
        const identity = await this.requireRadarIdentity();
        const followIds = command.followId
          ? [command.followId]
          : this.store
              .radarFollows(identity)
              .filter((follow) => follow.state === "active")
              .map((follow) => follow.id);
        for (const followId of followIds) {
          const follow = await gateway.refreshFollow(followId);
          this.store.saveRadarFollow(identity, follow);
        }
        this.radarConnection = "online";
        this.radarError = undefined;
        break;
      }
      case "radar.unfollow": {
        const gateway = this.options.sourceGateway;
        if (!gateway?.unfollow)
          throw new Error("当前信息源服务尚不支持取消关注。");
        const identity = await this.requireRadarIdentity();
        const name = this.store
          .radarFollows(identity)
          .find((follow) => follow.id === command.followId)?.name;
        await gateway.unfollow(command.followId);
        this.store.removeRadarFollow(identity, command.followId);
        this.store.appendRadarEvent(identity, {
          id: uid(),
          type: "follow.removed",
          summary: `Radar 已取消关注${name ? `：${name}` : ""}`,
          createdAt: now(),
          followId: command.followId,
        });
        this.radarConnection = "online";
        this.radarError = undefined;
        break;
      }
      case "radar.markRead":
        this.store.setRadarItemRead(command.itemId, command.read);
        break;
      case "radar.archive":
        this.store.setRadarItemArchived(command.itemId, command.archived);
        break;
      case "radar.addToTask": {
        await this.runtime.stop(command.taskId);
        const sources = this.store.radarSources(command.itemIds);
        this.store.commitRadarSourcesToTask(command.taskId, sources);
        for (const itemId of new Set(command.itemIds))
          this.store.setRadarItemRead(itemId, true);
        break;
      }
      case "radar.digest": {
        const identity = this.radarIdentity ?? this.store.radarIdentity();
        if (!identity)
          throw new Error("还没有可消化的信息源记录，请先接收真实来源内容。");
        const selected = new Set(command.itemIds);
        const currentItems = new Map(
          this.store
            .radarItems(identity)
            .filter((item) => selected.has(item.id))
            .map((item) => [item.id, item]),
        );
        const retryOfRunId = command.retry
          ? this.store.radarDigestions(identity).find((run) => {
              if (run.state !== "pending" || !this.store.hasTask(run.taskId))
                return false;
              const task = this.store.task(run.taskId);
              if (task.status !== "failed" && task.status !== "completed")
                return false;
              return [...selected].every((itemId) => {
                const current = currentItems.get(itemId);
                return (
                  !!current &&
                  run.items.some(
                    (item) =>
                      item.radarItemId === itemId &&
                      item.revisionId === current.latestRevisionId,
                  )
                );
              });
            })?.id
          : undefined;
        if (command.retry && !retryOfRunId)
          throw new Error(
            "只有失败或已结束但未发布的当前 Radar 消化批次可以重试。",
          );
        await this.createRadarDigestion(command.itemIds, retryOfRunId);
        break;
      }
      case "radar.discussEditorial":
      case "radar.createTask": {
        if (
          command.type === "radar.discussEditorial" &&
          this.store.hasTask(command.requestId)
        )
          break;
        const revision =
          command.type === "radar.discussEditorial"
            ? await this.loadEditorialRevision(
                command.issueId,
                command.revisionId,
              )
            : undefined;
        const sources = revision
          ? [
              textSource(
                `雷达解读 · ${revision.title} · v${revision.version}`,
                editorialDocument(revision),
                "text",
                `雷达议题 ${revision.issueId} / 版本 ${revision.id}`,
              ),
            ]
          : this.store.radarSources(
              command.type === "radar.createTask" ? command.itemIds : [],
            );
        const settings = this.store.settings();
        if (
          within(settings.aiRoot, settings.workspaceRoot) &&
          this.system?.state === "missing"
        ) {
          this.system = await bootstrapSystem(
            settings.aiRoot,
            settings.codeRoot,
          );
          if (this.system.state !== "ready")
            throw new Error("本机 AI 规则尚未就绪，请在设置中检查。");
        }
        const id =
          command.type === "radar.discussEditorial" ? command.requestId : uid();
        const workspace = await ensureOwnedDirectory(
          path.join(settings.workspaceRoot, id),
        );
        const instruction = command.instruction
          ? requireText(command.instruction, 40000, "处理要求")
          : `理解并整理 Radar 中选中的 ${sources.length} 条信息，合并为有证据的主题判断，并说明与当前目标和已有资料的关系。`;
        const title = command.title
          ? requireText(command.title, 120, "工作名称")
          : sources.length === 1
            ? sources[0]!.title.slice(0, 60)
            : `${sources[0]!.title.slice(0, 44)} 等 ${sources.length} 条`;
        const createdAt = now();
        this.store.createTaskFromRadar(
          {
            id,
            title,
            goal: instruction,
            goalVersion: 1,
            kind: "research",
            member: "coordinator",
            workspace,
            status: "idle",
            createdAt,
            updatedAt: createdAt,
            messages: [
              {
                id: uid(),
                role: "user",
                member: "coordinator",
                content: instruction,
                createdAt,
                goalVersion: 1,
              },
            ],
            events: [],
            sources: [],
            artifacts: [],
          },
          sources,
        );
        if (command.type === "radar.createTask")
          for (const itemId of new Set(command.itemIds))
            this.store.setRadarItemRead(itemId, true);
        break;
      }
      case "artifact.save": {
        const task = this.store.task(command.taskId);
        const artifact = task.artifacts.find(
          (a) => a.id === command.artifactId,
        );
        if (!artifact || !["md", "html"].includes(artifact.format))
          throw new Error("这种成果不能作为文本修订。");
        await writeArtifact(this.store, task.id, {
          title: artifact.title,
          content: command.content,
          format: artifact.format as "md" | "html",
          goalVersion: task.goalVersion,
          artifactId: artifact.id,
          expectedHash: command.expectedHash,
        });
        break;
      }
      case "artifact.refine": {
        const instruction = requireText(command.instruction, 40000, "处理要求");
        await this.runtime.stop(command.taskId);
        const task = this.store.task(command.taskId);
        const artifact = task.artifacts.find(
          (item) => item.id === command.artifactId,
        );
        if (!artifact || !["md", "html"].includes(artifact.format))
          throw new Error(
            "请选择 Markdown 或 HTML 原文档继续处理；图片和 PPT 请修改源文档后重新导出。",
          );
        if (
          hash(readOwnedArtifactSync(artifact, task.workspace)) !==
          command.expectedHash
        )
          throw new Error("成果已经改变，请刷新后再提交处理要求。");
        this.store.updateTask(task.id, (current) => {
          current.goalVersion++;
          current.status = "idle";
          current.error = undefined;
          current.messages.push({
            id: uid(),
            role: "user",
            member: current.member,
            createdAt: now(),
            goalVersion: current.goalVersion,
            content: `继续处理《${artifact.title}》：\n${instruction}`,
          });
          current.events.push({
            id: uid(),
            type: "artifact.refine_requested",
            member: current.member,
            summary: `继续处理《${artifact.title}》：${instruction.slice(0, 140)}`,
            createdAt: now(),
            goalVersion: current.goalVersion,
            data: {
              artifactId: artifact.id,
              expectedHash: command.expectedHash,
              artifactVersion: artifact.version,
              instruction,
            },
          });
        });
        this.store.saveCheckpoint(task.id, null);
        this.start(task.id);
        break;
      }
      case "library.collect": {
        const settings = this.store.settings();
        if (this.system?.state === "missing") {
          this.system = await bootstrapSystem(
            settings.aiRoot,
            settings.codeRoot,
          );
          if (this.system.state !== "ready")
            throw new Error("本机 AI 规则尚未就绪，请在设置中检查。");
        }
        const entry = await collectArtifact(
          this.store,
          settings.aiRoot,
          command,
        );
        this.store.event(command.taskId, {
          type: "library.collected",
          summary: `已收藏《${entry.title}》到本地 Lib，可作为可复用资产继续编辑。`,
          goalVersion: this.store.task(command.taskId).goalVersion,
          data: {
            entryId: entry.id,
            artifactId: command.artifactId,
            path: entry.path,
          },
        });
        break;
      }
      case "library.save": {
        const entry = await saveLibraryEntry(
          this.store,
          this.store.settings().aiRoot,
          command,
        );
        await this.invalidateLibraryTasks(
          entry.id,
          `version:${entry.version}:${entry.hash}`,
        );
        break;
      }
      case "library.feedback": {
        const feedback = recordLibraryFeedback(
          this.store,
          this.store.settings().aiRoot,
          command,
        );
        await this.invalidateLibraryTasks(
          feedback.entryId,
          `feedback:${feedback.id}`,
        );
        break;
      }
      case "library.reuse":
        await this.addSource(
          command.taskId,
          librarySource(
            this.store,
            this.store.settings().aiRoot,
            command.entryId,
          ),
        );
        break;
      case "artifact.export":
      case "artifact.exportPNG": {
        const task = this.runtimeTask(command.taskId);
        const artifact = task.artifacts.find(
          (a) => a.id === command.artifactId,
        );
        if (!artifact || !["md", "html"].includes(artifact.format))
          throw new Error("请选择文字或 HTML 成果导出。");
        const isPNG = command.type === "artifact.exportPNG";
        if (
          isPNG &&
          (artifact.hash !== command.expectedHash ||
            task.goalVersion !== command.goalVersion)
        )
          throw new Error("成果已更新，请重新导出。");
        if (!isPNG && command.format !== "pptx")
          throw new Error("图片导出需要桌面应用。");
        const content = isPNG
          ? Buffer.from(command.png)
          : await presentation(artifact);
        await writeArtifactData(this.store, task.id, {
          title: `${artifact.title} · ${isPNG ? "信息图" : "演示文稿"}`,
          content,
          format: isPNG ? "png" : "pptx",
          goalVersion: task.goalVersion,
        });
        break;
      }
      case "profile.save": {
        const p = validateProfile(command.profile);
        const previous = this.store.profiles().find((old) => old.id === p.id);
        const changed =
          !previous ||
          profileConnectionKey(previous) !== profileConnectionKey(p) ||
          ("keyChanged" in command && command.keyChanged) ||
          ("apiKey" in command && command.apiKey !== undefined);
        if (changed)
          await Promise.all([this.runtime.stopAll(), this.stopProbes(p.id)]);
        const hasKey = Boolean(await this.readKey(p));
        const evidence = this.store.profiles().find((old) => old.id === p.id);
        const profiles = this.store.profiles().filter((old) => old.id !== p.id);
        profiles.push({
          ...p,
          hasKey,
          status: !hasKey
            ? "unconfigured"
            : changed
              ? "untested"
              : evidence?.status === "unconfigured"
                ? "untested"
                : (evidence?.status ?? "untested"),
          lastError: changed ? undefined : evidence?.lastError,
          testedAt: changed ? undefined : evidence?.testedAt,
          capabilities: changed ? undefined : evidence?.capabilities,
        });
        this.store.setConfig("profiles", profiles);
        break;
      }
      case "profile.probe": {
        const profile = this.store
          .profiles()
          .find((p) => p.id === command.profileId);
        if (!profile) throw new Error("连接不存在。");
        const hasKey = Boolean(await this.readKey(profile));
        const result = hasKey
          ? await this.startProfileProbe(profile)
          : {
              capabilities: { text: false, tools: false, streaming: false },
              error: "未找到密钥，请先配置密钥或对应环境变量。",
            };
        if (this.closing) throw new Error("工作台正在关闭，连接检查已停止。");
        this.store.setConfig(
          "profiles",
          this.store.profiles().map((p) =>
            p.id === profile.id &&
            profileConnectionKey(p) === profileConnectionKey(profile)
              ? {
                  ...p,
                  hasKey,
                  status: !hasKey
                    ? "unconfigured"
                    : result.capabilities.text
                      ? "ready"
                      : "incomplete" in result && result.incomplete
                        ? "untested"
                        : "failed",
                  lastError: result.error,
                  capabilities:
                    !hasKey ||
                    ("incomplete" in result &&
                      result.incomplete &&
                      !result.capabilities.text)
                      ? undefined
                      : result.capabilities,
                  testedAt: hasKey ? now() : undefined,
                }
              : p,
          ),
        );
        if (result.capabilities.tools)
          this.scheduleRadarDigestion(this.options.radarDigestDelayMs ?? 800);
        break;
      }
      case "settings.save": {
        const settings = validateSettings(command.settings);
        const previous = this.store.settings();
        const {
          projectMonitoring: _a,
          backgroundRoutines: _c,
          ...before
        } = previous;
        const {
          projectMonitoring: _b,
          backgroundRoutines: _d,
          ...after
        } = settings;
        if (JSON.stringify(before) !== JSON.stringify(after))
          await this.runtime.stopAll();
        this.store.setConfig("settings", settings);
        if (
          previous.codeRoot !== settings.codeRoot ||
          previous.aiRoot !== settings.aiRoot
        ) {
          this.browserScope++;
          this.browserSequence++;
          this.projectBrowser = undefined;
        }
        this.scheduleProjects();
        await recoverLibrary(this.store, settings.aiRoot);
        await this.refreshSystem();
        this.scheduleRadarDigestion(this.options.radarDigestDelayMs ?? 800);
        break;
      }
      case "system.bootstrap": {
        const settings = this.store.settings();
        this.system = await bootstrapSystem(settings.aiRoot, settings.codeRoot);
        await this.refreshSystem();
        break;
      }
      case "project.initialize": {
        const key = command.input.taskId ?? uid();
        if (this.projectInitializations.has(key))
          throw new Error("这个讨论正在创建项目，请等待当前创建完成。");
        const pending = (async () => {
          const settings = this.store.settings();
          const input = { ...command.input };
          if (input.taskId) {
            const linked = this.store.task(input.taskId);
            const priorId =
              linked.projectId ??
              linked.events.findLast(
                (event) => event.type === "project.initialized",
              )?.data?.projectId;
            if (priorId)
              throw new Error(
                "这项工作已经关联项目，请在项目页查看和继续讨论。",
              );
          }
          const initializedGoalVersion = input.taskId
            ? this.store.task(input.taskId).goalVersion
            : undefined;
          if (input.taskId) {
            const task = this.runtimeTask(input.taskId);
            const current = task.artifacts
              .filter(
                (a) =>
                  a.format === "md" &&
                  a.content &&
                  a.goalVersion === task.goalVersion,
              )
              .map((a) => `## ${a.title}\n${a.content}`)
              .join("\n\n");
            input.description =
              `${input.description}\n\n## 团队讨论目标\n${task.goal}\n\n${current}`.slice(
                0,
                150000,
              );
          }
          const result = await initializeProject(
            settings.aiRoot,
            settings.codeRoot,
            input,
          );
          if (input.taskId)
            this.store.event(input.taskId, {
              type: "project.initialized",
              member: "cto",
              summary:
                this.store.task(input.taskId).goalVersion ===
                initializedGoalVersion
                  ? `已建立项目 ${result.project.name}，可交给 Codex。`
                  : `已按目标版本 ${initializedGoalVersion} 建立项目 ${result.project.name}；目标后来有更新，请审阅项目文档。`,
              goalVersion: initializedGoalVersion!,
              data: {
                projectId: result.project.id,
                devPath: result.project.devPath,
                checks: result.checks,
              },
            });
          await this.refreshSystem();
        })();
        this.projectInitializations.set(key, pending);
        try {
          await pending;
        } finally {
          this.projectInitializations.delete(key);
        }
        break;
      }
      default:
        throw new Error("此操作需要桌面应用。");
    }
    if (this.closing) throw new Error("工作台正在关闭。");
    const snapshot = await this.snapshot();
    if (replyScope !== undefined && replyScope !== this.browserScope)
      throw new Error("项目目录设置已变化，请重新选择文件。");
    snapshot.projectBrowser = this.projectBrowser;
    this.changed(snapshot);
    return browserReply
      ? { ...snapshot, projectBrowser: browserReply }
      : snapshot;
  }
  private startProfileProbe(profile: ModelProfile): Promise<HostedProbeResult> {
    const existing = this.probes.get(profile.id);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(90_000),
    ]);
    const promise = (
      profile.execution === "google-agent"
        ? this.probeGoogleAgent(profile, signal)
        : probeProfile(profile, this.readKey, {
            signal,
            modelFactory: this.options.modelFactory,
          })
    ).finally(() => this.probes.delete(profile.id));
    this.probes.set(profile.id, { controller, promise });
    return promise;
  }
  private async stopProbes(profileId?: string): Promise<void> {
    const active = [...this.probes.entries()]
      .filter(([id]) => !profileId || id === profileId)
      .map(([, probe]) => probe);
    for (const probe of active)
      probe.controller.abort(new DOMException("连接检查已停止", "AbortError"));
    await Promise.allSettled(active.map((probe) => probe.promise));
  }
  private async probeGoogleAgent(
    profile: ModelProfile,
    signal: AbortSignal,
  ): Promise<HostedProbeResult> {
    const capabilities = { text: false, tools: false, streaming: false };
    try {
      const model = await (
        this.options.googleAgentFactory ?? createGoogleAgentModel
      )(profile, this.readKey);
      const result = await new Runner({ tracingDisabled: true }).run(
        new Agent({ name: "synthetic_agent_probe", model }),
        "Synthetic connection test only. Reply with exactly AGENT_OK. Do not browse or create files.",
        { signal, maxTurns: 1 },
      );
      capabilities.text = String(result.finalOutput).includes("AGENT_OK");
      return {
        capabilities,
        error: capabilities.text ? undefined : "专项 Agent 未返回预期文本。",
      };
    } catch (error) {
      return {
        capabilities,
        incomplete: signal.aborted,
        error: signal.aborted
          ? "90 秒连接检查尚未得到最终结果，已请求取消；专项研究仍可保存后作为任务运行。"
          : safeError(error),
      };
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    if (this.workTimer) clearTimeout(this.workTimer);
    await this.workService.close();
    if (this.routineTimer) clearTimeout(this.routineTimer);
    await this.routines.close();
    await this.routineTick;
    if (this.projectTimer) clearTimeout(this.projectTimer);
    if (this.radarTimer) clearTimeout(this.radarTimer);
    if (this.radarDigestTimer) clearTimeout(this.radarDigestTimer);
    await this.options.sourceGateway?.close?.();
    await this.radarDigestion?.catch(() => undefined);
    await Promise.all([
      this.runtime.stopAll(),
      this.scanning,
      this.radarCatalogRefresh?.catch(() => undefined),
      this.radarDigestionCreation,
      this.stopProbes(),
      ...[...this.featureCommands].map((pending) =>
        pending.catch(() => undefined),
      ),
      ...[...this.featureCreates.values()].map((entry) =>
        entry.promise.catch(() => undefined),
      ),
      ...[...this.featureWorks.values()].map((entry) =>
        entry.promise.catch(() => undefined),
      ),
      ...[...this.taskDeletions.values()].map((pending) =>
        pending.catch(() => undefined),
      ),
      ...[...this.taskCommands.values()]
        .flatMap((commands) => [...commands])
        .map((pending) => pending.catch(() => undefined)),
      ...this.documentSaves.values(),
      ...this.projectInitializations.values(),
      ...[...this.sourceReceives].map((pending) =>
        pending.catch(() => undefined),
      ),
    ]);
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.store.close();
  }
}
function profileConnectionKey(profile: ModelProfile): string {
  return JSON.stringify([
    profile.provider,
    profile.protocol,
    profile.execution ?? "model",
    profile.streamingMode ?? "incremental",
    profile.baseURL.trim().replace(/\/$/, "") ||
      (profile.protocol === "google"
        ? "https://generativelanguage.googleapis.com/v1beta"
        : ""),
    profile.modelId.trim(),
    profile.apiKeyEnv.trim(),
  ]);
}
function requireText(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`${label}为空或过长。`);
  return value.trim();
}
export function validateProfile(input: ModelProfile): ModelProfile {
  const p = {
    id: requireText(input.id, 80, "连接 ID"),
    name: requireText(input.name, 120, "连接名称"),
    provider: input.provider,
    protocol: input.protocol,
    execution: input.execution ?? "model",
    streamingMode: input.streamingMode,
    baseURL: typeof input.baseURL === "string" ? input.baseURL.trim() : "",
    modelId: typeof input.modelId === "string" ? input.modelId.trim() : "",
    apiKeyEnv:
      typeof input.apiKeyEnv === "string" ? input.apiKeyEnv.trim() : "",
    hasKey: false,
    status: "untested" as const,
  };
  if (
    !/^[a-zA-Z0-9_-]+$/.test(p.id) ||
    !["gemini", "deepseek", "ark", "compatible"].includes(p.provider) ||
    !["google", "openai"].includes(p.protocol)
  )
    throw new Error("连接类型或 ID 无效。");
  if (
    p.streamingMode !== undefined &&
    !["buffered", "incremental"].includes(p.streamingMode)
  )
    throw new Error("响应方式无效。");
  if (
    !["model", "google-agent"].includes(p.execution) ||
    (p.execution === "google-agent" &&
      (p.provider !== "gemini" || p.protocol !== "google"))
  )
    throw new Error("专项 Agent 必须使用 Google 原生连接。");
  if (
    /^(deep-research|antigravity)/.test(p.modelId) &&
    p.execution !== "google-agent"
  )
    throw new Error("此 ID 是专项 Agent，请切换为 Google 专项 Agent。");
  if (p.apiKeyEnv && !/^[A-Z][A-Z0-9_]*$/.test(p.apiKeyEnv))
    throw new Error("环境变量名格式不正确。");
  if (p.baseURL) {
    const url = new URL(p.baseURL);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("模型接口地址格式不正确。");
  }
  return p;
}
export function validateSettings(input: AppSettings): AppSettings {
  for (const value of [input.aiRoot, input.codeRoot, input.workspaceRoot])
    if (
      typeof value !== "string" ||
      !path.isAbsolute(value) ||
      path.parse(value).root === path.resolve(value)
    )
      throw new Error("请选择有效的绝对目录。");
  if (
    within(input.aiRoot, input.codeRoot) ||
    within(input.codeRoot, input.aiRoot)
  )
    throw new Error("AI 与 Code 应使用各自独立的目录。");
  return {
    aiRoot: path.resolve(input.aiRoot),
    codeRoot: path.resolve(input.codeRoot),
    workspaceRoot: path.resolve(input.workspaceRoot),
    defaultProfileId: input.defaultProfileId,
    memberSettings: normalizeTeamSettings(input.memberSettings),
    projectMonitoring: input.projectMonitoring !== false,
    libraryRecall: input.libraryRecall !== false,
    backgroundRoutines: input.backgroundRoutines === true,
    memberProfiles: {
      coordinator: input.memberProfiles.coordinator,
      cto: input.memberProfiles.cto,
      researcher: input.memberProfiles.researcher,
      editor: input.memberProfiles.editor ?? "",
    },
  };
}
export function safeError(error: unknown): string {
  const value = error instanceof Error ? error.message : "操作失败，请重试。";
  return value
    .replace(/(?:sk-|AIza)[A-Za-z0-9_-]{12,}/g, "[已隐藏密钥]")
    .replace(/Bearer\s+\S+/gi, "Bearer [已隐藏]")
    .slice(0, 700);
}
