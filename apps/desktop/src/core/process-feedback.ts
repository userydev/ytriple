import type { Store } from "./store";
import type { OutcomeRecord } from "./outcome-contract";
import type { ArtifactVersion, Run } from "./types";
import { formatOutcomes } from "./outcome-contract";
import type { InputManifest } from "./input-manifest";

export function formatParallelFeedbackEvidence(
  store: Store,
  workId: string,
  versions: ArtifactVersion[],
  outcomes: OutcomeRecord[],
  contributionIds: string[],
) {
  if (!versions.length) return "";
  const blocks = versions.map((version) => {
    const scoped = outcomes.filter((o) => o.versionId === version.id);
    const manifests = store
      .all<InputManifest>("input-manifest")
      .filter((m) => m.workId === workId && contributionIds.includes(m.contributionId));
    const runIds = new Set(
      store.all<Run>("run").filter((r) => r.workId === workId).map((r) => r.id),
    );
    const related = manifests.filter((m) => runIds.has(m.runId));
    const delivered = related.flatMap((m) =>
      m.entries
        .filter((e) => e.kind === "outcome" && scoped.some((o) => o.id === e.entityId))
        .map((e) => `${e.id} · ${e.coverage}`),
    );
    return [
      `### 成果 ${version.id} 的反馈并列证据`,
      formatOutcomes(scoped) || "尚无用户反馈记录。",
      delivered.length
        ? `相关运行实际纳入的反馈条目：${delivered.join("；")}`
        : "相关运行未记录反馈纳入清单（可能未载入或尚未运行）。",
      "AI 对反馈的采用/未采用声明见对应公开说明；无声明不等于未读。",
    ].join("\n");
  });
  return `## 反馈并列证据（非因果证明）\n${blocks.join("\n\n")}`;
}

export function formatPublicProcessBlock(
  contribution: import("./types").Contribution,
  sourceLabel: (id: string) => string = (id) => id,
) {
  const parts: string[] = [];
  const meta = contribution.publicProcess;
  if (meta?.basis)
    parts.push(`**公开依据（AI 说明）**：${meta.basis}`);
  if (meta?.uncertainties?.length)
    parts.push(
      `**不确定性**：${meta.uncertainties.join("；")}`,
    );
  if (meta?.feedback?.length) {
    parts.push(
      "**反馈回应（声明，需对照输入清单）**：\n" +
        meta.feedback
          .map(
            (f) =>
              `- ${sourceLabel(f.sourceId)} · ${({used:"声明采用",not_used:"声明未采用",clarify:"需要澄清",unchecked:"尚未核查"})[f.stance]}${f.note ? ` · ${f.note}` : ""}`,
          )
          .join("\n"),
    );
  }
  if (contribution.publicProcessWarnings?.length)
    parts.push(
      `**说明校验**：${contribution.publicProcessWarnings.join("；")}`,
    );
  return parts.join("\n\n");
}
