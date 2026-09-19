import type { Snapshot, Contribution } from "../core/types";
import { coverageLabels } from "../core/input-manifest";
const stance = { used: "AI 声明采用", not_used: "AI 声明未采用", clarify: "AI 需要澄清", unchecked: "AI 尚未核查" };
export function FeedbackEvidence({ data, workId, records }: { data: Snapshot; workId: string; records: Contribution[] }) {
  const recordIds = new Set(records.map(c => c.id));
  const runIds = new Set(records.map(c => c.runId));
  const manifests = (data.inputManifests ?? []).filter(m => m.workId === workId && recordIds.has(m.contributionId));
  const sources = new Map<string, { id: string; text: string; label: string }>();
  for (const m of data.messages.filter(m => m.workId === workId && m.role === "user" && runIds.has(m.runId))) sources.set(`msg:${m.id}`, { id: `msg:${m.id}`, text: m.body, label: "用户输入" });
  for (const d of data.decisions.filter(d => d.workId === workId && recordIds.has(d.contributionId) && d.answer)) sources.set(`dec:${d.id}`, { id: `dec:${d.id}`, text: `${d.question}\n${d.answer}`, label: "用户决定" });
  for (const m of manifests) for (const e of m.entries.filter(e => e.kind !== "material")) {
    if (!sources.has(e.id)) sources.set(e.id, { id: e.id, text: e.label, label: e.kind === "outcome" ? "使用反馈（形成时快照）" : "历史输入（形成时快照）" });
  }
  if (!sources.size) return null;
  return <section className="feedback-evidence">
    <h3>反馈如何进入工作</h3>
    <p className="muted">送入上下文、AI 回应与成果变化是不同证据。无回应不代表无用；效果仍需验证。</p>
    {[...sources.values()].map(source => {
      const received = manifests.filter(m => m.entries.some(e => e.id === source.id));
      return <details key={source.id}>
        <summary>{source.label} · {source.text.slice(0, 42)}{source.text.length > 42 ? "…" : ""} · {received.length ? `${received.length} 次请求有传入记录` : "尚无传入证据"}</summary>
        <p className="feedback-source">{source.text}</p>
        {received.map(m => {
          const c = records.find(c => c.id === m.contributionId)!;
          const entry = m.entries.find(e => e.id === source.id)!;
          const claim = c.publicProcess?.feedback?.find(f => f.sourceId === source.id);
          const versions = data.versions.filter(v => v.runId === m.runId);
          return <div className="feedback-receipt" key={m.id}>
            <a href={`#record-${c.id}`}>{c.memberName} · {coverageLabels[entry.coverage]}</a>
            <p>{claim ? `${stance[claim.stance]}${claim.note ? `：${claim.note}` : ""}` : "AI 未单独回应这条来源，采用情况未知"}</p>
            <small>{versions.length ? `同轮形成 ${versions.length} 个成果版本，可在结果窗比较；这不证明由该反馈导致。` : "本轮没有成果版本变化；仍可能进行了核查。"} 效果待验证。</small>
          </div>;
        })}
        {!received.length ? <p className="muted">旧记录可能未记录清单，不能据此判断反馈未被采用。</p> : null}
      </details>;
    })}
  </section>;
}
