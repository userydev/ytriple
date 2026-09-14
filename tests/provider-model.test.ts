import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCurrentRunTree } from 'langsmith/traceable';
import { DEFAULT_SETTINGS } from '../src/shared/defaults';
import { createModelPort, extractPublicText } from '../src/providers/model-port';
import { withoutTracing } from '../src/core/privacy';

const sdk = vi.hoisted(() => ({ configs: [] as Record<string, unknown>[], options: [] as Record<string, unknown>[], chunks: [] as unknown[], error: null as unknown, tracing: [] as unknown[] }));
vi.mock('@langchain/google', () => ({ ChatGoogle: class {
  constructor(config: Record<string, unknown>) { sdk.configs.push(config); }
  async stream(_messages: unknown, options: Record<string, unknown>) { sdk.options.push(options); if (sdk.error) throw sdk.error; return (async function* () { for (const chunk of sdk.chunks) yield chunk; })(); }
} }));
vi.mock('@langchain/openai', () => ({ ChatOpenAICompletions: class {
  constructor(config: Record<string, unknown>) { sdk.configs.push(config); }
  async stream(_messages: unknown, options: Record<string, unknown>) { sdk.options.push(options); if (sdk.error) throw sdk.error; return (async function* () { for (const chunk of sdk.chunks) yield chunk; })(); }
} }));

const request = () => ({ system: '公开回答', prompt: '解释方法', member: { ...DEFAULT_SETTINGS.team.members[0] }, json: false, maxOutputTokens: 1000, signal: new AbortController().signal });
beforeEach(() => { sdk.configs.length = 0; sdk.options.length = 0; sdk.chunks = []; sdk.error = null; });

describe('provider boundary', () => {
  it('whitelists public text and never returns provider thought blocks or their metadata', () => {
    expect(extractPublicText([{ type: 'reasoning', reasoning: 'private' }, { type: 'text', text: 'private2', thought: true }, { type: 'thinking', text: 'private3' }, { type: 'text', text: '公开正文' }])).toBe('公开正文');
    expect(extractPublicText({ reasoning: 'private' })).toBe('');
  });

  it('streams only public text, strips split thinking tags, preserves usage and member model selection', async () => {
    sdk.chunks = [
      { content: [{ type: 'reasoning', reasoning: '隐藏块' }, { type: 'text', text: '公开' }], usage_metadata: { input_tokens: 10, output_tokens: 2 }, response_metadata: {}, additional_kwargs: {} },
      { content: '<thi', response_metadata: {}, additional_kwargs: {} }, { content: 'nk>隐藏标签<think>嵌套隐藏</think>仍隐藏', response_metadata: {}, additional_kwargs: {} }, { content: '</think>正文', usage_metadata: { input_tokens: 0, output_tokens: 8 }, response_metadata: {}, additional_kwargs: {} },
    ];
    const onText = vi.fn(); const r = request(); r.member.model = 'member-gemini';
    const result = await createModelPort(DEFAULT_SETTINGS.provider, 'fake-test-key').generate({ ...r, onText });
    expect(result).toEqual({ text: '公开正文', inputTokens: 10, outputTokens: 10 });
    expect(onText.mock.calls.flat().join('')).not.toContain('隐藏');
    expect(sdk.configs[0]).toMatchObject({ model: 'member-gemini', maxRetries: 0, thinkingConfig: { includeThoughts: false }, platformType: 'gai' });
    expect(sdk.options[0].signal).toBe(r.signal);
  });

  it('uses the explicit completions adapter and disables incompatible stream_options', async () => {
    sdk.chunks = [{ content: 'OK', response_metadata: {}, additional_kwargs: {} }];
    const result = await createModelPort({ kind: 'openai-compatible', model: 'custom-model', baseUrl: 'https://example.test/v1/' }, 'fake-test-key').generate(request());
    expect(result.inputTokens).toBeUndefined();
    expect(sdk.configs[0]).toMatchObject({ configuration: { baseURL: 'https://example.test/v1' }, streamUsage: false, maxRetries: 0 });
  });

  it('replaces SDK exceptions with a bounded public error without credentials or request details', async () => {
    sdk.error = { status: 401, message: 'request headers Authorization: Bearer secret-value', body: 'private work' };
    const port = createModelPort(DEFAULT_SETTINGS.provider, 'fake-test-key');
    try { await port.generate(request()); throw new Error('Expected failure'); }
    catch (error) {
      expect(error).toMatchObject({ code: 'AUTH' });
      expect(JSON.stringify(error)).not.toMatch(/secret-value|private work|fake-test-key/);
    }
  });

  it('rejects credential-bearing endpoints and fails if the provider returns only thoughts', async () => {
    expect(() => createModelPort({ kind: 'openai-compatible', model: 'custom', baseUrl: 'https://example.test/v1?key=private' }, 'fake')).toThrow('基础地址');
    sdk.chunks = [{ content: [{ type: 'reasoning', reasoning: 'private' }], response_metadata: {}, additional_kwargs: {} }];
    await expect(createModelPort(DEFAULT_SETTINGS.provider, 'fake').generate(request())).rejects.toMatchObject({ code: 'EMPTY_RESPONSE' });
  });

  it('establishes a local scope with tracing explicitly disabled', async () => {
    await withoutTracing(async () => { expect(getCurrentRunTree().tracingEnabled).toBe(false); });
  });

  it('does not mark a provider-truncated answer as a complete contribution', async () => {
    sdk.chunks = [{ content: '只返回一半', response_metadata: { finish_reason: 'length' }, additional_kwargs: {} }];
    await expect(createModelPort(DEFAULT_SETTINGS.provider, 'fake').generate(request())).rejects.toMatchObject({ code: 'TRUNCATED' });
  });
});
