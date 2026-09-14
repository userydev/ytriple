import type { AppNotification, DesktopApi } from '../shared/contracts';
export type WorkApi = Omit<DesktopApi,'getConnection'|'saveConnection'|'importMaterials'>;
export interface RemoteOptions { serverUrl:string; token:string; deviceId:string; fetch?:typeof fetch }
function timedSignal(parent?:AbortSignal) {
  const controller=new AbortController();
  const abort=()=>controller.abort();
  if(parent?.aborted)abort();else parent?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(abort,30000);
  return {signal:controller.signal,dispose:()=>{clearTimeout(timer);parent?.removeEventListener('abort',abort);}};
}
export function createRemoteApi(options:RemoteOptions):WorkApi {
  const base=options.serverUrl.replace(/\/$/,'');
  const request=options.fetch || globalThis.fetch;
  const headers={'Authorization':`Bearer ${options.token}`,'Content-Type':'application/json','X-Ytriple-Device':options.deviceId};
  const rpc=async(method:string,args?:unknown):Promise<unknown>=> {
    let response:Response;let data:{result?:unknown;error?:string};const deadline=timedSignal();
    try {response=await request(`${base}/api/rpc`,{method:'POST',headers,body:JSON.stringify({method,args}),signal:deadline.signal});data=await response.json() as {result?:unknown;error?:string};} catch {throw new Error('服务连接中断；请重新读取工作状态后再决定是否重试，提交结果可能已保存。');} finally {deadline.dispose();}
    if(!response.ok) throw new Error(data.error || '服务暂时不可用');
    return data.result;
  };
  const api=Object.fromEntries(['listWorks','createWork','getWork','renameWork','archiveWork','submit','stop','saveDraft','saveView','saveArtifact','addMaterial','getSettings','saveSettings','testProvider'].map(method=>[method,(args?:unknown)=>rpc(method,args)])) as unknown as WorkApi;
  api.onChanged=(listener)=> {
    const controller=new AbortController();let cursor=0;let epoch='';
    void (async()=> {
      while(!controller.signal.aborted) {
        const deadline=timedSignal(controller.signal);
        try {
          const response=await request(`${base}/api/events?after=${cursor}&epoch=${encodeURIComponent(epoch)}`,{headers,signal:deadline.signal});
          if(!response.ok) throw new Error('unavailable');
          const data=await response.json() as {cursor:number;epoch:string;events:AppNotification[];reset?:boolean};
          cursor=data.cursor;epoch=data.epoch;
          if(data.reset) listener({workId:''});
          for(const event of data.events) listener(event);
        } catch {
          if(controller.signal.aborted) break;
          await new Promise<void>(resolve=>{const end=()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',end);resolve();};const timer=setTimeout(end,2000);controller.signal.addEventListener('abort',end,{once:true});});
        } finally {deadline.dispose();}
      }
    })();
    return ()=>controller.abort();
  };
  return api;
}
