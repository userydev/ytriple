import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import type { Snapshot } from "../shared/types";
import type {
  AttentionCommand,
  AttentionItem,
  AttentionMode,
} from "../shared/attention";
import { formatDate, type Dispatch } from "./common";

interface ActionState {
  pending: boolean;
  error: string;
  command?: AttentionCommand;
}
interface PreferenceDraft extends ActionState {
  mode: AttentionMode;
  revision: number;
}
const pendingActions = new Map<string, ActionState>();
const preferenceDrafts = new Map<string, PreferenceDraft>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const emptyAction: ActionState = { pending: false, error: "" };
function useAction(key: string, dispatch: Dispatch) {
  const read = useCallback(() => pendingActions.get(key) ?? emptyAction, [key]);
  const state = useSyncExternalStore(subscribe, read, read);
  const submit = async (command: AttentionCommand) => {
    const current = read();
    if (current.pending) return;
    // A retry of the same action uses the original idempotency key.
    const matches =
      current.command?.type === "attention.resolve" &&
      command.type === "attention.resolve" &&
      current.command.action === command.action;
    const submitted = {
      pending: true,
      error: "",
      command: matches ? current.command! : command,
    };
    pendingActions.set(key, submitted);
    emit();
    try {
      const result = await dispatch(submitted.command);
      if (result) pendingActions.delete(key);
      else
        pendingActions.set(key, {
          ...submitted,
          pending: false,
          error: "操作未完成，请查看提示后重试。原事项已保留。",
        });
    } catch (error) {
      pendingActions.set(key, {
        ...submitted,
        pending: false,
        error: error instanceof Error ? error.message : "处理失败，请重试。",
      });
    }
    emit();
  };
  return { state, submit };
}
const reasonLabels: Record<AttentionItem["reason"], string> = {
  waiting: "需要判断或补充",
  failed: "实际受阻",
  result: "新成果",
  revision: "待修订",
  feedback: "反馈待判断",
  check: "检查成果待查看",
};

function AttentionRow({
  item,
  scope,
  dispatch,
  onTask,
  onSection,
  onService,
}: {
  item: AttentionItem;
  scope: string;
  dispatch: Dispatch;
  onTask: (id: string) => void;
  onSection?: (section: "deliveries" | "routines") => void;
  onService?: () => void;
}) {
  const { state, submit } = useAction(
    `${scope}:${item.id}:${item.fingerprint}`,
    dispatch,
  );
  const act = (action: "handled" | "snoozed" | "open") =>
    void submit({
      type: "attention.resolve",
      requestId: crypto.randomUUID(),
      itemId: item.id,
      expectedFingerprint: item.fingerprint,
      action,
      ...(action === "snoozed"
        ? { snoozedUntil: new Date(Date.now() + 86400000).toISOString() }
        : {}),
    });
  return (
    <article className="attention-item" data-attention-id={item.id}>
      <div className="attention-item-heading">
        <strong>{item.title}</strong>
        <span
          className={
            item.importance === "important" ? "attention-important" : ""
          }
        >
          {reasonLabels[item.reason]}
        </span>
      </div>
      <p>{item.summary}</p>
      <div className="attention-item-meta">
        {formatDate(item.occurredAt)}
        {item.state === "snoozed"
          ? ` · 暂缓至 ${formatDate(item.snoozedUntil!)}`
          : item.state === "handled"
            ? " · 本次提醒已处理"
            : ""}
      </div>
      <div className="attention-item-actions">
        {item.origin.workTaskId || item.origin.taskId ? (
          <button
            type="button"
            className="text-button"
            onClick={() =>
              onTask((item.origin.workTaskId ?? item.origin.taskId)!)
            }
          >
            {item.origin.workTaskId ? "查看检查与过程" : "查看原工作"}
          </button>
        ) : null}
        {item.origin.workTaskId && item.origin.taskId ? (
          <button
            type="button"
            className="text-button"
            onClick={() => onTask(item.origin.taskId!)}
          >
            返回原工作
          </button>
        ) : null}
        {(item.kind === "delivery" || item.kind === "routine") && onSection ? (
          <button
            type="button"
            className="text-button"
            onClick={() =>
              onSection(item.kind === "delivery" ? "deliveries" : "routines")
            }
          >
            {item.kind === "delivery"
              ? "处理原交付与反馈"
              : "查看例行设置与记录"}
          </button>
        ) : null}
        {item.kind === "remote" && onService ? (
          <button type="button" className="text-button" onClick={onService}>
            查看当前账户的远端工作
          </button>
        ) : null}
        {item.state === "open" ? (
          <>
            <button
              type="button"
              disabled={state.pending}
              onClick={() => act("handled")}
            >
              标记本次已处理
            </button>
            <button
              type="button"
              disabled={state.pending}
              onClick={() => act("snoozed")}
            >
              暂缓一天
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={state.pending}
            onClick={() => act("open")}
          >
            重新提醒
          </button>
        )}
      </div>
      {state.error ? (
        <p role="alert" className="attention-error">
          {state.error}
        </p>
      ) : null}
    </article>
  );
}

function Preferences({
  scope,
  revision,
  mode,
  dispatch,
}: {
  scope: string;
  revision: number;
  mode: AttentionMode;
  dispatch: Dispatch;
}) {
  const key = `${scope}:preferences`;
  const fallback = useMemo<PreferenceDraft>(
    () => ({ revision, mode, pending: false, error: "" }),
    [key, revision, mode],
  );
  const read = useCallback(
    () => preferenceDrafts.get(key) ?? fallback,
    [key, fallback],
  );
  const draft = useSyncExternalStore(subscribe, read, read);
  const submit = async () => {
    const current = read();
    if (current.pending) return;
    const command = current.command ?? {
      type: "attention.preferences" as const,
      requestId: crypto.randomUUID(),
      expectedRevision: current.revision,
      mode: current.mode,
    };
    const submitted = { ...current, command, pending: true, error: "" };
    preferenceDrafts.set(key, submitted);
    emit();
    try {
      const result = await dispatch(command);
      if (result) preferenceDrafts.delete(key);
      else
        preferenceDrafts.set(key, {
          ...submitted,
          pending: false,
          error: "偏好未保存，选择已保留，可以重试。",
        });
    } catch (error) {
      preferenceDrafts.set(key, {
        ...submitted,
        pending: false,
        error: error instanceof Error ? error.message : "偏好保存失败。",
      });
    }
    emit();
  };
  return (
    <div className="attention-preferences">
      <div className="attention-preferences-controls">
        <label>
          应用内通知
          <select
            aria-label="应用内通知偏好"
            value={draft.mode}
            disabled={draft.pending}
            onChange={(event) => {
              preferenceDrafts.set(key, {
                ...read(),
                mode: event.target.value as AttentionMode,
                command: undefined,
                error: "",
              });
              emit();
            }}
          >
            <option value="summary">汇总所有有意义事项</option>
            <option value="important">仅重要事项</option>
            <option value="muted">静音</option>
          </select>
        </label>
        <button
          type="button"
          disabled={draft.pending || (draft.mode === mode && !draft.error)}
          onClick={() => void submit()}
        >
          保存通知偏好
        </button>
        {draft.revision !== revision ? (
          <button
            type="button"
            onClick={() => {
              preferenceDrafts.delete(key);
              emit();
            }}
          >
            采用最新偏好
          </button>
        ) : null}
      </div>
      <p className="attention-note">
        静音只关闭应用内汇总提示。标记已处理或暂缓不会采纳、拒绝反馈，也不会改变工作状态；真实问题变化后重新提醒。
      </p>
      {draft.error ? (
        <p role="alert" className="attention-error">
          {draft.error}
        </p>
      ) : null}
    </div>
  );
}

export function Attention({
  snapshot,
  dispatch,
  onTask,
  onSection,
  onService,
  standalone = false,
}: {
  snapshot: Snapshot | null;
  standalone?: boolean;
  dispatch: Dispatch;
  onTask: (id: string) => void;
  onSection?: (section: "deliveries" | "routines") => void;
  onService?: () => void;
}) {
  const [filter, setFilter] = useState<"open" | "snoozed" | "handled" | "all">(
    "open",
  );
  const attention = snapshot?.attention;
  if (!snapshot || !attention) return null;
  const visible = attention.items.filter(
    (item) => filter === "all" || item.state === filter,
  );
  const content = (
    <>
      <h2 className="attention-heading">
        待我处理 · {attention.counts.open}
        {attention.counts.important
          ? `（${attention.counts.important} 项重要）`
          : ""}
      </h2>
      <div className="attention-panel-body">
        <p className="attention-notification" role="status">
          {attention.notification.summary}
        </p>
        <details className="attention-preference-menu">
          <summary>通知偏好</summary>
          <Preferences
            scope={snapshot.dataPath}
            revision={attention.preferences.revision}
            mode={attention.preferences.mode}
            dispatch={dispatch}
          />
        </details>
        <label className="attention-filter">
          查看
          <select
            aria-label="待处理事项筛选"
            value={filter}
            onChange={(event) => setFilter(event.target.value as typeof filter)}
          >
            <option value="open">待处理（{attention.counts.open}）</option>
            <option value="snoozed">
              已暂缓（{attention.counts.snoozed}）
            </option>
            <option value="handled">
              本次已处理（{attention.counts.handled}）
            </option>
            <option value="all">全部当前事项</option>
          </select>
        </label>
        {visible.length ? (
          <div className="attention-items">
            {visible.map((item) => (
              <AttentionRow
                key={item.id + item.fingerprint}
                item={item}
                scope={snapshot.dataPath}
                dispatch={dispatch}
                onTask={onTask}
                onSection={onSection}
                onService={onService}
              />
            ))}
          </div>
        ) : (
          <p className="attention-empty">
            这个分类当前没有事项。普通回复和没有变化的例行检查不会生成提醒。
          </p>
        )}
      </div>
    </>
  );
  return standalone ? (
    <section className="attention-panel attention-standalone">
      {content}
    </section>
  ) : (
    <details className="attention-panel">
      <summary>待我处理 · {attention.counts.open}</summary>
      {content}
    </details>
  );
}
