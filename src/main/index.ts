import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { join, resolve } from 'node:path';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Repository } from '../storage/repository';
import { AppService, publicError } from '../application/service';
import { LocalVault } from './vault';
import { readConnection, writeConfig } from './config-file';
import { createRemoteApi, type WorkApi } from '../client/remote';
import { normalizeServerUrl, validateRpc } from '../shared/validation';
import type { AppNotification, ConnectionConfig, ConnectionView, Material } from '../shared/contracts';
for(const key of ['LANGCHAIN_TRACING','LANGCHAIN_TRACING_V2','LANGSMITH_TRACING','LANGCHAIN_VERBOSE']) process.env[key]='false';
app.setPath('userData',process.env.YTRIPLE_DESKTOP_DATA_DIR ? resolve(process.env.YTRIPLE_DESKTOP_DATA_DIR) : join(app.getPath('appData'),'ytriple-p1'));
let window:BrowserWindow|null=null;
let service:AppService|undefined;let repository:Repository|undefined;let remote:WorkApi|undefined;let unsubscribe:(()=>void)|undefined;
let vault:LocalVault;let directory:string;let connection:ConnectionView;let deviceId:string;let quitting=false;
const notify=(event:AppNotification)=>{if(window && !window.isDestroyed()) window.webContents.send('ytriple:changed',event);};
const tokenId=(url:string)=>'server-'+createHash('sha256').update(url).digest('hex');
const connectionView=():ConnectionView=>({...connection,configured:connection.mode==='local' || Boolean(connection.serverUrl && getToken())});
function getToken():string|undefined {return (process.env.YTRIPLE_SERVER_URL?.replace(/\/$/,'')===connection.serverUrl ? process.env.YTRIPLE_SERVER_TOKEN:undefined) || vault.getSecret(tokenId(connection.serverUrl));}
function workApi():WorkApi {
  if(connection.mode==='server') {
    if(!connection.serverUrl || !getToken()) throw new Error('请先在设置中连接服务，或选择本地模式');
    if(!remote) {remote=createRemoteApi({serverUrl:connection.serverUrl,token:getToken()!,deviceId});unsubscribe=remote.onChanged(notify);}
    return remote;
  }
  if(!service) {repository=new Repository(join(directory,'workspace.sqlite'));repository.recoverInterruptedRuns();service=new AppService({repository,credentials:vault,mode:'local',dataDirectory:directory,notify});}
  return new Proxy({},{get:(_target,name)=>name==='onChanged'?()=>()=>{}:(args:unknown)=>service!.dispatch(String(name),args,deviceId)}) as WorkApi;
}
async function saveConnection(input:unknown):Promise<ConnectionView> {
  const c=z.object({mode:z.enum(['local','server']),serverUrl:z.string().max(2048),token:z.string().max(10000).optional()}).strict().parse(input) as ConnectionConfig;
  const url=c.mode==='server'?normalizeServerUrl(c.serverUrl):c.serverUrl;
  if(c.mode==='server') {
    const token=c.token?.trim() || (url===connection.serverUrl?getToken():vault.getSecret(tokenId(url)));
    if(!token) throw new Error('请输入该服务的访问令牌');
    await createRemoteApi({serverUrl:url,token,deviceId}).getSettings();
    if(c.token?.trim()) vault.putSecret(tokenId(url),c.token.trim());
  }
  unsubscribe?.();unsubscribe=undefined;remote=undefined;
  connection={mode:c.mode,serverUrl:url,configured:true};
  writeConfig(join(directory,'connection.json'),{mode:connection.mode,serverUrl:connection.serverUrl,deviceId});
  notify({workId:''});return connectionView();
}
app.whenReady().then(()=> {
  directory=app.getPath('userData');mkdirSync(directory,{recursive:true,mode:0o700});vault=new LocalVault(join(directory,'credentials.enc.json'));
  const stored=readConnection(join(directory,'connection.json'));
  deviceId=stored.deviceId || `desktop-${randomUUID()}`;
  connection={mode:stored.mode || 'server',serverUrl:process.env.YTRIPLE_SERVER_URL || stored.serverUrl || '',configured:false};
  // Persist identity even before the first connection; drafts are device-scoped on the server.
  writeConfig(join(directory,'connection.json'),{...stored,deviceId});
  const rendererFile=join(__dirname,'../renderer/index.html');
  const allowedUrl=process.env.ELECTRON_RENDERER_URL || pathToFileURL(rendererFile).toString();
  window=new BrowserWindow({width:1540,height:980,minWidth:900,minHeight:650,title:'ytriple',backgroundColor:'#f8f7f4',show:false,webPreferences:{preload:join(__dirname,'../preload/index.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  window.webContents.session.webRequest.onBeforeRequest((details,callback)=> {
    if(details.webContentsId!==window?.webContents.id)return callback({cancel:false});
    const url=new URL(details.url);const allowed=new URL(allowedUrl);
    const permitted=url.protocol==='file:' || url.protocol==='data:' || (Boolean(process.env.ELECTRON_RENDERER_URL) && url.hostname===allowed.hostname && url.port===allowed.port && ['http:','ws:'].includes(url.protocol));
    callback({cancel:!permitted});
  });
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',(event,url)=>{if(url!==allowedUrl)event.preventDefault();});
  ipcMain.handle('ytriple:request',async(event,method:unknown,args:unknown)=> {
    if(!window || event.sender!==window.webContents || event.senderFrame!==window.webContents.mainFrame || event.senderFrame.url.split('#')[0]!==allowedUrl.split('#')[0]) throw new Error('不允许的调用来源');
    try {
      if(method==='getConnection')return connectionView();
      if(method==='saveConnection')return await saveConnection(args);
      if(method==='importMaterials') {
        const workId=z.string().min(1).max(120).parse(args);const api=workApi();await api.getWork(workId);
        const selected=await dialog.showOpenDialog(window,{title:'导入本轮工作材料',properties:['openFile','multiSelections'],filters:[{name:'文本材料',extensions:['md','txt','json','csv']}]});
        if(selected.canceled)return [];
        const inputs=selected.filePaths.map(path=>{if(statSync(path).size>800000)throw new Error('材料过大，请拆分为小于 20 万字的文本');const content=readFileSync(path,'utf8');if(content.includes('\0')||content.length>200000)throw new Error('请选择不超过 20 万字的纯文本材料');return {workId,title:path.split(/[\\/]/).pop()!,content};});
        const materials:Material[]=[];for(const input of inputs)materials.push(await api.addMaterial(input));return materials;
      }
      if(typeof method!=='string')throw new Error('不支持的操作');
      const request=validateRpc(method,args);const api=workApi();
      return await (api[request.method] as (input:unknown)=>Promise<unknown>)(request.args);
    } catch(error) {throw new Error(publicError(error));}
  });
  window.once('ready-to-show',()=>window?.show());
  if(process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);else void window.loadFile(rendererFile);
}).catch(()=>{dialog.showErrorBox('启动失败','无法初始化 ytriple 数据目录或安全存储。');app.quit();});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',event=>{if(quitting)return;event.preventDefault();quitting=true;unsubscribe?.();void (service?.dispose() || Promise.resolve()).finally(()=>{repository?.close();app.quit();});});
