import type { ReactNode } from "react";
import Markdown from "./Markdown";
import { UnknownRunActions } from "./UnknownRunActions";
import { TeamTrace } from "./TeamTrace";
import type {
  ArtifactVersion,
  Contribution,
  Decision,
  Message,
  Run,
  Work,
} from "../core/types";
import { PanelsTopLeft, X } from "lucide-react";
import { IconButton } from "./Composer";

export function DecisionWindow({
  title,
  objectLabel,
  status,
  work,
  messages,
  latestRun,
  currentVersion,
  events: _events,
  contributions,
  decision,
  workspaceActions,
  input,
  chrome = "window",
  onExpand,
  onClose,
  onError,
  onRecord,
}: {
  title: string;
  objectLabel?: string;
  status?: string;
  work: Work | null;
  messages: Message[];
  latestRun: Run | null;
  currentVersion: ArtifactVersion | null;
  events: Contribution[];
  contributions: Contribution[];
  decision: Decision | null;
  workspaceActions?: ReactNode;
  input: ReactNode;
  chrome?: "window" | "pane";
  onExpand?: () => void;
  onClose?: () => void;
  onError: (error: unknown) => void;
  onRecord: (id: string) => void;
}) {
  const runStatus = latestRun
    ? {
        queued: "待发",
        running: "团队处理中",
        succeeded: "已回复",
        failed: "运行失败",
        unknown: "状态待核",
        cancelled: "已停止",
        waiting: "待你决定",
      }[latestRun.status]
    : status ?? "可提问";
  const heading = chrome === "window" ? "团队" : title;
  const fullTitle = work?.title ?? title;
  return (
    <section
      className={`decision-window chrome-${chrome}`}
      aria-label={fullTitle}
    >
      <header className="decision-window-head">
        <div>
          <strong title={fullTitle}>{heading}</strong>
          <p className="muted">{objectLabel ?? runStatus}</p>
        </div>
        <div className="tool-group">
          {onExpand ? (
            <IconButton label="展开团队工作区" onClick={onExpand}>
              <PanelsTopLeft size={18} />
            </IconButton>
          ) : null}
          {onClose ? (
            <IconButton label="关闭" onClick={onClose}>
              <X size={16} />
            </IconButton>
          ) : null}
        </div>
      </header>
      <div className="decision-window-body">
        {messages.map((message) => (
          <article className={`message ${message.role}`} key={message.id}>
            <small>{message.role === "user" ? "你" : "团队"}</small>
            <Markdown>{message.body}</Markdown>
          </article>
        ))}
        {latestRun ? (
          <TeamTrace
            run={latestRun}
            records={contributions.filter(
              (item) =>
                item.workId === work?.id &&
                item.runId === latestRun.id &&
                !item.task?.parentId &&
                !item.tool &&
                !item.toolFormatError,
            )}
            compact
            onRecord={onRecord}
          />
        ) : null}
        {currentVersion ? (
          <article className="decision-version" data-version-id={currentVersion.id}>
            <small>当前版本 · 完整正文</small>
            <Markdown>{currentVersion.body}</Markdown>
          </article>
        ) : null}
        {decision ? (
          <aside className="decision-pending" role="status">
            <h3>{decision.question}</h3>
            <p className="muted">{decision.impact}</p>
          </aside>
        ) : null}
        {latestRun?.status === "unknown" ? (
          <UnknownRunActions
            id={latestRun.id}
            kind="work"
            local={latestRun.recovery === "local"}
            onError={onError}
          />
        ) : null}
        {latestRun?.error ? (
          <p className="error-inline">{latestRun.error}</p>
        ) : null}
        {workspaceActions}
        {!messages.length && !currentVersion && !latestRun ? (
          <p className="muted">
            想了解什么，或需要做什么决定？
          </p>
        ) : null}
      </div>
      <div className="decision-window-input">{input}</div>
    </section>
  );
}
