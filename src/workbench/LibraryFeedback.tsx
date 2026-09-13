import { useEffect, useSyncExternalStore } from "react";
import type { Command, LibraryEntry, Snapshot } from "../shared/types";
import {
  libraryAssessment,
  LIBRARY_ASSESSMENT_LABELS,
  LIBRARY_FEEDBACK_LABELS,
} from "../shared/library";
import { formatDate, type Dispatch } from "./common";

type FeedbackCommand = Extract<Command, { type: "library.feedback" }>;
type Draft = {
  command: FeedbackCommand;
  pending: boolean;
  error?: string;
  sent?: boolean;
};
const drafts = new Map<string, Draft>();
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function update(key: string, draft?: Draft) {
  if (draft) drafts.set(key, draft);
  else drafts.delete(key);
  listeners.forEach((listener) => listener());
}

export function LibraryFeedbackPanel({
  entry,
  snapshot,
  selectedTaskId,
  dispatch,
  onContinue,
}: {
  entry: LibraryEntry;
  snapshot: Snapshot;
  selectedTaskId: string | null;
  dispatch: Dispatch;
  onContinue: () => void;
}) {
  const key = `${snapshot.settings.aiRoot}:${entry.id}`;
  const draft = useSyncExternalStore(
    subscribe,
    () => drafts.get(key),
    () => undefined,
  );
  const command = draft?.command;
  useEffect(() => {
    if (!draft || draft.pending) return;
    const recorded = entry.feedback?.find(
      (item) => item.id === draft.command.feedbackId,
    );
    if (
      recorded &&
      recorded.note === draft.command.note.trim() &&
      recorded.targetHash === draft.command.expectedHash &&
      drafts.get(key) === draft
    )
      update(key);
  }, [draft, entry.feedback, key]);
  const usages = snapshot.tasks.flatMap((task) =>
    task.sources
      .filter(
        (source) =>
          source.library?.entryId === entry.id &&
          source.location === entry.path,
      )
      .map((source) => ({ task, source })),
  );
  const selectedUse = usages.find(
    (use) =>
      use.task.id === command?.taskId && use.source.id === command?.sourceId,
  );
  const selectedArtifact = selectedUse?.task.artifacts.find(
    (artifact) => artifact.id === command?.artifactId,
  );
  const changed = Boolean(
    command &&
    (command.expectedFeedbackRevision !== (entry.feedbackRevision ?? 0) ||
      (command.taskId && !selectedUse) ||
      (command.artifactId &&
        (command.expectedArtifactHash !== selectedArtifact?.hash ||
          command.expectedArtifactVersion !== selectedArtifact?.version)) ||
      (!command.taskId &&
        (command.expectedHash !== entry.hash ||
          command.expectedVersion !== entry.version))),
  );
  const patch = (fields: Partial<FeedbackCommand>) => {
    if (draft && !draft.pending)
      update(key, {
        ...draft,
        command: {
          ...draft.command,
          ...fields,
          ...(draft.sent &&
          Object.entries(fields).some(
            ([field, value]) =>
              field !== "expectedFeedbackRevision" &&
              draft.command[field as keyof FeedbackCommand] !== value,
          )
            ? { feedbackId: crypto.randomUUID() }
            : {}),
        },
        error: undefined,
      });
  };
  const begin = (kind: FeedbackCommand["kind"]) => {
    const use =
      kind !== "correction"
        ? usages.find(
            (usage) =>
              usage.task.id === selectedTaskId &&
              !usage.source.library?.supersededAt,
          )
        : undefined;
    update(key, {
      pending: false,
      command: {
        type: "library.feedback",
        entryId: entry.id,
        feedbackId: crypto.randomUUID(),
        kind,
        expectedHash: use?.source.library?.hash ?? entry.hash,
        expectedVersion: use?.source.library?.version ?? entry.version,
        expectedFeedbackRevision: entry.feedbackRevision ?? 0,
        note: "",
        purpose: "",
        conditions: "",
        evidence: "",
        ...(use ? { taskId: use.task.id, sourceId: use.source.id } : {}),
      },
    });
  };
  const submit = async () => {
    const current = drafts.get(key);
    if (!current || current.pending || changed) return;
    const pending = { ...current, pending: true, sent: true, error: undefined };
    update(key, pending);
    try {
      const result = await dispatch(current.command);
      if (drafts.get(key) !== pending) return;
      if (result) update(key);
      else
        update(key, {
          ...current,
          sent: true,
          pending: false,
          error: "尚未保存，反馈内容已保留。请核对版本或重试。",
        });
    } catch {
      if (drafts.get(key) === pending)
        update(key, {
          ...current,
          sent: true,
          pending: false,
          error: "保存失败，反馈内容已保留。",
        });
    }
  };
  const feedback = entry.feedback ?? [];
  return (
    <section
      className="library-feedback"
      id={`library-feedback-${entry.id}`}
      aria-label="资产用途与反馈"
    >
      <div className="library-feedback-heading">
        <div>
          <h4>用途与反馈</h4>
          <p>记录实际用途、条件和结果，让团队下次接着用。</p>
        </div>
        <span className={`library-assessment ${libraryAssessment(entry)}`}>
          {LIBRARY_ASSESSMENT_LABELS[libraryAssessment(entry)]}
        </span>
      </div>
      {command ? (
        <fieldset disabled={draft.pending} className="library-feedback-form">
          <legend>
            {LIBRARY_FEEDBACK_LABELS[command.kind]} · 资产 v
            {command.expectedVersion}
          </legend>
          <label className="field">
            对应哪次使用
            <select
              aria-label="反馈对应的使用"
              value={command.sourceId ?? "current"}
              onChange={(event) => {
                const usage = usages.find(
                  (use) => use.source.id === event.target.value,
                );
                patch({
                  taskId: usage?.task.id,
                  sourceId: usage?.source.id,
                  artifactId: undefined,
                  expectedArtifactHash: undefined,
                  expectedArtifactVersion: undefined,
                  expectedHash: usage?.source.library?.hash ?? entry.hash,
                  expectedVersion:
                    usage?.source.library?.version ?? entry.version,
                });
              }}
            >
              <option value="current">
                当前资产 · 在其他工具使用或直接修正
              </option>
              {usages.map(({ task, source }) => (
                <option key={source.id} value={source.id}>
                  {task.title} · 资产 v{source.library!.version}
                  {source.library!.supersededAt ? "（历史）" : ""}
                </option>
              ))}
            </select>
          </label>
          {selectedUse?.task.artifacts.length ? (
            <label className="field">
              相关成果（可选）
              <select
                aria-label="反馈对应的成果"
                value={command.artifactId ?? ""}
                onChange={(event) => {
                  const artifact = selectedUse.task.artifacts.find(
                    (item) => item.id === event.target.value,
                  );
                  patch({
                    artifactId: artifact?.id,
                    expectedArtifactHash: artifact?.hash,
                    expectedArtifactVersion: artifact?.version,
                  });
                }}
              >
                <option value="">记录这次工作</option>
                {selectedUse.task.artifacts.map((artifact) => (
                  <option key={artifact.id} value={artifact.id}>
                    {artifact.title} · v{artifact.version}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="field">
            {command.kind === "correction" ? "需要纠正什么" : "实际结果"}
            <textarea
              aria-label="反馈内容"
              value={command.note}
              maxLength={4000}
              onInput={(event) => patch({ note: event.currentTarget.value })}
              placeholder={
                command.kind === "correction"
                  ? "哪项判断需要调整，应该怎样理解？"
                  : "哪些有效，哪些没有达到预期？"
              }
            />
          </label>
          <div className="form-grid">
            <label className="field">
              实际用途{command.kind === "correction" ? "（可选）" : ""}
              <input
                aria-label="实际用途"
                value={command.purpose}
                maxLength={1000}
                onInput={(event) =>
                  patch({ purpose: event.currentTarget.value })
                }
                placeholder="用它完成了什么"
              />
            </label>
            <label className="field">
              适用条件{command.kind === "correction" ? "（可选）" : ""}
              <input
                aria-label="适用条件"
                value={command.conditions}
                maxLength={2000}
                onInput={(event) =>
                  patch({ conditions: event.currentTarget.value })
                }
                placeholder="场景、对象或限制"
              />
            </label>
          </div>
          <label className="field">
            观察依据{command.kind === "correction" ? "（可选）" : ""}
            <textarea
              aria-label="观察依据"
              value={command.evidence}
              maxLength={4000}
              onInput={(event) =>
                patch({ evidence: event.currentTarget.value })
              }
              placeholder="实际观察、结果位置或失败原因；没有证据就保留待验证"
            />
          </label>
          {changed ? (
            <div className="inline-notice warning">
              资产或反馈已更新，输入仍保留。
              <button
                className="text-button"
                type="button"
                onClick={() =>
                  patch({
                    expectedFeedbackRevision: entry.feedbackRevision ?? 0,
                    ...(command.artifactId
                      ? {
                          expectedArtifactHash: selectedArtifact?.hash,
                          expectedArtifactVersion: selectedArtifact?.version,
                        }
                      : {}),
                    ...(!command.taskId
                      ? {
                          expectedHash: entry.hash,
                          expectedVersion: entry.version,
                        }
                      : {}),
                  })
                }
              >
                已核对，按当前版本记录
              </button>
            </div>
          ) : null}
          {draft.error ? <p role="alert">{draft.error}</p> : null}
          <div className="artifact-actions">
            <button
              className="button primary small"
              disabled={
                changed ||
                !command.note.trim() ||
                (command.kind !== "correction" &&
                  (!command.purpose.trim() ||
                    !command.conditions.trim() ||
                    !command.evidence.trim()))
              }
              onClick={() => void submit()}
            >
              {draft.pending ? "记录中…" : "记录到这项资产"}
            </button>
            <button className="text-button" onClick={() => update(key)}>
              取消
            </button>
          </div>
        </fieldset>
      ) : (
        <div className="artifact-actions">
          <button
            className="button secondary small"
            disabled={Boolean(entry.readError)}
            onClick={() => begin("correction")}
          >
            修正判断
          </button>
          <button
            className="button secondary small"
            disabled={Boolean(entry.readError)}
            onClick={() => begin("useful")}
          >
            使用有效
          </button>
          <button
            className="button secondary small"
            disabled={Boolean(entry.readError)}
            onClick={() => begin("failed")}
          >
            未达预期
          </button>
          {feedback.length ? (
            <button
              className="text-button"
              disabled={Boolean(entry.readError)}
              onClick={onContinue}
            >
              交给团队处理反馈 →
            </button>
          ) : null}
        </div>
      )}
      {feedback.length ? (
        <details className="library-feedback-history" open>
          <summary>已记录 {feedback.length} 条反馈 · 用户观察</summary>
          {[...feedback].reverse().map((item) => (
            <article key={item.id}>
              <div>
                <strong>{LIBRARY_FEEDBACK_LABELS[item.kind]}</strong>
                <span>
                  资产 v{item.targetVersion} · {formatDate(item.createdAt)}
                </span>
                {entry.feedbackResolutions?.some(
                  (resolution) => resolution.feedbackId === item.id,
                ) ? (
                  <span>已在正文修订中处理</span>
                ) : null}
              </div>
              <p>{item.note}</p>
              {item.purpose ? <p>用途：{item.purpose}</p> : null}
              {item.conditions ? <p>条件：{item.conditions}</p> : null}
              {item.evidence ? <p>依据：{item.evidence}</p> : null}
              {item.outcome ? (
                <p>
                  来自「{item.outcome.taskTitle}」
                  {item.outcome.artifactTitle
                    ? ` · ${item.outcome.artifactTitle} v${item.outcome.artifactVersion}`
                    : ""}
                </p>
              ) : null}
            </article>
          ))}
        </details>
      ) : (
        <p className="library-feedback-empty">
          尚无使用证据。保存到 Lib 和生成成果都不等于验证有效。
        </p>
      )}
    </section>
  );
}
