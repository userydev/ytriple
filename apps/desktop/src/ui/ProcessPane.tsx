import { skillKey } from "../core/skill-contract";
import { toolCatalog } from "../core/tool-contract";
import { ToolEvidence } from "./ToolEvidence";
import { useEffect, useState, type ReactNode } from "react";
import Markdown from "./Markdown";
import { MessageCircle, ListChecks, NotebookPen, BookOpen, X } from "lucide-react";
import { command } from "./api";
import type { Snapshot, Contribution } from "../core/types";
import type { ProcessRequest } from "../core/process";
import { IconButton } from "./Composer";
import { ProjectRequirements } from "./ProjectRequirements";
import { References } from "./References";
import { outputLabels } from "../core/output";
import { formatContextScope } from "../core/context-scope";
import { displayContributionBody } from "../core/team-response";
import { formatPublicProcessBlock } from "../core/process-feedback";
import { formatManifestForDiagnostics } from "../core/input-manifest";
import { FeedbackEvidence } from "./FeedbackEvidence";
import { TeamTrace } from "./TeamTrace";
const statusLabel = {
  running: "处理中",
  waiting: "等待答复",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已停止",
  unknown: "状态待核",
  queued: "待发",
};
export function ProcessPane({
  data,
  workId,
  onPrepare,
  onError,
  focusIds,
}: {
  data: Snapshot;
  workId: string;
  onPrepare: (request: ProcessRequest) => Promise<void>;
  onError: (error: unknown) => void;
  focusIds?: string[];
}) {
  const [expandedRecords, setExpandedRecords] = useState<string[]>(
    focusIds ?? [],
  );
  const [scope, setScope] = useState("all"),
    [selected, setSelected] = useState<string[]>([]),
    [passage, setPassage] = useState<{ id: string; text: string } | null>(null),
    [busy, setBusy] = useState(false);
  const runs = data.runs.filter((r) => r.workId === workId),
    all = data.contributions.filter((c) => c.workId === workId);
  const shown = all.filter((c) => scope === "all" || c.runId === scope);
  useEffect(() => {
    if (focusIds?.length) {
      setScope("all");
      setSelected(focusIds);
      setExpandedRecords((ids) => [...new Set([...ids, ...focusIds])]);
      document
        .getElementById(`record-${focusIds[0]}`)
        ?.scrollIntoView({ block: "center" });
    }
  }, [focusIds]);
  function capture() {
    const s = window.getSelection();
    const el =
      s?.anchorNode instanceof Element
        ? s.anchorNode
        : s?.anchorNode?.parentElement;
    const record = el?.closest<HTMLElement>("[data-contribution-id]");
    if (
      record &&
      s?.focusNode &&
      record.contains(s.focusNode) &&
      s.toString().trim()
    )
      setPassage({ id: record.dataset.contributionId!, text: s.toString() });
  }
  async function prepare(mode: ProcessRequest["mode"], id?: string) {
    if (busy) return;
    setBusy(true);
    try {
      const excerpt = id && passage?.id === id ? passage.text : undefined;
      if (excerpt && !all.find((c) => c.id === id)?.body.includes(excerpt))
        throw Error("选段跨越正文格式，请选择连续文字或清除选段后引用整条记录");
      await onPrepare({
        workId,
        mode,
        ...(id
          ? { contributionIds: [id], excerpt }
          : selected.length
            ? { contributionIds: selected }
            : scope !== "all"
              ? { runId: scope }
              : {}),
      });
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  const renderRecord = (c: Contribution): ReactNode => (
    <article
      key={c.id}
      id={`record-${c.id}`}
      className={
        selected.includes(c.id) ? "process-record selected" : "process-record"
      }
    >
      <div className="section-heading">
        <label className="process-member">
          <input
            type="checkbox"
            aria-label={`选择 ${c.memberName} 的记录 ${c.id}`}
            checked={selected.includes(c.id)}
            onChange={(e) =>
              setSelected((ids) =>
                e.target.checked
                  ? [...ids, c.id]
                  : ids.filter((id) => id !== c.id),
              )
            }
          />
          <span>{c.memberName}</span>
        </label>
        <div className="toolbar">
          <small>{statusLabel[c.status]}</small>
          <IconButton
            label={
              passage?.id === c.id
                ? `追问 ${c.memberName} 的选段`
                : `追问 ${c.memberName} 此处`
            }
            disabled={busy}
            onClick={() => void prepare("explanation", c.id)}
          >
            <MessageCircle size={16} />
          </IconButton>
        </div>
      </div>
      <p className="muted">{c.objective}</p>
      {c.task?.returnedFrom ? (
        <p className="muted">
          收到{" "}
          {all.find((x) => x.id === c.task?.returnedFrom)?.memberName ??
            "子任务"}{" "}
          的回信，继续处理
        </p>
      ) : null}
      {c.task?.parentId ? (
        <small>
          受{" "}
          {all.find((x) => x.id === c.task?.parentId)?.memberName ?? "负责成员"}{" "}
          委派 · 层级 {c.task.depth}
        </small>
      ) : null}
      {c.task?.parentId && c.task.refs.length ? (
        <References
          data={data}
          refs={c.task.refs}
          disabled
          onChange={() => {}}
        />
      ) : null}
      <details
        className="record-analysis"
        open={expandedRecords.includes(c.id)}
      >
        <summary
          onClick={(event) => {
            event.preventDefault();
            setExpandedRecords((ids) =>
              ids.includes(c.id)
                ? ids.filter((id) => id !== c.id)
                : [...ids, c.id],
            );
          }}
        >
          {expandedRecords.includes(c.id) ? "收起分析" : "查看公开分析"}
        </summary>
        <div data-contribution-id={c.id}>
          {c.tool ? (
            <>
              <p>
                {toolCatalog.find((t) => t.key === c.tool!.request.key)?.name ??
                  c.tool.request.key}{" "}
                · {c.tool.status === "succeeded" ? "执行完成" : "执行失败"}
              </p>
              <p>{c.tool.request.purpose}</p>
              <ToolEvidence receipt={c.tool} contribution={c} data={data} />
            </>
          ) : null}
          {!c.tool || c.tool.status === "failed" ? (
            <>
              <Markdown>
                {c.status === "running" && /^\s*\{/.test(c.body)
                  ? "正在组织协作请求…"
                  : (() => {
                      const run = data.runs.find((r) => r.id === c.runId);
                      return run
                        ? displayContributionBody(c.body, run)
                        : c.body;
                    })() || "尚无公开分析记录"}
              </Markdown>
              {c.publicProcess || c.publicProcessWarnings?.length ? (
                <div className="public-process-meta">
                  <Markdown>{formatPublicProcessBlock(c, id => data.inputManifests?.find(m => m.id === c.inputManifestId)?.entries.find(e => e.id === id)?.label.slice(0, 100) ?? "来源详见输入清单")}</Markdown>
                </div>
              ) : null}
              {c.tool?.status === "failed" && c.status === "succeeded" ? (
                <p className="error-inline" role="status">
                  宿主记录：工具执行失败；上方 AI 公开说明不能视为实际成功。
                </p>
              ) : null}
              {c.inputManifestId ? (
                <details className="input-manifest">
                  <summary>本轮实际输入清单（宿主）</summary>
                  <pre>
                    {(() => {
                      const m = data.inputManifests?.find(
                        (row) => row.id === c.inputManifestId,
                      );
                      return m
                        ? formatManifestForDiagnostics(m)
                        : "清单不可用或尚未持久化";
                    })()}
                  </pre>
                </details>
              ) : null}
            </>
          ) : null}
        </div>
        {c.skills?.length ? (
          <details className="method-provenance">
            <summary>本次请求载入方法 · {c.skills.length}</summary>
            {c.skills.map((use) => {
              const method = data.runs
                .find((r) => r.id === c.runId)
                ?.skills?.find((s) => skillKey(s) === use.key);
              return (
                <details key={use.key}>
                  <summary>
                    {method?.name ?? use.key} · v{method?.version ?? "?"} ·{" "}
                    {use.source === "requested" ? "用户指定" : "成员选择"}
                  </summary>
                  <p>{use.purpose}</p>
                  <Markdown>{method?.body ?? "方法快照不可用"}</Markdown>
                </details>
              );
            })}
            <small>仅方法正文载入记录，不代表脚本执行或效果验证。</small>
          </details>
        ) : null}
      </details>
      {c.error ? <p className="error-inline">{c.error}</p> : null}
      {all.some((child) => child.task?.parentId === c.id) ? (
        <details
          className="delegated-records"
          open={focusIds?.some((id) => id.startsWith(c.id + ":d")) || undefined}
        >
          <summary>
            委派任务与返回 ·{" "}
            {c.delegation?.responseId ? "已有回信" : "处理中或受阻"}
          </summary>
          {all
            .filter((child) => child.task?.parentId === c.id)
            .map(renderRecord)}
        </details>
      ) : null}
      <details className="record-identity">
        <summary>记录与时间</summary>
        <small>
          {c.id} · {new Date(c.createdAt).toLocaleString()}
        </small>
        {/^\s*\{/.test(c.body) ? <details><summary>原始协议诊断</summary><pre>{c.body}</pre></details> : null}
      </details>
    </article>
  );
  return (
    <section className="process-pane" onMouseUp={capture} onKeyUp={capture}>
      <div className="section-heading">
        <h2>协作过程</h2>
      </div>
      <p className="muted process-actions-copy">
        以下操作只准备草稿与冻结快照，不会立即调用模型。范围：当前筛选的
        {selected.length ? ` ${selected.length} 条所选记录` : scope === "all" ? "整个工作" : "单轮记录"}
        。执行记录与 AI 公开说明分别呈现。
      </p>
      <div className="process-action-buttons">
        <button
          type="button"
          className="secondary"
          disabled={busy || !shown.length}
          onClick={() => void prepare("summary")}
        >
          整理成文档
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy || !shown.length}
          onClick={() => void prepare("review")}
        >
          手动复盘
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy || !shown.length}
          onClick={() => void prepare("method")}
        >
          整理为方法草案
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy || !shown.length}
          onClick={() =>
            void (async () => {
              if (busy) return;
              setBusy(true);
              try {
                await command({
                  type: "export-process",
                  workId,
                  ...(selected.length
                    ? { contributionIds: selected, mode: "summary" as const }
                    : scope !== "all"
                      ? { runId: scope, mode: "summary" as const }
                      : { mode: "summary" as const }),
                });
              } catch (e) {
                onError(e);
              } finally {
                setBusy(false);
              }
            })()
          }
        >
          导出原始记录 · Markdown
        </button>
      </div>
      <div className="toolbar process-icon-actions">
        <button type="button" disabled={busy || !shown.length} onClick={() => void prepare("explanation")}>追问所选过程</button>
      </div>
      {runs.length ? (
        <div className="process-scope">
          <select
            aria-label="过程范围"
            value={scope}
            onChange={(e) => {
              setScope(e.target.value);
              setSelected([]);
              setPassage(null);
            }}
          >
            <option value="all">整个工作</option>
            {runs.map((r, i) => (
              <option key={r.id} value={r.id}>
                第 {i + 1} 轮 · {outputLabels[r.outputMode ?? "result"]} ·{" "}
                {r.text.slice(0, 24)}
              </option>
            ))}
          </select>
          <small>
            {selected.length
              ? `已选 ${selected.length} 条记录`
              : scope === "all"
                ? `${runs.length} 轮 · ${shown.length} 条记录`
                : `${shown.length} 条记录`}
          </small>
          {selected.length || passage ? (
            <IconButton
              label="清除过程选择"
              onClick={() => {
                setSelected([]);
                setPassage(null);
                window.getSelection()?.removeAllRanges();
              }}
            >
              <X size={15} />
            </IconButton>
          ) : null}
        </div>
      ) : null}
      <FeedbackEvidence data={data} workId={workId} records={selected.length ? shown.filter(c => selected.includes(c.id)) : shown} />
      {runs
        .filter((r) => scope === "all" || r.id === scope)
        .map((r) => (
          <section className="process-run" key={r.id}>
            <div className="section-heading">
              <div>
                <small>
                  第 {runs.indexOf(r) + 1} 轮 ·{" "}
                  {outputLabels[r.outputMode ?? "result"]} ·{" "}
                  {statusLabel[r.status]}
                </small>
                <h3>{r.text.length > 180 ? `${r.text.slice(0, 180)}…` : r.text}</h3>
              </div>
            </div>
            <TeamTrace
              run={r}
              records={shown}
              onRecord={(id) => {
                setExpandedRecords((ids) => [...new Set([...ids, id])]);
                requestAnimationFrame(() => {
                  document
                    .getElementById(`record-${id}`)
                    ?.scrollIntoView({ block: "start", behavior: "smooth" });
                });
              }}
            />
            <details>
              <summary>
                {r.team.name} · 搭配 v{r.team.version} · 流程 v
                {r.workflow.version}
              </summary>
              <p>
                {r.workflow.name} · {new Date(r.createdAt).toLocaleString()}
              </p>
              {r.modelIdentity ? (
                <p className="muted">
                  实际模型 · {r.modelIdentity.label} · {r.modelIdentity.endpoint}
                </p>
              ) : (
                <p className="muted">实际模型 · 本轮未记录连接标识</p>
              )}
              {r.contextScope ? (
                <p className="muted">
                  上下文范围 · {formatContextScope(r.contextScope)}
                </p>
              ) : (
                <p className="muted">上下文范围 · 本轮开始前未记录快照</p>
              )}
              {r.execution ? (
                <p className="muted">
                  执行清单 ·{" "}
                  {r.execution.strategyId === "adaptive-delegation"
                    ? "负责人按需委派"
                    : "固定步骤"}{" "}
                  · 内核 {r.execution.kernelId} v{r.execution.kernelVersion}
                </p>
              ) : (
                <p className="muted">执行清单 · 历史记录未记录内核版本</p>
              )}
              {r.projectContext ? (
                <ProjectRequirements
                  context={r.projectContext}
                  versions={data.versions}
                />
              ) : null}
              {r.refs.length ? (
                <References
                  data={data}
                  refs={r.refs}
                  disabled
                  onChange={() => {}}
                />
              ) : null}
            </details>
            {shown
              .filter((c) => c.runId === r.id)
              .filter((c) => !c.task?.parentId)
              .map(renderRecord)}
          </section>
        ))}
      {!all.length ? (
        <div className="empty">
          <h3>过程将随工作展开</h3>
          <p>这里记录实际分工、依据、核查意见与修订，不按固定人数填充卡片。</p>
        </div>
      ) : null}
    </section>
  );
}
