# V1 Agent Conversation Runtime Fix

## Status

Blocking task for V1 usability.

Current V1 cannot be treated as usable until the product implements a real three-agent conversation and execution flow.

This task must follow the output contract in:

- `docs/product/v1-output-contract.md`

## Problem

The current app has the visual shape of yTriple, but the core strategy is not fully executed.

Known issues:

1. The center chat is not yet a real shared conversation with Conductor / Researcher / Specialist.
2. Researcher and Specialist do not actually ask scoped questions based on their own responsibility.
3. Conductor does not yet summarize the conversation into a structured task brief before dispatching work.
4. Left and right panels still behave partly like progress decoration instead of showing real execution process.
5. Role references are visible in UI, but role behavior is not sufficiently enforced in runtime.
6. Research is not yet exposed as a visible process: query intent, search action, sources, findings, assumptions, and uncertainty are not clearly shown.
7. Specialist review is not yet exposed as a visible process: role checklist, missing context, risks, trade-offs, and review judgment are not clearly shown.
8. Runtime is split between TypeScript and Rust/Tauri paths, creating ambiguity over the actual source of product behavior.
9. The old four-file output assumption conflicts with the product promise: `Three Agents, One Perfect Output`.

## Product Decision

V1 must behave as a real fixed three-agent PRD workshop:

```text
User shared chat
  -> Conductor listens, summarizes, and controls task readiness
  -> Researcher asks research-scope questions and later executes light research
  -> Specialist asks product-review questions and later executes structured review
  -> Conductor dispatches both agents after enough context exists
  -> side panels show real execution traces
  -> Conductor merges results into one clean PRD draft
  -> app writes prd.md as the only default user-facing deliverable
```

The product is not a one-button PRD generator with decorative side panels. It is a constrained three-agent working session that produces one clean PRD output.

## Output Decision

Default output is exactly one user-facing Markdown file:

```text
<output-root>/ytriple-outputs/<task-id>/prd.md
```

Do not generate these as default deliverables:

```text
01-final-prd.md
02-assumptions-and-open-questions.md
03-research-notes.md
04-specialist-review.md
```

Researcher notes, Specialist review, Task Brief, source cards, and conversation transcript are process materials. They should be visible in the app and may be stored as internal trace data, but they are not default Markdown deliverables.

`prd.md` must include assumptions, open questions, and source notes where relevant.

## Required UX Model

### 1. Shared Three-Agent Chat

The center chat is the single user-facing conversation surface.

Required behavior:

- User speaks once in the center chat.
- Conductor responds with a concise understanding of the task.
- Researcher may ask 0-2 questions from the research angle.
- Specialist may ask 0-2 questions from the product-review angle.
- User replies in the same chat, not in separate hidden forms.
- Conductor continuously maintains a structured task brief from the conversation.

Agent messages must be clearly labeled:

- `Conductor`
- `Researcher`
- `Specialist`
- `You`

Each agent question must be grounded in that agent's responsibility. Do not use generic canned questions.

### 2. Conductor Responsibility

Conductor owns conversation control.

Required behavior:

- Understand the user's raw idea.
- Decide whether the task can proceed or needs more context.
- Ask only the minimum necessary cross-cutting questions.
- Accept Researcher and Specialist questions into the same shared chat.
- Summarize accumulated user answers into a task brief.
- Decide when the task is ready for dispatch.
- Dispatch Researcher and Specialist with the structured brief.
- Merge outputs into the final PRD.

Conductor must produce a visible `Task Brief` before dispatch.

Minimum task brief fields:

- `product_object`
- `target_user`
- `core_scenario`
- `pain_or_problem`
- `v1_scope`
- `non_goals`
- `success_criteria`
- `research_scope`
- `specialist_focus`
- `assumptions`
- `open_questions`

### 3. Researcher Responsibility

Researcher is not a side label. It must have runtime behavior.

Conversation phase:

- Ask about market / competitor / source / region / validation scope only when needed.
- Avoid product-management questions that belong to Specialist or Conductor.

Execution phase:

- Generate a visible light-research plan.
- Execute Ark web_search only in the Researcher slot.
- Show search queries or query intent.
- Show source cards.
- Separate facts, inferences, and assumptions.
- Produce structured research input for Conductor's PRD merge.

Left panel must show real Researcher process, not demo progress.

Required left-panel sections:

- Research scope
- Query plan / search intent
- Search status
- Source cards
- Key findings
- Facts vs assumptions
- Research contribution ready state

### 4. Specialist Responsibility

Specialist is not a side label. It must have runtime behavior.

Conversation phase:

- Ask about users, scope, non-goals, success metrics, risks, constraints, and product shape only when needed.
- Avoid market-source questions that belong to Researcher.

Execution phase:

- Use the selected `product_lead` role profile.
- Show review checklist.
- Identify missing PRD sections.
- Identify product risks and trade-offs.
- Produce structured review input for Conductor's PRD merge.

Right panel must show real Specialist process, not demo progress.

Required right-panel sections:

- Active role profile
- Review checklist
- Missing context
- Risks
- Scope warnings
- Recommendations
- Specialist contribution ready state

## Runtime Contract Change

### New Task States

The current status sequence is not enough. V1 should use explicit states that match the product experience.

Required state model:

```text
idle
chatting
agent_questioning
brief_ready
dispatching
running_researcher
running_specialist
merging
writing_outputs
completed
failed
```

`quick_clarify` should not be a shallow UI heuristic. It should be replaced by real `agent_questioning` driven by agent outputs.

### New Event Types

The UI must subscribe to real runtime events.

Required events:

```ts
type RuntimeEvent =
  | { type: "agent_message"; agent: "conductor" | "researcher" | "specialist"; text: string }
  | { type: "agent_question"; agent: "conductor" | "researcher" | "specialist"; question: string; reason: string }
  | { type: "task_brief_updated"; brief: TaskBrief }
  | { type: "task_status"; status: TaskStatus }
  | { type: "research_event"; stage: string; detail: string; sources?: SourceNote[] }
  | { type: "specialist_event"; stage: string; detail: string }
  | { type: "artifact_written"; filename: "prd.md"; path: string }
  | { type: "error"; stage: string; message: string };
```

Existing `agent_activity` can remain only if it is backed by real runtime stages. It must not be used for fake progress.

## Role Contract

Role references must affect runtime behavior, not just UI cards.

Each role used in V1 must expose:

```ts
interface RuntimeRoleProfile {
  roleId: string;
  displayName: string;
  responsibility: string;
  questionPolicy: string[];
  executionPolicy: string[];
  outputSchema: unknown;
  panelSections: string[];
}
```

V1 fixed mappings:

- Conductor: orchestration, task readiness, brief synthesis, dispatch, final merge.
- Researcher: light research, sources, facts/inferences, research contribution.
- Specialist: product lead review, scope, risks, missing sections, recommendations.

Do not expose custom agent composition in V1.

## Implementation Requirements

### Required Code Changes

1. Replace front-end demo conversation and demo progress with runtime-backed state.
2. Add a conversation/session model that stores all user and agent messages.
3. Add an agent-question pass before final PRD generation.
4. Add `TaskBrief` as a first-class runtime object.
5. Make Conductor update and display the Task Brief before dispatch.
6. Make Researcher and Specialist receive the same Task Brief plus their role profile.
7. Make left and right panels render real Researcher/Specialist events.
8. Make Ark provider strategy the explicit V1 provider strategy in docs and code.
9. Decide one source of runtime truth for desktop behavior. For V1 desktop, Rust/Tauri command path is the product path; TypeScript runtime may remain only as test harness if kept in sync.
10. Replace four-file artifact assumptions with the single-output contract: `prd.md`.
11. Add tests for conversation, agent questions, task brief creation, dispatch, event emission, and single PRD output.

### UI Rules

- Empty state may use examples, but running state must never show fake execution.
- Agent questions must appear in the center chat.
- Side panels must show process, not alternate chat windows.
- Final PRD remains the primary output after completion.
- Researcher and Specialist contributions remain visible in side panels, not separate default output files.

## Acceptance Criteria

A PR for this task is not acceptable unless all criteria below are satisfied.

### Manual Product Test

Use this sample input:

```text
我想做一个工具，把模糊的产品想法变成可以给开发看的 PRD，但是我现在还没想清楚具体流程。
```

Expected behavior:

1. Conductor responds with a short task understanding.
2. Researcher asks at least one research-scope question if research scope is missing.
3. Specialist asks at least one product-review question if target user / scope / success criteria are missing.
4. User can answer in the same center chat.
5. Conductor produces a visible Task Brief.
6. Conductor dispatches Researcher and Specialist.
7. Left panel shows real Researcher stages and sources.
8. Right panel shows real Specialist checklist, risks, and recommendations.
9. The app writes exactly one default user-facing Markdown file: `prd.md`.
10. `prd.md` contains a clean PRD draft with assumptions and open questions included.
11. `prd.md` does not contain raw research dump or raw specialist-review noise.
12. Researcher and Specialist process remains visible in the app.

### Technical Test Evidence Required In PR

PR description must include:

- Screenshot or recording of the shared three-agent chat.
- Screenshot or recording of left/right panels showing real execution process.
- Sample generated output directory listing showing `prd.md`.
- Contents preview or excerpt of `prd.md`.
- Test command output for `npm test`.
- Build command output for `npm run build`.
- Tauri dev/manual run notes.

## Out Of Scope

Do not add these in this task:

- Custom agent builder.
- User-defined agent topology.
- Deep research mode.
- Git integration.
- Team collaboration.
- Cloud sync.
- More templates beyond PRD.
- Role marketplace.
- Four-file default output package.

## Review Gate

This task should be reviewed as a V1 usability gate, not as a UI polish task.

Reject the PR if:

- Agent questions are still canned UI text.
- Side panels still show fake/demo execution.
- Researcher does not perform or display real light research behavior.
- Specialist does not perform or display real product-review behavior.
- Conductor does not produce a structured Task Brief before dispatch.
- The app still writes the old four default Markdown files.
- The generated `prd.md` is not clean enough to hand to a developer or AI coding agent.
