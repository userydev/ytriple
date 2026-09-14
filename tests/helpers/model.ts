import type { ModelPort } from '../../src/core/model-port';
export const controlledModel:ModelPort={async generate(request) {
  if(request.signal.aborted)throw new DOMException('aborted','AbortError');
  const stage=request.prompt.match(/^\[stage:(\w+)\]/)?.[1];
  const output:Record<string,unknown>={
    plan:{overview:'检查活动目标',method:'按流程与约束分工',requirements:'给出可用安排',tasks:[{id:'t1',memberId:'researcher',title:'整理活动流程',question:'对照时间边界安排活动',requirement:'保留时间用于回顾',sourceIds:[]}]},
    worker:'## 材料与方法\n先确认时间边界，再为分享、讨论和回顾安排时间。尚需确认参加者偏好。',
    review:{analysis:'已核对流程。参加者偏好仍待用户确认。',sourceIds:[],gaps:[],reworkTaskId:null},
    synthesize:{answer:'已完成活动安排，保留了回顾时间。参加者偏好仍待确认。',artifact:{title:'读书会活动安排',content:'# 活动安排\n\n14:00 分享；15:00 讨论；15:45 回顾。\n\n待确认：参加者偏好。'},changes:'采纳成员对回顾环节的建议。',replacements:[]},
    direct:'这一步按目标检查时间和内容是否相符，仍需确认参加者偏好。'
  };
  const value=output[stage || 'direct'];const text=typeof value==='string'?value:JSON.stringify(value);
  request.onText?.(text);return {text,inputTokens:10,outputTokens:20};
}};
