import type { Draft, RunSnapshot, SubmitRequest } from '../../shared/contracts';

export interface PendingSubmission {
  schema: 1;
  request: SubmitRequest;
  beforeRunIds: string[];
  startedAt: string;
  draft: Draft;
  clearDraftOnAcceptance: boolean;
}
export function sameDraft(a: Draft, b: Draft): boolean {
  return a.text === b.text && a.intent === b.intent && a.targetMemberId === b.targetMemberId
    && sameReference(a.reference, b.reference);
}
function sameReference(a: Draft['reference'], b: Draft['reference']): boolean {
  return a?.kind === b?.kind && a?.id === b?.id && a?.version === b?.version && a?.quote === b?.quote;
}
export function matchingSubmissions(pending: PendingSubmission, runs: RunSnapshot[]): RunSnapshot[] {
  const before = new Set(pending.beforeRunIds);
  return runs.filter(run => !before.has(run.id) && run.workId === pending.request.workId
    && run.prompt === pending.request.prompt && run.intent === pending.request.intent
    && run.targetMemberId === pending.request.targetMemberId && sameReference(run.reference, pending.request.reference));
}

// Do not switch the IPC service while an accepted submission is still saving its
// acknowledgement or clearing the original service's draft.
const activeOperations = new Set<Promise<unknown>>();
export async function trackSubmission<T>(operation: () => Promise<T>): Promise<T> {
  const pending = Promise.resolve().then(operation);
  activeOperations.add(pending);
  try { return await pending; } finally { activeOperations.delete(pending); }
}
export async function settleSubmissions(): Promise<void> {
  while (activeOperations.size) await Promise.allSettled([...activeOperations]);
}
