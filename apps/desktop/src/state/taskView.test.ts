import {
  createDefaultTeam,
  createFakeClock,
  createFakeOutputPort,
  createScriptedProviderAdapter,
  createScriptedUserPort,
  createTaskRuntime,
  requireRole,
} from "@ytriple/core";
import { DEMO_SCENARIO, scenarioToRecording } from "@ytriple/providers";
import type {
  AgentDefinition,
  ModelBinding,
  RuntimeEvent,
  TeamDefinition,
  YtripleConfig,
} from "@ytriple/shared";
import { describe, expect, it } from "vitest";
import { layoutMembers } from "./layout.js";
import { buildTaskView, type MemberView } from "./taskView.js";

const binding: ModelBinding = { providerId: "recorded", modelId: "recorded" };
const team = createDefaultTeam(binding);

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

/**
 * Drives the real runtime against the recorded scenario, so the view model is
 * tested against the event stream the app actually receives.
 */
async function recordedRun(): Promise<RuntimeEvent[]> {
  const recording = scenarioToRecording(DEMO_SCENARIO);
  const adapter = createScriptedProviderAdapter({
    capabilities: DEMO_SCENARIO.capabilities,
    handlers: {
      "*": (request) => {
        const key = [
          request.metadata.agentId,
          request.metadata.subAgentId ?? "-",
          request.metadata.phase,
          request.metadata.round,
        ].join("#");
        const entry =
          recording.entries.find((candidate) => candidate.key === key) ??
          recording.entries.find(
            (candidate) =>
              candidate.phase === request.metadata.phase &&
              candidate.agentId === request.metadata.agentId,
          );
        if (!entry) throw new Error(`no recorded entry for ${key}`);
        return entry.result;
      },
    },
  });

  const runtime = createTaskRuntime({
    taskId: "view-task",
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

  const result = await runtime.run({ userInput: DEMO_SCENARIO.userInput });
  expect(result.status).toBe("completed");
  return result.events;
}

describe("buildTaskView on a real run", () => {
  it("renders the shared chat from events alone", async () => {
    const view = buildTaskView(team, "view-task", await recordedRun());

    expect(view.chat[0]).toMatchObject({ kind: "user", displayName: "You" });
    expect(view.chat.some((entry) => entry.kind === "agent")).toBe(true);

    const questions = view.chat.filter((entry) => entry.kind === "question");
    expect(questions).toHaveLength(3);
    expect(questions.map((entry) => entry.displayName)).toEqual([
      "Conductor",
      "Researcher",
      "Specialist",
    ]);
    // Every question carries the reason its asker gave.
    expect(questions.every((entry) => (entry.reason ?? "").length > 0)).toBe(true);
    expect(view.pendingQuestions).toEqual([]);
  });

  it("exposes the brief and the artifact the run produced", async () => {
    const view = buildTaskView(team, "view-task", await recordedRun());

    expect(view.brief?.memberTasks.map((task) => task.agentId)).toEqual([
      "researcher",
      "specialist",
    ]);
    expect(view.artifact?.filename).toBe("prd.md");
    expect(view.status).toBe("completed");
  });

  it("fills each member pane from that member's own events", async () => {
    const view = buildTaskView(team, "view-task", await recordedRun());
    const researcher = view.members.find((member) => member.agentId === "researcher");
    const specialist = view.members.find((member) => member.agentId === "specialist");

    expect(view.members.map((member) => member.agentId)).toEqual(["researcher", "specialist"]);
    expect(researcher?.status).toBe("contributed");
    expect(researcher?.objective).toContain("调研");
    expect(researcher?.contribution?.schemaId).toBe("research_contribution");
    expect(specialist?.contribution?.schemaId).toBe("review_contribution");
    // Panels are labelled by the role, not by a hardcoded slot.
    expect(researcher?.panelSections).toContain("Sources");
    expect(specialist?.panelSections).toContain("Review checklist");
  });

  it("surfaces the degradations the run reported, attributed to an agent", async () => {
    const view = buildTaskView(team, "view-task", await recordedRun());

    // The recorded provider is JSON-mode only, so every schema call degrades.
    expect(view.degradations.length).toBeGreaterThan(0);
    expect(view.degradations[0]?.degradation.kind).toBe("structured_output");
    expect(view.degradations[0]?.degradation.to).toBe("json_mode");
    expect(view.degradations.every((entry) => entry.agentId !== undefined)).toBe(true);

    const researcher = view.members.find((member) => member.agentId === "researcher");
    expect(researcher?.degradations.length).toBeGreaterThan(0);
  });

  it("shows no sources and no research tool when the run could not search", async () => {
    const view = buildTaskView(team, "view-task", await recordedRun());
    const researcher = view.members.find((member) => member.agentId === "researcher");

    expect(researcher?.sources).toEqual([]);
    expect(researcher?.toolCalls.map((call) => call.tool)).not.toContain("web_search");
  });

  it("keeps the orchestrator out of the side bays", async () => {
    const view = buildTaskView(team, "view-task", await recordedRun());
    expect(view.orchestrator.agentId).toBe("conductor");
    expect(view.members.some((member) => member.isOrchestrator)).toBe(false);
  });

  it("accumulates usage per member and for the task", async () => {
    const view = buildTaskView(team, "view-task", await recordedRun());
    const perMember = [view.orchestrator, ...view.members].reduce(
      (total, member) => total + member.usage.inputTokens,
      0,
    );
    expect(view.usage.inputTokens).toBe(perMember);
    expect(view.usage.inputTokens).toBeGreaterThan(0);
  });
});

describe("buildTaskView shows only what happened", () => {
  it("starts empty: no members working, no brief, no artifact", () => {
    const view = buildTaskView(team, "task-1", []);

    expect(view.status).toBe("idle");
    expect(view.chat).toEqual([]);
    expect(view.brief).toBeUndefined();
    expect(view.artifact).toBeUndefined();
    expect(view.members.every((member) => member.status === "idle")).toBe(true);
    expect(view.members.every((member) => member.stages.length === 0)).toBe(true);
  });

  it("advances a member only as its own events arrive", () => {
    const events = (bodies: RuntimeEvent["body"][]): RuntimeEvent[] =>
      bodies.map((body, index) => ({ taskId: "task-1", seq: index, at: index, body }));

    const dispatched = buildTaskView(
      team,
      "task-1",
      events([{ type: "agent_dispatched", agentId: "researcher", objective: "look around" }]),
    );
    expect(dispatched.members[0]?.status).toBe("dispatched");
    expect(dispatched.members[1]?.status).toBe("idle");

    const working = buildTaskView(
      team,
      "task-1",
      events([
        { type: "agent_dispatched", agentId: "researcher", objective: "look around" },
        { type: "agent_stage", agentId: "researcher", stage: "start", detail: "looking" },
      ]),
    );
    expect(working.members[0]?.status).toBe("working");
  });

  it("marks a blocked member without failing the others", () => {
    const view = buildTaskView(team, "task-1", [
      {
        taskId: "task-1",
        seq: 0,
        at: 0,
        body: {
          type: "error",
          agentId: "researcher",
          stage: "member_work",
          message: "provider exploded",
          retryable: true,
        },
      },
    ]);

    expect(view.members[0]?.status).toBe("failed");
    expect(view.members[0]?.error).toEqual({ message: "provider exploded", retryable: true });
    expect(view.members[1]?.status).toBe("idle");
    expect(view.errors).toHaveLength(1);
  });

  it("lists a question as pending until its answer arrives", () => {
    const asked: RuntimeEvent = {
      taskId: "task-1",
      seq: 0,
      at: 0,
      body: {
        type: "agent_question",
        agentId: "specialist",
        questionId: "q-1",
        question: "Who is this for?",
        reason: "scope",
      },
    };
    expect(buildTaskView(team, "task-1", [asked]).pendingQuestions).toHaveLength(1);

    const answered: RuntimeEvent = {
      taskId: "task-1",
      seq: 1,
      at: 1,
      body: { type: "user_answer", questionId: "q-1", text: "solo builders" },
    };
    expect(buildTaskView(team, "task-1", [asked, answered]).pendingQuestions).toEqual([]);
  });
});

describe("sources found by a tool reach the panel", () => {
  /**
   * The SearchPort fallback returned sources on the ToolResult, which reached
   * the contribution but never the event stream, so the research panel — which
   * is built from events alone — showed nothing.
   */
  it("shows sources a tool returned, not only ones the provider grounded", () => {
    const view = buildTaskView(team, "task-1", [
      {
        taskId: "task-1",
        seq: 0,
        at: 0,
        body: {
          type: "agent_stage",
          agentId: "researcher",
          stage: "sources",
          detail: "2 source(s) from web_search",
          sources: [
            { title: "One", url: "https://example.com/one", origin: "search_port" },
            { title: "Two", url: "https://example.com/two", origin: "search_port" },
          ],
        },
      },
    ]);

    const researcher = view.members.find((member) => member.agentId === "researcher");
    expect(researcher?.sources).toHaveLength(2);
    expect(researcher?.sources[0]?.origin).toBe("search_port");
  });
});

describe("sub-agents render inside their parent", () => {
  const nested: RuntimeEvent[] = [
    {
      taskId: "task-1",
      seq: 0,
      at: 0,
      body: {
        type: "subagent_spawned",
        parentAgentId: "researcher",
        subAgentId: "researcher.sub-1",
        objective: "map competitors",
        depth: 1,
        tools: ["web_search"],
        tokenBudget: 5000,
      },
    },
    {
      taskId: "task-1",
      seq: 1,
      at: 1,
      body: {
        type: "tool_call",
        agentId: "researcher",
        subAgentId: "researcher.sub-1",
        tool: "web_search",
        intent: "query=competitors",
        outcome: "ok",
        detail: "2 sources",
      },
    },
    {
      taskId: "task-1",
      seq: 2,
      at: 2,
      body: {
        type: "subagent_completed",
        parentAgentId: "researcher",
        subAgentId: "researcher.sub-1",
        summary: "three tools compete",
        tokensUsed: 1200,
      },
    },
  ];

  it("nests the sub-agent under the parent rather than beside it", () => {
    const view = buildTaskView(team, "task-1", nested);
    const researcher = view.members.find((member) => member.agentId === "researcher");

    expect(view.members).toHaveLength(2);
    expect(researcher?.subAgents).toHaveLength(1);
    expect(researcher?.subAgents[0]).toMatchObject({
      subAgentId: "researcher.sub-1",
      status: "completed",
      summary: "three tools compete",
      tokensUsed: 1200,
    });
    // The sub-agent's tool call belongs to the sub-agent, not to the parent.
    expect(researcher?.toolCalls).toHaveLength(0);
    expect(researcher?.subAgents[0]?.toolCalls).toHaveLength(1);
  });

  it("shows an aborted sub-agent with its reason", () => {
    const view = buildTaskView(team, "task-1", [
      nested[0]!,
      {
        taskId: "task-1",
        seq: 1,
        at: 1,
        body: {
          type: "subagent_aborted",
          parentAgentId: "researcher",
          subAgentId: "researcher.sub-1",
          reason: "token_budget_exhausted",
          detail: "used 6000 of 5000",
        },
      },
    ]);

    expect(view.members[0]?.subAgents[0]).toMatchObject({
      status: "aborted",
      abortReason: "token_budget_exhausted",
    });
  });
});

describe("three-bay layout", () => {
  function membersOfSize(size: number): MemberView[] {
    return Array.from({ length: size }, (_, index) => ({
      agentId: `member-${index}`,
      displayName: `Member ${index}`,
      roleId: "generic-contributor",
      roleDisplayName: "Contributor",
      responsibility: "",
      panelSections: [],
      isOrchestrator: false,
      status: "idle" as const,
      stages: [],
      toolCalls: [],
      sources: [],
      subAgents: [],
      degradations: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    }));
  }

  it("uses one bay for a single member", () => {
    const layout = layoutMembers(membersOfSize(1));
    expect(layout.bays).toHaveLength(1);
    expect(layout.bays[0]?.split).toBe(false);
  });

  it("gives two members one bay each without splitting", () => {
    const layout = layoutMembers(membersOfSize(2));
    expect(layout.bays.map((bay) => bay.members.length)).toEqual([1, 1]);
    expect(layout.bays.every((bay) => !bay.split)).toBe(true);
  });

  it("splits a bay once it holds more than one member", () => {
    const layout = layoutMembers(membersOfSize(5));
    expect(layout.bays.map((bay) => bay.members.length)).toEqual([3, 2]);
    expect(layout.bays.every((bay) => bay.split)).toBe(true);
    expect(layout.totalMembers).toBe(5);
  });

  it("renders no side bay for a team with no contributors", () => {
    expect(layoutMembers([]).bays).toEqual([]);
  });
});

describe("a five-member team needs no UI changes", () => {
  it("produces a pane per contributor straight from the team definition", () => {
    const base = createDefaultTeam(binding);
    const extra: AgentDefinition[] = ["a", "b", "c", "d"].map((suffix, index) => ({
      agentId: `member-${suffix}`,
      displayName: `Member ${suffix.toUpperCase()}`,
      role: requireRole(index % 2 === 0 ? "technical-researcher" : "ux-reviewer"),
      tools: [],
      canSpawnSubAgents: false,
    }));
    const bigTeam: TeamDefinition = { ...base, members: [base.members[0]!, ...extra] };

    const view = buildTaskView(bigTeam, "task-1", []);
    const layout = layoutMembers(view.members);

    expect(view.members).toHaveLength(4);
    expect(view.members.map((member) => member.roleDisplayName)).toEqual([
      "Technical Researcher",
      "UX Reviewer",
      "Technical Researcher",
      "UX Reviewer",
    ]);
    expect(layout.bays.map((bay) => bay.members.length)).toEqual([2, 2]);
    expect(layout.bays.every((bay) => bay.split)).toBe(true);
  });
});
