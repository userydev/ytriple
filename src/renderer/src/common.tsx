import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Maximize2, Minimize2 } from 'lucide-react';
import type { Intent, RunStatus } from '../../shared/contracts';
export const intents: Record<Intent, string> = { discuss: '与团队讨论', 'change-goal': '调整工作目标', revise: '修订成果', explain: '解释与追问', summarize: '总结过程', reflect: '复盘工作' };
export const statuses: Record<RunStatus, string> = { running: '团队处理中', stopping: '正在请求停止', stopped: '已停止', completed: '本轮已完成', failed: '运行异常', interrupted: '运行已中断', superseded: '目标已更新' };
const ipcRequestPrefix = "Error invoking remote method 'ytriple:request': Error: ";
export const errorText = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith(ipcRequestPrefix) ? message.slice(ipcRequestPrefix.length) : message;
};
export const dateText = (date: string) => new Date(date).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
export function Markdown({ children }: { children: string }) { return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>, img: ({ src, alt }) => typeof src === 'string' && src.startsWith('data:image/') ? <img src={src} alt={alt ?? ''}/> : <span className="muted small">[图片：{alt || '外部图片未载入'}]</span> }}>{children}</ReactMarkdown></div>; }
export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) { return <div className="empty-state"><div className="empty-icon">{icon}</div><h3>{title}</h3><p>{children}</p></div>; }
export function PaneHeader({ title, subtitle: _subtitle, index: _index, focused, onFocus, children }: { index: string; title: string; subtitle: string; focused: boolean; onFocus(): void; children?: ReactNode }) { return <header className="pane-header"><h2>{title}</h2><div className="pane-actions">{children}<button className="icon-button" title={focused ? '还原三窗口' : `聚焦${title}`} aria-label={focused ? '还原三窗口' : `聚焦${title}`} onClick={onFocus}>{focused ? <Minimize2 size={15}/> : <Maximize2 size={15}/>}</button></div></header>; }
