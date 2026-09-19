import type { Store } from "./store";
import type { OutcomeRecord } from "./outcome-contract";
import type { Material, Snapshot } from "./types";
export type ProcessStaleInfo = { status: "current" | "uncovered" | "superseded"; detail: string };
type Source = NonNullable<Material["processSource"]>;
type EvidenceData = Pick<Snapshot, "outcomes" | "messages" | "runs" | "contributions" | "decisions">;
const collections = { outcome: "outcomes", message: "messages", run: "runs", contribution: "contributions", decision: "decisions" } as const;
function recordState(kind: string, value: any) {
  if (!value) return "missing";
  if (kind === "run") return JSON.stringify([value.text, value.status, value.error]);
  if (kind === "message") return JSON.stringify([value.body, value.refs]);
  return JSON.stringify(value);
}
export function processScopeDigest(source: Source) { return JSON.stringify([source.runIds, source.contributionIds, source.versionIds, source.outcomeState, source.capturedAt]); }
export function buildProcessScopeFields(store: Store, source: Source) {
  const state: NonNullable<Source["evidenceState"]> = [];
  const ids = { run: source.runIds, contribution: source.contributionIds, outcome: source.outcomeIds ?? [], message: source.sources?.filter(s => s.kind === "message").map(s => s.entityId) ?? [], decision: source.sources?.filter(s => s.kind === "decision").map(s => s.entityId) ?? [] };
  for (const [kind, keys] of Object.entries(ids))
    for (const id of keys) state.push({ kind, id, value: recordState(kind, store.get(kind, id)) });
  return { ...source, evidenceState: state, scopeDigest: processScopeDigest(source), cutoffWorkSeq: Math.max(0, ...store.all<any>("run").filter(r => r.workId === source.workId).map(r => r.workSeq ?? 0)) };
}
export function processSnapshotStaleData(material: Material, data: EvidenceData): ProcessStaleInfo {
  const source = material.processSource;
  if (!source?.evidenceState) return { status: "current", detail: "历史快照未记录依据变化校验，状态未知" };
  for (const saved of source.evidenceState) {
    const key = collections[saved.kind as keyof typeof collections];
    if (key && recordState(saved.kind, data[key].find(r => r.id === saved.id)) !== saved.value)
      return { status: "superseded", detail: "所选原始依据已修改、撤回或移除，需要复核；旧报告保留" };
  }
  const newOutcome = data.outcomes.some(o => o.workId === source.workId && source.versionIds.includes(o.versionId) && !source.outcomeIds?.includes(o.id));
  const within = (runId: string) => source.scopeKind === "work" || (source.scopeKind !== "selection" && source.runIds.includes(runId));
  // The report and follow-up analysis of this snapshot are not new source evidence.
  const isReport = (runId: string) => data.runs.find(r => r.id === runId)?.refs.some(r => r.materialId === material.id);
  const after = (at: string, runId: string) => at > source.capturedAt && within(runId) && !isReport(runId);
  const newInput = data.messages.some(m => m.workId === source.workId && m.role === "user" && after(m.createdAt, m.runId));
  const newRecords = data.contributions.some(c => c.workId === source.workId && !source.contributionIds.includes(c.id) && after(c.createdAt, c.runId));
  const newDecisions = data.decisions.some(d => d.workId === source.workId && after(d.answeredAt ?? d.createdAt, d.runId) && !source.evidenceState!.some(s => s.kind === "decision" && s.id === d.id));
  return newOutcome || newInput || newRecords || newDecisions
    ? { status: "uncovered", detail: "已有新增反馈或过程，本报告未涵盖；原依据未改变" }
    : { status: "current", detail: "" };
}
export function processSnapshotStale(store: Store, material: Material, outcomes: OutcomeRecord[]) { return processSnapshotStaleData(material, { ...store.snapshot(), outcomes }); }
