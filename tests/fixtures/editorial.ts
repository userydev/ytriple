import type {
  EditorialBody,
  EditorialRevision,
} from "@ytriple/source-contract";
export const issueId = "9d02a816-8871-418b-9044-705b75163b35";
export function editorialBody(
  ids: string[] = ["material-a"],
  takeaway = "测试材料显示标价降低，但完成任务的成本还取决于成功率和重试次数。",
): EditorialBody {
  return {
    title: "标价变低，为什么还不能判断任务成本？",
    question: "单价变化和实际完成成本是什么关系？",
    takeaway,
    relationship: "成本比较需要相同任务和质量标准，标价只是其中一个条件。",
    sections: [
      {
        kind: "fact",
        heading: "已经知道什么",
        body: "测试公告提供了单价变化，没有提供完整任务评测。",
        sourceIds: ids,
      },
      {
        kind: "analysis",
        heading: "缺少哪一环",
        body: "只有同时知道成功率和重试消耗，才有依据比较完整任务成本。",
        sourceIds: ids,
      },
    ],
    uncertainties: ["缺少同一批任务的对照结果。"],
    watchFor: ["后续是否提供同条件、可复核的成功率与重试成本。"],
    sourceAppraisals: ids.map((itemId) => ({
      itemId,
      role: "primary",
      sharedOriginWith: null,
      note: "仅有测试公告，不能当作独立实测。",
    })),
  };
}
export function editorialRevision(
  overrides: Partial<EditorialRevision> = {},
): EditorialRevision {
  return {
    ...editorialBody(),
    id: "0382c0fb-c405-4253-ade7-39a0bf1d0c5c",
    issueId,
    version: 1,
    createdAt: "2026-09-12T20:00:00.000Z",
    changeKind: "new",
    changeSummary: "建立成本条件的初步理解。",
    model: "deterministic-test",
    evidence: [
      {
        itemId: "material-a",
        revisionId: "material-revision-a",
        contentHash: "a".repeat(64),
        title: "测试用单价公告",
        url: "https://example.com/test-announcement",
        sourceName: "测试官方来源",
        origin: "recommended",
        coverage: "metadata",
        missing: ["未取得全文"],
        observedAt: "2026-09-12T19:59:00.000Z",
        excerpt: "这是确定性测试材料：标价降低，未披露成功率。",
      },
    ],
    ...overrides,
  };
}

export function editorialPresentation(
  revision: EditorialRevision = editorialRevision(),
): import("@ytriple/source-contract").EditorialPresentation {
  return {
    revisionId: revision.id,
    headline: "单价下降，还不等于完成成本下降",
    summary: revision.relationship,
    visual: {
      kind: "comparison",
      title: "比较的是两种不同成本",
      items: [
        {
          label: "单次标价",
          text: "公告已经给出了变化",
          symbol: "cost",
          sectionIndex: 0,
          quote: revision.sections[0]!.body,
        },
        {
          label: "完成任务的成本",
          text: "仍取决于成功率与重试",
          symbol: "check",
          sectionIndex: 1,
          quote: revision.sections[1]!.body,
        },
      ],
      conclusion: "把同一任务和质量标准放在一起，才有比较的基础。",
    },
    boundary: {
      text: revision.uncertainties[0]!,
      quote: revision.uncertainties[0]!,
    },
    watch: { text: revision.watchFor[0]!, quote: revision.watchFor[0]! },
  };
}
