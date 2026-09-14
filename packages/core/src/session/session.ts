import type { AgentId, ClockPort, IdPort, SessionMessage } from "@ytriple/shared";

/**
 * The single shared conversation. Every agent question, every user answer and
 * every orchestrator statement lands here, so each agent is prompted with the
 * same transcript instead of a private side channel.
 */
export interface Session {
  addUserMessage(text: string, inReplyTo?: string): SessionMessage;
  addAgentMessage(agentId: AgentId, text: string): SessionMessage;
  addAgentQuestion(agentId: AgentId, question: string, reason: string): SessionMessage;
  messages(): SessionMessage[];
  transcript(displayNames: Record<AgentId, string>): string;
}

export function createSession(clock: ClockPort, ids: IdPort): Session {
  const messages: SessionMessage[] = [];

  const push = (message: SessionMessage): SessionMessage => {
    messages.push(message);
    return message;
  };

  return {
    addUserMessage(text, inReplyTo) {
      return push({
        messageId: ids.next("msg"),
        authorKind: "user",
        authorId: "user",
        kind: inReplyTo ? "answer" : "statement",
        text,
        ...(inReplyTo ? { inReplyTo } : {}),
        createdAt: clock.now(),
      });
    },
    addAgentMessage(agentId, text) {
      return push({
        messageId: ids.next("msg"),
        authorKind: "agent",
        authorId: agentId,
        kind: "statement",
        text,
        createdAt: clock.now(),
      });
    },
    addAgentQuestion(agentId, question, reason) {
      return push({
        messageId: ids.next("msg"),
        authorKind: "agent",
        authorId: agentId,
        kind: "question",
        text: question,
        reason,
        createdAt: clock.now(),
      });
    },
    messages: () => [...messages],
    transcript(displayNames) {
      return messages
        .map((message) => {
          const label =
            message.authorId === "user"
              ? "User"
              : (displayNames[message.authorId] ?? message.authorId);
          const prefix = message.kind === "question" ? `${label} (question)` : label;
          return `${prefix}: ${message.text}`;
        })
        .join("\n");
    },
  };
}
