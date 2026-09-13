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
        content: "面向用户的实际答复：仍需核查适用条件。",
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
    event("skill_loaded", "已提供交接方法", {
      skillId: "handoff-review",
      name: "交接检查",
      version: "1.0.0",
      hash: "a".repeat(64),
      instructions: "PRIVATE_METHOD_BODY",
    }),
    event("agent_completed", "PROTOCOL_STATUS_SECRET"),
  ];
  const { content, title } = buildProcessDocument(task, undefined, {
    scope: "goal",
  });
  assert.match(title, /团队过程总结/);
  assert.match(content, /确认三项需求/);
  assert.match(content, /实际读取记录/);
  assert.match(content, /需求笔记：已读取/);
  assert.match(content, /需求核查结果/);
  assert.match(content, /交接检查 · 版本 1\.0\.0/);
  assert.match(content, /这里只记录方法正文已提供/);
  assert.doesNotMatch(
    content.replaceAll("\\_", "_"),
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
  assert.match(content, /资料读取有失败记录/);
  assert.match(content, /未能读取/);
  assert.doesNotMatch(content, /其他成员摘要|同成员其他轮次|已读取正文片段/);
});
test("empty current-goal process document is explicit and public report Markdown is treated as text", () => {
  const task = fixture();
  task.messages = [];
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
  assert.match(document, /问题理解 · 当时的公开分析/);
  assert.match(document, /方案与取舍 · 当时的公开分析/);
  assert.match(document, /实际公开答复 · CTO/);
  assert.match(document, /成员实际回复/);
  assert.match(document, /核查本地存储/);
  assert.match(document, /现有资料支持本地方案/);
  assert.doesNotMatch(document, /PRIVATE_/);
});

test("saved summary has a compact work title and shows the actual project request first", () => {
  const task = fixture();
  task.title =
    "核对正式产品定义并整理真实开发边界与本轮需要继续推进的具体工作事项".repeat(
      3,
    );
  const request =
    "核查离线阅读是否可用。\n我的问题：这行属于用户原文。\n用户要推进的工作：这行也要保留。";
  task.goal = `围绕本机项目「阅读工具」推进工作。\n项目 ID：reader；目录：/project-context-only\n工程上下文与处理约束。\n用户要推进的工作：${request}`;
  task.messages.unshift({
    id: "original-goal",
    role: "user",
    member: "coordinator",
    content: task.goal,
    createdAt: "",
    goalVersion: task.goalVersion,
  });
  const { title, content } = buildProcessDocument(task);
  assert.equal(Array.from(title.split(" · ")[0]!).length, 32);
  assert.match(title, /… · 团队过程总结$/);
  assert.equal(content.split("\n")[0], `# ${title}`);
  const opening = content.split("## 分析与解决历程")[0]!;
  assert.match(opening, /核查离线阅读是否可用/);
  assert.match(opening, /我的问题：这行属于用户原文/);
  assert.match(opening, /用户要推进的工作：这行也要保留/);
  assert.doesNotMatch(opening, /project-context-only|工程上下文|围绕本机项目/);
  assert.match(
    content.split("## 分析与解决历程")[1]!,
    /project-context-only|工程上下文/,
  );

  task.title = "📚".repeat(40);
  assert.equal(
    buildProcessDocument(task).title,
    `${"📚".repeat(31)}… · 团队过程总结`,
  );
});

test("project question extraction respects legacy boundaries without stripping direct input", () => {
  const task = fixture();
  task.messages = [];
  for (const goal of [
    "围绕本机项目「工具」讨论。\r\n项目 ID：tool\r\n我的问题：保留旧问题。",
    "围绕本机项目讨论。我的问题：保留旧问题。",
  ]) {
    task.goal = goal;
    const content = buildProcessDocument(task).content;
    assert.match(content, /> 保留旧问题。/);
    assert.doesNotMatch(content, /围绕本机项目|项目 ID/);
  }
  task.goal = "请解释这段模板。\n用户要推进的工作：不应删除用户前文。";
  assert.match(buildProcessDocument(task).content, /> 请解释这段模板。/);
  task.goal =
    "围绕本机项目讨论。我的问题：保留最早的问题。\n用户要推进的工作：这只是原文补充。";
  assert.match(buildProcessDocument(task).content, /> 保留最早的问题。/);
  assert.match(
    buildProcessDocument(task).content,
    /> 用户要推进的工作：这只是原文补充。/,
  );
  task.goal = "围绕本机项目推进工作，尚未指定具体问题。";
  assert.match(buildProcessDocument(task).content, /尚未指定具体问题/);
});

test("review foregrounds concrete corrections and keeps each long public original once later", () => {
  const task = fixture();
  task.messages = [];
  const correction = `错误是把扫描记录当成正文阅读。${"必须实际读取并核查资料的适用条件。".repeat(60)}纠正依据结尾。`;
  const good = `做得好的是先验证离线边界。${"逐条对照证据并列出未知。".repeat(60)}有效做法原文结尾。`;
  const third = "值得保留的第三项评价不能被摘要丢弃。";
  const fourth = "值得保留的第四项评价仍有完整依据。";
  task.events = [
    event("tool_failed", "读取失败", {
      tool: "read_source",
      sourceId: "source",
    }),
    event("progress_reported", "核查方法记录。", { stage: "method" }),
    event("public_response", "公开答复", {
      content: `# 哪里不对\n${correction}\n# 做得好\n${good}\n# 可取之处\n${third}\n# 优点\n${fourth}`,
    }),
  ];
  const content = buildProcessDocument(task).content;
  const review = content
    .split("## 复盘归纳")[1]!
    .split("## 分析与解决历程")[0]!;
  assert.ok(review.length < 1800, `review length ${review.length}`);
  assert.ok(
    review.indexOf("错误是把扫描记录") < review.indexOf("资料读取有失败记录"),
  );
  assert.ok(review.indexOf("做得好的是先验证") >= 0);
  assert.doesNotMatch(review, /纠正依据结尾|有效做法原文结尾/);
  assert.match(review, /另有 2 条相关记录/);
  assert.match(review, /〔依据 \d+〕/);
  assert.equal(content.split(correction).length - 1, 1);
  assert.equal(content.split(good).length - 1, 1);
  assert.match(
    content.split("## 分析与解决历程")[1]!,
    /第三项评价不能被摘要丢弃|第四项评价仍有完整依据/,
  );
});

test("abbreviated methods and both compared positions keep their exact supporting text", () => {
  const task = fixture();
  task.messages = [];
  const method = `先逐条检查引用。${"每项结论须回到材料核对。".repeat(70)}方法全文结尾。`;
  const earlier = `较早认为适合在线。${"早期依据有限。".repeat(100)}`;
  const later = `后续认为离线更合适。${"新材料支持离线。".repeat(100)}`;
  task.events = [
    event("progress_reported", "已明确核查办法。", { stage: "method", method }),
    event("progress_reported", earlier, { stage: "decision" }),
    event("progress_reported", later, { stage: "decision" }),
  ];
  const content = buildProcessDocument(task).content;
  const review = content
    .split("## 复盘归纳")[1]!
    .split("## 分析与解决历程")[0]!;
  assert.match(review, /较早认为适合在线/);
  assert.match(review, /后续认为离线更合适/);
  assert.doesNotMatch(review, /方法全文结尾/);
  assert.match(content, /## 复盘依据补充/);
  assert.equal(content.split(method).length - 1, 1);
  assert.equal(content.split(earlier).length - 1, 1);
  assert.equal(content.split(later).length - 1, 1);
});
