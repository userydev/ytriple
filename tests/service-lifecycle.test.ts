import { afterEach, describe, expect, it, vi } from 'vitest';
import { Repository } from '../src/storage/repository';
import { AppService } from '../src/application/service';
import { EnvironmentCredentials } from '../src/application/credentials';
import { createServer } from '../src/server/server';
import { createRemoteApi } from '../src/client/remote';
import type { ModelPort, ModelRequest, ModelResponse } from '../src/core/model-port';
import { controlledModel } from './helpers/model';

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function setup(port: ModelPort = controlledModel) {
  const repository = new Repository(':memory:');
  const service = new AppService({
    repository, credentials: new EnvironmentCredentials({ GEMINI_API_KEY: 'isolated-fixture-key' }),
    mode: 'server', dataDirectory: 'isolated-memory', modelFactory: () => port,
  });
  cleanup.push(() => repository.close());
  cleanup.push(() => service.dispose());
  return { repository, service };
}
function pendingUntilAbort(request: ModelRequest): Promise<ModelResponse> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException('isolated cancellation', 'AbortError'));
    if (request.signal.aborted) abort();
    else request.signal.addEventListener('abort', abort, { once: true });
  });
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('service lifecycle, cancellation and notification recovery', () => {
  it('accepts replacement of one active work at capacity while keeping unrelated work running', async () => {
    const { repository, service } = setup({ generate: pendingUntilAbort });
    const works = [1, 2, 3].map((number) => repository.createWork({ title: `并行工作 ${number}`, goal: '隔离生命周期验证' }).work);
    const runs = [];
    for (const work of works) runs.push(await service.submit({ workId: work.id, prompt: '先解释要求', intent: 'explain' }));
    const replacement = await service.submit({ workId: works[0].id, prompt: '新的明确目标', intent: 'change-goal' });
    expect(repository.getRun(runs[0].id).status).toBe('superseded');
    expect(repository.getRun(replacement.id)).toMatchObject({ status: 'running', goalRevision: 2, goal: '新的明确目标' });
    expect(repository.getRun(runs[1].id).status).toBe('running');
    expect(repository.getRun(runs[2].id).status).toBe('running');
    const overflow = repository.createWork({ title: '第四项', goal: '不应开始' }).work;
    await expect(service.submit({ workId: overflow.id, prompt: '超过并发容量', intent: 'explain' })).rejects.toThrow('正在处理');
    expect(repository.getWork(overflow.id).runs).toHaveLength(0);
  });

  it('stopping during final synthesis preserves prior output even when the provider later ignores cancellation', async () => {
    const synthesis = deferred<ModelResponse>();
    const arrived = deferred<void>();
    let hold = false;
    let heldRequest: ModelRequest | undefined;
    const port: ModelPort = { generate: async (request) => {
      if (hold && request.prompt.startsWith('[stage:synthesize]')) {
        heldRequest = request; arrived.resolve();
        // This fixture deliberately represents a remote provider that ignores AbortSignal.
        return synthesis.promise;
      }
      return controlledModel.generate(request);
    } };
    const { repository, service } = setup(port);
    const work = repository.createWork({ title: '停止验收', goal: '保留已完成成果' }).work;
    await service.submit({ workId: work.id, prompt: '生成初始成果', intent: 'discuss' }); await service.idle();
    const previous = repository.getWork(work.id).artifacts[0];
    hold = true;
    const stopped = await service.submit({ workId: work.id, prompt: '继续讨论等待停止', intent: 'discuss' });
    await arrived.promise;
    service.stop(stopped.id); await service.idle();
    expect(repository.getRun(stopped.id).status).toBe('stopped');
    expect(heldRequest?.signal.aborted).toBe(true);
    expect(repository.getRun(stopped.id).usage).toMatchObject({ calls: 4, known: false });
    synthesis.resolve({ text: JSON.stringify({ answer: '迟到结果', artifact: { title: '不应覆盖', content: '停止后的内容' }, changes: '', replacements: [] }), inputTokens: 50, outputTokens: 50 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const after = repository.getWork(work.id);
    expect(after.runs.find((run) => run.id === stopped.id)?.status).toBe('stopped');
    expect(after.artifacts[0]).toEqual(previous);
    expect(after.messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
    expect(after.events.filter((event) => event.runId === stopped.id && event.streaming)).toHaveLength(0);
  });

  it('a corrected goal can complete before the obsolete provider response without losing the current artifact', async () => {
    const obsolete = deferred<ModelResponse>(); const arrived = deferred<void>();
    let blockNextSynthesis = true;
    const port: ModelPort = { generate: async (request) => {
      if (blockNextSynthesis && request.prompt.startsWith('[stage:synthesize]')) {
        blockNextSynthesis = false; arrived.resolve(); return obsolete.promise;
      }
      return controlledModel.generate(request);
    } };
    const { repository, service } = setup(port);
    const work = repository.createWork({ title: '目标纠正', goal: '旧目标' }).work;
    const old = await service.submit({ workId: work.id, prompt: '先处理旧目标', intent: 'discuss' });
    await arrived.promise;
    const current = await service.submit({ workId: work.id, prompt: '按新目标重新组织', intent: 'change-goal' });
    await service.idle();
    expect(repository.getRun(old.id).status).toBe('superseded');
    expect(repository.getRun(current.id)).toMatchObject({ status: 'completed', goalRevision: 2 });
    obsolete.resolve({ text: JSON.stringify({ answer: '旧目标迟到', artifact: { title: '旧版成果', content: '失效目标正文' }, changes: '', replacements: [] }), inputTokens: 10, outputTokens: 20 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const detail = repository.getWork(work.id);
    expect(detail.artifacts[0].versions).toHaveLength(1);
    expect(detail.artifacts[0].versions[0].runId).toBe(current.id);
    expect(detail.messages.filter((message) => message.role === 'assistant').map((message) => message.runId)).toEqual([current.id]);
    expect(detail.runs.find((run) => run.id === old.id)?.status).toBe('superseded');
  });

  it('counts an in-flight connection check toward the global capacity before accepting another work', async () => {
    const { repository, service } = setup({ generate: pendingUntilAbort });
    const connection = service.testProvider();
    const works = [1, 2, 3].map((number) => repository.createWork({ title: `容量 ${number}`, goal: '隔离容量检查' }).work);
    for (const work of works.slice(0, 2)) await service.submit({ workId: work.id, prompt: '等待处理', intent: 'explain' });
    await expect(service.submit({ workId: works[2].id, prompt: '不可超过全局容量', intent: 'explain' })).rejects.toThrow();
    await service.dispose();
    expect((await connection).ok).toBe(false);
  });

  it('shutdown cancels a connection check locally even when its provider response is delayed', async () => {
    const returned = deferred<ModelResponse>();
    const { service } = setup({ generate: () => returned.promise });
    const pending = service.testProvider();
    const disposed = service.dispose();
    returned.resolve({ text: '迟到的 OK', inputTokens: 1, outputTokens: 1 });
    expect((await pending).ok).toBe(false);
    await disposed;
  });

  it('requests a full refresh after server restart even when the new event cursor has passed the old cursor', async () => {
    const repository = new Repository(':memory:'); cleanup.push(() => repository.close());
    const options = { repository, credentials: new EnvironmentCredentials({ GEMINI_API_KEY: 'isolated-fixture-key' }), dataDirectory: 'isolated-memory', token: 'isolated-lifecycle-token-123456789', modelFactory: () => controlledModel };
    const first = createServer(options); cleanup.push(() => first.app.close());
    const work = await first.service.dispatch('createWork', { title: '重启同步', goal: '保留所有状态' }) as { work: { id: string } };
    const headers = { authorization: `Bearer ${options.token}` };
    const initial = (await first.app.inject({ method: 'GET', url: '/api/events?after=0', headers })).json();
    await first.app.close();
    const second = createServer(options); cleanup.push(() => second.app.close());
    await second.service.dispatch('renameWork', { workId: work.work.id, title: '重启后的名字' });
    await second.service.dispatch('archiveWork', { workId: work.work.id, archived: true });
    const response = (await second.app.inject({ method: 'GET', url: `/api/events?after=${initial.cursor}&epoch=${encodeURIComponent(initial.epoch ?? '')}`, headers })).json();
    expect(response.reset).toBe(true);
    expect(response.epoch).toBeTruthy();
    expect(response.epoch).not.toBe(initial.epoch);
    expect(repository.getWork(work.work.id).work).toMatchObject({ title: '重启后的名字', archived: true });
  });

  it('carries the notification epoch between polls and forwards a restart reset to its client', async () => {
    const urls: string[] = [];
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      if (urls.length === 1) return new Response(JSON.stringify({ cursor: 7, epoch: 'first-process', events: [{ workId: 'work-one' }], reset: false }));
      if (urls.length === 2) return new Response(JSON.stringify({ cursor: 8, epoch: 'second-process', events: [{ workId: 'work-two' }], reset: true }));
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
    });
    const listener = vi.fn();
    const api = createRemoteApi({ serverUrl: 'https://isolated.test', token: 'isolated-token', deviceId: 'device', fetch: request });
    const off = api.onChanged(listener); cleanup.push(off);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    expect(urls[1]).toContain('after=7&epoch=first-process');
    expect(urls[2]).toContain('after=8&epoch=second-process');
    expect(listener.mock.calls.map(([event]) => event)).toEqual([{ workId: 'work-one' }, { workId: '' }, { workId: 'work-two' }]);
    off();
  });

  it('times out a half-open notification request, reconnects and removes timers when unsubscribed', async () => {
    vi.useFakeTimers();
    let off: (() => void) | undefined;
    try {
      const request = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      }));
      const api = createRemoteApi({ serverUrl: 'https://isolated.test', token: 'isolated-token', deviceId: 'device', fetch: request });
      off = api.onChanged(() => {});
      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(request).toHaveBeenCalledTimes(2);
      off();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally { off?.(); vi.useRealTimers(); }
  });
});
