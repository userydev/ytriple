import type { ProviderConfig } from '../shared/contracts';
export interface CredentialVault {
  get(config: ProviderConfig): string | undefined;
  source(config: ProviderConfig): 'environment' | 'encrypted' | 'none';
  set(config: ProviderConfig, key: string): void;
  remove(config: ProviderConfig): void;
}
export class EnvironmentCredentials implements CredentialVault {
  constructor(private env: Record<string,string|undefined> = process.env) {}
  get(config:ProviderConfig):string|undefined {
    if(config.kind==='gemini') return this.env.GEMINI_API_KEY || this.env.GOOGLE_API_KEY;
    const allowed=(this.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/,'');
    return config.baseUrl.replace(/\/$/,'')===allowed ? this.env.OPENAI_API_KEY : undefined;
  }
  source(config:ProviderConfig) { return this.get(config) ? 'environment' as const : 'none' as const; }
  set():void { throw new Error('模型凭据由服务端环境管理'); }
  remove():void { throw new Error('模型凭据由服务端环境管理'); }
}
