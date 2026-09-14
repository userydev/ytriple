import type {
  GenerateRequest,
  GenerateResult,
  JsonSchema,
  ProviderAdapter,
  ProviderCapabilities,
} from "@ytriple/shared";

/**
 * A deterministic stand-in for a real model.
 *
 * It answers any request by generating a value that satisfies the requested
 * schema, seeded with the sample's own vocabulary so the output is on topic.
 * That is deliberately a weaker claim than "the model writes a good PRD": what
 * this validates is the system around the model — that a schema-valid,
 * on-topic set of replies always yields one structurally complete document,
 * including when the model misbehaves in the ways real ones do.
 */
export type ModelDefect =
  | "clean"
  | "fenced_json"
  | "chatty_prose"
  | "invalid_once"
  | "member_failure"
  | "empty_optional_lists";

export interface SyntheticModelOptions {
  /** Words from the user's idea, woven into generated content. */
  topic: string;
  keywords: string[];
  defect: ModelDefect;
  /** Which agent explodes, when the defect is `member_failure`. */
  failingAgentId?: string;
  capabilities?: Partial<ProviderCapabilities>;
}

const BASE_CAPABILITIES: ProviderCapabilities = {
  structuredOutput: "json_schema",
  toolCalling: "parallel",
  nativeWebSearch: false,
  streaming: false,
  maxContextTokens: 128_000,
  maxOutputTokens: 8_192,
  reasoningEffort: false,
  visionInput: false,
  costTier: "cheap",
};

export function createSyntheticAdapter(options: SyntheticModelOptions): ProviderAdapter & {
  readonly requests: GenerateRequest[];
} {
  const requests: GenerateRequest[] = [];
  const capabilities = { ...BASE_CAPABILITIES, ...options.capabilities };
  const seenPhases = new Set<string>();

  return {
    adapterId: "openai_compatible",
    providerId: "synthetic",
    requests,
    describe: (model) => ({ ...capabilities, ...model.capabilities }),
    async healthCheck() {
      return { reachable: true, detected: capabilities, mismatches: [] };
    },
    async generate(request): Promise<GenerateResult> {
      requests.push(request);
      const { agentId, phase } = request.metadata;

      if (options.defect === "member_failure" && agentId === options.failingAgentId && phase === "member_work") {
        throw new Error(`synthetic outage for ${agentId}`);
      }

      if (!request.responseSchema) {
        return reply("acknowledged", request, options);
      }

      const phaseKey = `${agentId}:${phase}`;
      const firstTimeThisPhase = !seenPhases.has(phaseKey);
      seenPhases.add(phaseKey);

      // Return a response that fails validation once, to exercise the repair
      // path the way a JSON-mode model does in practice.
      if (options.defect === "invalid_once" && firstTimeThisPhase && phase === "member_work") {
        return reply(JSON.stringify({ unexpected: "not the schema" }), request, options);
      }

      const value = generate(request.responseSchema.schema, {
        request,
        options,
        path: request.responseSchema.name,
      });

      return reply(JSON.stringify(value), request, options);
    },
  };
}

function reply(
  body: string,
  request: GenerateRequest,
  options: SyntheticModelOptions,
): GenerateResult {
  let text = body;
  if (options.defect === "fenced_json") text = `\`\`\`json\n${body}\n\`\`\``;
  if (options.defect === "chatty_prose") text = `Sure — here is the result.\n\n${body}\n\nHope that helps.`;

  const promptLength =
    request.system.length + request.messages.reduce((total, entry) => total + entry.content.length, 0);

  return {
    text,
    toolCalls: [],
    usage: {
      inputTokens: Math.ceil(promptLength / 4),
      outputTokens: Math.ceil(text.length / 4),
    },
    degradations: [],
  };
}

interface GenerateContext {
  request: GenerateRequest;
  options: SyntheticModelOptions;
  path: string;
}

function generate(schema: JsonSchema, context: GenerateContext): unknown {
  switch (schema.type) {
    case "object": {
      const result: Record<string, unknown> = {};
      const required = new Set(schema.required ?? []);
      for (const [key, property] of Object.entries(schema.properties ?? {})) {
        const isOptional = !required.has(key);
        // Real models skip optional fields; make sure the PRD survives that.
        if (isOptional && context.options.defect === "empty_optional_lists") continue;
        result[key] = generate(property, { ...context, path: key });
      }
      return result;
    }

    case "array": {
      if (!schema.items) return [];

      // An item keyed by an enum (memberTasks.agentId) needs one entry per value.
      const enumKey = Object.entries(schema.items.properties ?? {}).find(
        ([, property]) => property.enum !== undefined,
      );
      if (enumKey) {
        const [key, property] = enumKey;
        return (property.enum ?? []).map((value) =>
          generate(schema.items as JsonSchema, { ...context, path: `${context.path}.${value}` }, ),
        ).map((item, index) => ({
          ...(item as Record<string, unknown>),
          [key]: (property.enum ?? [])[index],
        }));
      }

      if (context.path === "approved") {
        // The question gate must address the candidate ids it was shown.
        return questionIdsIn(context.request.system).map((questionId) => ({ questionId }));
      }

      const count = Math.min(schema.maxItems ?? 3, Math.max(schema.minItems ?? 0, 3));
      return Array.from({ length: count }, (_, index) =>
        generate(schema.items as JsonSchema, { ...context, path: `${context.path}[${index}]` }),
      );
    }

    case "string":
      if (schema.enum && schema.enum.length > 0) return schema.enum[0];
      return sentenceFor(context);

    case "integer":
    case "number":
      return 1;

    case "boolean":
      return true;
  }
}

function questionIdsIn(system: string): string[] {
  return [...system.matchAll(/^- (q-\d+) \(/gm)].map((match) => match[1] ?? "");
}

/**
 * Content is generated from the field name plus the sample's own vocabulary,
 * so the resulting document is recognisably about what the user asked for.
 */
function sentenceFor(context: GenerateContext): string {
  const { topic, keywords } = context.options;
  const field = context.path.split(".").pop() ?? context.path;
  const keyword = keywords[Math.abs(hash(context.path)) % Math.max(1, keywords.length)] ?? topic;
  const readable = field.replace(/[._[\]]+/g, " ").replace(/\d+/g, "").trim();

  switch (field.replace(/\[\d+\]$/, "")) {
    case "understanding":
      return `You want ${topic}. The shape of it is still open, so that is part of the work.`;
    case "readiness":
      return "needs_questions";
    case "question":
      return `Which part of ${keyword} matters most for the first version?`;
    case "reason":
      return `It changes how ${keyword} is scoped.`;
    case "productObject":
    case "product_summary":
      return `${topic}, delivered as one clean first draft rather than a bundle of notes.`;
    case "targetUser":
    case "target_users":
      return `People who need ${keyword} and do not have a team to hand it to.`;
    case "coreScenario":
    case "core_scenario":
      return `The user describes ${topic}, answers a couple of questions, and receives a draft covering ${keyword}.`;
    case "painOrProblem":
    case "problem_background":
      return `Today ${keyword} stays vague, so nothing downstream can start.`;
    case "objective":
      return `Cover ${keyword} for ${topic}.`;
    case "summary":
      return `Findings on ${keyword} as it applies to ${topic}.`;
    case "statement":
      return `${keyword} is the part users get stuck on in ${topic}.`;
    case "title":
      return `${readable}: ${keyword}`;
    case "detail":
    case "body":
      return `${topic} must handle ${keyword} explicitly rather than leaving it implied.`;
    case "merge_notes":
      return `Merged the team's work on ${topic} into a first draft.`;
    default:
      return `${capitalise(readable)} for ${topic}, focused on ${keyword}.`;
  }
}

function capitalise(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

function hash(value: string): number {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) {
    result = (result * 31 + value.charCodeAt(index)) | 0;
  }
  return result;
}
