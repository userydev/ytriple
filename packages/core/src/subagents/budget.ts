import type { SubAgentAbortReason, SubAgentBudget, TokenUsage } from "@ytriple/shared";
import { totalTokens } from "@ytriple/shared";

export interface BudgetRejection {
  reason: SubAgentAbortReason;
  detail: string;
}

export class SubAgentBudgetError extends Error {
  readonly reason: SubAgentAbortReason;

  constructor(rejection: BudgetRejection) {
    super(rejection.detail);
    this.name = "SubAgentBudgetError";
    this.reason = rejection.reason;
  }
}

export interface ChildBudget {
  readonly limitTokens: number;
  readonly usedTokens: number;
  /** Throws SubAgentBudgetError when the child or the shared pool is exhausted. */
  charge(usage: TokenUsage): void;
}

/**
 * One shared pool per parent agent, covering all of its sub-agents for the
 * whole task. Exhaustion is an explicit failure: `spawn_subagent` refuses, and
 * a child that overruns its own slice is aborted with its partial result marked
 * incomplete. Nothing continues silently.
 */
export interface SubAgentLedger {
  readonly budget: SubAgentBudget;
  readonly usedTokens: number;
  readonly remainingTokens: number;
  readonly spawnCount: number;
  /** Milliseconds left before the wall-clock budget is spent. */
  readonly remainingWallClockMs: number;
  check(requestedTokens: number): BudgetRejection | undefined;
  openChild(subAgentId: string, requestedTokens: number): ChildBudget;
}

export function createSubAgentLedger(
  budget: SubAgentBudget,
  now: () => number,
): SubAgentLedger {
  const startedAt = now();
  let usedTokens = 0;
  let spawnCount = 0;

  const ledger: SubAgentLedger = {
    budget,
    get usedTokens() {
      return usedTokens;
    },
    get remainingTokens() {
      return Math.max(0, budget.maxTokens - usedTokens);
    },
    get spawnCount() {
      return spawnCount;
    },
    get remainingWallClockMs() {
      return Math.max(0, budget.maxWallClockMs - (now() - startedAt));
    },
    check(requestedTokens) {
      if (spawnCount >= budget.maxSpawns) {
        return {
          reason: "spawn_limit_reached",
          detail: `already spawned ${spawnCount} sub-agent(s); the budget allows ${budget.maxSpawns}`,
        };
      }
      const elapsed = now() - startedAt;
      if (elapsed > budget.maxWallClockMs) {
        return {
          reason: "wall_clock_exceeded",
          detail: `sub-agent wall clock budget of ${budget.maxWallClockMs}ms is spent (${elapsed}ms elapsed)`,
        };
      }
      if (requestedTokens > ledger.remainingTokens) {
        return {
          reason: "token_budget_exhausted",
          detail: `requested ${requestedTokens} tokens but only ${ledger.remainingTokens} of ${budget.maxTokens} remain in the shared pool`,
        };
      }
      return undefined;
    },
    openChild(subAgentId, requestedTokens) {
      spawnCount += 1;
      let childUsed = 0;

      return {
        limitTokens: requestedTokens,
        get usedTokens() {
          return childUsed;
        },
        charge(usage) {
          const spent = totalTokens(usage);
          childUsed += spent;
          usedTokens += spent;

          if (childUsed > requestedTokens) {
            throw new SubAgentBudgetError({
              reason: "token_budget_exhausted",
              detail: `${subAgentId} used ${childUsed} tokens, over its ${requestedTokens} token limit`,
            });
          }
          if (usedTokens > budget.maxTokens) {
            throw new SubAgentBudgetError({
              reason: "token_budget_exhausted",
              detail: `the shared sub-agent pool of ${budget.maxTokens} tokens is exhausted`,
            });
          }
          if (now() - startedAt > budget.maxWallClockMs) {
            throw new SubAgentBudgetError({
              reason: "wall_clock_exceeded",
              detail: `${subAgentId} passed the ${budget.maxWallClockMs}ms sub-agent wall clock budget`,
            });
          }
        },
      };
    },
  };

  return ledger;
}
