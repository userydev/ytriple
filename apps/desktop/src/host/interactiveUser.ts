import type { AgentAnswer, AgentQuestion, UserPort } from "@ytriple/shared";

/**
 * Bridges the runtime's question round to the chat composer: `askQuestions`
 * parks a promise, the UI shows the questions the orchestrator approved, and
 * the user's reply resolves it.
 */
export interface InteractiveUserPort extends UserPort {
  /** Currently waiting on the user, or an empty list. */
  pending(): AgentQuestion[];
  submit(answers: AgentAnswer[]): void;
  cancel(): void;
}

export function createInteractiveUserPort(
  onPendingChange: (questions: AgentQuestion[]) => void,
): InteractiveUserPort {
  let pending: AgentQuestion[] = [];
  let resolveCurrent: ((answers: AgentAnswer[]) => void) | undefined;

  const settle = (answers: AgentAnswer[]) => {
    const resolver = resolveCurrent;
    resolveCurrent = undefined;
    pending = [];
    onPendingChange([]);
    resolver?.(answers);
  };

  return {
    pending: () => pending,
    submit: (answers) => settle(answers),
    cancel: () =>
      settle(
        pending.map((question) => ({
          questionId: question.questionId,
          text: "",
        })),
      ),
    async askQuestions(questions) {
      if (questions.length === 0) return [];
      pending = questions;
      onPendingChange(questions);
      return new Promise<AgentAnswer[]>((resolve) => {
        resolveCurrent = resolve;
      });
    },
  };
}
