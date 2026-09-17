import { useRef, useState } from "react";
import { ArrowUp, PanelsTopLeft, Square } from "lucide-react";
import type { Decision } from "../core/types";
import { command } from "./api";
export function DecisionInput({
  decision,
  title,
  immersive,
  onExpand,
  onManage,
  onError,
}: {
  decision: Decision;
  title: string;
  immersive: boolean;
  onExpand: () => void;
  onManage: () => void;
  onError: (e: unknown) => void;
}) {
  const [text, setText] = useState(decision.draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const revision = useRef(decision.draftRevision);
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  const key = useRef<string | null>(null);
  function change(value: string) {
    setText(value);
    key.current = null;
    pending.current = pending.current.then(async () => {
      const saved = await command<Decision>({
        type: "decision-draft",
        decisionId: decision.id,
        revision: decision.revision,
        draftRevision: revision.current,
        text: value,
      });
      revision.current = saved.draftRevision;
    });
    void pending.current.catch((e) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  }
  async function send() {
    if (busy || !text.trim()) return;
    setBusy(true);
    try {
      await pending.current;
      key.current ??= crypto.randomUUID();
      await command({
        type: "answer-decision",
        decisionId: decision.id,
        revision: decision.revision,
        draftRevision: revision.current,
        key: key.current,
        text,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="composer decision-composer" aria-label="回答待决">
      <div className="composer-context">
        <button
          className="quiet"
          disabled={busy}
          onClick={() => void pending.current.then(onManage).catch(onError)}
        >
          {title}
        </button>
        <span className="muted">等待你的决定</span>
      </div>
      <div className="decision-question">
        <h3>{decision.question}</h3>
        <p className="muted">{decision.impact}</p>
        <details>
          <summary>为什么需要决定</summary>
          <p>{decision.reason}</p>
        </details>
        <div className="decision-options">
          {decision.options.map((option) => (
            <button
              key={option.label}
              type="button"
              disabled={busy}
              aria-pressed={text === option.label}
              title={option.detail}
              onClick={() => change(option.label)}
            >
              <strong>{option.label}</strong>
              <span>{option.detail}</span>
            </button>
          ))}
        </div>
      </div>
      <textarea
        aria-label="对当前问题的答复"
        rows={2}
        value={text}
        disabled={busy}
        placeholder="选择方向，或写下你的决定…"
        onChange={(e) => change(e.target.value)}
        onKeyDown={(e) => {
          if (
            e.key === "Enter" &&
            (e.metaKey || e.ctrlKey) &&
            !e.nativeEvent.isComposing
          ) {
            e.preventDefault();
            void send();
          }
        }}
      />
      {error ? (
        <p role="alert" className="error-inline">
          {error}
        </p>
      ) : null}
      <div className="composer-tools">
        <span className="muted">答复后接续原工作</span>
        <div className="tool-group">
          <button
            className="icon-button"
            aria-label={immersive ? "收起工作区" : "展开团队工作区"}
            title={immersive ? "收起工作区" : "展开团队工作区"}
            disabled={busy}
            onClick={() => void pending.current.then(onExpand).catch(onError)}
          >
            <PanelsTopLeft size={18} />
          </button>
          <button
            className="icon-button"
            aria-label="停止等待并保留答复草稿"
            title="停止等待并保留答复草稿"
            disabled={busy}
            onClick={() =>
              void pending.current
                .then(() => command({ type: "stop", workId: decision.workId }))
                .catch(onError)
            }
          >
            <Square size={16} />
          </button>
          <button
            className="icon-button send"
            aria-label="回答并继续 · ⌘/Ctrl+Enter"
            title="回答并继续 · ⌘/Ctrl+Enter"
            disabled={busy || !text.trim() || !!error}
            onClick={() => void send()}
          >
            <ArrowUp size={20} />
          </button>
        </div>
      </div>
    </section>
  );
}
