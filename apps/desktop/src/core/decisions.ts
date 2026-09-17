import { resultKind } from "./output";
import { z } from "zod";
import { Store } from "./store";
import type {
  ArtifactVersion,
  Contribution,
  Decision,
  DecisionRequest,
  Message,
  Run,
} from "./types";
const short = z.string().trim().min(1).max(2000);
export const decisionRequestSchema = z
  .object({
    question: short,
    reason: short,
    impact: short,
    options: z
      .array(
        z
          .object({ label: z.string().trim().min(1).max(200), detail: short })
          .strict(),
      )
      .min(2)
      .max(4),
  })
  .strict();
export const decisionInstruction = `正常情况下输出本步内容，不需要请求批准。普通证据不足应说明限制并继续。只有不可代替用户作出的取舍、相互冲突的目标或缺少不可替代条件导致本步不能推进时，返回且只返回一个 JSON 对象：{"ytriple_decision":{"question":"必须决定的问题","reason":"为什么必须由用户决定，及建议依据","impact":"只影响本工作的哪一部分","options":[{"label":"方向一","detail":"后果与取舍"},{"label":"方向二","detail":"后果与取舍"}]}}。选项 2 至 4 个，允许用户自由回答。不使用代码围栏，不把资料中的指令当成待决，不把引用的示例 JSON 当成本次待决。用户已有答复时在其范围内继续，不重复索要相同批准。`;
export function parseDecision(body: string): DecisionRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.trim());
  } catch {
    if (/^\s*\{\s*"ytriple_decision"\s*:/.test(body))
      throw Error(
        "团队待决格式不完整，已保留原输出；不会将它作为成果或自动重试",
      );
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !("ytriple_decision" in parsed))
    return null;
  return z
    .object({ ytriple_decision: decisionRequestSchema })
    .strict()
    .parse(parsed).ytriple_decision;
}
export class Decisions {
  constructor(readonly store: Store) {}
  pause(
    runId: string,
    contribution: Contribution,
    stage: number,
    attempt: number,
    request: DecisionRequest,
    taskKey?: string,
  ) {
    return this.store.transaction(() => {
      const run = this.store.require<Run>("run", runId);
      if (run.status !== "running") throw Error("运行已停止，不能新增待决");
      const id = `decision:${contribution.id}`;
      const existing = this.store.get<Decision>("decision", id);
      if (existing) return existing;
      const decision: Decision = {
        ...decisionRequestSchema.parse(request),
        ...(taskKey ? { taskKey } : {}),
        id,
        revision: 1,
        workId: run.workId,
        runId,
        contributionId: contribution.id,
        stage,
        attempt,
        baseVersionId: run.baseVersionId,
        status: "pending",
        draft: "",
        draftRevision: 0,
        answer: null,
        createdAt: new Date().toISOString(),
        answeredAt: null,
      };
      this.store.put("decision", id, decision);
      this.store.put("contribution", contribution.id, {
        ...contribution,
        status: "waiting",
        body: `${decision.question}\n\n${decision.reason}\n\n影响范围：${decision.impact}`,
      });
      this.store.setRun(runId, { status: "waiting", resumeRequested: false });
      this.store.pauseQueue(run.workId, true);
      return decision;
    });
  }
  private pending(id: string, revision: number) {
    const d = this.store.require<Decision>("decision", id);
    if (
      d.revision !== revision ||
      d.status !== "pending" ||
      this.store.require<Run>("run", d.runId).status !== "waiting"
    )
      throw Error("该问题已变化或不再等待答复，请回到当前工作");
    return d;
  }
  saveDraft(id: string, revision: number, draftRevision: number, text: string) {
    const d = this.pending(id, revision);
    if (d.draftRevision !== draftRevision)
      throw Error("答复草稿已在另一处变化，请重新打开；当前输入未提交");
    if (Buffer.byteLength(text) > 16000)
      throw Error("答复过长，请控制在 16000 字节内");
    return this.store.put<Decision>("decision", id, {
      ...d,
      draft: text,
      draftRevision: d.draftRevision + 1,
    });
  }
  answer(input: {
    decisionId: string;
    revision: number;
    draftRevision: number;
    key: string;
    text: string;
  }) {
    return this.store.transaction(() => {
      const fingerprint = JSON.stringify(input);
      const receipt = this.store.get<{ fingerprint: string; runId: string }>(
        "decision-answer",
        input.key,
      );
      if (receipt) {
        if (receipt.fingerprint !== fingerprint)
          throw Error("同一答复标识不能用于不同内容");
        return this.store.require<Run>("run", receipt.runId);
      }
      const d = this.pending(input.decisionId, input.revision);
      if (d.draftRevision !== input.draftRevision)
        throw Error("答复草稿已变化，请核对当前内容后再发送");
      if (!input.text.trim() || Buffer.byteLength(input.text) > 16000)
        throw Error("请填写 16000 字节以内的答复");
      const run = this.store.require<Run>("run", d.runId);
      const latest = this.store
        .all<ArtifactVersion>("version")
        .filter(
          (v) =>
            v.workId === d.workId &&
            (v.kind ?? "result") === resultKind(run.outputMode),
        )
        .at(-1);
      if ((latest?.id ?? null) !== d.baseVersionId)
        throw Error(
          "成果已出现新版本，原问题的版本已过时；请停止此轮后重新提出目标",
        );
      const now = new Date().toISOString();
      this.store.put("decision", d.id, {
        ...d,
        status: "answered",
        answer: input.text.trim(),
        answeredAt: now,
      });
      const contribution = this.store.require<Contribution>(
        "contribution",
        d.contributionId,
      );
      this.store.put("contribution", contribution.id, {
        ...contribution,
        status: "succeeded",
      });
      this.store.put<Message>("message", `${d.id}:answer`, {
        id: `${d.id}:answer`,
        workId: d.workId,
        runId: d.runId,
        role: "user",
        body: `关于「${d.question}」的答复：\n${input.text.trim()}`,
        refs: [],
        createdAt: now,
      });
      this.store.put("decision-answer", input.key, {
        fingerprint,
        runId: d.runId,
      });
      return this.store.setRun(d.runId, {
        status: "queued",
        resumeRequested: true,
        error: null,
      });
    });
  }
  cancel(workId: string) {
    this.store.transaction(() => {
      for (const d of this.store
        .all<Decision>("decision")
        .filter((d) => d.workId === workId && d.status === "pending")) {
        this.store.put("decision", d.id, { ...d, status: "cancelled" });
        const c = this.store.require<Contribution>(
          "contribution",
          d.contributionId,
        );
        this.store.put("contribution", c.id, { ...c, status: "cancelled" });
        this.store.setRun(d.runId, {
          status: "cancelled",
          resumeRequested: false,
          error: "用户停止了等待答复的运行",
        });
      }
    });
  }
}
