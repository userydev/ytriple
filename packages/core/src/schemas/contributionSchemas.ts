import type { JsonSchema, NamedJsonSchema } from "@ytriple/shared";

/**
 * Contribution schemas belong to role profiles, not to the runtime. The merge
 * step receives whatever shape a role declared and passes it to the
 * orchestrator as JSON, which is why adding a role never touches orchestration.
 */

const stringArray = (description: string): JsonSchema => ({
  type: "array",
  description,
  items: { type: "string" },
});

const sharedContributionProperties: Record<string, JsonSchema> = {
  summary: { type: "string", description: "One paragraph answering your objective." },
  proposed_sections: {
    type: "array",
    description: "Draft material the orchestrator may fold into the PRD.",
    items: {
      type: "object",
      required: ["title", "body"],
      properties: { title: { type: "string" }, body: { type: "string" } },
    },
  },
  assumptions: stringArray("Assumptions you had to make."),
  open_questions: stringArray("What remains unresolved after your work."),
};

export const RESEARCH_CONTRIBUTION_SCHEMA: NamedJsonSchema = {
  name: "research_contribution",
  schema: {
    type: "object",
    required: ["summary", "facts", "inferences", "assumptions", "open_questions"],
    properties: {
      ...sharedContributionProperties,
      facts: {
        type: "array",
        description: "Source-backed statements. Each must cite a URL you actually saw.",
        items: {
          type: "object",
          required: ["statement"],
          properties: {
            statement: { type: "string" },
            sourceUrl: { type: "string", description: "Omit when no source supports it." },
          },
        },
      },
      inferences: stringArray("What you infer from the facts, clearly not fact itself."),
      competitive_set: {
        type: "array",
        description: "Named products or approaches, with the angle each takes.",
        items: {
          type: "object",
          required: ["name", "angle"],
          properties: { name: { type: "string" }, angle: { type: "string" } },
        },
      },
    },
  },
};

export const REVIEW_CONTRIBUTION_SCHEMA: NamedJsonSchema = {
  name: "review_contribution",
  schema: {
    type: "object",
    required: ["summary", "checklist", "risks", "recommendations", "assumptions", "open_questions"],
    properties: {
      ...sharedContributionProperties,
      checklist: {
        type: "array",
        description: "The review checklist you applied and the verdict for each item.",
        items: {
          type: "object",
          required: ["item", "verdict"],
          properties: {
            item: { type: "string" },
            verdict: { type: "string", enum: ["ok", "weak", "missing"] },
            note: { type: "string" },
          },
        },
      },
      missing_sections: stringArray("PRD sections that are absent or too thin."),
      risks: {
        type: "array",
        items: {
          type: "object",
          required: ["risk", "tradeoff"],
          properties: { risk: { type: "string" }, tradeoff: { type: "string" } },
        },
      },
      scope_warnings: stringArray("Scope that V1 cannot carry."),
      recommendations: stringArray("Concrete changes you recommend."),
    },
  },
};

export const GENERIC_CONTRIBUTION_SCHEMA: NamedJsonSchema = {
  name: "generic_contribution",
  schema: {
    type: "object",
    required: ["summary", "key_points", "assumptions", "open_questions"],
    properties: {
      ...sharedContributionProperties,
      key_points: stringArray("The points the orchestrator should carry into the PRD."),
    },
  },
};
