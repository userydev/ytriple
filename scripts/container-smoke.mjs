import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const token='isolated-container-check-token-123456789';
const cid=execFileSync('docker',['run','--rm','-d','-p','127.0.0.1::4317','-e',`YTRIPLE_SERVER_TOKEN=${token}`,'ytriple:p1-local'],{encoding:'utf8'}).trim();
try {
 let url;
 const address=()=>{url=`http://${execFileSync('docker',['port',cid,'4317/tcp'],{encoding:'utf8'}).trim()}`;};
 const ready=async()=>{address();for(let n=0;n<40;n++){try{if((await fetch(url+'/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,150));}throw new Error('container not ready');};await ready();
 const rpc=async(method,args)=>{const r=await fetch(url+'/api/rpc',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,'X-Ytriple-Device':'container-test'},body:JSON.stringify({method,args})});assert.equal(r.status,200);return (await r.json()).result;};
 assert.equal((await fetch(url+'/api/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
 const w=await rpc('createWork',{title:'隔离容器持久化',goal:'核对重启后的工作身份'});
 execFileSync('docker',['restart',cid],{stdio:'pipe'});await ready();
 assert.equal((await rpc('getWork',w.work.id)).work.title,'隔离容器持久化');
 console.log('Linux arm64容器：启动、认证、工作写入和重启后读取通过。');
} catch(error) {console.error(execFileSync('docker',['logs',cid],{encoding:'utf8'}));throw error;}
finally {execFileSync('docker',['rm','-fv',cid],{stdio:'pipe'});}
