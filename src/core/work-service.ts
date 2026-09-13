import path from "node:path";
import { writeFile } from "node:fs/promises";
import { z } from "zod";
import type {
  WorkJob,
  WorkJobInput,
  WorkJobUpdate,
  WorkSchedule,
} from "../../services/work-service/contract.js";
import type { FeatureHost } from "./feature-host.js";
import type {
  WorkServiceCommand,
  WorkServiceSnapshot,
} from "../shared/work-service.js";
import {
  workServiceCommandSchema,
  workAccountSchema,
  workDeviceSchema,
  workModelSchema,
  workJobSchema,
  workExportSchema,
} from "../shared/work-service.js";
import { WorkGateway, workProfileId } from "./work-gateway.js";
import { ensureOwnedDirectory, hash, writeArtifact } from "./files.js";
import { uid, now } from "./store.js";
import { skillCatalog } from "./skill-policy.js";
import { validateSkillBindings } from "./skills.js";

const empty = (): WorkServiceSnapshot => ({
  state: "unconfigured",
  devices: [],
  models: [],
  jobs: [],
  exports: [],
  collected: {},
  submissions: {},
});
const jsonHash = (value: unknown) => hash(JSON.stringify(value));
function parseJob(raw: unknown): WorkJob {
  const job = workJobSchema.parse(raw) as WorkJob;
  if (
    new Set(job.materials.map((item) => item.id)).size !==
      job.materials.length ||
    new Set(job.skills.map((item) => item.id)).size !== job.skills.length ||
    job.materials.some((item) => item.hash && item.hash !== hash(item.text)) ||
    job.skills.some((item) => item.hash !== hash(item.instructions))
  )
    throw new Error("服务材料或方法的版本哈希不一致，未导入该响应。");
  return job;
}
function schedule(
  command: Extract<WorkServiceCommand, { type: "service.job.create" }>,
): WorkSchedule {
  if (command.schedule === "once" || command.schedule === "change")
    return { kind: command.schedule };
  const timezone = command.timezone ?? "UTC";
  if (command.schedule === "after_node")
    return {
      kind: "after_node",
      timezone,
      delayMinutes: command.delayMinutes ?? 1440,
    };
  if (command.schedule === "interval")
    return {
      kind: "time",
      cadence: "interval",
      timezone,
      everyMinutes: command.everyMinutes ?? 60,
    };
  return {
    kind: "time",
    cadence: command.schedule,
    timezone,
    time: command.time ?? "09:00",
    ...(command.schedule === "weekly" ? { weekday: command.weekday ?? 1 } : {}),
  };
}
export class WorkServiceClient {
  private gateway?: WorkGateway;
  private state: WorkServiceSnapshot = empty();
  private refreshing?: { gateway: WorkGateway; promise: Promise<void> };
  private closed = false;
  private generation = 0;
  private readonly operations = new Set<Promise<void>>();
  private readonly collections = new Map<string, Promise<void>>();
  constructor(private readonly host: FeatureHost) {}
  snapshot() {
    return structuredClone(this.state);
  }
  private key(gateway = this.gateway!) {
    return `work-service:${hash(`${gateway.connection.baseURL}\0${gateway.connection.user.id}`)}`;
  }
  private current(gateway: WorkGateway) {
    if (this.closed || this.gateway !== gateway)
      throw new Error("服务账户已切换或连接已关闭，忽略旧账户结果。");
  }
  private persist(gateway = this.gateway) {
    if (gateway && gateway === this.gateway && !this.closed)
      this.host.store.setConfig(this.key(gateway), this.state);
  }
  async connect(gateway: WorkGateway) {
    if (this.closed) throw new Error("服务客户端已经关闭。");
    const generation = ++this.generation;
    this.gateway?.close();
    this.gateway = undefined;
    this.state = empty();
    await Promise.allSettled([...this.operations]);
    if (generation !== this.generation || this.closed) {
      gateway.close();
      return;
    }
    this.gateway = gateway;
    const cached = this.host.store.config<WorkServiceSnapshot>(
      this.key(),
      empty,
    );
    // Cached state has no credentials. Refresh validates all remote fields before replacing it.
    this.state = {
      ...empty(),
      exports: Array.isArray(cached.exports) ? cached.exports : [],
      collected: cached.collected ?? {},
      submissions: cached.submissions ?? {},
      baseURL: gateway.connection.baseURL,
    };
    await this.refresh();
  }
  async disconnect(notice?: string) {
    this.generation++;
    this.gateway?.close();
    this.gateway = undefined;
    this.state = { ...empty(), ...(notice ? { error: notice } : {}) };
    await Promise.allSettled([...this.operations]);
  }
  async close() {
    this.closed = true;
    await this.disconnect();
    await this.refreshing?.promise;
  }
  async refresh(): Promise<void> {
    const gateway = this.gateway;
    if (!gateway || this.closed) return;
    if (this.refreshing?.gateway === gateway) return this.refreshing.promise;
    const promise = (async () => {
      try {
        const raw = await Promise.all([
          gateway.request("/v1/account"),
          gateway.request("/v1/devices"),
          gateway.request("/v1/models"),
          gateway.request("/v1/jobs"),
        ]);
        this.current(gateway);
        const account = workAccountSchema.parse(raw[0]),
          devices = z
            .object({ devices: z.array(workDeviceSchema).max(1000) })
            .parse(raw[1]).devices,
          models = z
            .object({ data: z.array(workModelSchema).max(1000) })
            .parse(raw[2]).data,
          jobs = z
            .object({ jobs: z.array(z.unknown()).max(1000) })
            .parse(raw[3])
            .jobs.map(parseJob);
        if (account.user.id !== gateway.connection.user.id)
          throw new Error("服务返回的账户与当前登录不匹配。");
        this.state = {
          ...this.state,
          state: "connected",
          account,
          devices,
          models,
          jobs,
          refreshedAt: now(),
          error: undefined,
        };
        this.persist(gateway);
      } catch (error) {
        if (this.gateway !== gateway || this.closed) return;
        this.state.state = "offline";
        this.state.error =
          error instanceof z.ZodError
            ? "服务返回的数据格式不兼容，未接收本次结果。"
            : error instanceof Error
              ? error.message
              : "服务暂时不可用。";
        this.persist(gateway);
      }
    })().finally(() => {
      if (this.refreshing?.promise === promise) this.refreshing = undefined;
    });
    this.refreshing = { gateway, promise };
    return promise;
  }
  execute(raw: WorkServiceCommand): Promise<void> {
    const pending = this.handle(workServiceCommandSchema.parse(raw));
    this.operations.add(pending);
    void pending
      .finally(() => this.operations.delete(pending))
      .catch(() => undefined);
    return pending;
  }
  private async handle(command: WorkServiceCommand) {
    const gateway = this.gateway;
    if (!gateway || this.closed)
      throw new Error(
        "请先登录官方或自部署能力服务，也可以继续使用自己的 API 连接。",
      );
    this.current(gateway);
    const sourceSnapshot = (taskId: string, ids: string[]) => {
      const task = this.host.store.task(taskId);
      if (task.archivedAt) throw new Error("请先恢复原工作。");
      return ids.map((id) => {
        const source = task.sources.find((item) => item.id === id);
        if (!source || source.library?.supersededAt)
          throw new Error("选定资料已改变，请重新选择。");
        return {
          id: source.id,
          title: source.title,
          text: source.text,
          hash: hash(source.text),
          coverage: source.coverage,
        };
      });
    };
    switch (command.type) {
      case "service.refresh":
        await this.refresh();
        return;
      case "service.login":
      case "service.logout":
        throw new Error("账户凭据操作必须由桌面安全入口处理。");
      case "service.model.select": {
        if (this.state.state !== "connected")
          throw new Error("请先连接服务并刷新模型列表。");
        const model = this.state.models.find(
          (item) => item.id === command.modelId,
        );
        if (!model) throw new Error("服务模型列表已变化，请刷新。");
        const id = workProfileId(gateway.connection, model.id),
          profiles = this.host.store.profiles();
        this.host.store.setConfig("profiles", [
          ...profiles.filter((profile) => profile.id !== id),
          {
            id,
            name: `${model.name} · 能力服务`,
            provider: "compatible",
            protocol: "openai",
            streamingMode: model.streamingMode,
            baseURL: `${gateway.connection.baseURL}/v1`,
            modelId: model.id,
            apiKeyEnv: "",
            hasKey: true,
            status: "untested",
          },
        ]);
        const settings = this.host.store.settings();
        this.host.store.setConfig("settings", {
          ...settings,
          defaultProfileId: id,
          memberProfiles: {
            coordinator: id,
            cto: id,
            researcher: id,
            editor: id,
          },
        });
        break;
      }
      case "service.device.revoke":
        await gateway.request(
          `/v1/devices/${encodeURIComponent(command.deviceId)}`,
          "DELETE",
        );
        break;
      case "service.clearData":
        await gateway.request("/v1/data", "DELETE", {
          confirm: command.confirm,
        });
        break;
      case "service.export": {
        const data = workExportSchema.parse(
          await gateway.request("/v1/export"),
        );
        this.current(gateway);
        if (data.account.user.id !== gateway.connection.user.id)
          throw new Error("导出结果与当前账户不匹配。");
        for (const job of data.jobs) parseJob(job);
        const directory = await ensureOwnedDirectory(
          path.join(
            this.host.store.settings().workspaceRoot,
            "service-exports",
          ),
        );
        this.current(gateway);
        const file = path.join(directory, `${uid()}.json`);
        await writeFile(file, JSON.stringify(data, null, 2), {
          flag: "wx",
          mode: 0o600,
        });
        this.current(gateway);
        this.state.exports.push({ path: file, createdAt: now() });
        this.persist(gateway);
        break;
      }
      case "service.job.create": {
        const task = this.host.store.task(command.taskId),
          sources = sourceSnapshot(task.id, command.sourceIds);
        if (!sources.some((source) => source.text.trim()))
          throw new Error("请选择至少一项有正文的资料再委托远端处理。");
        const pins = validateSkillBindings(
            task.skillPins ?? task.skillBindings,
          ),
          catalog = skillCatalog(this.host.store);
        const skills = command.skillIds.map((id) => {
          const skill = pins.find((item) => item.id === id);
          if (!skill || !catalog.some((item) => item.id === id && item.enabled))
            throw new Error("选定方法未绑定到原工作或已经停用。");
          return {
            id: skill.id,
            name: skill.name,
            version: skill.version,
            hash: skill.hash,
            instructions: skill.instructions,
          };
        });
        const input: WorkJobInput = {
          requestId: command.requestId,
          model: command.modelId,
          title: task.title,
          goal: task.goal,
          materials: sources,
          skills,
          schedule: schedule(command),
          limits: { maxRuns: command.maxRuns, maxTokens: command.maxTokens },
          origin: { taskId: task.id, version: task.goalVersion },
        };
        const { job: raw } = z
          .object({ job: z.unknown() })
          .parse(await gateway.request("/v1/jobs", "POST", input));
        this.current(gateway);
        const job = parseJob(raw);
        if (
          job.origin?.taskId !== task.id ||
          job.origin.version !== task.goalVersion ||
          job.goal !== task.goal ||
          jsonHash(job.materials) !== jsonHash(input.materials) ||
          jsonHash(job.skills) !== jsonHash(input.skills)
        )
          throw new Error(
            "服务没有确认同一版本的目标、材料或方法，未建立本地回写关联。",
          );
        this.state.submissions ??= {};
        this.state.submissions[job.id] = {
          taskId: task.id,
          goalVersion: task.goalVersion,
          sourceHashes: Object.fromEntries(
            sources.map((item) => [item.id, item.hash]),
          ),
          skillHashes: Object.fromEntries(
            skills.map((item) => [item.id, item.hash]),
          ),
        };
        this.persist(gateway);
        break;
      }
      case "service.job.update": {
        const input: WorkJobUpdate = {
          requestId: command.requestId,
          expectedVersion: command.expectedVersion,
          action: command.action,
        };
        if (command.taskId) {
          if (!command.sourceIds) throw new Error("更新材料需明确选择范围。");
          input.materials = sourceSnapshot(command.taskId, command.sourceIds);
        } else if (command.sourceIds)
          throw new Error("更新资料必须指定其所属的本机工作。");
        if (command.maxRuns !== undefined || command.maxTokens !== undefined) {
          const job = this.state.jobs.find((job) => job.id === command.jobId);
          if (!job) throw new Error("请刷新委托后调整上限。");
          input.limits = {
            maxRuns: command.maxRuns ?? job.limits.maxRuns,
            maxTokens: command.maxTokens ?? job.limits.maxTokens,
          };
        }
        const { job: raw } = z
          .object({ job: z.unknown() })
          .parse(
            await gateway.request(
              `/v1/jobs/${encodeURIComponent(command.jobId)}`,
              "PATCH",
              input,
            ),
          );
        this.current(gateway);
        const job = parseJob(raw);
        if (
          job.id !== command.jobId ||
          (input.materials &&
            jsonHash(job.materials) !== jsonHash(input.materials))
        )
          throw new Error("服务返回的委托版本或资料范围不匹配。");
        if (
          command.taskId &&
          this.state.submissions?.[job.id]?.taskId === command.taskId
        ) {
          this.state.submissions[job.id] = {
            ...this.state.submissions[job.id]!,
            goalVersion: this.host.store.task(command.taskId).goalVersion,
            sourceHashes: Object.fromEntries(
              input.materials!.map((item) => [item.id, item.hash!]),
            ),
          };
          this.persist(gateway);
        }
        break;
      }
      case "service.job.node":
        await gateway.request(
          `/v1/jobs/${encodeURIComponent(command.jobId)}`,
          "PATCH",
          {
            requestId: command.requestId,
            expectedVersion: command.expectedVersion,
            node: {
              occurredAt: command.occurredAt,
              evidence: command.evidence,
              actual: true,
            },
          },
        );
        break;
      case "service.job.cancel":
        await gateway.request(
          `/v1/jobs/${encodeURIComponent(command.jobId)}/cancel`,
          "POST",
          { requestId: command.requestId },
        );
        break;
      case "service.job.collect": {
        const key = `${this.key(gateway)}:${command.jobId}`;
        let pending = this.collections.get(key);
        if (!pending) {
          pending = this.collect(gateway, command.jobId);
          this.collections.set(key, pending);
        }
        try {
          await pending;
        } finally {
          if (this.collections.get(key) === pending)
            this.collections.delete(key);
        }
        break;
      }
    }
    this.current(gateway);
    await this.refresh();
  }
  private async collect(gateway: WorkGateway, jobId: string) {
    const { job: raw } = z
      .object({ job: z.unknown() })
      .parse(await gateway.request(`/v1/jobs/${encodeURIComponent(jobId)}`));
    this.current(gateway);
    const job = parseJob(raw);
    if (job.id !== jobId) throw new Error("返回结果不属于所选委托。");
    const run = job.runs.findLast(
      (item) => item.state === "completed" && item.result,
    );
    if (!run?.result) throw new Error("还没有已完成的远端成果。");
    const previous = this.state.collected[jobId];
    if (previous?.runId === run.id) {
      this.host.store.task(previous.taskId);
      return;
    }
    const submission = this.state.submissions?.[jobId];
    // Only a locally recorded submission grants permission to return to its original task.
    let task = previous
      ? this.host.store.task(previous.taskId)
      : submission
        ? this.host.store.task(submission.taskId)
        : undefined;
    if (submission && task?.goalVersion !== submission.goalVersion)
      throw new Error(
        "原工作的目标版本已改变；先核对远端结果与当前目标，不能直接覆盖。",
      );
    if (previous && !previous.artifactHash)
      throw new Error(
        "旧的取回记录缺少版本哈希，不能安全覆盖本机成果；已有文件已保留。",
      );
    if (task && this.host.isRunning(task.id))
      throw new Error("原工作正在执行，请结束后再取回成果。");
    if (!task) {
      task = await this.host.createWork({
        requestId: `remote:${hash(gateway.connection.baseURL + gateway.connection.user.id)}:${job.id}`,
        isolatedContext: true,
        title: `远端成果 · ${job.title}`,
        goal: job.goal,
        skillPolicy: { mode: "off", skillIds: [] },
        sources: job.materials.map((item) => ({
          id: item.id,
          title: item.title,
          text: item.text,
          type: "text",
          location: `remote-work:${job.id}:${item.id}`,
          addedAt: now(),
          coverage: item.coverage ?? "明确提交到远端的文本快照",
        })),
      });
      this.current(gateway);
    }
    const artifact = await writeArtifact(this.host.store, task.id, {
      artifactId: previous?.artifactId,
      expectedHash: previous?.artifactHash,
      title: job.title,
      format: "md",
      content: run.result,
      goalVersion: task.goalVersion,
      operationId: `remote-result:${hash(this.key(gateway))}:${job.id}:${run.id}`,
    });
    this.current(gateway);
    this.host.store.updateTask(task.id, (current) => {
      current.status = "completed";
      current.events.push({
        id: uid(),
        createdAt: now(),
        type: "remote.result_received",
        goalVersion: current.goalVersion,
        summary: "已取回远端真实成果。",
        data: {
          jobId: job.id,
          runId: run.id,
          version: run.version,
          artifactId: artifact.id,
          tokens: run.tokens,
          usageKnown: run.tokens !== undefined,
        },
      });
    });
    this.state.collected[job.id] = {
      taskId: task.id,
      artifactId: artifact.id,
      runId: run.id,
      artifactHash: artifact.hash,
    };
    this.persist(gateway);
  }
}
