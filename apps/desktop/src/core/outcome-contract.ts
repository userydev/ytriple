import { z } from "zod";
import type { Material, Reference } from "./types";
const id = z.string().min(1).max(300);
const context = {
  versionId: id,
  recipient: z.string().trim().min(1).max(300),
  purpose: z.string().trim().min(1).max(2000),
};
export const readinessInput = z.object(context).strict();
export const outcomeInput = z
  .object({
    ...context,
    key: z.string().uuid(),
    kind: z.enum(["handoff", "usage", "validation", "revision"]),
    occurredOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((s) => {
        const d = new Date(s);
        return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
      }, "请选择有效日期"),
    body: z.string().trim().min(1).max(8000),
    refs: z
      .array(
        z
          .object({
            materialId: id,
            version: z.number().int().positive(),
            label: z.string().max(500),
            excerpt: z.string().min(1).max(16000).optional(),
          })
          .strict(),
      )
      .max(5),
  })
  .strict();
export type OutcomeInput = z.infer<typeof outcomeInput>;
export type OutcomeRecord = Omit<OutcomeInput, "key" | "refs"> & {
  id: string;
  workId: string;
  versionHash: string;
  source: "user_report";
  evidence: { reference: Reference; material: Material }[];
  recordedAt: string;
  withdrawn?: { reason: string; at: string };
};
export const outcomeLabels: Record<OutcomeRecord["kind"], string> = {
  handoff: "交接记录",
  usage: "使用反馈",
  validation: "验证记录",
  revision: "待修订",
};
export function formatOutcomes(records: OutcomeRecord[]) {
  return records
    .map((r) =>
      [
        `## ${outcomeLabels[r.kind]} ${r.id}`,
        `来源：用户记录，非系统核验。成果版本：${r.versionId}；正文 SHA256：${r.versionHash}`,
        `接收或使用对象：${r.recipient}\n用途：${r.purpose}\n发生日期（用户填写）：${r.occurredOn}\n记录时间：${r.recordedAt}`,
        r.withdrawn
          ? `本记录已撤回，不可作为有效结论。原因：${r.withdrawn.reason}；撤回时间：${r.withdrawn.at}`
          : "记录有效；只适用于所列版本，不证明其他版本已使用或已验证。",
        r.body,
        ...r.evidence.map(
          ({ reference: ref, material: m }) =>
            `证据：${m.title}（${m.id} v${m.version}；覆盖：${m.coverage}）\n${ref.excerpt ?? m.body}`,
        ),
        r.evidence.length
          ? "附件已保存；是否支持上述判断仍需核查。"
          : "没有附加证据，仅有用户陈述。",
      ].join("\n"),
    )
    .join("\n\n");
}

export function outcomeState(records: OutcomeRecord[]) {
  return JSON.stringify(
    records
      .map((r) => [r.id, r.recordedAt, r.withdrawn?.at ?? null])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
}
export function outcomeSnapshotChanged(
  material: Material,
  records: OutcomeRecord[],
) {
  const source = material.readinessSource ?? material.processSource;
  if (!source?.outcomeState) return false;
  const versionIds = material.readinessSource
    ? [material.readinessSource.versionId]
    : (material.processSource?.versionIds ?? []);
  return (
    source.outcomeState !==
    outcomeState(
      records.filter(
        (r) => r.workId === source.workId && versionIds.includes(r.versionId),
      ),
    )
  );
}
