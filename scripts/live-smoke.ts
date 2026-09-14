/** Explicit opt-in only; synthetic inputs, existing server-side environment credential. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Repository } from '../src/storage/repository';
import { EnvironmentCredentials } from '../src/application/credentials';
import { createServer } from '../src/server/server';
import { createRemoteApi } from '../src/client/remote';
for(const key of ['LANGCHAIN_TRACING','LANGCHAIN_TRACING_V2','LANGSMITH_TRACING','LANGCHAIN_VERBOSE']) process.env[key]='false';
if(process.env.YTRIPLE_LIVE_TEST!=='1') throw new Error('真实调用须显式设置 YTRIPLE_LIVE_TEST=1，仅运行隔离材料。');
const dir=mkdtempSync(join(tmpdir(),'ytriple-live-'));
const repository=new Repository(join(dir,'live.sqlite'));
const settings=repository.getSettings();if(process.env.YTRIPLE_MODEL)settings.provider.model=process.env.YTRIPLE_MODEL;
repository.saveSettings(settings);
const token=randomBytes(32).toString('hex');
const {app,service}=createServer({repository,credentials:new EnvironmentCredentials(),dataDirectory:dir,token});
const evidence:{model:string;date:string;checks:unknown[]}= {model:settings.provider.model,date:new Date().toISOString(),checks:[]};
try {
  const url=await app.listen({port:0,host:'127.0.0.1'});
  const desktop=createRemoteApi({serverUrl:url,token,deviceId:'live-desktop'});
  const mobile=createRemoteApi({serverUrl:url,token,deviceId:'live-mobile'});
  const created=await desktop.createWork({title:'隔离验收：周末读书会',goal:'依据提供的虚构材料，为一个周末读书会写一页可执行安排，明确尚需确认的问题。'});
  await desktop.addMaterial({workId:created.work.id,title:'虚构条件',content:'仅用于测试：参加者6人；场地周六14:00到16:00可用；预算120元；不购买书籍；现场提供饮用水。活动应有读书分享、讨论和简短回顾。不要查询外部来源。'});
  const run=await desktop.submit({workId:created.work.id,intent:'discuss',prompt:'请团队从活动流程和约束可行性两个角度协作，核查后输出简短的 Markdown 活动安排。'});
  await service.idle();
  let detail=await mobile.getWork(created.work.id);let actual=detail.runs.find(r=>r.id===run.id)!;
  evidence.checks.push({kind:'team-server-to-mobile',status:actual.status,error:actual.error,calls:actual.usage.calls,usage:actual.usage,eventTypes:[...new Set(detail.events.map(e=>e.type))],artifactCount:detail.artifacts.length});
  assert.equal(actual.status,'completed');assert.ok(detail.events.some(e=>e.type==='delegation'));assert.ok(detail.events.some(e=>e.type==='review'));assert.ok(detail.artifacts.some(a=>a.kind==='deliverable'));
  const event=detail.events.find(e=>e.type==='analysis')!;
  const explain=await mobile.submit({workId:created.work.id,intent:'explain',prompt:'请解释这一步采用了什么方法，并指出一个仍需我确认的具体条件。简短回答。',reference:{kind:'event',id:event.id},targetMemberId:event.memberId});
  await service.idle();detail=await desktop.getWork(created.work.id);actual=detail.runs.find(r=>r.id===explain.id)!;
  evidence.checks.push({kind:'mobile-followup-to-desktop',status:actual.status,error:actual.error,calls:actual.usage.calls,artifactVersions:detail.artifacts.map(a=>a.currentVersion)});
  assert.equal(actual.status,'completed');assert.ok(detail.artifacts.every(a=>a.currentVersion===1));
  console.log(JSON.stringify(evidence,null,2));
} catch(error) {console.error('隔离真实验收未通过；安全状态已记录，不输出提供方原始异常。');process.exitCode=1;}
finally {mkdirSync('test-results',{recursive:true});writeFileSync('test-results/live-evidence.json',JSON.stringify(evidence,null,2));await app.close();repository.close();rmSync(dir,{recursive:true,force:true});}
