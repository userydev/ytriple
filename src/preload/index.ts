import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, AppNotification } from '../shared/contracts';
const methods=['getConnection','saveConnection','listWorks','createWork','getWork','renameWork','archiveWork','submit','stop','saveDraft','saveView','saveArtifact','addMaterial','importMaterials','getSettings','saveSettings','testProvider'] as const;
const api=Object.fromEntries(methods.map(method=>[method,(args?:unknown)=>ipcRenderer.invoke('ytriple:request',method,args)])) as unknown as DesktopApi;
api.onChanged=(listener)=>{const handler=(_event:unknown,event:AppNotification)=>listener(event);ipcRenderer.on('ytriple:changed',handler);return ()=>ipcRenderer.removeListener('ytriple:changed',handler);};
contextBridge.exposeInMainWorld('ytriple',api);
