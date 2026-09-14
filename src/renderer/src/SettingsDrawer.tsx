import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Cpu,
  KeyRound,
  LoaderCircle,
  Monitor,
  Network,
  Plus,
  Server,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from "lucide-react";
import type {
  AppSettings,
  ConnectionView,
  SettingsView,
} from "../../shared/contracts";
import { DEFAULT_SETTINGS } from "../../shared/defaults";
import { errorText } from "./common";
import "./SettingsDrawer.css";

function editableSettings(value: AppSettings): AppSettings {
  return structuredClone({
    version: value.version,
    strategy: value.strategy,
    provider: value.provider,
    team: value.team,
    skills: value.skills,
    limits: value.limits,
  });
}
type Tab = "connection" | "team" | "method";
type Props = {
  settings?: SettingsView;
  connection?: ConnectionView;
  onClose(): void;
  onSaved(value: SettingsView): void;
  onBeforeConnect(): Promise<void>;
  onConnected(): Promise<void>;
  onError(error: unknown): void;
};

export function SettingsDrawer({
  settings,
  connection,
  onClose,
  onSaved,
  onBeforeConnect,
  onConnected,
  onError,
}: Props) {
  const [config, setConfig] = useState<AppSettings>(() =>
    editableSettings(settings ?? DEFAULT_SETTINGS),
  );
  const [mode, setMode] = useState<"server" | "local">(
    connection?.mode ?? "server",
  );
  const [url, setUrl] = useState(connection?.serverUrl ?? "");
  const [token, setToken] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState("");
  const [tab, setTab] = useState<Tab>("connection");
  const [connectionFeedback, setConnectionFeedback] = useState<{
    kind: "success" | "error";
    text: string;
  }>();
  const [settingsFeedback, setSettingsFeedback] = useState<{
    kind: "success" | "error";
    text: string;
  }>();
  const [testFeedback, setTestFeedback] = useState<{
    kind: "success" | "error";
    text: string;
  }>();
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    closeButton.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  useEffect(() => {
    if (settings) setConfig(editableSettings(settings));
  }, [settings]);
  useEffect(() => {
    if (connection) {
      setMode(connection.mode);
      setUrl(connection.serverUrl);
    }
  }, [connection]);
  function fail(
    error: unknown,
    setFeedback: (value: { kind: "error"; text: string }) => void,
  ) {
    const text = errorText(error);
    setFeedback({ kind: "error", text });
    onError(error);
  }
  async function connect() {
    setBusy("connect");
    setConnectionFeedback(undefined);
    try {
      await onBeforeConnect();
      await window.ytriple.saveConnection({
        mode,
        serverUrl: url.trim(),
        ...(token ? { token } : {}),
      });
      await onConnected();
      setToken("");
      setConnectionFeedback({
        kind: "success",
        text: "已保存并连接；工作列表已切换到所选执行位置。",
      });
    } catch (error) {
      fail(error, (value) => setConnectionFeedback(value));
    } finally {
      setBusy("");
    }
  }
  async function save() {
    setBusy("save");
    setSettingsFeedback(undefined);
    try {
      const value = await window.ytriple.saveSettings({
        settings: config,
        ...(!settings?.providerManaged && key ? { apiKey: key } : {}),
      });
      onSaved(value);
      setKey("");
      setSettingsFeedback({
        kind: "success",
        text: "已保存，从下一轮工作开始使用；历史轮次保留当时的配置。",
      });
    } catch (error) {
      fail(error, (value) => setSettingsFeedback(value));
    } finally {
      setBusy("");
    }
  }
  async function test() {
    setBusy("test");
    setTestFeedback(undefined);
    try {
      const result = await window.ytriple.testProvider();
      setTestFeedback({
        kind: result.ok ? "success" : "error",
        text: result.message,
      });
    } catch (error) {
      fail(error, (value) => setTestFeedback(value));
    } finally {
      setBusy("");
    }
  }
  function updateMember(id: string, patch: Record<string, string | undefined>) {
    setConfig((value) => ({
      ...value,
      team: {
        ...value.team,
        members: value.team.members.map((member) =>
          member.id === id ? { ...member, ...patch } : member,
        ),
      },
    }));
  }
  const feedback = (value?: { kind: "success" | "error"; text: string }) =>
    value ? (
      <p
        className={`settings-feedback ${value.kind}`}
        role={value.kind === "error" ? "alert" : "status"}
      >
        {value.text}
      </p>
    ) : null;
  return (
    <div
      className="drawer-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        className="settings-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) onClose();
          if (event.key === "Tab") {
            const elements = [
              ...event.currentTarget.querySelectorAll<HTMLElement>(
                "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary",
              ),
            ].filter((node) => node.offsetParent !== null);
            const first = elements[0];
            const last = elements.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header className="drawer-header">
          <div>
            <span className="settings-kicker">工作空间设置</span>
            <h2 id="settings-title">团队与能力</h2>
          </div>
          <button
            ref={closeButton}
            className="icon-button"
            onClick={onClose}
            disabled={!!busy}
            aria-label="关闭设置"
          >
            <X size={20} />
          </button>
        </header>
        <nav className="settings-tabs" aria-label="设置分组" role="tablist">
          {(
            [
              ["connection", "连接"],
              ["team", "团队"],
              ["method", "方法与用量"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? "settings-tab active" : "settings-tab"}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="drawer-body">
          {tab === "connection" ? (
            <section className="settings-section" role="tabpanel">
              <div className="section-label">
                <Network size={18} />
                <div>
                  <h3>连接</h3>
                  <p>先确认当前执行位置，再保存连接信息。</p>
                </div>
              </div>
              <div className="choice-grid">
                <button
                  type="button"
                  className={mode === "server" ? "choice selected" : "choice"}
                  onClick={() => setMode("server")}
                >
                  <Server size={21} />
                  <strong>服务器</strong>
                  <small>统一提供模型与工作服务</small>
                  {mode === "server" ? <Check size={15} /> : null}
                </button>
                <button
                  type="button"
                  className={mode === "local" ? "choice selected" : "choice"}
                  onClick={() => setMode("local")}
                >
                  <Monitor size={21} />
                  <strong>本机独立</strong>
                  <small>数据与执行留在本机</small>
                  {mode === "local" ? <Check size={15} /> : null}
                </button>
              </div>
              {mode === "server" ? (
                <>
                  <label>
                    服务器地址
                    <input
                      aria-label="服务器地址"
                      value={url}
                      onChange={(event) => setUrl(event.target.value)}
                      placeholder="https://your-server.example"
                      spellCheck={false}
                      autoCapitalize="off"
                    />
                    <span className="field-note">
                      本地开发服务可以使用回环地址。
                    </span>
                  </label>
                  <label>
                    连接令牌
                    <input
                      aria-label="连接令牌"
                      type="password"
                      value={token}
                      onChange={(event) => setToken(event.target.value)}
                      autoComplete="off"
                      placeholder={
                        connection?.configured
                          ? "已有令牌不会显示；留空保留现有凭据"
                          : "由服务管理员提供"
                      }
                    />
                  </label>
                </>
              ) : (
                <p className="inline-note">
                  <Monitor size={16} />
                  本机模式的数据与服务器工作空间分开保存，需要本机模型凭据。
                </p>
              )}
              {settings ? (
                <div className="connection-provider-status">
                  <strong>当前模型状态</strong>
                  <span>
                    {settings.provider.model || "尚未设置模型"} ·{" "}
                    {settings.credential.configured
                      ? "凭据已配置"
                      : "尚未配置凭据"}
                  </span>
                  <small>模型与凭据的详细编辑位于“方法与用量”。</small>
                </div>
              ) : null}
              {feedback(connectionFeedback)}
              <button
                className="secondary-button"
                disabled={!!busy || (mode === "server" && !url.trim())}
                onClick={() => void connect()}
              >
                {busy === "connect" ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Network size={16} />
                )}
                保存并连接
              </button>
            </section>
          ) : null}
          {tab === "team" && settings ? (
            <section className="settings-section" role="tabpanel">
              <div className="section-label">
                <Users size={18} />
                <div>
                  <h3>团队</h3>
                  <p>角色定义责任，成员变化从下一轮工作开始生效。</p>
                </div>
                <span className="badge">team-v{config.team.version}</span>
              </div>
              {config.team.members.map((member, index) => (
                <details
                  className="member-setting"
                  key={member.id}
                  open={index === 0}
                >
                  <summary>
                    <span className={`avatar member-${index % 3}`}>
                      {member.name.slice(0, 1) || "?"}
                    </span>
                    <span>
                      <strong>{member.name || "未命名成员"}</strong>
                      <small>{member.role || "设置职责"}</small>
                    </span>
                    <ChevronDown size={15} />
                  </summary>
                  <div className="member-fields">
                    <div className="two-fields">
                      <label>
                        成员名称
                        <input
                          value={member.name}
                          onChange={(event) =>
                            updateMember(member.id, {
                              name: event.target.value,
                            })
                          }
                        />
                      </label>
                      <label>
                        角色职责
                        <input
                          value={member.role}
                          onChange={(event) =>
                            updateMember(member.id, {
                              role: event.target.value,
                            })
                          }
                        />
                      </label>
                    </div>
                    <label>
                      工作要求
                      <textarea
                        rows={3}
                        value={member.instructions}
                        onChange={(event) =>
                          updateMember(member.id, {
                            instructions: event.target.value,
                          })
                        }
                      />
                    </label>
                    {!settings.providerManaged ? (
                      <label>
                        成员模型覆盖（可选）
                        <input
                          value={member.model ?? ""}
                          onChange={(event) =>
                            updateMember(member.id, {
                              model: event.target.value || undefined,
                            })
                          }
                          placeholder="留空使用默认模型"
                        />
                      </label>
                    ) : null}
                    {member.id !== "lead" ? (
                      <button
                        type="button"
                        className="text-button danger"
                        disabled={config.team.members.length <= 2}
                        onClick={() =>
                          setConfig((value) => ({
                            ...value,
                            team: {
                              ...value.team,
                              members: value.team.members.filter(
                                (item) => item.id !== member.id,
                              ),
                            },
                          }))
                        }
                      >
                        <Trash2 size={14} />
                        移除成员
                      </button>
                    ) : (
                      <p className="field-note">
                        统筹成员保留为团队协调入口，可调整名称和职责。
                      </p>
                    )}
                  </div>
                </details>
              ))}
              <button
                type="button"
                className="text-button"
                disabled={config.team.members.length >= 6}
                onClick={() =>
                  setConfig((value) => ({
                    ...value,
                    team: {
                      ...value.team,
                      members: [
                        ...value.team.members,
                        {
                          id: `member-${crypto.randomUUID().slice(0, 8)}`,
                          name: "新成员",
                          role: "",
                          instructions: "",
                        },
                      ],
                    },
                  }))
                }
              >
                <Plus size={15} />
                添加成员
              </button>
              {feedback(settingsFeedback)}
            </section>
          ) : null}
          {tab === "method" && settings ? (
            <section className="settings-section" role="tabpanel">
              <div className="section-label">
                <Cpu size={18} />
                <div>
                  <h3>方法与用量</h3>
                  <p>启用的方法、版本与单轮资源限制。</p>
                </div>
              </div>
              <div className="method-provider">
                {settings.providerManaged ? (
                  <>
                    <ShieldCheck size={22} />
                    <div>
                      <strong>模型由服务器统一管理</strong>
                      <p>
                        {settings.provider.kind === "gemini"
                          ? "Google Gemini"
                          : "OpenAI 兼容"}{" "}
                        · {settings.provider.model || "尚未设置模型"}
                      </p>
                      <span>
                        {settings.credential.configured
                          ? "服务已配置模型凭据"
                          : "服务尚未配置模型凭据，请由管理员配置"}
                      </span>
                    </div>
                  </>
                ) : (
                  <>
                    <label>
                      提供方
                      <select
                        value={config.provider.kind}
                        onChange={(event) =>
                          setConfig((value) => ({
                            ...value,
                            provider: {
                              ...value.provider,
                              kind: event.target
                                .value as AppSettings["provider"]["kind"],
                            },
                          }))
                        }
                      >
                        <option value="gemini">Google Gemini 原生</option>
                        <option value="openai-compatible">
                          OpenAI 兼容服务
                        </option>
                      </select>
                    </label>
                    <label>
                      默认模型
                      <input
                        value={config.provider.model}
                        onChange={(event) =>
                          setConfig((value) => ({
                            ...value,
                            provider: {
                              ...value.provider,
                              model: event.target.value,
                            },
                          }))
                        }
                        placeholder="提供方的模型 ID"
                      />
                    </label>
                    {config.provider.kind === "openai-compatible" ? (
                      <label>
                        API 地址
                        <input
                          value={config.provider.baseUrl}
                          onChange={(event) =>
                            setConfig((value) => ({
                              ...value,
                              provider: {
                                ...value.provider,
                                baseUrl: event.target.value,
                              },
                            }))
                          }
                          placeholder="https://api.example.com/v1"
                          spellCheck={false}
                        />
                      </label>
                    ) : null}
                    <label>
                      API Key
                      <input
                        type="password"
                        value={key}
                        onChange={(event) => setKey(event.target.value)}
                        autoComplete="off"
                        placeholder={
                          settings.credential.configured
                            ? "已配置，留空保留现有凭据"
                            : "输入 API Key"
                        }
                      />
                    </label>
                    <p className="field-note">
                      <KeyRound size={13} />
                      凭据保存后不再显示，当前来源：
                      {settings.credential.source === "environment"
                        ? "运行环境"
                        : settings.credential.source === "encrypted"
                          ? "加密存储"
                          : "尚未配置"}
                      。
                    </p>
                  </>
                )}
              </div>
              {settings.providerManaged ? null : (
                <button
                  className="text-button"
                  disabled={!!busy || !settings.credential.configured}
                  onClick={() => void test()}
                >
                  {busy === "test" ? (
                    <LoaderCircle size={15} className="spin" />
                  ) : null}
                  测试已保存的模型连接
                </button>
              )}
              {settings.providerManaged ? (
                <button
                  className="text-button"
                  disabled={!!busy || !settings.credential.configured}
                  onClick={() => void test()}
                >
                  {busy === "test" ? (
                    <LoaderCircle size={15} className="spin" />
                  ) : null}
                  测试当前服务器模型连接
                </button>
              ) : null}
              {feedback(testFeedback)}
              <div className="skill-list">
                {config.skills.map((skill) => (
                  <label className="skill-setting" key={skill.id}>
                    <input
                      type="checkbox"
                      checked={skill.enabled}
                      onChange={(event) =>
                        setConfig((value) => ({
                          ...value,
                          skills: value.skills.map((item) =>
                            item.id === skill.id
                              ? { ...item, enabled: event.target.checked }
                              : item,
                          ),
                        }))
                      }
                    />
                    <span>
                      <strong>
                        {skill.name}
                        <small>v{skill.version}</small>
                      </strong>
                      <p>{skill.description}</p>
                      <small>
                        {skill.requires.length
                          ? `需要：${skill.requires.join("、")}`
                          : "方法型 Skill · 无外部依赖"}
                      </small>
                    </span>
                  </label>
                ))}
              </div>
              <details className="limits-details">
                <summary>高级运行限制</summary>
                <div className="two-fields">
                  {(
                    [
                      {
                        key: "maxCalls",
                        label: "最多模型调用",
                        min: 1,
                        max: 16,
                      },
                      {
                        key: "maxConcurrency",
                        label: "同时执行数",
                        min: 1,
                        max: 4,
                      },
                      {
                        key: "timeoutMs",
                        label: "超时（秒）",
                        min: 1,
                        max: 300,
                      },
                      {
                        key: "maxOutputTokens",
                        label: "单次输出 Token 上限",
                        min: 256,
                        max: 8192,
                      },
                    ] as const
                  ).map((field) => (
                    <label key={field.key}>
                      {field.label}
                      <input
                        type="number"
                        min={field.min}
                        max={field.max}
                        value={
                          field.key === "timeoutMs"
                            ? Math.round(config.limits.timeoutMs / 1000)
                            : config.limits[field.key]
                        }
                        onChange={(event) =>
                          setConfig((value) => ({
                            ...value,
                            limits: {
                              ...value.limits,
                              [field.key]:
                                field.key === "timeoutMs"
                                  ? Number(event.target.value) * 1000
                                  : Number(event.target.value),
                            },
                          }))
                        }
                      />
                    </label>
                  ))}
                </div>
                <p className="field-note">
                  限制约束一次工作的资源，不代表结果质量或完成比例。服务接口仍以毫秒保存超时。
                </p>
              </details>
              {feedback(settingsFeedback)}
              <p className="usage-summary">
                已记录用量只来自已完成或正在进行的工作；本轮过程会显示准确调用与
                Token 状态。
              </p>
              <p className="storage-note">
                工作数据位置：{settings.dataDirectory}
              </p>
            </section>
          ) : null}
          {!settings ? (
            <section className="settings-section">
              <p>
                连接成功后，可以查看服务的模型状态并配置团队、方法与运行限制。
              </p>
            </section>
          ) : null}
        </div>
        <footer className="drawer-footer">
          <div className="form-actions">
            <button
              className="secondary-button"
              onClick={onClose}
              disabled={!!busy}
            >
              完成
            </button>
            {settings && tab !== "connection" ? (
              <button
                className="primary-button"
                disabled={!!busy}
                onClick={() => void save()}
              >
                {busy === "save" ? (
                  <LoaderCircle size={16} className="spin" />
                ) : (
                  <Check size={16} />
                )}
                保存团队与能力
              </button>
            ) : null}
          </div>
        </footer>
      </section>
    </div>
  );
}
