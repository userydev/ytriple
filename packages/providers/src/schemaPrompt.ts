import { describeSchema, type NamedJsonSchema } from "@ytriple/shared";

/**
 * Prompt-level fallback for providers that cannot enforce a response schema.
 * The runtime still validates the parsed payload, so this is a nudge rather
 * than a guarantee.
 */
export function appendSchemaInstruction(system: string, schema: NamedJsonSchema): string {
  return [
    system,
    "",
    `Reply with a single JSON object named ${schema.name} and nothing else.`,
    "Do not wrap it in Markdown fences and do not add commentary.",
    "It must match this shape exactly:",
    describeSchema(schema.schema),
  ].join("\n");
}
