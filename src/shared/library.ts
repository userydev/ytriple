import type {
  LibraryAssessment,
  LibraryEntry,
  LibraryFeedback,
} from "./types.js";

export const LIBRARY_ASSESSMENT_LABELS: Record<LibraryAssessment, string> = {
  unverified: "尚未验证",
  needs_review: "有反馈待处理",
  user_reported_useful: "用户反馈有效",
};
export const LIBRARY_FEEDBACK_LABELS: Record<LibraryFeedback["kind"], string> =
  {
    correction: "判断修正",
    useful: "使用有效",
    failed: "使用未达预期",
  };
export function unresolvedLibraryFeedback(
  entry: LibraryEntry,
): LibraryFeedback[] {
  const resolved = new Set(
    entry.feedbackResolutions?.map((item) => item.feedbackId),
  );
  return (entry.feedback ?? []).filter(
    (item) => item.kind !== "useful" && !resolved.has(item.id),
  );
}
/** A positive report applies only to the exact content used, never to future revisions. */
export function libraryAssessment(entry: LibraryEntry): LibraryAssessment {
  if (entry.externalChange || unresolvedLibraryFeedback(entry).length)
    return "needs_review";
  return entry.feedback?.some(
    (item) => item.kind === "useful" && item.targetHash === entry.hash,
  )
    ? "user_reported_useful"
    : "unverified";
}
