import { curatedRolesFor, isRoleLocked } from "@ytriple/core";
import type { TeamDefinition, YtripleConfig } from "@ytriple/shared";
import { useState, type JSX } from "react";
import type { DesktopHost, DesktopSettings } from "../host/types.js";
import { credentialRefsOf, modelChoices } from "../state/settings.js";

/**
 * Role and model configuration, per seat.
 *
 * Roles come from the curated catalog, so the full upstream library never
 * reaches this picker, and the orchestrator's seat is locked because it is part
 * of the control plane. Credentials are written straight to the host's secure
 * store; this component never reads one back.
 */
export function SettingsView({
  host,
  config,
  team,
  settings,
  credentials,
  onChange,
  onCredentialSaved,
}: {
  host: DesktopHost;
  config: YtripleConfig;
  team: TeamDefinition;
  settings: DesktopSettings;
  credentials: Record<string, boolean>;
  onChange(settings: DesktopSettings): void;
  onCredentialSaved(): void;
}): JSX.Element {
  const models = modelChoices(config);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | undefined>(undefined);

  const bindingValue = (agentId: string) => {
    const binding = settings.agentModels[agentId];
    return binding ? `${binding.providerId}::${binding.modelId}` : "";
  };

  return (
    <div className="settings-layout">
      <section className="pane">
        <header className="pane-header">
          <h2>Team</h2>
          <span className="muted">{team.members.length} members · preset {team.teamId}</span>
        </header>
        <div className="pane-scroll">
          {team.members.map((member) => {
            const locked = isRoleLocked(member.role.roleId);
            const roles = locked ? [] : curatedRolesFor("generic");

            return (
              <div className="settings-row" key={member.agentId}>
                <div className="settings-row-head">
                  <h3>{member.displayName}</h3>
                  <code className="muted">{member.agentId}</code>
                </div>
                <p className="muted">{member.role.responsibility}</p>

                <label>
                  <span>Role</span>
                  {locked ? (
                    <span className="locked-value">
                      {member.role.displayName} <span className="tag">locked</span>
                    </span>
                  ) : (
                    <select
                      value={settings.agentRoles[member.agentId] ?? member.role.roleId}
                      onChange={(event) =>
                        onChange({
                          ...settings,
                          agentRoles: {
                            ...settings.agentRoles,
                            [member.agentId]: event.target.value,
                          },
                        })
                      }
                    >
                      {roles.map((role) => (
                        <option key={role.roleId} value={role.roleId}>
                          {role.displayName}
                        </option>
                      ))}
                    </select>
                  )}
                </label>

                <label>
                  <span>Model</span>
                  <select
                    value={bindingValue(member.agentId)}
                    onChange={(event) => {
                      const next = { ...settings.agentModels };
                      if (event.target.value === "") delete next[member.agentId];
                      else {
                        const [providerId, modelId] = event.target.value.split("::");
                        next[member.agentId] = { providerId: providerId!, modelId: modelId! };
                      }
                      onChange({ ...settings, agentModels: next });
                    }}
                  >
                    <option value="">
                      Team default ({settings.defaultModel.providerId} ·{" "}
                      {settings.defaultModel.modelId})
                    </option>
                    {models.map((model) => (
                      <option
                        key={`${model.providerId}::${model.modelId}`}
                        value={`${model.providerId}::${model.modelId}`}
                      >
                        {model.label}
                      </option>
                    ))}
                  </select>
                </label>

                {member.tools.length > 0 && (
                  <p className="muted">Tools: {member.tools.join(", ")}</p>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="pane">
        <header className="pane-header">
          <h2>Providers and credentials</h2>
          <span className="muted">
            {host.info.secureCredentialStorage
              ? "Stored in the OS keychain, never in this window"
              : "This host has no credential store"}
          </span>
        </header>
        <div className="pane-scroll">
          <label className="settings-row">
            <span>Default model for the team</span>
            <select
              value={`${settings.defaultModel.providerId}::${settings.defaultModel.modelId}`}
              onChange={(event) => {
                const [providerId, modelId] = event.target.value.split("::");
                onChange({
                  ...settings,
                  defaultModel: { providerId: providerId!, modelId: modelId! },
                });
              }}
            >
              {models.map((model) => (
                <option
                  key={`${model.providerId}::${model.modelId}`}
                  value={`${model.providerId}::${model.modelId}`}
                >
                  {model.label}
                </option>
              ))}
            </select>
          </label>

          {config.providers.map((provider) => (
            <div className="settings-row" key={provider.providerId}>
              <div className="settings-row-head">
                <h3>{provider.displayName}</h3>
                <span className={`tag ${credentials[provider.credentialRef] ? "tag-ok" : "tag-warn"}`}>
                  {credentials[provider.credentialRef] ? "credential stored" : "no credential"}
                </span>
              </div>
              <p className="muted">
                adapter {provider.adapterId} · models{" "}
                {provider.models.map((model) => model.modelId).join(", ")}
              </p>
              <p className="muted">
                credential ref <code>{provider.credentialRef}</code>
              </p>

              {host.info.secureCredentialStorage && (
                <div className="credential-row">
                  <input
                    type="password"
                    placeholder={`Paste the key for ${provider.displayName}`}
                    value={drafts[provider.credentialRef] ?? ""}
                    onChange={(event) =>
                      setDrafts({ ...drafts, [provider.credentialRef]: event.target.value })
                    }
                  />
                  <button
                    type="button"
                    disabled={
                      saving === provider.credentialRef ||
                      (drafts[provider.credentialRef] ?? "").length === 0
                    }
                    onClick={() => {
                      setSaving(provider.credentialRef);
                      void host
                        .saveCredential(
                          provider.credentialRef,
                          drafts[provider.credentialRef] ?? "",
                        )
                        .then(() => {
                          setDrafts({ ...drafts, [provider.credentialRef]: "" });
                          onCredentialSaved();
                        })
                        .finally(() => setSaving(undefined));
                    }}
                  >
                    Save to keychain
                  </button>
                </div>
              )}
            </div>
          ))}

          <p className="muted">
            Credential refs in use: {credentialRefsOf(config).join(", ")}. Keys are resolved when a
            request is sent and never enter this window.
          </p>
        </div>
      </section>
    </div>
  );
}
