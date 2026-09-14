import { z } from 'zod';
const id = z.string().min(1).max(120);
const text = z.string().max(200000);
const reference = z.object({ kind: z.enum(['event','artifact']), id, version: z.number().int().positive().optional(), quote: text.optional() }).strict();
const intent = z.enum(['discuss','change-goal','revise','explain','summarize','reflect']);
export const settingsSchema = z.object({
  version: z.number().int().nonnegative(), strategy: z.literal('team-v1'),
  provider: z.object({ kind: z.enum(['gemini','openai-compatible']), model: z.string().trim().min(1).max(200), baseUrl: z.string().max(2048) }).strict(),
  team: z.object({ version: z.number().int().nonnegative(), members: z.array(z.object({ id, name: z.string().trim().min(1).max(60), role: z.string().trim().min(1).max(200), instructions: z.string().max(10000), model: z.string().max(200).optional() }).strict()).min(2).max(6) }).strict(),
  skills: z.array(z.object({ id, name: z.string().min(1).max(100), version: z.string().min(1).max(100), description: z.string().max(2000), instructions: z.string().max(20000), enabled: z.boolean(), requires: z.array(z.string().max(100)).max(20) }).strict()).max(20),
  limits: z.object({ maxCalls: z.number().int().min(1).max(16), maxConcurrency: z.number().int().min(1).max(4), timeoutMs: z.number().int().min(1000).max(300000), maxOutputTokens: z.number().int().min(256).max(8192) }).strict()
}).strict().superRefine((s,c) => {
  if (new Set(s.team.members.map(m=>m.id)).size !== s.team.members.length) c.addIssue({code:'custom',message:'成员标识不能重复'});
  if (new Set(s.skills.map(m=>m.id)).size !== s.skills.length) c.addIssue({code:'custom',message:'Skill 标识不能重复'});
});
export const rpcSchemas = {
  listWorks: z.undefined(), getWork: id, createWork: z.object({title:z.string().trim().min(1).max(200),goal:text.min(1)}).strict(),
  renameWork: z.object({workId:id,title:z.string().trim().min(1).max(200)}).strict(), archiveWork:z.object({workId:id,archived:z.boolean()}).strict(),
  submit:z.object({workId:id,prompt:text.min(1),intent,targetMemberId:id.optional(),reference:reference.optional()}).strict(), stop:id,
  saveDraft:z.object({workId:id,draft:z.object({text,intent,targetMemberId:id.optional(),reference:reference.optional()}).strict()}).strict(),
  saveView:z.object({workId:id,view:z.object({focusedPane:z.enum(['all','conversation','process','result']).optional(),activePane:z.enum(['conversation','process','result']).optional(), widths:z.array(z.number().min(5).max(90)).length(3).optional(),artifactId:id.optional(),artifactVersion:z.number().int().positive().optional(),scroll:z.record(z.string().max(200),z.number().min(0).max(10000000)).optional(),eventMemberFilter:z.string().max(120).optional()}).strict()}).strict(),
  saveArtifact:z.object({workId:id,artifactId:id,baseVersion:z.number().int().positive(),content:text}).strict(),
  addMaterial:z.object({workId:id,title:z.string().trim().min(1).max(300),content:text.min(1)}).strict(),
  getSettings:z.undefined(),saveSettings:z.object({settings:settingsSchema,apiKey:z.string().max(10000).optional(),removeKey:z.boolean().optional()}).strict(),testProvider:z.undefined()
};
export type RpcMethod = keyof typeof rpcSchemas;
export function validateRpc(method: string, args: unknown): {method:RpcMethod;args:unknown} {
  if (!Object.hasOwn(rpcSchemas,method)) throw new Error('不支持的操作');
  const schema=rpcSchemas[method as RpcMethod];
  const result=schema.safeParse(args === null ? undefined : args);
  if(!result.success) throw new Error('输入格式无效，请检查目标、成员、版本或配置范围');
  return {method:method as RpcMethod,args:result.data};
}
export function normalizeServerUrl(value: string): string {
  const u=new URL(value);
  const privateHost = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[::1\])$/.test(u.hostname);
  if ((u.protocol!=='https:' && !(u.protocol==='http:' && privateHost)) || u.username || u.password || u.search || u.hash) throw new Error('服务地址须为 HTTPS；本机或局域网开发服务可用 HTTP');
  return u.toString().replace(/\/$/,'');
}
