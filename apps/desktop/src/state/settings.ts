import { applyRoleSelection, createDefaultTeam } from "@ytriple/core";
import type { AgentDefinition, TeamDefinition, YtripleConfig } from "@ytriple/shared";
import type { DesktopSettings } from "../host/types.js";

/**
 * Settings are the only thing that shapes the team. Everything the user can
 * change — which role sits in a seat, which model it is bound to — is data that
 * ends up in the `TeamDefinition`, never a branch in the UI.
 */
export function defaultSettings(config: YtripleConfig): DesktopSettings {
  return {
    defaultModel: config.defaultModel,
    agentRoles: {},
    agentModels: {},
  };
}

export function teamFromSettings(settings: DesktopSettings): TeamDefinition {
  const base = createDefaultTeam(settings.defaultModel);

  const selections = Object.entries(settings.agentRoles)
    .filter(([agentId, roleId]) => {
      const member = base.members.find((entry) => entry.agentId === agentId);
      return member !== undefined && member.role.roleId !== roleId;
    })
    .map(([agentId, roleId]) => ({ agentId, roleId }));

  const withRoles = selections.length > 0 ? applyRoleSelection(base, selections) : base;

  return {
    ...withRoles,
    members: withRoles.members.map((member): AgentDefinition => {
      const binding = settings.agentModels[member.agentId];
      return binding ? { ...member, model: binding } : member;
    }),
  };
}

export function credentialRefsOf(config: YtripleConfig): string[] {
  return [...new Set(config.providers.map((provider) => provider.credentialRef))];
}

export function modelChoices(config: YtripleConfig): Array<{
  providerId: string;
  modelId: string;
  label: string;
}> {
  return config.providers.flatMap((provider) =>
    provider.models.map((model) => ({
      providerId: provider.providerId,
      modelId: model.modelId,
      label: `${provider.displayName} · ${model.displayName}`,
    })),
  );
}
