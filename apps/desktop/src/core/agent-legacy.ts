import { isDelegationId, DelegationRunner } from "./delegation";
import { parseToolRequest } from "./tool-contract";
import { teamCapabilityBrief } from "./team-capability";
import { Decisions, decisionInstruction, parseDecision } from "./decisions";
import { outputInstruction } from "./output";
import { teamResponseInstruction } from "./team-response";
import type { Store } from "./store";
import type { Contribution, Run } from "./types";
import { ServiceError, type Model, type Prompt } from "./ycore";
import type { WorkspaceActions } from "./workspace-actions";

export type LegacyRunOutcome = {
  final: string;
  result: boolean;
  waiting: boolean;
};

/** Runs without frozen execution manifest keep the pre-kernel dual paths. */
export async function executeLegacyRun(input: {
  store: Store;
  model: Model;
  run: Run;
  context: string;
  signal: AbortSignal;
  workspaceActions?: WorkspaceActions;
  onContribution: (c: Contribution) => void;
}): Promise<LegacyRunOutcome> {
  const { store, model, run, context, signal, workspaceActions, onContribution } =
    input;
  if (
    run.workflow.delegation ||
    run.skills?.length ||
    run.tools?.keys.length
  ) {
    const execution = await new DelegationRunner(
      store,
      model,
      run,
      signal,
      onContribution,
      workspaceActions,
    ).execute(context);
    return execution;
  }
  return executePlainStageRun({
    store,
    model,
    run,
    context,
    signal,
    onContribution,
  });
}

export async function executePlainStageRun(input: {
  store: Store;
  model: Model;
  run: Run;
  context: string;
  signal: AbortSignal;
  onContribution: (c: Contribution) => void;
}): Promise<LegacyRunOutcome> {
  const { store, model, run, context, signal, onContribution } = input;
  const stages = run.recipient
    ? [
        {
          role: run.recipient,
          objective: "回应用户指定的问题",
          result: false,
        },
      ]
    : run.workflow.stages;
  let contributions = "";
  let final = "";
  let producesResult = false;
  for (const [index, stage] of stages.entries()) {
    if (signal.aborted) throw new DOMException("已停止", "AbortError");
    const member = run.team.members.find((m) => m.id === stage.role)!;
    const decisions = store
      .all<import("./types").Decision>("decision")
      .filter((d) => d.runId === run.id);
    const answers = decisions.filter((d) => d.status === "answered");
    const attempt = answers.filter((d) => d.stage === index).length;
    if (attempt > 8)
      throw new Error(
        "同一步已多次等待答复，请调整目标后重新开始，已有回答与过程保留",
      );
    const contributionId = `${run.id}:${index}${attempt ? `:${attempt}` : ""}`;
    const remoteKey = `${run.id}-${index}${attempt ? `-answer-${attempt}` : ""}`;
    const saved = store.get<Contribution>("contribution", contributionId);
    if (saved?.status === "succeeded") {
      if (parseToolRequest(saved.body))
        throw new Error("此历史流程未启用工具，未执行请求");
      const question = parseDecision(saved.body);
      if (question) {
        new Decisions(store).pause(run.id, saved, index, attempt, question);
        return { final: "", result: false, waiting: true };
      }
      contributions += `\n${member.name}：\n${saved.body}\n`;
      final = saved.body;
      producesResult = stage.result;
      continue;
    }
    let contribution: Contribution = {
      id: contributionId,
      remoteKey,
      runId: run.id,
      workId: run.workId,
      memberId: member.id,
      memberName: member.name,
      objective: stage.objective,
      body: "",
      status: "running",
      remoteId: null,
      error: null,
      createdAt: new Date().toISOString(),
    };
    store.put("contribution", contribution.id, contribution);
    onContribution(contribution);
    const responseHint = teamResponseInstruction(run, {
      finalStage: index === stages.length - 1,
      allowsArtifact: stage.result && run.outputMode !== "explanation",
    });
    const prompt: Prompt = {
      taskId: contribution.id,
      refs: [],
      messages: [
        {
          role: "system",
          content: [
            teamCapabilityBrief(),
            `你在 ytriple 团队中担任${member.name}。${member.instruction}`,
            decisionInstruction,
            outputInstruction(run.outputMode),
            responseHint,
            "本成员本轮未启用工具，不得请求或声称执行工具。",
          ].join("\n\n"),
        },
        {
          role: "user",
          content: `当前目标：${run.text}\n\n${context}\n\n本轮已有成员贡献（审阅其依据，不盲从）：\n${contributions || "尚无"}\n\n用户对原待决的已提交答复（只在所述范围内生效）：\n${answers.map((d) => `问题：${d.question}\n影响：${d.impact}\n答复：${d.answer}`).join("\n\n") || "无"}\n\n本步：${stage.objective}`,
        },
      ],
    };
    let completed = false;
    if (prompt.messages.some((m) => m.content.length > 32000) ||
        prompt.messages.reduce((n, m) => n + Buffer.byteLength(m.content), 0) > 64000)
      throw new Error("本轮材料超出服务输入范围，请减少引用范围后重新提交");
    for await (const event of model.stream(prompt, remoteKey, signal)) {
      contribution = {
        ...contribution,
        remoteId: event.run_id,
        body:
          contribution.body +
          (event.type === "text.delta" ? (event.text ?? "") : ""),
      };
      if (event.type === "run.failed")
        throw new ServiceError(
          event.error?.code ?? "MODEL_FAILED",
          event.error?.message ?? "模型运行失败",
          event.run_id,
        );
      if (event.type === "run.completed") completed = true;
      store.put("contribution", contribution.id, contribution);
      onContribution(contribution);
    }
    if (signal.aborted) throw new DOMException("已停止", "AbortError");
    if (completed && parseToolRequest(contribution.body))
      throw new Error("此流程未启用工具，未执行请求");
    if (!completed)
      throw new ServiceError("STREAM_INTERRUPTED", "未收到成功终态");
    if (!contribution.body.trim()) throw new Error("模型未返回可用内容");
    const question = parseDecision(contribution.body);
    if (question) {
      new Decisions(store).pause(
        run.id,
        contribution,
        index,
        attempt,
        question,
      );
      return { final: "", result: false, waiting: true };
    }
    contribution = { ...contribution, status: "succeeded" };
    store.put("contribution", contribution.id, contribution);
    contributions += `\n${member.name}：\n${contribution.body}\n`;
    final = contribution.body;
    producesResult = stage.result;
  }
  return { final, result: producesResult, waiting: false };
}

export function legacyContributionStage(runId: string, contributionId: string) {
  if (!contributionId.startsWith(runId + ":")) return null;
  const stage = contributionId.slice(runId.length + 1);
  if (/^\d+(?::\d+)?$/.test(stage)) return stage;
  if (isDelegationId(runId, contributionId)) return "delegation";
  return null;
}
