import type { SourceNote, TaskBrief } from "@ytriple/shared";

/**
 * Renders the single deliverable.
 *
 * The orchestrator returns structured merge output and this function lays it
 * out, so the required sections exist whether or not the model remembered them.
 * Section order follows the output contract.
 */
export interface PrdRenderInput {
  title: string;
  brief: TaskBrief;
  merge: Record<string, unknown>;
  sources: SourceNote[];
}

export function renderPrdMarkdown(input: PrdRenderInput): string {
  const { merge, brief } = input;
  const blocks: string[] = [`# ${input.title}`];

  blocks.push(section("Product Summary", paragraph(merge, "product_summary", brief.productObject)));
  blocks.push(
    section("Problem / Background", paragraph(merge, "problem_background", brief.painOrProblem)),
  );
  blocks.push(section("Target Users", paragraph(merge, "target_users", brief.targetUser)));
  blocks.push(section("Core Scenario", paragraph(merge, "core_scenario", brief.coreScenario)));
  blocks.push(section("V1 Scope", bullets(list(merge, "v1_scope", brief.v1Scope))));
  blocks.push(section("Non-goals", bullets(list(merge, "non_goals", brief.nonGoals))));
  blocks.push(section("Functional Requirements", functionalRequirements(merge)));
  blocks.push(section("UX / Interaction Requirements", bullets(list(merge, "ux_requirements", []))));

  const runtimeRequirements = list(merge, "data_permission_runtime_requirements", []);
  if (runtimeRequirements.length > 0) {
    blocks.push(section("Data / Permission / Runtime Requirements", bullets(runtimeRequirements)));
  }

  blocks.push(
    section("Success Criteria", bullets(list(merge, "success_criteria", brief.successCriteria))),
  );

  const assumptions = list(merge, "assumptions", brief.assumptions);
  const openQuestions = list(merge, "open_questions", brief.openQuestions);
  blocks.push(
    section(
      "Assumptions and Open Questions",
      [
        "**Assumptions**",
        bullets(assumptions),
        "",
        "**Open questions**",
        bullets(openQuestions),
      ].join("\n"),
    ),
  );

  if (input.sources.length > 0) {
    blocks.push(section("Source Notes", sourceNotes(input.sources)));
  }

  return `${blocks.join("\n\n")}\n`;
}

function section(heading: string, body: string): string {
  return `## ${heading}\n\n${body.trim().length > 0 ? body.trim() : "_Not established in this run._"}`;
}

function paragraph(merge: Record<string, unknown>, key: string, fallback: string): string {
  const value = merge[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function list(
  merge: Record<string, unknown>,
  key: string,
  fallback: readonly string[],
): string[] {
  const value = merge[key];
  const entries = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
  return entries.length > 0 ? entries : [...fallback];
}

function bullets(entries: readonly string[]): string {
  return entries.length > 0 ? entries.map((entry) => `- ${entry}`).join("\n") : "";
}

function functionalRequirements(merge: Record<string, unknown>): string {
  const value = merge.functional_requirements;
  if (!Array.isArray(value)) return "";

  const rendered = value.flatMap((entry, index) => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title : `Requirement ${index + 1}`;
    const detail = typeof record.detail === "string" ? record.detail : "";
    return [`${index + 1}. **${title}** — ${detail}`];
  });

  return rendered.join("\n");
}

function sourceNotes(sources: readonly SourceNote[]): string {
  const unique = new Map<string, SourceNote>();
  for (const source of sources) {
    if (!unique.has(source.url)) unique.set(source.url, source);
  }
  return [...unique.values()]
    .map((source) => `- [${source.title}](${source.url})${source.snippet ? ` — ${source.snippet}` : ""}`)
    .join("\n");
}
