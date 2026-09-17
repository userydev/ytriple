import { useRef, useState } from "react";
import { LogIn, LogOut, RefreshCw, KeyRound } from "lucide-react";
import type { Snapshot } from "../core/types";
import { command } from "./api";
import { IconButton } from "./Composer";

export function AccountSettings({
  data,
  onError,
}: {
  data: Snapshot;
  onError: (e: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const info = data.service.account;
  const signedIn = info?.state === "signed_in";
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
    <section className="account-settings">
      <div className="section-heading">
        <h2>账号与服务</h2>
        <div className="actions">
          <IconButton
            label="检查服务连接"
            disabled={busy || (!signedIn && !data.service.configured)}
            onClick={() => void act(() => command({ type: "connect" }))}
          >
            <RefreshCw size={18} />
          </IconButton>
          {signedIn ? (
            <IconButton
              label="退出当前工作空间的账号"
              disabled={busy}
              onClick={() =>
                void act(() => command({ type: "account-sign-out" }))
              }
            >
              <LogOut size={18} />
            </IconButton>
          ) : null}
        </div>
      </div>
      <p>
        服务账号仅用于当前工作空间。本地 AI、Code 目录及成果不会随登录上传。
      </p>
      {signedIn ? (
        <>
          <strong>{info.email ?? "已登录账号"}</strong>
          <p className="muted">
            {data.service.connected ? "服务已连接" : "账号已登录，服务尚未连接"}
          </p>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget,
              fields = new FormData(form);
            const password = String(fields.get("password"));
            const passwordInput = form.elements.namedItem(
              "password",
            ) as HTMLInputElement;
            passwordInput.value = "";
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
            <details>
              <summary>服务地址</summary>
              <label>
                ycore
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
            <small className="muted">使用已有服务账号登录。</small>
          </fieldset>
        </form>
      )}
      {info?.error || data.service.error ? (
        <p role="status" className="muted">
          {info?.error ?? data.service.error}
        </p>
      ) : null}
      {!signedIn ? (
        <details>
          <summary>
            <KeyRound size={16} /> 访问令牌连接
          </summary>
          <p className="muted">
            已有独立客户端令牌时使用。凭据只保存在本机安全存储。
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget,
                fields = new FormData(form);
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
              {data.service.connected ? <small>访问令牌已连接</small> : null}
            </fieldset>
          </form>
        </details>
      ) : null}
    </section>
  );
}
