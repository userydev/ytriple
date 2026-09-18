import { useEffect, useState } from "react";
import { Check, FolderCog, RefreshCw } from "lucide-react";
import type { Snapshot } from "../core/types";
import type { LocalSystemPlan, LocalSystemStatus } from "../core/local-system";
import { command } from "./api";
import { Dialog } from "./Dialog";
export function LocalSystemSetup({ data }: { data: Snapshot }) {
  const [status, setStatus] = useState<LocalSystemStatus | null>(null),
    [plan, setPlan] = useState<LocalSystemPlan | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [approved, setApproved] = useState(false),
    [file, setFile] = useState("");
  const configured = !!data.localRoots.aiPath && !!data.localRoots.codePath;
  const fail = (e: unknown) =>
    setError(e instanceof Error ? e.message : String(e));
  useEffect(() => {
    let current = true;
    setStatus(null);
    setPlan(null);
    setError("");
    if (configured)
      void command<LocalSystemStatus>({ type: "inspect-local-system" })
        .then((s) => {
          if (current) setStatus(s);
        })
        .catch((e) => {
          if (current) fail(e);
        });
    return () => {
      current = false;
    };
  }, [data.localRoots.aiPath, data.localRoots.codePath]);
  async function inspect() {
    setBusy(true);
    setError("");
    try {
      setStatus(
        await command<LocalSystemStatus>({ type: "inspect-local-system" }),
      );
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  async function preview() {
    if (busy) return;
    setBusy(true);
    setError("");
    setApproved(false);
    try {
      const p =
        status?.plan && ["running", "failed"].includes(status.plan.status)
          ? status.plan
          : await command<LocalSystemPlan>({ type: "preview-local-system" });
      setPlan(p);
      setFile(Object.keys(p.files)[0]);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  async function execute() {
    if (!plan || busy || !approved) return;
    setBusy(true);
    setError("");
    try {
      setPlan(
        await command<LocalSystemPlan>({
          type: "execute-local-system",
          planId: plan.id,
        }),
      );
      setStatus(
        await command<LocalSystemStatus>({ type: "inspect-local-system" }),
      );
    } catch (e) {
      fail(e);
      try {
        const s = await command<LocalSystemStatus>({
          type: "inspect-local-system",
        });
        setStatus(s);
        if (s.plan) setPlan(s.plan);
      } catch {
        /* Keep the action error. */
      }
    } finally {
      setBusy(false);
      setApproved(false);
    }
  }
  return (
    <section className="local-system-setup settings-section">
      <div className="settings-section-header">
        <div>
          <h2>本机项目规则</h2>
          <p>检查 AI 与 Code 目录是否具备统一的基础约定。</p>
        </div>
        <button
          className="quiet"
          disabled={busy || !configured}
          onClick={() => void inspect()}
        >
          <RefreshCw size={17} />
          重新检查
        </button>
      </div>
      <div className="setting-row">
        <div className="setting-copy">
          <strong>初始化状态</strong>
          <small>
            {!configured
              ? "先选择 AI 与 Code 目录"
              : (status?.message ??
                (error ? "检查未完成，请查看说明" : "正在检查…"))}
          </small>
        </div>
        <span
          className={`status-badge ${status?.state === "ready" ? "success" : ""}`}
        >
          {!configured
            ? "待配置"
            : status?.state === "ready"
              ? "已就绪"
              : "未完成"}
        </span>
        {configured && status?.state !== "ready" ? (
          <div className="settings-actions">
            <button
              className="quiet"
              disabled={busy}
              onClick={() => void preview()}
            >
              <FolderCog size={17} />
              {status?.plan &&
              ["running", "failed"].includes(status.plan.status)
                ? "继续初始化"
                : "查看并初始化"}
            </button>
          </div>
        ) : null}
      </div>
      {status?.state === "ready" ? (
        <p className="settings-note">
          <Check size={15} />
          沿用本机已有规则和项目登记。
        </p>
      ) : null}
      {!plan && error ? <p role="alert">{error}</p> : null}
      {plan ? (
        <Dialog
          title="建立本机项目规则"
          onClose={() => {
            if (!busy) setPlan(null);
          }}
        >
          <p>
            AI 管理可复用资产，Code
            管理项目。现有项目与资产留在原处；有内容冲突时停止并保留现状。
          </p>
          <p className="local-path">
            AI：{plan.aiRoot}
            <br />
            Code：{plan.codeRoot}
          </p>
          <p className="settings-note">
            将建立 {plan.directories.length} 个目录、
            {Object.keys(plan.files).length} 个规则文件和{" "}
            {Object.keys(plan.links).length} 个规则入口。
          </p>
          <details>
            <summary>查看规则文件内容</summary>
            <label>
              规则文件
              <select
                aria-label="预览基础规则文件"
                value={file}
                onChange={(e) => setFile(e.target.value)}
              >
                {Object.keys(plan.files).map((path) => (
                  <option key={path}>{path}</option>
                ))}
              </select>
            </label>
            <pre className="suggestion-preview">{plan.files[file]}</pre>
          </details>
          <details>
            <summary>完整文件夹与规则入口</summary>
            <ul>
              {plan.directories.map((path) => (
                <li className="local-path" key={path}>
                  {path}
                </li>
              ))}
              {Object.entries(plan.links).map(([path, target]) => (
                <li className="local-path" key={path}>
                  {path} → {target}
                </li>
              ))}
            </ul>
          </details>
          <p className="muted">
            两个根目录的 AGENTS.md 都将指向
            AI/system/POLICY.md，作为开发工具读取的基础约定。已有项目规则需单独核对；不自动迁移项目。
          </p>
          {error ? <p role="alert">{error}</p> : null}
          {plan.status === "complete" ? (
            <p role="status">
              基础规则与项目登记目录已建立，可以继续初始化项目。
            </p>
          ) : (
            <>
              {plan.status === "failed" ? (
                <p role="status">
                  上次建立未完成：{plan.error}。已有文件会先核对，再继续。
                </p>
              ) : null}
              <label className="initialization-approval">
                <input
                  type="checkbox"
                  checked={approved}
                  disabled={busy}
                  onChange={(e) => setApproved(e.target.checked)}
                />
                采用这些基础规则，并建立所列目录、文件和两个规则入口。
              </label>
              <button
                disabled={busy || !approved}
                onClick={() => void execute()}
              >
                <FolderCog size={17} />
                {busy
                  ? "正在建立并核对…"
                  : plan.status === "preview"
                    ? "建立基础规则"
                    : "检查并继续原计划"}
              </button>
            </>
          )}
        </Dialog>
      ) : null}
    </section>
  );
}
