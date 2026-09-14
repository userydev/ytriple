/**
 * A deliberately small JSON Schema subset.
 *
 * It is the single description of structured agent output: providers that
 * support native `json_schema` receive it verbatim, providers that only offer a
 * JSON mode receive `describeSchema()` in the prompt, and every response is
 * checked with `validateAgainstSchema()` regardless of provider capability.
 */
export type JsonSchemaType =
  | "object"
  | "array"
  | "string"
  | "number"
  | "integer"
  | "boolean";

export interface JsonSchema {
  type: JsonSchemaType;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  items?: JsonSchema;
  enum?: readonly string[];
  additionalProperties?: boolean;
  minItems?: number;
  maxItems?: number;
}

export interface NamedJsonSchema {
  name: string;
  schema: JsonSchema;
}

export interface SchemaViolation {
  path: string;
  message: string;
}

export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
  path = "$",
): SchemaViolation[] {
  switch (schema.type) {
    case "object":
      return validateObject(value, schema, path);
    case "array":
      return validateArray(value, schema, path);
    case "string":
      return validateString(value, schema, path);
    case "integer":
    case "number":
      return validateNumber(value, schema, path);
    case "boolean":
      return typeof value === "boolean"
        ? []
        : [{ path, message: `expected boolean, received ${describeValue(value)}` }];
  }
}

function validateObject(
  value: unknown,
  schema: JsonSchema,
  path: string,
): SchemaViolation[] {
  if (!isRecord(value)) {
    return [{ path, message: `expected object, received ${describeValue(value)}` }];
  }

  const violations: SchemaViolation[] = [];
  const properties = schema.properties ?? {};

  for (const key of schema.required ?? []) {
    if (!(key in value)) {
      violations.push({ path: `${path}.${key}`, message: "required property is missing" });
    }
  }

  for (const [key, propertyValue] of Object.entries(value)) {
    const propertySchema = properties[key];
    if (!propertySchema) {
      if (schema.additionalProperties === false) {
        violations.push({ path: `${path}.${key}`, message: "unexpected property" });
      }
      continue;
    }
    if (propertyValue === undefined || propertyValue === null) {
      if ((schema.required ?? []).includes(key)) {
        violations.push({ path: `${path}.${key}`, message: "required property is null" });
      }
      continue;
    }
    violations.push(...validateAgainstSchema(propertyValue, propertySchema, `${path}.${key}`));
  }

  return violations;
}

function validateArray(
  value: unknown,
  schema: JsonSchema,
  path: string,
): SchemaViolation[] {
  if (!Array.isArray(value)) {
    return [{ path, message: `expected array, received ${describeValue(value)}` }];
  }

  const violations: SchemaViolation[] = [];
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    violations.push({ path, message: `expected at least ${schema.minItems} items` });
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    violations.push({ path, message: `expected at most ${schema.maxItems} items` });
  }
  if (schema.items) {
    value.forEach((item, index) => {
      violations.push(
        ...validateAgainstSchema(item, schema.items as JsonSchema, `${path}[${index}]`),
      );
    });
  }
  return violations;
}

function validateString(
  value: unknown,
  schema: JsonSchema,
  path: string,
): SchemaViolation[] {
  if (typeof value !== "string") {
    return [{ path, message: `expected string, received ${describeValue(value)}` }];
  }
  if (schema.enum && !schema.enum.includes(value)) {
    return [{ path, message: `expected one of ${schema.enum.join(" | ")}, received ${value}` }];
  }
  return [];
}

function validateNumber(
  value: unknown,
  schema: JsonSchema,
  path: string,
): SchemaViolation[] {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return [{ path, message: `expected number, received ${describeValue(value)}` }];
  }
  if (schema.type === "integer" && !Number.isInteger(value)) {
    return [{ path, message: "expected integer" }];
  }
  return [];
}

/** Human-readable schema rendering used when a provider has no native schema mode. */
export function describeSchema(schema: JsonSchema, indent = 0): string {
  const pad = "  ".repeat(indent);
  switch (schema.type) {
    case "object": {
      const entries = Object.entries(schema.properties ?? {});
      if (entries.length === 0) return "{}";
      const required = new Set(schema.required ?? []);
      const lines = entries.map(([key, propertySchema]) => {
        const marker = required.has(key) ? "" : "?";
        const comment = propertySchema.description ? ` // ${propertySchema.description}` : "";
        return `${pad}  "${key}"${marker}: ${describeSchema(propertySchema, indent + 1)}${comment}`;
      });
      return `{\n${lines.join("\n")}\n${pad}}`;
    }
    case "array":
      return `${schema.items ? describeSchema(schema.items, indent) : "unknown"}[]`;
    case "string":
      return schema.enum ? schema.enum.map((option) => `"${option}"`).join(" | ") : "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
  }
}

/**
 * Parses model output that is supposed to be JSON. Models wrap JSON in prose or
 * fences often enough that tolerating it is cheaper than a retry round trip.
 */
export function parseJsonPayload(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const candidate = extractJsonCandidate(text);
  if (candidate === undefined) {
    return { ok: false, error: "response contained no JSON object or array" };
  }
  try {
    return { ok: true, value: JSON.parse(candidate) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "invalid JSON" };
  }
}

function extractJsonCandidate(text: string): string | undefined {
  const withoutFence = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  if (withoutFence.startsWith("{") || withoutFence.startsWith("[")) {
    return withoutFence;
  }

  const firstBrace = withoutFence.indexOf("{");
  const lastBrace = withoutFence.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return withoutFence.slice(firstBrace, lastBrace + 1);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
