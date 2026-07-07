# yTriple V1 Output Contract

## Purpose

This document defines what yTriple V1 should deliver to the user.

It supersedes the earlier four-file delivery assumption.

## Product Decision

V1 delivers **one primary user-facing document**:

```text
prd.md
```

yTriple is not a report bundle generator. The product promise is:

> Three Agents, One Perfect Output.

Therefore the default output must be one clean PRD draft, not four separate files.

## Default Output

Each completed task writes exactly one user-facing file:

```text
<output-root>/ytriple-outputs/<task-id>/prd.md
```

`prd.md` is the only default deliverable.

The app should open or preview this file first after completion.

## What Goes Into `prd.md`

The PRD must be clean enough to give to a developer, product collaborator, or AI coding agent.

Minimum sections:

1. Product Summary
2. Problem / Background
3. Target Users
4. Core Scenario
5. V1 Scope
6. Non-goals
7. Functional Requirements
8. UX / Interaction Requirements
9. Data / Permission / Runtime Requirements, if relevant
10. Success Criteria
11. Assumptions and Open Questions
12. Source Notes, only when source-backed facts are used

Research and specialist review should influence the PRD, but raw research notes and raw review notes must not dominate the PRD body.

## What Does Not Become A Default Deliverable

The following are process materials, not default user deliverables:

- full conversation transcript
- raw Researcher notes
- raw Specialist review
- side-panel event logs
- full source dump
- model/provider debug payloads

These may be visible inside the app during and after the run, but they should not be written as separate user-facing Markdown deliverables by default.

## Runtime Trace

The app may keep internal runtime trace data for debugging, history, and reopen support.

Trace data may include:

- conversation messages
- Task Brief
- Researcher events
- Specialist events
- source cards
- artifact write events
- model/provider metadata
- errors

Trace data is not a user-facing deliverable.

For V1, trace storage can be implemented in the simplest safe way, but it must not be presented as one of the main outputs.

## Optional Export

A future optional action may export supporting notes as one combined file:

```text
agent-notes.md
```

This is not part of the V1 default acceptance criteria.

If implemented later, it must combine Task Brief, Researcher notes, Specialist review, and sources into one supporting appendix file. It must not restore the old four-file default.

## UI Implication

After task completion:

- Center panel focuses on `prd.md` preview.
- Left panel can still show Researcher process.
- Right panel can still show Specialist process.
- Task Brief can remain visible as a collapsible context card.
- `Open Output Folder` should show the folder containing `prd.md`.

## Implementation Contract

Code must stop assuming these four default files:

```text
01-final-prd.md
02-assumptions-and-open-questions.md
03-research-notes.md
04-specialist-review.md
```

Replace them with:

```text
prd.md
```

Any tests, UI labels, runtime artifact manifests, README instructions, and PR acceptance checks must follow this output contract.

## Acceptance Criteria

A task is complete only when:

1. The app generates exactly one default user-facing Markdown output: `prd.md`.
2. `prd.md` contains a complete PRD draft with assumptions and open questions included inside the document.
3. Researcher and Specialist outputs influence the PRD but are not emitted as separate default Markdown files.
4. The side panels still show real Researcher and Specialist process before and after completion.
5. PR evidence includes a preview or excerpt of `prd.md`, not four generated files.
