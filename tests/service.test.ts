import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';import { join } from 'node:path';
import { Repository } from '../src/storage/repository';
import { AppService } from '../src/application/service';
import { EnvironmentCredentials } from '../src/application/credentials';
import { createServer } from '../src/server/server';
import { createRemoteApi } from '../src/client/remote';
import { controlledModel } from './helpers/model';
import { readConnection, writeConfig } from '../src/main/config-file';
const cleanup:Array<()=>Promise<unknown>|void>=[];afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
function store(){const dir=mkdtempSync(join(tmpdir(),'ytriple-api-'));const r=new Repository(join(dir,'test.sqlite'));cleanup.push(()=>{r.close();rmSync(dir,{recursive:true,force:true});});return {r,dir};}
function options(){const {r,dir}=store();return {repository:r,credentials:new EnvironmentCredentials({GEMINI_API_KEY:'isolated-fake'}),dataDirectory:dir,modelFactory:()=>controlledModel};}
describe('service boundary and device continuation',()=> {
  it('authenticates native clients, refuses browser origins and server provider mutation, and shares work with device drafts isolated',async()=> {
    const o=options();const token='isolated-service-token-123456789';const {app,service}=createServer({...o,token});cleanup.push(()=>app.close());const url=await app.listen({host:'127.0.0.1',port:0});
    expect((await app.inject({method:'POST',url:'/api/rpc',payload:{method:'listWorks'}})).statusCode).toBe(401);
    expect((await app.inject({method:'POST',url:'/api/rpc',headers:{authorization:`Bearer ${token}`,origin:'https://untrusted.test'},payload:{method:'listWorks'}})).statusCode).toBe(403);
    const desktop=createRemoteApi({serverUrl:url,token,deviceId:'desktop'}),mobile=createRemoteApi({serverUrl:url,token,deviceId:'phone'});
    const w=await desktop.createWork({title:'活动',goal:'制定活动安排'});await desktop.saveDraft({workId:w.work.id,draft:{intent:'discuss',text:'电脑草稿'}});
    expect((await mobile.getWork(w.work.id)).draft.text).toBe('');expect((await desktop.getWork(w.work.id)).draft.text).toBe('电脑草稿');
    const changes:unknown[]=[];const off=mobile.onChanged(e=>changes.push(e));cleanup.push(off);
    const run=await desktop.submit({workId:w.work.id,prompt:'写一份活动安排',intent:'discuss'});await service.idle();
    const detail=await mobile.getWork(w.work.id);expect(detail.runs.find(r=>r.id===run.id)?.status).toBe('completed');expect(detail.artifacts[0].currentVersion).toBe(1);expect(detail.events.some(e=>e.type==='delegation')).toBe(true);
    await vi.waitFor(()=>expect(changes.length).toBeGreaterThan(0));
    const settings=await desktop.getSettings();expect(settings.providerManaged).toBe(true);expect(JSON.stringify(settings)).not.toContain('isolated-fake');
    const {credential,dataDirectory,executionLocation,providerManaged,...editable}=settings;
    editable.provider.model='client-invented';await expect(desktop.saveSettings({settings:editable})).rejects.toThrow('服务端');
    expect(o.repository.getSettings().provider.model).not.toBe('client-invented');
  });
  it('validates all settings before modifying credentials or active work',async()=> {
    const o=options();const set=vi.fn();const service=new AppService({...o,mode:'local',credentials:{...o.credentials,get:()=> 'old',source:()=> 'encrypted',set,remove:vi.fn()}});
    const settings=o.repository.getSettings();settings.team.members[0].instructions='';
    expect(()=>service.saveSettings({settings,apiKey:'new-key'})).toThrow();expect(set).not.toHaveBeenCalled();expect(o.repository.getSettings().team.members[0].instructions).not.toBe('');
  });
  it('bounds provider checks and cancels them on service shutdown',async()=> {
    const o=options();const generate=vi.fn((request)=>new Promise<never>((_resolve,reject)=>request.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true})));
    const service=new AppService({...o,mode:'server',modelFactory:()=>({generate})});const pending=service.testProvider();
    expect((await service.testProvider()).ok).toBe(false);expect(generate).toHaveBeenCalledTimes(1);await service.dispose();expect((await pending).ok).toBe(false);
  });
  it('treats a lost response body as an uncertain submission, never automatically resubmitting',async()=> {
    const fetchMock=vi.fn(async()=>({ok:true,json:async()=>{throw new Error('body transfer lost');}} as unknown as Response));
    const api=createRemoteApi({serverUrl:'https://isolated.test',token:'fake',deviceId:'device',fetch:fetchMock});
    await expect(api.submit({workId:'w',prompt:'hello',intent:'discuss'})).rejects.toThrow('提交结果可能已保存');expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('recovers damaged connection configuration without touching the workspace',()=> {
    const {dir}=store();const path=join(dir,'connection.json');writeConfig(path,{mode:'local',deviceId:'device'});expect(readConnection(path).mode).toBe('local');
    writeFileSync(path,'{partial');expect(readConnection(path)).toEqual({});expect(readdirSync(dir).some(name=>name.startsWith('connection.json.damaged'))).toBe(true);
  });
});
