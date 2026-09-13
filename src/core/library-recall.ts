import path from "node:path";
import type { LibraryEntry, Source, Task } from "../shared/types.js";
import { hash } from "./files.js";
import {
  librarySource,
  listLibrary,
  readLibraryBytes,
  migrateLibrarySources,
} from "./library.js";
import { Store, now, uid } from "./store.js";

const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
const stopwords = new Set(
  "的 了 和 与 是 在 我 你 请 这 那 一个 一份 这个 这些 什么 如何 怎么 需要 可以 进行 根据 关于 帮助 整理 研究 分析 使用 工作 资料 内容 说明书 the a an of to in is are for with and or this that use using please".split(
    " ",
  ),
);
function terms(text: string): string[] {
  return [
    ...new Set(
      [...segmenter.segment(text.normalize("NFKC").toLowerCase())]
        .filter(
          (part) =>
            part.isWordLike &&
            part.segment.length > 1 &&
            !stopwords.has(part.segment),
        )
        .map((part) => part.segment),
    ),
  ].slice(0, 80);
}
export interface LibraryMatch {
  entry: LibraryEntry;
  reason: string;
  score: number;
}

/** Local, explainable keyword recall. It is a candidate lookup, not a semantic verification. */
export function rankLibrary(
  entries: LibraryEntry[],
  query: string,
  limit = 3,
): LibraryMatch[] {
  const keywords = terms(query);
  if (!keywords.length) return [];
  return entries
    .flatMap((entry) => {
      if (entry.readError || !["md", "html"].includes(entry.format)) return [];
      const title = terms(entry.title),
        tags = terms(entry.tags.join(" "));
      const note = terms(entry.note);
      const feedback = (entry.feedback ?? [])
        .map((item) => `${item.note} ${item.purpose} ${item.conditions}`)
        .join("\n")
        .normalize("NFKC")
        .toLowerCase();
      // Corpus terms are not query-limited; long documents may contain the useful match near the end.
      const body = entry.content?.normalize("NFKC").toLowerCase() ?? "";
      const matches = keywords.filter(
        (word) =>
          title.includes(word) ||
          tags.includes(word) ||
          note.includes(word) ||
          feedback.includes(word) ||
          body.includes(word),
      );
      const score = matches.reduce(
        (total, word) =>
          total +
          (title.includes(word)
            ? 5
            : tags.includes(word)
              ? 4
              : note.includes(word)
                ? 3
                : feedback.includes(word)
                  ? 3
                  : 1),
        0,
      );
      if (
        score < 3 ||
        (matches.length === 1 &&
          !title.includes(matches[0]!) &&
          !tags.includes(matches[0]!) &&
          !note.includes(matches[0]!) &&
          !feedback.includes(matches[0]!))
      )
        return [];
      return [
        {
          entry,
          score,
          reason: `与当前问题匹配：${matches.slice(0, 5).join("、")}。属于本地关键词候选，仍需团队阅读判断。`,
        },
      ];
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.entry.updatedAt.localeCompare(a.entry.updatedAt) ||
        a.entry.id.localeCompare(b.entry.id),
    )
    .slice(0, limit);
}

/** Prepare only at a run boundary. Retain replaced snapshots for evidence and feedback attribution. */
export function prepareLibraryRecall(store: Store, taskId: string): void {
  migrateLibrarySources(store, store.settings().aiRoot);
  const task = store.task(taskId);
  if (task.surface === "background") return;
  const settings = store.settings(),
    root = path.resolve(settings.aiRoot);
  const lastUser = task.messages.findLast((message) => message.role === "user");
  const query =
    lastUser && lastUser.content !== task.goal
      ? `${lastUser.content}\n${task.goal}`
      : task.goal;
  const active = task.sources.filter(
    (source) => source.library && !source.library.supersededAt,
  );
  const explicit = new Map(
    active
      .filter((source) => source.library!.selection === "explicit")
      .map((source) => [source.library!.entryId, source]),
  );
  const matches =
    settings.libraryRecall === false
      ? []
      : rankLibrary(listLibrary(store, root), query);
  const selected = new Map(
    matches.map((match) => [
      match.entry.id,
      {
        selection: "recalled" as "recalled" | "explicit",
        reason: match.reason,
      },
    ]),
  );
  for (const [id, source] of explicit)
    selected.set(id, { selection: "explicit", reason: source.library!.reason });
  const desired: Source[] = [];
  const issues: string[] = [];
  for (const [entryId, selection] of selected) {
    const previous = active.find(
      (source) => source.library!.entryId === entryId,
    );
    if (previous && previous.library!.root !== root) {
      // Existing task snapshots remain usable; switching roots never authorizes fresh reads of the old Lib.
      desired.push(previous);
      continue;
    }
    try {
      const source = librarySource(store, root, entryId);
      Object.assign(source.library!, selection);
      if (
        previous &&
        previous.library!.hash === source.library!.hash &&
        previous.library!.version === source.library!.version &&
        previous.library!.feedbackRevision ===
          source.library!.feedbackRevision &&
        previous.library!.assessment === source.library!.assessment &&
        previous.library!.selection === selection.selection
      )
        desired.push(previous);
      else desired.push(source);
    } catch {
      issues.push(
        `《${previous?.title ?? entryId}》当前无法读取，未将其作为本轮 Lib 依据。`,
      );
    }
  }
  const desiredIds = new Set(desired.map((source) => source.id));
  const removed = active.filter((source) => !desiredIds.has(source.id));
  const added = desired.filter(
    (source) => !task.sources.some((item) => item.id === source.id),
  );
  if (!removed.length && !added.length && !issues.length) return;
  store.updateTask(taskId, (current) => {
    // Source changes invalidate previous reasoning. The runtime references the original latest user message without fabricating another one.
    if (
      removed.length ||
      current.artifacts.some(
        (artifact) => artifact.goalVersion === current.goalVersion,
      )
    ) {
      const refinement = current.events.findLast(
        (event) =>
          event.type === "artifact.refine_requested" &&
          event.goalVersion === current.goalVersion,
      );
      current.goalVersion++;
      if (refinement)
        current.events.push({
          ...refinement,
          id: uid(),
          goalVersion: current.goalVersion,
          createdAt: now(),
        });
    }
    for (const source of current.sources)
      if (removed.some((item) => item.id === source.id))
        source.library!.supersededAt = now();
    current.sources.push(...added);
    current.events.push({
      id: uid(),
      createdAt: now(),
      type: "library.recalled",
      goalVersion: current.goalVersion,
      summary: `已为当前问题准备 ${desired.length} 项 Lib 资料；加入资料不代表已经阅读或验证。${issues.join(" ")}`,
      data: {
        continuedUserMessageId: lastUser?.id,
        sourceIds: desired.map((source) => source.id),
        matches: desired.map((source) => ({
          entryId: source.library!.entryId,
          sourceId: source.id,
          reason: source.library!.reason,
        })),
        issues,
      },
    });
  });
  store.saveCheckpoint(taskId, null);
}

/** Prevent feedback arriving mid-run from producing a result based on an obsolete judgment. */
export function assertLibraryContextCurrent(store: Store, task: Task): void {
  if (task.surface === "background") return;
  for (const source of task.sources) {
    const reference = source.library;
    if (
      !reference ||
      reference.supersededAt ||
      reference.root !== path.resolve(store.settings().aiRoot)
    )
      continue;
    if (
      store.libraryFeedback(reference.root, reference.entryId).length !==
        reference.feedbackRevision ||
      hash(readLibraryBytes(store, reference.root, reference.entryId)) !==
        reference.hash
    )
      throw new Error(
        "本轮使用的 Lib 已有修订或反馈，请继续工作以读取最新判断。",
      );
  }
}
