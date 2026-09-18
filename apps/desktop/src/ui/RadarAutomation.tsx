import { useState } from "react";
import { Clock, Pause, ArrowUpRight } from "lucide-react";
import type { Snapshot } from "../core/types";
import type { RadarTopic } from "../core/radar-contract";
import { radarCheckLabels } from "../core/radar-watch-contract";
import { command } from "./api";
import { Dialog } from "./Dialog";
import { IconButton } from "./Composer";

const time = (value: string | null) =>
  value
    ? new Date(value).toLocaleString("zh-CN", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "未安排";

export function RadarAutomationEditor({
  data,
  topic,
  onClose,
}: {
  data: Snapshot;
  topic: RadarTopic;
  onClose: () => void;
}) {
  const watch = data.radar.watches.find((w) => w.id === topic.id);
  const [revision] = useState(watch?.revision ?? 0),
    [topicRevision] = useState(topic.revision);
  const [enabled, setEnabled] = useState(watch?.enabled ?? false);
  const [minutes, setMinutes] = useState(watch?.intervalMinutes ?? 60);
  const [limit, setLimit] = useState(watch?.maxCallsPerDay ?? 4);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const checks = data.radar.checks
    .filter((c) => c.watchId === topic.id)
    .slice(-10)
    .reverse();
  const current = data.radar.jobs.filter((j) => j.topic.id === topic.id).at(-1);
  return (
    <Dialog
      title="自动整理议题"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          setError("");
          try {
            await command({
              type: "radar-watch-save",
              input: {
                topicId: topic.id,
                topicRevision,
                expectedRevision: revision,
                enabled,
                intervalMinutes: minutes,
                maxCallsPerDay: limit,
              },
            });
            onClose();
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset className="form-section">
          <legend>{topic.title}</legend>
          <p className="settings-note">
            按议题规则 v{topic.revision} 使用 {topic.sources.length} 项所选材料
            {topic.feedIds?.length
              ? `与 ${topic.feedIds.length} 个订阅的新近文章`
              : ""}
            。结果回到雷达，已有阅读位置与收藏版本保留。
          </p>
          <label className="schedule-check">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            应用运行时自动整理
          </label>
        </fieldset>
        <fieldset className="form-section">
          <legend>检查频率与用量</legend>
          <label>
            检查间隔（分钟）
            <input
              type="number"
              min={30}
              max={10080}
              required
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
            />
          </label>
          <label>
            每 24 小时最多自动调用模型
            <input
              type="number"
              min={1}
              max={24}
              required
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
            />
          </label>
          <p className="settings-note">
            仅在材料或规则变化时调用模型；上限按滚动 24 小时计算，手动整理另计。
          </p>
        </fieldset>
        <details>
          <summary>运行范围</summary>
          <p className="settings-note">
            只读取议题已选材料。应用退出时不执行，重开只检查当前材料一次；暂停只停止后续检查。
          </p>
        </details>
        {watch?.error ? <p role="status">{watch.error}</p> : null}
        {error ? <p role="alert">{error}</p> : null}
        <button className="primary" disabled={busy}>
          {busy ? "保存中…" : "保存设置"}
        </button>
      </form>
      {current?.status === "unknown" ? (
        <p>原整理待核对，请返回议题使用“核对原整理”。</p>
      ) : null}
      {watch ? (
        <p className="muted">
          下次检查：{time(watch.nextAt)} · 最近检查：{time(watch.lastCheckedAt)}
        </p>
      ) : null}
      {checks.length ? (
        <details>
          <summary>最近检查记录</summary>
          {checks.map((c) => (
            <article className="schedule-history" key={c.id}>
              <strong>{radarCheckLabels[c.status]}</strong>
              <small>
                {time(c.startedAt)} · 规则 v{c.topicRevision} · 自动设置 v
                {c.watchRevision}
              </small>
              <p>
                模型提交 {c.modelSubmitted ? 1 : 0} 次
                {c.error ? ` · ${c.error}` : ""}
              </p>
            </article>
          ))}
        </details>
      ) : null}
    </Dialog>
  );
}

export function RadarAutomationList({
  data,
  onRead,
}: {
  data: Snapshot;
  onRead: (id: string | null) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null),
    [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (!data.radar.watches.length) return null;
  const selected = data.radar.topics.find((t) => t.id === editing);
  return (
    <section className="feeds-panel">
      <h2>雷达自动整理</h2>
      <p className="muted">
        使用各议题选择的材料，解读回到雷达。检查未变不调用模型。
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {data.radar.watches.map((w) => {
        const topic = data.radar.topics.find((t) => t.id === w.id);
        if (!topic) return null;
        const last = data.radar.checks.filter((c) => c.watchId === w.id).at(-1);
        const edition = data.radar.editions
          .filter((e) => e.topicId === w.id)
          .at(-1);
        return (
          <article className="feed-row" key={w.id}>
            <div>
              <button className="story-title" onClick={() => setEditing(w.id)}>
                {topic.title}
              </button>
              <small>
                {w.enabled ? `每 ${w.intervalMinutes} 分钟检查` : "已暂停"} ·
                下次 {time(w.nextAt)}
              </small>
              <p className="muted">
                {w.error ??
                  (last ? radarCheckLabels[last.status] : "等待首次检查")}
              </p>
            </div>
            <div className="schedule-actions">
              <IconButton
                label={`自动整理设置 ${topic.title}`}
                onClick={() => setEditing(w.id)}
              >
                <Clock size={16} />
              </IconButton>
              {w.enabled ? (
                <IconButton
                  label={`暂停自动整理 ${topic.title}`}
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    setError("");
                    void command({
                      type: "radar-watch-save",
                      input: {
                        topicId: w.id,
                        topicRevision: topic.revision,
                        expectedRevision: w.revision,
                        enabled: false,
                        intervalMinutes: w.intervalMinutes,
                        maxCallsPerDay: w.maxCallsPerDay,
                      },
                    })
                      .catch((e) => setError(String(e)))
                      .finally(() => setBusy(false));
                  }}
                >
                  <Pause size={16} />
                </IconButton>
              ) : null}
              <IconButton
                label={`打开雷达 ${topic.title}`}
                onClick={() => onRead(edition?.id ?? null)}
              >
                <ArrowUpRight size={16} />
              </IconButton>
            </div>
          </article>
        );
      })}
      {selected ? (
        <RadarAutomationEditor
          key={selected.id}
          data={data}
          topic={selected}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </section>
  );
}
