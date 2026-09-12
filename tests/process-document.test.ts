import test from "node:test";
import assert from "node:assert/strict";
import { buildProcessDocument } from "../src/core/process-document.js";
import type { Task, TaskEvent } from "../src/shared/types.js";
function event(
  type: string,
  summary: string,
  data: Record<string, unknown> = {},
  member: TaskEvent["member"] = "researcher",
  goalVersion = 2,
): TaskEvent {
  return {
    id: `${type}-${summary}`,
    type,
    summary,
    data,
    member,
    goalVersion,
    createdAt: "2026-09-11T12:00:00Z",
  };
}
function fixture(): Task {
  return {
    id: "task",
    title: "阅读整理",
    goal: "对照资料核查产品需求",
    goalVersion: 2,
    kind: "research",
    member: "coordinator",
    workspace: "/private/path",
    status: "completed",
    createdAt: "",
    updatedAt: "",
    messages: [
      {
        id: "m",
        member: "coordinator",
        role: "assistant",
        content: "PRIVATE_ASSISTANT_BODY",
        createdAt: "",
        goalVersion: 2,
      },
    ],
    sources: [
      {
        id: "source",
        title: "需求笔记",
        type: "text",
        text: "PRIVATE_SOURCE_BODY",
        location: "",
        coverage: "全文已导入",
        addedAt: "",
      },
    ],
    artifacts: [
      {
        id: "report",
        title: "需求核查结果",
        path: "/private/report.md",
        hash: "PRIVATE_HASH",
        version: 3,
        format: "md",
        goalVersion: 2,
        content: "PRIVATE_ARTIFACT_BODY",
        updatedAt: "",
        versions: [],
      },
    ],
    events: [],
  };
}
test("process document summarizes only allowlisted public evidence for the current goal", () => {
  const task = fixture();
  task.events = [
    event(
      "progress_reported",
      "OLD_GOAL_SECRET",
      { stage: "finding" },
      "researcher",
      1,
    ),
    event("raw_model_stream_event", "RAW_REASONING_SECRET", {
      reasoning: "RAW_PAYLOAD_SECRET",
    }),
    event("tool_completed", "PROTOCOL_DUMP_SECRET", {
      tool: "read_source",
      sourceId: "source",
      result: "RAW_TOOL_RESULT_SECRET",
    }),
    event("progress_reported", "确认三项需求仍待用户取舍。", {
      stage: "finding",
      sourceIds: ["source"],
      artifactIds: ["report"],
      content: "RAW_CONTENT_SECRET",
      reasoning: "PRIVATE_REASONING_SECRET",
      request: "RAW_REQUEST_SECRET",
    }),
    event("artifact_written", "保存结果", {
      artifactId: "report",
      operationId: "PRIVATE_OPERATION",
      hash: "PRIVATE_HASH",
    }),
    event("agent_completed", "PROTOCOL_STATUS_SECRET"),
  ];
  const { content, title } = buildProcessDocument(task);
  assert.match(title, /团队过程摘要/);
  assert.match(content, /确认三项需求/);
  assert.match(content, /研究员已阅读资料《需求笔记》/);
  assert.match(content, /已读取正文片段/);
  assert.match(content, /需求核查结果/);
  assert.doesNotMatch(
    content,
    /SECRET|PRIVATE_|read_source|operationId|reasoning|\/private/,
  );
});
test("process document scopes a single member invocation and does not call incomplete work successful", () => {
  const task = fixture();
  task.events = [
    event(
      "progress_reported",
      "其他成员摘要",
      { invocationId: "parent" },
      "coordinator",
    ),
    event("progress_reported", "同成员其他轮次", { invocationId: "other" }),
    event("progress_reported", "当前仍缺少公开证据", {
      invocationId: "selected",
      stage: "decision",
    }),
    event("tool_failed", "technical failure", {
      invocationId: "selected",
      tool: "read_source",
      sourceId: "source",
    }),
    event("agent_failed", "technical failure", { invocationId: "selected" }),
  ];
  const { content } = buildProcessDocument(task, "researcher", {
    invocationId: "selected",
  });
  assert.match(content, /当前仍缺少公开证据/);
  assert.match(content, /研究员未完成阅读资料/);
  assert.match(content, /未记录读取完成/);
  assert.doesNotMatch(content, /其他成员摘要|同成员其他轮次|已读取正文片段/);
});
test("empty current-goal process document is explicit and public report Markdown is treated as text", () => {
  const task = fixture();
  assert.match(buildProcessDocument(task).content, /尚无可整理/);
  task.events.push(
    event("progress_reported", "<script>unsafe</script>\n# pretend heading", {
      stage: "plan",
    }),
  );
  const { content } = buildProcessDocument(task);
  assert.match(content, /\\<script\\>/);
  assert.doesNotMatch(content, /\n# pretend heading/);
});

test("saved process document keeps structured public analysis and actual member conversation", () => {
  const task = fixture();
  task.events = [
    event("progress_reported", "需要考虑离线使用边界。", { stage: "framing" }),
    event("progress_reported", "方案甲更适合离线使用，代价是维护本地存储。", {
      stage: "alternatives",
    }),
    event("delegation_completed", "收到协作回复", {
      callId: "peer",
      invocationId: "main",
      receiver: "cto",
      request: "核查本地存储。",
      result: "现有资料支持本地方案。",
      reasoning: "PRIVATE_CHAIN",
      providerData: "PRIVATE_PAYLOAD",
    }),
  ];
  const document = buildProcessDocument(task).content;
  assert.match(document, /### 问题理解与计划/);
  assert.match(document, /### 方案与取舍/);
  assert.match(document, /## 成员对话/);
  assert.match(document, /核查本地存储/);
  assert.match(document, /现有资料支持本地方案/);
  assert.doesNotMatch(document, /PRIVATE_/);
});
