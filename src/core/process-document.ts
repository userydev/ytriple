import type { MemberId, Task, TaskEvent } from "../shared/types.js";
import {
  ANALYSIS_SECTIONS,
  buildPublicExchanges,
  buildProcessSources,
  publicReportDetails,
  publicSearchQueries,
  publicAnalysisSection,
  SOURCE_STATUS_NAMES,
} from "../shared/progress.js";

const labels: Record<MemberId, string> = {
  coordinator: "统筹",
  cto: "CTO",
  researcher: "研究员",
};
const stages: Record<string, string> = {
  framing: "问题理解",
  method: "方法",
  plan: "计划",
  evidence: "依据",
  finding: "发现",
  alternatives: "方案取舍",
  decision: "判断",
};
const statuses: Record<Task["status"], string> = {
  idle: "尚未开始",
  running: "进行中",
  waiting: "等待补充",
  paused: "已暂停",
  failed: "需要处理",
  completed: "已完成",
};
const tools: Record<string, string> = {
  list_materials: "查看资料目录",
  read_source: "阅读资料",
  read_artifact: "阅读成果",
  write_artifact: "保存成果",
  report_progress: "汇报进展",
  request_clarification: "提出需要补充的信息",
};
const publicTypes = new Set([
  "progress_reported",
  "clarification_requested",
  "agent_started",
  "agent_resumed",
  "agent_completed",
  "agent_paused",
  "agent_failed",
  "agent_waiting",
  "tool_started",
  "tool_resumed",
  "tool_completed",
  "tool_paused",
  "tool_failed",
  "delegation_started",
  "delegation_resumed",
  "delegation_completed",
  "delegation_paused",
  "delegation_failed",
  "artifact_written",
  "run_started",
  "run_resumed",
  "run_completed",
  "run_paused",
  "run_failed",
  "run_waiting",
]);
function plain(value: string, limit = 1200): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .trim()
    .slice(0, limit)
    .replace(/[\\`*_{}\[\]<>#|]/g, "\\$&")
    .replace(/\r?\n/g, " ");
}
const memberLabel = (member: unknown) =>
  typeof member === "string" && member in labels
    ? labels[member as MemberId]
    : "团队";
const eventType = (event: TaskEvent) => event.type.replaceAll(".", "_");
function distinct(items: string[], limit = 30): string[] {
  return [...new Set(items)].slice(-limit);
}
function reportLines(event: TaskEvent): string[] {
  const { detail, method, questions } = publicReportDetails(event);
  const lines = [
    `- **${memberLabel(event.member)} · ${event.data?.hosted === true ? "Google 公开摘要" : (stages[String(event.data?.stage)] ?? "进展")}**：${plain(event.summary)}`,
  ];
  if (method) lines.push("", `  **核查方法**：${plain(method, 2000)}`);
  if (detail && detail !== event.summary)
    lines.push(
      "",
      "  **展开说明**：",
      "",
      ...detail.split(/\r?\n/).map((line) => `  > ${plain(line, 6000)}`),
    );
  if (questions.length)
    lines.push(
      "",
      `  **仍待解决**：${questions.map((question) => plain(question, 300)).join("；")}`,
    );
  return lines;
}

/** Summarize only named public fields; SDK state, raw payloads and tool bodies never enter the document. */
export function buildProcessDocument(
  task: Task,
  member?: MemberId,
  options: { invocationId?: string } = {},
): { title: string; content: string } {
  const events = task.events.filter(
    (event) =>
      event.goalVersion === task.goalVersion &&
      (!member || event.member === member) &&
      (!options.invocationId ||
        event.data?.invocationId === options.invocationId) &&
      publicTypes.has(eventType(event)),
  );
  const scope = member ? labels[member] : "团队";
  const title = `${task.title.slice(0, 100)} · ${scope}过程摘要`;
  const lines = [
    `# ${plain(title, 160)}`,
    "",
    `目标版本：${task.goalVersion} · 范围：${scope} · 任务状态：${statuses[task.status]}`,
    "",
    "## 当前目标",
    "",
    plain(task.goal, 6000),
    "",
  ];
  if (!events.length) {
    lines.push("## 记录情况", "", "当前目标版本尚无可整理的公开工作记录。", "");
    return { title, content: lines.join("\n") };
  }
  const reports = events.filter(
    (event) => eventType(event) === "progress_reported",
  );
  lines.push("## 工作摘要", "");
  if (reports.length) {
    for (const section of ANALYSIS_SECTIONS) {
      const entries = reports.filter(
        (event) => publicAnalysisSection(event) === section.id,
      );
      if (entries.length)
        lines.push(
          `### ${section.title}`,
          "",
          ...entries.slice(-30).flatMap(reportLines),
          "",
        );
    }
    const uncategorized = reports.filter(
      (event) => !publicAnalysisSection(event),
    );
    if (uncategorized.length)
      lines.push(
        "### 其他公开进展",
        "",
        ...distinct(
          uncategorized.map(
            (event) =>
              `- **${memberLabel(event.member)}**：${plain(event.summary)}`,
          ),
        ),
        "",
      );
  } else {
    lines.push(
      "尚未记录成员的计划、发现或判断摘要；以下按实际执行记录整理。",
      "",
    );
  }
  const exchanges = buildPublicExchanges(events, task.status);
  if (exchanges.length) {
    lines.push(
      "## 成员对话",
      "",
      "以下为实际委派与回复，较长内容可能是运行时保留的节选。",
      "",
    );
    for (const exchange of exchanges.slice(-20)) {
      lines.push(
        `### ${memberLabel(exchange.sender)} → ${exchange.specialist ? "专项成员" : memberLabel(exchange.receiver)}`,
        "",
      );
      if (exchange.request)
        lines.push(`- **委派**：${plain(exchange.request, 4000)}`);
      if (exchange.response)
        lines.push(`- **回复**：${plain(exchange.response, 12000)}`);
      else
        lines.push(
          `- ${exchange.status === "running" ? "尚在等待回复。" : "此记录没有保留回复正文。"}`,
        );
      lines.push("");
    }
  }
  const processSources = buildProcessSources(task, events);
  const queries = publicSearchQueries(events);
  if (queries.length)
    lines.push(
      "## 实际检索词",
      "",
      ...queries.slice(-40).map((query) => `- ${plain(query, 1000)}`),
      "",
    );
  if (processSources.length) {
    lines.push(
      "## 核查资料与网站",
      "",
      "搜索结果和引用来源不等于已访问；读取状态依据实际工具或服务商记录。",
      "",
    );
    for (const source of processSources.slice(-100)) {
      const label = plain(source.title, 200);
      lines.push(
        `- **${source.url ? `[${label}](${source.url.replace(/[()<>]/g, (char) => "%" + char.charCodeAt(0).toString(16))})` : label}** · ${SOURCE_STATUS_NAMES[source.status]} · ${source.origin === "google" ? "Google 返回" : "任务资料"}`,
      );
      if (source.snippet) lines.push(`  ${plain(source.snippet, 1600)}`);
    }
    lines.push("");
  }
  const questions = distinct(
    events
      .filter((event) => eventType(event) === "clarification_requested")
      .map(
        (event) => `- ${memberLabel(event.member)}：${plain(event.summary)}`,
      ),
    12,
  );
  if (questions.length) lines.push("## 需要补充的信息", "", ...questions, "");
  const actions: string[] = [];
  const sourceIds = new Set<string>();
  const readSourceIds = new Set<string>();
  const artifactIds = new Set<string>();
  const writtenIds = new Set<string>();
  for (const event of events) {
    const type = eventType(event),
      data = event.data ?? {},
      who = memberLabel(event.member);
    if (type === "progress_reported") {
      if (Array.isArray(data.sourceIds))
        for (const id of data.sourceIds)
          if (typeof id === "string") sourceIds.add(id);
      if (Array.isArray(data.artifactIds))
        for (const id of data.artifactIds)
          if (typeof id === "string") artifactIds.add(id);
    }
    if (typeof data.sourceId === "string") {
      sourceIds.add(data.sourceId);
      if (type === "tool_completed" && data.tool === "read_source")
        readSourceIds.add(data.sourceId);
    }
    if (typeof data.artifactId === "string") artifactIds.add(data.artifactId);
    if (type === "artifact_written" && typeof data.artifactId === "string")
      writtenIds.add(data.artifactId);
    if (/^agent_(completed|paused|failed|waiting)$/.test(type)) {
      const action = type.endsWith("_completed")
        ? "完成本次处理"
        : type.endsWith("_paused")
          ? "暂停并保留进度"
          : type.endsWith("_waiting")
            ? "等待补充信息"
            : "本次处理未完成";
      actions.push(`- ${who}${action}。`);
    }
    if (/^delegation_(started|completed|paused|failed)$/.test(type)) {
      const receiver =
        data.specialist === true ? "专项成员" : memberLabel(data.receiver);
      const action = type.endsWith("_started")
        ? `将具体工作交给${receiver}`
        : type.endsWith("_completed")
          ? `收到${receiver}的协作结果`
          : type.endsWith("_paused")
            ? `暂停与${receiver}的协作`
            : `与${receiver}的协作未完成`;
      actions.push(`- ${who}${action}。`);
    }
    if (
      /^tool_(completed|paused|failed)$/.test(type) &&
      typeof data.tool === "string" &&
      tools[data.tool]
    ) {
      const action = tools[data.tool];
      const result = type.endsWith("_completed")
        ? `已${action}`
        : type.endsWith("_paused")
          ? `暂停${action}`
          : `未完成${action}`;
      const source =
        typeof data.sourceId === "string"
          ? task.sources.find((entry) => entry.id === data.sourceId)
          : undefined;
      const artifact =
        typeof data.artifactId === "string"
          ? task.artifacts.find((entry) => entry.id === data.artifactId)
          : undefined;
      actions.push(
        `- ${who}${result}${source || artifact ? `《${plain((source ?? artifact)!.title, 180)}》` : ""}。`,
      );
    }
  }
  if (actions.length)
    lines.push("## 已记录的工作", "", ...distinct(actions, 40), "");
  const sources = task.sources.filter((source) => sourceIds.has(source.id));
  if (sources.length)
    lines.push(
      "## 资料依据",
      "",
      ...sources
        .slice(0, 30)
        .map(
          (source) =>
            `- **${plain(source.title, 180)}**：${readSourceIds.has(source.id) ? "已读取正文片段" : "公开摘要中提及，未记录读取完成"}。${plain(source.coverage, 500)}`,
        ),
      "",
    );
  const artifacts = task.artifacts.filter((artifact) =>
    artifactIds.has(artifact.id),
  );
  if (artifacts.length)
    lines.push(
      "## 相关成果",
      "",
      ...artifacts
        .slice(0, 30)
        .map(
          (artifact) =>
            `- **${plain(artifact.title, 180)}**：${writtenIds.has(artifact.id) ? "本轮保存过的成果" : "本轮引用的成果"}，当前为第 ${artifact.version} 版。`,
        ),
      "",
    );
  if (options.invocationId)
    lines.push("本摘要限于选定成员本次处理的公开记录。", "");
  lines.push("摘要依据本目标版本的公开工作记录整理，可继续编辑和补充。", "");
  return { title, content: lines.join("\n") };
}
