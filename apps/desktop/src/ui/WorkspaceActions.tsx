import { Check, RotateCcw, X } from "lucide-react";
import { useState } from "react";
import type { Snapshot } from "../core/types";
import type { WorkspaceActionProposal } from "../core/workspace-action-contract";
import { command } from "./api";
import { localMatchPreview } from "../core/radar-news";
import "./workspace-actions.css";

function details(proposal: WorkspaceActionProposal, data: Snapshot) {
  const action = proposal.action;
  if (action.kind === "schedule") {
    const input = action.input;
    const when = new Date(input.firstAt).toLocaleString("zh-CN", {
      timeZone: input.timezone,
    });
    return `${input.name} · ${when} · ${input.timezone} · ${input.intervalHours ? `每 ${input.intervalHours} 小时重复` : "单次"} · 每次最多 ${input.maxModelCalls} 次模型请求 · ${input.enabled ? "保存后启用" : "保存为暂停"} · 仅桌面应用运行且电脑唤醒时触发`;
  }
  if (action.kind === "schedule-enabled")
    return action.enabled
      ? "确认后开始后续触发；仅桌面应用运行且电脑唤醒时执行"
      : "确认后暂停后续触发；正在执行的一轮不会被伪装为已停止";
  if (action.kind === "radar-topic") {
    const input = action.topic;
    const names = (input.sourceIds ?? []).map(
      (id) =>
        data.sources.find((source) => source.id === id)?.name ??
        data.feeds.find((source) => source.id === id)?.name ??
        "已选来源",
    );
    return [
      input.focus ? `关注：${input.focus}` : null,
      names.length ? `来源：${names.join("、")}` : null,
      input.keywords?.length ? `关键词：${input.keywords.join("、")}` : null,
      input.matchRules ? `同时包含：${input.matchRules.groups.map((group) => group.terms.join(" / ")).join(" + ")}` : null,
      input.matchRules?.exclude?.length ? `排除：${input.matchRules.exclude.join("、")}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  const input = action.input;
  const topic = data.radar.topics.find((item) => item.id === input.topicId);
  return `${topic?.title ?? "当前议题"} · 议题 v${input.topicRevision} · ${input.enabled ? `每 ${input.intervalMinutes} 分钟检查 · 每天最多 ${input.maxCallsPerDay} 次模型调用 · 确认后开始生效` : "暂停自动整理"} · 仅桌面应用运行且电脑唤醒时执行`;
}

export function WorkspaceActions({
  data,
  workId,
  onRadar,
  onSchedule,
  onError,
  compactRadar = false,
}: {
  data: Snapshot;
  workId: string;
  onRadar: (id: string) => void;
  onSchedule: (id: string) => void;
  onError: (error: unknown) => void;
  compactRadar?: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const proposals = data.workspaceActions.filter(
    (proposal) => proposal.workId === workId && proposal.status !== "dismissed",
  );
  const firstPending = proposals.find(
    (proposal) => proposal.status === "pending",
  )?.id;
  if (!proposals.length) return null;
  async function act(
    type:
      | "workspace-action-apply"
      | "workspace-action-dismiss"
      | "workspace-action-undo",
    id: string,
  ) {
    if (busy) return;
    setBusy(id);
    try {
      await command({ type, id });
    } catch (error) {
      onError(error);
    } finally {
      setBusy(null);
    }
  }
  async function enableDirect() {
    if (busy) return;
    setBusy("policy");
    try {
      await command({ type: "workspace-policy", direct: true });
    } catch (error) {
      onError(error);
    } finally {
      setBusy(null);
    }
  }
  function openResult(proposal: WorkspaceActionProposal) {
    if (proposal.action.kind === "radar-watch")
      onRadar(proposal.action.input.topicId);
    else if (proposal.result?.kind === "schedule")
      onSchedule(proposal.result.id);
    else if (proposal.result) onRadar(proposal.result.id);
  }
  return (
    <section className="workspace-actions" aria-label="工作空间变更">
      {proposals.map((proposal) => {
        const preview = proposal.action.kind === "radar-topic"
          ? localMatchPreview(data, proposal.action.topic)
          : null;
        const expired =
          proposal.status === "pending" &&
          new Date(proposal.expiresAt).getTime() <= Date.now();
        return (
          <article
            key={proposal.id}
            className={`workspace-action ${proposal.status}`}
          >
            <div>
              <strong>
                {proposal.status === "pending"
                  ? "等待你确认"
                  : proposal.status === "undone"
                    ? "已撤销"
                    : "已应用"}
              </strong>
              <p>{proposal.summary}</p>
              <small>{details(proposal, data)}</small>
              {preview ? (
                <div className="radar-scope-preview">
                  <p>{preview.error ?? `当前新闻中有 ${preview.count} 篇符合范围`}</p>
                  {preview.samples.slice(0, 3).map((sample, index) => <p key={index}>{sample.title}</p>)}
                </div>
              ) : null}
              {proposal.status === "pending" ? (
                <small>
                  {expired
                    ? "确认已过期，请告诉团队重新核对并提出新变更。"
                    : "确认后才会写入；失败时本卡会保留。"}
                </small>
              ) : null}
              {!compactRadar && proposal.id === firstPending && !data.workspacePolicy.direct ? (
                <label className="workspace-policy-inline">
                  <input
                    type="checkbox"
                    disabled={!!busy}
                    onChange={(event) => {
                      if (event.target.checked) void enableDirect();
                    }}
                  />
                  今后小范围、可撤销的操作直接办理
                </label>
              ) : null}
            </div>
            <div className="workspace-action-controls">
              {proposal.status === "pending" ? (
                <>
                  <button
                    className="primary"
                    disabled={expired || !!busy}
                    onClick={() =>
                      void act("workspace-action-apply", proposal.id)
                    }
                  >
                    <Check size={15} />
                    确认
                  </button>
                  <button
                    disabled={!!busy}
                    onClick={() =>
                      void act("workspace-action-dismiss", proposal.id)
                    }
                  >
                    <X size={15} />
                    暂不更改
                  </button>
                </>
              ) : proposal.status === "applied" ? (
                <>
                  {proposal.result ? (
                    <button
                      className="text-action"
                      disabled={!!busy}
                      onClick={() => openResult(proposal)}
                    >
                      查看实际结果
                    </button>
                  ) : null}
                  <button
                    disabled={!!busy || proposal.undo?.available === false}
                    title={proposal.undo?.reason}
                    onClick={() =>
                      void act("workspace-action-undo", proposal.id)
                    }
                  >
                    <RotateCcw size={15} />
                    撤销
                  </button>
                </>
              ) : null}
            </div>
          </article>
        );
      })}
    </section>
  );
}
