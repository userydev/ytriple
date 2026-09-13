import type { MemberId, Task } from "../shared/types.js";
import {
  buildProcessStory,
  type ProcessObservation,
  type ProcessReference,
  type ProcessStoryOptions,
} from "../shared/process-story.js";
import {
  buildProcessSources,
  currentProgressEvents,
  publicSearchQueries,
  SOURCE_STATUS_NAMES,
} from "../shared/progress.js";

const labels: Record<MemberId, string> = {
  coordinator: "统筹",
  cto: "CTO",
  researcher: "研究员",
  editor: "内容编辑",
};
const kindNames = {
  framing: "问题理解",
  method: "核查方法",
  evidence: "依据与发现",
  comparison: "方案与取舍",
  decision: "判断",
  revision: "修正",
  result: "结果",
  question: "待解决",
};
const origins = {
  public_report: "当时的公开分析",
  public_reply: "实际公开答复",
  user_request: "用户原始要求",
  revision_record: "已保存的变化记录",
};
function plain(value: string, limit = 120_000): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .trim()
    .slice(0, limit)
    .replace(/[\\`*_{}\[\]<>#|]/g, "\\$&");
}
const quoted = (value: string) =>
  value.split(/\r?\n/).map((line) => `> ${plain(line)}`);
const key = (ref: ProcessReference) =>
  `${ref.kind}:${ref.id}:${ref.version ?? ""}:${ref.hash ?? ""}:${ref.readStart ?? ""}:${ref.readEnd ?? ""}`;
const compact = (value: string, limit: number) => {
  const characters = Array.from(value.replace(/\s+/g, " ").trim());
  return characters.length > limit
    ? `${characters.slice(0, limit - 1).join("")}…`
    : characters.join("");
};
function readableGoal(goal: string): string {
  if (goal.startsWith("围绕本机项目")) {
    const boundary = /\r?\n(?:用户要推进的工作|我的问题)：/.exec(goal);
    const legacy = goal.indexOf("我的问题：");
    if (legacy >= 0 && (!boundary || legacy < boundary.index))
      return goal.slice(legacy + "我的问题：".length).trim() || goal;
    if (boundary)
      return goal.slice(boundary.index + boundary[0].length).trim() || goal;
  }
  return goal.trim();
}
function reviewExcerpt(item: ProcessObservation): string {
  // Keep both actual positions visible when the review compares judgments.
  if (item.id === "judgments-recorded") {
    const later = item.text.indexOf("\n后来记录的判断：");
    const end = item.text.lastIndexOf("\n这两项表述可对照；");
    if (later > 0)
      return `${compact(item.text.slice(0, later), 100)}\n${compact(item.text.slice(later, end > later ? end : undefined), 100)}`;
  }
  return compact(item.text, 200);
}

/** Use the same evidence-backed story as the UI. This is a deterministic review
 * of public statements, not another model's reconstruction of hidden thoughts. */
export function buildProcessDocument(
  task: Task,
  member?: MemberId,
  options: ProcessStoryOptions = {},
): { title: string; content: string } {
  const story = buildProcessStory(task, {
    ...options,
    member: member ?? options.member,
  });
  const scope = member ? labels[member] : "团队";
  const title = `${compact(task.title, 32) || "工作"} · ${scope}过程总结`;
  const refs: ProcessReference[] = [];
  const cite = (references: ProcessReference[]) =>
    [
      ...new Set(
        references.map((ref) => {
          let index = refs.findIndex((existing) => key(existing) === key(ref));
          if (index < 0) {
            index = refs.length;
            refs.push(ref);
          }
          return `〔依据 ${index + 1}〕`;
        }),
      ),
    ].join(" ");
  const range =
    options.scope === "goal"
      ? `当前目标 v${task.goalVersion}`
      : options.scope === "run"
        ? `当前目标 v${task.goalVersion} 的本次处理`
        : "全部保留历程";
  const lines = [
    `# ${plain(title, 180)}`,
    "",
    `范围：${range} · 成员：${scope}`,
    "",
    "## 当前要解决的问题",
    "",
    ...quoted(readableGoal(task.goal)),
    "",
    story.coverage.notice,
    "",
  ];
  if (
    !story.entries.length &&
    !Object.values(story.review).some((items) => items.length)
  ) {
    lines.push(
      "当前范围尚无可整理的公开分析或答复。工具记录不能代替当时的判断依据。",
      "",
    );
    return { title, content: lines.join("\n") };
  }
  const prioritize = (items: ProcessObservation[], prefixes: string[]) =>
    [...items].sort((a, b) => {
      const rank = (item: ProcessObservation) => {
        const index = prefixes.findIndex((prefix) =>
          item.id.startsWith(prefix),
        );
        return index < 0 ? prefixes.length : index;
      };
      return rank(a) - rank(b);
    });
  const reviewGroups = [
    [
      "问题与修正要求",
      prioritize(story.review.issues, ["requested:", "acknowledged:"]),
    ],
    [
      "判断变化与可复核做法",
      prioritize(story.review.effective, [
        "stated:",
        "judgments-recorded",
        "method:",
      ]),
    ],
    ["待解决与未验证点", story.review.unverified],
  ] as const;
  const supplemental: ProcessObservation[] = [];
  if (reviewGroups.some(([, items]) => items.length)) {
    lines.push(
      "## 复盘归纳",
      "",
      "以下摘录具体问题、做法与待核查事项；完整公开原文保留在后文历程及依据中。",
      "",
    );
    for (const [label, items] of reviewGroups) {
      if (!items.length) continue;
      lines.push(`### ${label}`, "");
      for (const [index, item] of items.entries()) {
        cite(item.references);
        const citation = cite(item.references.slice(0, 3));
        const excerpt = reviewExcerpt(item);
        if (index < 2)
          lines.push(
            ...quoted(excerpt),
            "",
            `${citation}${item.references.length > 3 ? " 等；完整依据见索引。" : ""}`,
            "",
          );
        // These observations quote an existing story entry; preserve that full
        // original once in the chronology instead of copying it into the review.
        const originalInStory =
          item.id === "judgments-recorded" ||
          story.entries.some(
            (entry) =>
              item.id.endsWith(`:${entry.id}`) ||
              entry.content.includes(item.text),
          );
        if ((index >= 2 || excerpt !== item.text) && !originalInStory)
          supplemental.push(item);
      }
      if (items.length > 2)
        lines.push(
          `另有 ${items.length - 2} 条相关记录，见后文历程与依据。`,
          "",
        );
    }
  }
  lines.push("## 分析与解决历程", "");
  if (!story.entries.length)
    lines.push(
      "当前范围未保留可回看的公开分析；以上执行问题不能代替判断依据。",
      "",
    );
  let goalVersion: number | undefined;
  for (const entry of story.entries) {
    if (goalVersion !== entry.goalVersion) {
      goalVersion = entry.goalVersion;
      lines.push(`### 目标记录 v${goalVersion}`, "");
    }
    lines.push(
      `#### ${plain(entry.title, 140)}`,
      "",
      `${kindNames[entry.kind]} · ${entry.interaction === "request" ? "成员委派的问题" : origins[entry.provenance]}${entry.member ? ` · ${labels[entry.member]}` : ""}${entry.createdAt ? ` · ${plain(entry.createdAt, 80)}` : ""}`,
      "",
      ...quoted(entry.content),
      "",
      cite(entry.references),
      "",
    );
    if (entry.truncated)
      lines.push("原始记录为节选，未保留的内容不作推断。", "");
  }
  if (supplemental.length) {
    lines.push("## 复盘依据补充", "");
    for (const item of supplemental)
      lines.push(...quoted(item.text), "", cite(item.references), "");
  }
  if (refs.length) {
    lines.push("## 依据索引", "");
    for (const [index, ref] of refs.entries()) {
      const description =
        ref.kind === "source"
          ? "资料"
          : ref.kind === "artifact"
            ? "成果"
            : ref.kind === "message"
              ? "对话"
              : "公开事件";
      lines.push(
        `### 依据 ${index + 1}`,
        "",
        `${description}：${plain(ref.label, 500)}${ref.goalVersion ? ` · 目标 v${ref.goalVersion}` : ""}${ref.version ? ` · 成果 v${ref.version}` : ""}`,
      );
      if (ref.kind === "artifact" && !ref.version)
        lines.push("该次引用没有保留版本号，不能用当前版本冒充。");
      if (ref.readStart !== undefined && ref.readEnd !== undefined)
        lines.push(
          `真实读取范围：第 ${ref.readStart + 1} 至 ${ref.readEnd} 字符。`,
        );
      if (ref.coverage) lines.push(plain(ref.coverage, 1200));
      if (ref.hash && /^[a-f0-9]{64}$/i.test(ref.hash))
        lines.push(`内容标识：${ref.hash}`);
      lines.push("");
    }
  }
  const currentRun =
    options.scope === "run"
      ? new Set(currentProgressEvents(task).map((event) => event.id))
      : undefined;
  const events = task.events.filter(
    (event) =>
      (!options.scope ||
        options.scope === "all" ||
        event.goalVersion === task.goalVersion) &&
      (!currentRun || currentRun.has(event.id)) &&
      (!member || event.member === member) &&
      (!options.invocationId ||
        event.data?.invocationId === options.invocationId),
  );
  const methods = events.filter((event) => event.type === "skill_loaded");
  if (methods.length)
    lines.push(
      "## 已提供的方法版本",
      "",
      ...methods.map(
        (event) =>
          `- ${plain(String(event.data?.name ?? event.data?.skillId ?? "方法"), 180)} · 版本 ${plain(String(event.data?.version ?? "未记录"), 80)}。`,
      ),
      "",
      "这里只记录方法正文已提供，是否有用以分析、结果及反馈为准。",
      "",
    );
  const queries = publicSearchQueries(events);
  if (queries.length)
    lines.push(
      "## 实际检索词",
      "",
      ...queries.map((query) => `- ${plain(query, 1000)}`),
      "",
    );
  const sources = buildProcessSources(task, events);
  if (sources.length)
    lines.push(
      "## 所引资料的覆盖",
      "",
      ...sources.map(
        (source) =>
          `- ${plain(source.title, 180)}${source.url ? `（${source.url}）` : ""}：${SOURCE_STATUS_NAMES[source.status]}。${plain(source.snippet ?? "", 1200)}`,
      ),
      "",
    );
  return { title, content: lines.join("\n") };
}
