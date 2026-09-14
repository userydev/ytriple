import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Archive, BookOpen, ChevronRight, CircleAlert, FolderKanban, House, LoaderCircle, Plus, Radio, RefreshCw, Settings2, Sparkles, Workflow, X } from 'lucide-react';
import type { ConnectionView, SettingsView, Work, WorkDetail } from '../../shared/contracts';
import { dateText, Empty, errorText } from './common';
import { Workbench } from './Workbench';
import { SettingsDrawer } from './SettingsDrawer';
import { settleSubmissions } from './pending-submission';

type Page = 'home' | 'works' | 'projects' | 'radar' | 'library' | 'tasks';
const nav = [{ id: 'home', label: '首页', icon: House }, { id: 'works', label: '工作', icon: Workflow }, { id: 'projects', label: '项目', icon: FolderKanban }, { id: 'radar', label: '雷达', icon: Radio }, { id: 'library', label: '资产', icon: BookOpen }] as const;
export function App() {
  const [page, setPage] = useState<Page>('home');
  const [works, setWorks] = useState<Work[]>([]);
  const [detail, setDetail] = useState<WorkDetail>();
  const [activeId, setActiveId] = useState<string>();
  const activeRef = useRef<string | undefined>(undefined);
  const [settings, setSettings] = useState<SettingsView>();
  const [connection, setConnection] = useState<ConnectionView>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [goal, setGoal] = useState('');
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [renameId, setRenameId] = useState<string>();
  const [name, setName] = useState('');
  const beforeLeave = useRef<(() => Promise<void>) | undefined>(undefined);
  const request = useRef(0);
  const listRequest = useRef(0);
  const session = useRef(0);
  const report = useCallback((e: unknown) => setError(errorText(e)), []);
  const refreshList = useCallback(async () => {
    const ticket = ++listRequest.current; const epoch = session.current;
    try { const list = await window.ytriple.listWorks(); if (epoch !== session.current || ticket !== listRequest.current) return; setWorks(list); setConnected(true); }
    catch (e) { if (epoch === session.current && ticket === listRequest.current) { setConnected(false); report(e); } }
  }, [report]);
  const refreshActive = useCallback(async (id = activeRef.current) => {
    if (!id) return;
    const ticket = ++request.current; const epoch = session.current;
    try { const work = await window.ytriple.getWork(id); if (epoch !== session.current || ticket !== request.current || id !== activeRef.current) return; setDetail(work); setConnected(true); }
    catch (e) { if (epoch === session.current && ticket === request.current && id === activeRef.current) { setConnected(false); report(e); } }
  }, [report]);
  const refresh = useCallback(async (id = activeRef.current) => { await Promise.all([refreshList(), refreshActive(id)]); }, [refreshList, refreshActive]);
  const load = useCallback(async () => {
    const epoch = ++session.current;
    setLoading(true);
    try { const value = await window.ytriple.getConnection(); if (epoch === session.current) setConnection(value); } catch (e) { report(e); }
    const results = await Promise.allSettled([window.ytriple.listWorks(), window.ytriple.getSettings()]);
    if (epoch !== session.current) return;
    if (results[0].status === 'fulfilled') { setWorks(results[0].value); setConnected(true); } else { setConnected(false); report(results[0].reason); }
    if (results[1].status === 'fulfilled') setSettings(results[1].value); else { setSettings(undefined); report(results[1].reason); }
    setLoading(false);
  }, [report]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    let workTimer: ReturnType<typeof setTimeout> | undefined;
    let listTimer: ReturnType<typeof setTimeout> | undefined;
    const dispose = window.ytriple.onChanged(event => {
      if ((!event.workId || event.workId === activeRef.current) && !workTimer) {
        workTimer = setTimeout(() => { workTimer = undefined; void refreshActive(); }, 140);
      }
      if (!listTimer) listTimer = setTimeout(() => { listTimer = undefined; void refreshList(); }, 850);
    });
    return () => { dispose(); if (workTimer) clearTimeout(workTimer); if (listTimer) clearTimeout(listTimer); };
  }, [refreshList, refreshActive]);
  async function leave() { await beforeLeave.current?.(); }
  async function navigate(next: Page) { try { await leave(); activeRef.current = undefined; setActiveId(undefined); setDetail(undefined); ++request.current; setPage(next); void refresh(undefined); } catch (e) { report(e); } }
  async function openWork(id: string) { try { await leave(); activeRef.current = id; setActiveId(id); setDetail(undefined); setPage('works'); await refresh(id); } catch (e) { report(e); } }
  async function create() {
    if (!goal.trim()) return;
    setCreating(true);
    try { await leave(); const work = await window.ytriple.createWork({ title: goal.trim().split('\n')[0].slice(0, 48), goal: goal.trim() }); setGoal(''); activeRef.current = work.work.id; setActiveId(work.work.id); setDetail(work); setPage('works'); await refresh(work.work.id); } catch (e) { report(e); } finally { setCreating(false); }
  }
  async function archive(work: Work) { try { await window.ytriple.archiveWork({ workId: work.id, archived: !work.archived }); await refresh(); } catch (e) { report(e); } }
  async function rename() { if (!renameId || !name.trim()) return; try { await window.ytriple.renameWork({ workId: renameId, title: name.trim() }); setRenameId(undefined); await refresh(); } catch (e) { report(e); } }
  const visibleWorks = works.filter(work => work.archived === showArchived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const status = loading ? '正在连接' : !connected ? '服务未连接' : !settings?.credential.configured ? '待配置模型' : '团队已就绪';
  const workList = (items: Work[]) => <div className="work-list">{items.map(work => <div className="work-row" key={work.id}><button className="work-open" onClick={() => void openWork(work.id)}><span className="work-mark"><Workflow size={19}/></span><span><strong>{work.title}</strong><small>{work.goal}</small></span><time>{dateText(work.updatedAt)}</time><ChevronRight size={16}/></button><button className="text-button" onClick={() => { setRenameId(work.id); setName(work.title); }}>命名</button><button className="icon-button" title={work.archived ? '恢复工作' : '归档工作'} aria-label={work.archived ? `恢复 ${work.title}` : `归档 ${work.title}`} onClick={() => void archive(work)}>{work.archived ? <RefreshCw size={15}/> : <Archive size={15}/>}</button></div>)}</div>;
  return <div className="app-shell">
    <aside className="sidebar"><button className="brand" aria-label="ytriple 首页" onClick={() => void navigate('home')}><span className="brand-mark">y<span>⋮</span></span></button><nav aria-label="主导航">{nav.map(item => <button key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => void navigate(item.id)}><item.icon size={20}/><span>{item.label}</span></button>)}</nav><div className="sidebar-bottom"><button className="nav-item" onClick={() => setSettingsOpen(true)} aria-label="设置"><Settings2 size={20}/><span>设置</span></button><span className="sidebar-version">P1</span></div></aside>
    <main className="app-main"><div className="topbar"><div className="breadcrumb"><span>ytriple</span><ChevronRight size={13}/><strong>{detail?.work.title ?? nav.find(item => item.id === page)?.label ?? '工作台'}</strong></div><button className={`connection-status ${connected && settings?.credential.configured ? 'ready' : ''}`} onClick={() => setSettingsOpen(true)}><i/>{status}<span>{connection?.mode === 'local' ? '本机独立' : '服务器'}</span></button></div>
      {error ? <div className="error-banner" role="alert"><CircleAlert size={17}/><span>{error}</span><button onClick={() => { setError(''); void load(); }} className="text-button">重新连接</button><button className="icon-button" onClick={() => setError('')} aria-label="关闭错误提示"><X size={16}/></button></div> : null}
      {activeId ? detail ? <Workbench key={`${connection?.mode}:${connection?.serverUrl}:${detail.work.id}`} detail={detail} settings={settings} connected={connected} connection={connection} onError={report} refresh={() => refresh(detail.work.id)} onSettings={() => setSettingsOpen(true)} registerLeave={fn => { beforeLeave.current = fn; }}/>: <div className="loading"><LoaderCircle size={22} className="spin"/>正在读取工作…{!loading && !connected ? <button className="text-button" onClick={() => void refresh(activeId)}>重试读取</button> : null}</div> : <div className="page-scroll">{page === 'home' || page === 'works' ? <div className="home-content"><div className="page-heading"><span className="eyebrow">YOUR WORK, WITH A TEAM</span><h1>{page === 'home' ? '把想法，往前推进。' : '每项工作，都有来路。'}</h1><p>{page === 'home' ? '和团队一起理清目标，看见方法，形成可以继续使用的成果。' : '继续讨论、回看过程，让材料和成果保持在同一件事里。'}</p></div>
      {page === 'home' ? <section className="start-card"><div className="start-label"><Sparkles size={18}/><span>开始一项工作</span><small>团队会从你的目标出发</small></div><label className="sr-only" htmlFor="new-goal">新工作目标</label><textarea id="new-goal" value={goal} onChange={e => setGoal(e.target.value)} placeholder="现在，你想把什么事情想清楚或做出来？" rows={3}/><div className="start-footer"><span>先建立工作，再添加材料或与成员交流</span><button className="primary-button" disabled={creating || !goal.trim() || !connected} onClick={() => void create()}>{creating ? <LoaderCircle size={16} className="spin"/> : <Plus size={16}/>}建立工作<ArrowRight size={16}/></button></div></section> : <button className="primary-button compact" onClick={() => void navigate('home')}><Plus size={16}/>新建工作</button>}
      {!connected || !settings?.credential.configured ? <div className="setup-callout"><div><strong>{!connected ? '连接你的团队服务' : '工作空间已连接，模型尚未就绪'}</strong><p>{!connected ? '默认连接服务器统一提供 AI 能力；也可以选择本机独立运行。' : '可以建立工作、阅读和整理材料。开始 AI 协作前需要配置可用模型。'}</p></div><button className="secondary-button" onClick={() => setSettingsOpen(true)}>打开设置<ArrowRight size={15}/></button></div> : null}
      <div className="section-heading"><h2>{page === 'home' ? '继续工作' : '工作记录'} <span>{visibleWorks.length}</span></h2><button className="text-button" onClick={() => setShowArchived(!showArchived)}>{showArchived ? '查看进行中的工作' : '查看归档'}</button></div>{visibleWorks.length ? workList(page === 'home' ? visibleWorks.slice(0, 6) : visibleWorks) : <Empty icon={<Workflow size={27}/>} title={showArchived ? '没有归档的工作' : '从一个真实目标开始'}>你建立的工作会出现在这里。每次交流、过程记录和成果版本都留在同一项工作中。</Empty>}
      <div className="home-footnote"><span className="three-dots"><i/><i/><i/></span>交流确定方向 · 过程看见方法 · 成果保留进展</div></div> : <div className="future-page"><span className="eyebrow">后续能力</span><Empty icon={page === 'radar' ? <Radio size={32}/> : page === 'projects' ? <FolderKanban size={32}/> : <BookOpen size={32}/>} title={page === 'radar' ? '雷达与信息来源尚未接入' : page === 'projects' ? '项目初始化与管理尚未接入' : '资产与方法库尚未接入'}>{page === 'radar' ? '后续由服务器管理来源、整理信息并提供订阅。当前版本不会抓取来源或生成推送。' : page === 'projects' ? '后续将团队讨论转为标准项目材料，交给 Codex 等专业工具接手。现在可以先在工作中讨论产品和方案。' : '后续在这里查找、复用成果与方法。当前可在设置中管理内置 Skill，在原工作中查阅成果。'}</Empty><button className="secondary-button" onClick={() => void navigate('home')}>开始一项工作<ArrowRight size={16}/></button></div>}</div>}
    </main>
    {settingsOpen ? <SettingsDrawer settings={settings} connection={connection} onClose={() => setSettingsOpen(false)} onSaved={value => setSettings(value)} onBeforeConnect={async () => { await settleSubmissions(); await leave(); }} onConnected={async () => { activeRef.current = undefined; setActiveId(undefined); setDetail(undefined); setWorks([]); setSettings(undefined); setError(''); setPage('home'); await load(); }} onError={report}/> : null}
    {renameId ? <div className="modal-backdrop"><form className="small-modal" onSubmit={e => { e.preventDefault(); void rename(); }}><h2>给工作命名</h2><label>工作名称<input autoFocus value={name} onChange={e => setName(e.target.value)} maxLength={160}/></label><div className="form-actions"><button type="button" className="secondary-button" onClick={() => setRenameId(undefined)}>取消</button><button className="primary-button" disabled={!name.trim()}>保存名称</button></div></form></div> : null}
  </div>;
}
