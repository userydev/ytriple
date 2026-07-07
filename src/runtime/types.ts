export type TaskStatus =
  | "drafting_input"
  | "classifying"
  | "quick_clarify"
  | "preparing_context"
  | "running_researcher"
  | "running_specialist"
  | "merging"
  | "writing_outputs"
  | "completed"
  | "failed";

export type AgentRole = "conductor" | "researcher" | "specialist";

export interface TaskRecord {
  taskId: string;
  templateId: "prd";
  status: TaskStatus;
  workspaceRoot?: string;
  userInput: string;
  clarifyAnswers: string[];
  assumptions: string[];
  selectedSpecialistRole: "product_lead";
  artifactsDir?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceFile {
  path: string;
  sizeBytes: number;
  mimeType: string;
}

export interface WorkspaceSummary {
  files: WorkspaceFile[];
}

export interface WorkspaceFileRead {
  path: string;
  content: string;
  truncated: boolean;
}

export interface WorkspaceTextMatch {
  path: string;
  line: number;
  snippet: string;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  sourceType: string;
}

export interface WebSearchResponse {
  results: WebSearchResult[];
}

export interface ResearcherOutput {
  summary: string;
  key_findings: string[];
  concepts: Array<{ name: string; note: string }>;
  competitor_samples: Array<{ name: string; note: string }>;
  sources: Array<{ title: string; url: string; reason: string }>;
}

export interface SpecialistOutput {
  role: "product_lead";
  summary: string;
  strengths: string[];
  risks: string[];
  missing_sections: string[];
  recommendations: string[];
}

export interface ConductorOutput {
  task_type: "prd";
  confidence: "low" | "medium" | "high";
  assumptions: string[];
  open_questions: string[];
  final_prd_markdown: string;
  artifact_manifest: string[];
}

export interface ProviderGenerateJsonInput {
  role: AgentRole;
  system: string;
  user: string;
  model?: string;
  schema?: {
    name: string;
    schema: Record<string, unknown>;
  };
}

export interface ProviderAdapter {
  generateJson(input: ProviderGenerateJsonInput): Promise<unknown>;
}
