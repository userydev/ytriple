import type { JsonSchema, NamedJsonSchema } from "@ytriple/shared";

/**
 * Schemas for the orchestrator's own phases. Member contribution schemas live
 * on the role profile instead, so the runtime never needs to know what a
 * particular member returns.
 */

const stringArray = (description: string): JsonSchema => ({
  type: "array",
  description,
  items: { type: "string" },
});

export const INTAKE_SCHEMA: NamedJsonSchema = {
  name: "intake_result",
  schema: {
    type: "object",
    required: ["understanding", "readiness", "questions"],
    properties: {
      understanding: {
        type: "string",
        description: "Two or three sentences restating the task in your own words.",
      },
      readiness: {
        type: "string",
        enum: ["ready", "needs_questions"],
        description: "needs_questions only when a missing fact would change the direction.",
      },
      questions: {
        type: "array",
        maxItems: 2,
        description: "Cross-cutting questions only you can own. Prefer an empty list.",
        items: {
          type: "object",
          required: ["question", "reason"],
          properties: { question: { type: "string" }, reason: { type: "string" } },
        },
      },
    },
  },
};

export const MEMBER_QUESTIONS_SCHEMA: NamedJsonSchema = {
  name: "member_questions",
  schema: {
    type: "object",
    required: ["questions"],
    properties: {
      questions: {
        type: "array",
        maxItems: 2,
        description: "Questions inside your question policy scope. Empty is a valid answer.",
        items: {
          type: "object",
          required: ["question", "reason"],
          properties: {
            question: { type: "string" },
            reason: { type: "string", description: "Why this changes your work." },
          },
        },
      },
    },
  },
};

export function buildQuestionGateSchema(maxApproved: number): NamedJsonSchema {
  return {
  name: "question_gate",
  schema: {
    type: "object",
    required: ["approved"],
    properties: {
      approved: {
        type: "array",
        maxItems: maxApproved,
        description: "The questions actually worth the user's time, in asking order.",
        items: {
          type: "object",
          required: ["questionId"],
          properties: {
            questionId: { type: "string", description: "Id of a candidate question." },
            rewritten: {
              type: "string",
              description: "Optional clearer phrasing of the same question.",
            },
          },
        },
      },
      dropped_reason: {
        type: "string",
        description: "Why the remaining candidates were not worth asking.",
      },
    },
  },
  };
}

/** Default gate schema, matching DEFAULT_RUNTIME_LIMITS.maxApprovedQuestions. */
export const QUESTION_GATE_SCHEMA: NamedJsonSchema = buildQuestionGateSchema(3);

export function buildBriefSchema(agentIds: readonly string[]): NamedJsonSchema {
  return {
    name: "task_brief",
    schema: {
      type: "object",
      required: [
        "productObject",
        "targetUser",
        "coreScenario",
        "painOrProblem",
        "v1Scope",
        "nonGoals",
        "successCriteria",
        "assumptions",
        "openQuestions",
        "memberTasks",
      ],
      properties: {
        productObject: { type: "string" },
        targetUser: { type: "string" },
        coreScenario: { type: "string" },
        painOrProblem: { type: "string" },
        v1Scope: stringArray("What V1 delivers."),
        nonGoals: stringArray("What V1 explicitly does not do."),
        successCriteria: stringArray("How we know V1 worked."),
        assumptions: stringArray("Assumptions you are proceeding on."),
        openQuestions: stringArray("What is still unresolved."),
        memberTasks: {
          type: "array",
          description: `One entry per dispatched member. Valid agentIds: ${agentIds.join(", ")}.`,
          items: {
            type: "object",
            required: ["agentId", "objective", "mustCover", "outOfScope"],
            properties: {
              agentId: { type: "string", enum: [...agentIds] },
              objective: { type: "string" },
              mustCover: stringArray("Points this member must address."),
              outOfScope: stringArray("What belongs to another member."),
            },
          },
        },
      },
    },
  };
}

export const MERGE_SCHEMA: NamedJsonSchema = {
  name: "prd_merge",
  schema: {
    type: "object",
    required: [
      "merge_notes",
      "product_summary",
      "problem_background",
      "target_users",
      "core_scenario",
      "v1_scope",
      "non_goals",
      "functional_requirements",
      "ux_requirements",
      "success_criteria",
      "assumptions",
      "open_questions",
    ],
    properties: {
      merge_notes: {
        type: "string",
        description: "One short paragraph for the shared chat, not for the PRD body.",
      },
      product_summary: { type: "string" },
      problem_background: { type: "string" },
      target_users: { type: "string" },
      core_scenario: { type: "string" },
      v1_scope: stringArray("Scope lines."),
      non_goals: stringArray("Non-goals."),
      functional_requirements: {
        type: "array",
        items: {
          type: "object",
          required: ["title", "detail"],
          properties: { title: { type: "string" }, detail: { type: "string" } },
        },
      },
      ux_requirements: stringArray("UX and interaction requirements."),
      data_permission_runtime_requirements: stringArray(
        "Data, permission and runtime requirements, when relevant.",
      ),
      success_criteria: stringArray("Measurable success criteria."),
      assumptions: stringArray("Assumptions carried into the PRD."),
      open_questions: stringArray("Open questions carried into the PRD."),
    },
  },
};

export const SUBAGENT_RESULT_SCHEMA: NamedJsonSchema = {
  name: "subagent_result",
  schema: {
    type: "object",
    required: ["summary", "findings"],
    properties: {
      summary: { type: "string", description: "One paragraph answering your objective." },
      findings: stringArray("Concrete findings your parent can use."),
      gaps: stringArray("What you could not establish."),
    },
  },
};
