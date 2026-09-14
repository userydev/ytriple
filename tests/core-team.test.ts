import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/shared/defaults';
import type { EventInput, RunSnapshot } from '../src/shared/contracts';
import type { ModelPort, ModelRequest } from '../src/core/model-port';
import { applyReplacements, runTeam, type TeamStrategy } from '../src/core/team';

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    id: 'run1', workId: 'work1', goal: '制定可用方案', goalRevision: 1, prompt: '对照材料制定方案', intent: 'discuss',
    createdAt: new Date().toISOString(), status: 'running', strategyVersion: 'team-v1', settings: structuredClone(DEFAULT_SETTINGS),
    materials: [{ id: 'material1', workId: 'work1', title: '要求', content: '必须可离线阅读', hash: 'hash1', createdAt: '' }],
    messages: [], usage: { calls: 0, inputTokens: 0, outputTokens: 0, known: false }, ...overrides,
  };
}
function fixture(options: { rework?: boolean; tasks?: number; synth?: Record<string, unknown>; plan?: string } = {}) {
  const requests: ModelRequest[] = [];
  const port: ModelPort = {
    async generate(request) {
      requests.push(request);
      const stage = request.prompt.match(/^\[stage:(\w+)\]/)?.[1];
      let text: string;
      switch (stage) {
        case 'plan': text = options.plan ?? JSON.stringify({ overview: '先校准离线需求', method: '按数据和使用方式分工', requirements: '离线可读', tasks: [
          { id: 't1', memberId: 'researcher', title: '数据可用性', question: '确定哪些数据需要本地保留', requirement: '说明缓存边界', sourceIds: ['material1'] },
          ...(options.tasks === 2 ? [{ id: 't2', memberId: 'reviewer', title: '离线使用路径', question: '分析用户离线时可完成的操作', requirement: '操作有边界', sourceIds: ['material1'] }] : []),
        ] }); break;
        case 'worker': text = request.member.id === 'researcher' ? '实际贡献：正文在本地，联网请求不算离线可用。' : '实际贡献：离线可读，但不能发起新模型调用。'; break;
        case 'review': text = JSON.stringify({ analysis: '核查发现缓存过期尚未定义。', sourceIds: ['material1'], gaps: options.rework ? [{ taskId: 'run1:t1', problem: '缺少缓存期限', requirement: '说明缓存边界', instruction: '补充失效与保留策略' }] : [], reworkTaskId: options.rework ? 'run1:t1' : null }); break;
        case 'rework': text = '修订贡献：保留明确版本，不因缓存到期删除用户资料。'; break;
        case 'synthesize': text = JSON.stringify(options.synth ?? { answer: '正文保留本地，可离线阅读。', artifact: { title: '离线方案', content: '# 离线方案\n正文保留在本地。' }, changes: '采纳缓存边界意见。', replacements: [] }); break;
        case 'direct': text = '这个步骤用于核对离线要求；这里只解释，不修改成果。'; break;
        default: throw new Error('Unexpected test stage');
      }
      request.onText?.(text);
      return { text, inputTokens: 10, outputTokens: 20 };
    },
  };
  return { port, requests };
}
const execute = async (run = snapshot(), options: Parameters<typeof fixture>[0] = {}) => {
  const { port, requests } = fixture(options); const events: EventInput[] = [];
  const result = await runTeam(run, port, (e) => events.push(e), new AbortController().signal);
  return { result, requests, events };
};

describe('real team orchestration with a controlled model port', () => {
  it('uses a dynamic plan, shares actual worker contributions with review and synthesis, and accounts for each call', async () => {
    const { result, requests, events } = await execute(snapshot(), { tasks: 2 });
    const workers = requests.filter((r) => r.prompt.startsWith('[stage:worker]'));
    expect(workers).toHaveLength(2);
    expect(workers[0].prompt).toContain('确定哪些数据需要本地保留');
    expect(workers[1].prompt).toContain('分析用户离线时可完成的操作');
    expect(workers[0].prompt).not.toContain('分析用户离线时可完成的操作');
    expect(requests.find((r) => r.prompt.startsWith('[stage:review]'))?.prompt).toContain('实际贡献：正文在本地');
    expect(requests.at(-1)?.prompt).toContain('核查发现缓存过期尚未定义');
    expect(result.artifact?.kind).toBe('deliverable');
    expect(events.filter((e) => e.type === 'delegation')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'usage')).toHaveLength(5);
    expect(events.filter((e) => e.type === 'usage').every((e) => e.usage?.calls === 1 && e.usage.known)).toBe(true);
    const plan = events.find((e) => e.type === 'plan');
    expect(events.filter((e) => e.type === 'delegation').every((e) => e.relatedEventKeys?.includes('plan'))).toBe(true);
    expect(events.filter((e) => e.type === 'analysis').every((e) => e.relatedEventKeys?.some((key) => key.startsWith('delegation:')))).toBe(true);
    expect(events.find((e) => e.type === 'review')?.relatedEventKeys).toEqual(expect.arrayContaining(['analysis:run1:t1', 'analysis:run1:t2']));
    expect(plan?.relatedEventIds).toBeUndefined();
  });

  it('routes one concrete review issue back to its worker and uses the revision in synthesis', async () => {
    const { requests, events } = await execute(snapshot(), { rework: true });
    const reworks = requests.filter((r) => r.prompt.startsWith('[stage:rework]'));
    expect(reworks).toHaveLength(1);
    expect(reworks[0].member.id).toBe('researcher');
    expect(reworks[0].prompt).toContain('补充失效与保留策略');
    expect(requests.at(-1)?.prompt).toContain('不因缓存到期删除用户资料');
    expect(events.find((e) => e.type === 'revision' && e.taskId === 'run1:t1')?.relatedEventKeys)
      .toEqual(expect.arrayContaining(['review', 'analysis:run1:t1']));
    expect(events.find((e) => e.type === 'revision' && e.key === 'synthesis-changes')?.relatedEventKeys)
      .toEqual(expect.arrayContaining(['review', 'analysis:run1:t1', 'revision:run1:t1']));
  });

  it('answers a selected member or explanation with its reference and never proposes an artifact', async () => {
    const { result, requests } = await execute(snapshot({ intent: 'explain', targetMemberId: 'reviewer', reference: { kind: 'event', id: 'e1' }, referenceContent: '先核对离线要求' }));
    expect(requests).toHaveLength(1);
    expect(requests[0].member.id).toBe('reviewer');
    expect(requests[0].prompt).toContain('先核对离线要求');
    expect(result.artifact).toBeUndefined();
  });

  it('corrects a referenced process step without a baseline and can create the first artifact', async () => {
    const run = snapshot({
      intent: 'revise',
      reference: { kind: 'event', id: 'prior-step', quote: '原判断片段' },
      referenceContent: '原判断片段：尚需核查。',
    });
    const { result, events } = await execute(run, {
      synth: { answer: '已按该步骤重新处理。', artifact: { title: '首次成果', content: '# 首次成果\n\n已补充核查。' }, changes: '根据过程步骤修正并形成首份成果。', replacements: [] },
    });
    expect(result.artifact).toMatchObject({ kind: 'deliverable', title: '首次成果' });
    expect(events.find((event) => event.type === 'plan')?.relatedEventIds).toEqual(['prior-step']);
  });

  it('uses a process quote as correction context, not as the artifact replacement scope', async () => {
    const run = snapshot({
      intent: 'revise',
      reference: { kind: 'event', id: 'prior-step', quote: '过程中的判断片段' },
      referenceContent: '过程中的判断片段：需要纠正。',
      baseArtifact: { id: 'a1', title: '原成果', kind: 'deliverable', version: 1, content: '# 原成果\n需要改正的正文。\n保留其它内容。' },
    });
    const { result } = await execute(run, {
      synth: { answer: '已修订成果。', artifact: null, changes: '依据过程纠正成果。', replacements: [{ original: '需要改正的正文。', replacement: '已修订的正文。' }] },
    });
    expect(result.artifact?.content).toContain('已修订的正文。');
    expect(result.artifact?.content).toContain('保留其它内容。');
  });

  it('keeps artifact-only revision strict when no artifact baseline exists', async () => {
    const { port, requests } = fixture();
    await expect(runTeam(snapshot({ intent: 'revise' }), port, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'MISSING_BASE' });
    expect(requests).toHaveLength(0);
  });

  it('applies a precise revision to its baseline and preserves unrelated text', async () => {
    const run = snapshot({ intent: 'revise', reference: { kind: 'artifact', id: 'a1', version: 2, quote: '缓存有效期为一天。' }, baseArtifact: { id: 'a1', title: '原成果', kind: 'deliverable', version: 2, content: '# 原标题\n缓存有效期为一天。\n不相关内容必须保留。' } });
    const { result } = await execute(run, { synth: { answer: '已修改有效期。', artifact: null, changes: '依据版本保留原则修改。', replacements: [{ original: '缓存有效期为一天。', replacement: '正文按版本保留。' }] } });
    expect(result.artifact?.content).toBe('# 原标题\n正文按版本保留。\n不相关内容必须保留。');
  });

  it('rejects invalid planner output and makes no following model calls', async () => {
    const { port, requests } = fixture({ plan: '{"not":"a plan"}' });
    await expect(runTeam(snapshot(), port, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    expect(requests).toHaveLength(1);
  });

  it('enforces the total call ceiling without an implicit SDK/format retry', async () => {
    const run = snapshot(); run.settings.limits.maxCalls = 2;
    const { port, requests } = fixture();
    await expect(runTeam(run, port, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'CALL_LIMIT' });
    expect(requests).toHaveLength(2);
  });

  it('stops even a non-cooperating port, preserves call accounting, and suppresses late content', async () => {
    const controller = new AbortController(); const events: EventInput[] = [];
    let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; });
    let request!: ModelRequest; let resolveCall!: (response: { text: string }) => void;
    const port: ModelPort = { generate: (r) => { request = r; started(); return new Promise((resolve) => { resolveCall = resolve; }); } };
    const running = runTeam(snapshot({ intent: 'explain' }), port, (e) => events.push(e), controller.signal);
    await ready; controller.abort();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(request.signal.aborted).toBe(true);
    request.onText?.('迟到内容'); resolveCall({ text: '迟到内容' });
    await Promise.resolve();
    expect(events.filter((e) => e.type === 'analysis')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'usage')).toHaveLength(1);
  });

  it('has a wall-clock deadline and retains unknown usage on timeout', async () => {
    const run = snapshot({ intent: 'explain' }); run.settings.limits.timeoutMs = 15;
    const events: EventInput[] = [];
    await expect(runTeam(run, { generate: () => new Promise(() => {}) }, (e) => events.push(e), new AbortController().signal)).rejects.toMatchObject({ code: 'TIME_LIMIT' });
    expect(events.at(-1)?.usage?.known).toBe(false);
  });

  it.each(['summarize', 'reflect'] as const)('requires actual public process records for %s and labels the resulting artifact', async (intent) => {
    const { port, requests } = fixture();
    await expect(runTeam(snapshot({ intent }), port, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'MISSING_PROCESS' });
    expect(requests).toHaveLength(0);
    const run = snapshot({ intent, contextEvents: [{ id: 'original-event', workId: 'work1', runId: 'prior-run', sequence: 2, createdAt: '', type: 'analysis', title: '此前处理步骤', body: '先核对离线限制，再确认正文保留。', memberId: 'researcher' }] });
    const executed = await execute(run);
    expect(executed.result.artifact?.kind).toBe(intent === 'summarize' ? 'summary' : 'reflection');
    expect(executed.requests.at(-1)?.prompt).toContain('original-event');
    expect(executed.requests.at(-1)?.prompt).toContain('先核对离线限制');
  });

  it('rejects a hallucinated source before any delegated calls occur', async () => {
    const { port, requests } = fixture({ plan: JSON.stringify({ overview: '理解', method: '核查', requirements: '准确', tasks: [{ id: 't1', memberId: 'researcher', title: '读取', question: '读取材料', requirement: '有依据', sourceIds: ['unavailable'] }] }) });
    await expect(runTeam(snapshot(), port, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'UNKNOWN_SOURCE' });
    expect(requests).toHaveLength(1);
  });

  it('supports swapping the orchestration strategy without UI, storage or provider changes', async () => {
    const alternate: TeamStrategy = { version: 'test-strategy', async execute({ snapshot }) { return { answer: `新的策略处理：${snapshot.goal}` }; } };
    const result = await runTeam(snapshot(), { generate: async () => { throw new Error('should not call'); } }, () => {}, new AbortController().signal, alternate);
    expect(result.answer).toBe('新的策略处理：制定可用方案');
  });
});

describe('precise revision boundaries', () => {
  it('rejects ambiguous, overlapping or out-of-scope replacements', () => {
    expect(() => applyReplacements('重复，重复', [{ original: '重复', replacement: '新' }])).toThrow('唯一定位');
    expect(() => applyReplacements('abcdef', [{ original: 'abc', replacement: 'X' }, { original: 'bcd', replacement: 'Y' }])).toThrow('重叠');
    expect(() => applyReplacements('正文，别处', [{ original: '别处', replacement: '新' }], '正文')).toThrow('选定片段');
  });
});
