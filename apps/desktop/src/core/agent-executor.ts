import { AgentHostAdapter } from "./agent-host-adapter";
import { AwaitingDecision, runMemberTask } from "./agent-loop";
import {
  assertRunExecutionReady,
  resolveAgentKernel,
} from "./agent-kernel-contract";
import { executeLegacyRun } from "./agent-legacy";
import type { Store } from "./store";
import type { Contribution, Run } from "./types";
import type { Model } from "./ycore";
import type { WorkspaceActions } from "./workspace-actions";

export type RunExecutionOutcome = {
  final: string;
  result: boolean;
  waiting: boolean;
};

export async function executeAgentRun(input: {
  store: Store;
  model: Model;
  run: Run;
  context: string;
  signal: AbortSignal;
  workspaceActions?: WorkspaceActions;
  onContribution: (c: Contribution) => void;
}): Promise<RunExecutionOutcome> {
  const manifest = input.run.execution;
  if (!manifest) {
    return executeLegacyRun({
      store: input.store,
      model: input.model,
      run: input.run,
      context: input.context,
      signal: input.signal,
      workspaceActions: input.workspaceActions,
      onContribution: input.onContribution,
    });
  }
  assertRunExecutionReady(input.run);
  const kernel = resolveAgentKernel(manifest);
  const host = new AgentHostAdapter(
    input.store,
    input.model,
    input.run,
    input.signal,
    kernel,
    manifest.strategyId,
    false,
    input.workspaceActions,
    input.onContribution,
  );
  const stages = kernel.planStages(input.run);
  if (!stages.length || stages.length > 16 || stages.some((s, i) =>
    !input.run.team.members.some((m) => m.id === s.role) ||
    !s.objective.trim() || s.objective.length > 8000 ||
    (s.result && (i !== stages.length - 1 || !!input.run.recipient ||
      !input.run.workflow.stages.some((original) => original.result)))))
    throw new Error("执行策略返回了不符合本轮授权的步骤");
  let final = "";
  let result = false;
  const replies: string[] = [];
  try {
    for (const [index, stage] of stages.entries()) {
      const member = input.run.team.members.find((m) => m.id === stage.role)!;
      const c = await runMemberTask(host, {
        key: `${input.run.id}:${index}`,
        member,
        objective: stage.objective,
        context: `用户目标：${input.run.text}\n\n${input.context}\n\n之前步骤的公开结论：\n${replies.join("\n\n") || "无"}`,
        refs: input.run.refs,
        depth: 0,
        stage: index,
        finalStage: index === stages.length - 1,
        allowsArtifact: stage.result && !input.run.recipient,
      });
      replies.push(`${member.name}（${c.id}）：${c.body}`);
      final = c.body;
      result = stage.result;
    }
    return { final, result, waiting: false };
  } catch (e) {
    if (e instanceof AwaitingDecision)
      return { final: "", result: false, waiting: true };
    throw e;
  }
}
