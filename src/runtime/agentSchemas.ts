import { DELIVERY_FILENAMES } from "./outputWriter";

export const RESEARCHER_SCHEMA = {
  name: "researcher_output",
  schema: {
    type: "object",
    properties: {
      summary: { type: "string" },
      key_findings: { type: "array", items: { type: "string" } },
      concepts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            note: { type: "string" },
          },
          required: ["name", "note"],
          additionalProperties: false,
        },
      },
      competitor_samples: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            note: { type: "string" },
          },
          required: ["name", "note"],
          additionalProperties: false,
        },
      },
      sources: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            url: { type: "string" },
            reason: { type: "string" },
          },
          required: ["title", "url", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["summary", "key_findings", "concepts", "competitor_samples", "sources"],
    additionalProperties: false,
  },
};

export const SPECIALIST_SCHEMA = {
  name: "specialist_output",
  schema: {
    type: "object",
    properties: {
      role: { type: "string", enum: ["product_lead"] },
      summary: { type: "string" },
      strengths: { type: "array", items: { type: "string" } },
      risks: { type: "array", items: { type: "string" } },
      missing_sections: { type: "array", items: { type: "string" } },
      recommendations: { type: "array", items: { type: "string" } },
    },
    required: ["role", "summary", "strengths", "risks", "missing_sections", "recommendations"],
    additionalProperties: false,
  },
};

export const CONDUCTOR_SCHEMA = {
  name: "conductor_output",
  schema: {
    type: "object",
    properties: {
      task_type: { type: "string", enum: ["prd"] },
      confidence: { type: "string", enum: ["low", "medium", "high"] },
      assumptions: { type: "array", items: { type: "string" } },
      open_questions: { type: "array", items: { type: "string" } },
      final_prd_markdown: { type: "string" },
      artifact_manifest: {
        type: "array",
        items: { type: "string", enum: [...DELIVERY_FILENAMES] },
      },
    },
    required: [
      "task_type",
      "confidence",
      "assumptions",
      "open_questions",
      "final_prd_markdown",
      "artifact_manifest",
    ],
    additionalProperties: false,
  },
};
