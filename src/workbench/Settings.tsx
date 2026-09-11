import { useState } from "react";
import type {
  MemberSettings,
  MemberSettingsMap,
} from "../shared/member-settings";
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
  type MemberId,
} from "../shared/types";
import { type Dispatch, formatDate } from "./common";
import { GOOGLE_CATALOG } from "../shared/model-catalog";
import {
  normalizeTeamSettings,
  defaultMemberSettings,
  MEMBER_PROMPT_LIMIT,
} from "../shared/member-settings";

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
    keyEnv: "VOLCENGINE_ARK_API_KEY",
  },
  compatible: {
    name: "OpenAI 兼容服务",
    protocol: "openai",
    baseURL: "",
    keyEnv: "",
  },
};
export type SettingsSection = "models" | "team" | "environment";

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
  initial,
  onBusy,
}: {
  original?: ModelProfile;
  initial?: ModelProfile;
  onBusy?: (busy: boolean) => void;
  dispatch: Dispatch;
  onSaved: (id: string) => void;
  connected: boolean;
}) {
  const [profile, setProfile] = useState<ModelProfile>(() =>
    original || initial
      ? { ...(original ?? initial)! }
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
  const [dirty, setDirty] = useState(false);
  const updateProfile = (patch: Partial<ModelProfile>) => {
    setProfile((current) => ({ ...current, ...patch }));
    setSaved(false);
    setDirty(true);
  };
  const changeProvider = (provider: ModelProfile["provider"]) => {
    setKey("");
    setDirty(true);
    setProfile({
      ...profile,
      provider,
      protocol: PROVIDERS[provider].protocol,
      baseURL: PROVIDERS[provider].baseURL,
      apiKeyEnv: PROVIDERS[provider].keyEnv,
      modelId: "",
      execution: "model",
      status: "untested",
    });
    setSaved(false);
  };
  const save = async (probe: boolean) => {
    if (
      !connected ||
      saving ||
      probing ||
      !profile.name.trim() ||
      !profile.modelId.trim() ||
      (profile.protocol !== "google" && !profile.baseURL.trim())
    )
      return;
    setSaving(true);
    onBusy?.(true);
    setSaved(false);
    const result = await dispatch({
      type: "profile.save",
      profile,
      ...(key ? { apiKey: key } : {}),
    });
    setSaving(false);
    if (!result) {
      onBusy?.(false);
      return;
    }
    setKey("");
    setSaved(true);
    setDirty(false);
    if (probe) {
      setProbing(true);
      await dispatch({ type: "profile.probe", profileId: profile.id });
      setProbing(false);
    }
    onBusy?.(false);
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
      <fieldset
        className="settings-fieldset"
        disabled={!connected || saving || probing}
      >
        <div className="section-heading">
          <div>
            <span className="eyebrow">MODEL CONNECTION</span>
            <h3>{original ? "配置连接" : "添加模型连接"}</h3>
          </div>
          {original ? (
            <span className={`status-badge profile-${original.status}`}>
              {dirty ? "有未保存修改" : PROFILE_STATUS[original.status]}
            </span>
          ) : null}
        </div>
        <div className="form-grid">
          <label className="field">
            连接名称
            <input
              required
              value={profile.name}
              onInput={(event) => {
                updateProfile({ name: event.currentTarget.value });
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
                changeProvider(
                  event.currentTarget.value as ModelProfile["provider"],
                )
              }
              disabled={!connected || Boolean(original)}
            >
              {Object.entries(PROVIDERS).map(([id, provider]) => (
                <option value={id} key={id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {original ? (
          <p className="field-hint">添加其他服务商时，请建立新的连接。</p>
        ) : null}
        {profile.provider === "gemini" ? (
          <div className="google-catalog">
            <label className="field">
              Google 模型与专项 Agent
              <select
                aria-label="Google 模型目录"
                value={
                  GOOGLE_CATALOG.some((item) => item.id === profile.modelId)
                    ? profile.modelId
                    : ""
                }
                onChange={(event) => {
                  const item = GOOGLE_CATALOG.find(
                    (item) => item.id === event.currentTarget.value,
                  );
                  if (item)
                    updateProfile({
                      modelId: item.id,
                      execution: item.execution,
                      name: profile.name || item.name,
                    });
                }}
              >
                <option value="">选择预设，也可以填写自定义 ID</option>
                <optgroup label="通用模型 · 本地团队协作">
                  {GOOGLE_CATALOG.filter(
                    (item) => item.execution === "model",
                  ).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} · {item.description}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Google 托管专项 Agent">
                  {GOOGLE_CATALOG.filter(
                    (item) => item.execution === "google-agent",
                  ).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} · {item.description}
                    </option>
                  ))}
                </optgroup>
              </select>
            </label>
            <label className="field">
              执行方式
              <select
                aria-label="执行方式"
                value={profile.execution ?? "model"}
                onChange={(event) =>
                  updateProfile({
                    execution: event.currentTarget
                      .value as ModelProfile["execution"],
                  })
                }
              >
                <option value="model">通用模型 · 使用工作台工具</option>
                <option value="google-agent">
                  Google 专项 Agent · Interactions
                </option>
              </select>
            </label>
            {profile.execution === "google-agent" ? (
              <p className="field-hint">
                在 Google 端检索与执行，公开进度回到过程面板，报告保存为本地
                MD。使用账号的专项 API
                权限；本地项目文件不会自动上传。验证只检查合成回复，不代表本地工具或协作已通过。
              </p>
            ) : null}
          </div>
        ) : null}
        <label className="field">
          模型 ID
          <input
            required
            value={profile.modelId}
            onInput={(event) => {
              const modelId = event.currentTarget.value;
              const preset = GOOGLE_CATALOG.find(
                (item) => item.id === modelId.trim(),
              );
              updateProfile({
                modelId,
                ...(profile.provider === "gemini" && preset
                  ? { execution: preset.execution }
                  : {}),
              });
            }}
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
            required={profile.protocol !== "google"}
            value={profile.baseURL}
            onInput={(event) =>
              updateProfile({ baseURL: event.currentTarget.value })
            }
            placeholder={
              profile.protocol === "google"
                ? PROVIDERS.gemini.baseURL
                : "https://…"
            }
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
                  protocol: event.currentTarget
                    .value as ModelProfile["protocol"],
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
              onInput={(event) =>
                updateProfile({ apiKeyEnv: event.currentTarget.value })
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
              onInput={(event) => {
                setKey(event.currentTarget.value);
                setDirty(true);
                setSaved(false);
              }}
              placeholder={
                original?.hasKey
                  ? "已有密钥；留空保留"
                  : "也可以通过环境变量提供"
              }
              autoComplete="new-password"
              disabled={!connected}
            />
          </div>
          <span className="field-hint">
            已有密钥不会回显到界面；保存后清空本次输入。
          </span>
        </label>
        {original?.capabilities && !dirty ? (
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
              (profile.protocol !== "google" && !profile.baseURL.trim())
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
      </fieldset>
    </form>
  );
}

type SettingsPatch = Partial<
  Pick<
    AppSettings,
    "aiRoot" | "codeRoot" | "workspaceRoot" | "defaultProfileId"
  >
> & {
  memberProfiles?: Partial<Record<MemberId, string>>;
  memberSettings?: Partial<Record<MemberId, Partial<MemberSettings>>>;
};
const environmentKeys = ["aiRoot", "codeRoot", "workspaceRoot"] as const;
function mergeSettings(base: AppSettings, patch: SettingsPatch): AppSettings {
  const members = normalizeTeamSettings(base.memberSettings);
  for (const member of MEMBERS)
    members[member.id] = {
      ...members[member.id],
      ...patch.memberSettings?.[member.id],
    };
  return {
    ...base,
    ...patch,
    memberProfiles: { ...base.memberProfiles, ...patch.memberProfiles },
    memberSettings: members,
  };
}
function settingsPatch(before: AppSettings, after: AppSettings): SettingsPatch {
  const patch: SettingsPatch = {};
  for (const key of [...environmentKeys, "defaultProfileId"] as const)
    if (before[key] !== after[key]) patch[key] = after[key];
  for (const { id } of MEMBERS) {
    if (before.memberProfiles[id] !== after.memberProfiles[id])
      patch.memberProfiles = {
        ...patch.memberProfiles,
        [id]: after.memberProfiles[id],
      };
    const old = before.memberSettings?.[id],
      next = after.memberSettings?.[id];
    for (const key of ["prompt", "responseStyle", "delegation"] as const)
      if (next && old?.[key] !== next[key])
        patch.memberSettings = {
          ...patch.memberSettings,
          [id]: { ...patch.memberSettings?.[id], [key]: next[key] },
        };
  }
  return patch;
}
function combinePatches(
  current: SettingsPatch,
  next: SettingsPatch,
): SettingsPatch {
  const memberSettings = { ...current.memberSettings };
  for (const { id } of MEMBERS)
    if (next.memberSettings?.[id])
      memberSettings[id] = {
        ...memberSettings[id],
        ...next.memberSettings[id],
      };
  return {
    ...current,
    ...next,
    memberProfiles: { ...current.memberProfiles, ...next.memberProfiles },
    memberSettings,
  };
}
function scopedPatch(
  patch: SettingsPatch,
  mode: "environment" | "team",
): SettingsPatch {
  if (mode === "team")
    return {
      ...(patch.memberProfiles ? { memberProfiles: patch.memberProfiles } : {}),
      ...(patch.memberSettings ? { memberSettings: patch.memberSettings } : {}),
    };
  return Object.fromEntries(
    environmentKeys
      .filter((key) => patch[key] !== undefined)
      .map((key) => [key, patch[key]]),
  );
}
function clearPatch(
  patch: SettingsPatch,
  mode: "environment" | "team",
): SettingsPatch {
  const next = { ...patch };
  if (mode === "team") {
    delete next.memberProfiles;
    delete next.memberSettings;
  } else for (const key of environmentKeys) delete next[key];
  return next;
}

function EnvironmentSettings({
  snapshot,
  dispatch,
  mode = "environment",
  connected,
  onOpenModels,
}: {
  snapshot: Snapshot;
  dispatch: Dispatch;
  mode?: "environment" | "team";
  connected: boolean;
  onOpenModels?: () => void;
}) {
  const [patch, setPatch] = useState<SettingsPatch>({});
  const settings = mergeSettings(snapshot.settings, patch);
  const setSettings = (next: AppSettings) => {
    const change = settingsPatch(settings, next);
    setPatch((current) => combinePatches(current, change));
    setSavedMode(null);
  };
  const [saving, setSaving] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(false);
  const system = snapshot.system;
  const team = settings.memberSettings as MemberSettingsMap;
  const [savedMode, setSavedMode] = useState<"team" | "environment" | null>(
    null,
  );
  const save = async () => {
    if (!connected || saving || bootstrapping) return;
    setSaving(true);
    const next = mergeSettings(snapshot.settings, scopedPatch(patch, mode));
    const result = await dispatch({ type: "settings.save", settings: next });
    if (result) {
      setSavedMode(mode);
      setPatch((current) => clearPatch(current, mode));
    }
    setSaving(false);
  };
  const bootstrap = async () => {
    if (!connected || saving || bootstrapping) return;
    setBootstrapping(true);
    const result = await dispatch({
      type: "settings.save",
      settings: mergeSettings(
        snapshot.settings,
        scopedPatch(patch, "environment"),
      ),
    });
    if (result) {
      setPatch((current) => clearPatch(current, "environment"));
      setSavedMode("environment");
      await dispatch({ type: "system.bootstrap" });
    }
    setBootstrapping(false);
  };
  return (
    <div className="environment-settings">
      <fieldset
        className="settings-fieldset"
        disabled={!connected || saving || bootstrapping}
      >
        {mode === "environment" ? (
          <>
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
                    onInput={(event) =>
                      setSettings({
                        ...settings,
                        aiRoot: event.currentTarget.value,
                      })
                    }
                    placeholder="AI 规则、知识与资源所在路径"
                  />
                </label>
                <label className="field">
                  Code 根目录
                  <input
                    value={settings.codeRoot}
                    onInput={(event) =>
                      setSettings({
                        ...settings,
                        codeRoot: event.currentTarget.value,
                      })
                    }
                    placeholder="项目所在路径"
                  />
                </label>
              </div>
              <label className="field">
                工作资料目录
                <input
                  value={settings.workspaceRoot}
                  onInput={(event) =>
                    setSettings({
                      ...settings,
                      workspaceRoot: event.currentTarget.value,
                    })
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
                      void dispatch({
                        type: "path.reveal",
                        path: system.policyPath,
                      })
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
          </>
        ) : null}
        {mode === "team" ? (
          <section className="settings-section team-settings-section">
            <div className="section-heading">
              <h3>成员与协作方式</h3>
              <SlidersHorizontal size={18} />
            </div>
            <p className="section-description">
              定义每位成员的职责、回答详略和协作方式。保存后，继续工作时采用新配置。
            </p>
            <div className="team-model-reference">
              <div>
                <strong>团队使用已配置的 AI 模型</strong>
                <p>
                  为成员分配连接；新增模型、密钥与连接验证统一在「AI
                  模型」中管理。
                </p>
              </div>
              {onOpenModels ? (
                <button
                  type="button"
                  className="button secondary small"
                  onClick={onOpenModels}
                >
                  管理 AI 模型 <ChevronRight size={13} />
                </button>
              ) : null}
            </div>
            <div className="member-configs">
              {MEMBERS.map((member) => (
                <section className="member-settings-card" key={member.id}>
                  <div className="section-heading">
                    <div>
                      <h4>{member.name}</h4>
                      <p className="field-hint">{member.description}</p>
                    </div>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => {
                        setSettings({
                          ...settings,
                          memberSettings: {
                            ...team,
                            [member.id]: {
                              ...team[member.id],
                              prompt: defaultMemberSettings(member.id).prompt,
                            },
                          },
                        });
                        setSavedMode(null);
                      }}
                    >
                      恢复默认提示词
                    </button>
                  </div>
                  <label className="field member-model-assignment">
                    使用的模型
                    <select
                      aria-label={`${member.shortName}使用的模型`}
                      value={settings.memberProfiles[member.id] ?? ""}
                      onChange={(event) =>
                        setSettings({
                          ...settings,
                          memberProfiles: {
                            ...settings.memberProfiles,
                            [member.id]: event.currentTarget.value,
                          },
                        })
                      }
                    >
                      <option value="">跟随工作台默认</option>
                      {snapshot.profiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.name}
                          {profile.execution === "google-agent"
                            ? " · 专项 Agent"
                            : ""}
                        </option>
                      ))}
                    </select>
                    <span className="field-hint">
                      从已保存的连接中分配，跟随默认时使用 AI
                      模型页的工作台默认模型。
                    </span>
                  </label>
                  <label className="field">
                    角色提示词
                    <textarea
                      aria-label={`${member.shortName}的提示词`}
                      rows={4}
                      maxLength={MEMBER_PROMPT_LIMIT}
                      value={team[member.id].prompt}
                      onInput={(event) =>
                        setSettings({
                          ...settings,
                          memberSettings: {
                            ...team,
                            [member.id]: {
                              ...team[member.id],
                              prompt: event.currentTarget.value,
                            },
                          },
                        })
                      }
                    />
                  </label>
                  <div className="form-grid">
                    <label className="field">
                      回答详略
                      <select
                        aria-label={`${member.shortName}的回答详略`}
                        value={team[member.id].responseStyle}
                        onChange={(event) =>
                          setSettings({
                            ...settings,
                            memberSettings: {
                              ...team,
                              [member.id]: {
                                ...team[member.id],
                                responseStyle: event.currentTarget.value as
                                  "concise" | "balanced" | "detailed",
                              },
                            },
                          })
                        }
                      >
                        <option value="concise">简洁总结</option>
                        <option value="balanced">适度展开</option>
                        <option value="detailed">详细说明</option>
                      </select>
                    </label>
                    <label className="field">
                      协作方式
                      <select
                        aria-label={`${member.shortName}的协作方式`}
                        value={team[member.id].delegation}
                        onChange={(event) =>
                          setSettings({
                            ...settings,
                            memberSettings: {
                              ...team,
                              [member.id]: {
                                ...team[member.id],
                                delegation: event.currentTarget.value as
                                  "auto" | "off",
                              },
                            },
                          })
                        }
                      >
                        <option value="auto">自动协作</option>
                        <option value="off">独立处理</option>
                      </select>
                    </label>
                  </div>
                </section>
              ))}
            </div>
          </section>
        ) : null}
        <div className="form-actions">
          <button
            className="button primary"
            onClick={() => void save()}
            disabled={saving}
          >
            {saving
              ? "正在保存"
              : savedMode === mode
                ? "已保存"
                : mode === "team"
                  ? "保存团队设置"
                  : "保存本机环境"}
            <ArrowRight size={14} />
          </button>
          <span className="small-text muted">
            {mode === "team"
              ? "保存会暂停正在进行的工作，继续后生效"
              : "目录与规则用于资料保存和项目发现"}
          </span>
        </div>
        {mode === "environment" ? (
          <div className="settings-storage">
            工作台数据 <code>{snapshot.dataPath}</code>
          </div>
        ) : null}
      </fieldset>
    </div>
  );
}

function DefaultModelSettings({
  snapshot,
  dispatch,
  connected,
}: {
  snapshot: Snapshot;
  dispatch: Dispatch;
  connected: boolean;
}) {
  const [draft, setDraft] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const save = async () => {
    if (!connected || saving || draft === undefined) return;
    setSaving(true);
    const result = await dispatch({
      type: "settings.save",
      settings: { ...snapshot.settings, defaultProfileId: draft },
    });
    if (result) {
      setDraft(undefined);
      setSaved(true);
    }
    setSaving(false);
  };
  return (
    <section className="default-model-settings">
      <div>
        <h3>工作台默认模型</h3>
        <p>新工作和选择「跟随工作台默认」的成员使用此连接。</p>
      </div>
      <div className="default-model-actions">
        <label className="field">
          <span className="sr-only">工作台默认模型</span>
          <select
            aria-label="工作台默认模型"
            value={draft ?? snapshot.settings.defaultProfileId}
            disabled={!connected || saving}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setSaved(false);
            }}
          >
            <option value="">尚未指定</option>
            {snapshot.profiles.map((profile) => (
              <option value={profile.id} key={profile.id}>
                {profile.name} · {PROFILE_STATUS[profile.status]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="button secondary small"
          disabled={!connected || saving || draft === undefined}
          onClick={() => void save()}
        >
          {saving ? "正在保存" : saved ? "已保存" : "保存默认模型"}
        </button>
      </div>
    </section>
  );
}

export function Settings({
  snapshot,
  dispatch,
  connected,
  section,
  onOpenModels,
}: {
  snapshot: Snapshot | null;
  dispatch: Dispatch;
  connected: boolean;
  section?: SettingsSection;
  onOpenModels?: () => void;
}) {
  const [localSection, setLocalSection] = useState<SettingsSection>("models");
  const tab = section ?? localSection;
  const openModels =
    onOpenModels ??
    (section === undefined ? () => setLocalSection("models") : undefined);
  const [selected, setSelected] = useState<string | null>(
    snapshot?.profiles[0]?.id ?? null,
  );
  const [selectionInitialized, setSelectionInitialized] = useState(
    snapshot !== null,
  );
  const [newProfile, setNewProfile] = useState<ModelProfile>();
  const [catalogChoice, setCatalogChoice] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const addConnection = (presetId?: string) => {
    setSelectionInitialized(true);
    const preset = GOOGLE_CATALOG.find((item) => item.id === presetId);
    const google = snapshot?.profiles.find(
      (item) => item.provider === "gemini" && item.protocol === "google",
    );
    setNewProfile({
      id: crypto.randomUUID(),
      name: preset?.name ?? "",
      provider: "gemini",
      protocol: "google",
      execution: preset?.execution ?? "model",
      modelId: preset?.id ?? "",
      baseURL: google?.baseURL || PROVIDERS.gemini.baseURL,
      apiKeyEnv: google?.apiKeyEnv || PROVIDERS.gemini.keyEnv,
      hasKey: false,
      status: "unconfigured",
    });
    setSelected(null);
    setCatalogChoice("");
  };
  if (!selectionInitialized && snapshot) {
    setSelectionInitialized(true);
    setSelected(snapshot.profiles[0]?.id ?? null);
  }
  const original = snapshot?.profiles.find(
    (profile) => profile.id === selected,
  );
  return (
    <div className="settings-page">
      <div className="page-heading settings-page-heading">
        <span className="eyebrow">
          {tab === "models"
            ? "AI CONNECTIONS"
            : tab === "team"
              ? "AGENT TEAM"
              : "LOCAL WORKSPACE"}
        </span>
        <h1>
          {tab === "models"
            ? "AI 模型"
            : tab === "team"
              ? "多 Agent 团队"
              : "本机环境"}
        </h1>
        <p>
          {tab === "models"
            ? "管理模型连接、密钥和能力验证，选择工作台默认模型。"
            : tab === "team"
              ? "定义谁来工作，以及成员各自的职责与协作方式。"
              : "管理规则、资料与项目目录，让本机工作有序延续。"}
        </p>
      </div>
      {section === undefined ? (
        <div className="page-tabs">
          <button
            className={tab === "models" ? "active" : ""}
            onClick={() => setLocalSection("models")}
          >
            模型连接
          </button>
          <button
            className={tab === "environment" ? "active" : ""}
            onClick={() => setLocalSection("environment")}
          >
            本机环境
          </button>
          <button
            className={tab === "team" ? "active" : ""}
            onClick={() => setLocalSection("team")}
          >
            常驻成员
          </button>
        </div>
      ) : null}
      <div
        className={
          tab === "models" ? "models-page-content" : "settings-tab-hidden"
        }
      >
        {snapshot ? (
          <DefaultModelSettings
            snapshot={snapshot}
            dispatch={dispatch}
            connected={connected}
          />
        ) : null}
        <div className="models-layout">
          <aside className="profile-list">
            {snapshot?.profiles.map((profile) => (
              <button
                className={`profile-item ${profile.id === selected ? "active" : ""}`}
                key={profile.id}
                disabled={profileBusy}
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
              disabled={!connected || profileBusy}
              onClick={() => addConnection()}
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
          <div className="profile-workspace">
            <section className="catalog-new-connection">
              <div>
                <h3>从 Google 目录添加连接</h3>
                <p>为通用模型或专项 Agent 单独配置，保留现有连接。</p>
              </div>
              <div className="catalog-add-actions">
                <select
                  aria-label="用于新连接的 Google 模型目录"
                  value={catalogChoice}
                  disabled={!connected || profileBusy}
                  onChange={(event) =>
                    setCatalogChoice(event.currentTarget.value)
                  }
                >
                  <option value="">选择模型或专项 Agent</option>
                  <optgroup label="通用模型">
                    {GOOGLE_CATALOG.filter(
                      (item) => item.execution === "model",
                    ).map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Google 专项 Agent">
                    {GOOGLE_CATALOG.filter(
                      (item) => item.execution === "google-agent",
                    ).map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </optgroup>
                </select>
                <button
                  className="button secondary small"
                  disabled={!connected || profileBusy || !catalogChoice}
                  onClick={() => addConnection(catalogChoice)}
                >
                  <Plus size={13} />
                  添加为新连接
                </button>
              </div>
            </section>
            <ProfileEditor
              key={original?.id ?? newProfile?.id ?? "new"}
              original={original}
              initial={newProfile}
              dispatch={dispatch}
              onSaved={setSelected}
              onBusy={setProfileBusy}
              connected={connected}
            />
          </div>
        </div>
      </div>
      {snapshot ? (
        <div className={tab === "models" ? "settings-tab-hidden" : ""}>
          <EnvironmentSettings
            snapshot={snapshot}
            dispatch={dispatch}
            connected={connected}
            mode={tab === "team" ? "team" : "environment"}
            onOpenModels={openModels}
          />
        </div>
      ) : tab !== "models" ? (
        <div className="section-empty">
          <FolderOpen size={30} strokeWidth={1.3} />
          <h3>桌面连接后读取本机环境</h3>
          <p>浏览器布局预览无法发现本机规则与路径。</p>
        </div>
      ) : null}
    </div>
  );
}
