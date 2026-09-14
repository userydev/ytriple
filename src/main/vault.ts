import { safeStorage } from 'electron';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { ProviderConfig } from '../shared/contracts';
import { EnvironmentCredentials, type CredentialVault } from '../application/credentials';
export class LocalVault implements CredentialVault {
  private environment=new EnvironmentCredentials();
  constructor(private file:string) {}
  private read():Record<string,string> {return existsSync(this.file)?JSON.parse(readFileSync(this.file,'utf8')) as Record<string,string>:{};}
  private key(c:ProviderConfig) {return createHash('sha256').update(c.kind+'|'+(c.kind==='gemini'?'google':c.baseUrl.replace(/\/$/,''))).digest('hex');}
  private writable() {if(!safeStorage.isEncryptionAvailable() || (process.platform==='linux' && safeStorage.getSelectedStorageBackend()==='basic_text')) throw new Error('系统安全存储不可用，请通过环境变量提供凭据');}
  getSecret(id:string):string|undefined {const value=this.read()[id];if(!value)return;this.writable();return safeStorage.decryptString(Buffer.from(value,'base64'));}
  putSecret(id:string,value:string):void {this.writable();const values=this.read();values[id]=safeStorage.encryptString(value).toString('base64');this.write(values);}
  private write(values:Record<string,string>) {writeFileSync(this.file+'.tmp',JSON.stringify(values),{mode:0o600});renameSync(this.file+'.tmp',this.file);}
  get(c:ProviderConfig) {return this.getSecret(this.key(c)) || this.environment.get(c);}
  source(c:ProviderConfig) {return this.read()[this.key(c)]?'encrypted' as const:this.environment.source(c);}
  set(c:ProviderConfig,key:string) {this.putSecret(this.key(c),key);}
  remove(c:ProviderConfig) {const values=this.read();delete values[this.key(c)];this.write(values);}
}
