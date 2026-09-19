import { createHash } from "node:crypto";
import {
  outcomeInput,
  readinessInput,
  formatOutcomes,
  outcomeState,
  type OutcomeInput,
  type OutcomeRecord,
} from "./outcome-contract";
import type { Store } from "./store";
import type { ArtifactVersion, Draft, Material, Run, Work } from "./types";
import { versionLabel } from "./output";
import { captureProjectContext, formatProjectContext } from "./projects";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export class Outcomes {
  constructor(readonly store: Store) {}
  private result(id: string) {
    const version = this.store.require<ArtifactVersion>("version", id);
    const work = this.store.require<Work>("work", version.workId);
    if ((version.kind ?? "result") !== "result" || !version.body.trim())
      throw Error("请选择完整主成果版本");
    if (version.author === "team") {
      const run = version.runId && this.store.get<Run>("run", version.runId);
      if (!run || run.workId !== work.id || run.status !== "succeeded")
        throw Error("该成果尚无已完成的原运行");
    }
    return { version, work };
  }
  record(raw: OutcomeInput) {
    const input = outcomeInput.parse(raw);
    return this.store.transaction(() => {
      const oldInput = this.store.get<OutcomeInput>("outcome-input", input.key);
      if (oldInput) {
        if (JSON.stringify(oldInput) !== JSON.stringify(input))
          throw Error("此记录请求已使用，请重新保存");
        return this.store.require<OutcomeRecord>("outcome", input.key);
      }
      const { version, work } = this.result(input.versionId);
      const evidence = input.refs.map((reference) => {
        const material = this.store.material(reference);
        if (material.readError || !material.body.trim())
          throw Error("所选证据未读取，请先补齐材料");
        if (
          reference.excerpt !== undefined &&
          !material.body.includes(reference.excerpt)
        )
          throw Error("证据选段不属于指定材料版本");
        return { reference: { ...reference, label: material.title }, material };
      });
      const { key, refs: _refs, ...fields } = input;
      const record: OutcomeRecord = {
        ...fields,
        id: key,
        workId: work.id,
        source: "user_report",
        versionHash: hash(version.body),
        evidence,
        recordedAt: new Date().toISOString(),
      };
      if (Buffer.byteLength(formatOutcomes([record])) > 24000)
        throw Error("反馈与证据过长，请缩小材料范围");
      this.store.put("outcome-input", key, input);
      return this.store.put("outcome", key, record);
    });
  }
  withdraw(id: string, reason: string) {
    if (!reason.trim() || reason.length > 2000)
      throw Error("请填写简短的撤回原因");
    const record = this.store.require<OutcomeRecord>("outcome", id);
    if (record.withdrawn) return record;
    return this.store.put("outcome", id, {
      ...record,
      withdrawn: { reason: reason.trim(), at: new Date().toISOString() },
    });
  }
  prepare(raw: { versionId: string; recipient: string; purpose: string }) {
    const input = readinessInput.parse(raw);
    return this.store.transaction(() => {
      const { work, version } = this.result(input.versionId);
      const records = this.store
        .all<OutcomeRecord>("outcome")
        .filter((r) => r.versionId === version.id && r.workId === work.id);
      const body = [
        `# 交接检查材料\n工作：${work.title}\n成果：${versionLabel(version)}\n版本编号：${version.id}\n正文 SHA256：${hash(version.body)}\n接收对象：${input.recipient}\n预期用途：${input.purpose}`,
        `## 指定版本完整正文\n${version.body}`,
        `## 检查时的项目要求\n${formatProjectContext(captureProjectContext(this.store, work.projectId, work.deliveryId)) || "未提供项目要求"}`,
        `## 该版本已有记录\n${formatOutcomes(records) || "尚无交接、使用或验证记录。"}`,
        "以上是准备检查时的快照；没有附带的文件和外部执行结果视为未知。用户记录与附件不是系统认证。",
      ].join("\n\n");
      if (Buffer.byteLength(body) > 24000)
        throw Error("交接材料超出本轮范围，请先精简成果或项目材料");
      const materialId = `readiness:v1:${hash(body)}`;
      const instruction =
        "请检查所引用版本是否适合交给指定对象使用：复述目标和输入条件，列出缺失材料、要求冲突、证据不足和可能的歧义，并区分阻塞项与可选改进。输出独立的 AI 检查意见，不修改主成果、不宣称已经交接或验证。";
      const previous = this.store.get<Draft>("draft", work.id);
      const refs = (previous?.refs ?? []).filter(
        (r) => r.materialId !== previous?.preparedProcess?.materialId,
      );
      if (!refs.some((r) => r.materialId === materialId))
        refs.push({
          materialId,
          version: 1,
          label: `交接检查 · ${versionLabel(version)} · ${input.recipient}`,
        });
      if (refs.length > 20) throw Error("草稿引用已达上限，请先精简");
      const paragraphs = (previous?.text ?? "").split("\n\n");
      if (previous?.preparedProcess?.added) {
        const i = paragraphs.lastIndexOf(previous.preparedProcess.instruction);
        if (i >= 0) paragraphs.splice(i, 1);
      }
      const existing = paragraphs.join("\n\n");
      const added = !existing.includes(instruction);
      const text = [existing, ...(added ? [instruction] : [])]
        .filter(Boolean)
        .join("\n\n");
      if (Buffer.byteLength(text) > 16000) throw Error("草稿过长，请先精简");
      if (!this.store.get("material", `${materialId}@1`)) {
        const material: Material = {
          id: materialId,
          version: 1,
          title: `交接检查 · ${versionLabel(version)} · ${input.recipient}`,
          body,
          coverage: "readiness_snapshot",
          createdAt: new Date().toISOString(),
          readinessSource: {
            ...input,
            workId: work.id,
            versionHash: hash(version.body),
            outcomeIds: records.map((r) => r.id),
            outcomeState: outcomeState(records),
          },
        };
        this.store.put("material", `${materialId}@1`, material);
      }
      return this.store.saveDraft({
        id: work.id,
        text,
        refs,
        recipient: previous?.recipient ?? null,
        projectId: work.projectId,
        outputMode: "readiness",
        preparedProcess: { materialId, instruction, added },
      });
    });
  }
}
