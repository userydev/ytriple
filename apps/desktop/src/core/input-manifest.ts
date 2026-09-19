import { partialCoverage } from "./authorized-materials";
import type { Store } from "./store";
import type { Contribution, Decision, Reference, Run } from "./types";

export type ManifestCoverage = "full" | "excerpt" | "summary" | "truncated" | "omitted";
export type InputManifestEntry = {
  id: string;
  kind: "message" | "decision" | "outcome" | "material";
  label: string;
  coverage: ManifestCoverage;
  entityId: string;
};
export type InputManifest = {
  id: string; runId: string; contributionId: string; workId: string;
  capturedAt: string; entries: InputManifestEntry[];
};
export function materialManifestId(reference: Reference) {
  return `mat:${reference.materialId}@${reference.version}${reference.excerpt ? ":excerpt" : ""}`;
}

/** Constructed from the frozen context and the exact task's authorized materials. */
export function buildTaskInputManifest(
  store: Store, run: Run, contributionId: string, refs: Reference[],
  options?: { previewLimit?: number; decisionTaskPrefix?: string; subtask?: boolean; canReadMore?: boolean },
): InputManifest {
  const entries: InputManifestEntry[] = [];
  if (!options?.subtask) {
    // resolveRunContext persists before the host is constructed. Never rebuild history here.
    const frozen = store.require<Run>("run", run.id).contextSnapshot;
    entries.push(...(frozen?.sources ?? []));
    entries.push({ id: `msg:${run.id}`, kind: "message", entityId: run.id, label: run.text.slice(0, 400), coverage: "full" });
  }
  for (const ref of refs) {
    const material = store.material(ref);
    const body = ref.excerpt ?? material.body;
    // Root context includes the full authorized reference. Child previews are limited only
    // when the member can request more via the material tool (same rule as the formatter).
    const truncated = !!options?.subtask && !!options.canReadMore && body.length > (options.previewLimit ?? 1600);
    const coverage: ManifestCoverage = material.readError ? "omitted" : truncated ? "truncated" : ref.excerpt ? "excerpt" : partialCoverage.has(material.coverage) ? "summary" : "full";
    entries.push({ id: materialManifestId(ref), kind: "material", entityId: `${ref.materialId}@${ref.version}`, label: material.title, coverage });
    // An excerpt/preview does not authorize attribution to every record in its source.
    // Frozen embedded records are exposed only when the whole snapshot was delivered.
    if (!material.readError && !truncated && !ref.excerpt && material.processSource?.workId === run.workId)
      entries.push(...(material.processSource.sources ?? []));
  }
  if (options?.decisionTaskPrefix) {
    for (const d of store.all<Decision>("decision").filter(d => d.runId === run.id && d.status === "answered" && d.taskKey?.startsWith(options.decisionTaskPrefix!)))
      entries.push({ id: `dec:${d.id}`, kind: "decision", entityId: d.id, label: `${d.question}\n${d.answer}`.slice(0, 400), coverage: "full" });
  }
  const byId = new Map<string, InputManifestEntry>();
  for (const entry of entries) {
    if (byId.get(entry.id)?.coverage !== "full") byId.set(entry.id, entry);
  }
  return { id: `input:${contributionId}`, runId: run.id, workId: run.workId, contributionId, capturedAt: new Date().toISOString(), entries: [...byId.values()] };
}
export function manifestEntryIds(manifest: InputManifest | undefined) {
  return new Set(manifest?.entries.filter(e => e.coverage !== "omitted").map(e => e.id) ?? []);
}
export function filterPublicFeedback(manifest: InputManifest | undefined, feedback: { sourceId: string; stance: "used" | "not_used" | "clarify" | "unchecked"; note?: string }[] | undefined) {
  const allowed = manifestEntryIds(manifest);
  return { accepted: (feedback ?? []).filter(f => allowed.has(f.sourceId)), rejected: (feedback ?? []).filter(f => !allowed.has(f.sourceId)).map(f => f.sourceId) };
}
export const coverageLabels: Record<ManifestCoverage, string> = { full: "完整送入", excerpt: "仅选段", summary: "仅摘要", truncated: "部分送入", omitted: "未载入" };
export function formatManifestForDiagnostics(manifest: InputManifest) {
  return manifest.entries.map(e => `${e.id} · ${coverageLabels[e.coverage]} · ${e.label}`).join("\n");
}
export function maxWorkSeqForContributions(store: Store, contributionIds: string[]) {
  const runs = new Set(store.all<Contribution>("contribution").filter(c => contributionIds.includes(c.id)).map(c => c.runId));
  return Math.max(0, ...store.all<Run>("run").filter(r => runs.has(r.id)).map(r => r.workSeq ?? 0));
}
