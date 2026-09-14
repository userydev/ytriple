import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { ArrowUpRight, Check, ChevronDown, FilePlus2, FileText, LoaderCircle, MessageSquare, Paperclip, Plus, Send, Square, Users, X } from 'lucide-react';
import type { Artifact, ConnectionView, Draft, Intent, Reference, SettingsView, SubmitRequest, ViewState, WorkDetail } from '../../shared/contracts';
import { ArtifactPane } from './ArtifactPane';
import { Empty, intents, Markdown, PaneHeader, statuses } from './common';
import { ProcessPane } from './ProcessPane';
import { ScrollArea } from './ScrollArea';
import { matchingSubmissions, sameDraft, trackSubmission, type PendingSubmission } from './pending-submission';

type Pane = 'conversation' | 'process' | 'result';
export function Workbench({ detail, settings, connected, connection, onError, refresh, onSettings, registerLeave }: { detail: WorkDetail; settings?: SettingsView; connected: boolean; connection?: ConnectionView; onError(error: unknown): void; refresh(): Promise<void>; onSettings(): void; registerLeave(fn: (() => Promise<void>) | undefined): void }) {
  const draftKey = `ytriple:message-draft:v1:${encodeURIComponent(`${connection?.mode ?? 'server'}:${connection?.serverUrl ?? ''}`)}:${detail.work.id}`;
  const [initialDraft] = useState(() => {
    try { const raw = localStorage.getItem(draftKey); if (raw) { const parsed = JSON.parse(raw) as { schema: number; draft: Draft }; if (parsed.schema === 1 && typeof parsed.draft?.text === 'string' && parsed.draft.intent in intents) return { draft: parsed.draft, recovered: true }; } }
    catch { /* The persisted server draft is still available if the local recovery copy cannot be read. */ }
    return { draft: detail.draft, recovered: false };
  });
  const pendingKey = draftKey.replace(':message-draft:', ':pending-submission:');
  const [pending, setPending] = useState<PendingSubmission | null>(() => {
    try {
      const raw = localStorage.getItem(pendingKey); if (!raw) return null;
      const value = JSON.parse(raw) as PendingSubmission;
      return value.schema === 1 && value.request?.workId === detail.work.id ? value : null;
    } catch { return null; }
  });
  const pendingRef = useRef(pending);
  const [reconciling, setReconciling] = useState(false);
  const [pendingNotFound, setPendingNotFound] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => initialDraft.draft);
  const draftRef = useRef(draft);
  const draftDirty = useRef(initialDraft.recovered);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const [view, setView] = useState<ViewState>(() => ({ ...detail.view, widths: detail.view.widths.length === 3 ? detail.view.widths : [34, 33, 33] }));
  const viewRef = useRef(view);
  const viewDirty = useRef(false);
  const viewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [materialOpen, setMaterialOpen] = useState(false);
  const [materialTitle, setMaterialTitle] = useState('');
  const [materialContent, setMaterialContent] = useState('');
  const [adding, setAdding] = useState(false);
  const [materialsExpanded, setMaterialsExpanded] = useState(false);
  const [draftSaving, setDraftSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const paneContainer = useRef<HTMLDivElement>(null);
  const running = detail.runs.find(run => run.status === 'running' || run.status === 'stopping');
  const latestRun = detail.runs.at(-1);
  const ready = connected && !!settings?.credential.configured;
  const team = settings?.team.members ?? latestRun?.settings.team.members ?? [];
  const disabled = !ready || sending || !!running || !!pending || reconciling || detail.work.archived;
  const errorRef = useRef(onError); errorRef.current = onError;
  const flushDraft = useCallback(async () => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    if (!draftDirty.current) return saveQueue.current;
    const saved = draftRef.current;
    draftDirty.current = false;
    setDraftSaving(true);
    const next = saveQueue.current.catch(() => undefined).then(() => window.ytriple.saveDraft({ workId: detail.work.id, draft: saved }));
    saveQueue.current = next;
    try { await next; if (draftRef.current === saved) localStorage.removeItem(draftKey); } catch (e) { if (draftRef.current === saved) draftDirty.current = true; throw e; } finally { setDraftSaving(false); }
  }, [detail.work.id, draftKey]);
  const flushView = useCallback(async () => {
    if (viewTimer.current) clearTimeout(viewTimer.current);
    if (!viewDirty.current) return;
    const saved = viewRef.current; viewDirty.current = false;
    try { await window.ytriple.saveView({ workId: detail.work.id, view: saved }); } catch (e) { viewDirty.current = true; throw e; }
  }, [detail.work.id]);
  const flush = useCallback(async () => { await Promise.all([flushDraft(), flushView()]); }, [flushDraft, flushView]);
  useEffect(() => {
    registerLeave(flush);
    if (draftDirty.current) void flushDraft().catch(errorRef.current);
    const saveBeforeClose = () => { void flush().catch(errorRef.current); };
    window.addEventListener('pagehide', saveBeforeClose);
    return () => { registerLeave(undefined); window.removeEventListener('pagehide', saveBeforeClose); void flush().catch(errorRef.current); };
  }, [flush]);
  function updateDraft(patch: Partial<Draft>) {
    const next = { ...draftRef.current, ...patch };
    draftRef.current = next; draftDirty.current = true; setDraft(next);
    try { localStorage.setItem(draftKey, JSON.stringify({ schema: 1, draft: next })); } catch (e) { onError(e); }
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => void flushDraft().catch(onError), 450);
  }
  const updateView = useCallback((patch: Partial<ViewState>) => {
    const next = { ...viewRef.current, ...patch, scroll: patch.scroll ? { ...viewRef.current.scroll, ...patch.scroll } : viewRef.current.scroll };
    viewRef.current = next; viewDirty.current = true; setView(next);
    if (viewTimer.current) clearTimeout(viewTimer.current);
    viewTimer.current = setTimeout(() => void flushView().catch(errorRef.current), 500);
  }, [flushView]);
  useEffect(() => {
    if (!viewRef.current.artifactId && detail.artifacts.length) {
      const first = detail.artifacts[0]; updateView({ artifactId: first.id, artifactVersion: first.currentVersion || first.versions.at(-1)?.version });
    }
  }, [detail.artifacts, updateView]);
  function focus(pane: Pane) { updateView({ focusedPane: view.focusedPane === pane ? 'all' : pane, activePane: pane }); }
  function savePending(value: PendingSubmission) {
    localStorage.setItem(pendingKey, JSON.stringify(value));
    pendingRef.current = value; setPending(value); setPendingNotFound(false);
  }
  function clearPending() {
    localStorage.removeItem(pendingKey);
    pendingRef.current = null; setPending(null); setPendingNotFound(false);
  }
  async function submit(override?: { intent: Intent; prompt: string; reference?: Reference }) {
    const submittedDraft = draftRef.current;
    const prompt = override?.prompt ?? submittedDraft.text.trim();
    if (!prompt || disabled || pendingRef.current) return;
    setSending(true); setNotice('');
    await trackSubmission(async () => {
      let awaitingAcknowledgement = false;
      try {
        await flush();
        const request: SubmitRequest = { workId: detail.work.id, prompt, intent: override?.intent ?? submittedDraft.intent, targetMemberId: override ? undefined : submittedDraft.targetMemberId, reference: override?.reference ?? (override ? undefined : submittedDraft.reference) };
        savePending({ schema: 1, request, draft: submittedDraft, beforeRunIds: detail.runs.map(run => run.id), startedAt: new Date().toISOString(), clearDraftOnAcceptance: !override });
        awaitingAcknowledgement = true;
        await window.ytriple.submit(request);
        awaitingAcknowledgement = false;
        clearPending();
        if (!override && sameDraft(draftRef.current, submittedDraft)) { updateDraft({ text: '', reference: undefined, intent: 'discuss' }); await flushDraft(); }
        await refresh();
      } catch (e) {
        onError(e);
        if (awaitingAcknowledgement) setNotice('上次提交的响应未确认，可能已在服务端开始。请先核对提交状态。');
      } finally { setSending(false); }
    });
  }
  async function reconcileSubmission() {
    const saved = pendingRef.current; if (!saved || reconciling) return;
    setReconciling(true); setPendingNotFound(false);
    await trackSubmission(async () => {
      try {
        const latest = await window.ytriple.getWork(saved.request.workId);
        const matches = matchingSubmissions(saved, latest.runs);
        if (matches.length === 1) {
          clearPending();
          if (saved.clearDraftOnAcceptance && sameDraft(draftRef.current, saved.draft)) { updateDraft({ text: '', reference: undefined, intent: 'discuss' }); await flushDraft(); }
          setNotice(`已找到与上次请求一致的新运行：${statuses[matches[0].status]}。没有重复提交。`);
          await refresh();
        } else {
          setPendingNotFound(true);
          setNotice(matches.length > 1 ? '有多条与上次请求一致的运行，请先核对交流和过程记录。' : '最新状态中尚未找到与上次请求一致的新运行。请核对交流记录后再决定是否重新发送。');
          await refresh();
        }
      } catch (e) { onError(e); } finally { setReconciling(false); }
    });
  }
  function reference(ref: Reference, memberId: string | undefined, intent: 'explain' | 'revise') {
    const targetMemberId = memberId && team.some(member => member.id === memberId) ? memberId : undefined;
    updateDraft({ reference: ref, targetMemberId, intent, text: draftRef.current.text || (intent === 'explain' ? '请解释这一步的方法、依据，以及还有哪些要求没有达到。' : '') });
    if (memberId && !targetMemberId) setNotice('这条记录的原成员已离开当前团队；引用仍保留，交由当前团队继续解释与核查。');
    updateView({ activePane: 'conversation', ...(viewRef.current.focusedPane !== 'all' ? { focusedPane: 'conversation' as const } : {}) });
    setTimeout(() => input.current?.focus(), 0);
  }
  function summary(intent: 'summarize' | 'reflect', runId?: string) {
    const scope = runId ? `仅处理运行 ${runId}（第 ${detail.runs.findIndex(run => run.id === runId) + 1} 轮）` : '处理本项工作已经实际记录的过程与成果';
    const prompt = intent === 'summarize' ? `请总结过程：${scope}。形成可学习的处理流程、关键步骤与要求、成员贡献、决定和未完成部分，引用原始记录。只描述实际公开的分析，不补造内部思考。请生成过程总结成果。` : `请复盘工作：${scope}。检查目标与成果的差距、未达到要求的步骤、用户修正及其影响，注明准确成果版本和证据。没有实际使用反馈时只评价过程与成果，不声称使用效果改善；说明阶段状态。请生成工作复盘成果。`;
    const event = runId ? detail.events.find(item => item.runId === runId) : undefined;
    if (runId && !event) { onError(new Error('所选轮次还没有可总结的过程记录。')); return; }
    void submit({ intent, prompt, ...(event ? { reference: { kind: 'event', id: event.id } as Reference } : {}) });
  }
  async function stop() { if (!running) return; setStopping(true); try { await window.ytriple.stop(running.id); await refresh(); } catch (e) { onError(e); } finally { setStopping(false); } }
  async function addMaterial() { if (!materialTitle.trim() || !materialContent.trim()) return; setAdding(true); try { await window.ytriple.addMaterial({ workId: detail.work.id, title: materialTitle.trim(), content: materialContent }); setMaterialOpen(false); setMaterialTitle(''); setMaterialContent(''); setMaterialsExpanded(true); await refresh(); } catch (e) { onError(e); } finally { setAdding(false); } }
  async function importMaterials() { setAdding(true); try { const imported = await window.ytriple.importMaterials(detail.work.id); if (imported.length) { setNotice(`已添加 ${imported.length} 份材料，下次运行会纳入本项工作。`); setMaterialsExpanded(true); await refresh(); } } catch (e) { onError(e); } finally { setAdding(false); } }
  function resize(index: number, e: PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const width = paneContainer.current?.clientWidth ?? 1000;
    const startX = e.clientX; const initial = [...viewRef.current.widths]; const pair = initial[index] + initial[index + 1];
    const onMove = (event: globalThis.PointerEvent) => { const next = [...initial]; next[index] = Math.max(20, Math.min(pair - 20, initial[index] + (event.clientX - startX) / width * 100)); next[index + 1] = pair - next[index]; updateView({ widths: next }); };
    const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); void flushView().catch(onError); };
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp, { once: true });
  }
  const refDescription = draft.reference ? draft.reference.kind === 'event' ? detail.events.find(event => event.id === draft.reference?.id)?.title ?? '过程记录' : `${detail.artifacts.find(artifact => artifact.id === draft.reference?.id)?.title ?? '成果'} · v${draft.reference.version}` : '';
  const paneHeader = (pane: Pane, title: string, subtitle: string, index: string) => <PaneHeader title={title} subtitle={subtitle} index={index} focused={view.focusedPane === pane} onFocus={() => focus(pane)}/>;
  const separator = (index: number) => <div className="pane-divider" role="separator" aria-label={`调整第 ${index + 1} 与第 ${index + 2} 窗口宽度`} aria-orientation="vertical" aria-valuenow={Math.round(view.widths[index])} aria-valuemin={20} aria-valuemax={60} tabIndex={0} onPointerDown={e => resize(index, e)} onKeyDown={e => { if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return; e.preventDefault(); const next = [...view.widths]; const delta = e.key === 'ArrowLeft' ? -2 : 2; if (next[index] + delta >= 20 && next[index + 1] - delta >= 20) { next[index] += delta; next[index + 1] -= delta; updateView({ widths: next }); } }}/>;
  return <div className="workbench"><header className="work-header"><div><div className="work-title-line"><h1>{detail.work.title}</h1>{detail.work.archived ? <span className="badge">已归档</span> : null}</div><p title={detail.work.goal}>{detail.work.goal}</p></div><div className="work-status"><span className={running ? 'run-status working' : `run-status ${latestRun?.status === 'failed' ? 'failed' : ''}`}><i className={running ? 'pulsing' : ''}/>{sending ? '正在提交' : running ? statuses[running.status] : latestRun ? statuses[latestRun.status] : '等待开始'}</span>{running ? <button className="stop-button" disabled={stopping || running.status === 'stopping'} onClick={() => void stop()}><Square size={12}/>{stopping || running.status === 'stopping' ? '正在停止' : '停止'}</button> : null}<span className="execution-note" title={connection?.serverUrl}>{connection?.mode === 'server' ? `服务器 · ${connection.serverUrl || '未连接'}` : '本机独立执行'}</span></div></header>
    {notice ? <div className="work-notice" role="status"><Check size={15}/><span>{notice}</span><button className="icon-button" aria-label="关闭通知" onClick={() => setNotice('')}><X size={14}/></button></div> : null}
    <div className="mobile-pane-tabs" role="tablist" aria-label="工作窗口">{(['conversation', 'process', 'result'] as const).map(pane => <button role="tab" aria-selected={view.activePane === pane} key={pane} onClick={() => updateView({ activePane: pane, focusedPane: 'all' })}>{pane === 'conversation' ? '交流' : pane === 'process' ? '思维过程' : '成果'}</button>)}</div>
    <div ref={paneContainer} className={`panes focus-${view.focusedPane} active-${view.activePane}`} style={{ gridTemplateColumns: `${view.widths[0]}fr 7px ${view.widths[1]}fr 7px ${view.widths[2]}fr` }}>
      <section className="pane conversation-pane" aria-label="主窗口">{paneHeader('conversation', '一起把方向想清楚', 'CONVERSATION', '01')}<div className="team-strip"><Users size={15}/>{team.length ? team.map((member, index) => <button className={draft.targetMemberId === member.id ? 'team-member selected' : 'team-member'} key={member.id} onClick={() => updateDraft({ targetMemberId: draft.targetMemberId === member.id ? undefined : member.id })} title={`${member.role} · 点击直接交流`}><span className={`avatar member-${index % 3}`}>{member.name.slice(0, 1)}</span>{member.name}</button>) : <span className="muted small">连接后显示团队</span>}<button className="icon-button" aria-label="配置团队" title="配置团队" onClick={onSettings}><Plus size={14}/></button></div>
      <div className="materials-bar"><button className="text-button" onClick={() => setMaterialsExpanded(!materialsExpanded)}><Paperclip size={13}/>材料 {detail.materials.length}<ChevronDown size={12}/></button><span>本项工作范围</span><button className="text-button" onClick={() => setMaterialOpen(true)}>添加文本</button><button className="text-button" disabled={adding} onClick={() => void importMaterials()}><FilePlus2 size={13}/>导入</button></div>{materialsExpanded ? <div className="material-list">{detail.materials.length ? detail.materials.map(material => <details key={material.id}><summary><FileText size={13}/>{material.title}<small>{material.content.length.toLocaleString()} 字符</small></summary><Markdown>{material.content}</Markdown></details>) : <p>还没有材料。可以添加文本，或导入 Markdown / 文本文件。</p>}</div> : null}
      <ScrollArea identity={`conversation:${detail.work.id}`} initial={view.scroll.conversation ?? 0} changeToken={detail.messages.length} follow onPosition={top => updateView({ scroll: { conversation: top } })}><div className="messages">{!detail.messages.length ? <Empty icon={<MessageSquare size={28}/>} title="目标有了，一起往下走">向团队提出第一个问题，也可以先补充背景和资料。你可以指定成员，或让统筹组织这项工作。</Empty> : detail.messages.map(message => { const run = detail.runs.find(item => item.id === message.runId); const member = run?.settings.team.members.find(item => item.id === message.memberId); return <article className={`message ${message.role}`} key={message.id}><header><span className={`avatar ${message.role === 'user' ? 'user-avatar' : 'member-0'}`}>{message.role === 'user' ? 'Y' : (member?.name ?? '团队').slice(0, 1)}</span><strong>{message.role === 'user' ? '你' : member?.name ?? '团队'}</strong><time>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></header>{message.reference ? <div className="message-reference"><ArrowUpRight size={12}/>{message.reference.kind === 'event' ? '引用过程记录' : `引用成果 v${message.reference.version}`}{message.reference.quote ? <q>{message.reference.quote}</q> : null}</div> : null}<Markdown>{message.content}</Markdown>{run && message.role === 'assistant' ? <button className="text-button" onClick={() => updateView({ activePane: 'process', ...(view.focusedPane !== 'all' ? { focusedPane: 'process' as const } : {}) })}>对照本轮过程<ArrowUpRight size={12}/></button> : null}</article>; })}{running ? <div className="working-note"><LoaderCircle className="spin" size={15}/>{running.status === 'stopping' ? '停止已请求，正在保留已完成记录。' : '团队正在处理；公开汇报会出现在思维窗口。'}</div> : null}</div></ScrollArea>
      <div className="composer">{pending ? <div className="pending-submission" role="status"><strong>上次提交尚未确认</strong><p>请求与草稿已保留；重开也不会自动重试。先核对服务端状态，避免重复运行。</p><button className="secondary-button" disabled={sending || reconciling} onClick={() => void reconcileSubmission()}>{reconciling ? <LoaderCircle size={13} className="spin"/> : null}核对提交状态</button>{pendingNotFound ? <button className="text-button" disabled={reconciling} onClick={() => { try { clearPending(); setNotice('已按你的核对结果解除阻挡。重新发送仍需你点击发送按钮。'); } catch (e) { onError(e); } }}>我已核对记录，允许重新发送</button> : null}</div> : null}<div className="composer-options"><label><span className="sr-only">交流对象</span><select aria-label="交流对象" value={draft.targetMemberId ?? ''} onChange={e => updateDraft({ targetMemberId: e.target.value || undefined })}><option value="">整个团队</option>{team.map(member => <option value={member.id} key={member.id}>{member.name}</option>)}</select></label><label><span className="sr-only">发言意图</span><select aria-label="发言意图" value={draft.intent} onChange={e => updateDraft({ intent: e.target.value as Intent })}>{Object.entries(intents).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label></div>{draft.reference ? <div className="reference-chip"><div><strong>{draft.reference.kind === 'event' ? '针对过程' : '针对成果'} · {refDescription}</strong>{draft.reference.quote ? <p>“{draft.reference.quote}”</p> : null}</div><button className="icon-button" aria-label="移除引用" onClick={() => updateDraft({ reference: undefined })}><X size={14}/></button></div> : null}{draft.intent === 'change-goal' ? <p className="intent-note">这次发言将更新整项工作的目标，后续运行使用新目标。</p> : null}<label className="sr-only" htmlFor="message-input">与团队交流</label><textarea ref={input} id="message-input" value={draft.text} onChange={e => updateDraft({ text: e.target.value })} placeholder={draft.targetMemberId ? `向${team.find(member => member.id === draft.targetMemberId)?.name ?? '成员'}提问或提出修正…` : '说说你的想法，或指出需要更进一步的地方…'} rows={3} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); } }}/><div className="composer-footer"><span>{draftSaving ? '正在保存草稿…' : '草稿自动保留'}<small>⌘ / Ctrl ↵ 发送</small></span><button className="send-button" aria-label="发送给团队" disabled={disabled || !draft.text.trim()} onClick={() => void submit()}>{sending ? <LoaderCircle className="spin" size={16}/> : <Send size={16}/>}发送</button></div>{!ready ? <button className="setup-inline" onClick={onSettings}>{connected ? '模型尚未配置，打开设置' : '服务已断开，检查连接'}<ArrowUpRight size={13}/></button> : detail.work.archived ? <p className="intent-note">这项工作已归档，请从工作列表恢复后继续。</p> : null}</div></section>
      {separator(0)}
      <section className="pane process-pane" aria-label="思维窗口">{paneHeader('process', '看见协作与方法', 'PROCESS', '02')}<ProcessPane detail={detail} memberFilter={view.eventMemberFilter} setMemberFilter={value => updateView({ eventMemberFilter: value })} onReference={reference} onSummary={summary} scroll={view.scroll.process ?? 0} onScroll={top => updateView({ scroll: { process: top } })} disabled={disabled}/></section>
      {separator(1)}
      <section className="pane result-pane" aria-label="结果窗口">{paneHeader('result', '留下可用的成果', 'RESULT', '03')}<ArtifactPane detail={detail} view={view} namespace={encodeURIComponent(`${connection?.mode ?? 'server'}:${connection?.serverUrl ?? ''}`)} onView={updateView} onReference={reference} onError={onError} onSaved={async (artifact: Artifact) => { await refresh(); setNotice(`已保存「${artifact.title}」的新版本。`); }}/></section>
    </div>
    {materialOpen ? <div className="modal-backdrop"><form className="small-modal material-modal" onSubmit={e => { e.preventDefault(); void addMaterial(); }}><div className="modal-heading"><h2>添加工作材料</h2><button type="button" className="icon-button" onClick={() => setMaterialOpen(false)} aria-label="关闭添加材料"><X size={18}/></button></div><p>材料保存在本项工作，下次运行时会提供给团队。</p><label>材料名称<input autoFocus value={materialTitle} onChange={e => setMaterialTitle(e.target.value)} placeholder="这份材料是什么？"/></label><label>文本内容<textarea rows={9} value={materialContent} onChange={e => setMaterialContent(e.target.value)} placeholder="粘贴背景、需求、笔记或原始资料…"/></label><div className="form-actions"><button type="button" className="secondary-button" onClick={() => setMaterialOpen(false)}>取消</button><button className="primary-button" disabled={adding || !materialTitle.trim() || !materialContent.trim()}>{adding ? <LoaderCircle size={15} className="spin"/> : <Plus size={15}/>}添加材料</button></div></form></div> : null}
  </div>;
}
