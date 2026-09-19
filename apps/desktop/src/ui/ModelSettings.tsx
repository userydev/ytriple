import { useRef, useState } from "react";
import { Check, FlaskConical, Settings2 } from "lucide-react";
import type { Snapshot } from "../core/types";
import type { DirectProfile } from "../core/model-contract";
import { command } from "./api";
import { Dialog } from "./Dialog";
import "./settings-account.css";

const empty: DirectProfile = {
  baseUrl: "",
  model: "",
  maxOutputTokens: 4096,
  tokenParameter: "max_tokens",
};

export function ModelSettings({
  data,
  onError,
}: {
  data: Snapshot;
  onError: (e: unknown) => void;
}) {
  const info = data.model;
  const [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const [profile, setProfile] = useState<DirectProfile>(info?.direct ?? empty),
    [token, setToken] = useState(""),
    [noKey, setNoKey] = useState(false);
  const lock = useRef(false);
  async function act(fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setNotice("");
    try {
      await fn();
    } catch (e) {
      onError(e);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function openDirectConfiguration() {
    setProfile(info?.direct ?? empty);
    setToken("");
    setNoKey(false);
    setEditing(true);
  }
  return (
    <section className="settings-page model-settings">
      <div className="settings-section">
        <div className="settings-section-header">
          <div>
            <h2>AI 模型</h2>
            <p>选择此工作空间执行 AI 工作时使用的连接。</p>
          </div>
          <button
            type="button"
            disabled={
              busy ||
              !info?.configured ||
              (info.mode === "service" && !data.service.ai)
            }
            onClick={() =>
              void act(async () => {
                await command({ type: "model-test" });
                setNotice("测试通过，文本流正常完成。");
              })
            }
          >
            <FlaskConical size={16} />
            {busy ? "正在测试…" : "测试当前模型"}
          </button>
        </div>
        <div
          className="model-choice-group"
          role="group"
          aria-label="AI 连接方式"
        >
          <button
            className="model-choice"
            aria-pressed={info?.mode !== "direct"}
            disabled={busy || !data.service.configured}
            onClick={() =>
              void act(async () => {
                await command({ type: "model-select", mode: "service" });
              })
            }
          >
            <span className="choice-indicator">
              {info?.mode !== "direct" ? <Check size={15} /> : null}
            </span>
            <span>
              <strong>ycore 服务</strong>
              <small>使用账号服务提供的共享模型，无需单独管理 API Key。</small>
            </span>
          </button>
          <button
            className="model-choice"
            aria-pressed={info?.mode === "direct"}
            disabled={busy}
            onClick={() => {
              if (info?.direct)
                void act(async () => {
                  await command({ type: "model-select", mode: "direct" });
                });
              else openDirectConfiguration();
            }}
          >
            <span className="choice-indicator">
              {info?.mode === "direct" ? <Check size={15} /> : null}
            </span>
            <span>
              <strong>自带 API</strong>
              <small>
                连接兼容 Chat Completions 的模型接口，凭据保存在本机。
              </small>
            </span>
          </button>
        </div>
        <div className="setting-row">
          <div className="setting-copy">
            <strong>当前模型</strong>
            <small>
              {info?.mode === "direct"
                ? info.direct?.baseUrl
                : "由 ycore 服务提供"}
            </small>
          </div>
          <span className="setting-value">
            {info?.label ?? "ycore 共享模型"}
          </span>
        </div>
        <div className="setting-row">
          <div className="setting-copy">
            <strong>连接状态</strong>
            <small>
              {info?.testedAt
                ? `最近测试：${new Date(info.testedAt).toLocaleString()}`
                : "尚未完成连接测试"}
            </small>
          </div>
          <span
            className={`status-badge ${info?.configured ? "success" : "warning"}`}
          >
            {info?.configured ? "已配置" : "待配置"}
          </span>
        </div>
        <div className="settings-actions">
          <button
            type="button"
            onClick={openDirectConfiguration}
            disabled={busy}
          >
            <Settings2 size={16} />
            {info?.direct ? "编辑自带 API" : "配置自带 API"}
          </button>
        </div>
        <p className="settings-note">
          模型测试会发送一条固定短消息，可能产生用量，不携带工作资料。
        </p>
        {info?.error ? (
          <div role="status" className="settings-note error-note">
            {info.error}
          </div>
        ) : null}
        {notice ? (
          <div role="status" className="settings-note success-note">
            {notice}
          </div>
        ) : null}
      </div>
      {editing ? (
        <Dialog
          title="自带 API 配置"
          onClose={() => {
            if (!busy) setEditing(false);
          }}
        >
          <form
            className="settings-form model-config-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                await command({ type: "model-save", profile, token, noKey });
                setToken("");
                setEditing(false);
                setNotice("已保存并选用；可测试连接或直接开始工作。");
              });
            }}
          >
            <label>
              接口根地址
              <input
                type="url"
                required
                placeholder="https://提供商/v1"
                value={profile.baseUrl}
                onChange={(e) =>
                  setProfile({ ...profile, baseUrl: e.target.value })
                }
                disabled={busy}
              />
            </label>
            <label>
              模型名称
              <input
                required
                maxLength={200}
                placeholder="填写提供商提供的准确模型 ID"
                value={profile.model}
                onChange={(e) =>
                  setProfile({ ...profile, model: e.target.value })
                }
                disabled={busy}
              />
            </label>
            <label>
              API Key
              <input
                type="password"
                autoComplete="off"
                value={token}
                placeholder={
                  info?.direct
                    ? "留空沿用同一接口的已保存凭据"
                    : "只保存在本机系统安全存储"
                }
                onChange={(e) => setToken(e.target.value)}
                disabled={busy || noKey}
              />
            </label>
            <label className="inline-check">
              <input
                type="checkbox"
                checked={noKey}
                onChange={(e) => setNoKey(e.target.checked)}
                disabled={busy}
              />
              此接口无需 API Key
            </label>
            <details className="advanced-settings">
              <summary>兼容选项</summary>
              <label>
                输出 token 上限
                <input
                  type="number"
                  min={256}
                  max={32768}
                  value={profile.maxOutputTokens}
                  onChange={(e) =>
                    setProfile({
                      ...profile,
                      maxOutputTokens: Number(e.target.value),
                    })
                  }
                  disabled={busy}
                />
              </label>
              <label>
                上限参数
                <select
                  value={profile.tokenParameter}
                  onChange={(e) =>
                    setProfile({
                      ...profile,
                      tokenParameter: e.target
                        .value as DirectProfile["tokenParameter"],
                    })
                  }
                  disabled={busy}
                >
                  <option value="max_tokens">max_tokens · 通用兼容接口</option>
                  <option value="max_completion_tokens">
                    max_completion_tokens · 要求此参数的模型
                  </option>
                </select>
              </label>
            </details>
            <p className="settings-note">
              支持 Chat Completions
              文本流。联网检索、图片和工具能力需另行接入；中断后不自动重发。
            </p>
            <div className="dialog-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => setEditing(false)}
              >
                取消
              </button>
              <button className="primary" disabled={busy}>
                {busy ? "正在保存…" : "保存并选用"}
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}
    </section>
  );
}
