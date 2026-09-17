import { useState } from "react";
import {
  Plus,
  RefreshCw,
  Pause,
  Play,
  Square,
  Pencil,
  Archive,
  RotateCcw,
  Rss,
} from "lucide-react";
import type { Snapshot } from "../core/types";
import type { FeedSource, FeedPreview } from "../core/feed-contract";
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
    : "尚未读取";

function AddFeed({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState(""),
    [name, setName] = useState("");
  const [preview, setPreview] = useState<FeedPreview | null>(null);
  const [enabled, setEnabled] = useState(false),
    [minutes, setMinutes] = useState(60);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Dialog
      title="添加我的订阅"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError("");
          try {
            if (!preview) {
              const result = await command<FeedPreview>({
                type: "feed-preview",
                url,
              });
              setPreview(result);
              setName(result.snapshot.title.slice(0, 120));
            } else {
              await command({
                type: "feed-add",
                previewId: preview.id,
                name,
                intervalMinutes: minutes,
                enabled,
              });
              onClose();
            }
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          RSS / Atom 地址
          <input
            type="url"
            autoFocus
            required
            value={url}
            disabled={busy}
            placeholder="https://…/feed"
            onChange={(e) => {
              setUrl(e.target.value);
              setPreview(null);
            }}
          />
        </label>
        <p className="muted">
          由当前信息服务读取公开订阅。不会加入公共资料库，也不会调用模型；登录、付费和带密钥的订阅暂不支持。
        </p>
        {preview ? (
          <>
            <label>
              来源名称
              <input
                value={name}
                maxLength={120}
                required
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <p>
              识别为持续订阅 · 本次可读取 {preview.snapshot.items.length} 条
              {preview.snapshot.omitted_items
                ? `，另有 ${preview.snapshot.omitted_items} 条未纳入`
                : ""}
            </p>
            <p className="muted">
              读取的是订阅提供的标题、摘要或节选，未逐篇读取网站全文。历史材料保留，后续更新形成新版本。
            </p>
            <details>
              <summary>预览本次材料</summary>
              {preview.snapshot.items.slice(0, 3).map((item) => (
                <article key={item.url}>
                  <strong>{item.title}</strong>
                  <p>{item.text.slice(0, 240)}</p>
                </article>
              ))}
            </details>
            <label className="schedule-check">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              应用运行时自动更新
            </label>
            <label>
              检查间隔
              <select
                value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value))}
              >
                {[30, 60, 180, 720, 1440].map((n) => (
                  <option key={n} value={n}>
                    {n < 60 ? `${n} 分钟` : `${n / 60} 小时`}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "处理中…" : preview ? "加入我的来源" : "识别并读取"}
        </button>
      </form>
    </Dialog>
  );
}

export function FeedsPanel({ data }: { data: Snapshot }) {
  const [adding, setAdding] = useState(false),
    [editing, setEditing] = useState<FeedSource | null>(null);
  const [history, setHistory] = useState<string | null>(null),
    [archived, setArchived] = useState(false);
  const [busy, setBusy] = useState<string | null>(null),
    [error, setError] = useState("");
  async function act(id: string, callback: () => Promise<unknown>) {
    if (busy) return;
    setBusy(id);
    setError("");
    try {
      await callback();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }
  function update(source: FeedSource, patch: Partial<FeedSource>) {
    return command({
      type: "feed-update",
      id: source.id,
      revision: source.revision,
      patch: {
        name: source.name,
        intervalMinutes: source.intervalMinutes,
        enabled: source.enabled,
        archived: source.archived,
        ...patch,
      },
    });
  }
  const selected = data.feeds.find((s) => s.id === history);
  return (
    <section className="feeds-panel">
      <div className="section-heading">
        <div>
          <h2>我的来源</h2>
          <p className="muted">订阅送来新材料，议题负责理解变化。</p>
        </div>
        <button
          className="text-action"
          disabled={!data.service.configured}
          onClick={() => setAdding(true)}
        >
          <Plus size={17} />
          添加订阅
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {!data.feeds.length ? (
        <p className="muted">
          添加公开 RSS 或 Atom，预览范围后再启用自动更新。
        </p>
      ) : null}
      {data.feeds
        .filter((s) => (archived ? s.archived : !s.archived))
        .map((s) => {
          const running = data.feedChecks.some(
            (c) => c.sourceId === s.id && c.status === "running",
          );
          const last = data.feedChecks
            .filter((c) => c.sourceId === s.id)
            .at(-1);
          return (
            <article className="feed-row" key={s.id}>
              <div>
                <button
                  className="story-title"
                  onClick={() => setHistory(s.id)}
                >
                  <Rss size={15} />
                  {s.name}
                </button>
                <small>
                  {running
                    ? "读取中"
                    : s.archived
                      ? "已停用"
                      : s.error
                        ? "更新失败"
                        : s.enabled
                          ? `每 ${s.intervalMinutes} 分钟更新`
                          : "手动更新"}{" "}
                  · 最近成功 {time(s.lastSuccessAt)}
                </small>
                <p className="muted">
                  {s.error ??
                    (last?.status === "succeeded"
                      ? `新增 ${last.added} · 修订 ${last.updated} · 未变 ${last.unchanged}`
                      : "尚无更新记录")}
                </p>
                {last?.omittedItems ? (
                  <small>
                    本次有 {last.omittedItems} 条未纳入，查看记录了解范围。
                  </small>
                ) : null}
              </div>
              <div className="schedule-actions">
                {s.archived ? (
                  <IconButton
                    label={`恢复来源 ${s.name}`}
                    disabled={!!busy}
                    onClick={() =>
                      void act(s.id, async () => {
                        await update(s, { archived: false, enabled: false });
                        setArchived(false);
                      })
                    }
                  >
                    <RotateCcw size={16} />
                  </IconButton>
                ) : (
                  <>
                    {running ? (
                      <IconButton
                        label={`停止本次读取 ${s.name}`}
                        onClick={() =>
                          void command({ type: "feed-stop", id: s.id }).catch(
                            (e) => setError(String(e)),
                          )
                        }
                      >
                        <Square size={16} />
                      </IconButton>
                    ) : (
                      <IconButton
                        label={`刷新来源 ${s.name}`}
                        disabled={!!busy}
                        onClick={() =>
                          void act(s.id, () =>
                            command({ type: "feed-refresh", id: s.id }),
                          )
                        }
                      >
                        <RefreshCw size={16} />
                      </IconButton>
                    )}
                    <IconButton
                      label={`${s.enabled ? "暂停自动更新" : "启用自动更新"} ${s.name}`}
                      disabled={!!busy}
                      onClick={() =>
                        void act(s.id, () => update(s, { enabled: !s.enabled }))
                      }
                    >
                      {s.enabled ? <Pause size={16} /> : <Play size={16} />}
                    </IconButton>
                    <IconButton
                      label={`编辑来源 ${s.name}`}
                      disabled={!!busy}
                      onClick={() => setEditing(s)}
                    >
                      <Pencil size={16} />
                    </IconButton>
                    <IconButton
                      label={`停用并保留材料 ${s.name}`}
                      disabled={!!busy || running}
                      onClick={() =>
                        void act(s.id, () =>
                          update(s, { archived: true, enabled: false }),
                        )
                      }
                    >
                      <Archive size={16} />
                    </IconButton>
                  </>
                )}
              </div>
            </article>
          );
        })}
      {archived || data.feeds.some((s) => s.archived) ? (
        <button
          className="text-action muted"
          onClick={() => setArchived(!archived)}
        >
          {archived ? "返回当前来源" : "已停用来源"}
        </button>
      ) : null}
      {adding ? <AddFeed onClose={() => setAdding(false)} /> : null}
      {editing ? (
        <Dialog title="来源设置" onClose={() => setEditing(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const input = new FormData(e.currentTarget);
              void act(editing.id, async () => {
                await update(editing, {
                  name: String(input.get("name")),
                  intervalMinutes: Number(input.get("interval")),
                });
                setEditing(null);
              });
            }}
          >
            <label>
              来源名称
              <input
                name="name"
                required
                maxLength={120}
                defaultValue={editing.name}
              />
            </label>
            <label>
              检查间隔（分钟）
              <input
                name="interval"
                type="number"
                min={30}
                max={10080}
                required
                defaultValue={editing.intervalMinutes}
              />
            </label>
            <p className="muted">{editing.url}</p>
            <p>
              自动检查只在应用运行时进行；重新打开会检查最新一份订阅，不逐次补跑错过的时点。
            </p>
            {error ? <p role="alert">{error}</p> : null}
            <button className="primary" disabled={!!busy}>
              保存
            </button>
          </form>
        </Dialog>
      ) : null}
      {selected ? (
        <Dialog title={selected.name} onClose={() => setHistory(null)}>
          <p className="local-path">{selected.url}</p>
          <p className="muted">
            下次检查：{selected.nextAt ? time(selected.nextAt) : "未安排"}
            。停用不会删除已读材料或旧解读。
          </p>
          {data.feedChecks
            .filter((c) => c.sourceId === selected.id)
            .slice()
            .reverse()
            .map((c) => (
              <article className="schedule-history" key={c.id}>
                <strong>
                  {
                    {
                      running: "读取中",
                      succeeded: "已检查",
                      failed: "读取失败",
                      cancelled: "已停止",
                      interrupted: "读取中断",
                    }[c.status]
                  }
                </strong>
                <small>
                  {time(c.startedAt)} ·{" "}
                  {
                    { add: "首次加入", manual: "手动刷新", clock: "自动检查" }[
                      c.trigger
                    ]
                  }
                </small>
                <p>
                  {c.error ??
                    `新增 ${c.added} · 修订 ${c.updated} · 未变 ${c.unchanged}`}
                </p>
                {c.note ? (
                  <p>
                    {c.note} 未纳入 {c.omittedItems} 条。
                  </p>
                ) : null}
                {c.resolvedUrl && c.resolvedUrl !== selected.url ? (
                  <small>重定向后的来源：{c.resolvedUrl}</small>
                ) : null}
              </article>
            ))}
        </Dialog>
      ) : null}
    </section>
  );
}
