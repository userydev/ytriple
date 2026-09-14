import type { ModelDefect } from "./syntheticModel.js";

/**
 * The sample set: vague product ideas of the kind this product exists for,
 * paired with the model misbehaviour each run should survive.
 *
 * The ideas are deliberately underspecified — that is the input the product
 * promises to handle. Each sample also names the words that must survive into
 * the finished document, which is how "the draft is about what I asked for" is
 * checked rather than assumed.
 */
export interface QualitySample {
  id: string;
  language: "zh" | "en";
  /** What the user types. Intentionally vague. */
  input: string;
  topic: string;
  keywords: string[];
  /** Terms that must appear somewhere in the generated prd.md. */
  mustMention: string[];
  defect: ModelDefect;
  failingAgentId?: string;
  /** No SearchPort and no native grounding: research has to degrade. */
  withoutWebSearch?: boolean;
  withWorkspace?: boolean;
}

export const QUALITY_SAMPLES: QualitySample[] = [
  {
    id: "prd-workbench-zh",
    language: "zh",
    input: "我想做一个工具，把模糊的产品想法变成可以给开发看的 PRD，但是我现在还没想清楚具体流程。",
    topic: "把模糊产品想法变成一份可交付的 PRD",
    keywords: ["需求收敛", "开发可读的规格", "独立开发者"],
    mustMention: ["需求收敛", "独立开发者"],
    defect: "clean",
  },
  {
    id: "reading-habit-en",
    language: "en",
    input: "Something that helps me actually finish the books I start. Not sure what it looks like yet.",
    topic: "a tool that helps someone finish the books they start",
    keywords: ["reading habit", "abandoned books", "daily nudge"],
    mustMention: ["reading habit", "abandoned books"],
    defect: "fenced_json",
  },
  {
    id: "invoice-chaos-en",
    language: "en",
    input: "I lose track of freelance invoices and chase payments too late. Maybe an app? Maybe a script?",
    topic: "keeping freelance invoices and chasing payments under control",
    keywords: ["unpaid invoices", "payment reminders", "freelancers"],
    mustMention: ["unpaid invoices", "freelancers"],
    defect: "chatty_prose",
  },
  {
    id: "team-standup-zh",
    language: "zh",
    input: "远程团队的站会很浪费时间，想做点什么改善，但还没想清楚是异步还是同步。",
    topic: "改善远程团队站会的效率",
    keywords: ["异步站会", "远程协作", "会议成本"],
    mustMention: ["异步站会", "远程协作"],
    defect: "invalid_once",
  },
  {
    id: "plant-care-en",
    language: "en",
    input: "My plants keep dying and I do not know why. Some kind of helper?",
    topic: "helping someone keep their houseplants alive",
    keywords: ["watering schedule", "plant health", "beginner gardeners"],
    mustMention: ["watering schedule", "plant health"],
    defect: "empty_optional_lists",
  },
  {
    id: "study-notes-en",
    language: "en",
    input: "I take a lot of notes and never look at them again. There is probably a product in there.",
    topic: "making notes worth revisiting after they are written",
    keywords: ["note review", "spaced repetition", "personal knowledge"],
    mustMention: ["note review", "spaced repetition"],
    defect: "member_failure",
    failingAgentId: "researcher",
  },
  {
    id: "local-events-zh",
    language: "zh",
    input: "想做个本地活动推荐，但不知道从哪里拿数据，也不确定用户是谁。",
    topic: "本地活动推荐",
    keywords: ["活动数据来源", "本地生活", "推荐口径"],
    mustMention: ["活动数据来源", "本地生活"],
    defect: "clean",
    withoutWebSearch: true,
  },
  {
    id: "codebase-onboarding-en",
    language: "en",
    input: "New engineers take weeks to understand our codebase. I want to fix that somehow.",
    topic: "shortening the time it takes a new engineer to understand a codebase",
    keywords: ["onboarding time", "codebase tour", "tribal knowledge"],
    mustMention: ["onboarding time", "codebase tour"],
    defect: "clean",
    withWorkspace: true,
  },
];

/** Sections the output contract requires in every generated document. */
export const REQUIRED_PRD_SECTIONS = [
  "## Product Summary",
  "## Problem / Background",
  "## Target Users",
  "## Core Scenario",
  "## V1 Scope",
  "## Non-goals",
  "## Functional Requirements",
  "## UX / Interaction Requirements",
  "## Success Criteria",
  "## Assumptions and Open Questions",
] as const;
