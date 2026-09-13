/** Method skills carry guidance, never tool or filesystem authority. */
export interface SkillResource {
  path: string;
  content: string;
  hash: string;
}
export interface SkillDependency {
  name: string;
  status: "unknown" | "available" | "missing";
  evidence: string;
}
export interface SkillOrigin {
  label: string;
  location?: string;
  coverage?: string;
  copiedFromId?: string;
  copiedFromHash?: string;
  taskId?: string;
  artifactId?: string;
  artifactHash?: string;
}
export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  version: string;
  hash: string;
  source: "builtin" | "local" | "user" | "derived";
  instructions: string;
  origin?: SkillOrigin;
  dependencies?: SkillDependency[];
  resources?: SkillResource[];
  allowedMembers?: string[];
}
export interface SkillPolicy {
  mode: "auto" | "explicit" | "off";
  skillIds: string[];
}
export interface SkillFeedback {
  id: string;
  versionHash: string;
  outcome: "useful" | "failed" | "correction";
  conditions: string;
  observation: string;
  evidence: string;
  taskId?: string;
  artifactId?: string;
  createdAt: string;
}
export interface SkillCatalogEntry extends SkillDefinition {
  enabled: boolean;
  validation: "unverified" | "needs-review" | "observed-useful";
  revision?: number;
  versions?: {
    version: string;
    hash: string;
    name: string;
    createdAt: string;
    active: boolean;
  }[];
  feedback?: SkillFeedback[];
  availability?: "ready" | "missing-dependencies";
  editable?: boolean;
}
export const DEFAULT_SKILL_POLICY: SkillPolicy = { mode: "auto", skillIds: [] };
