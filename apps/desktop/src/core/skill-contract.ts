import { z } from "zod";
import type { Reference } from "./types";
export type MethodOrigin = {
  workId: string;
  workTitle: string;
  runId: string;
  versionId: string;
  versionHash: string;
  refs: Reference[];
};
export type SkillAdoption = {
  key: string;
  trialRunId: string;
  reason: string;
  acceptedAt: string;
};
export const skillDefinition = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(1000),
    body: z.string().trim().min(1).max(16000),
    dependencies: z.array(z.string().trim().min(1).max(500)).max(20),
  })
  .strict();
export type SkillDefinition = z.infer<typeof skillDefinition>;
export type SkillVersion = SkillDefinition & {
  id: string;
  version: number;
  createdAt: string;
  source: {
    kind: "builtin" | "local" | "copy" | "proposal";
    path?: string;
    sha256?: string;
    definitionHash?: string;
    fromKey?: string;
  };
  proposal?: MethodOrigin;
  importedProposal?: MethodOrigin;
};
export function isTrialMethod(s: SkillVersion, adoptions: SkillAdoption[]) {
  return (
    s.source.kind === "proposal" &&
    !adoptions.some((a) => a.key === skillKey(s))
  );
}
export type SkillState = { id: string; enabled: boolean };
export type SkillUse = {
  key: string;
  purpose: string;
  source: "requested" | "automatic";
};
export const skillKey = (s: SkillVersion) => `${s.id}@${s.version}`;
export function skillAvailability(s: SkillVersion, states: SkillState[]) {
  return states.find((x) => x.id === s.id)?.enabled === false
    ? "disabled"
    : s.dependencies.length
      ? "missing_dependency"
      : "ready";
}
export function availableSkills(
  run: { skills?: SkillVersion[]; requestedSkillKeys?: string[] },
  member: { skillKeys?: string[] },
) {
  return (run.skills ?? []).filter(
    (s) =>
      s.source.kind === "builtin" ||
      run.requestedSkillKeys?.includes(skillKey(s)) ||
      member.skillKeys?.includes(skillKey(s)),
  );
}
export function formatSkills(skills: SkillVersion[], uses: SkillUse[]) {
  return uses
    .map((u) => {
      const s = skills.find((s) => skillKey(s) === u.key);
      if (!s) throw Error("本轮缺少已指定的方法版本");
      return `【方法 ${s.name} / ${u.key} / 仅加载方法正文，未执行脚本或验证效果】\n用途：${u.purpose}\n适用条件：${s.description}\n${s.body}`;
    })
    .join("\n\n");
}
export const builtInSkills: SkillVersion[] = [
  {
    id: "builtin.reading",
    name: "资料消化",
    description:
      "用于摘要、节选与全文混合的资料，区分已读范围、来源主张和可支持结论。",
    body: "先列明实际读取范围，区分全文、摘要、链接和未读资料。按问题归纳各来源的主张、直接依据、时间和限制，保留冲突与来源对应关系。基于节选只能给有范围限制的结论；未知不补造。输出连贯理解、未解决分歧和可核查的下一步，不将转述变成亲自验证。",
    dependencies: [],
  },
  {
    id: "builtin.requirements",
    name: "需求澄清",
    description:
      "用于把目标转为可交接要求，辨认约束、取舍和仍需用户决定的条件。",
    body: "从现有目标中区分期望结果、硬限制、例子与建议。将要求落实为接收者能理解的输入、产出和验收证据；标明缺失信息及其影响。普通实现选择可以有依据地建议；不可替用户决定的重大冲突集中提出。不能把功能清单当成完整流程，需核对实际使用路径、失败与接续方式。",
    dependencies: [],
  },
  {
    id: "builtin.script-review",
    name: "脚本核查",
    description:
      "用于内容脚本、口播稿和制作说明，核对事实边界、受众表达和演练条件。",
    body: "核对每个事实主张的来源范围，将事实、推断、示例和表达建议区分。对照受众、用途与制作条件检查口语表达和连贯性。字数、语速、分镜数量和时长只是估算，不能保证效果或实测达标；需要完整演练或实际数据再验证。保留占位信息，明确哪些尚未核对，不补造反馈或发布情况。",
    dependencies: [],
  },
  {
    id: "builtin.handoff",
    name: "交接检查",
    description:
      "用于检查指定成果版本是否能被特定接收者理解，暴露材料、条件和证据缺口。",
    body: "明确指定版本、接收对象和用途，再复述其目标、输入条件和验收要求。只依据实际附带的正文与材料找缺失、冲突、歧义和证据不足，区分阻塞项和可选改进。用户记录、AI 检查意见、真实接收、执行和效果验证是不同事实；既无证据就保留未知。给出可操作修正建议，不自动改变正文、采用状态或长期标准。",
    dependencies: [],
  },
].map((s) => ({
  ...s,
  version: 1,
  createdAt: "2026-09-17T00:00:00.000Z",
  source: { kind: "builtin" as const },
}));

const requestSchema = z
  .object({
    key: z.string().min(1).max(300),
    purpose: z.string().trim().min(1).max(1000),
  })
  .strict();
export function parseSkillRequest(
  body: string,
): { key: string; purpose: string } | null {
  let value: unknown;
  try {
    value = JSON.parse(body.trim());
  } catch {
    if (/^\s*\{\s*"ytriple_skill"\s*:/.test(body))
      throw Error("方法加载请求不完整，已保留输出，不会自动重试");
    return null;
  }
  if (!value || typeof value !== "object" || !("ytriple_skill" in value))
    return null;
  return z.object({ ytriple_skill: requestSchema }).strict().parse(value)
    .ytriple_skill;
}
