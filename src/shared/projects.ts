export interface ProjectWorktreeObservation {
  path: string;
  expectedBranch?: string;
  branch?: string;
  head?: string;
  changedFiles?: number;
  state: "ready" | "missing" | "error";
  error?: string;
  fingerprint?: string;
}
export interface ProjectDocumentObservation {
  name: string;
  path: string;
  state: "present" | "missing" | "error";
  modifiedAt?: string;
  bytes?: number;
}
export interface ProjectObservation {
  state: "ready" | "attention" | "missing" | "error";
  checkedAt: string;
  worktrees: ProjectWorktreeObservation[];
  documents: ProjectDocumentObservation[];
  issues: string[];
  fingerprint: string;
}
export interface ProjectChange {
  projectId: string;
  name: string;
  kind: "added" | "changed" | "removed";
  summary: string;
}
export interface ProjectDiscoveryState {
  status: "idle" | "scanning" | "ready" | "partial" | "failed";
  aiRoot: string;
  codeRoot: string;
  checkedAt?: string;
  errors: string[];
  truncated: boolean;
  changes: ProjectChange[];
  durationMs?: number;
}
