import { skillKey } from "./skill-contract";
import {
  formatOutcomes,
  outcomeState,
  type OutcomeRecord,
} from "./outcome-contract";
import { createHash } from "node:crypto";
import type { Store } from "./store";
import type {
  ArtifactVersion,
  Contribution,
  Decision,
  Draft,
  Material,
  Message,
  OutputMode,
  Reference,
  Run,
  Work,
} from "./types";
import { outputLabels, versionLabel } from "./output";
export type ProcessRequest = {
  workId: string;
  mode: Exclude<OutputMode, "result" | "readiness">;
  runId?: string;
  versionId?: string;
  contributionIds?: string[];
  excerpt?: string;
};
export class ProcessRecords {
  constructor(readonly store: Store) {}
  prepare(input: ProcessRequest) {
    return this.store.transaction(() => {
      const work = this.store.require<Work>("work", input.workId);
      if (input.runId && input.contributionIds)
        throw Error("请选择一个轮次或一组记录");
      const targetVersion = input.versionId
        ? this.store.require<ArtifactVersion>("version", input.versionId)
        : undefined;
      if (
        targetVersion &&
        ((input.mode !== "review" && input.mode !== "method") ||
          targetVersion.workId !== work.id ||
          (input.runId && targetVersion.runId !== input.runId))
      )
        throw Error("所选成果不属于当前复盘范围");
      const allRuns = this.store
        .all<Run>("run")
        .filter((r) => r.workId === work.id);
      if (input.runId && !allRuns.some((r) => r.id === input.runId))
        throw Error("所选轮次不属于当前工作");
      const all = this.store
        .all<Contribution>("contribution")
        .filter((c) => c.workId === work.id);
      const ids = input.contributionIds
        ? [...new Set(input.contributionIds)]
        : undefined;
      if (ids?.some((id) => !all.some((c) => c.id === id)))
        throw Error("所选过程不属于当前工作");
      const contributions = all.filter((c) =>
        ids ? ids.includes(c.id) : !input.runId || c.runId === input.runId,
      );
      if (!contributions.length) throw Error("当前范围尚无过程记录");
      if (
        input.excerpt !== undefined &&
        (contributions.length !== 1 ||
          !input.excerpt.trim() ||
          !contributions[0].body.includes(input.excerpt))
      )
        throw Error("选段必须来自一条准确的公开分析");
      const runIds = [...new Set(contributions.map((c) => c.runId))];
      const runs = allRuns.filter((r) => runIds.includes(r.id));
      const versions =
        input.mode === "review" || input.mode === "method"
          ? this.store
              .all<ArtifactVersion>("version")
              .filter(
                (v) =>
                  v.workId === work.id &&
                  (v.id === targetVersion?.id ||
                    (v.runId && runIds.includes(v.runId)) ||
                    runs.some((r) => r.baseVersionId === v.id)),
              )
          : [];
      const outcomes =
        input.mode === "review" || input.mode === "method"
          ? this.store
              .all<OutcomeRecord>("outcome")
              .filter(
                (r) =>
                  r.workId === work.id &&
                  versions.some((v) => v.id === r.versionId),
              )
          : [];
      const messages =
        input.mode === "review" || input.mode === "method"
          ? this.store
              .all<Message>("message")
              .filter(
                (m) =>
                  m.workId === work.id &&
                  runIds.includes(m.runId) &&
                  m.role === "user",
              )
          : [];
      const decisions = this.store
        .all<Decision>("decision")
        .filter(
          (d) =>
            d.workId === work.id &&
            (ids ? ids.includes(d.contributionId) : runIds.includes(d.runId)),
        );
      const evidence: Reference[] = [];
      for (const contribution of contributions)
        for (const reference of contribution.task?.refs ??
          runs.find((r) => r.id === contribution.runId)?.refs ??
          []) {
          if (
            !evidence.some(
              (r) =>
                r.materialId === reference.materialId &&
                r.version === reference.version &&
                r.excerpt === reference.excerpt,
            )
          )
            evidence.push(reference);
        }
      const methods = new Map<string, string>();
      for (const c of contributions)
        for (const use of c.skills ?? []) {
          const skill = runs
            .find((r) => r.id === c.runId)
            ?.skills?.find((s) => skillKey(s) === use.key);
          if (skill)
            methods.set(
              `${c.runId}:${use.key}`,
              `## 方法 ${use.key}\n${skill.name}；来源：${skill.source.kind}；仅载入正文，未运行脚本或验证效果。\n${skill.body}`,
            );
        }
      const body = [
        `# ${outputLabels[input.mode]}的记录范围\n工作：${work.title}\n工作编号：${work.id}\n范围：${ids ? "所选记录" : input.runId ? "指定轮次" : "整个工作现有记录"}\n本材料是点击时的公开记录快照，之后新增内容不包含在内。记录没有内部推理，也不能证明真实使用效果。`,
        ...runs.map(
          (r) =>
            `## 轮次 ${r.id}\n目标：${r.text}\n状态：${r.status}\n时间：${r.createdAt}\n团队：${r.team.name} v${r.team.version}\n流程：${r.workflow.name} v${r.workflow.version}\n${r.error ? `限制：${r.error}` : ""}`,
        ),
        ...contributions.map(
          (c) =>
            `## 记录 ${c.id}\n轮次：${c.runId}\n成员：${c.memberName}（${c.memberId}）\n任务：${c.objective}\n状态：${c.status}\n${c.task?.parentId ? `受委派于记录：${c.task.parentId}；限定材料：${c.task.refs.map((r) => `${r.materialId} v${r.version}`).join("、") || "仅背景，无附件"}\n` : ""}${c.task?.returnedFrom ? `收到子任务回信：${c.task.returnedFrom}\n` : ""}${c.delegation ? `委派记录：${c.delegation.childKey}；回信记录：${c.delegation.responseId ?? "尚无"}\n` : ""}时间：${c.createdAt}\n${c.skills?.length ? `已载入的方法：${c.skills.map((s) => `${s.key}（${s.purpose}）`).join("、")}\n` : ""}${input.excerpt !== undefined ? "仅引用选段：" : "公开内容："}\n${input.excerpt ?? (c.body || "未记录公开分析")}\n${c.error ? `限制：${c.error}` : ""}`,
        ),
        ...decisions.map(
          (d) =>
            `## 决定 ${d.id}\n相关记录：${d.contributionId}\n问题：${d.question}\n影响：${d.impact}\n状态：${d.status}\n${d.answer ? `用户已提交回答：${d.answer}` : "尚无已提交回答"}`,
        ),
        ...versions.map(
          (v) =>
            `## 成果 ${v.id}\n${versionLabel(v)}\n轮次：${v.runId ?? "历史手动修订"}\n父版本：${v.parentId ?? "无"}\n${v.body}`,
        ),
        ...messages.map(
          (m) => `## 用户输入 ${m.id}\n轮次：${m.runId}\n${m.body}`,
        ),
        ...evidence.map((r, i) => {
          const m = this.store.material(r);
          return `## 来源 ${i + 1}\n材料：${r.materialId} v${r.version}\n标题：${r.label}\n覆盖：${m.coverage}\n${m.readError ? `未读取：${m.readError}` : (r.excerpt ?? m.body)}`;
        }),
        ...methods.values(),
        formatOutcomes(outcomes),
        input.mode === "review" || input.mode === "method"
          ? "## 复盘边界\n用户输入保留原话，不自动归类为已验证反馈。实际使用效果需要记录中的直接证据；没有时明确未验证。已停止、失败、等待或尚在运行的记录只可作阶段分析。"
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      if (Buffer.byteLength(body) > 24000)
        throw Error(
          "所选过程超过本轮输入范围，请选择较少记录或一个轮次；原草稿保持不变",
        );
      const digest = createHash("sha256").update(body).digest("hex"),
        materialId = `process:v2:${digest}`;
      const material: Material = {
        id: materialId,
        version: 1,
        title: `${outputLabels[input.mode]} · ${ids ? `${ids.length} 条记录` : input.runId ? "单轮" : "全工作"}`,
        body,
        coverage: "process_snapshot",
        createdAt: new Date().toISOString(),
        processSource: {
          workId: work.id,
          runIds,
          contributionIds: contributions.map((c) => c.id),
          versionIds: versions.map((v) => v.id),
          outcomeIds: outcomes.map((r) => r.id),
          outcomeState:
            input.mode === "review" || input.mode === "method"
              ? outcomeState(outcomes)
              : undefined,
          capturedAt: new Date().toISOString(),
          mode: input.mode,
        },
      };
      const draft = this.store.get<Draft>("draft", work.id),
        refs = [...(draft?.refs ?? [])].filter(
          (r) => r.materialId !== draft?.preparedProcess?.materialId,
        );
      if (!refs.some((r) => r.materialId === materialId && r.version === 1))
        refs.push({ materialId, version: 1, label: material.title });
      if (refs.length > 20) throw Error("草稿引用已达上限，请先精简");
      const instruction =
        input.mode === "method"
          ? "请依据所引用的过程、成果与反馈，整理可试用的方法草案：写清适用条件、必要输入、步骤、实例、修正依据和待验证假设；注明准确来源，不把草案当成已稳定方法。"
          : input.mode === "explanation"
            ? "请解释所引用的过程记录及依据，指出仍需核查之处；本轮只讨论，不修改主成果。"
            : input.mode === "summary"
              ? "请依据所引用的记录总结过程，关键结论注明记录编号；缺少公开分析或证据时保留限制。"
              : "请依据所引用的过程、用户修正和成果复盘目标与实际结果的差距，关键判断注明记录编号，区分事实、推断和建议；没有使用反馈时明确未验证。";
      let existingText = draft?.text ?? "";
      if (draft?.preparedProcess?.added) {
        const old = draft.preparedProcess.instruction;
        const paragraphs = existingText.split("\n\n");
        const position = paragraphs.lastIndexOf(old);
        if (position >= 0) {
          paragraphs.splice(position, 1);
          existingText = paragraphs.join("\n\n");
        }
      }
      const added = !existingText.includes(instruction);
      const text = added
        ? [existingText, instruction].filter(Boolean).join("\n\n")
        : existingText;
      if (Buffer.byteLength(text) > 16000)
        throw Error("草稿过长，请先精简后再加入过程任务");
      if (!this.store.get("material", `${materialId}@1`))
        this.store.put("material", `${materialId}@1`, material);
      return this.store.saveDraft({
        id: work.id,
        text,
        refs,
        recipient: draft?.recipient ?? null,
        projectId: work.projectId,
        outputMode: input.mode,
        preparedProcess: { materialId, instruction, added },
      });
    });
  }
}
