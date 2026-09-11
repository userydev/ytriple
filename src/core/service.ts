import path from "node:path";
import {
  normalizeMemberSettings,
  normalizeTeamSettings,
} from "../shared/member-settings.js";
import { buildProcessDocument } from "./process-document.js";
import { ProjectDiscovery } from "./projects.js";
import { createGoogleAgentModel } from "./google-agents.js";
import { Agent, Runner } from "@openai/agents";
import type {
  AppSettings,
  Command,
  ModelProfile,
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
} from "./library.js";
import { importFile, importURL } from "./sources.js";
import { TeamRuntime, type RuntimeCheckpoint } from "./runtime.js";
import { probeProfile } from "./models.js";
import { inspectSystem, bootstrapSystem, initializeProject } from "./system.js";

export type InternalCommand =
  | Command
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
  readonly store: Store;
  readonly runtime: TeamRuntime;
  private system?: Snapshot["system"];
  private readonly projectScanner = new ProjectDiscovery();
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
    } = {},
  ) {
    this.store = new Store(dataPath);
    this.runtime = new TeamRuntime({
      getTask: (id) => this.runtimeTask(id),
      getGoalVersion: (id) => this.store.task(id).goalVersion,
      getProfile: (task, member) => {
        const settings = this.store.settings();
        const id =
          task.profileId ||
          settings.memberProfiles[member] ||
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
        this.store.event(id, event);
        this.notify();
      },
      addAssistantMessage: (id, member, content, goalVersion) => {
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
      loadCheckpoint: (id) => this.store.checkpoint<RuntimeCheckpoint>(id),
      saveCheckpoint: (id, checkpoint) =>
        this.store.saveCheckpoint(id, checkpoint),
      setStatus: (id, status, error) => {
        this.store.updateTask(id, (task) => {
          task.status = status;
          task.error = error;
        });
        this.notify();
      },
    });
  }
  async initialize(): Promise<Snapshot> {
    await recoverArtifacts(this.store);
    await recoverLibrary(this.store, this.store.settings().aiRoot);
    await this.refreshSystem();
    this.scheduleProjects();
    return this.snapshot();
  }
  private runtimeTask(id: string): Task {
    const task = this.store.task(id);
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
      .then(() => {});
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
    return {
      version: "0.1.0",
      dataPath: this.store.dataPath,
      tasks,
      profiles,
      settings: this.store.settings(),
      system: this.system!,
      projects: this.projectScanner.snapshot.projects,
      projectDiscovery: this.projectScanner.snapshot.discovery,
      library: listLibrary(this.store, this.store.settings().aiRoot),
    };
  }
  private start(id: string): void {
    if (this.runtime.isRunning(id)) return;
    void this.runtime.run(id).catch((error) => {
      this.store.updateTask(id, (task) => {
        task.status = "failed";
        task.error = safeError(error);
      });
      this.notify();
    });
  }
  private async addSource(id: string, source: Source): Promise<void> {
    await this.runtime.stop(id);
    this.store.updateTask(id, (task) => {
      if (
        task.sources.some(
          (s) => s.location === source.location && s.text === source.text,
        )
      )
        return;
      task.goalVersion++;
      task.sources.push(source);
      task.status = "idle";
      task.error = undefined;
      task.events.push({
        id: uid(),
        type: "source.imported",
        summary: `已导入资料：${source.title}`,
        goalVersion: task.goalVersion,
        createdAt: now(),
      });
    });
    this.store.saveCheckpoint(id, null);
  }
  async execute(command: InternalCommand): Promise<Snapshot> {
    if (this.closing) throw new Error("工作台正在关闭。");
    switch (command.type) {
      case "snapshot":
        break;
      case "project.refresh":
        await this.refreshProjects();
        break;
      case "process.save": {
        const task = this.store.task(command.taskId);
        const document = buildProcessDocument(task, command.member);
        await writeArtifact(this.store, task.id, {
          ...document,
          format: "md",
          goalVersion: task.goalVersion,
          operationId: uid(),
        });
        break;
      }
      case "task.create": {
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
        this.store.saveTask({
          id,
          title: (command.title || goal).slice(0, 60),
          goal,
          goalVersion: 1,
          kind: command.kind ?? "research",
          member: command.member ?? "coordinator",
          profileId: command.profileId,
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
        break;
      }
      case "task.send": {
        const content = requireText(command.text, 40000, "消息");
        await this.runtime.stop(command.taskId);
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
        );
        break;
      case "source.addURL":
        await this.addSource(command.taskId, await importURL(command.url));
        break;
      case "source.import.paths":
        for (const sourcePath of command.paths)
          await this.addSource(command.taskId, await importFile(sourcePath));
        break;
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
      case "library.save":
        await saveLibraryEntry(
          this.store,
          this.store.settings().aiRoot,
          command,
        );
        break;
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
        await Promise.all([
          this.runtime.stopAll(),
          this.stopProbes(command.profile.id),
        ]);
        const p = validateProfile(command.profile);
        const profiles = this.store.profiles().filter((old) => old.id !== p.id);
        profiles.push({
          ...p,
          hasKey: Boolean(await this.readKey(p)),
          status: "untested",
          lastError: undefined,
          testedAt: undefined,
          capabilities: undefined,
        });
        this.store.setConfig("profiles", profiles);
        break;
      }
      case "profile.probe": {
        const profile = this.store
          .profiles()
          .find((p) => p.id === command.profileId);
        if (!profile) throw new Error("连接不存在。");
        const result =
          profile.execution === "google-agent"
            ? await this.startGoogleProbe(profile)
            : await probeProfile(profile, this.readKey);
        if (this.closing) throw new Error("工作台正在关闭，连接检查已停止。");
        this.store.setConfig(
          "profiles",
          this.store.profiles().map((p) =>
            p.id === profile.id
              ? {
                  ...p,
                  status:
                    "incomplete" in result && result.incomplete
                      ? "untested"
                      : result.error
                        ? "failed"
                        : "ready",
                  lastError: result.error,
                  capabilities:
                    "incomplete" in result && result.incomplete
                      ? undefined
                      : result.capabilities,
                  testedAt: now(),
                }
              : p,
          ),
        );
        break;
      }
      case "settings.save": {
        const settings = validateSettings(command.settings);
        const previous = this.store.settings();
        const { projectMonitoring: _a, ...before } = previous;
        const { projectMonitoring: _b, ...after } = settings;
        if (JSON.stringify(before) !== JSON.stringify(after))
          await this.runtime.stopAll();
        this.store.setConfig("settings", settings);
        this.scheduleProjects();
        await recoverLibrary(this.store, settings.aiRoot);
        await this.refreshSystem();
        break;
      }
      case "system.bootstrap": {
        const settings = this.store.settings();
        this.system = await bootstrapSystem(settings.aiRoot, settings.codeRoot);
        await this.refreshSystem();
        break;
      }
      case "project.initialize": {
        const settings = this.store.settings();
        const input = { ...command.input };
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
        break;
      }
      default:
        throw new Error("此操作需要桌面应用。");
    }
    const snapshot = await this.snapshot();
    this.changed(snapshot);
    return snapshot;
  }
  private startGoogleProbe(profile: ModelProfile): Promise<HostedProbeResult> {
    const existing = this.probes.get(profile.id);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(90_000),
    ]);
    const promise = this.probeGoogleAgent(profile, signal).finally(() =>
      this.probes.delete(profile.id),
    );
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
    if (this.projectTimer) clearTimeout(this.projectTimer);
    await Promise.all([
      this.runtime.stopAll(),
      this.scanning,
      this.stopProbes(),
    ]);
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.store.close();
  }
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
    memberProfiles: {
      coordinator: input.memberProfiles.coordinator,
      cto: input.memberProfiles.cto,
      researcher: input.memberProfiles.researcher,
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
