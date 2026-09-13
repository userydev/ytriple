import type { MemberId } from "./types.js";

export interface MemberSettings {
  prompt: string;
  responseStyle: "concise" | "balanced" | "detailed";
  delegation: "auto" | "off";
}
export type MemberSettingsMap = Record<MemberId, MemberSettings>;
export const MEMBER_PROMPT_LIMIT = 12_000;
export const memberIds: MemberId[] = [
  "coordinator",
  "cto",
  "researcher",
  "editor",
];
const rolePrompts: Record<MemberId, string> = {
  editor:
    "你是内容编辑，负责原创表达、文章和脚本结构、镜头与制作说明、标题与内容承诺一致性。依据研究员提供的真实证据修订，不抄写对标、不保证流量或收益；不声称已经剪辑、发布或验证成片。",
  coordinator:
    "你是统筹与长期工作伙伴，理解目标、分配工作、比较成员意见并形成决策。",
  cto: "你是产品技术伙伴，负责产品雏形、需求边界、工程可行性、架构取舍与质量核查。",
  researcher:
    "你是研究员，负责阅读资料、证据核查、深入研究和知识扩展。区分事实、推断和待验证项。",
};
export function defaultMemberSettings(member: MemberId): MemberSettings {
  return {
    prompt: rolePrompts[member],
    responseStyle: "concise",
    delegation: "auto",
  };
}
export function normalizeMemberSettings(
  value: unknown,
  member: MemberId,
): MemberSettings {
  const fallback = defaultMemberSettings(member);
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fallback;
  const raw = value as Partial<MemberSettings>;
  return {
    prompt:
      typeof raw.prompt === "string"
        ? raw.prompt.trim().slice(0, MEMBER_PROMPT_LIMIT) || fallback.prompt
        : fallback.prompt,
    responseStyle:
      raw.responseStyle === "concise" ||
      raw.responseStyle === "balanced" ||
      raw.responseStyle === "detailed"
        ? raw.responseStyle
        : fallback.responseStyle,
    delegation:
      raw.delegation === "auto" || raw.delegation === "off"
        ? raw.delegation
        : fallback.delegation,
  };
}
export function normalizeTeamSettings(value: unknown): MemberSettingsMap {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Partial<MemberSettingsMap>)
      : {};
  return Object.fromEntries(
    memberIds.map((member) => [
      member,
      normalizeMemberSettings(raw[member], member),
    ]),
  ) as MemberSettingsMap;
}
