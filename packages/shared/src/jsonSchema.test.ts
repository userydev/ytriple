import { describe, expect, it } from "vitest";
import {
  describeSchema,
  parseJsonPayload,
  validateAgainstSchema,
  type JsonSchema,
} from "./jsonSchema.js";

const briefSchema: JsonSchema = {
  type: "object",
  required: ["title", "confidence", "questions"],
  additionalProperties: false,
  properties: {
    title: { type: "string", description: "short task title" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    rounds: { type: "integer" },
    questions: {
      type: "array",
      maxItems: 2,
      items: {
        type: "object",
        required: ["question"],
        properties: { question: { type: "string" }, reason: { type: "string" } },
      },
    },
  },
};

describe("validateAgainstSchema", () => {
  it("accepts a well-formed payload", () => {
    const violations = validateAgainstSchema(
      { title: "PRD workshop", confidence: "medium", questions: [{ question: "Who?" }] },
      briefSchema,
    );
    expect(violations).toEqual([]);
  });

  it("reports missing required properties with a path", () => {
    const violations = validateAgainstSchema({ title: "x" }, briefSchema);
    expect(violations).toEqual([
      { path: "$.confidence", message: "required property is missing" },
      { path: "$.questions", message: "required property is missing" },
    ]);
  });

  it("rejects values outside an enum", () => {
    const violations = validateAgainstSchema(
      { title: "x", confidence: "certain", questions: [] },
      briefSchema,
    );
    expect(violations).toEqual([
      { path: "$.confidence", message: "expected one of low | medium | high, received certain" },
    ]);
  });

  it("checks nested array items and item counts", () => {
    const violations = validateAgainstSchema(
      {
        title: "x",
        confidence: "low",
        questions: [{ question: "a" }, { question: "b" }, { reason: "c" }],
      },
      briefSchema,
    );
    expect(violations).toEqual([
      { path: "$.questions", message: "expected at most 2 items" },
      { path: "$.questions[2].question", message: "required property is missing" },
    ]);
  });

  it("rejects unexpected properties when additionalProperties is false", () => {
    const violations = validateAgainstSchema(
      { title: "x", confidence: "low", questions: [], secret: "leak" },
      briefSchema,
    );
    expect(violations).toEqual([{ path: "$.secret", message: "unexpected property" }]);
  });

  it("requires integers where declared", () => {
    const violations = validateAgainstSchema(
      { title: "x", confidence: "low", questions: [], rounds: 1.5 },
      briefSchema,
    );
    expect(violations).toEqual([{ path: "$.rounds", message: "expected integer" }]);
  });
});

describe("describeSchema", () => {
  it("renders a prompt-friendly shape for providers without schema support", () => {
    expect(describeSchema(briefSchema)).toMatchInlineSnapshot(`
      "{
        "title": string // short task title
        "confidence": "low" | "medium" | "high"
        "rounds"?: number
        "questions": {
          "question": string
          "reason"?: string
        }[]
      }"
    `);
  });
});

describe("parseJsonPayload", () => {
  it("parses plain JSON", () => {
    expect(parseJsonPayload('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });

  it("parses fenced JSON", () => {
    expect(parseJsonPayload('```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } });
  });

  it("parses JSON wrapped in prose", () => {
    expect(parseJsonPayload('Sure! Here you go:\n{"a":1}\nHope that helps.')).toEqual({
      ok: true,
      value: { a: 1 },
    });
  });

  it("reports when no JSON is present", () => {
    expect(parseJsonPayload("I cannot do that")).toEqual({
      ok: false,
      error: "response contained no JSON object or array",
    });
  });
});
