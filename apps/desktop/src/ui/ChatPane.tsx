import type { AgentAnswer, AgentQuestion, TaskBrief } from "@ytriple/shared";
import { useEffect, useRef, useState, type JSX } from "react";
import type { ChatEntry } from "../state/taskView.js";
import { TaskBriefCard } from "./TaskBriefCard.js";

/**
 * The centre bay: one shared conversation owned by the orchestrator.
 *
 * Members never address the user directly, so every question here arrived
 * through the orchestrator's gate and carries the reason its asker gave.
 */
export function ChatPane({
  chat,
  brief,
  displayNames,
  pendingQuestions,
  running,
  onStart,
  onAnswer,
  placeholder,
}: {
  chat: ChatEntry[];
  brief?: TaskBrief | undefined;
  displayNames: Record<string, string>;
  pendingQuestions: AgentQuestion[];
  running: boolean;
  onStart(text: string): void;
  onAnswer(answers: AgentAnswer[]): void;
  placeholder: string;
}): JSX.Element {
  const [draft, setDraft] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [chat.length, pendingQuestions.length]);

  const awaitingAnswers = pendingQuestions.length > 0;

  return (
    <section className="pane chat-pane">
      <header className="pane-header">
        <h2>Shared conversation</h2>
        <span className="muted">Everyone works from this one thread</span>
      </header>

      <div className="chat-scroll">
        {chat.length === 0 && !running && (
          <div className="empty-state">
            <p>Describe a product idea, however rough.</p>
            <p className="muted">
              The team will ask only what it genuinely needs, publish a Task Brief, then write one{" "}
              <code>prd.md</code>.
            </p>
          </div>
        )}

        {chat.map((entry) => (
          <article className={`chat-entry chat-${entry.kind}`} key={entry.id}>
            <div className="chat-meta">
              <span className="chat-author">{entry.displayName}</span>
              {entry.kind === "question" && <span className="tag tag-question">question</span>}
            </div>
            <p className="chat-text">{entry.text}</p>
            {entry.reason && <p className="chat-reason">Why: {entry.reason}</p>}
          </article>
        ))}

        {brief && <TaskBriefCard brief={brief} displayNames={displayNames} />}
        <div ref={bottomRef} />
      </div>

      <footer className="composer">
        {awaitingAnswers ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onAnswer(
                pendingQuestions.map(
                  (question): AgentAnswer => ({
                    questionId: question.questionId,
                    text: answers[question.questionId] ?? "",
                  }),
                ),
              );
              setAnswers({});
            }}
          >
            <p className="composer-title">
              {pendingQuestions.length} question{pendingQuestions.length === 1 ? "" : "s"} for you
            </p>
            {pendingQuestions.map((question) => (
              <label className="answer-field" key={question.questionId}>
                <span className="answer-label">
                  <strong>{question.agentDisplayName}</strong> {question.question}
                </span>
                <input
                  type="text"
                  value={answers[question.questionId] ?? ""}
                  placeholder="Leave blank to let the team assume"
                  onChange={(event) =>
                    setAnswers({ ...answers, [question.questionId]: event.target.value })
                  }
                />
              </label>
            ))}
            <button className="primary" type="submit">
              Send answers
            </button>
          </form>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onStart(draft);
              setDraft("");
            }}
          >
            <textarea
              value={draft}
              rows={3}
              disabled={running}
              placeholder={placeholder}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button className="primary" type="submit" disabled={running || draft.trim().length === 0}>
              {running ? "Working…" : "Start task"}
            </button>
          </form>
        )}
      </footer>
    </section>
  );
}
