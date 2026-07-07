import type { AgentRole } from "./types";
import { AGENCY_AGENT_ROLES, AGENCY_AGENTS_SOURCE } from "./agencyAgentsCatalog";

export interface AgencyRoleReference {
  id: string;
  name: string;
  ytripleSlot: AgentRole;
  sourceSlug: string;
  sourceUrl: string;
  sourceLicense: "MIT";
  positioning: string;
  operatingPrinciples: string[];
}

const SLOT_REFERENCES = [
  {
    sourceSlug: "product/product-manager.md",
    ytripleSlot: "specialist",
  },
  {
    sourceSlug: "product/product-trend-researcher.md",
    ytripleSlot: "researcher",
  },
  {
    sourceSlug: "specialized/agents-orchestrator.md",
    ytripleSlot: "conductor",
  },
] as const satisfies Array<{ sourceSlug: string; ytripleSlot: AgentRole }>;

const ROLE_POSITIONING: Record<string, Pick<AgencyRoleReference, "positioning" | "operatingPrinciples">> = {
  "product/product-manager.md": {
    positioning:
      "Outcome-obsessed product leader who turns ambiguous business and user needs into scoped, measurable PRD decisions.",
    operatingPrinciples: [
      "Lead with the problem before accepting a solution.",
      "Make trade-offs explicit instead of hiding them in scope.",
      "Define success metrics, non-goals, risks, and open questions.",
      "Protect focus by rejecting or deferring scope creep.",
    ],
  },
  "product/product-trend-researcher.md": {
    positioning:
      "Market intelligence researcher focused on lightweight trend, competitor, and opportunity signals that improve product direction.",
    operatingPrinciples: [
      "Use diverse sources but keep findings concise and actionable.",
      "Separate facts, inferred trends, and strategic implications.",
      "Prefer market gaps and user behavior signals over generic summaries.",
      "Keep research as support material, not PRD body filler.",
    ],
  },
  "specialized/agents-orchestrator.md": {
    positioning:
      "Pipeline coordinator who enforces phase boundaries, handoffs, and evidence-based completion checks.",
    operatingPrinciples: [
      "Keep the pipeline fixed and stateful.",
      "Advance only after required outputs are available.",
      "Preserve context across agent handoffs.",
      "Treat quality gates as part of delivery, not optional review.",
    ],
  },
};

// These are role-positioning inputs from the upstream agency-agents catalog.
// They do not add extra runtime agents; yTriple V1 still has fixed Conductor / Researcher / Specialist slots.
export const AGENCY_ROLE_REFERENCES: AgencyRoleReference[] = SLOT_REFERENCES.map((mapping) => {
  const sourceRole = AGENCY_AGENT_ROLES.find((role) => role.path === mapping.sourceSlug);
  if (!sourceRole) {
    throw new Error(`Missing agency-agents role reference: ${mapping.sourceSlug}`);
  }
  const rolePositioning = ROLE_POSITIONING[mapping.sourceSlug];
  return {
    id: sourceRole.id,
    name: sourceRole.name,
    ytripleSlot: mapping.ytripleSlot,
    sourceSlug: sourceRole.path,
    sourceUrl: sourceRole.sourceUrl,
    sourceLicense: AGENCY_AGENTS_SOURCE.license,
    positioning: rolePositioning.positioning,
    operatingPrinciples: rolePositioning.operatingPrinciples,
  };
});

export function roleReferenceForAgent(role: AgentRole) {
  return AGENCY_ROLE_REFERENCES.find((reference) => reference.ytripleSlot === role);
}

export function roleReferencePrompt(role: AgentRole) {
  const reference = roleReferenceForAgent(role);
  if (!reference) {
    return "";
  }

  return [
    `Agency role reference: ${reference.name}.`,
    `Positioning: ${reference.positioning}`,
    `Role library: ${AGENCY_AGENTS_SOURCE.repository} (${AGENCY_AGENTS_SOURCE.license}), ${AGENCY_AGENT_ROLES.length} roles available as reference catalog.`,
    "Operating principles:",
    ...reference.operatingPrinciples.map((principle) => `- ${principle}`),
    `Source: ${reference.sourceSlug} (${reference.sourceLicense}).`,
    "Use this only as role-positioning reference inside the fixed yTriple slot.",
  ].join("\n");
}
