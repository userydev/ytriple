import Fastify from 'fastify';
import { timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import type { AppNotification } from '../shared/contracts';
import { AppService, publicError, type ServiceOptions } from '../application/service';

export function createServer(options:Omit<ServiceOptions,'mode'|'notify'> & {token:string}) {
  if(options.token.length<24) throw new Error('服务访问令牌至少需要 24 个字符');
  const app=Fastify({logger:false,bodyLimit:1_200_000,requestTimeout:35000});
  const epoch=randomUUID();let cursor=0;
  const events:Array<{sequence:number;event:AppNotification}>=[];
  const waiting=new Set<()=>void>();
  const service=new AppService({...options,mode:'server',notify:event=> {
    events.push({sequence:++cursor,event});if(events.length>500) events.shift();
    for(const wake of [...waiting]) wake();
  }});
  const expected=createHash('sha256').update(`Bearer ${options.token}`).digest();
  app.addHook('onRequest',async(request,reply)=> {
    if(request.url==='/health') return;
    const actual=createHash('sha256').update(request.headers.authorization || '').digest();
    if(!timingSafeEqual(actual,expected)) return reply.code(401).send({error:'服务令牌无效或已失效，请重新连接'});
    if(request.headers.origin) return reply.code(403).send({error:'P1 服务仅接受原生客户端连接'});
  });
  app.get('/health',async()=>({ok:true,service:'ytriple',apiVersion:1}));
  app.post('/api/rpc',async(request,reply)=> {
    const body=request.body as {method?:unknown;args?:unknown}|null;
    const device=request.headers['x-ytriple-device'];
    if(typeof device!=='string' || !/^[\w-]{1,100}$/.test(device) || !body || typeof body.method!=='string') return reply.code(400).send({error:'请求格式无效'});
    try {return {result:(await service.dispatch(body.method,body.args,device)) ?? null};}
    catch(error) {return reply.code(400).send({error:publicError(error)});}
  });
  app.get('/api/events',async(request,reply)=> {
    const query=request.query as {after?:string;epoch?:string};const after=Number(query.after || 0);const changedEpoch=query.epoch!==epoch;
    if(!Number.isSafeInteger(after)||after<0) return reply.code(400).send({error:'通知位置无效'});
    if(after===cursor && !changedEpoch) await new Promise<void>(resolve=> {
      let timer:ReturnType<typeof setTimeout>;
      const wake=()=>{clearTimeout(timer);waiting.delete(wake);reply.raw.off('close',wake);resolve();};
      waiting.add(wake);reply.raw.once('close',wake);timer=setTimeout(wake,20000);
    });
    return {cursor,epoch,reset:changedEpoch || after>cursor || (events.length>0 && after<events[0].sequence-1),events:events.filter(e=>e.sequence>after).map(e=>e.event)};
  });
  app.setErrorHandler((_error,_request,reply)=>reply.code(400).send({error:'服务无法处理该请求'}));
  app.addHook('preClose',async()=>{for(const wake of [...waiting]) wake();await service.dispose();});
  return {app,service};
}
