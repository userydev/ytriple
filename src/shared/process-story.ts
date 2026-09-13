import type { MemberId, Task, TaskEvent } from "./types.js";
import {
  currentProgressEvents,
  publicAnalysisSection,
  publicReportDetails,
} from "./progress.js";

export type ProcessStoryKind =
  | "framing"
  | "method"
  | "evidence"
  | "comparison"
  | "decision"
  | "revision"
  | "result"
  | "question";
export interface ProcessReference {
  kind: "event" | "message" | "source" | "artifact";
  id: string;
  label: string;
  goalVersion?: number;
  version?: number;
  hash?: string;
  revisionId?: string;
  readStart?: number;
  readEnd?: number;
  coverage?: string;
}
export interface ProcessStoryEntry {
  id: string;
  kind: ProcessStoryKind;
  title: string;
  content: string;
  member?: MemberId;
  createdAt: string;
  goalVersion: number;
  provenance:
    "public_report" | "public_reply" | "user_request" | "revision_record";
  references: ProcessReference[];
  truncated?: boolean;
  interaction?: "request" | "reply";
}
export interface ProcessObservation {
  id: string;
  text: string;
  references: ProcessReference[];
}
export interface ProcessStoryOptions {
  scope?: "all" | "goal" | "run";
  member?: MemberId;
  invocationId?: string;
}
export interface ProcessStory {
  entries: ProcessStoryEntry[];
  review: {
    effective: ProcessObservation[];
    issues: ProcessObservation[];
    unverified: ProcessObservation[];
  };
  coverage: {
    reports: number;
    replies: number;
    revisions: number;
    notice: string;
  };
}
const text = (value: unknown, max = 120_000) =>
  typeof value === "string"
    ? value
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
        .trim()
        .slice(0, max)
    : "";
const typeOf = (event: TaskEvent) => event.type.replaceAll(".", "_");
const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const memberIds = new Set(["coordinator", "researcher", "cto", "editor"]);
const refKey = (ref: ProcessReference) =>
  `${ref.kind}:${ref.id}:${ref.version ?? ""}:${ref.hash ?? ""}:${ref.readStart ?? ""}:${ref.readEnd ?? ""}`;
const uniqueRefs = (refs: ProcessReference[]) => [
  ...new Map(refs.map((ref) => [refKey(ref), ref])).values(),
];
const eventRef = (event: TaskEvent): ProcessReference => {
  const type = typeOf(event);
  const operational: Record<string, string> = {
    tool_completed: "实际工具完成记录",
    tool_failed: "实际工具失败记录",
    run_failed: "本次执行失败记录",
    artifact_written: "成果保存记录",
    agent_completed: "成员公开答复记录",
    agent_waiting: "成员等待补充记录",
    delegation_completed: "成员实际回复",
    public_response: "自动保留的公开答复",
  };
  return {
    kind: "event",
    id: event.id,
    label: operational[type] ?? (text(event.summary, 180) || "公开记录"),
    goalVersion: event.goalVersion,
  };
};
function artifactRef(
  task: Task,
  id: string,
  data: Record<string, unknown> = {},
): ProcessReference | undefined {
  const artifact = task.artifacts.find((item) => item.id === id);
  if (!artifact) return;
  const version = number(data.version) ?? number(data.artifactVersion);
  const hash =
    text(data.hash, 160) || text(data.expectedHash, 160) || undefined;
  return { kind: "artifact", id, label: artifact.title, version, hash };
}
function sourceRef(
  task: Task,
  id: string,
  data: Record<string, unknown> = {},
): ProcessReference | undefined {
  const source = task.sources.find((item) => item.id === id);
  if (!source) return;
  return {
    kind: "source",
    id,
    label: source.title,
    hash: text(data.sourceHash, 160) || undefined,
    revisionId: text(data.revisionId, 240) || undefined,
    readStart: number(data.readStart),
    readEnd: number(data.readEnd),
    coverage:
      text(data.coverage, 1000) ||
      `${source.coverage}（当前资料范围；当时正文以读取记录为准）`,
  };
}
/** References never upgrade a mention to a completed read or substitute today's artifact version. */
function references(task: Task, event: TaskEvent): ProcessReference[] {
  const data = event.data ?? {};
  const refs: ProcessReference[] = [eventRef(event)];
  const prior = task.events
    .slice(0, task.events.indexOf(event) + 1)
    .filter(
      (item) =>
        item.goalVersion === event.goalVersion &&
        (!data.invocationId || item.data?.invocationId === data.invocationId),
    );
  const sourceIds = new Set(
    [
      ...(Array.isArray(data.sourceIds) ? data.sourceIds : []),
      data.sourceId,
    ].filter((id): id is string => typeof id === "string"),
  );
  for (const id of sourceIds) {
    const read = [...prior]
      .reverse()
      .find(
        (item) =>
          typeOf(item) === "tool_completed" &&
          item.data?.tool === "read_source" &&
          item.data.sourceId === id,
      );
    const ref = sourceRef(task, id, read?.data);
    if (ref) refs.push(ref);
  }
  const artifactIds = new Set(
    [
      ...(Array.isArray(data.artifactIds) ? data.artifactIds : []),
      data.artifactId,
    ].filter((id): id is string => typeof id === "string"),
  );
  for (const id of artifactIds) {
    const evidence = [...prior]
      .reverse()
      .find(
        (item) =>
          item.data?.artifactId === id &&
          (typeOf(item) === "artifact_written" ||
            (typeOf(item) === "tool_completed" &&
              item.data.tool === "read_artifact") ||
            item === event),
      );
    const ref = artifactRef(task, id, evidence?.data);
    if (ref) refs.push(ref);
  }
  return uniqueRefs(refs);
}
function titleOf(content: string, fallback: string) {
  return (
    text(
      content
        .split(/\r?\n/)
        .find((line) => line.trim())
        ?.replace(/^\s*(?:#{1,6}\s+|[-*>]+\s*)/, "")
        .replace(/\*\*/g, ""),
      90,
    ) || fallback
  );
}
function kindOf(heading: string, fallback: ProcessStoryKind): ProcessStoryKind {
  if (/修正|纠正|修订|改进|调整|纠偏|更正/.test(heading)) return "revision";
  if (/待解决|未解决|未验证|待核查|不确定|缺口|风险|问题|限制/.test(heading))
    return /理解.*问题|问题.*理解/.test(heading) ? "framing" : "question";
  if (/依据|证据|发现|来源|观察/.test(heading)) return "evidence";
  if (/比较|取舍|方案|对比|替代/.test(heading)) return "comparison";
  if (/判断|结论|建议|决定/.test(heading)) return "decision";
  if (/方法|核查路径|验证步骤/.test(heading)) return "method";
  if (/目标|理解|背景|计划/.test(heading)) return "framing";
  return fallback;
}
function publicSections(
  content: string,
): { title: string; content: string; kind: ProcessStoryKind }[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let fence: string | undefined;
  for (const line of content.split(/\r?\n/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
    if (marker) {
      if (!fence) fence = marker[0];
      else if (fence === marker[0]) fence = undefined;
    }
    if (!fence && /^#{1,6}\s+\S/.test(line) && current.length) {
      chunks.push(current.join("\n").trim());
      current = [];
    }
    current.push(line);
  }
  if (current.length) chunks.push(current.join("\n").trim());
  return chunks
    .filter(
      (part) =>
        part && (!/^#{1,6}\s+[^\n]+$/.test(part) || chunks.length === 1),
    )
    .map((part) => {
      const match = part.match(/^#{1,6}\s+(.+)(?:\r?\n|$)/);
      const title = match ? text(match[1], 120) : titleOf(part, "公开答复");
      return { title, content: part, kind: kindOf(title, "result") };
    });
}
/** Reconstruct from explicitly public fields. Tool payloads, model reasoning and
 * progress previews are never inputs. Classification labels are navigation only;
 * reply/report text remains the actual public text, not an invented inner monologue. */
export function buildProcessStory(
  task: Task,
  options: ProcessStoryOptions = {},
): ProcessStory {
  const runEvents =
    options.scope === "run"
      ? new Set(currentProgressEvents(task).map((event) => event.id))
      : undefined;
  const events = task.events.filter(
    (event) =>
      (!options.scope ||
        options.scope === "all" ||
        event.goalVersion === task.goalVersion) &&
      (!runEvents || runEvents.has(event.id)) &&
      (!options.member ||
        event.member === options.member ||
        event.data?.receiver === options.member) &&
      (!options.invocationId ||
        event.data?.invocationId === options.invocationId ||
        event.data?.childInvocationId === options.invocationId),
  );
  const entries: ProcessStoryEntry[] = [];
  const review: ProcessStory["review"] = {
    effective: [],
    issues: [],
    unverified: [],
  };
  const replyBodies = new Map<string, ProcessStoryEntry[]>();
  const addReply = (
    id: string,
    content: string,
    member: MemberId | undefined,
    createdAt: string,
    goalVersion: number,
    refs: ProcessReference[],
    truncated = false,
  ) => {
    if (!content) return;
    const key = `${goalVersion}:${member}:${content}`;
    const previous = replyBodies.get(key);
    if (previous) {
      for (const entry of previous)
        entry.references = uniqueRefs([...entry.references, ...refs]);
      return;
    }
    const parts = publicSections(content).map(
      (part, index): ProcessStoryEntry => ({
        ...part,
        id: `${id}:${index}`,
        member,
        createdAt,
        goalVersion,
        provenance: "public_reply",
        interaction: "reply",
        references: refs,
        truncated,
      }),
    );
    replyBodies.set(key, parts);
    entries.push(...parts);
  };
  let reports = 0,
    revisions = 0;
  const fullReplyInvocations = new Set(
    events
      .filter(
        (event) =>
          typeOf(event) === "public_response" &&
          typeof event.data?.invocationId === "string",
      )
      .map((event) => `${event.goalVersion}:${event.data?.invocationId}`),
  );
  const runStart =
    options.scope === "run"
      ? events.find((event) => /^run_(started|resumed)$/.test(typeOf(event)))
          ?.createdAt
      : undefined;
  const messages = task.messages.filter(
    (message) =>
      (!options.scope ||
        options.scope === "all" ||
        message.goalVersion === task.goalVersion) &&
      (!options.member || message.member === options.member) &&
      !options.invocationId &&
      (options.scope !== "run" ||
        Boolean(
          runStart && message.createdAt && message.createdAt >= runStart,
        )),
  );
  for (const message of messages) {
    const content = text(message.content);
    if (!content) continue;
    const ref: ProcessReference = {
      kind: "message",
      id: message.id,
      label: message.role === "user" ? "用户原始要求" : "向用户的实际答复",
      goalVersion: message.goalVersion,
    };
    if (message.role === "assistant")
      addReply(
        `message:${message.id}`,
        content,
        message.member,
        message.createdAt,
        message.goalVersion,
        [ref],
        message.content.length > 120_000,
      );
    else {
      const refinement = task.events.find(
        (event) =>
          event.goalVersion === message.goalVersion &&
          typeOf(event) === "artifact_refine_requested",
      );
      const correction =
        Boolean(refinement) ||
        /修订|修正|纠正|更正|改为|改成|不对|有误/.test(content);
      entries.push({
        id: `message:${message.id}`,
        kind: correction ? "revision" : "framing",
        title: titleOf(content, "用户提出的问题"),
        content,
        createdAt: message.createdAt,
        goalVersion: message.goalVersion,
        provenance: "user_request",
        references: uniqueRefs([
          ref,
          ...(refinement ? references(task, refinement) : []),
        ]),
      });
      if (correction) revisions++;
    }
  }
  const delegatedRequests = new Set<string>();
  for (const event of events) {
    const type = typeOf(event),
      data = event.data ?? {},
      refs = references(task, event);
    if (
      /^delegation_(started|completed)$/.test(type) &&
      typeof data.request === "string"
    ) {
      const requestKey = `${data.runId ?? event.goalVersion}:${data.invocationId ?? event.member}:${data.callId ?? event.id}`;
      if (!delegatedRequests.has(requestKey) && text(data.request)) {
        delegatedRequests.add(requestKey);
        entries.push({
          id: `request:${event.id}`,
          kind: "framing",
          title: titleOf(data.request, "成员委派的问题"),
          content: text(data.request, 4000),
          member: event.member,
          createdAt: event.createdAt,
          goalVersion: event.goalVersion,
          provenance: "public_reply",
          interaction: "request",
          references: refs,
          truncated: true,
        });
      }
    }
    if (type === "progress_reported" && publicAnalysisSection(event)) {
      const section = publicAnalysisSection(event)!;
      const detail = publicReportDetails(event);
      const kind: ProcessStoryKind =
        section === "alternatives"
          ? "comparison"
          : section === "provider"
            ? "evidence"
            : section;
      entries.push({
        id: `event:${event.id}`,
        kind,
        title: titleOf(event.summary, "公开分析"),
        content:
          detail.detail && detail.detail !== event.summary
            ? `${text(event.summary)}\n\n${detail.detail}`
            : text(event.summary),
        member: event.member,
        createdAt: event.createdAt,
        goalVersion: event.goalVersion,
        provenance: "public_report",
        references: refs,
      });
      reports++;
      if (detail.questions.length)
        for (const [index, question] of detail.questions.entries())
          review.unverified.push({
            id: `question:${event.id}:${index}`,
            text:
              event.goalVersion === task.goalVersion
                ? question
                : `当时待核查（目标 v${event.goalVersion}）：${question}`,
            references: refs,
          });
      if (kind === "method" || detail.method)
        review.effective.push({
          id: `method:${event.id}`,
          text: `记录的核查方法：${detail.method || event.summary}`,
          references: refs,
        });
    } else if (type === "public_response") {
      addReply(
        `event:${event.id}`,
        text(data.content),
        event.member,
        event.createdAt,
        event.goalVersion,
        refs,
        data.truncated === true,
      );
    } else if (
      (type === "agent_completed" || type === "agent_waiting") &&
      !fullReplyInvocations.has(`${event.goalVersion}:${data.invocationId}`)
    ) {
      const body = text(data.content);
      const matching = messages.find(
        (message) =>
          message.role === "assistant" &&
          message.member === event.member &&
          message.goalVersion === event.goalVersion &&
          text(message.content).startsWith(body.replace(/…$/, "")),
      );
      if (!matching)
        addReply(
          `event:${event.id}`,
          body,
          event.member,
          event.createdAt,
          event.goalVersion,
          refs,
          true,
        );
    } else if (
      type === "delegation_completed" &&
      typeof data.result === "string"
    ) {
      const receiver =
        typeof data.receiver === "string" && memberIds.has(data.receiver)
          ? (data.receiver as MemberId)
          : undefined;
      if (
        !fullReplyInvocations.has(
          `${event.goalVersion}:${data.childInvocationId}`,
        )
      )
        addReply(
          `event:${event.id}`,
          text(data.result),
          receiver,
          event.createdAt,
          event.goalVersion,
          refs,
          true,
        );
    } else if (
      type === "artifact_refine_requested" &&
      !messages.some(
        (message) =>
          message.role === "user" && message.goalVersion === event.goalVersion,
      )
    ) {
      const content = text(data.instruction);
      if (!content) continue;
      entries.push({
        id: `event:${event.id}`,
        kind: "revision",
        title: titleOf(content, "用户要求修订"),
        content,
        createdAt: event.createdAt,
        goalVersion: event.goalVersion,
        provenance: "user_request",
        references: refs,
      });
      revisions++;
    } else if (
      ["source_imported", "library_changed", "goal_changed"].includes(type)
    ) {
      const continuation =
        typeof data.continuedUserMessageId === "string"
          ? task.messages.find(
              (message) =>
                message.id === data.continuedUserMessageId &&
                message.role === "user",
            )
          : undefined;
      const linked = continuation
        ? [
            ...refs,
            {
              kind: "message" as const,
              id: continuation.id,
              label: "继续沿用的用户要求",
              goalVersion: continuation.goalVersion,
            },
          ]
        : refs;
      entries.push({
        id: `event:${event.id}`,
        kind: "revision",
        title: titleOf(event.summary, "可用依据发生变化"),
        content: `${text(event.summary)}\n\n${type === "source_imported" ? "新增资料改变了可用依据；导入本身不证明团队已读过或调整了判断。" : "这是一条输入变化记录；具体影响以之后的公开解释为准。"}`,
        member: event.member,
        createdAt: event.createdAt,
        goalVersion: event.goalVersion,
        provenance: "revision_record",
        references: linked,
      });
      revisions++;
    } else if (type === "clarification_requested") {
      entries.push({
        id: `event:${event.id}`,
        kind: "question",
        title: titleOf(event.summary, "需要补充"),
        content: text(event.summary),
        member: event.member,
        createdAt: event.createdAt,
        goalVersion: event.goalVersion,
        provenance: "public_report",
        references: refs,
      });
    } else if (type === "tool_failed" || type === "run_failed") {
      const tool =
        data.tool === "read_source"
          ? "资料读取"
          : data.tool === "read_artifact"
            ? "成果读取"
            : data.tool === "write_artifact"
              ? "成果保存"
              : "一次执行";
      review.issues.push({
        id: `failure:${event.id}`,
        text: `${tool}有失败记录；不能据此声称相应核查或交付完成。`,
        references: refs,
      });
    }
  }
  // Revisions are facts about the persisted object, never a fabricated explanation
  // of why an author changed their mind. Only explicit requests/replies supply why.
  const writes = events.filter(
    (event) =>
      typeOf(event) === "artifact_written" &&
      typeof event.data?.artifactId === "string",
  );
  for (const event of writes) {
    const ref = artifactRef(task, String(event.data?.artifactId), event.data);
    if (!ref) continue;
    const prior = task.events
      .slice(0, task.events.indexOf(event))
      .filter(
        (item) =>
          typeOf(item) === "artifact_written" &&
          item.data?.artifactId === ref.id,
      )
      .at(-1);
    const previous = number(prior?.data?.version);
    const content =
      previous && ref.version && ref.version > previous
        ? `《${ref.label}》从第 ${previous} 版保存为第 ${ref.version} 版。修订原因只以相邻的用户要求和公开解释为依据；版本记录本身不证明修正有效。`
        : `《${ref.label}》已保存${ref.version ? `第 ${ref.version} 版` : "（版本未记录）"}。这证明成果已形成，尚不能证明实际使用或效果。`;
    entries.push({
      id: `event:${event.id}`,
      kind: previous ? "revision" : "result",
      title: previous ? `《${ref.label}》的版本变化` : `形成《${ref.label}》`,
      content,
      member: event.member,
      createdAt: event.createdAt,
      goalVersion: event.goalVersion,
      provenance: "revision_record",
      references: references(task, event),
    });
    revisions++;
  }
  const eventOrder = new Map(
    task.events.map((event, index) => [event.id, index]),
  );
  const order = (entry: ProcessStoryEntry) => {
    const ids = entry.references
      .filter((ref) => ref.kind === "event")
      .map((ref) => eventOrder.get(ref.id))
      .filter((index): index is number => index !== undefined);
    return ids.length
      ? Math.min(...ids)
      : entry.provenance === "user_request"
        ? -1
        : task.events.length;
  };
  entries.sort(
    (a, b) =>
      a.goalVersion - b.goalVersion ||
      a.createdAt.localeCompare(b.createdAt) ||
      order(a) - order(b),
  );
  // Public assertions do not become verified conclusions merely because an Agent
  // or several members repeat them. Review statements cite the evidence boundary.
  const decisions = entries.filter(
    (entry) => entry.kind === "decision" || entry.kind === "comparison",
  );
  if (decisions.length) {
    const first = decisions[0]!,
      last = decisions.at(-1)!;
    if (first.id !== last.id && first.content !== last.content)
      review.effective.push({
        id: "judgments-recorded",
        text: `较早的公开判断：${text(first.content, 700)}\n后来记录的判断：${text(last.content, 700)}\n这两项表述可对照；是否属于结论被推翻应以原文为准。`,
        references: uniqueRefs([...first.references, ...last.references]),
      });
  }
  const reads = events.filter(
    (event) =>
      typeOf(event) === "tool_completed" &&
      event.data?.tool === "read_source" &&
      typeof event.data.sourceId === "string",
  );
  if (reads.length)
    review.effective.push({
      id: "evidence-reads",
      text: `有 ${new Set(reads.map((event) => event.data!.sourceId)).size} 项材料的实际读取记录，便于复核判断依据；只证明所记录的读取范围。`,
      references: uniqueRefs(reads.flatMap((event) => references(task, event))),
    });
  const revisionsRequested = entries.filter(
    (entry) => entry.provenance === "user_request" && entry.kind === "revision",
  );
  for (const entry of revisionsRequested)
    review.issues.push({
      id: `requested:${entry.id}`,
      text: `用户要求修正：${entry.content}\n后续保存不自动证明这项问题已解决，应对照对应版本复核。`,
      references: entry.references,
    });
  for (const entry of entries.filter(
    (entry) =>
      ["public_report", "public_reply"].includes(entry.provenance) &&
      (entry.kind === "revision" ||
        /不足|失误|哪里不对|错误|教训/.test(entry.title)),
  ))
    review.issues.push({
      id: `acknowledged:${entry.id}`,
      text: `公开记录中指出的问题与修正：${entry.content}`,
      references: entry.references,
    });
  for (const entry of entries.filter(
    (entry) =>
      entry.provenance === "public_reply" &&
      /做得好|有效做法|值得保留|成功经验|优点|可取之处/.test(entry.title),
  ))
    review.effective.push({
      id: `stated:${entry.id}`,
      text: `公开答复对做法的评价（尚需结果支持）：${entry.content}`,
      references: entry.references,
    });
  for (const entry of entries.filter((entry) => entry.kind === "question"))
    review.unverified.push({
      id: `open:${entry.id}`,
      text:
        entry.goalVersion === task.goalVersion
          ? entry.content
          : `当时提出（目标 v${entry.goalVersion}）：${entry.content}`,
      references: entry.references,
    });

  const replies = replyBodies.size;
  return {
    entries,
    review,
    coverage: {
      reports,
      replies,
      revisions,
      notice: reports
        ? "公开分析、实际答复与修订记录按先后呈现；复盘归纳只依据所引证据。"
        : replies
          ? "此前未单独记录分析摘要；以下从实际公开答复和修订记录回看，不代表补写当时未记录的想法。"
          : "尚无可解释判断依据的公开答复；操作记录只能证明动作，不能补造分析过程。",
    },
  };
}
