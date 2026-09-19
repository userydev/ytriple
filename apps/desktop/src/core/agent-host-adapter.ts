import { Decisions } from "./decisions";
import { formatAuthorizedMaterials } from "./authorized-materials";
import { buildTaskInputManifest } from "./input-manifest";
import { memberCanReadMaterials } from "./agent-prompt";
import { attachPublicProcessToContribution } from "./team-response";
import { LocalTools } from "./tools";
import type { AgentHost, ModelStreamResult } from "./agent-host";
import type { AgentKernel, ExecutionStrategyId } from "./agent-kernel-contract";
import type { Store } from "./store";
import type {
  Contribution,
  DecisionRequest,
  Member,
  Reference,
  Run,
} from "./types";
import type { ToolRequest } from "./tool-contract";
import {
  isUncertainExecution,
  ServiceError,
  type Model,
  type Prompt,
} from "./ycore";
import type { WorkspaceActions } from "./workspace-actions";

export class AgentHostAdapter implements AgentHost {
  constructor(
    private readonly store: Store,
    private readonly model: Model,
    readonly run: Run,
    readonly signal: AbortSignal,
    readonly kernel: AgentKernel,
    readonly strategyId: ExecutionStrategyId,
    readonly isSubtask: boolean,
    private readonly workspaceActions?: WorkspaceActions,
    private readonly changed: (contribution: Contribution) => void = () => {},
  ) {}

  onContribution(contribution: Contribution) {
    this.changed(contribution);
  }

  formatMaterials(refs: Reference[], canRead: boolean) {
    return formatAuthorizedMaterials(
      refs,
      (reference) => this.store.material(reference),
      { previewLimit: 1600, canReadMore: canRead, numbered: true },
    );
  }

  loadContribution(id: string) {
    return this.store.get<Contribution>("contribution", id);
  }

  saveContribution(contribution: Contribution) {
    this.store.put("contribution", contribution.id, contribution);
    this.onContribution(contribution);
  }

  async streamModel(
    contribution: Contribution,
    prompt: Prompt,
    remoteKey: string,
    protocol: string,
  ): Promise<ModelStreamResult> {
    const refs = contribution.task?.refs ?? this.run.refs;
    const manifest = buildTaskInputManifest(
      this.store,
      this.run,
      contribution.id,
      refs,
      {
        decisionTaskPrefix: contribution.task?.key
          ? `${contribution.task.key}:t`
          : undefined,
        subtask: this.isSubtask || (contribution.task?.depth ?? 0) > 0,
        canReadMore: memberCanReadMaterials(this.run, this.run.team.members.find(m => m.id === contribution.memberId)!),
      },
    );
    // Supply the same source IDs to the model; IDs alone do not grant additional content.
    prompt = { ...prompt, messages: prompt.messages.map(m => m.role !== "user" ? m : {
      ...m, content: m.content + "\n\n宿主记录的本次输入来源（覆盖有边界，不证明采用或效果）：\n" +
        manifest.entries.filter(e => e.coverage !== "omitted").map(e => `${e.id} · ${e.coverage} · ${e.label.slice(0, 120)}`).join("\n"),
    }) };
    if (prompt.messages.some((m) => m.content.length > 32000) ||
        prompt.messages.reduce((n, m) => n + Buffer.byteLength(m.content), 0) > 64000)
      throw new Error("本轮材料超出服务输入范围，请减少引用范围后重新提交");
    this.store.put("input-manifest", manifest.id, manifest);
    const withManifest = { ...contribution, inputManifestId: manifest.id };
    this.saveContribution(withManifest);
    this.store.put("model-input", contribution.id, {
      protocol,
      runId: this.run.id,
      contributionId: contribution.id,
      remoteKey,
      prompt,
      manifestId: manifest.id,
      capturedAt: new Date().toISOString(),
    });
    let completed = false;
    let c: Contribution = withManifest;
    for await (const event of this.model.stream(prompt, remoteKey, this.signal)) {
      c = { ...c, remoteId: event.run_id };
      if (event.type === "text.delta") c = { ...c, body: c.body + (event.text ?? "") };
      if (event.type === "run.failed") {
        const uncertain = isUncertainExecution(event.error?.code);
        c = {
          ...c,
          status: uncertain ? "unknown" : "failed",
          error: event.error?.message ?? "子任务失败",
        };
        this.saveContribution(c);
        if (
          (this.isSubtask || (c.task?.depth ?? 0) > 0) &&
          !uncertain
        )
          return { contribution: c, completed: false };
        throw new ServiceError(
          event.error?.code ?? "MODEL_FAILED",
          event.error?.message ?? "子任务失败",
          event.run_id,
        );
      }
      if (event.type === "run.completed") completed = true;
      this.saveContribution(c);
    }
    if (this.signal.aborted) throw new DOMException("已停止", "AbortError");
    if (!completed)
      throw new ServiceError("STREAM_INTERRUPTED", "调用未收到成功终态");
    if (!c.body.trim()) throw new Error("成员未返回可用内容");
    c = { ...c, status: "succeeded" };
    this.saveContribution(c);
    attachPublicProcessToContribution(this.store, this.run, c.id);
    c = this.store.require<Contribution>("contribution", c.id);
    return { contribution: c, completed: true };
  }

  executeTool(
    contributionId: string,
    member: Member,
    refs: Reference[],
    request: ToolRequest,
  ) {
    return new LocalTools(this.store, this.workspaceActions).execute(
      this.run,
      member,
      contributionId,
      refs,
      request,
      this.signal,
    );
  }

  pauseForDecision(
    contribution: Contribution,
    stage: number,
    attempt: number,
    question: DecisionRequest,
    taskKey?: string,
  ) {
    new Decisions(this.store).pause(
      this.run.id,
      contribution,
      stage,
      attempt,
      question,
      taskKey,
    );
    this.onContribution(this.store.require("contribution", contribution.id));
  }

  answeredDecisions(taskKeyPrefix?: string) {
    const all = this.store
      .all<import("./types").Decision>("decision")
      .filter((d) => d.runId === this.run.id && d.status === "answered");
    if (!taskKeyPrefix) return all;
    return all.filter((d) => d.taskKey?.startsWith(taskKeyPrefix));
  }

  delegationCount() {
    return this.store
      .all<Contribution>("contribution")
      .filter((x) => x.runId === this.run.id && x.delegation).length;
  }

  delegationPolicy() {
    return this.run.workflow.delegation ?? { maxTasks: 0, maxDepth: 0 };
  }
}
