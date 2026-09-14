import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { createModelPort } from '../src/providers/model';
import { DEFAULT_SETTINGS } from '../src/shared/defaults';
it('uses an actual compatible SSE transport with Chat Completions even for an automatically routed model name',async()=> {
  let path='';let input:Record<string,unknown>={};let authorization='';
  const server=createServer(async(req,res)=> {
    path=req.url || '';authorization=req.headers.authorization || '';let body='';for await(const chunk of req)body+=chunk;input=JSON.parse(body);
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    for(const chunk of [{id:'isolated',object:'chat.completion.chunk',created:1,model:'gpt-6',choices:[{index:0,delta:{role:'assistant',content:'公开结果'},finish_reason:null}]},{id:'isolated',object:'chat.completion.chunk',created:1,model:'gpt-6',choices:[{index:0,delta:{},finish_reason:'stop'}]}])res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const address=server.address();if(!address || typeof address==='string')throw new Error('missing address');
    const result=await createModelPort({kind:'openai-compatible',model:'gpt-6',baseUrl:`http://127.0.0.1:${address.port}/v1`},'isolated-key').generate({system:'公开答复',prompt:'隔离传输检查',member:DEFAULT_SETTINGS.team.members[0],json:false,signal:AbortSignal.timeout(5000),maxOutputTokens:256});
    expect(path).toBe('/v1/chat/completions');expect(input.stream).toBe(true);expect(input).not.toHaveProperty('stream_options');expect(authorization).toBe('Bearer isolated-key');expect(result.text).toBe('公开结果');expect(result.inputTokens).toBeUndefined();
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
