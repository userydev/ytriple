import { useRef, useState } from "react";
import { KeyRound, LogIn, LogOut, RefreshCw } from "lucide-react";
import type { Snapshot } from "../core/types";
import { command } from "./api";
import { Dialog } from "./Dialog";
import "./settings-account.css";

export function AccountSettings({
  data,
  onError,
}: {
  data: Snapshot;
  onError: (e: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const lock = useRef(false);
  const info = data.service.account;
  const signedIn = info?.state === "signed_in";
  const email = info?.email ?? "已登录账号";
  async function act(fn: () => Promise<unknown>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError(e);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="settings-page account-settings">
      <div className="settings-section">
        <div className="settings-section-header">
          <div>
            <h2>账号</h2>
            <p>管理当前工作空间使用的服务账号。</p>
          </div>
        </div>
        {signedIn ? (
          <>
            <div className="account-identity">
              <div className="account-avatar" aria-hidden="true">
                {email.slice(0, 1).toUpperCase()}
              </div>
              <div className="account-meta">
                <strong>{email}</strong>
                <span>当前工作空间账号</span>
              </div>
            </div>
            <div className="setting-row">
              <div className="setting-copy">
                <strong>登录状态</strong>
                <small>账号凭据只用于当前工作空间。</small>
              </div>
              <span className="status-badge success">已登录</span>
            </div>
            <div className="setting-row">
              <div className="setting-copy">
                <strong>服务连接</strong>
                <small>{data.service.baseUrl}</small>
              </div>
              <span
                className={`status-badge ${data.service.connected ? "success" : "warning"}`}
              >
                {data.service.connected ? "已连接" : "未连接"}
              </span>
            </div>
            <div className="settings-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => void act(() => command({ type: "connect" }))}
              >
                <RefreshCw size={16} />
                {busy ? "正在检查…" : "检查服务连接"}
              </button>
              <button
                type="button"
                className="quiet danger-action"
                disabled={busy}
                onClick={() => setConfirmingSignOut(true)}
              >
                <LogOut size={16} />
                退出登录
              </button>
            </div>
          </>
        ) : (
          <form
            className="settings-form"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const fields = new FormData(form);
              const password = String(fields.get("password"));
              (form.elements.namedItem("password") as HTMLInputElement).value =
                "";
              void act(() =>
                command({
                  type: "account-sign-in",
                  baseUrl: String(fields.get("baseUrl")),
                  email: String(fields.get("email")),
                  password,
                }),
              );
            }}
          >
            <div className="settings-note">
              <strong>尚未登录</strong>
              <span>
                使用已有服务账号登录。登录不会上传本地 AI、Code 目录或成果。
              </span>
            </div>
            <fieldset disabled={busy}>
              <label>
                邮箱
                <input
                  name="email"
                  type="email"
                  autoComplete="username"
                  required
                  maxLength={320}
                />
              </label>
              <label>
                密码
                <input
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  maxLength={4096}
                />
              </label>
              <details className="advanced-settings">
                <summary>高级服务设置</summary>
                <label>
                  服务地址
                  <input
                    name="baseUrl"
                    type="url"
                    defaultValue={data.service.baseUrl}
                    required
                  />
                </label>
              </details>
              <button className="primary" type="submit">
                <LogIn size={16} />
                {busy ? "正在登录…" : "登录"}
              </button>
            </fieldset>
          </form>
        )}
        {info?.error || data.service.error ? (
          <div role="status" className="settings-note error-note">
            {info?.error ?? data.service.error}
          </div>
        ) : null}
      </div>
      {!signedIn ? (
        <details className="settings-section advanced-settings">
          <summary>
            <KeyRound size={17} /> 高级：使用访问令牌
          </summary>
          <form
            className="settings-form"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const fields = new FormData(form);
              const token = String(fields.get("token"));
              (form.elements.namedItem("token") as HTMLInputElement).value = "";
              void act(() =>
                command({
                  type: "configure",
                  baseUrl: String(fields.get("baseUrl")),
                  token,
                }),
              );
            }}
          >
            <p className="settings-note">
              仅在已有独立客户端令牌时使用。凭据保存在本机安全存储。
            </p>
            <fieldset disabled={busy}>
              <label>
                服务地址
                <input
                  name="baseUrl"
                  defaultValue={data.service.baseUrl}
                  type="url"
                  required
                />
              </label>
              <label>
                访问令牌
                <input
                  name="token"
                  type="password"
                  autoComplete="off"
                  required
                />
              </label>
              <button type="submit">连接并保存</button>
            </fieldset>
          </form>
        </details>
      ) : null}
      {confirmingSignOut ? (
        <Dialog title="退出账号？" onClose={() => setConfirmingSignOut(false)}>
          <p>退出后，此工作空间将无法继续使用账号服务，直到重新登录。</p>
          <div className="dialog-actions">
            <button type="button" onClick={() => setConfirmingSignOut(false)}>
              取消
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await command({ type: "account-sign-out" });
                  setConfirmingSignOut(false);
                })
              }
            >
              {busy ? "正在退出…" : "确认退出"}
            </button>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}
