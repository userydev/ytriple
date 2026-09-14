import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
export function writeConfig(file:string,value:unknown):void {
  writeFileSync(file+'.tmp',JSON.stringify(value),{mode:0o600});renameSync(file+'.tmp',file);
}
export function readConnection(file:string):{mode?:'local'|'server';serverUrl?:string;deviceId?:string} {
  if(!existsSync(file))return {};
  try {
    const value=JSON.parse(readFileSync(file,'utf8'));
    if(!value || typeof value!=='object' || (value.mode!==undefined && !['local','server'].includes(value.mode)) || (value.serverUrl!==undefined && typeof value.serverUrl!=='string') || (value.deviceId!==undefined && !/^[\w-]{1,100}$/.test(value.deviceId))) throw new Error();
    return value;
  } catch {renameSync(file,file+`.damaged-${Date.now()}`);return {};}
}
