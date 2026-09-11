import { useState } from "react";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  FolderOpen,
  KeyRound,
  LoaderCircle,
  Plus,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react";
import {
  MEMBERS,
  type AppSettings,
  type ModelProfile,
  type Snapshot,
} from "../shared/types";
import { type Dispatch, formatDate } from "./common";

const PROVIDERS: Record<
  ModelProfile["provider"],
  {
    name: string;
    protocol: ModelProfile["protocol"];
    baseURL: string;
    keyEnv: string;
  }
> = {
  gemini: {
    name: "Google Gemini",
    protocol: "google",
    baseURL: "https://generativelanguage.googleapis.com/v1beta",
    keyEnv: "GEMINI_API_KEY",
  },
  deepseek: {
    name: "DeepSeek",
    protocol: "openai",
    baseURL: "https://api.deepseek.com",
    keyEnv: "DEEPSEEK_API_KEY",
  },
  ark: {
    name: "火山方舟 Ark",
    protocol: "openai",
    baseURL: "https://ark.cn-beijing.volces.com/api/v3",
    keyEnv: "ARK_API_KEY",
  },
  compatible: {
    name: "OpenAI 兼容服务",
    protocol: "openai",
    baseURL: "",
    keyEnv: "",
  },
};
const PROFILE_STATUS: Record<ModelProfile["status"], string> = {
  ready: "已验证",
  untested: "待验证",
  unconfigured: "待配置",
  failed: "连接异常",
};

function ProfileEditor({
  original,
  dispatch,
  onSaved,
  connected,
}: {
  original?: ModelProfile;
  dispatch: Dispatch;
  onSaved: (id: string) => void;
  connected: boolean;
}) {
  const [profile, setProfile] = useState<ModelProfile>(() =>
    original
      ? { ...original }
      : {
          id: crypto.randomUUID(),
          name: "",
          provider: "gemini",
          protocol: "google",
          baseURL: PROVIDERS.gemini.baseURL,
          modelId: "",
          apiKeyEnv: PROVIDERS.gemini.keyEnv,
          hasKey: false,
          status: "unconfigured",
        },
  );
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [saved, setSaved] = useState(false);
  const updateProfile = (patch: Partial<ModelProfile>) => {
    setProfile((current) => ({ ...current, ...patch }));
    setSaved(false);
  };
  const changeProvider = (provider: ModelProfile["provider"]) => {
    setProfile({
      ...profile,
      provider,
      protocol: PROVIDERS[provider].protocol,
      baseURL: PROVIDERS[provider].baseURL,
      apiKeyEnv: PROVIDERS[provider].keyEnv,
      modelId: "",
      status: "untested",
    });
    setSaved(false);
  };
  const save = async (probe: boolean) => {
    setSaving(true);
    setSaved(false);
    const result = await dispatch({
      type: "profile.save",
      profile,
      ...(key ? { apiKey: key } : {}),
    });
    setSaving(false);
    if (!result) return;
    setKey("");
    setSaved(true);
    if (probe) {
      setProbing(true);
      await dispatch({ type: "profile.probe", profileId: profile.id });
      setProbing(false);
    }
    onSaved(profile.id);
  };
  return (
    <form
      className="profile-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save(false);
      }}
    >
      <div className="section-heading">
        <div>
          <span className="eyebrow">MODEL CONNECTION</span>
          <h3>{original ? "配置连接" : "添加模型连接"}</h3>
        </div>
        {original ? (
          <span className={`status-badge profile-${original.status}`}>
            {PROFILE_STATUS[original.status]}
          </span>
        ) : null}
      </div>
      <div className="form-grid">
        <label className="field">
          连接名称
          <input
            required
            value={profile.name}
            onChange={(event) => {
              setProfile({ ...profile, name: event.target.value });
              setSaved(false);
            }}
            placeholder="例如：日常研究"
            disabled={!connected}
          />
        </label>
        <label className="field">
          服务商
          <select
            value={profile.provider}
            onChange={(event) =>
              changeProvider(event.target.value as ModelProfile["provider"])
            }
            disabled={!connected}
          >
            {Object.entries(PROVIDERS).map(([id, provider]) => (
              <option value={id} key={id}>
                {provider.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        模型 ID
        <input
          required
          value={profile.modelId}
          onChange={(event) => updateProfile({ modelId: event.target.value })}
          placeholder={
            profile.provider === "ark"
              ? "模型名称或推理接入点 ID"
              : "填写服务商提供的模型 ID"
          }
          disabled={!connected}
        />
      </label>
      <label className="field">
        API 地址
        <input
          type="url"
          required
          value={profile.baseURL}
          onChange={(event) => updateProfile({ baseURL: event.target.value })}
          placeholder="https://…"
          disabled={!connected}
        />
      </label>
      <div className="form-grid">
        <label className="field">
          调用协议
          <select
            value={profile.protocol}
            onChange={(event) =>
              updateProfile({
                protocol: event.target.value as ModelProfile["protocol"],
              })
            }
            disabled={!connected || profile.provider !== "compatible"}
          >
            <option value="google">Google 原生</option>
            <option value="openai">OpenAI 兼容</option>
          </select>
        </label>
        <label className="field">
          密钥环境变量
          <input
            value={profile.apiKeyEnv}
            onChange={(event) =>
              updateProfile({ apiKeyEnv: event.target.value })
            }
            placeholder="例如 GEMINI_API_KEY"
            autoCapitalize="off"
            spellCheck={false}
            disabled={!connected}
          />
        </label>
      </div>
      <label className="field">
        临时输入密钥 <span className="optional">可选</span>
        <div className="input-with-icon">
          <KeyRound size={15} />
          <input
            type="password"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder={
              original?.hasKey ? "已有密钥；留空保留" : "也可以通过环境变量提供"
            }
            autoComplete="new-password"
            disabled={!connected}
          />
        </div>
        <span className="field-hint">
          已有密钥不会回显到界面；保存后清空本次输入。
        </span>
      </label>
      {original?.capabilities ? (
        <div className="capabilities">
          {(
            [
              ["text", "文本"],
              ["tools", "工具调用"],
              ["streaming", "流式响应"],
            ] as const
          ).map(([id, name]) => (
            <span
              className={original.capabilities?.[id] ? "verified" : ""}
              key={id}
            >
              {original.capabilities?.[id] ? (
                <Check size={12} />
              ) : (
                <CircleHelp size={12} />
              )}
              {name}
            </span>
          ))}
        </div>
      ) : null}
      {original?.lastError ? (
        <div className="inline-notice warning">{original.lastError}</div>
      ) : null}
      <div className="form-actions">
        <button
          className="button primary"
          disabled={!connected || saving || probing}
          type="submit"
        >
          {saving ? (
            <LoaderCircle size={14} className="spin" />
          ) : saved ? (
            <Check size={14} />
          ) : null}
          {saving ? "正在保存" : saved ? "已保存" : "保存连接"}
        </button>
        <button
          className="button secondary"
          type="button"
          disabled={
            !connected ||
            saving ||
            probing ||
            !profile.name.trim() ||
            !profile.modelId.trim() ||
            !profile.baseURL.trim()
          }
          onClick={() => void save(true)}
        >
          {probing ? (
            <LoaderCircle size={14} className="spin" />
          ) : (
            <RefreshCw size={14} />
          )}
          {probing ? "正在验证能力" : "保存并验证"}
        </button>
        {original?.testedAt ? (
          <span className="muted small-text">
            验证于 {formatDate(original.testedAt)}
          </span>
        ) : null}
      </div>
    </form>
  );
}

function EnvironmentSettings({
  snapshot,
  dispatch,
}: {
  snapshot: Snapshot;
  dispatch: Dispatch;
}) {
  const [settings, setSettings] = useState<AppSettings>(() => ({
    ...snapshot.settings,
    memberProfiles: { ...snapshot.settings.memberProfiles },
  }));
  const [saving, setSaving] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(false);
  const system = snapshot.system;
  const save = async () => {
    setSaving(true);
    await dispatch({ type: "settings.save", settings });
    setSaving(false);
  };
  const bootstrap = async () => {
    setBootstrapping(true);
    const result = await dispatch({ type: "settings.save", settings });
    if (result) await dispatch({ type: "system.bootstrap" });
    setBootstrapping(false);
  };
  return (
    <div className="environment-settings">
      <section className="settings-section">
        <div className="section-heading">
          <div>
            <span className="eyebrow">LOCAL WORKSPACE</span>
            <h3>你的本机工作环境</h3>
          </div>
          <FolderOpen size={22} strokeWidth={1.4} />
        </div>
        <p className="section-description">
          知识、规则与项目各有归属。识别已有环境，也可以为新电脑建立起点。
        </p>
        <div className="form-grid">
          <label className="field">
            AI 根目录
            <input
              value={settings.aiRoot}
              onChange={(event) =>
                setSettings({ ...settings, aiRoot: event.target.value })
              }
              placeholder="AI 规则、知识与资源所在路径"
            />
          </label>
          <label className="field">
            Code 根目录
            <input
              value={settings.codeRoot}
              onChange={(event) =>
                setSettings({ ...settings, codeRoot: event.target.value })
              }
              placeholder="项目所在路径"
            />
          </label>
        </div>
        <label className="field">
          工作资料目录
          <input
            value={settings.workspaceRoot}
            onChange={(event) =>
              setSettings({ ...settings, workspaceRoot: event.target.value })
            }
            placeholder="工作台资料与成果的保存路径"
          />
        </label>
      </section>
      <section className="settings-section">
        <div className="section-heading">
          <h3>环境识别</h3>
          <span
            className={`status-badge ${system.state === "ready" ? "profile-ready" : "profile-untested"}`}
          >
            {
              {
                ready: "已就绪",
                missing: "尚未建立",
                incomplete: "需要补齐",
                conflict: "存在冲突",
              }[system.state]
            }
          </span>
        </div>
        {system.issues.length ? (
          <ul className="system-issues">
            {system.issues.map((issue, index) => (
              <li key={`${issue.code}-${index}`}>
                <span className="issue-marker" />
                <div>
                  <p>{issue.message}</p>
                  {issue.path ? <code>{issue.path}</code> : null}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="verified-note">
            <CheckCircle2 size={16} />
            已识别规则与项目目录。
          </p>
        )}
        <div className="form-actions">
          <button
            className="button secondary"
            type="button"
            disabled={bootstrapping}
            onClick={() => void bootstrap()}
          >
            {bootstrapping ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <Plus size={15} />
            )}
            {bootstrapping
              ? "正在建立环境"
              : system.state === "ready"
                ? "检查并补齐规则"
                : "建立本机规则体系"}
          </button>
          {system.policyPath ? (
            <button
              className="text-button"
              onClick={() =>
                void dispatch({ type: "path.reveal", path: system.policyPath })
              }
            >
              查看规则
              <ChevronRight size={13} />
            </button>
          ) : null}
        </div>
        <p className="field-hint">
          在所选位置建立缺失的目录和规则，保留已有内容。冲突会明确列出。
        </p>
      </section>
      <section className="settings-section">
        <div className="section-heading">
          <h3>团队使用的模型</h3>
          <SlidersHorizontal size={18} />
        </div>
        <p className="section-description">
          成员使用各自的默认连接；开展某项工作时，也可以临时指定。
        </p>
        <label className="field">
          工作台默认连接
          <select
            value={settings.defaultProfileId}
            onChange={(event) =>
              setSettings({ ...settings, defaultProfileId: event.target.value })
            }
          >
            <option value="">尚未指定</option>
            {snapshot.profiles.map((profile) => (
              <option value={profile.id} key={profile.id}>
                {profile.name} · {PROFILE_STATUS[profile.status]}
              </option>
            ))}
          </select>
        </label>
        <div className="member-configs">
          {MEMBERS.map((member) => (
            <label className="member-config" key={member.id}>
              <div>
                <strong>{member.shortName}</strong>
                <span>{member.description}</span>
              </div>
              <select
                aria-label={`${member.shortName}的默认模型`}
                value={settings.memberProfiles[member.id] ?? ""}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    memberProfiles: {
                      ...settings.memberProfiles,
                      [member.id]: event.target.value,
                    },
                  })
                }
              >
                <option value="">跟随工作台默认</option>
                {snapshot.profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </section>
      <div className="form-actions">
        <button
          className="button primary"
          onClick={() => void save()}
          disabled={saving}
        >
          {saving ? "正在保存" : "保存环境与团队设置"}
          <ArrowRight size={14} />
        </button>
        <span className="small-text muted">下次工作使用更新后的配置</span>
      </div>
      <div className="settings-storage">
        工作台数据 <code>{snapshot.dataPath}</code>
      </div>
    </div>
  );
}

export function Settings({
  snapshot,
  dispatch,
  connected,
}: {
  snapshot: Snapshot | null;
  dispatch: Dispatch;
  connected: boolean;
}) {
  const [tab, setTab] = useState<"models" | "environment">("models");
  const [selected, setSelected] = useState<string | null>(
    snapshot?.profiles[0]?.id ?? null,
  );
  const original = snapshot?.profiles.find(
    (profile) => profile.id === selected,
  );
  return (
    <div className="settings-page">
      <div className="page-heading">
        <span className="eyebrow">PREFERENCES</span>
        <h1>把工作台准备好</h1>
        <p>连接你的模型，找到本机资料，让团队开始工作。</p>
      </div>
      <div className="page-tabs">
        <button
          className={tab === "models" ? "active" : ""}
          onClick={() => setTab("models")}
        >
          模型连接
        </button>
        <button
          className={tab === "environment" ? "active" : ""}
          onClick={() => setTab("environment")}
        >
          本机环境与团队
        </button>
      </div>
      {tab === "models" ? (
        <div className="models-layout">
          <aside className="profile-list">
            {snapshot?.profiles.map((profile) => (
              <button
                className={`profile-item ${profile.id === selected ? "active" : ""}`}
                key={profile.id}
                onClick={() => setSelected(profile.id)}
              >
                <span className={`provider-mark ${profile.provider}`}>
                  {profile.provider === "gemini"
                    ? "G"
                    : profile.provider === "deepseek"
                      ? "D"
                      : profile.provider === "ark"
                        ? "A"
                        : "↗"}
                </span>
                <span>
                  <strong>{profile.name}</strong>
                  <small>{PROFILE_STATUS[profile.status]}</small>
                </span>
                <ChevronRight size={14} />
              </button>
            ))}
            <button
              className={`add-profile ${selected === null ? "active" : ""}`}
              onClick={() => setSelected(null)}
            >
              <Plus size={15} />
              添加模型连接
            </button>
            <p className="profile-note">
              有密钥不代表已验证。
              <br />
              请测试文本与工具调用能力。
            </p>
          </aside>
          <ProfileEditor
            key={original?.id ?? "new"}
            original={original}
            dispatch={dispatch}
            onSaved={setSelected}
            connected={connected}
          />
        </div>
      ) : snapshot ? (
        <EnvironmentSettings snapshot={snapshot} dispatch={dispatch} />
      ) : (
        <div className="section-empty">
          <FolderOpen size={30} strokeWidth={1.3} />
          <h3>桌面连接后读取本机环境</h3>
          <p>浏览器布局预览无法发现本机规则与路径。</p>
        </div>
      )}
    </div>
  );
}
