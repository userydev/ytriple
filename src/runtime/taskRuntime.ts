import { DELIVERY_FILENAMES, createDeliveryPackage } from "./outputWriter";
import { PRD_TEMPLATE } from "./templates";
import { CONDUCTOR_SCHEMA, RESEARCHER_SCHEMA, SPECIALIST_SCHEMA } from "./agentSchemas";
import { roleReferencePrompt } from "./agencyRoleReferences";
import type {
  ConductorOutput,
  ProviderAdapter,
  ResearcherOutput,
  SpecialistOutput,
  TaskRecord,
  TaskStatus,
  WebSearchResponse,
} from "./types";
import { listWorkspaceFiles } from "./workspace";

export interface RunPrdTaskInput {
  userInput: string;
  workspaceRoot?: string;
  outputRoot?: string;
  provider: ProviderAdapter;
  webSearch: (input: { query: string; maxResults: number; searchMode: "light_research" }) => Promise<WebSearchResponse>;
  onStatusChange?: (status: TaskStatus) => void;
}

export async function runPrdTask(input: RunPrdTaskInput) {
  const now = new Date().toISOString();
  const task: TaskRecord = {
    taskId: crypto.randomUUID(),
    templateId: "prd",
    status: "drafting_input",
    workspaceRoot: input.workspaceRoot,
    userInput: input.userInput,
    clarifyAnswers: [],
    assumptions: [],
    selectedSpecialistRole: PRD_TEMPLATE.defaultSpecialistRole,
    createdAt: now,
    updatedAt: now,
  };

  const setStatus = (status: TaskStatus) => {
    task.status = status;
    task.updatedAt = new Date().toISOString();
    input.onStatusChange?.(status);
  };

  setStatus("classifying");
  validatePrdTask(input.userInput);

  setStatus("preparing_context");
  const workspaceSummary = input.workspaceRoot
    ? await listWorkspaceFiles({ workspaceRoot: input.workspaceRoot, maxResults: 20 })
    : { files: [] };

  setStatus("running_researcher");
  const researchPromise = runResearcher(input, workspaceSummary.files.map((file) => file.path));

  setStatus("running_specialist");
  const specialistPromise = runSpecialist(input, workspaceSummary.files.map((file) => file.path));

  const [researcher, specialist] = await Promise.all([researchPromise, specialistPromise]);

  setStatus("merging");
  const conductor = (await input.provider.generateJson({
    role: "conductor",
    system: conductorSystemPrompt(),
    user: JSON.stringify({
      user_input: input.userInput,
      template: PRD_TEMPLATE,
      workspace_files: workspaceSummary.files,
      researcher,
      specialist,
    }),
    schema: CONDUCTOR_SCHEMA,
  })) as ConductorOutput;

  assertConductorOutput(conductor);

  setStatus("writing_outputs");
  const documents = renderDeliveryDocuments(conductor, researcher, specialist);
  let deliveryPackage:
    | Awaited<ReturnType<typeof createDeliveryPackage>>
    | { artifactsDir: undefined; files: [] } = { artifactsDir: undefined, files: [] };

  if (input.outputRoot) {
    deliveryPackage = await createDeliveryPackage({
      outputRoot: input.outputRoot,
      taskId: task.taskId,
      documents,
    });
    task.artifactsDir = deliveryPackage.artifactsDir;
  }

  task.assumptions = conductor.assumptions;
  setStatus("completed");

  return {
    task,
    researcher,
    specialist,
    conductor,
    deliveryPackage,
    documents,
  };
}

async function runResearcher(input: RunPrdTaskInput, workspaceFiles: string[]) {
  const web = await input.webSearch({
    query: input.userInput,
    maxResults: 5,
    searchMode: "light_research",
  });

  return input.provider.generateJson({
    role: "researcher",
    system: [
      "You are the fixed yTriple Researcher. Return JSON only. Do light web research notes, not a deep report.",
      "Do not invent statistics, report names, citations, URLs, competitors, or source-backed claims. If a fact is not grounded in provided web_results or tool citations, label it as an inference or assumption.",
      roleReferencePrompt("researcher"),
    ].join("\n\n"),
    user: JSON.stringify({
      user_input: input.userInput,
      workspace_files: workspaceFiles,
      web_results: web.results,
      output_shape: "summary, key_findings, concepts, competitor_samples, sources",
    }),
    schema: RESEARCHER_SCHEMA,
  }) as Promise<ResearcherOutput>;
}

function runSpecialist(input: RunPrdTaskInput, workspaceFiles: string[]) {
  return input.provider.generateJson({
    role: "specialist",
    system: [
      "You are the fixed yTriple Specialist for the PRD template. Use product_lead role and return JSON only.",
      roleReferencePrompt("specialist"),
    ].join("\n\n"),
    user: JSON.stringify({
      user_input: input.userInput,
      workspace_files: workspaceFiles,
      review_checklist: PRD_TEMPLATE.reviewChecklist,
      output_shape: "role, summary, strengths, risks, missing_sections, recommendations",
    }),
    schema: SPECIALIST_SCHEMA,
  }) as Promise<SpecialistOutput>;
}

function validatePrdTask(userInput: string) {
  if (userInput.trim().length < 8) {
    throw new Error("PRD task input is too short to infer a product object or goal.");
  }
}

function conductorSystemPrompt() {
  return [
    "You are the fixed yTriple Conductor.",
    "Only support PRD first-draft delivery.",
    "Merge Researcher and Specialist structured outputs into a clean final PRD.",
    "Keep research notes and specialist review out of the PRD body.",
    "Do not present unsupported statistics, report names, or citations as facts. Keep unverified claims in assumptions/open questions.",
    "Return JSON only with task_type, confidence, assumptions, open_questions, final_prd_markdown, artifact_manifest.",
    `artifact_manifest must be ${DELIVERY_FILENAMES.join(", ")}.`,
    roleReferencePrompt("conductor"),
  ].join("\n");
}

function assertConductorOutput(output: ConductorOutput) {
  if (output.task_type !== "prd") {
    throw new Error("Conductor returned an unsupported task type.");
  }

  const manifest = JSON.stringify(output.artifact_manifest);
  if (manifest !== JSON.stringify([...DELIVERY_FILENAMES])) {
    throw new Error("Conductor returned an invalid artifact manifest.");
  }
}

function renderDeliveryDocuments(
  conductor: ConductorOutput,
  researcher: ResearcherOutput,
  specialist: SpecialistOutput,
) {
  return {
    finalPrd: conductor.final_prd_markdown,
    assumptions: [
      "# Assumptions and Open Questions",
      "",
      "## Assumptions",
      ...conductor.assumptions.map((item) => `- ${item}`),
      "",
      "## Open Questions",
      ...conductor.open_questions.map((item) => `- ${item}`),
      "",
    ].join("\n"),
    researchNotes: [
      "# Research Notes",
      "",
      "## Summary",
      researcher.summary,
      "",
      "## Key Findings",
      ...researcher.key_findings.map((item) => `- ${item}`),
      "",
      "## Concepts",
      ...researcher.concepts.map((item) => `- ${item.name}: ${item.note}`),
      "",
      "## Competitor Samples",
      ...researcher.competitor_samples.map((item) => `- ${item.name}: ${item.note}`),
      "",
      "## Sources",
      ...researcher.sources.map((source) => `- [${source.title}](${source.url}) - ${source.reason}`),
      "",
    ].join("\n"),
    specialistReview: [
      "# Specialist Review",
      "",
      `Role: ${specialist.role}`,
      "",
      "## Summary",
      specialist.summary,
      "",
      "## Strengths",
      ...specialist.strengths.map((item) => `- ${item}`),
      "",
      "## Risks",
      ...specialist.risks.map((item) => `- ${item}`),
      "",
      "## Missing Sections",
      ...specialist.missing_sections.map((item) => `- ${item}`),
      "",
      "## Recommendations",
      ...specialist.recommendations.map((item) => `- ${item}`),
      "",
    ].join("\n"),
  };
}
