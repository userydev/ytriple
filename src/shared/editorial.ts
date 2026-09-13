import type { EditorialRevision } from "@ytriple/source-contract";

/** Preserve the interpretation and exactly the evidence available to its author. */
export function editorialDocument(revision: EditorialRevision): string {
  return [
    `# ${revision.title}`,
    `议题：${revision.issueId}\n版本：${revision.id}（v${revision.version}）\n制作时间：${revision.createdAt}`,
    revision.question,
    revision.takeaway,
    revision.relationship,
    ...revision.sections.map(
      (section) =>
        `## ${section.heading}\n\n${section.kind === "fact" ? "材料所述" : "分析"}：${section.body}\n\n依据：${section.sourceIds.join("、")}`,
    ),
    `## 尚不能确定\n\n${revision.uncertainties.map((value) => `- ${value}`).join("\n")}`,
    `## 继续观察\n\n${revision.watchFor.map((value) => `- ${value}`).join("\n")}`,
    `## 本次变化\n\n${revision.changeSummary}`,
    "## 当时使用的材料\n\n以下仅为服务器实际取得并交给栏目作者的文本范围；不能据此声称读过完整论文、图片或视频。",
    ...revision.evidence.map((material) => {
      const appraisal = revision.sourceAppraisals.find(
        (source) => source.itemId === material.itemId,
      );
      return `### ${material.title}\n\n来源：${material.sourceName}\n网址：${material.url}\n条目：${material.itemId}\n修订：${material.revisionId}\n内容 hash：${material.contentHash}\n发布时间：${material.publishedAt ?? "未提供"}\n取得时间：${material.observedAt}\n覆盖：${material.coverage}\n缺口：${material.missing.join("；") || "未报告"}\n来源判断：${appraisal?.note ?? "未作为正文依据"}\n\n${material.excerpt}`;
    }),
  ].join("\n\n");
}
