import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Repository, STORAGE_LIMITS } from '../src/storage/repository';
import { DEFAULT_SETTINGS } from '../src/shared/defaults';
import type { AppSettings, CoreResult, Intent, RunSnapshot } from '../src/shared/contracts';

describe('SQLite durable state and run ownership', () => {
  let directory: string;
  let path: string;
  let repository: Repository;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ytriple-storage-test-'));
    path = join(directory, 'work.sqlite');
    repository = new Repository(path);
  });
  afterEach(() => { repository.close(); rmSync(directory, { recursive: true, force: true }); });

  const result = (content = '团队正文', kind: 'deliverable' | 'summary' | 'reflection' = 'deliverable'): CoreResult => ({
    answer: '工作已完成，依据见成果。', artifact: { title: '测试成果', content, kind }, changes: '核查并补充了依据。',
  });
  function start(workId: string, intent: Intent = 'discuss'): RunSnapshot {
    return repository.createRun({ workId, prompt: `${intent}：隔离测试任务`, intent }, repository.getSettings());
  }
  function seeded() {
    const work = repository.createWork({ title: '隔离工作', goal: '完整交付可阅读的成果' }).work;
    const run = start(work.id); repository.completeRun(run.id, result());
    return { work, run, artifact: repository.getWork(work.id).artifacts[0] };
  }

  it('reopens work, role snapshots, events, material, artifact and separate desktop/mobile drafts', () => {
    const work = repository.createWork({ title: '恢复测试', goal: '保留用户输入' }).work;
    const content = '  原始材料\n\n包含格式与末尾换行。\n';
    const material = repository.addMaterial({ workId: work.id, title: '用户材料', content });
    const run = start(work.id);
    const event = repository.appendEvent(run.id, { type: 'analysis', title: '研究员依据', body: '基于原始材料进行核查。', memberId: 'researcher', sourceIds: [material.id], key: 'research' });
    repository.completeRun(run.id, result());
    const artifact = repository.getWork(work.id).artifacts[0];
    repository.saveDraft({ workId: work.id, draft: { text: '桌面尚未发出的修正', intent: 'revise', reference: { kind: 'artifact', id: artifact.id, version: 1, quote: '正文' } } });
    repository.saveDraft({ workId: work.id, draft: { text: '手机的独立草稿', intent: 'explain', reference: { kind: 'event', id: event.id } } }, 'mobile-1');
    repository.saveView({ workId: work.id, view: { activePane: 'result', artifactId: artifact.id, artifactVersion: 1, scroll: { result: 125 } } });
    repository.saveView({ workId: work.id, view: { focusedPane: 'process', activePane: 'process' } }, 'mobile-1');
    repository.renameWork({ workId: work.id, title: '已重命名' });
    repository.archiveWork({ workId: work.id, archived: true });
    repository.close(); repository = new Repository(path);
    const desktop = repository.getWork(work.id);
    const mobile = repository.getWork(work.id, 'mobile-1');
    expect(desktop.work).toMatchObject({ title: '已重命名', archived: true, goalRevision: 1 });
    expect(desktop.materials[0].content).toBe(content);
    expect(desktop.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(desktop.events[0]).toMatchObject({ id: event.id, memberId: 'researcher', sourceIds: [material.id] });
    expect(desktop.runs[0].materials).toEqual([material]);
    expect(desktop.artifacts[0].versions[0].content).toBe('团队正文');
    expect(desktop.draft.text).toBe('桌面尚未发出的修正');
    expect(desktop.view).toMatchObject({ activePane: 'result', artifactVersion: 1, scroll: { result: 125 } });
    expect(mobile.draft.text).toBe('手机的独立草稿');
    expect(mobile.view.activePane).toBe('process');
    expect(mobile.artifacts).toEqual(desktop.artifacts);
    expect(repository.listWorks()).toHaveLength(1);
  });

  it('deduplicates material by exact content within its work, without changing the original', () => {
    const first = repository.createWork({ title: '第一项', goal: '' }).work;
    const second = repository.createWork({ title: '第二项', goal: '' }).work;
    const material = repository.addMaterial({ workId: first.id, title: '首次标题', content: '\n 原文 \n' });
    expect(repository.addMaterial({ workId: first.id, title: '重复材料标题', content: '\n 原文 \n' })).toEqual(material);
    expect(repository.addMaterial({ workId: first.id, title: '内容差异', content: '原文' }).id).not.toBe(material.id);
    expect(repository.addMaterial({ workId: second.id, title: '另一工作', content: '\n 原文 \n' }).id).not.toBe(material.id);
    expect(repository.getWork(first.id).materials).toHaveLength(2);
    expect(() => repository.addMaterial({ workId: first.id, title: '过大材料', content: '字'.repeat(STORAGE_LIMITS.materialCharacters + 1) })).toThrow('未被截断');
    expect(repository.getWork(first.id).materials).toHaveLength(2);
  });

  it('rejects aggregate material overflow rather than silently omitting material', () => {
    const work = repository.createWork({ title: '材料上限', goal: '' }).work;
    for (let index = 0; index < 5; index++) repository.addMaterial({ workId: work.id, title: `材料 ${index}`, content: String(index).repeat(STORAGE_LIMITS.materialCharacters) });
    expect(() => repository.addMaterial({ workId: work.id, title: '超出总量', content: '多一个字' })).toThrow('总计最多');
    expect(repository.getWork(work.id).materials).toHaveLength(5);
  });

  it('keeps settings and team versions owned by storage and excludes credential fields from database snapshots', () => {
    const unsafe = structuredClone(DEFAULT_SETTINGS) as AppSettings & { apiKey: string };
    unsafe.apiKey = 'do-not-store-credential';
    Object.assign(unsafe.provider, { apiKey: unsafe.apiKey, token: unsafe.apiKey });
    unsafe.version = 999; unsafe.team.version = 999;
    const saved = repository.saveSettings(unsafe);
    expect(saved.version).toBe(2); expect(saved.team.version).toBe(1);
    expect(JSON.stringify(saved)).not.toContain(unsafe.apiKey);
    const work = repository.createWork({ title: '快照测试', goal: '检查角色版本' }).work;
    const run = repository.createRun({ workId: work.id, prompt: '隔离快照', intent: 'discuss' }, unsafe);
    const changed = structuredClone(saved); changed.team.members[1].name = '资料分析师';
    const latest = repository.saveSettings(changed);
    expect(latest.version).toBe(3); expect(latest.team.version).toBe(2);
    expect(repository.getRun(run.id).settings.team.members[1].name).toBe('研究员');
    const reader = new DatabaseSync(path, { readOnly: true });
    try {
      expect(JSON.stringify(reader.prepare('SELECT payload_json FROM settings').all())).not.toContain(unsafe.apiKey);
      expect(JSON.stringify(reader.prepare('SELECT snapshot_json FROM runs').all())).not.toContain(unsafe.apiKey);
      expect(reader.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(reader.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 1 });
    } finally { reader.close(); }
    changed.provider.baseUrl = 'https://example.test/v1?api_key=secret';
    expect(() => repository.validateSettings(changed)).toThrow('不能包含凭据');
    expect(() => repository.saveSettings(changed)).toThrow('不能包含凭据');
    expect(repository.getSettings().version).toBe(3);
    repository.validateSettings(latest);
    expect(repository.getSettings()).toEqual(latest);
  });

  it('rejects invalid submissions atomically before cancelling the current run or changing its goal', () => {
    const { work, artifact } = seeded(); const running = start(work.id);
    const foreign = seeded();
    expect(() => repository.createRun({ workId: work.id, prompt: '恶意引用', intent: 'change-goal', reference: { kind: 'artifact', id: foreign.artifact.id } }, repository.getSettings())).toThrow('不属于当前工作');
    expect(() => repository.createRun({ workId: work.id, prompt: '不存在的成员', intent: 'discuss', targetMemberId: 'outsider' }, repository.getSettings())).toThrow('不属于本次团队');
    expect(() => repository.createRun({ workId: work.id, prompt: '篡改引用', intent: 'revise', reference: { kind: 'artifact', id: artifact.id, version: 1, quote: '不存在的片段' } }, repository.getSettings())).toThrow('引用片段');
    expect(() => repository.createRun({ workId: work.id, prompt: '非法意图', intent: 'invalid' as Intent }, repository.getSettings())).toThrow('意图');
    const detail = repository.getWork(work.id);
    expect(detail.work.goalRevision).toBe(1);
    expect(detail.runs.at(-1)?.status).toBe('running');
    expect(repository.getRun(running.id).status).toBe('running');
    expect(detail.messages.filter((message) => message.role === 'user')).toHaveLength(2);
  });

  it('new goals supersede in-flight runs and isolate late results without replacing the current deliverable', () => {
    const { work, artifact } = seeded();
    const old = start(work.id, 'revise');
    const next = repository.createRun({ workId: work.id, prompt: '重新聚焦于新目标', intent: 'change-goal' }, repository.getSettings());
    expect(next.goalRevision).toBe(2); expect(next.goal).toBe('重新聚焦于新目标');
    expect(repository.getRun(old.id).status).toBe('superseded');
    repository.completeRun(next.id, result('新目标的正式结果'));
    repository.completeRun(old.id, result('旧目标迟到结果'));
    const detail = repository.getWork(work.id);
    const current = detail.artifacts.find((item) => item.id === artifact.id)!;
    expect(current.currentVersion).toBe(2);
    expect(current.versions.map((version) => [version.content, version.status])).toEqual([
      ['团队正文', 'history'], ['新目标的正式结果', 'current'], ['旧目标迟到结果', 'proposal'],
    ]);
    expect(repository.getRun(old.id).status).toBe('superseded');
    expect(detail.messages.filter((message) => message.role === 'assistant')).toHaveLength(2);
    expect(detail.events.some((event) => event.runId === old.id && event.title === '迟到结果已隔离')).toBe(true);
  });

  it('uses the selected historical version as the actual revision baseline and preserves conflicts as proposals', () => {
    const { work, artifact } = seeded();
    repository.saveArtifact({ workId: work.id, artifactId: artifact.id, baseVersion: 1, content: '用户的版本二' });
    const oldVersionRun = repository.createRun({ workId: work.id, prompt: '修订最初版本', intent: 'revise', reference: { kind: 'artifact', id: artifact.id, version: 1, quote: '正文' } }, repository.getSettings());
    expect(oldVersionRun.baseArtifact).toMatchObject({ version: 1, content: '团队正文' });
    expect(oldVersionRun.referenceContent).toBe('团队正文');
    repository.completeRun(oldVersionRun.id, result('针对历史版本的AI修订'));
    const updated = repository.getWork(work.id).artifacts[0];
    expect(updated.currentVersion).toBe(2);
    expect(updated.versions.at(-1)).toMatchObject({ status: 'proposal', baseVersion: 1, content: '针对历史版本的AI修订' });
    expect(repository.getRun(oldVersionRun.id).status).toBe('completed');
  });

  it('protects manual edits made during generation and manual edits from another device', () => {
    const { work, artifact } = seeded();
    const run = start(work.id, 'revise');
    repository.saveArtifact({ workId: work.id, artifactId: artifact.id, baseVersion: 1, content: '用户编辑优先' });
    repository.completeRun(run.id, result('生成期间的AI结果'));
    const conflict = repository.saveArtifact({ workId: work.id, artifactId: artifact.id, baseVersion: 1, content: '另一设备基于旧版本的编辑' });
    expect(conflict.currentVersion).toBe(2);
    expect(conflict.versions.map((version) => version.status)).toEqual(['history', 'current', 'proposal', 'proposal']);
    expect(conflict.versions[1].content).toBe('用户编辑优先');
    expect(conflict.versions[2].runId).toBe(run.id);
    expect(conflict.versions[3].runId).toBeUndefined();
  });

  it('completes once even after reopening and replaying the same result', () => {
    const work = repository.createWork({ title: '幂等完成', goal: '' }).work;
    const run = start(work.id);
    repository.completeRun(run.id, result());
    repository.close(); repository = new Repository(path);
    repository.completeRun(run.id, result('不应重复写入的结果'));
    const detail = repository.getWork(work.id);
    expect(detail.artifacts[0].versions).toHaveLength(1);
    expect(detail.messages).toHaveLength(2);
    expect(detail.runs[0].status).toBe('completed');
    repository.finishRun(run.id, 'failed', '迟到错误');
    expect(repository.getRun(run.id).status).toBe('completed');
  });

  it.each(['stopping', 'stopped', 'failed', 'interrupted'] as const)('cannot change a %s run into completed when a result arrives late', (status) => {
    const { work } = seeded(); const run = start(work.id, 'revise');
    repository.appendEvent(run.id, { type: 'analysis', title: '正在输出', body: '部分分析', streaming: true, key: 'analysis' });
    repository.finishRun(run.id, status, '隔离中断');
    repository.completeRun(run.id, result('取消后的结果'));
    repository.finishRun(run.id, 'completed');
    expect(repository.getRun(run.id).status).toBe(status);
    const detail = repository.getWork(work.id);
    expect(detail.artifacts[0].currentVersion).toBe(1);
    expect(detail.artifacts[0].versions.at(-1)?.status).toBe('proposal');
    expect(detail.messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
  });

  it('recovering an interrupted process clears streams and never automatically restarts a run', () => {
    const first = repository.createWork({ title: '运行中', goal: '' }).work;
    const second = repository.createWork({ title: '停止中', goal: '' }).work;
    const run1 = start(first.id); const run2 = start(second.id);
    repository.appendEvent(run1.id, { type: 'analysis', title: '过程', body: '部分返回', streaming: true, key: 'part' });
    repository.finishRun(run2.id, 'stopping');
    repository.close(); repository = new Repository(path);
    expect(repository.recoverInterruptedRuns()).toBe(2);
    expect(repository.recoverInterruptedRuns()).toBe(0);
    expect(repository.getRun(run1.id)).toMatchObject({ status: 'interrupted', error: expect.stringContaining('未自动重试') });
    expect(repository.getRun(run2.id).status).toBe('interrupted');
    expect(repository.getWork(first.id).events[0].streaming).toBe(false);
    repository.appendEvent(run1.id, { type: 'analysis', title: '过程', body: '迟到的部分返回', streaming: true, key: 'part' });
    expect(repository.getWork(first.id).events[0].streaming).toBe(false);
  });

  it('summaries and reflections have independent versions and explanation never edits any artifact', () => {
    const { work, artifact } = seeded();
    const summary = start(work.id, 'summarize'); repository.completeRun(summary.id, result('过程总结', 'summary'));
    const reflection = start(work.id, 'reflect');
    expect(reflection.baseArtifact).toBeUndefined();
    expect(reflection.contextArtifact).toEqual({ id: artifact.id, title: artifact.title, kind: 'deliverable', version: 1, content: '团队正文' });
    expect(reflection.contextNote).toContain(`主成果“${artifact.title}”第 1 版`);
    expect(reflection.contextNote).not.toContain('团队正文');
    repository.completeRun(reflection.id, result('阶段复盘', 'reflection'));
    const explanation = start(work.id, 'explain'); repository.completeRun(explanation.id, result('即使核心错误返回成果也不应写入'));
    const detail = repository.getWork(work.id);
    expect(detail.artifacts.map((entry) => entry.kind)).toEqual(['deliverable', 'summary', 'reflection']);
    expect(detail.artifacts[0]).toEqual(artifact);
    expect(detail.artifacts.map((entry) => entry.versions[0].content)).toEqual(['团队正文', '过程总结', '阶段复盘']);
    expect(detail.messages.at(-1)?.runId).toBe(explanation.id);
    const anotherSummary = start(work.id, 'summarize'); repository.completeRun(anotherSummary.id, result('新过程总结', 'summary'));
    expect(repository.getWork(work.id).artifacts[1].versions).toHaveLength(2);
    expect(repository.getWork(work.id).artifacts[0].versions).toHaveLength(1);
    const nextReflection = start(work.id, 'reflect');
    expect(nextReflection.baseArtifact).toMatchObject({ kind: 'reflection', version: 1, content: '阶段复盘' });
    expect(nextReflection.contextArtifact).toMatchObject({ id: artifact.id, version: 1, content: '团队正文' });
    expect(nextReflection.contextNote).toContain('复盘报告单独保存');
  });

  it('snapshots actual process events with an explicit scope for summary, reflection and selected-step follow-up', () => {
    const { work, run } = seeded();
    const firstEvent = repository.appendEvent(run.id, { type: 'review', title: '历史核查', body: '第一次核查指出缺少事实依据。', memberId: 'reviewer', key: 'review' });
    const second = start(work.id);
    repository.appendEvent(second.id, { type: 'analysis', title: '第二轮分析', body: '依据反馈补充材料。', memberId: 'researcher', key: 'analysis' });
    repository.completeRun(second.id, result('加入材料的成果'));
    const summary = start(work.id, 'summarize');
    expect(summary.contextEvents?.map((event) => event.title)).toEqual(['历史核查', '第二轮分析']);
    expect(summary.contextNote).toContain('当前工作此前全部 2 条');
    repository.completeRun(summary.id, result('过程总结', 'summary'));
    const followUp = repository.createRun({ workId: work.id, prompt: '解释第一个不足', intent: 'explain', reference: { kind: 'event', id: firstEvent.id } }, repository.getSettings());
    expect(followUp.contextEvents).toEqual([firstEvent]);
    expect(followUp.contextNote).toContain('所选事件所属运行的全部 1 条');
    repository.appendEvent(run.id, { type: 'status', title: '后加状态', body: '不会改写已有快照。' });
    expect(repository.getRun(followUp.id).contextEvents).toEqual([firstEvent]);
  });

  it('rolls back a malformed completion instead of leaving a half-written message or artifact', () => {
    const work = repository.createWork({ title: '完成事务', goal: '' }).work;
    const run = start(work.id);
    expect(() => repository.completeRun(run.id, { answer: '有效回复', artifact: { title: '有效标题', content: '', kind: 'deliverable' } })).toThrow('不能为空');
    const beforeRetry = repository.getWork(work.id);
    expect(beforeRetry.messages).toHaveLength(1);
    expect(beforeRetry.artifacts).toHaveLength(0);
    expect(beforeRetry.runs[0].status).toBe('running');
    repository.completeRun(run.id, result('后来正确完成的成果'));
    expect(repository.getWork(work.id).artifacts[0].versions).toHaveLength(1);
    expect(repository.getWork(work.id).messages).toHaveLength(2);
  });

  it('keeps streaming event identity and order, scopes keys by run and accumulates corrected usage once', () => {
    const work = repository.createWork({ title: '事件测试', goal: '' }).work; const run = start(work.id);
    const initial = repository.appendEvent(run.id, { type: 'analysis', title: '公开分析', body: '初始', memberId: 'researcher', taskId: 'task1', parentTaskId: 'plan', streaming: true, key: 'worker' });
    repository.appendEvent(run.id, { type: 'review', title: '核查', body: '核查内容', memberId: 'reviewer' });
    const final = repository.appendEvent(run.id, { type: 'analysis', title: '公开分析', body: '完整内容', memberId: 'researcher', taskId: 'task1', parentTaskId: 'plan', streaming: false, key: 'worker' });
    expect(final).toMatchObject({ id: initial.id, sequence: initial.sequence, createdAt: initial.createdAt, body: '完整内容', streaming: false });
    expect(repository.getWork(work.id).events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(() => repository.appendEvent(run.id, { type: 'analysis', title: '换身份', body: '禁止', memberId: 'reviewer', taskId: 'task1', parentTaskId: 'plan', key: 'worker' })).toThrow('不能更改');
    const usage = { type: 'usage' as const, title: '调用用量', body: '用量事实', memberId: 'lead', key: 'usage:1', usage: { calls: 1, inputTokens: 20, outputTokens: 8, known: true } };
    repository.appendEvent(run.id, usage); repository.appendEvent(run.id, usage);
    expect(repository.getRun(run.id).usage).toEqual({ calls: 1, inputTokens: 20, outputTokens: 8, known: true });
    repository.appendEvent(run.id, { ...usage, usage: { calls: 1, inputTokens: 25, outputTokens: 10, known: true } });
    repository.appendEvent(run.id, { ...usage, key: 'usage:2', usage: { calls: 1, known: false } });
    expect(repository.getRun(run.id).usage).toEqual({ calls: 2, inputTokens: 25, outputTokens: 10, known: false });
    const next = start(work.id);
    const separate = repository.appendEvent(next.id, { type: 'analysis', title: '新运行', body: '新内容', key: 'worker' });
    expect(separate.id).not.toBe(initial.id); expect(separate.sequence).toBe(1);
  });

  it('enforces work, run-member and material snapshot ownership for every writable reference', () => {
    const one = seeded(); const two = seeded(); const run = start(one.work.id);
    const foreignEvent = repository.appendEvent(two.run.id, { type: 'status', title: '其他工作', body: '不可引用' });
    const lateMaterial = repository.addMaterial({ workId: one.work.id, title: '运行后才加入', content: '不属于输入快照' });
    expect(() => repository.createRun({ workId: one.work.id, prompt: '解释', intent: 'explain', reference: { kind: 'event', id: foreignEvent.id } }, repository.getSettings())).toThrow('不属于当前工作');
    expect(() => repository.saveArtifact({ workId: one.work.id, artifactId: two.artifact.id, baseVersion: 1, content: '串写' })).toThrow('不属于当前工作');
    expect(() => repository.saveDraft({ workId: one.work.id, draft: { text: '串引用', intent: 'revise', reference: { kind: 'artifact', id: two.artifact.id } } })).toThrow('不属于当前工作');
    expect(() => repository.saveView({ workId: one.work.id, view: { artifactId: two.artifact.id } })).toThrow('不属于当前工作');
    expect(() => repository.appendEvent(run.id, { type: 'analysis', title: '错误成员', body: '', memberId: 'outsider' })).toThrow('团队快照');
    expect(() => repository.appendEvent(run.id, { type: 'analysis', title: '未读材料', body: '', sourceIds: [lateMaterial.id] })).toThrow('输入快照');
    expect(() => repository.appendEvent(run.id, { type: 'analysis', title: '串过程', body: '', relatedEventIds: [foreignEvent.id] })).toThrow('不属于当前工作');
    expect(repository.getWork(one.work.id).events).toHaveLength(0);
    expect(repository.getRun(run.id).status).toBe('running');
  });

  it('refuses databases created by a newer application without replacing them', () => {
    const work = repository.createWork({ title: '保留新版资料', goal: '不可降级' }).work;
    repository.close();
    const future = new DatabaseSync(path); future.exec('PRAGMA user_version = 99'); future.close();
    expect(() => new Repository(path)).toThrow('高于当前应用支持');
    const restore = new DatabaseSync(path); expect(restore.prepare('SELECT title FROM works WHERE id = ?').get(work.id)).toMatchObject({ title: '保留新版资料' });
    restore.exec('PRAGMA user_version = 1'); restore.close();
    repository = new Repository(path);
    expect(repository.getWork(work.id).work.goal).toBe('不可降级');
  });
});
