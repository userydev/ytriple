import { afterEach, describe, expect, it } from 'vitest';
import { Repository } from '../src/storage/repository';
import { AppService } from '../src/application/service';
import { EnvironmentCredentials } from '../src/application/credentials';
import { createServer } from '../src/server/server';
import { createRemoteApi } from '../src/client/remote';
import { controlledModel } from './helpers/model';
import { isNotAcceptedError, notAcceptedMessage } from '../src/shared/error-protocol';
import type { ModelPort } from '../src/core/model-port';

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function serviceWith(repository: Repository, credentials: Record<string, string | undefined>, port: ModelPort = controlledModel) {
  return new AppService({ repository, credentials: new EnvironmentCredentials(credentials), mode: 'server', dataDirectory: 'isolated', modelFactory: () => port });
}

describe('submit acceptance outcome protocol', () => {
  it('recognizes a known rejection after Electron invoke error serialization', () => {
    const error = new Error("Error invoking remote method 'ytriple:request': Error: YTRIPLE_NOT_ACCEPTED:当前工作还没有可修订的成果");
    expect(isNotAcceptedError(error)).toBe(true);
    expect(notAcceptedMessage(error)).toBe('当前工作还没有可修订的成果');
  });

  it('does not interpret an arbitrary mention or unrelated IPC error as a rejection', () => {
    expect(isNotAcceptedError(new Error('网络错误，详情提到 YTRIPLE_NOT_ACCEPTED:未知'))).toBe(false);
    expect(isNotAcceptedError(new Error("Error invoking remote method 'another:request': Error: YTRIPLE_NOT_ACCEPTED:未知"))).toBe(false);
    expect(isNotAcceptedError(new Error("Error invoking remote method 'ytriple:request': Error: 服务连接中断"))).toBe(false);
  });

  it('marks missing credentials as not accepted and creates no run', async () => {
    const repository = new Repository(':memory:'); cleanups.push(() => repository.close());
    const service = serviceWith(repository, {}); cleanups.push(() => service.dispose());
    const work = repository.createWork({ title: '缺凭据', goal: '保留请求' }).work;
    let error: unknown;
    try { await service.submit({ workId: work.id, prompt: '开始', intent: 'discuss' }); } catch (caught) { error = caught; }
    expect(isNotAcceptedError(error)).toBe(true);
    expect(notAcceptedMessage(error)).toContain('尚未配置');
    expect(repository.getWork(work.id).runs).toHaveLength(0);
  });

  it('marks createRun validation rejection as not accepted and creates no run', async () => {
    const repository = new Repository(':memory:'); cleanups.push(() => repository.close());
    const service = serviceWith(repository, { GEMINI_API_KEY: 'isolated-key' }); cleanups.push(() => service.dispose());
    const work = repository.createWork({ title: '无成果修订', goal: '保留请求' }).work;
    let error: unknown;
    try { await service.submit({ workId: work.id, prompt: '修订', intent: 'revise' }); } catch (caught) { error = caught; }
    expect(isNotAcceptedError(error)).toBe(true);
    expect(notAcceptedMessage(error)).toContain('可修订的成果');
    expect(repository.getWork(work.id).runs).toHaveLength(0);
  });

  it('marks capacity rejection as not accepted and creates no run', async () => {
    const pending: ModelPort = { generate: () => new Promise(() => {}) };
    const repository = new Repository(':memory:'); cleanups.push(() => repository.close());
    const service = serviceWith(repository, { GEMINI_API_KEY: 'isolated-key' }, pending); cleanups.push(() => service.dispose());
    const works = [1, 2, 3, 4].map(number => repository.createWork({ title: `容量${number}`, goal: '保留请求' }).work);
    for (const work of works.slice(0, 3)) await service.submit({ workId: work.id, prompt: '开始', intent: 'explain' });
    let error: unknown;
    try { await service.submit({ workId: works[3].id, prompt: '超过容量', intent: 'explain' }); } catch (caught) { error = caught; }
    expect(isNotAcceptedError(error)).toBe(true);
    expect(repository.getWork(works[3].id).runs).toHaveLength(0);
  });

  it('preserves the not accepted marker through the server and remote client', async () => {
    const repository = new Repository(':memory:');
    const server = createServer({ repository, credentials: new EnvironmentCredentials({}), dataDirectory: 'isolated', token: 'isolated-submit-outcome-token-123456789', modelFactory: () => controlledModel });
    cleanups.push(() => repository.close()); cleanups.push(() => server.app.close());
    const url = await server.app.listen({ host: '127.0.0.1', port: 0 });
    const api = createRemoteApi({ serverUrl: url, token: 'isolated-submit-outcome-token-123456789', deviceId: 'device' });
    const work = await api.createWork({ title: '远程拒绝', goal: '保留请求' });
    let error: unknown;
    try { await api.submit({ workId: work.work.id, prompt: '开始', intent: 'discuss' }); } catch (caught) { error = caught; }
    expect(isNotAcceptedError(error)).toBe(true);
    expect(notAcceptedMessage(error)).toContain('尚未配置');
  });

  it('does not mark an error after createRun as not accepted', async () => {
    const failing: ModelPort = { generate: async () => { throw new Error('provider failed after acceptance'); } };
    const repository = new Repository(':memory:'); cleanups.push(() => repository.close());
    const service = serviceWith(repository, { GEMINI_API_KEY: 'isolated-key' }, failing); cleanups.push(() => service.dispose());
    const work = repository.createWork({ title: '已接受后失败', goal: '保留运行' }).work;
    const run = await service.submit({ workId: work.id, prompt: '开始', intent: 'explain' });
    await service.idle();
    expect(isNotAcceptedError(new Error(repository.getRun(run.id).error ?? ''))).toBe(false);
    expect(repository.getRun(run.id).status).toBe('failed');
  });
});
