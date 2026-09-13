import {
  createContext,
  useContext,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type { Artifact, Snapshot, Task } from "../shared/types.js";
import {
  DELIVERY_STATUS,
  FEEDBACK_DECISION,
  type DeliveryCommand,
  type DeliveryRecord,
  type DeliverySnapshot,
  type DeliverySpec,
  type DeliveryStatus,
} from "../shared/delivery.js";

type ViewSnapshot = Pick<Snapshot, "tasks"> & { delivery?: DeliverySnapshot };
type DeliveryDispatch = (
  command: DeliveryCommand,
) => Promise<ViewSnapshot | null>;
type SharedProps = {
  snapshot: ViewSnapshot;
  dispatch: DeliveryDispatch;
  onTask?: (taskId: string) => void;
};
type RecordAction = DeliveryCommand extends infer C
  ? C extends { deliveryId: string }
    ? Omit<C, "requestId" | "deliveryId" | "expectedRevision">
    : never
  : never;
const drafts = new Map<string, Record<string, string>>();
const DraftKey = createContext("");
const value = (form: HTMLFormElement, name: string) =>
  form
    .querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      `[name="${name}"]`,
    )
    ?.value.trim() ?? "";
const selected = (form: HTMLFormElement, name: string) =>
  [...form.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)]
    .filter((input) => input.checked)
    .map((input) => input.value);
function Form({
  draftKey,
  children,
  onSubmit,
}: {
  draftKey: string;
  children: ReactNode;
  onSubmit: (form: HTMLFormElement) => void;
}) {
  const saveDraft = (form: HTMLFormElement) => {
    const data: Record<string, string> = {};
    for (const field of form.querySelectorAll<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >("[name]")) {
      if ((field as HTMLInputElement).type !== "checkbox")
        data[field.name] = field.value;
    }
    drafts.set(draftKey, data);
  };
  return (
    <DraftKey.Provider value={draftKey}>
      <form
        className="delivery-form"
        onChange={(event) => saveDraft(event.currentTarget)}
        onInput={(event) => saveDraft(event.currentTarget)}
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          saveDraft(event.currentTarget);
          onSubmit(event.currentTarget);
        }}
      >
        {children}
      </form>
    </DraftKey.Provider>
  );
}
function Field({
  name,
  label,
  initial = "",
  required = false,
  multiline = false,
  type = "text",
  help,
}: {
  name: string;
  label: string;
  initial?: string;
  required?: boolean;
  multiline?: boolean;
  type?: string;
  help?: string;
}) {
  const draftKey = useContext(DraftKey);
  const initialValue = drafts.get(draftKey)?.[name] ?? initial;
  return (
    <label className="delivery-field">
      <span>{label}</span>
      {multiline ? (
        <textarea
          name={name}
          defaultValue={initialValue}
          required={required}
          rows={3}
          maxLength={20000}
        />
      ) : (
        <input
          name={name}
          type={type}
          defaultValue={initialValue}
          required={required}
          maxLength={1000}
        />
      )}
      {help ? <small>{help}</small> : null}
    </label>
  );
}
function SpecFields({ spec }: { spec: DeliverySpec }) {
  return (
    <>
      <Field
        name="recipient"
        label="给谁使用"
        initial={spec.recipient}
        required
      />
      <Field
        name="goal"
        label="这次交付的目标"
        initial={spec.goal}
        required
        multiline
      />
      <Field
        name="criteria"
        label="怎样才算完成"
        initial={spec.criteria}
        required
        multiline
      />
      <Field
        name="missing"
        label="尚缺条件"
        initial={spec.missing}
        multiline
        help="没有未解决条件时留空。"
      />
      <Field
        name="plannedDate"
        label="计划交付日期"
        type="date"
        initial={spec.plannedDate ?? ""}
        help="仅用于安排交付，不表示实际发布或收到。"
      />
    </>
  );
}
const readSpec = (form: HTMLFormElement): DeliverySpec => ({
  recipient: value(form, "recipient"),
  goal: value(form, "goal"),
  criteria: value(form, "criteria"),
  missing: value(form, "missing"),
  ...(value(form, "plannedDate")
    ? { plannedDate: value(form, "plannedDate") }
    : {}),
});

export function ArtifactDeliveryPanel({
  task,
  artifact,
  snapshot,
  dispatch,
  onTask,
}: SharedProps & { task: Task; artifact: Artifact }) {
  const matching =
    snapshot.delivery?.records.filter(
      (record) =>
        record.taskId === task.id && record.artifactId === artifact.id,
    ) ?? [];
  const current = matching.find(
    (record) => record.artifactHash === artifact.hash,
  );
  const [selectedId, setSelectedId] = useState<string>();
  const record =
    matching.find((item) => item.id === selectedId) ?? current ?? matching[0];
  const [registering, setRegistering] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const requests = useRef(new Map<string, string>());
  const register = async (form: HTMLFormElement) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    const spec = readSpec(form);
    const signature = JSON.stringify([artifact.hash, spec]);
    const requestId = requests.current.get(signature) ?? crypto.randomUUID();
    requests.current.set(signature, requestId);
    try {
      const result = await dispatch({
        type: "delivery.register",
        requestId,
        taskId: task.id,
        artifactId: artifact.id,
        expectedHash: artifact.hash,
        spec,
      });
      if (result) {
        setSelectedId(
          result.delivery?.records.find(
            (item) =>
              item.taskId === task.id &&
              item.artifactId === artifact.id &&
              item.artifactHash === artifact.hash,
          )?.id,
        );
        drafts.delete(
          `delivery-register:${task.id}:${artifact.id}:${artifact.hash}`,
        );
        setRegistering(false);
      }
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "登记未完成，请重试。",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <div
      className="delivery-entry"
      onKeyDown={(event) => {
        if (event.key === "Escape" && expanded) {
          event.stopPropagation();
          setExpanded(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        className="text-button"
        ref={trigger}
        aria-expanded={expanded}
        aria-controls={`delivery-${artifact.id}`}
        onClick={() => setExpanded(!expanded)}
      >
        交接与反馈{current ? ` · ${DELIVERY_STATUS[current.status]}` : ""}
      </button>
      <section
        className="delivery-panel"
        id={`delivery-${artifact.id}`}
        aria-label="交接与反馈"
        hidden={!expanded}
      >
        <header className="delivery-panel-heading">
          <strong>
            {artifact.title} · v{artifact.version}
          </strong>
          <button
            className="text-button"
            onClick={() => {
              setExpanded(false);
              trigger.current?.focus();
            }}
          >
            关闭
          </button>
        </header>
        {!current && ["md", "html"].includes(artifact.format) ? (
          <button
            className="button secondary small"
            onClick={() => setRegistering(!registering)}
          >
            {registering ? "收起登记" : `登记当前 v${artifact.version} 交付`}
          </button>
        ) : null}
        {registering ? (
          <Form
            draftKey={`delivery-register:${task.id}:${artifact.id}:${artifact.hash}`}
            onSubmit={(form) => void register(form)}
          >
            <SpecFields
              spec={{
                recipient: "Y / 接收工具",
                goal: task.goal,
                criteria: "接收方能理解目标、依据和条件，并给出实际使用结果。",
                missing: "",
              }}
            />
            <button className="button primary small" disabled={busy}>
              保存交付登记
            </button>
          </Form>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        {matching.length > 1 ? (
          <label className="delivery-field">
            查看交付版本
            <select
              value={record?.id}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              {matching.map((item) => (
                <option key={item.id} value={item.id}>
                  v{item.artifactVersion} · {item.recipient} ·{" "}
                  {DELIVERY_STATUS[item.status]}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {record ? (
          <DeliveryActions
            key={record.id}
            record={record}
            task={task}
            snapshot={snapshot}
            dispatch={dispatch}
            onTask={onTask}
          />
        ) : !registering ? (
          <p className="delivery-muted">
            登记接收对象与完成条件，保留准确版本，再检查交接、登记使用和反馈。
          </p>
        ) : null}
      </section>
    </div>
  );
}

function DeliveryActions({
  record,
  task,
  dispatch,
  onTask,
}: SharedProps & { record: DeliveryRecord; task?: Task }) {
  const [expectedRevision, setExpectedRevision] = useState(record.revision);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const requests = useRef(new Map<string, string>());
  const stale = expectedRevision !== record.revision;
  const act = async (action: RecordAction, navigate = false) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    const signature = JSON.stringify([record.id, expectedRevision, action]);
    const requestId = requests.current.get(signature) ?? crypto.randomUUID();
    requests.current.set(signature, requestId);
    try {
      const result = await dispatch({
        ...action,
        requestId,
        deliveryId: record.id,
        expectedRevision,
      } as DeliveryCommand);
      if (result) {
        const updated = result.delivery?.records.find(
          (item) => item.id === record.id,
        );
        if (updated) {
          setExpectedRevision(updated.revision);
          if (navigate) {
            const work = updated.works.find((item) => item.id === requestId);
            if (work) onTask?.(work.taskId);
          }
        }
        setMessage(
          action.type === "delivery.check" ||
            action.type === "delivery.reviewFeedback"
            ? "已建立独立工作，可打开查看实际运行和结果。"
            : "已保存到这一交付版本。",
        );
      }
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "操作未完成，请重试。",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="delivery-actions">
      <div className="delivery-record-summary">
        <strong>{record.recipient}</strong>
        <span>
          v{record.artifactVersion} · {DELIVERY_STATUS[record.status]}
        </span>
        <p>{record.goal}</p>
        <p>完成标准：{record.criteria}</p>
        {record.missing ? <p>尚缺：{record.missing}</p> : null}
        {record.plannedDate ? <p>计划交付：{record.plannedDate}</p> : null}
      </div>
      {record.sourceChanged ? (
        <p className="delivery-notice">
          原成果已有新版本。这里的检查、交接和反馈仍对应 v
          {record.artifactVersion}；新版本需单独登记。
        </p>
      ) : null}
      {record.sourceMissing ? (
        <p className="delivery-notice">
          原成果已不在当前工作中，已登记的版本与反馈仍可查看。
        </p>
      ) : null}
      {stale ? (
        <div className="delivery-notice">
          记录已更新，未提交的输入保留。核对上方最新内容后再继续。
          <button
            type="button"
            className="text-button"
            onClick={() => setExpectedRevision(record.revision)}
          >
            已核对，使用最新记录
          </button>
        </div>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {message ? <p role="status">{message}</p> : null}
      <fieldset disabled={busy || stale}>
        <details>
          <summary>目标与交付日期</summary>
          <Form
            draftKey={`delivery-meta:${record.id}`}
            onSubmit={(form) =>
              void act({ type: "delivery.update", spec: readSpec(form) })
            }
          >
            <SpecFields spec={record} />
            <button className="button secondary small">保存目标与日期</button>
          </Form>
        </details>
        <details>
          <summary>检查是否准备好</summary>
          <p>
            独立研究员只读已登记的准确正文和下方选定资料，用交付检查方法找出歧义与缺口。原聊天不会带入，检查不表示实际执行通过。
          </p>
          <Form
            draftKey={`delivery-check:${record.id}`}
            onSubmit={(form) =>
              void act(
                {
                  type: "delivery.check",
                  sourceIds: selected(form, "sourceIds"),
                },
                true,
              )
            }
          >
            {task?.sources
              .filter((source) => !source.library?.supersededAt)
              .map((source) => (
                <label className="delivery-checkbox" key={source.id}>
                  <input type="checkbox" name="sourceIds" value={source.id} />
                  {source.title}
                  <small>{source.coverage}</small>
                </label>
              ))}
            <button className="button secondary small">开始独立就绪检查</button>
          </Form>
        </details>
        <details>
          <summary>登记确认、接收或实际使用</summary>
          <Form
            draftKey={`delivery-status:${record.id}`}
            onSubmit={(form) => {
              const evidence: Record<string, string> = {};
              for (const key of [
                "receipt",
                "usage",
                "conditions",
                "observations",
              ])
                if (value(form, key)) evidence[key] = value(form, key);
              void act({
                type: "delivery.status",
                status: value(form, "status") as DeliveryStatus,
                evidence,
                ...(value(form, "note") ? { note: value(form, "note") } : {}),
              });
            }}
          >
            <label className="delivery-field">
              登记状态
              <select name="status" defaultValue={record.status}>
                {Object.entries(DELIVERY_STATUS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <Field
              name="receipt"
              label="接收证据"
              multiline
              help="已交接必填：实际回执、接收记录或可查证的执行反馈。"
            />
            <Field name="usage" label="实际用途" multiline />
            <Field name="conditions" label="使用或验证条件" multiline />
            <Field
              name="observations"
              label="实际观察与证据"
              multiline
              help="已使用、已验证都需要用途、条件与观察证据；模型自评不足以证明。"
            />
            <Field name="note" label="补充说明" multiline />
            <button className="button secondary small">保存状态与证据</button>
          </Form>
        </details>
        <details>
          <summary>反馈原文与报告</summary>
          <Form
            draftKey={`delivery-feedback:${record.id}`}
            onSubmit={(form) => {
              const observed = value(form, "observedAt");
              void act({
                type: "delivery.addFeedback",
                kind: value(form, "kind") as "text" | "url" | "report",
                quote: value(form, "quote"),
                coverage: value(form, "coverage"),
                observedAt: observed
                  ? new Date(observed).toISOString()
                  : new Date().toISOString(),
                ...(value(form, "location")
                  ? { location: value(form, "location") }
                  : {}),
                ...(value(form, "reportSourceId")
                  ? { reportSourceId: value(form, "reportSourceId") }
                  : {}),
              });
            }}
          >
            <label className="delivery-field">
              反馈来源
              <select name="kind" defaultValue="text">
                <option value="text">手动登记</option>
                <option value="url">公开网址与原话</option>
                <option value="report">已导入报告</option>
              </select>
            </label>
            <Field
              name="quote"
              label="反馈原话 / 报告说明"
              required
              multiline
            />
            <Field
              name="location"
              label="公开原文网址"
              type="url"
              help="选择公开网址时必填；保留你提供的原话，不自动把网页当作已读。"
            />
            <label className="delivery-field">
              选用报告
              <select name="reportSourceId" defaultValue="">
                <option value="">请选择本工作已导入的报告</option>
                {task?.sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.title}
                  </option>
                ))}
              </select>
            </label>
            <Field
              name="coverage"
              label="观察范围与样本"
              required
              initial="用户手动提供的这条反馈，未代表全部用户或观众。"
              multiline
            />
            <Field
              name="observedAt"
              label="实际观察时间（本地时间）"
              type="datetime-local"
            />
            <button className="button secondary small">保存反馈原文</button>
          </Form>
        </details>
        {record.feedback.length ? (
          <details open>
            <summary>整理与处理反馈 · {record.feedback.length}</summary>
            <Form
              draftKey={`delivery-feedback-review:${record.id}`}
              onSubmit={(form) =>
                void act(
                  {
                    type: "delivery.reviewFeedback",
                    feedbackIds: selected(form, "feedbackIds"),
                  },
                  true,
                )
              }
            >
              {record.feedback.map((feedback) => (
                <label className="delivery-checkbox" key={feedback.id}>
                  <input
                    type="checkbox"
                    name="feedbackIds"
                    value={feedback.id}
                  />
                  <span>
                    {feedback.quote.slice(0, 150)} ·{" "}
                    {FEEDBACK_DECISION[feedback.decision]}
                  </span>
                </label>
              ))}
              <button className="button secondary small">
                将所选反馈整理为问题与机会
              </button>
            </Form>
            {record.feedback.map((feedback) => (
              <article className="delivery-feedback" key={feedback.id}>
                <p>
                  {feedback.observedAt} · {FEEDBACK_DECISION[feedback.decision]}
                </p>
                <blockquote>{feedback.quote}</blockquote>
                <small>
                  {feedback.location ?? "用户登记"} · {feedback.coverage}
                </small>
                {feedback.decisionNote ? (
                  <p>判断：{feedback.decisionNote}</p>
                ) : null}
                <Form
                  draftKey={`delivery-decision:${feedback.id}`}
                  onSubmit={(form) =>
                    void act({
                      type: "delivery.decideFeedback",
                      feedbackId: feedback.id,
                      decision: value(form, "decision") as
                        "accepted" | "rejected" | "deferred",
                      note: value(form, "note"),
                    })
                  }
                >
                  <label className="delivery-field">
                    本次判断
                    <select name="decision" defaultValue="deferred">
                      <option value="accepted">采纳为本交付的反馈</option>
                      <option value="rejected">拒绝</option>
                      <option value="deferred">暂缓</option>
                    </select>
                  </label>
                  <Field
                    name="note"
                    label="处理依据与适用范围"
                    required
                    multiline
                  />
                  <button className="button secondary small">
                    保存反馈判断
                  </button>
                </Form>
                {record.projectId && feedback.decision === "accepted" ? (
                  <button
                    className="text-button"
                    type="button"
                    disabled={record.writebacks.some(
                      (item) => item.feedbackId === feedback.id,
                    )}
                    onClick={() =>
                      void act({
                        type: "delivery.writeFeedback",
                        feedbackId: feedback.id,
                      })
                    }
                  >
                    写入项目指定反馈文件
                  </button>
                ) : null}
              </article>
            ))}
          </details>
        ) : null}
        <button
          type="button"
          className="button secondary small"
          onClick={() => void act({ type: "delivery.export" })}
        >
          导出准确版本 Markdown 交接包
        </button>
      </fieldset>
      {record.works.length ? (
        <div className="delivery-work-list">
          <h4>检查与反馈整理</h4>
          {record.works.map((work) => (
            <div key={work.id}>
              <button
                type="button"
                className="text-button"
                onClick={() => onTask?.(work.taskId)}
                disabled={!onTask}
              >
                {work.kind === "readiness" ? "独立就绪检查" : "反馈整理"} ·
                登记修订 {work.deliveryRevision ?? "未记录"} ·{" "}
                {(
                  {
                    idle: "待开始",
                    running: "进行中",
                    waiting: "等待中",
                    paused: "已暂停",
                    failed: "未完成",
                    completed: "工作已结束，需查看结论",
                    missing: "工作记录已移除",
                  } as Record<string, string>
                )[work.status ?? "idle"] ?? work.status}
              </button>
              {work.error ? <p role="alert">{work.error}</p> : null}
            </div>
          ))}
        </div>
      ) : null}
      {record.exports.length ? (
        <details>
          <summary>已导出的交接包</summary>
          {record.exports.map((item) => (
            <p key={item.artifactId}>
              {item.createdAt}
              <br />
              <code>{item.path}</code>
              <button
                className="text-button"
                onClick={() => onTask?.(record.taskId)}
                disabled={!onTask}
              >
                到原工作查看成果
              </button>
            </p>
          ))}
        </details>
      ) : null}
      {record.writebacks.map((item) => (
        <p className="delivery-muted" key={item.feedbackId}>
          反馈已追加：{item.path}；尚未表示开发工具采纳执行。
        </p>
      ))}
      <details>
        <summary>准确版本与使用记录</summary>
        <p>
          成果 v{record.artifactVersion} · 原目标 v{record.goalVersion}
        </p>
        <code>{record.artifactHash}</code>
        <pre className="delivery-frozen-body">{record.content}</pre>
        {record.history.map((entry, index) => (
          <div className="delivery-history" key={index}>
            <strong>{DELIVERY_STATUS[entry.status]}</strong> ·{" "}
            {entry.recordedAt}
            {Object.entries(entry.evidence).map(([key, text]) => (
              <p key={key}>
                {
                  (
                    {
                      receipt: "接收",
                      usage: "用途",
                      conditions: "条件",
                      observations: "观察证据",
                    } as Record<string, string>
                  )[key]
                }
                ：{text}
              </p>
            ))}
            {entry.note ? <p>{entry.note}</p> : null}
          </div>
        ))}
      </details>
    </div>
  );
}

export function DeliveryOverview({ snapshot, dispatch, onTask }: SharedProps) {
  const [query, setQuery] = useState("");
  const [onlyPending, setOnlyPending] = useState(false);
  const records = snapshot.delivery?.records ?? [];
  const visible = records.filter(
    (record) =>
      (!onlyPending || !["used", "verified"].includes(record.status)) &&
      `${record.artifactTitle} ${record.recipient} ${record.goal} ${record.projectId ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <section className="delivery-overview" aria-label="交付清单">
      <header>
        <h2>交付与反馈</h2>
        <p>查看要交给谁、何时准备好，以及实际使用带回了什么。</p>
      </header>
      <div className="delivery-toolbar">
        <label>
          查找交付
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="作品、接收方或目标"
          />
        </label>
        <label className="delivery-checkbox">
          <input
            type="checkbox"
            checked={onlyPending}
            onChange={(event) => setOnlyPending(event.target.checked)}
          />
          只看尚待使用的交付
        </label>
      </div>
      {visible.length ? (
        visible.map((record) => (
          <details className="delivery-panel" key={record.id}>
            <summary>
              {record.plannedDate ?? "未设日期"} · {record.artifactTitle} v
              {record.artifactVersion} · {DELIVERY_STATUS[record.status]}
            </summary>
            <button
              className="text-button"
              onClick={() => onTask?.(record.taskId)}
              disabled={!onTask}
            >
              打开原工作
            </button>
            <DeliveryActions
              record={record}
              task={snapshot.tasks.find((task) => task.id === record.taskId)}
              snapshot={snapshot}
              dispatch={dispatch}
              onTask={onTask}
            />
          </details>
        ))
      ) : (
        <p className="delivery-muted">
          {records.length
            ? "没有匹配的交付。"
            : "在一份成果旁登记交付，便可在这里安排日期、检查材料并留下真实反馈。"}
        </p>
      )}
    </section>
  );
}
