import type { AppNotification, AppSettings, EventInput, ProviderConfig, RunSnapshot, SettingsUpdate, SettingsView, SubmitRequest } from '../shared/contracts';
import { validateRpc, settingsSchema } from '../shared/validation';
import { Repository } from '../storage/repository';
import { runTeam } from '../core/team';
import { createModelPort } from '../providers/model';
import type { ModelPort } from '../core/model-port';
import type { CredentialVault } from './credentials';

export interface ServiceOptions { repository:Repository; credentials:CredentialVault; mode:'local'|'server'; dataDirectory:string; notify?:(event:AppNotification)=>void; modelFactory?:(config:ProviderConfig,key:string)=>ModelPort }
export class AppService {
  private providerCheck: {controller:AbortController;done:Promise<{ok:boolean;message:string}>}|undefined;
  private lastProviderCheck=0;
  private active=new Map<string,{workId:string;controller:AbortController;done:Promise<void>}>();
  constructor(readonly options:ServiceOptions) {}
  private changed(workId:string,runId?:string) { this.options.notify?.({workId,runId}); }
  getSettings():SettingsView {
    const settings=this.options.repository.getSettings();
    return {...settings, credential:{configured:Boolean(this.options.credentials.get(settings.provider)),source:this.options.credentials.source(settings.provider)},providerManaged:this.options.mode==='server',executionLocation:this.options.mode,dataDirectory:this.options.mode==='server'?'服务端工作空间':this.options.dataDirectory};
  }
  saveSettings(input:SettingsUpdate):SettingsView {
    input={...input,settings:settingsSchema.parse(input.settings)};
    this.options.repository.validateSettings(input.settings);
    const previous=this.options.repository.getSettings();
    if(this.options.mode==='server') {
      if(input.apiKey || input.removeKey || JSON.stringify(input.settings.provider)!==JSON.stringify(previous.provider)) throw new Error('AI 模型与凭据由服务端统一配置');
      if(input.settings.team.members.some(m=>m.model && m.model!==previous.provider.model)) throw new Error('该模型未由服务端开放，请使用服务端当前模型');
    }
    const changedProvider=JSON.stringify(previous.provider)!==JSON.stringify(input.settings.provider);
    if(input.apiKey?.trim()) this.options.credentials.set(input.settings.provider,input.apiKey.trim());
    if(input.removeKey) this.options.credentials.remove(input.settings.provider);
    if(changedProvider || input.apiKey || input.removeKey) for(const [runId] of this.active) this.stop(runId);
    this.options.repository.saveSettings(input.settings);
    this.changed('');
    return this.getSettings();
  }
  async submit(input:SubmitRequest):Promise<RunSnapshot> {
    if(this.active.size+(this.providerCheck?1:0)>=3 && ![...this.active.values()].some(r=>r.workId===input.workId)) throw new Error('已有三项工作正在处理，请等待或停止其中一项');
    const settings=this.options.repository.getSettings();
    const key=this.options.credentials.get(settings.provider);
    if(!key) throw new Error(this.options.mode==='server'?'服务端尚未配置可用模型凭据':'请先在设置中连接可用模型');
    const port=(this.options.modelFactory || createModelPort)(settings.provider,key);
    const run=this.options.repository.createRun(input,settings);
    for(const current of this.active.values()) if(current.workId===input.workId) current.controller.abort();
    const controller=new AbortController();
    const emit=(event:EventInput) => { this.options.repository.appendEvent(run.id,event);this.changed(run.workId,run.id); };
    const done=Promise.resolve().then(()=>runTeam(run,port,emit,controller.signal)).then(result=> {
      this.options.repository.completeRun(run.id,result);
    }).catch(error=> {
      const message=publicError(error);
      this.options.repository.finishRun(run.id,controller.signal.aborted?'stopped':'failed',controller.signal.aborted?'本地请求已停止；提供方是否停止处理未知':message);
      emit({type:'error',title:controller.signal.aborted?'已停止本地处理':'本轮未完成',body:controller.signal.aborted?'已有贡献已保留，远端是否停止未知。':message,key:'terminal-error'});
    }).finally(()=>{this.active.delete(run.id);this.changed(run.workId,run.id);});
    this.active.set(run.id,{workId:run.workId,controller,done});
    this.changed(run.workId,run.id);
    return run;
  }
  stop(runId:string):void {
    const run=this.options.repository.getRun(runId);
    const active=this.active.get(runId);
    if(!active) return;
    this.options.repository.finishRun(runId,'stopping','停止请求已发出，远端取消结果未知');
    active.controller.abort();
    this.changed(run.workId,run.id);
  }
  async testProvider():Promise<{ok:boolean;message:string}> {
    if(this.providerCheck || this.active.size>=3) return {ok:false,message:'已有连接检查或多项工作正在进行，请稍后再试'};
    if(Date.now()-this.lastProviderCheck<5000) return {ok:false,message:'请稍候再检查连接'};
    const s=this.options.repository.getSettings();const key=this.options.credentials.get(s.provider);
    if(!key) return {ok:false,message:'尚未配置模型凭据'};
    this.lastProviderCheck=Date.now();
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),20000);
    const done=(async()=> {
      try {
        const p=(this.options.modelFactory||createModelPort)(s.provider,key);
        const generation=p.generate({system:'这是连接检查，只回复 OK。',prompt:'回复 OK',member:s.team.members[0],json:false,signal:controller.signal,maxOutputTokens:256});
        let onAbort:()=>void=()=>{};
        const cancelled=new Promise<never>((_resolve,reject)=>{onAbort=()=>reject(new Error('连接检查已停止，提供方结果未知'));if(controller.signal.aborted)onAbort();else controller.signal.addEventListener('abort',onAbort,{once:true});});
        let result;
        try {result=await Promise.race([generation,cancelled]);} finally {controller.signal.removeEventListener('abort',onAbort);}
        if(controller.signal.aborted)throw new Error('连接检查已停止，提供方结果未知');
        if(!result.text.trim()) throw new Error('模型未返回可读正文');
        return {ok:true,message:'模型已返回真实响应'};
      } catch(error) {return {ok:false,message:publicError(error)};} finally {clearTimeout(timer);}
    })();
    this.providerCheck={controller,done};
    try {return await done;} finally {this.providerCheck=undefined;}
  }
  async dispatch(method:string,args:unknown,deviceId='desktop'):Promise<unknown> {
    const req=validateRpc(method,args);const a=req.args as never;const r=this.options.repository;
    let result:unknown;
    switch(req.method) {
      case 'listWorks': return r.listWorks();case 'getWork':return r.getWork(a,deviceId);
      case 'createWork':result=r.createWork(a);break;case 'renameWork':result=r.renameWork(a);break;case 'archiveWork':result=r.archiveWork(a);break;
      case 'submit':return this.submit(a);case 'stop':return this.stop(a);
      case 'saveDraft':return r.saveDraft(a,deviceId);case 'saveView':return r.saveView(a,deviceId);
      case 'saveArtifact':result=r.saveArtifact(a);break;case 'addMaterial':result=r.addMaterial(a);break;
      case 'getSettings':return this.getSettings();case 'saveSettings':return this.saveSettings(a);case 'testProvider':return this.testProvider();
    }
    this.changed(typeof req.args==='object' && req.args && 'workId' in req.args ? String(req.args.workId):'');
    return result;
  }
  async idle():Promise<void> {await Promise.all([...this.active.values()].map(x=>x.done));}
  async dispose():Promise<void> {for(const [id] of this.active) this.stop(id); this.providerCheck?.controller.abort(); await Promise.all([this.idle(),this.providerCheck?.done]);}
}
export function publicError(error:unknown):string {
  if(error instanceof Error && !/https?:\/\/|AIza|sk-|api[_ -]?key|authorization|bearer|headers|request body/i.test(error.message)) return error.message.slice(0,600);
  return '处理失败，请检查模型配置、网络与调用限制；敏感错误详情未写入工作记录。';
}
