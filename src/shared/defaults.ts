import type { AppSettings, ViewState } from './contracts';
export const DEFAULT_SETTINGS: AppSettings = {
  version: 1, strategy: 'team-v1', provider: { kind: 'gemini', model: 'gemini-3.8-flash', baseUrl: '' },
  team: { version: 1, members: [
    { id: 'lead', name: '统筹', role: '目标与整合', instructions: '理解用户目标、组织分工，核查返回并形成可直接使用的结论与成果。' },
    { id: 'researcher', name: '研究员', role: '材料与依据', instructions: '认真阅读提供的材料，调查依据、约束与缺口；未取得的资料明确未知。' },
    { id: 'reviewer', name: '审阅员', role: '多视角核查', instructions: '从使用者与反例角度审查方案，指出具体未达要求之处，基于实际证据提出修正。' }
  ] },
  skills: [{ id: 'clear-work', name: '目标—依据—核查', version: '1.0.0', description: '先明确要求，对照材料和反例，检查成果是否满足目标。', instructions: '围绕实际任务明确目标和完成要求；区分材料事实、判断与未知；对照反例和限制核查；公开解释方法及不足；修订时说明修改依据。仅输出面向用户的分析，不输出隐藏思维链。', enabled: true, requires: [] }],
  limits: { maxCalls: 8, maxConcurrency: 2, timeoutMs: 180000, maxOutputTokens: 4096 }
};
export const DEFAULT_VIEW: ViewState = { focusedPane: 'all', activePane: 'conversation', widths: [34, 33, 33], scroll: {} };
