import type { Store } from "./store.js";
import type { Source, Task, TaskKind, MemberId } from "../shared/types.js";
import type { SkillPolicy } from "../shared/skills.js";

export interface FeatureTaskInput {
  requestId?: string;
  isolatedContext?: boolean;
  skillPins?: import("../shared/skills.js").SkillDefinition[];
  goal: string;
  title: string;
  kind?: TaskKind;
  member?: MemberId;
  projectId?: string;
  teamMode?: "software" | "media";
  skillPolicy?: SkillPolicy;
  sources?: Source[];
}

/** Domain features share the existing task, storage and runtime authority. */
export interface FeatureHost {
  store: Store;
  createWork(input: FeatureTaskInput): Promise<Task>;
  addSource(taskId: string, source: Source): Promise<void>;
  readURL?(url: string): Promise<Source>;
  runWork(taskId: string): Promise<void>;
  stopWork(taskId: string): Promise<void>;
  isRunning(taskId: string): boolean;
}
