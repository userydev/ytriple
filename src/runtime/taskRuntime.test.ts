import { describe, expect, it } from "vitest";
import { runPrdTask } from "./taskRuntime";

describe("fixed tri-agent PRD runtime", () => {
  it("runs the fixed V1 state sequence and returns the standard artifact manifest", async () => {
    const seenStatuses: string[] = [];

    const result = await runPrdTask({
      userInput: "做一个帮助咖啡店把会员活动整理成 PRD 的桌面工具",
      workspaceRoot: undefined,
      outputRoot: undefined,
      webSearch: async () => ({
        results: [
          {
            title: "Membership product planning",
            url: "https://example.com/membership",
            snippet: "Loyalty workflows benefit from simple activation and redemption loops.",
            sourceType: "article",
          },
        ],
      }),
      provider: {
        generateJson: async ({ role }) => {
          if (role === "researcher") {
            return {
              summary: "会员活动需要明确触达、权益、兑换和复购路径。",
              key_findings: ["轻量会员体系需要低门槛启动。"],
              concepts: [{ name: "Activation", note: "首次参与动作。" }],
              competitor_samples: [{ name: "Local loyalty apps", note: "常见积分和权益组合。" }],
              sources: [
                {
                  title: "Membership product planning",
                  url: "https://example.com/membership",
                  reason: "补足会员活动概念",
                },
              ],
            };
          }
          if (role === "specialist") {
            return {
              role: "product_lead",
              summary: "首稿应先收束目标用户和核心闭环。",
              strengths: ["目标场景明确"],
              risks: ["活动规则可能过宽"],
              missing_sections: ["成功指标"],
              recommendations: ["先固定一个主活动类型"],
            };
          }
          return {
            task_type: "prd",
            confidence: "medium",
            assumptions: ["默认面向单店经营者。"],
            open_questions: ["是否需要多门店权限？"],
            final_prd_markdown: "# PRD 首稿\n\n## 目标\n帮助咖啡店形成会员活动方案。",
            artifact_manifest: [
              "01-final-prd.md",
              "02-assumptions-and-open-questions.md",
              "03-research-notes.md",
              "04-specialist-review.md",
            ],
          };
        },
      },
      onStatusChange: (status) => seenStatuses.push(status),
    });

    expect(seenStatuses).toEqual([
      "classifying",
      "preparing_context",
      "running_researcher",
      "running_specialist",
      "merging",
      "writing_outputs",
      "completed",
    ]);
    expect(result.task.templateId).toBe("prd");
    expect(result.task.selectedSpecialistRole).toBe("product_lead");
    expect(result.conductor.artifact_manifest).toEqual([
      "01-final-prd.md",
      "02-assumptions-and-open-questions.md",
      "03-research-notes.md",
      "04-specialist-review.md",
    ]);
  });
});
