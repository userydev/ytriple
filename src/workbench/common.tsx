import { useEffect, useRef, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { normalizeMathDelimiters, remarkHeadingIds } from "../shared/markdown";
import { X } from "lucide-react";
import {
  MEMBERS,
  type Command,
  type Snapshot,
  type TaskStatus,
  type MemberId,
} from "../shared/types";

export type Dispatch = (command: Command) => Promise<Snapshot | null>;
export const STATUS_NAMES: Record<TaskStatus, string> = {
  idle: "待开始",
  running: "进行中",
  waiting: "等待中",
  paused: "已暂停",
  failed: "需要处理",
  completed: "已完成",
};
export const memberName = (id: MemberId) =>
  MEMBERS.find((member) => member.id === id)?.shortName ?? id;
export const formatTime = (date: string) => {
  const value = new Date(date);
  return Number.isNaN(value.getTime())
    ? "时间未知"
    : value.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
};
export const formatDate = (date: string) => {
  const value = new Date(date);
  return Number.isNaN(value.getTime())
    ? "时间未知"
    : value.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
};

export function Markdown({
  children,
  dispatch,
  onArtifactLink,
  onDocumentLink,
}: {
  children: string;
  dispatch: Dispatch;
  onArtifactLink?: (artifactId: string) => void;
  onDocumentLink?: (href: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  return (
    <div className="markdown" ref={container}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkHeadingIds]}
        rehypePlugins={[
          [
            rehypeKatex,
            { trust: false, strict: "ignore", maxExpand: 1000, maxSize: 20 },
          ],
        ]}
        urlTransform={(url) =>
          /^artifact:[a-zA-Z0-9-]+$/.test(url) ? url : defaultUrlTransform(url)
        }
        components={{
          a: ({ href, children, node: _node, ...properties }) => (
            <a
              {...properties}
              href={href}
              onClick={(event) => {
                event.preventDefault();
                if (href?.startsWith("#")) {
                  let id: string;
                  try {
                    id = decodeURIComponent(href.slice(1));
                  } catch {
                    return;
                  }
                  const target = Array.from(
                    container.current?.querySelectorAll<HTMLElement>("[id]") ??
                      [],
                  ).find((element) => element.id === id);
                  target?.scrollIntoView({
                    behavior: "smooth",
                    block: "start",
                  });
                } else if (href?.startsWith("artifact:"))
                  onArtifactLink?.(href.slice(9));
                else if (
                  href &&
                  !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) &&
                  !href.startsWith("/") &&
                  !href.startsWith("\\")
                )
                  onDocumentLink?.(href);
                if (href && /^https?:\/\//i.test(href))
                  void dispatch({ type: "url.open", url: href });
              }}
            >
              {children}
            </a>
          ),
          img: ({ alt }) => (
            <span className="embedded-image-note">
              {alt ? `图片：${alt}` : "图片引用"} · 在原始成果中查看
            </span>
          ),
          table: ({ children }) => (
            <div
              className="markdown-table-scroll"
              tabIndex={0}
              role="region"
              aria-label="表格，可横向滚动"
            >
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {normalizeMathDelimiters(children)}
      </ReactMarkdown>
    </div>
  );
}

export function Modal({
  title,
  description,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const focusable = () =>
      Array.from(
        container.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]',
        ) ?? [],
      );
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") {
        const items = focusable();
        const first = items[0];
        const last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${wide ? "modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        ref={container}
      >
        <header className="modal-header">
          <div>
            <h2 id="modal-title">{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          <button
            className="icon-button"
            aria-label="关闭对话框"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
