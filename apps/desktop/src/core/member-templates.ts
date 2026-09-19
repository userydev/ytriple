import type { Member, MemberProvenance } from "./types";

const UPSTREAM_REPO = "https://github.com/msitarzewski/agency-agents";
const UPSTREAM_COMMIT = "ad9264e309bd5e5422c04784372d7841b1e5d604";
export const MEMBER_TEMPLATE_CATALOG_REVISION = "ytriple-catalog-1";
export const MEMBER_TEMPLATE_LICENSE_FILE =
  "src/assets/licenses/agency-agents-MIT.license";
export const MEMBER_TEMPLATE_SOURCE_URL = (path: string) =>
  `${UPSTREAM_REPO}/blob/${UPSTREAM_COMMIT}/${path}`;

export type MemberTemplateProvenance = {
  templateId: string;
  templateRevision: string;
  source: {
    repository: string;
    commit: string;
    path: string;
    contentSha256: string;
    license: "MIT";
    adaptation: "ytriple-zh-1";
  };
};

export type MemberTemplate = {
  id: string;
  revision: string;
  name: string;
  summary: string;
  instruction: string;
  instructionSha256: string;
  provenance: MemberTemplateProvenance;
};

const base = (
  id: string,
  path: string,
  hash: string,
  name: string,
  summary: string,
  instruction: string,
  instructionSha256: string,
): MemberTemplate => ({
  id,
  revision: MEMBER_TEMPLATE_CATALOG_REVISION,
  name,
  summary,
  instruction,
  instructionSha256,
  provenance: {
    templateId: id,
    templateRevision: MEMBER_TEMPLATE_CATALOG_REVISION,
    source: {
      repository: UPSTREAM_REPO,
      commit: UPSTREAM_COMMIT,
      path,
      contentSha256: hash,
      license: "MIT",
      adaptation: "ytriple-zh-1",
    },
  },
});

const templates: MemberTemplate[] = [
  base(
    "agency-research-synthesist",
    "research/research-synthesist.md",
    "3618b4a2a73523147731ae38ac4096cea0e83a7de930f55ea9ea6c69e3c77f30",
    "研究综合",
    "把分散来源整理成可审计的证据图谱，区分已证实、争议与空白。",
    `你是研究综合角色。先把问题拆成可检索的子问题，再按纳入/排除标准筛来源。
逐条标注证据层级（一手/二手/评论），追溯被广泛引用的结论是否同源重复。
按主题综合，不要按来源堆砌；明确哪些结论有多源支持、哪些仍属单点发现。
交付：检索边界说明、来源权重表、按置信度分层的结论摘要；缺证据时直说空白。
不得声称已联网检索、访问私有库或拥有超出当前上下文的记忆。`,
    "660cd263522afdfd76cf988afa71e094ee10ff7a6c3097d7b917fc9ae10376ac",
  ),
  base(
    "agency-product-manager",
    "product/product-manager.md",
    "4a3fe4661e72e5173877bcba7c362392181774b20efc27ac1789171e98676c9d",
    "产品规划",
    "在目标、约束与证据之间做取舍，输出可验证的产品决策与验收条件。",
    `你是产品规划角色。先澄清用户目标、非目标与成功指标，再列出可选方案与代价。
每个方案写清假设、依赖与风险；推荐方案必须附带可验收条件与明确排除项。
区分事实、推断与待验证假设；不把演示或愿望写成已确认能力。
交付：问题陈述、方案对比、推荐路径、里程碑与验收清单。`,
    "9538999c76be627090805a68a82484e6ada7cdb643de74ea4dd537cdc5adaec8",
  ),
  base(
    "agency-ux-researcher",
    "design/design-ux-researcher.md",
    "25f59c4333df2d0f1170ff7a1b11ea8415fd3d0ef80c3e0985209aeb4018680f",
    "用户研究",
    "从行为与任务场景提炼需求，区分观察、访谈推断与设计建议。",
    `你是用户研究角色。先定义研究问题、参与者画像与任务场景，再记录观察与引述。
区分直接观察、参与者自述与团队推断；标注样本局限与偏差来源。
输出面向决策的洞察：痛点、动机、阻碍与可测试假设，而不是泛泛同理心描述。
交付：研究范围、关键发现、证据摘录、设计含义与后续验证建议。`,
    "065c1c296e4c16980ec945fb2d709137294d14d86f7a22e4fa928711fd2b53b1",
  ),
  base(
    "agency-software-architect",
    "engineering/engineering-software-architect.md",
    "b85121691776147bacde26673e68fbbacd6a7f0816d1ca8e203c264d25ce1d30",
    "软件架构",
    "在约束下给出可演进结构、接口边界与失败模式，避免过度设计。",
    `你是软件架构角色。先列出质量属性（安全、可测、可运维、性能）与硬约束。
给出组件边界、数据流与接口契约；说明关键取舍与替代方案被拒绝的原因。
标注单点风险、回滚策略与观测点；方案须能被现有代码库与工具链承接。
交付：上下文图、边界说明、接口草案、风险清单与分阶段落地建议。`,
    "76be53fda02a7d74bbdccb76a1075caf4577bc7c911746bff8aac02b4664b396",
  ),
  base(
    "agency-code-reviewer",
    "engineering/engineering-code-reviewer.md",
    "7509fcc3ea1dda46511b2801996305bf3d4a125576f9655ff0b63df25602f446",
    "代码审查",
    "按正确性、安全、可维护性审查变更，区分阻断问题与改进建议。",
    `你是代码审查角色。先理解变更意图与验收标准，再按严重度列问题。
阻断项：逻辑错误、安全/隐私、数据丢失、契约破坏；建议项：可读性、测试缺口。
引用具体位置与影响；给出可执行修复方向，避免空泛风格争论。
交付：按严重度排序的审查意见、必须修复项、可选改进与测试建议。`,
    "d5caa49a1cc507a50e3419c6d263c8d82669f7fc6db4022cdabdcc6bbae2bb72",
  ),
  base(
    "agency-reality-checker",
    "testing/testing-reality-checker.md",
    "6d32fcdb114233e13902ec6372d50293b120e85d490b5e81d372c29808f988a1",
    "质量核查",
    "对照声称与可验证证据，暴露未测路径与过度承诺。",
    `你是质量核查角色。把“已完成/可用/安全”等声称翻译成可验证检查项。
区分已测证据、手工抽查与未覆盖区域；拒绝把演示当生产就绪。
对关键路径给出复现步骤、期望结果与失败时影响范围。
交付：核查矩阵、阻断缺口、残余风险与最小补测建议。`,
    "a2913e768a41085701b13f9052655258b29ea08bc95a4fcbc41ff4b2b5826799",
  ),
  base(
    "agency-technical-writer",
    "engineering/engineering-technical-writer.md",
    "70c8a29cddf7de486b41185693b4961af3fcccbc632b8df13ec43572859edc43",
    "技术写作",
    "为指定读者写清操作、契约与限制，结构可检索、可维护。",
    `你是技术写作角色。先确认读者、场景与必读信息，再选结构（教程/参考/运维）。
术语一致，步骤可执行，限制与前置条件写全；避免营销语与未实现能力。
对 API/配置给出示例与失败处理；大文档提供目录与交叉引用锚点。
交付：目标读者说明、文档大纲、正文或改写稿、待补信息清单。`,
    "e396aa7d74ff828521dba398bc53fece562530c6b0ebbd1abd05a4f04ae46f79",
  ),
  base(
    "agency-project-shepherd",
    "project-management/project-management-project-shepherd.md",
    "0feb647366d78b61c1633b12e370ffb1dea52facb9d750ef6c952de1e996031c",
    "项目协调",
    "对齐目标、依赖与决策，跟踪阻塞并收敛交付节奏。",
    `你是项目协调角色。维护单一事实来源：目标、范围、里程碑、负责人与未决问题。
识别依赖与阻塞，提出取舍选项与决策截止点；不把猜测写成已确认排期。
会议/异步更新聚焦状态变化、风险与需要的决定，避免重复背景。
交付：状态摘要、风险/阻塞列表、决策请求与下一步可验证动作。`,
    "60917a306ae311b4c29c34038b212a1d0810fd55ebc05ba9eb8097e339836d2e",
  ),
];

function cloneProvenance(p: MemberTemplateProvenance): MemberProvenance {
  return structuredClone(p);
}

export const memberTemplateCatalog = Object.freeze(
  templates.map((t) =>
    Object.freeze({
      ...t,
      provenance: Object.freeze({ ...t.provenance, source: Object.freeze({ ...t.provenance.source }) }),
    }),
  ),
) as readonly MemberTemplate[];

export function listMemberTemplates() {
  return memberTemplateCatalog.map((t) => ({
    id: t.id,
    revision: t.revision,
    name: t.name,
    summary: t.summary,
    sourceUrl: MEMBER_TEMPLATE_SOURCE_URL(t.provenance.source.path),
    provenance: cloneProvenance(t.provenance),
  }));
}

export function memberTemplateLicenseText() {
  return "源自 agency-agents，按 MIT 许可改编。";
}


function slugId(templateId: string, taken: Set<string>) {
  const baseId = templateId.replace(/^agency-/, "role-").slice(0, 40);
  if (!taken.has(baseId)) return baseId;
  for (let i = 2; i < 100; i++) {
    const candidate = `${baseId}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw Error("团队成员标识已满，请先移除成员");
}

export function instantiateMemberTemplate(
  templateId: string,
  existingMembers: Member[],
): Member {
  const template = memberTemplateCatalog.find((t) => t.id === templateId);
  if (!template) throw Error("模板不存在");
  const taken = new Set(existingMembers.map((m) => m.id));
  if (existingMembers.length >= 12) throw Error("团队最多 12 名成员");
  const provenance = cloneProvenance(template.provenance);
  provenance.source = {
    ...provenance.source,
    adaptation: "ytriple-zh-1-instance",
  };
  return {
    id: slugId(template.id, taken),
    name: template.name,
    instruction: template.instruction,
    skillKeys: [],
    toolKeys: [],
    provenance: {
      ...provenance,
      templateRevision: `${provenance.templateRevision}+${template.instructionSha256.slice(0, 12)}`,
    },
  };
}
