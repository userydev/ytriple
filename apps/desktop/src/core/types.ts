import type {
  SkillVersion,
  SkillState,
  SkillUse,
  SkillAdoption,
} from "./skill-contract";
import type { OutcomeRecord } from "./outcome-contract";
import type { Layout, WorkView } from "./view";
import type { RadarSnapshot } from "./radar-contract";
import type { WorkspaceContext } from "./workspace-context";
import type { WorkspaceActionProposal } from "./workspace-action-contract";
import type { FeedSource, FeedCheck } from "./feed-contract";
import type {
  Schedule,
  ScheduleOccurrence,
  ScheduledRun,
  ModelCall,
} from "./schedule-contract";
import type { InitializationSummary } from "./project-initialization";
import type {
  SuggestionDocument,
  SuggestionReceipt,
} from "./project-suggestions";
export type RunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";
export type Reference = {
  materialId: string;
  version: number;
  label: string;
  excerpt?: string;
};
export type OutputMode =
  "result" | "explanation" | "summary" | "review" | "readiness" | "method";
export type Draft = {
  workspaceContext?: WorkspaceContext;
  teamKey?: string;
  workflowKey?: string;
  skillKeys?: string[];
  outputMode?: OutputMode;
  preparedProcess?: { materialId: string; instruction: string; added: boolean };
  id: string;
  text: string;
  refs: Reference[];
  recipient: string | null;
  projectId: string | null;
  updatedAt: string;
};
export type Project = {
  id: string;
  name: string;
  goal: string;
  kind: "software" | "media";
  createdAt: string;
  directory?: string | null;
};
export type LocalRoots = { aiPath: string | null; codePath: string | null };
export type LocalInventory = {
  inspectedAt: string;
  roots: {
    kind: "ai" | "code";
    path: string | null;
    available: boolean;
    error: string | null;
  }[];
  projects: { name: string; path: string }[];
  assets: {
    id: string;
    title: string;
    kind: string;
    path: string;
    available: boolean;
  }[];
  notes: string[];
};
export type ProjectFile = {
  path: string;
  kind: "source" | "configuration" | "test" | "documentation" | "other";
  state:
    | "unread"
    | "captured"
    | "changed"
    | "missing"
    | "excluded"
    | "unavailable"
    | "unchecked";
  reason?: string;
  bytes?: number;
  modifiedAt?: string;
  sha256?: string;
  reference?: Reference;
};
export type ProjectInspection = {
  projectId: string;
  root: string;
  inspectedAt: string;
  entries: ProjectFile[];
  limited: boolean;
  notes: string[];
};
export type ProjectBrief = {
  projectId: string;
  revision: number;
  goal: string;
  refs: Reference[];
  createdAt: string;
};
export type ProjectStandard = {
  id: string;
  projectId: string;
  revision: number;
  title: string;
  body: string;
  deliveryId: string | null;
  enabled: boolean;
  source?: { versionId: string; excerpt?: string };
  createdAt: string;
};
export type ProjectContext = {
  projectId: string;
  projectName: string;
  briefRevision: number;
  goal: string;
  standards: ProjectStandard[];
  materials: { reference: Reference; material: Material }[];
};
export type Delivery = {
  id: string;
  projectId: string;
  title: string;
  adoptedVersionId: string | null;
};
export type Work = {
  workspaceContext?: WorkspaceContext;
  id: string;
  title: string;
  projectId: string | null;
  deliveryId: string | null;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  completedAt?: string | null;
  queuePaused: boolean;
  teamKey?: string;
  workflowKey?: string;
};
export type Material = {
  feedSource?: {
    sourceId: string;
    checkId: string;
    sourceUrl: string;
    resolvedUrl: string;
    contentHash: string;
    rawHash: string;
    publishedAt: string | null;
    fetchedAt: string;
    publisher: string | null;
  };
  id: string;
  version: number;
  title: string;
  body: string;
  coverage: string;
  readError?: string;
  provenance?: { editionId: string; refs: Reference[] };
  projectSource?: {
    projectId: string;
    root: string;
    path: string;
    sha256: string;
    bytes: number;
    modifiedAt: string;
    kind: ProjectFile["kind"];
  };
  readinessSource?: {
    workId: string;
    versionId: string;
    versionHash: string;
    recipient: string;
    purpose: string;
    outcomeIds: string[];
    outcomeState?: string;
  };
  processSource?: {
    workId: string;
    runIds: string[];
    contributionIds: string[];
    outcomeIds?: string[];
    outcomeState?: string;
    versionIds: string[];
    capturedAt: string;
    mode: OutputMode;
  };
  url?: string;
  upstream?: {
    scope: string;
    id: string;
    revision: number;
    publisher: string | null;
    publishedAt: string | null;
    discoveredAt: string;
    updatedAt: string;
    topics: string[];
    provenance: {
      sourceId: string;
      adapter: string;
      upstreamId: string | null;
      discoveredAt: string;
      rawRef: string;
    }[];
    contentHash: string;
    fullArticle: false;
  };
  createdAt: string;
};
export type Message = {
  id: string;
  workId: string;
  runId: string;
  role: "user" | "assistant";
  body: string;
  refs: Reference[];
  createdAt: string;
};
export type Member = {
  toolKeys?: import("./tool-contract").ToolKey[];
  id: string;
  name: string;
  instruction: string;
  skillKeys?: string[];
};
export type Team = {
  id: string;
  version: number;
  name: string;
  members: Member[];
};
export type Workflow = {
  delegation?: { maxTasks: number; maxDepth: number };
  id: string;
  version: number;
  name: string;
  stages: { role: string; objective: string; result: boolean }[];
};
export type Run = {
  workspacePolicy?: { direct: boolean };
  workspaceContext?: WorkspaceContext;
  tools?: import("./tool-contract").ToolPolicy;
  modelIdentity?: import("./model-contract").ModelIdentity;
  recovery?: "remote" | "local";
  abandonedAt?: string;
  schedule?: ScheduledRun;
  skills?: SkillVersion[];
  requestedSkillKeys?: string[];
  outputMode?: OutputMode;
  id: string;
  workId: string;
  text: string;
  refs: Reference[];
  recipient: string | null;
  status: RunStatus;
  error: string | null;
  createdAt: string;
  team: Team;
  workflow: Workflow;
  baseVersionId: string | null;
  submissionKey: string;
  queueRevision?: number;
  queueDraft?: { text: string; refs: Reference[]; recipient: string | null };
  serviceScope?: string;
  resumeRequested?: boolean;
  projectContext?: ProjectContext | null;
};
export type DecisionRequest = {
  question: string;
  reason: string;
  impact: string;
  options: { label: string; detail: string }[];
};
export type Decision = DecisionRequest & {
  taskKey?: string;
  id: string;
  revision: number;
  workId: string;
  runId: string;
  contributionId: string;
  stage: number;
  attempt: number;
  baseVersionId: string | null;
  status: "pending" | "answered" | "cancelled";
  draft: string;
  draftRevision: number;
  answer: string | null;
  createdAt: string;
  answeredAt: string | null;
};
export type Contribution = {
  tool?: import("./tool-contract").ToolReceipt;
  toolFormatError?: { message: string; createdAt: string };
  skills?: SkillUse[];
  skillRequest?: { key: string; purpose: string };
  task?: {
    key: string;
    stage: number;
    depth: number;
    parentId?: string;
    returnedFrom?: string;
    refs: Reference[];
  };
  delegation?: {
    request: {
      memberId: string;
      objective: string;
      context: string;
      references: number[];
    };
    childKey: string;
    responseId?: string;
  };
  id: string;
  workId: string;
  runId: string;
  memberId: string;
  memberName: string;
  objective: string;
  body: string;
  status: RunStatus;
  remoteId: string | null;
  remoteKey?: string;
  error: string | null;
  createdAt: string;
};
export type ArtifactVersion = {
  kind?: "result" | "summary" | "review" | "readiness" | "method";
  id: string;
  artifactId: string;
  workId: string;
  runId: string | null;
  parentId: string | null;
  number: number;
  body: string;
  createdAt: string;
  author: "team" | "user";
  editedFromId?: string;
  candidateId?: string;
};
export type ArtifactCandidate = {
  id: string;
  artifactId: string;
  workId: string;
  runId: string;
  baseVersionId: string | null;
  body: string;
  status: "pending" | "resolved" | "dismissed";
  resolvedVersionId: string | null;
  createdAt: string;
};
export type AssetOrigin = {
  materialId: string;
  version: number;
  coverage: string;
  url?: string;
  workTitle?: string;
  projectName?: string;
  versionId?: string;
  selected: boolean;
};
export type Asset = {
  id: string;
  label: string;
  reference: Reference;
  createdAt: string;
  files?: { path: string; sha256: string; savedAt: string }[];
  importedOrigin?: AssetOrigin;
  importFingerprint?: string;
};
export type Source = {
  id: string;
  name: string;
  status: string;
  last_error: string | null;
};
export type ServiceStatus = {
  account?: import("./accounts").AccountInfo;
  configured: boolean;
  baseUrl: string;
  connected: boolean;
  ai: boolean;
  error: string | null;
};
export type Snapshot = {
  workspacePolicy: { direct: boolean };
  workspaceActions: WorkspaceActionProposal[];
  desktop?: {
    version: string;
    buildId: string;
    packaged: boolean;
    platform: string;
    arch: string;
    dataDirectory: string;
  };
  model?: import("./model-contract").ModelInfo;
  workspace?: { id: string; name: string; startupError?: string };
  feeds: FeedSource[];
  feedChecks: FeedCheck[];
  schedules: Schedule[];
  scheduleOccurrences: ScheduleOccurrence[];
  modelCalls: ModelCall[];
  skills: SkillVersion[];
  skillStates: SkillState[];
  skillAdoptions: SkillAdoption[];
  outcomes: OutcomeRecord[];
  radar: RadarSnapshot;
  layout: Layout;
  views: WorkView[];
  works: Work[];
  projects: Project[];
  projectInspections: ProjectInspection[];
  suggestionDocuments: SuggestionDocument[];
  suggestionReceipts: SuggestionReceipt[];
  initializations: InitializationSummary[];
  projectBriefs: ProjectBrief[];
  projectStandards: ProjectStandard[];
  localRoots: LocalRoots;
  localInventory: LocalInventory | null;
  deliveries: Delivery[];
  drafts: Draft[];
  messages: Message[];
  runs: Run[];
  contributions: Contribution[];
  versions: ArtifactVersion[];
  candidates: ArtifactCandidate[];
  decisions: Decision[];
  materials: Material[];
  assets: Asset[];
  sources: Source[];
  service: ServiceStatus;
  team: Team;
  workflow: Workflow;
  teams: Team[];
  workflows: Workflow[];
};
export type SubmitInput = {
  workspaceContext?: WorkspaceContext;
  schedule?: ScheduledRun;
  skillKeys?: string[];
  outputMode?: OutputMode;
  key: string;
  context: string;
  text: string;
  refs: Reference[];
  recipient: string | null;
  projectId: string | null;
  deliveryId?: string | null;
};
export const defaultTeam: Team = {
  id: "editorial",
  version: 1,
  name: "研究与核查",
  members: [
    {
      id: "researcher",
      name: "研究员",
      instruction:
        "分析用户问题与给定材料，区分原文、摘要、推断。只声称实际可见的证据；不虚构检索、工具或验证。给出候选方案与取舍。",
    },
    {
      id: "reviewer",
      name: "核查员",
      instruction:
        "审查研究结论，具体指出证据缺口、推断越界、反例、约束冲突与需要修订的句子。保留可以成立的结论，不为扮演角色而机械反对。",
    },
    {
      id: "editor",
      name: "编辑员",
      instruction:
        "综合研究与核查意见，按用户目标输出可以直接使用的完整成果。修订时保持原成果身份和未要求改变的内容。保留真实限制，不虚构已验证、发布或工具执行。只返回成果正文，不输出工作日志。",
    },
  ],
};
export const defaultWorkflow: Workflow = {
  id: "evidence-revision",
  version: 1,
  name: "分析 → 核查 → 修订",
  stages: [
    {
      role: "researcher",
      objective: "理解问题、材料与可行方案",
      result: false,
    },
    {
      role: "reviewer",
      objective: "核查依据与约束，指出需修订处",
      result: false,
    },
    { role: "editor", objective: "吸收核查意见，形成或修订成果", result: true },
  ],
};

export const adaptiveWorkflow: Workflow = {
  id: "adaptive-team",
  version: 1,
  name: "按需协作 · 负责人委派与汇合",
  delegation: { maxTasks: 4, maxDepth: 2 },
  stages: [
    {
      role: "editor",
      objective:
        "判断目标和证据是否清楚；简单任务直接完成，需要时委派研究或核查，再根据真实返回给出可用成果。",
      result: true,
    },
  ],
};

export const workbenchTeam: Team = {
  id: "workbench-team",
  version: 1,
  name: "工作团队",
  members: defaultTeam.members.map((member) => member.id === "editor" ? {
    ...member,
    name: "工作伙伴",
    toolKeys: ["builtin.workspace@1", "builtin.material@1", "builtin.calculate@1"],
    instruction: "理解用户当前目标和正在处理的对象，先核对真实状态。简单问题直接回答，明确操作使用实际工作台能力办理；需要研究或核查时才委派。仅缺少会改变行动的条件才追问。区分已执行、等待确认和执行失败，不用建议或文字代替真实操作。解释不修改成果，调整保留原对象和历史。",
  } : { ...member, toolKeys: ["builtin.material@1", "builtin.calculate@1"] }),
};
export const workbenchWorkflow: Workflow = {
  ...adaptiveWorkflow,
  id: "workbench-flow",
  name: "按需办理与协作",
  stages: [{ role: "editor", objective: "根据目标选择直接回答、办理或按需委派；办理以真实结果回应，分析依赖实际证据，不机械全员发言。", result: true }],
};
