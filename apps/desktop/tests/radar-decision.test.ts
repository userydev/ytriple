import { test } from "node:test";
import assert from "node:assert/strict";
import { compareCoreDecision, coreDecisionScore } from "../src/core/radar-decision";
import type { Material } from "../src/core/types";

const material = (
  id: string,
  decision?: Material["coreDecision"],
): Material => ({
  id,
  version: 1,
  title: id,
  body: id,
  coverage: "summary",
  createdAt: "2026-09-20T00:00:00Z",
  ...(decision ? { coreDecision: decision } : {}),
});

const decision = (
  overrides: Partial<NonNullable<Material["coreDecision"]>> = {},
): NonNullable<Material["coreDecision"]> => ({
  contractId: "core-radar-v1",
  contractVersion: 1,
  status: "ready",
  semanticValidProbability: 0.9,
  topic: "ai_technology",
  informationType: "report",
  contentQuality: 1,
  generalImportance: 1,
  completedAt: "2026-09-20T00:00:00Z",
  contentHash: "hash",
  error: null,
  ...overrides,
});

test("Y-Core Decision ranks stronger public signals ahead without becoming a user rule", () => {
  const strong = material("strong", decision({ contentQuality: 2, generalImportance: 2 }));
  const weak = material("weak", decision({ semanticValidProbability: 0.55, contentQuality: 0, generalImportance: 0 }));
  const unjudged = material("unjudged");
  assert.ok(coreDecisionScore(strong) > coreDecisionScore(weak));
  assert.ok(coreDecisionScore(weak) > coreDecisionScore(unjudged));
  assert.ok(compareCoreDecision(strong, weak) < 0);
});

test("insufficient title-only Decision is only a negative shared signal", () => {
  const insufficient = material(
    "insufficient",
    decision({
      status: "insufficient",
      semanticValidProbability: null,
      topic: null,
      informationType: null,
      contentQuality: null,
      generalImportance: null,
    }),
  );
  assert.equal(coreDecisionScore(insufficient), -1);
});
