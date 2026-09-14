import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown } from 'lucide-react';
export function ScrollArea({ children, identity, initial, changeToken, follow = false, onPosition, className = '' }: { children: ReactNode; identity: string; initial: number; changeToken: string | number; follow?: boolean; onPosition(top: number): void; className?: string }) {
  const element = useRef<HTMLDivElement>(null);
  const following = useRef(initial === 0);
  const [unread, setUnread] = useState(false);
  const waitingForLayout = useRef(false);
  const restorePosition = useRef(initial);
  const callback = useRef(onPosition); callback.current = onPosition;
  useLayoutEffect(() => {
    const node = element.current; if (!node) return;
    restorePosition.current = initial; waitingForLayout.current = true;
    const restore = () => { if (!waitingForLayout.current || node.clientHeight === 0) return; node.scrollTop = restorePosition.current; following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 90; waitingForLayout.current = false; };
    restore(); setUnread(false);
    const observer = new ResizeObserver(restore); observer.observe(node);
    return () => observer.disconnect();
  }, [identity]);
  useEffect(() => {
    const node = element.current;
    if (!node || !follow || node.clientHeight === 0 || waitingForLayout.current) return;
    const selection = window.getSelection();
    if (following.current && (!selection || selection.isCollapsed)) { node.scrollTop = node.scrollHeight; callback.current(node.scrollTop); }
    else setUnread(true);
  }, [changeToken, follow]);
  return <div className={`scroll-shell ${className}`}><div className="pane-scroll" ref={element} onScroll={e => { const node = e.currentTarget; if (node.clientHeight === 0 || waitingForLayout.current) return; following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 90; if (following.current) setUnread(false); callback.current(node.scrollTop); }}>{children}</div>{unread ? <button className="new-content" onClick={() => { const node = element.current; if (node) { node.scrollTop = node.scrollHeight; following.current = true; callback.current(node.scrollTop); setUnread(false); } }}><ArrowDown size={14}/>有新内容，跳到最新</button> : null}</div>;
}
