import type { AgentDefinition, MemberTask, RuntimeCapabilities, TaskBrief } from "@ytriple/shared";
import { CONTEXT_PRIORITY, type ContextSection } from "../context/contextBudget.js";

/**
 * Prompts are assembled from role data only. There is no branch on an agent id
 * or a role name anywhere in here, which is what lets a team of two or of five
 * run the same orchestration code.
 */

export function roleSection(agent: AgentDefinition): ContextSection {
  const { role } = agent;
  return {
    id: `role:${agent.agentId}`,
    priority: CONTEXT_PRIORITY.roleAndTools,
    content: [
      `You are ${agent.displayName} (agentId: ${agent.agentId}).`,
      `Responsibility: ${role.responsibility}`,
      "",
      role.instructions,
      "",
      "Question policy:",
      ...role.questionPolicy.scope.map((entry) => `- you may ask about: ${entry}`),
      ...role.questionPolicy.forbidden.map((entry) => `- you must not ask about: ${entry}`),
      `- at most ${role.questionPolicy.maxQuestionsPerTurn} question(s) per turn`,
      "",
      "Execution policy:",
      ...role.executionPolicy.map((entry) => `- ${entry}`),
    ].join("\n"),
  };
}

export function toolsSection(agent: AgentDefinition, toolNames: readonly string[]): ContextSection {
  return {
    id: `tools:${agent.agentId}`,
    priority: CONTEXT_PRIORITY.roleAndTools,
    content:
      toolNames.length > 0
        ? [
            "Tools available to you this run:",
            ...toolNames.map((name) => `- ${name}`),
            "Call a tool only when its result would change what you write.",
          ].join("\n")
        : "You have no tools this run. Work from the conversation and the brief alone.",
  };
}

export function capabilitiesSection(capabilities: RuntimeCapabilities): ContextSection {
  return {
    id: "capabilities",
    priority: CONTEXT_PRIORITY.roleAndTools,
    content: [
      "Host capabilities for this task:",
      `- workspace files: ${capabilities.workspaceRead ? "readable" : "not available"}`,
      `- web search: ${capabilities.webSearch ? "available" : "not available"}`,
      `- output writing: ${capabilities.outputWrite ? "available" : "not available"}`,
      "Do not plan work that depends on a capability marked unavailable; say so instead.",
    ].join("\n"),
  };
}

export function briefSection(brief: TaskBrief, memberTask?: MemberTask): ContextSection {
  const lines = [
    "Task Brief:",
    `- product: ${brief.productObject}`,
    `- target user: ${brief.targetUser}`,
    `- core scenario: ${brief.coreScenario}`,
    `- problem: ${brief.painOrProblem}`,
    `- V1 scope: ${joinOrNone(brief.v1Scope)}`,
    `- non-goals: ${joinOrNone(brief.nonGoals)}`,
    `- success criteria: ${joinOrNone(brief.successCriteria)}`,
    `- assumptions so far: ${joinOrNone(brief.assumptions)}`,
    `- open questions: ${joinOrNone(brief.openQuestions)}`,
    `- context available: workspace=${brief.contextAvailability.workspace}, webSearch=${brief.contextAvailability.webSearch}`,
  ];

  if (memberTask) {
    lines.push(
      "",
      "Your task:",
      `- objective: ${memberTask.objective}`,
      `- must cover: ${joinOrNone(memberTask.mustCover)}`,
      `- out of scope for you: ${joinOrNone(memberTask.outOfScope)}`,
    );
  }

  return {
    id: "brief",
    priority: CONTEXT_PRIORITY.briefAndMemberTask,
    content: lines.join("\n"),
  };
}

export interface TranscriptSections {
  recent: ContextSection;
  earlier?: ContextSection;
}

/**
 * Split so the overflow chain can drop the early transcript before the recent
 * turns, per the provider contract's trimming order.
 */
export function transcriptSections(transcript: string, recentLines = 12): TranscriptSections {
  const lines = transcript.split("\n").filter((line) => line.trim().length > 0);
  const recentStart = Math.max(0, lines.length - recentLines);
  const recent: ContextSection = {
    id: "chat:recent",
    priority: CONTEXT_PRIORITY.recentChat,
    content: ["Recent conversation:", ...lines.slice(recentStart)].join("\n"),
  };

  if (recentStart === 0) return { recent };

  return {
    recent,
    earlier: {
      id: "chat:earlier",
      priority: CONTEXT_PRIORITY.earlyChat,
      content: ["Earlier conversation:", ...lines.slice(0, recentStart)].join("\n"),
    },
  };
}

export function observationsSection(observations: readonly string[]): ContextSection {
  return {
    id: "observations",
    priority: CONTEXT_PRIORITY.rawSearchResults,
    content:
      observations.length > 0
        ? ["Tool results so far:", ...observations].join("\n\n")
        : "",
  };
}

export function phaseSection(id: string, instruction: string): ContextSection {
  return { id: `phase:${id}`, priority: CONTEXT_PRIORITY.briefAndMemberTask, content: instruction };
}

function joinOrNone(values: readonly string[]): string {
  return values.length > 0 ? values.join("; ") : "(none stated yet)";
}
