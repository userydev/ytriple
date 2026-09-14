import type { AgentId, ClockPort, SessionMessage } from "@ytriple/shared";
import type { IdFactory } from "../ids.js";

/**
 * The single shared conversation.
 *
 * Only the user and team members appear here. Sub-agents are an implementation
 * detail of their parent and have no way to reach this object, which is how the
 * "sub-agents stay out of the shared chat" rule holds structurally.
 */
export interface Session {
  addUserMessage(text: string, inReplyTo?: string): SessionMessage;
  addAgentMessage(agentId: AgentId, text: string): SessionMessage;
  addAgentQuestion(agentId: AgentId, question: string, reason: string): SessionMessage;
  messages(): SessionMessage[];
  transcript(displayNames: Record<AgentId, string>): string;
}

export function createSession(clock: ClockPort, ids: IdFactory): Session {
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
