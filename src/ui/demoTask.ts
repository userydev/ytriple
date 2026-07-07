import type { TaskStatus } from "../runtime/types";

export const statusLabels: Record<TaskStatus, string> = {
  drafting_input: "Drafting Input",
  classifying: "Classifying",
  quick_clarify: "Quick Clarify",
  preparing_context: "Preparing Context",
  running_researcher: "Researching",
  running_specialist: "Specialist Review",
  merging: "Merging",
  writing_outputs: "Writing Outputs",
  completed: "Completed",
  failed: "Failed",
};

export const demoSequence: TaskStatus[] = [
  "classifying",
  "preparing_context",
  "running_researcher",
  "running_specialist",
  "merging",
  "writing_outputs",
  "completed",
];

export const deliveryFiles = [
  "01-final-prd.md",
  "02-assumptions-and-open-questions.md",
  "03-research-notes.md",
  "04-specialist-review.md",
];

export const researchItems = {
  question: "How should a fuzzy product idea become a usable PRD first draft?",
  concepts: [
    "Problem framing before feature expansion",
    "Explicit assumptions for incomplete input",
    "Light competitor scan, not deep research",
  ],
  sources: [
    {
      title: "PRD structure baseline",
      url: "https://example.com/prd",
      reason: "Supports section completeness",
    },
    {
      title: "Early product discovery",
      url: "https://example.com/discovery",
      reason: "Supports assumption-led first draft",
    },
  ],
  summary: "Research stays compact and feeds references into the package, not into PRD body noise.",
};

export const specialistItems = {
  role: "Product Lead",
  risks: ["Target user may be too broad", "Success metric is not yet explicit"],
  missing: ["Primary use case boundary", "MVP acceptance criteria"],
  recommendations: ["Keep one core scenario", "Expose assumptions before asking more questions"],
  summary: "The first draft should optimize for direction, structure, and visible unknowns.",
};
