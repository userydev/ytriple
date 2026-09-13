import test from "node:test";
import assert from "node:assert/strict";
import { buildProcessStory } from "../src/shared/process-story.js";
import { buildProcessDocument } from "../src/core/process-document.js";
import type { Task, TaskEvent, Message } from "../src/shared/types.js";
function fixture(): Task {
  return {
    id: "story",
    title: "选择离线方案",
    goal: "用用户提供的材料修正离线方案",
    goalVersion: 2,
    kind: "research",
    member: "coordinator",
    status: "completed",
    workspace: "/unused",
    createdAt: "2026-09-13T12:00:00Z",
    updatedAt: "2026-09-13T12:05:00Z",
    messages: [],
    events: [],
    sources: [
      {
        id: "source",
        title: "测量结果",
        text: "PRIVATE_SOURCE_BODY",
        location: "",
        type: "text",
        addedAt: "2026-09-13T12:00:00Z",
        coverage: "用户提供的测量片段",
      },
    ],
    artifacts: [
      {
        id: "doc",
        title: "方案说明",
        format: "md",
        content: "PRIVATE_ARTIFACT_BODY",
        path: "/unused/report.md",
        version: 3,
        hash: "c".repeat(64),
        goalVersion: 2,
        updatedAt: "2026-09-13T12:05:00Z",
        versions: [
          {
            version: 1,
            hash: "a".repeat(64),
            path: "/unused/v1.md",
            createdAt: "2026-09-13T12:00:00Z",
            summary: "初稿",
          },
          {
            version: 2,
            hash: "b".repeat(64),
            path: "/unused/v2.md",
            createdAt: "2026-09-13T12:03:00Z",
            summary: "修订",
          },
        ],
      },
    ],
  };
}
const event = (
  id: string,
  type: string,
  summary: string,
  data: Record<string, unknown> = {},
  goalVersion = 2,
  member: TaskEvent["member"] = "coordinator",
): TaskEvent => ({
  id,
  type,
  summary,
  data,
  goalVersion,
  member,
  createdAt: `2026-09-13T12:0${goalVersion}:00Z`,
});
const message = (
  id: string,
  role: Message["role"],
  content: string,
  goalVersion = 2,
): Message => ({
  id,
  role,
  member: "coordinator",
  content,
  goalVersion,
  createdAt: `2026-09-13T12:0${goalVersion}:00Z`,
});

test("legacy public answers and corrections recover a substantive history without manufacturing reports", () => {
  const task = fixture();
  task.messages = [
    message("question", "user", "离线时怎样查询资料？", 1),
    message(
      "old",
      "assistant",
      "## 结论\n先采用服务端索引。\n\n## 风险\n断网时查询能力未测试。",
      1,
    ),
    message(
      "correction",
      "user",
      "原方案不对：需要完全离线，把索引改为本地文件。",
    ),
    message(
      "new",
      "assistant",
      "## 修正\n原方案遗漏了离线约束；改为本地索引。\n\n## 结论\n本地索引可覆盖读取，文件规模仍需测试。\n\n## 做得好\n先核对离线约束避免继续扩展远端依赖。",
    ),
  ];
  const story = buildProcessStory(task);
  assert.equal(story.coverage.reports, 0);
  assert.equal(story.coverage.replies, 2);
  assert.match(story.coverage.notice, /从实际公开答复/);
  assert.ok(
    story.entries.some(
      (entry) =>
        entry.kind === "revision" && entry.provenance === "user_request",
    ),
  );
  assert.ok(
    story.entries.some(
      (entry) =>
        entry.kind === "revision" && entry.provenance === "public_reply",
    ),
  );
  assert.match(
    story.review.issues.map((item) => item.text).join("\n"),
    /需要完全离线/,
  );
  assert.match(
    story.review.issues.map((item) => item.text).join("\n"),
    /原方案遗漏了离线约束/,
  );
  assert.match(
    story.review.effective.map((item) => item.text).join("\n"),
    /先采用服务端索引[\s\S]*本地索引/,
  );
  assert.match(
    story.review.effective.map((item) => item.text).join("\n"),
    /先核对离线约束/,
  );
  const doc = buildProcessDocument(task).content;
  assert.match(doc, /复盘归纳/);
  assert.match(doc, /原方案遗漏了离线约束/);
  assert.match(doc, /目标记录 v1/);
  assert.match(doc, /目标记录 v2/);
  assert.match(doc, /依据索引/);
  assert.doesNotMatch(doc, /PRIVATE_/);
  const current = buildProcessStory(task, { scope: "goal" });
  assert.ok(current.entries.every((entry) => entry.goalVersion === 2));
  assert.doesNotMatch(
    buildProcessDocument(task, undefined, { scope: "goal" }).content,
    /先采用服务端索引/,
  );
});

test("public reports retain explanatory detail and exact historical read and artifact references", () => {
  const task = fixture();
  task.events = [
    event("read", "tool_completed", "LOG_BODY", {
      tool: "read_source",
      sourceId: "source",
      sourceHash: "d".repeat(64),
      readStart: 50,
      readEnd: 90,
      coverage: "当时的测量片段",
      result: "PRIVATE_TOOL_BODY",
    }),
    event("read-version", "tool_completed", "LOG_READ_ARTIFACT", {
      tool: "read_artifact",
      artifactId: "doc",
      version: 1,
      hash: "a".repeat(64),
    }),
    event("report", "progress_reported", "甲方案存在断网依赖。", {
      stage: "alternatives",
      detail: "在无网络条件下，服务端查询不可用；本地索引增加维护成本。",
      method: "关闭网络后对照索引行为。",
      questions: ["文件规模上限仍需实测。"],
      sourceIds: ["source"],
      artifactIds: ["doc"],
      reasoning: "PRIVATE_REASONING",
    }),
  ];
  const story = buildProcessStory(task),
    entry = story.entries.find(
      (entry) => entry.provenance === "public_report",
    )!;
  assert.match(entry.content, /服务端查询不可用/);
  assert.equal(entry.kind, "comparison");
  const source = entry.references.find((ref) => ref.kind === "source")!;
  assert.equal(source.readStart, 50);
  assert.equal(source.readEnd, 90);
  assert.equal(source.hash, "d".repeat(64));
  assert.equal(source.coverage, "当时的测量片段");
  const artifact = entry.references.find((ref) => ref.kind === "artifact")!;
  assert.equal(artifact.version, 1);
  assert.equal(artifact.hash, "a".repeat(64));
  assert.notEqual(artifact.version, task.artifacts[0].version);
  assert.match(story.review.unverified[0]!.text, /文件规模上限/);
  assert.match(story.review.effective[0]!.text, /关闭网络/);
  assert.doesNotMatch(
    JSON.stringify(story),
    /PRIVATE_|LOG_BODY|LOG_READ_ARTIFACT/,
  );
});

test("stream capture, the final hook and the user message merge exact duplicate text while retaining all provenance", () => {
  const task = fixture(),
    body = "## 判断\n合成测量不能证明真实用户效果。";
  task.messages = [message("answer", "assistant", body)];
  task.events = [
    event("full", "public_response", "成员公开答复", {
      invocationId: "run",
      content: body,
    }),
    event("end", "agent_completed", "成员完成", {
      invocationId: "run",
      content: "## 判断\n合成测量…",
    }),
    event("delegation", "delegation_completed", "成员回复", {
      childInvocationId: "run",
      receiver: "coordinator",
      result: "## 判断\n合成测量…",
    }),
  ];
  const story = buildProcessStory(task);
  assert.equal(story.entries.length, 1);
  assert.equal(story.entries[0].content, body);
  assert.equal(story.entries[0].truncated, false);
  assert.ok(story.entries[0].references.some((ref) => ref.kind === "message"));
  assert.ok(
    story.entries[0].references.some(
      (ref) => ref.kind === "event" && ref.id === "full",
    ),
  );
});

test("logs and failed requests do not become analysis; only explicit public fields are allowed", () => {
  const task = fixture();
  task.events = [
    event("raw", "raw_model_stream_event", "PRIVATE_RAW", {
      reasoning: "PRIVATE_REASONING",
    }),
    event("preview", "member_output", "流式节选", {
      content: "PRIVATE_UNCOMMITTED_PREVIEW",
    }),
    event("start", "tool_started", "准备读取", {
      tool: "read_source",
      sourceId: "source",
    }),
    event("fail", "tool_failed", "PRIVATE_PROTOCOL_DUMP", {
      tool: "read_source",
      sourceId: "source",
      result: "PRIVATE_TOOL_BODY",
    }),
  ];
  const story = buildProcessStory(task);
  assert.equal(story.entries.length, 0);
  assert.match(story.coverage.notice, /操作记录只能证明动作/);
  assert.match(story.review.issues[0]!.text, /读取有失败记录/);
  assert.equal(story.review.effective.length, 0);
  assert.doesNotMatch(JSON.stringify(story), /PRIVATE_/);
  assert.match(buildProcessDocument(task).content, /资料读取有失败记录/);
  assert.doesNotMatch(buildProcessDocument(task).content, /PRIVATE_/);
});

test("artifact version changes identify actual versions without claiming the requested correction was verified", () => {
  const task = fixture();
  task.messages = [
    message("change", "user", "继续处理方案：删掉未经验证的性能保证。"),
  ];
  task.events = [
    event(
      "v1",
      "artifact_written",
      "已保存",
      { artifactId: "doc", version: 1, hash: "a".repeat(64) },
      1,
    ),
    event("revise", "artifact.refine_requested", "修订", {
      artifactId: "doc",
      artifactVersion: 1,
      expectedHash: "a".repeat(64),
      instruction: "删掉未经验证的性能保证。",
    }),
    event("v2", "artifact_written", "已保存", {
      artifactId: "doc",
      version: 2,
      hash: "b".repeat(64),
    }),
  ];
  const story = buildProcessStory(task);
  const change = story.entries.find((entry) => entry.id === "event:v2")!;
  assert.match(change.content, /从第 1 版保存为第 2 版/);
  assert.equal(change.provenance, "revision_record");
  assert.equal(
    change.references.find((ref) => ref.kind === "artifact")!.version,
    2,
  );
  assert.match(story.review.issues[0]!.text, /删掉未经验证的性能保证/);
  assert.match(story.review.issues[0]!.text, /不自动证明/);
});

test("run and member scopes do not leak other invocations; real member requests and replies remain paired", () => {
  const task = fixture();
  task.events = [
    event("old-start", "run_started", "开始", { runId: "old" }),
    event("old", "public_response", "答复", {
      runId: "old",
      invocationId: "old",
      content: "旧轮专有判断",
    }),
    event("new-start", "run_started", "开始", { runId: "new" }),
    event("request", "delegation_started", "委派", {
      runId: "new",
      invocationId: "parent",
      childInvocationId: "child",
      callId: "call",
      receiver: "researcher",
      request: "请核查离线限制。",
    }),
    event(
      "reply",
      "public_response",
      "答复",
      {
        runId: "new",
        invocationId: "child",
        content: "仅凭所给资料无法证明离线可用。",
      },
      2,
      "researcher",
    ),
    event("end", "delegation_completed", "完成", {
      runId: "new",
      invocationId: "parent",
      childInvocationId: "child",
      callId: "call",
      receiver: "researcher",
      request: "请核查离线限制。",
      result: "仅凭所给资料无法证明离线可用。",
    }),
  ];
  const story = buildProcessStory(task, { scope: "run", member: "researcher" });
  assert.doesNotMatch(JSON.stringify(story), /旧轮专有判断/);
  assert.equal(
    story.entries.filter((entry) => entry.content === "请核查离线限制。")
      .length,
    1,
  );
  assert.equal(
    story.entries.filter(
      (entry) => entry.content === "仅凭所给资料无法证明离线可用。",
    ).length,
    1,
  );
  assert.doesNotMatch(
    JSON.stringify(buildProcessStory(task, { invocationId: "old" })),
    /离线限制/,
  );
});

test("source changes are input history with the original continued request, not fabricated new user messages", () => {
  const task = fixture();
  task.messages = [message("original", "user", "核查材料支持哪些结论。", 1)];
  task.events = [
    event("changed", "library.changed", "所用资产新增了一条纠正反馈。", {
      continuedUserMessageId: "original",
      entryId: "asset",
    }),
  ];
  const story = buildProcessStory(task);
  const changed = story.entries.find((entry) => entry.id === "event:changed")!;
  assert.equal(changed.provenance, "revision_record");
  assert.ok(
    changed.references.some(
      (ref) => ref.kind === "message" && ref.id === "original",
    ),
  );
  assert.equal(
    story.entries.filter((entry) => entry.provenance === "user_request").length,
    1,
  );
  assert.match(changed.content, /具体影响以之后的公开解释/);
});

test("long legacy answers disclose excerpt limits and headings inside code do not invent analysis stages", () => {
  const task = fixture();
  task.messages = [
    message("long", "assistant", "普通公开答复。".repeat(25_000)),
  ];
  const long = buildProcessStory(task);
  assert.equal(long.entries[0]!.truncated, true);
  assert.equal(long.entries[0]!.content.length, 120_000);
  task.messages = [
    message(
      "code",
      "assistant",
      "代码示例：\n```md\n# 结论\n这是示例里的标题，不是本次判断。\n```\n\n后续说明仍属于同一段答复。",
    ),
  ];
  const code = buildProcessStory(task);
  assert.equal(code.entries.length, 1);
  assert.equal(code.entries[0]!.kind, "result");
  assert.match(code.entries[0]!.content, /后续说明/);
});
