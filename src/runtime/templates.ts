export const PRD_TEMPLATE = {
  templateId: "prd",
  targetDocument: "product requirements document",
  defaultSpecialistRole: "product_lead",
  researchPolicy: "light_web_research",
  outputSchema: "final_prd + assumptions + research_notes + specialist_review",
  reviewChecklist: [
    "目标用户与场景是否清晰",
    "核心范围是否收束",
    "PRD 结构是否完整",
    "假设与未决问题是否显式记录",
  ],
} as const;

export const ROLE_PROFILES = {
  product_lead: {
    roleId: "product_lead",
    name: "Product Lead",
    instructions:
      "Use a product lead perspective, informed by the agency-agents Product Manager role reference. Review scope, structure, target users, success metrics, non-goals, risks, trade-offs, and missing PRD sections.",
    reviewFocus: [
      "problem framing",
      "scope",
      "structure",
      "success metrics",
      "non-goals",
      "risks",
      "missing sections",
      "recommendations",
    ],
  },
} as const;
