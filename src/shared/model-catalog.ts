import type { ModelProfile } from "./types.js";
/** Official catalog reviewed 2026-09-11. Listing is availability guidance, never a successful probe. */
export const GOOGLE_CATALOG: {
  id: string;
  name: string;
  execution: NonNullable<ModelProfile["execution"]>;
  description: string;
}[] = [
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    execution: "model",
    description: "日常协作、编码与长任务",
  },
  {
    id: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    execution: "model",
    description: "通用 Agent 与多步执行",
  },
  {
    id: "gemini-3.6-flash",
    name: "Gemini 3.6 Flash",
    execution: "model",
    description: "通用多模态协作",
  },
  {
    id: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    execution: "model",
    description: "常规高频任务",
  },
  {
    id: "gemini-3.5-flash-lite",
    name: "Gemini 3.5 Flash-Lite",
    execution: "model",
    description: "轻量与低延迟",
  },
  {
    id: "gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro Preview",
    execution: "model",
    description: "复杂问题与技术判断",
  },
  {
    id: "gemini-3.1-pro-preview-customtools",
    name: "Gemini 3.1 Pro · Custom Tools",
    execution: "model",
    description: "优化自定义工具调用",
  },
  {
    id: "gemini-3.1-flash-lite",
    name: "Gemini 3.1 Flash-Lite",
    execution: "model",
    description: "高频轻量任务",
  },
  ...["pro", "flash", "flash-lite"].map((name) => ({
    id: `gemini-2.5-${name}`,
    name: `Gemini 2.5 ${name}`,
    execution: "model" as const,
    description: "2.5 系列通用模型",
  })),
  {
    id: "deep-research-preview-04-2026",
    name: "Deep Research",
    execution: "google-agent",
    description: "独立检索与研究报告",
  },
  {
    id: "deep-research-max-preview-04-2026",
    name: "Deep Research Max",
    execution: "google-agent",
    description: "更深入的研究与综合",
  },
  {
    id: "antigravity-preview-05-2026",
    name: "Antigravity Agent",
    execution: "google-agent",
    description: "Google 远端 Agent · 网页、代码与整理",
  },
];
