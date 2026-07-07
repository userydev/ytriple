# yTriple V1 Role Selection Contract

## Purpose

This document defines how yTriple should manually select and configure role references from the upstream `agency-agents` catalog.

The goal is to let the user tune agent perspectives without turning yTriple into a user-composable agent platform.

## Product Decision

V1 supports **manual role profile selection**, not manual agent orchestration.

```text
Allowed: choose role profiles for fixed slots
Forbidden: add/remove agents or build custom flows
```

The fixed V1 slots remain:

- Conductor
- Researcher
- Specialist

Only the role profile attached to a slot may change.

## Current Baseline

Current code maps upstream `agency-agents` roles into fixed yTriple slots:

```text
Conductor  -> specialized/agents-orchestrator.md
Researcher -> product/product-trend-researcher.md
Specialist -> product/product-manager.md
```

This baseline is valid as the default preset, but it is not enough for productized manual configuration.

## V1 Role Selection Model

### 1. Conductor Is Locked By Default

Conductor controls orchestration, task readiness, Task Brief synthesis, dispatch, and final merge.

V1 should not expose Conductor role switching to normal users.

Reason:

- If Conductor changes freely, the fixed workflow becomes unstable.
- Conductor is part of the product's control plane, not a creative role.

Default:

```text
specialized/agents-orchestrator.md
```

### 2. Researcher Is Selectable From A Curated Research Allowlist

Researcher can be manually configured because different PRD tasks need different research perspectives.

Examples of valid Researcher-style profiles:

- product trend researcher
- market researcher
- competitor analyst
- user research analyst
- technical researcher

The UI should not expose all upstream roles directly. It should expose a curated allowlist of roles that can safely behave as Researcher.

Researcher role changes may affect:

- question policy
- search query strategy
- source preference
- fact / inference / assumption handling
- left-panel sections
- research contribution schema

Researcher role changes must not affect:

- number of agents
- output file count
- final PRD ownership
- Conductor's dispatch authority

### 3. Specialist Is Selectable From A Curated Specialist Allowlist

Specialist can be manually configured because different PRDs need different review perspectives.

Examples of valid Specialist-style profiles:

- product manager
- technical architect
- growth strategist
- brand strategist
- UX reviewer
- compliance reviewer

Specialist role changes may affect:

- review checklist
- product-risk focus
- non-goal pressure
- success-metric interpretation
- right-panel sections
- specialist contribution schema

Specialist role changes must not affect:

- fixed orchestration
- Researcher behavior
- output contract
- Conductor ownership of final merge

## UI Placement

V1 should expose role configuration in two places.

### Task Setup

Before execution, show a compact role configuration card:

```text
Role Setup

Conductor: Agents Orchestrator (locked)
Researcher: Product Trend Researcher [change]
Specialist: Product Manager [change]
```

The default path should require no configuration. Role selection is optional.

### Settings / Presets

Settings may include default presets:

```text
Default PRD Preset
- Researcher role
- Specialist role
- preferred model per slot, optional
- web search enabled for Researcher
```

V1 should support simple saved presets only if implementation cost is low. Otherwise task-level selection is enough.

## Configuration Shape

Role selection should be represented as data, not hard-coded inside UI components.

Recommended config shape:

```ts
interface SlotRoleConfig {
  slot: "conductor" | "researcher" | "specialist";
  roleId: string;
  sourceSlug: string;
  displayName: string;
  locked?: boolean;
}

interface RolePreset {
  presetId: string;
  name: string;
  description: string;
  slots: SlotRoleConfig[];
}
```

Default preset:

```ts
const DEFAULT_PRD_PRESET: RolePreset = {
  presetId: "prd.default",
  name: "PRD Default",
  description: "Default fixed three-agent PRD workshop preset.",
  slots: [
    {
      slot: "conductor",
      roleId: "agents-orchestrator",
      sourceSlug: "specialized/agents-orchestrator.md",
      displayName: "Agents Orchestrator",
      locked: true,
    },
    {
      slot: "researcher",
      roleId: "product-trend-researcher",
      sourceSlug: "product/product-trend-researcher.md",
      displayName: "Product Trend Researcher",
    },
    {
      slot: "specialist",
      roleId: "product-manager",
      sourceSlug: "product/product-manager.md",
      displayName: "Product Manager",
    },
  ],
};
```

## Runtime Behavior

When a user selects a role profile, runtime must inject the selected profile into the fixed slot.

Required runtime inputs:

```ts
interface TaskRoleSelection {
  conductorRole: SlotRoleConfig;
  researcherRole: SlotRoleConfig;
  specialistRole: SlotRoleConfig;
}
```

The selected role should influence:

- agent system prompt
- agent question policy
- execution policy
- panel labels
- review checklist or research policy

The selected role must not bypass:

- fixed state machine
- Task Brief requirement
- Conductor dispatch
- single `prd.md` output contract

## Catalog Policy

The full upstream `agency-agents` catalog can remain in code as a reference catalog.

V1 UI should not expose the full 220-role catalog directly.

Instead, create slot-specific allowlists:

```ts
const RESEARCHER_ROLE_ALLOWLIST = [
  "product/product-trend-researcher.md",
  // future curated researcher-compatible roles
];

const SPECIALIST_ROLE_ALLOWLIST = [
  "product/product-manager.md",
  // future curated specialist-compatible roles
];

const CONDUCTOR_ROLE_ALLOWLIST = [
  "specialized/agents-orchestrator.md",
];
```

Reason:

- Most upstream roles are not safe drop-in replacements for a fixed PRD workflow.
- Role compatibility must be curated by slot.
- This prevents the product from drifting into generic agent composition.

## Manual Configuration Levels

### Level 1: Code-Level Configuration

Initial implementation may allow manual configuration through a runtime preset file.

Recommended file:

```text
src/runtime/rolePresets.ts
```

This is acceptable for internal testing.

### Level 2: Task-Level UI Selection

Productized V1 should allow task-level role selection before dispatch.

This is the preferred V1 UX.

### Level 3: Saved Presets

Saved presets can come later.

Do not block V1 on saved preset management.

## Acceptance Criteria

Manual role selection is acceptable only when:

1. Conductor remains locked by default.
2. Researcher and Specialist can be changed only within curated slot allowlists.
3. Selected role appears in the UI.
4. Selected role affects prompts, questions, execution focus, and panel labels.
5. Selected role does not change the fixed three-agent orchestration.
6. Selected role does not change the single `prd.md` output contract.
7. Tests prove that role selection is passed from UI/request into runtime prompts.

## Review Gate

Reject implementation if:

- The full upstream catalog is dumped into the UI without slot filtering.
- Users can add or remove agents.
- Users can alter the fixed workflow order.
- Conductor can be freely replaced in V1.
- Role selection is only decorative and does not affect runtime behavior.
- Role selection breaks the single-output contract.
