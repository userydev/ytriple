import type { Contribution, Decision, Member, Reference, Run } from "./types";
import type { ToolReceipt, ToolRequest } from "./tool-contract";
import type { DecisionRequest } from "./types";
import type { AgentKernel } from "./agent-kernel-contract";
import type { ExecutionStrategyId } from "./types";
import type { Prompt } from "./ycore";

export type ModelStreamResult = {
  contribution: Contribution;
  completed: boolean;
};

export interface AgentHost {
  readonly run: Run;
  readonly signal: AbortSignal;
  readonly kernel: AgentKernel;
  readonly strategyId: ExecutionStrategyId;
  readonly isSubtask: boolean;
  onContribution(contribution: Contribution): void;
  formatMaterials(refs: Reference[], canRead: boolean): string;
  loadContribution(id: string): Contribution | undefined;
  saveContribution(contribution: Contribution): void;
  streamModel(
    contribution: Contribution,
    prompt: Prompt,
    remoteKey: string,
    protocol: string,
  ): Promise<ModelStreamResult>;
  executeTool(
    contributionId: string,
    member: Member,
    refs: Reference[],
    request: ToolRequest,
  ): ToolReceipt;
  pauseForDecision(
    contribution: Contribution,
    stage: number,
    attempt: number,
    question: DecisionRequest,
    taskKey?: string,
  ): void;
  answeredDecisions(taskKeyPrefix?: string): Decision[];
  delegationCount(): number;
  delegationPolicy(): { maxTasks: number; maxDepth: number };
}
