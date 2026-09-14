import {
  createDefaultTeam,
  createFakeClock,
  createFakeOutputPort,
  createScriptedUserPort,
  createTaskRuntime,
  type TaskRunResult,
} from "@ytriple/core";
import { buildTaskView, layoutMembers } from "@ytriple/desktop";
import { DEMO_SCENARIO, createReplayAdapter, scenarioToRecording } from "@ytriple/providers";
import type { YtripleConfig } from "@ytriple/shared";
import { eventsOfType } from "@ytriple/shared";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The manual acceptance case from `docs/project/v1-agent-conversation-runtime-task.md`,
 * turned into a test.
 *
 * The doc lists twelve numbered expectations for one specific input. Each one
 * is checked here against a real run and the view model the UI renders from, so
 * the acceptance case stops depending on someone remembering to walk through
 * it.
 */
const binding = { providerId: "recorded", modelId: "recorded" };

const config: YtripleConfig = {
  providers: [
    {
      providerId: "recorded",
      adapterId: "openai_compatible",
      displayName: "Recorded",
      baseUrl: "https://recorded.invalid/v1",
      credentialRef: "RECORDED",
      models: [{ modelId: "recorded", displayName: "Recorded" }],
    },
  ],
  defaultModel: binding,
};

/** The exact input the acceptance case specifies. */
const ACCEPTANCE_INPUT =
  "我想做一个工具，把模糊的产品想法变成可以给开发看的 PRD，但是我现在还没想清楚具体流程。";

const team = createDefaultTeam(binding);
let result: TaskRunResult;
let view: ReturnType<typeof buildTaskView>;

beforeAll(async () => {
  const adapter = createReplayAdapter(scenarioToRecording(DEMO_SCENARIO));
  const runtime = createTaskRuntime({
    taskId: "acceptance",
    team,
    config,
    capabilities: {
      workspaceRead: false,
      outputWrite: true,
      webSearch: true,
      localModels: true,
      persistentBackgroundRuns: false,
      streaming: false,
    },
    ports: {
      output: createFakeOutputPort(),
      clock: createFakeClock(),
      user: createScriptedUserPort(DEMO_SCENARIO.answers),
    },
    resolveBinding: async () => ({
      adapter,
      model: { modelId: "recorded", displayName: "Recorded" },
    }),
  });

  result = await runtime.run({ userInput: ACCEPTANCE_INPUT });
  view = buildTaskView(team, "acceptance", result.events);
});

describe("manual acceptance case", () => {
  it("uses the input the acceptance case specifies", () => {
    expect(DEMO_SCENARIO.userInput).toBe(ACCEPTANCE_INPUT);
    expect(view.chat[0]).toMatchObject({ kind: "user", text: ACCEPTANCE_INPUT });
  });

  it("1. the orchestrator answers with a short understanding of the task", () => {
    const first = eventsOfType(result.events, "agent_message")[0];
    expect(first?.agentId).toBe(team.orchestratorId);
    expect((first?.text ?? "").length).toBeGreaterThan(20);
    expect((first?.text ?? "").length).toBeLessThan(400);
  });

  it("2. the research member asks at least one research-scope question", () => {
    const asked = eventsOfType(result.events, "agent_question").filter(
      (body) => body.agentId === "researcher",
    );
    expect(asked.length).toBeGreaterThanOrEqual(1);
    expect(asked[0]?.question).toMatch(/市场|调研/);
    expect(asked[0]?.reason.length).toBeGreaterThan(0);
  });

  it("3. the reviewing member asks at least one product-review question", () => {
    const asked = eventsOfType(result.events, "agent_question").filter(
      (body) => body.agentId === "specialist",
    );
    expect(asked.length).toBeGreaterThanOrEqual(1);
    expect(asked[0]?.question).toMatch(/成功|用户|范围/);
  });

  it("4. the user answers in the same conversation", () => {
    const answers = eventsOfType(result.events, "user_answer");
    expect(answers.length).toBeGreaterThanOrEqual(3);
    // Answers land in the one shared chat, not in a side form.
    expect(view.chat.filter((entry) => entry.kind === "answer")).toHaveLength(answers.length);
    expect(view.pendingQuestions).toEqual([]);
  });

  it("5. a Task Brief becomes visible", () => {
    expect(view.brief).toBeDefined();
    expect(view.brief?.productObject.length).toBeGreaterThan(10);
    expect(view.brief?.memberTasks).toHaveLength(2);
  });

  it("6. both members are dispatched, after the brief", () => {
    const briefIndex = result.events.findIndex((event) => event.body.type === "task_brief_updated");
    const dispatchIndex = result.events.findIndex((event) => event.body.type === "agent_dispatched");

    expect(dispatchIndex).toBeGreaterThan(briefIndex);
    expect(eventsOfType(result.events, "agent_dispatched").map((body) => body.agentId)).toEqual([
      "researcher",
      "specialist",
    ]);
  });

  it("7. the research pane shows real stages and real sources", () => {
    const researcher = view.members.find((member) => member.agentId === "researcher")!;

    expect(researcher.stages.length).toBeGreaterThan(0);
    expect(researcher.toolCalls.map((call) => call.tool)).toContain("web_search");
    expect(researcher.sources.length).toBeGreaterThan(0);
    for (const source of researcher.sources) {
      expect(source.url).toMatch(/^https?:\/\//);
      expect(source.origin).toBe("native_provider_search");
    }
  });

  it("8. the review pane shows a checklist, risks and recommendations", () => {
    const specialist = view.members.find((member) => member.agentId === "specialist")!;
    const payload = specialist.contribution?.payload ?? {};

    expect(specialist.contribution?.schemaId).toBe("review_contribution");
    expect(Array.isArray(payload.checklist)).toBe(true);
    expect((payload.checklist as unknown[]).length).toBeGreaterThan(0);
    expect((payload.risks as unknown[]).length).toBeGreaterThan(0);
    expect((payload.recommendations as unknown[]).length).toBeGreaterThan(0);
  });

  it("9. exactly one user-facing file is written, and it is prd.md", () => {
    const artifacts = eventsOfType(result.events, "artifact_written");
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.filename).toBe("prd.md");
    expect(artifacts[0]?.path).toMatch(/ytriple-outputs\/acceptance\/prd\.md$/);
  });

  it("10. the document is a complete draft with assumptions and open questions inside it", () => {
    const markdown = result.prd?.markdown ?? "";

    for (const section of [
      "## Product Summary",
      "## Problem / Background",
      "## Target Users",
      "## Core Scenario",
      "## V1 Scope",
      "## Non-goals",
      "## Functional Requirements",
      "## UX / Interaction Requirements",
      "## Success Criteria",
      "## Assumptions and Open Questions",
      "## Source Notes",
    ]) {
      expect(markdown, `missing ${section}`).toContain(section);
    }
    expect(markdown).toContain("**Assumptions**");
    expect(markdown).toContain("**Open questions**");
  });

  it("11. no raw research dump or review noise reaches the document body", () => {
    const markdown = result.prd?.markdown ?? "";

    expect(markdown).not.toContain("research_contribution");
    expect(markdown).not.toContain("review_contribution");
    expect(markdown).not.toContain("checklist");
    expect(markdown).not.toContain("proposed_sections");
    expect(markdown).not.toContain('"verdict"');
  });

  it("12. both members' process stays visible after the run", () => {
    for (const member of view.members) {
      expect(member.status).toBe("contributed");
      expect(member.stages.length).toBeGreaterThan(0);
      expect(member.contribution).toBeDefined();
      expect(member.panelSections.length).toBeGreaterThan(0);
    }
    // Two members, so one per side bay and no internal split.
    const layout = layoutMembers(view.members);
    expect(layout.bays.map((bay) => bay.members.length)).toEqual([1, 1]);
    expect(layout.bays.every((bay) => !bay.split)).toBe(true);
  });
});

describe("no fabricated progress", () => {
  it("shows nothing for a member before its first event", () => {
    const beforeDispatch = result.events.slice(
      0,
      result.events.findIndex((event) => event.body.type === "agent_dispatched"),
    );
    const early = buildTaskView(team, "acceptance", beforeDispatch);

    expect(early.members.every((member) => member.status === "idle")).toBe(true);
    expect(early.members.every((member) => member.stages.length === 0)).toBe(true);
    expect(early.artifact).toBeUndefined();
  });

  it("derives every rendered pane entry from an event", () => {
    const stageCount = eventsOfType(result.events, "agent_stage").length;
    const renderedStages = [view.orchestrator, ...view.members].reduce(
      (total, member) => total + member.stages.length,
      0,
    );
    expect(renderedStages).toBe(stageCount);

    const toolCallCount = eventsOfType(result.events, "tool_call").length;
    const renderedToolCalls = [view.orchestrator, ...view.members].reduce(
      (total, member) =>
        total +
        member.toolCalls.length +
        member.subAgents.reduce((nested, subAgent) => nested + subAgent.toolCalls.length, 0),
      0,
    );
    expect(renderedToolCalls).toBe(toolCallCount);
  });
});
