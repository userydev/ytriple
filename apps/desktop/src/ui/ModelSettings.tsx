import { useState, useRef } from "react";
import { FlaskConical, Check, PlugZap } from "lucide-react";
import type { Snapshot } from "../core/types";
import type { DirectProfile } from "../core/model-contract";
import { command } from "./api";
import { IconButton } from "./Composer";
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
  const useDirect = () => {
    if (info?.direct) {
      void act(async () => {
        await command({ type: "model-select", mode: "direct" });
      });
    } else {
      setProfile(empty);
      setEditing(true);
    }
  };
  return (
    <section className="model-settings">
      <div className="section-heading">
        <h2>AI 模型</h2>
        <IconButton
          label="测试当前模型"
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
          <FlaskConical size={18} />
        </IconButton>
      </div>
      <div className="model-options" role="group" aria-label="AI 连接方式">
        <button
          aria-pressed={info?.mode !== "direct"}
          disabled={busy || !data.service.configured}
          onClick={() =>
            void act(async () => {
              await command({ type: "model-select", mode: "service" });
            })
          }
        >
          {info?.mode !== "direct" ? (
            <Check size={15} />
          ) : (
            <PlugZap size={15} />
          )}
          ycore 服务
        </button>
        <button
          aria-pressed={info?.mode === "direct"}
          disabled={busy}
          onClick={useDirect}
        >
          {info?.mode === "direct" ? (
            <Check size={15} />
          ) : (
            <PlugZap size={15} />
          )}
          自带 API
        </button>
      </div>
      <p>
        {info?.label ?? "ycore 共享模型"}
        {info?.testedAt
          ? ` · 测试于 ${new Date(info.testedAt).toLocaleTimeString()}`
          : ""}
      </p>
      <p className="muted">
        模型测试会发送一条固定短消息，可能产生用量，不携带工作资料。
      </p>
      <button
        className="quiet"
        disabled={busy}
        onClick={() => {
          setProfile(info?.direct ?? empty);
          setToken("");
          setNoKey(false);
          setEditing(!editing);
        }}
      >
        {editing ? "收起配置" : info?.direct ? "编辑自带 API" : "配置自带 API"}
      </button>
      {editing ? (
        <form
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
          <label className="model-no-key">
            <input
              type="checkbox"
              checked={noKey}
              onChange={(e) => setNoKey(e.target.checked)}
              disabled={busy}
            />
            此接口无需 API Key
          </label>
          <details>
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
          <p className="muted">
            当前支持 Chat Completions
            文本流。联网检索、图片和工具能力需另行接入；中断后不自动重发。信息来源连接单独保留。
          </p>
          <button className="primary" disabled={busy}>
            {busy ? "正在保存…" : "保存并选用"}
          </button>
        </form>
      ) : null}
      {info?.error ? <p role="status">{info.error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
    </section>
  );
}
