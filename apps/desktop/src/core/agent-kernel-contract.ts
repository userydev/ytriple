import { buildMemberSystemPrompt, buildMemberUserPrompt } from "./agent-prompt";
import type {
  Workflow,
  FrozenExecution,
  ExecutionStrategyId,
  Run,
  Member,
} from "./types";
import type { SkillUse } from "./skill-contract";
import { TEAM_RESPONSE_PROTOCOL } from "./team-response";

export const AGENT_KERNEL_ID = "ytriple.agent-kernel";
export type { FrozenExecution, ExecutionStrategyId };
export type KernelReference = Pick<FrozenExecution, "kernelId" | "kernelVersion">;
export const DEFAULT_KERNEL: Readonly<KernelReference> = Object.freeze({
  kernelId: AGENT_KERNEL_ID, kernelVersion: 1,
});

export type LoopTurnDecision = "continue" | "terminate";

export type AgentLoopPolicy = {
  afterToolFormatError(alreadyCorrected: boolean): LoopTurnDecision;
  afterToolFailure(): LoopTurnDecision;
};

export type AgentKernel = {
  readonly id: string;
  readonly version: number;
  readonly loopPolicy: AgentLoopPolicy;
  buildUserPrompt: typeof buildMemberUserPrompt;
  planStages(run: Run): {
    role: string;
    objective: string;
    result: boolean;
  }[];
  allowsDelegation(strategyId: ExecutionStrategyId, run: Run): boolean;
  buildSystemPrompt(input: {
    run: Run;
    member: Member;
    depth: number;
    uses: SkillUse[];
    strategyId: ExecutionStrategyId;
  }): string;
};

const registry = new Map<string, AgentKernel>();

function registryKey(id: string, version: number) {
  return `${id}@${version}`;
}

export function registerAgentKernel(kernel: AgentKernel) {
  const key = registryKey(kernel.id, kernel.version);
  if (registry.has(key))
    throw new Error(`执行内核 ${key} 已注册，不能静默覆写`);
  // Copy before freezing: later edits to a caller's object must not change a
  // version already pinned by queued or paused runs.
  registry.set(key, Object.freeze({
    ...kernel,
    loopPolicy: Object.freeze({ ...kernel.loopPolicy }),
  }));
}

export function resolveAgentKernel(manifest: FrozenExecution): AgentKernel {
  if (!["fixed-stages", "adaptive-delegation"].includes(manifest.strategyId))
    throw new Error("执行策略不可用，不能降级执行");
  const kernel = registry.get(
    registryKey(manifest.kernelId, manifest.kernelVersion),
  );
  if (!kernel)
    throw new Error(
      `执行内核 ${manifest.kernelId} v${manifest.kernelVersion} 不可用；不能降级执行`,
    );
  return kernel;
}

export function inferExecutionStrategy(workflow: Workflow): ExecutionStrategyId {
  if (workflow.executionStrategy) return workflow.executionStrategy;
  return workflow.delegation ? "adaptive-delegation" : "fixed-stages";
}

export function freezeExecutionManifest(
  workflow: Workflow,
  reference: KernelReference = DEFAULT_KERNEL,
): FrozenExecution {
  const manifest = {
    ...reference,
    strategyId: inferExecutionStrategy(workflow),
  };
  resolveAgentKernel(manifest);
  return manifest;
}

export function assertExecutionCompatible(
  manifest: FrozenExecution,
  checkpoint: FrozenExecution | null | undefined,
) {
  if (!checkpoint) throw new Error("缺少执行版本检查点，不能恢复推理");
  if (
    checkpoint.kernelId !== manifest.kernelId ||
    checkpoint.kernelVersion !== manifest.kernelVersion ||
    checkpoint.strategyId !== manifest.strategyId
  )
    throw new Error("检查点执行清单与当前运行不兼容，不能恢复推理");
}

export function assertRunExecutionReady(run: Run) {
  if (!run.execution) return;
  assertExecutionCompatible(run.execution, run.executionCheckpoint);
  resolveAgentKernel(run.execution);
  if (
    run.responseProtocol &&
    run.responseProtocol !== TEAM_RESPONSE_PROTOCOL
  )
    throw new Error("运行输出协议与当前内核不兼容，不能继续推理");
}

function createLoopPolicyV1(): AgentLoopPolicy {
  return {
    afterToolFormatError(alreadyCorrected) {
      return alreadyCorrected ? "terminate" : "continue";
    },
    afterToolFailure() {
      return "continue";
    },
  };
}

function createLoopPolicyV2(): AgentLoopPolicy {
  return {
    afterToolFormatError() {
      return "terminate";
    },
    afterToolFailure() {
      return "terminate";
    },
  };
}

function createKernel(
  version: number,
  loopPolicy: AgentLoopPolicy,
): AgentKernel {
  return {
    id: AGENT_KERNEL_ID,
    version,
    loopPolicy,
    buildUserPrompt: buildMemberUserPrompt,
    planStages(run) {
      if (run.recipient)
        return [
          { role: run.recipient, objective: run.text, result: false },
        ];
      return run.workflow.stages;
    },
    allowsDelegation(strategyId, run) {
      return strategyId === "adaptive-delegation" && !!run.workflow.delegation;
    },
    buildSystemPrompt({ run, member, depth, uses, strategyId }) {
      const policy = run.workflow.delegation ?? { maxTasks: 0, maxDepth: 0 };
      return buildMemberSystemPrompt({
        run,
        member,
        depth,
        uses,
        allowsDelegation: strategyId === "adaptive-delegation" && !!run.workflow.delegation,
        delegationPolicy: policy,
      });
    },
  };
}

export const AGENT_KERNEL_V1 = createKernel(1, createLoopPolicyV1());

export function createAgentKernelV2(): AgentKernel {
  return createKernel(2, createLoopPolicyV2());
}

registerAgentKernel(AGENT_KERNEL_V1);
