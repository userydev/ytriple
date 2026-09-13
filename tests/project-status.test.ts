import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveProjectStatus,
  taskBelongsToProject,
} from "../src/shared/project-status.js";
import { projectDiscussionGoal } from "../src/shared/project-context.js";
import type { DeliveryRecord } from "../src/shared/delivery.js";
import type { ProjectInfo, Snapshot, Task } from "../src/shared/types.js";

const project: ProjectInfo = {
  id: "reader",
  name: "阅读工具",
  series: "y",
  root: "/unused/reader",
  devPath: "/unused/reader/dev",
  documents: { entry: "/unused/reader/dev/README.md" },
  observation: {
    state: "ready",
    checkedAt: "2026-09-13T10:00:00Z",
    fingerprint: "observed",
    issues: [],
    worktrees: [
      {
        path: "/unused/reader/dev",
        state: "ready",
        branch: "dev",
        changedFiles: 0,
        head: "1234567890",
      },
    ],
    documents: [
      { name: "entry", path: "/unused/reader/dev/README.md", state: "present" },
    ],
  },
};
const work = (id: string, patch: Partial<Task> = {}): Task => ({
  id,
  projectId: project.id,
  title: `工作 ${id}`,
  goal: "围绕本机项目「阅读工具」讨论。\n项目 ID：reader；目录：/unused/reader\n我的问题：确定离线阅读的首版范围。",
  goalVersion: 1,
  kind: "project",
  member: "cto",
  workspace: `/unused/${id}`,
  status: "completed",
  createdAt: "2026-09-13T09:00:00Z",
  updatedAt: "2026-09-13T09:00:00Z",
  messages: [],
  events: [],
  sources: [],
  artifacts: [],
  ...patch,
});
const snapshot = (
  tasks: Task[] = [],
  records: DeliveryRecord[] = [],
): Snapshot => ({
  version: "test",
  dataPath: "/unused",
  tasks,
  projects: [project],
  profiles: [],
  settings: {
    aiRoot: "/unused/AI",
    codeRoot: "/unused/Code",
    workspaceRoot: "/unused/work",
    defaultProfileId: "",
    memberProfiles: { coordinator: "", cto: "", researcher: "" },
  },
  system: {
    state: "ready",
    aiRoot: "/unused/AI",
    codeRoot: "/unused/Code",
    policyPath: "/unused/AI/system/POLICY.md",
    issues: [],
  },
  delivery: { records },
});
const delivery = (patch: Partial<DeliveryRecord> = {}): DeliveryRecord => ({
  id: "delivery",
  revision: 2,
  projectId: project.id,
  taskId: "task",
  artifactId: "scope",
  artifactTitle: "首版范围",
  artifactVersion: 1,
  artifactHash: "a".repeat(64),
  goalVersion: 1,
  content: "# 首版范围",
  format: "md",
  sources: [],
  recipient: "开发执行者",
  goal: "明确离线阅读的第一版",
  criteria: "能说明输入、输出和验收条件",
  missing: "",
  status: "verified",
  createdAt: "2026-09-13T08:00:00Z",
  updatedAt: "2026-09-13T10:00:00Z",
  history: [
    {
      status: "verified",
      recordedAt: "2026-09-13T10:00:00Z",
      evidence: {
        usage: "用来实施离线阅读切片",
        conditions: "已有本地书库",
        observations: "执行者按说明完成输入输出核对",
      },
    },
  ],
  works: [],
  feedback: [],
  exports: [],
  writebacks: [],
  ...patch,
});

test("file presence, clean Git and commit hashes cannot become product goals or completion", () => {
  const result = deriveProjectStatus(project, snapshot());
  assert.equal(result.goal.scope, "unknown");
  assert.equal(result.state.kind, "unknown");
  assert.equal(result.next.kind, "understand");
  assert.deepEqual(result.confirmed, []);
  assert.equal(result.changedFiles, 0);
  assert.equal(result.changedFilesComplete, true);
  assert.ok(
    result.observations.every(
      (item) => item.evidence.kind === "file_observation",
    ),
  );
  assert.ok(
    result.observations.some((item) =>
      item.detail.includes("未读取或评审正文"),
    ),
  );
});

test("AI run completion offers the actual result for review while retaining its own goal and project scope", () => {
  const own = work("task", {
    messages: [
      {
        id: "assistant",
        role: "assistant",
        member: "cto",
        content: "整个项目已经全部完成并验证。",
        createdAt: "2026-09-13T10:00:00Z",
        goalVersion: 1,
      },
    ],
    artifacts: [
      {
        id: "scope",
        title: "首版范围",
        path: "/unused/task/scope.md",
        format: "md",
        version: 2,
        hash: "b".repeat(64),
        goalVersion: 1,
        updatedAt: "2026-09-13T10:00:00Z",
        versions: [],
      },
    ],
  });
  const foreign = work("foreign", {
    projectId: "other",
    status: "failed",
    events: [
      {
        id: "legacy",
        type: "project.initialized",
        summary: "先前上下文",
        goalVersion: 1,
        createdAt: "2026-09-13T11:00:00Z",
        data: { projectId: project.id },
      },
    ],
  });
  const state = snapshot(
    [own, foreign],
    [delivery({ projectId: "other", taskId: own.id })],
  );
  const before = structuredClone(state);
  const result = deriveProjectStatus(project, state);
  assert.equal(result.goal.text, "确定离线阅读的首版范围。");
  assert.equal(result.goal.scope, "work");
  assert.equal(result.state.kind, "review");
  assert.equal(result.next.kind, "artifact");
  assert.equal(result.next.taskId, "task");
  assert.equal(result.next.artifactId, "scope");
  assert.deepEqual(result.confirmed, []);
  assert.deepEqual(result.deliveries, []);
  assert.equal(
    taskBelongsToProject(foreign, project.id),
    false,
    "explicit ownership overrides stale initialization events",
  );
  assert.deepEqual(
    state,
    before,
    "the projection never rewrites source facts or their order",
  );
});

test("actual waiting and delivery gaps retain their evidence while verified results stay bound to their old version", () => {
  const waiting = work("waiting", {
    status: "waiting",
    updatedAt: "2026-09-13T11:00:00Z",
    events: [
      {
        id: "wait",
        type: "agent_waiting",
        member: "cto",
        summary: "请决定本轮是否包含全文检索",
        goalVersion: 1,
        createdAt: "2026-09-13T11:00:00Z",
      },
    ],
  });
  const original = work("task", {
    artifacts: [
      {
        id: "scope",
        title: "首版范围",
        path: "/unused/task/scope.md",
        format: "md",
        version: 2,
        hash: "b".repeat(64),
        goalVersion: 1,
        updatedAt: "2026-09-13T10:30:00Z",
        versions: [],
      },
    ],
  });
  const result = deriveProjectStatus(
    project,
    snapshot(
      [original, waiting],
      [
        delivery({
          sourceChanged: true,
          missing: "新版本还缺离线冲突处理条件",
        }),
      ],
    ),
  );
  assert.equal(result.state.kind, "blocked");
  assert.equal(result.next.taskId, waiting.id);
  assert.equal(result.blockers[0]?.detail, "请决定本轮是否包含全文检索");
  assert.ok(
    result.blockers.some((item) => item.detail.includes("离线冲突处理条件")),
  );
  assert.equal(result.confirmed[0]?.evidence.artifactVersion, 1);
  assert.equal(result.confirmed[0]?.evidence.artifactHash, "a".repeat(64));
  assert.match(result.confirmed[0]!.detail, /已有本地书库/);
  assert.match(result.confirmed[0]!.detail, /执行者按说明完成输入输出核对/);
  assert.equal(result.artifacts[0]?.artifact.version, 2);
  assert.ok(result.unknowns.some((item) => item.includes("产品整体进展")));
});

test("missing observation coverage stays unknown and paused work takes priority over older finished output", () => {
  const partial = {
    ...project,
    observation: {
      ...project.observation!,
      worktrees: [
        project.observation!.worktrees[0]!,
        {
          path: "/unused/second",
          state: "error" as const,
          error: "没有读取权限",
        },
      ],
    },
  };
  const older = work("old", {
    artifacts: [
      {
        id: "old-result",
        title: "旧结果",
        path: "/unused/old.md",
        format: "md",
        version: 1,
        hash: "c".repeat(64),
        goalVersion: 1,
        updatedAt: "2026-09-13T08:00:00Z",
        versions: [],
      },
    ],
  });
  const paused = work("paused", {
    status: "paused",
    updatedAt: "2026-09-13T12:00:00Z",
  });
  const result = deriveProjectStatus(partial, snapshot([older, paused]));
  assert.equal(result.changedFiles, 0);
  assert.equal(result.changedFilesComplete, false);
  assert.equal(result.state.kind, "paused");
  assert.equal(result.next.taskId, paused.id);
  const unknown = deriveProjectStatus(
    { ...project, observation: undefined },
    snapshot(),
  );
  assert.equal(unknown.changedFiles, undefined);
});

test("project goal summaries show the user request from current and legacy composer envelopes", () => {
  const request =
    "先核对离线阅读的范围。\n我的问题：读者的原话还需要保留。\n用户要推进的工作：这行也是用户补充的内容。";
  const current = work("current", {
    goal: projectDiscussionGoal(project, request),
  });
  assert.equal(
    deriveProjectStatus(project, snapshot([current])).goal.text,
    request,
  );
  const legacy = work("legacy");
  assert.equal(
    deriveProjectStatus(project, snapshot([legacy])).goal.text,
    "确定离线阅读的首版范围。",
  );
  const singleLine = work("old-line", {
    goal: "围绕本机项目讨论。我的问题：保持旧记录可读。",
  });
  assert.equal(
    deriveProjectStatus(project, snapshot([singleLine])).goal.text,
    "保持旧记录可读。",
  );
  const direct = work("direct", {
    goal: "请解释这段模板。\n用户要推进的工作：不应剥去直接输入的前文。",
  });
  assert.equal(
    deriveProjectStatus(project, snapshot([direct])).goal.text,
    direct.goal,
  );
});
