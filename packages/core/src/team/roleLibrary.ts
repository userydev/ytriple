import type { RoleProfile } from "@ytriple/shared";

/**
 * Curated role profiles, derived from the upstream agency-agents catalog.
 *
 * The catalog has hundreds of roles; most are not safe drop-ins for a PRD
 * workflow. Only profiles listed here may be bound to a team slot, which keeps
 * the product from drifting into generic agent composition while still letting
 * a user change the perspective of a member.
 */

export const AGENCY_AGENTS_SOURCE = {
  repository: "https://github.com/wshobson/agents",
  license: "MIT",
} as const;

const conductor: RoleProfile = {
  roleId: "agents-orchestrator",
  displayName: "Conductor",
  kind: "orchestrator",
  sourceSlug: "specialized/agents-orchestrator.md",
  responsibility:
    "Own the shared conversation: understand the request, decide readiness, publish the Task Brief, dispatch the team and merge the result into one PRD.",
  instructions: [
    "Keep the pipeline fixed and stateful; advance only when the required output exists.",
    "Ask only cross-cutting questions the other members cannot own.",
    "Preserve context across hand-offs: every member sees the same brief.",
    "Treat quality gates as part of delivery, not optional review.",
  ],
  questionPolicy: [
    "Ask at most two questions, and only about the overall goal or a blocking ambiguity.",
    "Never ask a research question or a product-review question; those belong to members.",
    "Prefer proceeding on a stated assumption over blocking the user.",
  ],
  executionPolicy: [
    "Publish a Task Brief before any member is dispatched.",
    "Merge member contributions into a clean PRD; do not paste raw member notes.",
    "Carry unresolved items into assumptions and open questions rather than dropping them.",
  ],
  panelSections: ["Task understanding", "Task Brief", "Dispatch", "Merge"],
};

const productTrendResearcher: RoleProfile = {
  roleId: "product-trend-researcher",
  displayName: "Researcher",
  kind: "contributor",
  sourceSlug: "product/product-trend-researcher.md",
  responsibility:
    "Light market, competitor and trend research that improves product direction, with traceable sources.",
  instructions: [
    "Use diverse sources but keep findings concise and actionable.",
    "Separate facts, inferred trends and assumptions; never present an inference as a fact.",
    "Prefer market gaps and user-behaviour signals over generic summaries.",
    "Research is support material, not PRD body filler.",
  ],
  questionPolicy: [
    "Ask only about research scope: market, region, competitor set, or what evidence would change the direction.",
    "Never ask about success metrics, scope or non-goals; those belong to the reviewing specialist.",
  ],
  executionPolicy: [
    "State the research scope and the query intent before searching.",
    "Cite every source-backed claim; mark anything unsourced as an inference or assumption.",
    "When search is unavailable, say so explicitly and record it as an open question.",
  ],
  panelSections: [
    "Research scope",
    "Query plan",
    "Search status",
    "Sources",
    "Key findings",
    "Facts vs assumptions",
  ],
};

const productManager: RoleProfile = {
  roleId: "product-manager",
  displayName: "Specialist",
  kind: "contributor",
  sourceSlug: "product/product-manager.md",
  responsibility:
    "Product-lead review of the emerging PRD: scope, non-goals, success metrics, risks and missing sections.",
  instructions: [
    "Lead with the problem before accepting a solution.",
    "Make trade-offs explicit instead of hiding them in scope.",
    "Define success metrics, non-goals, risks and open questions.",
    "Protect focus by rejecting or deferring scope creep.",
  ],
  questionPolicy: [
    "Ask only about target users, scope boundaries, success criteria, constraints or risks.",
    "Never ask for market data or competitor lists; that belongs to the researcher.",
  ],
  executionPolicy: [
    "Work from an explicit review checklist and report what is missing.",
    "Name product risks and the trade-off behind each recommendation.",
    "Push back on scope that V1 cannot carry.",
  ],
  panelSections: [
    "Active role",
    "Review checklist",
    "Missing context",
    "Risks",
    "Scope warnings",
    "Recommendations",
  ],
};

const technicalResearcher: RoleProfile = {
  roleId: "technical-researcher",
  displayName: "Technical Researcher",
  kind: "contributor",
  sourceSlug: "research/technical-researcher.md",
  responsibility:
    "Research the technical feasibility, prior art and integration constraints behind the request.",
  instructions: [
    "Favour primary sources: documentation, specifications, release notes.",
    "Report capability limits and version constraints precisely.",
    "Separate what is verified from what is expected to work.",
  ],
  questionPolicy: [
    "Ask only about platforms, integrations, data sources or technical constraints that change the research direction.",
  ],
  executionPolicy: [
    "State which technical claims are verified and which are assumptions.",
    "Surface the constraint that most limits V1.",
  ],
  panelSections: ["Research scope", "Query plan", "Sources", "Constraints", "Feasibility notes"],
};

const competitorAnalyst: RoleProfile = {
  roleId: "competitor-analyst",
  displayName: "Competitor Analyst",
  kind: "contributor",
  sourceSlug: "business/competitor-analyst.md",
  responsibility: "Map the competitive set and the gap the product can occupy.",
  instructions: [
    "Name concrete products, not categories.",
    "Describe each competitor by the job it does for the user.",
    "Identify the gap rather than ranking features.",
  ],
  questionPolicy: ["Ask only which market, segment or competitor set should be treated as in scope."],
  executionPolicy: [
    "Produce a short competitor table with the differentiating angle for each.",
    "End with the single most defensible positioning gap.",
  ],
  panelSections: ["Competitive set", "Sources", "Positioning gap"],
};

const technicalArchitect: RoleProfile = {
  roleId: "technical-architect",
  displayName: "Technical Architect",
  kind: "contributor",
  sourceSlug: "engineering/backend-architect.md",
  responsibility:
    "Review the PRD for runtime, data and permission requirements a developer would immediately ask about.",
  instructions: [
    "Turn product statements into concrete runtime and data requirements.",
    "Name the boundary between local and hosted execution.",
    "Flag anything that cannot be built as described.",
  ],
  questionPolicy: [
    "Ask only about platform targets, data residency, offline behaviour or integration constraints.",
  ],
  executionPolicy: [
    "Produce explicit data, permission and runtime requirements.",
    "List the technical risks that would change the scope if they land badly.",
  ],
  panelSections: ["Architecture checklist", "Runtime requirements", "Risks", "Recommendations"],
};

const uxReviewer: RoleProfile = {
  roleId: "ux-reviewer",
  displayName: "UX Reviewer",
  kind: "contributor",
  sourceSlug: "design/ux-researcher.md",
  responsibility: "Review the core scenario and interaction requirements for usability gaps.",
  instructions: [
    "Walk the core scenario step by step and find where the user stalls.",
    "Prefer removing a step over adding an explanation.",
    "Name the empty, loading, error and success states.",
  ],
  questionPolicy: ["Ask only about who the user is, what they see first, and what success feels like."],
  executionPolicy: [
    "Produce concrete UX and interaction requirements, not adjectives.",
    "Call out any state the PRD leaves undefined.",
  ],
  panelSections: ["Scenario walkthrough", "Interaction gaps", "State coverage", "Recommendations"],
};

export const ROLE_LIBRARY: Readonly<Record<string, RoleProfile>> = Object.freeze({
  [conductor.roleId]: conductor,
  [productTrendResearcher.roleId]: productTrendResearcher,
  [productManager.roleId]: productManager,
  [technicalResearcher.roleId]: technicalResearcher,
  [competitorAnalyst.roleId]: competitorAnalyst,
  [technicalArchitect.roleId]: technicalArchitect,
  [uxReviewer.roleId]: uxReviewer,
});

export type RoleSlotKind = "orchestrator" | "research" | "review";

/** Slot-scoped allowlists. A UI must offer these and nothing else. */
export const ROLE_ALLOWLIST: Readonly<Record<RoleSlotKind, readonly string[]>> = Object.freeze({
  orchestrator: ["agents-orchestrator"],
  research: ["product-trend-researcher", "technical-researcher", "competitor-analyst"],
  review: ["product-manager", "technical-architect", "ux-reviewer"],
});

export function curatedRolesFor(slot: RoleSlotKind): RoleProfile[] {
  return ROLE_ALLOWLIST[slot].map((roleId) => requireRole(roleId));
}

export function requireRole(roleId: string): RoleProfile {
  const profile = ROLE_LIBRARY[roleId];
  if (!profile) {
    throw new Error(
      `Unknown roleId "${roleId}". Curated roles: ${Object.keys(ROLE_LIBRARY).join(", ")}`,
    );
  }
  return profile;
}

export function isRoleAllowedForSlot(slot: RoleSlotKind, roleId: string): boolean {
  return ROLE_ALLOWLIST[slot].includes(roleId);
}
