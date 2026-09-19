import { useMemo, useState, type ReactNode } from "react";
import type { Snapshot } from "../core/types";
import type { RadarTopic } from "../core/radar-contract";
import {
  SUGGESTED_FOLLOW_LABELS,
  connectedPublicSourceIds,
  followIntentKind,
  followTopicInput,
  localMatchPreview,
  resolveFollowTitle,
} from "../core/radar-reading";
import { command } from "./api";
import { Dialog } from "./Dialog";

export function RadarFollow({
  data,
  draft,
  research,
  planning,
  onDraft,
  onClose,
  onFollowed,
  onPlan,
  onError,
}: {
  data: Snapshot;
  draft: string;
  research?: ReactNode;
  planning: boolean;
  onDraft: (value: string) => void;
  onClose: () => void;
  onFollowed: (
    topic: RadarTopic,
    outcome: "located" | "created" | "created-beside-archive",
  ) => void;
  onPlan: (title: string, topic?: RadarTopic) => void;
  onError: (error: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const sourceIds = connectedPublicSourceIds(data.sources);
  const intent = followIntentKind(draft);
  const existing = resolveFollowTitle(data.radar.topics, draft);
  const needsChoice = intent === "choice" && existing.kind !== "active";
  const previewTopic = useMemo(
    () => followTopicInput(draft, sourceIds, { literalText: true }),
    [draft, sourceIds.join(",")],
  );
  const preview =
    draft.trim()
      ? localMatchPreview(data, previewTopic)
      : null;
  const showLiteralPreview = needsChoice && draft.trim();

  async function follow(name: string, literal = false) {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    const resolved = resolveFollowTitle(data.radar.topics, trimmed);
    if (resolved.kind === "active") {
      onFollowed(resolved.topic, "located");
      return;
    }
    if (!literal && followIntentKind(trimmed) === "choice") return;
    setBusy(true);
    try {
      const topic = await command<RadarTopic>({
        type: "radar-topic",
        topic: followTopicInput(trimmed, sourceIds, { literalText: literal }),
      });
      onFollowed(
        topic,
        resolved.kind === "archived" ? "created-beside-archive" : "created",
      );
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="关注话题" onClose={onClose}>
      <div className="radar-follow-form">
        <div className="radar-follow-labels">
          {SUGGESTED_FOLLOW_LABELS.map((label) => (
            <button
              key={label.title}
              type="button"
              disabled={busy || planning}
              onClick={() => void follow(label.title)}
            >
              {label.title}
            </button>
          ))}
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (needsChoice || planning) return;
            void follow(draft);
          }}
        >
          <label>
            话题
            <input
              aria-label="话题名称"
              disabled={planning}
              value={draft}
              maxLength={120}
              onChange={(event) => onDraft(event.target.value)}
              placeholder="想看什么？选择话题，或用一句话描述"
            />
          </label>
          {showLiteralPreview && preview?.error ? (
            <p className="error-inline">{preview.error}</p>
          ) : null}
          {showLiteralPreview && preview && !preview.error ? (
            <p className="muted">
              {preview.count
                ? `按这段文字，当前范围内有 ${preview.count} 篇字面命中`
                : "按这段文字，当前范围内还没有命中，仍可先关注"}
            </p>
          ) : null}
          {needsChoice ? (
            <p className="muted">范围尚未确定。确认匹配文字，或让团队规划后再保存。</p>
          ) : null}
          {needsChoice ? (
            <div className="radar-follow-actions">
              <button
                type="button"
                className="primary"
                disabled={busy || planning || !draft.trim()}
                onClick={() => void follow(draft, true)}
              >
                只匹配这段文字
              </button>
              <button
                type="button"
                disabled={busy || planning || !draft.trim()}
                onClick={() => onPlan(draft)}
                aria-pressed={planning}
              >
                让 AI 完善范围
              </button>
            </div>
          ) : (
            <div className="radar-follow-actions">
              <button className="primary" disabled={busy || planning || !draft.trim()}>
                {busy ? "保存中…" : "关注"}
              </button>
            </div>
          )}
        </form>
        {planning ? (
          <div className="radar-follow-plan">
            {research ?? <p className="muted" role="status">正在规划关注范围…</p>}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
