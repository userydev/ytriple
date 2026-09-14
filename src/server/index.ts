import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Repository } from '../storage/repository';
import { EnvironmentCredentials } from '../application/credentials';
import { createServer } from './server';
for(const key of ['LANGCHAIN_TRACING','LANGCHAIN_TRACING_V2','LANGSMITH_TRACING','LANGCHAIN_VERBOSE']) process.env[key]='false';
const dataDirectory=resolve(process.env.YTRIPLE_DATA_DIR || '.ytriple-server');
mkdirSync(dataDirectory,{recursive:true,mode:0o700});
const tokenPath=resolve(dataDirectory,'access-token');
if(!process.env.YTRIPLE_SERVER_TOKEN && !existsSync(tokenPath)) writeFileSync(tokenPath,randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});
const token=process.env.YTRIPLE_SERVER_TOKEN || readFileSync(tokenPath,'utf8').trim();
const repository=new Repository(resolve(dataDirectory,'workspace.sqlite'));
repository.recoverInterruptedRuns();
const settings=repository.getSettings();
settings.provider={kind:process.env.YTRIPLE_PROVIDER==='openai-compatible'?'openai-compatible':'gemini',model:process.env.YTRIPLE_MODEL || 'gemini-3.8-flash',baseUrl:process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'};
repository.saveSettings(settings);
const {app}=createServer({repository,credentials:new EnvironmentCredentials(),dataDirectory,token});
try {
  const address=await app.listen({port:Number(process.env.PORT || 4317),host:process.env.YTRIPLE_HOST || '127.0.0.1'});
  console.log(`ytriple 服务已启动：${address}\n数据目录：${dataDirectory}\n访问令牌由 YTRIPLE_SERVER_TOKEN 或数据目录 access-token 文件管理，不输出至日志。`);
} catch {console.error('服务启动失败，请检查端口、数据目录和服务配置。');repository.close();process.exit(1);}
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{void app.close().then(()=>{repository.close();process.exit(0);});});
