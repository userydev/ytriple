import type { Material } from "./types";

export function coreDecisionScore(material: Material) {
  const decision = material.coreDecision;
  if (!decision) return 0;
  if (decision.status === "insufficient") return -1;
  if (decision.status !== "ready") return 0;
  const semantic = decision.semanticValidProbability ?? 0.5;
  const quality = decision.contentQuality ?? 0;
  const importance = decision.generalImportance ?? 0;
  return semantic * 4 + quality * 2 + importance * 3;
}

export function compareCoreDecision(a: Material, b: Material) {
  return coreDecisionScore(b) - coreDecisionScore(a);
}
