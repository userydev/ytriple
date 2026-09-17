import type { ArtifactVersion, OutputMode } from "./types";
export const outputLabels: Record<OutputMode, string> = {
  result: "主成果",
  method: "方法草案",
  readiness: "交接检查",
  explanation: "解释与追问",
  summary: "过程总结",
  review: "工作复盘",
};
export function resultKind(mode: OutputMode | undefined) {
  return mode === "summary" ||
    mode === "review" ||
    mode === "readiness" ||
    mode === "method"
    ? mode
    : "result";
}
export function versionLabel(version: ArtifactVersion) {
  return `${outputLabels[version.kind ?? "result"]} v${version.number}`;
}
export function outputInstruction(mode: OutputMode | undefined) {
  switch (mode) {
    case "method":
      return "本轮交付可试用的方法草案，作为独立支持成果，保持主成果不变。以清楚名称为一级标题，写明要解决的问题、适用范围与不适用条件、所需输入、可执行的步骤、每步完成证据、来自引用记录的实例与反例、为何修正及其依据、仍需验证的假设和试用检验方式。对关键经验引用准确的过程、成果或反馈记录编号，不补造未读材料、工具或内部推理，不把一次反馈推断为稳定因果。正文应能作为方法参考用于下一次任务；未知与临时建议明确标注，不宣称 Agent 已学会、方法稳定或效果验证通过。不自动改写长期方法、项目标准或权限。";
    case "readiness":
      return "本轮交付独立的 AI 交接检查意见。明确所检查版本、接收对象和用途，复述目标与输入条件，检查缺失材料、要求冲突、证据不足及歧义，区分阻塞项和可选改进。只依据已提供材料，区分用户陈述、附件所支持的事实与待验证推测；一次试读不能直接推出超时原因。缺少实际执行或接收证据时明确未知，不能认证可用、自动标记已交接或已验证。保留主成果，修订需另行提出。";
    case "explanation":
      return "本轮只解释或讨论所引用的公开过程、依据与问题，回答进入交流记录，不修改主成果。不得据此更改项目标准或宣称工具已执行。";
    case "summary":
      return "本轮交付过程总结，作为独立支持成果。只总结引用范围内实际记录的步骤、方法、成员贡献、分歧、决定与未完成部分，引用记录编号。没有公开分析时说明缺失；不得补造模型内部推理、真实工具动作或因果。当前主成果保持不变。";
    case "review":
      return "本轮交付工作复盘，作为独立支持成果。依据引用范围内的目标、公开过程、用户修正、成果和已记录反馈，逐项判断目标与实际结果差距，引用记录编号；区分观察、推断和建议，说明未完成与缺失证据。用户表达不自动等于验证结果，没有使用反馈不得宣称实际效果提升。不得事后补造内部推理，不自动采纳方法改进或更改项目标准。当前主成果保持不变。";
    default:
      return "";
  }
}
