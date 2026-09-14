import type {
  AgentDefinition,
  GenerateRequest,
  ModelBinding,
  RuntimeEvent,
  TeamDefinition,
  YtripleConfig,
} from "@ytriple/shared";
import { DEFAULT_RUNTIME_LIMITS, eventsOfType, isEventOfType } from "@ytriple/shared";
import { describe, expect, it } from "vitest";
import { requireRole } from "../team/roleLibrary.js";
import { createDefaultTeam } from "../team/presets.js";
import { validateTeam } from "../team/validation.js";
import {
  FULL_CAPABILITIES,
  HOSTED_CAPABILITIES,
  createFakeClock,
  createFakeFsPort,
  createFakeOutputPort,
  createFakeSearchPort,
  createScriptedProviderAdapter,
  createScriptedUserPort,
  type ScriptedHandler,
} from "../testing/fakes.js";
import { TOOL_NAMES } from "../tools/toolNames.js";
import { createTaskRuntime, type TaskRuntimeOptions } from "./taskRuntime.js";

const binding: ModelBinding = { providerId: "scripted", modelId: "scripted-model" };

const config: YtripleConfig = {
  providers: [
    {
      providerId: "scripted",
      adapterId: "openai_compatible",
      displayName: "Scripted",
      baseUrl: "https://scripted.invalid/v1",
      credentialRef: "SCRIPTED_KEY",
      models: [{ modelId: "scripted-model", displayName: "Scripted Model" }],
    },
  ],
  defaultModel: binding,
};

/** Handlers keyed by phase so the same script drives any team size. */
function defaultHandlers(overrides: Record<string, ScriptedHandler> = {}) {
  return {
    intake: () => ({
      understanding: "You want a tool that turns vague ideas into a developer-ready PRD.",
      readiness: "needs_questions",
      questions: [{ question: "Who is the first user?", reason: "It decides the scope." }],
    }),
    member_questions: (request: GenerateRequest) => ({
      questions: [
        {
          question: `What should ${request.metadata.agentId} focus on?`,
          reason: "It narrows my work.",
        },
      ],
    }),
    question_gate: () => ({
      approved: [{ questionId: "q-1" }, { questionId: "q-2" }],
      dropped_reason: "the rest are answerable by assumption",
    }),
    brief: (request: GenerateRequest) => ({
      productObject: "A desktop workshop that turns a vague idea into one PRD draft",
      targetUser: "Solo builders who write their own specs",
      coreScenario: "Paste a rough idea, answer two questions, get prd.md",
      painOrProblem: "A vague idea cannot be handed to a developer",
      v1Scope: ["Shared chat", "Task Brief", "Single prd.md output"],
      nonGoals: ["Team collaboration", "Custom agent topologies"],
      successCriteria: ["A first PRD draft in under ten minutes"],
      assumptions: ["The user already has a model key"],
      openQuestions: ["Which template comes after PRD"],
      memberTasks: memberIdsFrom(request).map((agentId) => ({
        agentId,
        objective: `Cover the ${agentId} angle`,
        mustCover: ["the core scenario"],
        outOfScope: ["writing the PRD itself"],
      })),
    }),
    member_work: (request: GenerateRequest) => {
      const canSearch = (request.tools ?? []).some((tool) => tool.name === TOOL_NAMES.webSearch);
      if (canSearch && request.metadata.round === 0) {
        return {
          text: "",
          toolCalls: [
            { toolCallId: "c1", name: TOOL_NAMES.webSearch, arguments: { query: "prd tooling" } },
          ],
          usage: { inputTokens: 40, outputTokens: 10 },
          degradations: [],
        };
      }
      return contributionFor(request);
    },
    merge: () => ({
      merge_notes: "Merged the team's work into a first PRD draft.",
      product_summary: "A desktop workshop that turns a vague product idea into one PRD draft.",
      problem_background: "Vague ideas cannot be handed to a developer.",
      target_users: "Solo builders and indie product people.",
      core_scenario: "Paste an idea, answer two questions, read prd.md.",
      v1_scope: ["Shared chat", "Task Brief", "Single prd.md"],
      non_goals: ["Team collaboration"],
      functional_requirements: [
        { title: "Shared conversation", detail: "One chat surface for the whole team." },
      ],
      ux_requirements: ["Show real events, never fake progress"],
      data_permission_runtime_requirements: ["Workspace access is read-only"],
      success_criteria: ["First draft in under ten minutes"],
      assumptions: ["The user brings their own model key"],
      open_questions: ["Which template comes second"],
    }),
    ...overrides,
  };
}

/** One payload that satisfies every curated role's contribution schema. */
function contributionFor(request: GenerateRequest) {
  return {
    summary: `${request.metadata.agentId} finished`,
    facts: [{ statement: "Solo builders skip PRDs", sourceUrl: "https://example.com/a" }],
    inferences: ["A faster first draft is the wedge"],
    checklist: [{ item: "Target user named", verdict: "ok" }],
    risks: [{ risk: "Scope creep", tradeoff: "Fewer templates in V1" }],
    recommendations: ["Ship one template"],
    key_points: ["One deliverable keeps the promise honest"],
    assumptions: ["Desktop first"],
    open_questions: ["How much research is enough"],
  };
}

function memberIdsFrom(request: GenerateRequest): string[] {
  // The brief prompt lists the dispatchable members; parse it so one script
  // works for a two-member and a five-member team alike.
  return [...request.system.matchAll(/^- (\S+) \(/gm)].map((match) => match[1] ?? "");
}

interface HarnessOptions {
  team?: TeamDefinition;
  handlers?: Record<string, ScriptedHandler>;
  capabilities?: TaskRuntimeOptions["capabilities"];
  withWorkspace?: boolean;
  withSearch?: boolean;
  modelCapabilities?: Parameters<typeof createScriptedProviderAdapter>[0]["capabilities"];
}

function harness(options: HarnessOptions = {}) {
  const team = options.team ?? createDefaultTeam(binding);
  const adapter = createScriptedProviderAdapter({
    handlers: options.handlers ?? defaultHandlers(),
    ...(options.modelCapabilities ? { capabilities: options.modelCapabilities } : {}),
  });
  const output = createFakeOutputPort("/out");
  const user = createScriptedUserPort(() => "The first user is a solo builder shipping side projects.");

  const runtime = createTaskRuntime({
    taskId: "task-1",
    team,
    config,
    capabilities: options.capabilities ?? FULL_CAPABILITIES,
    ports: {
      ...(options.withWorkspace === false
        ? {}
        : {
            fs: createFakeFsPort({
              files: { "README.md": "# Demo\nAn existing product note." },
            }),
          }),
      output,
      ...(options.withSearch === false
        ? {}
        : {
            search: createFakeSearchPort([
              { title: "PRD guide", url: "https://example.com/prd", snippet: "how to write one" },
            ]),
          }),
      clock: createFakeClock(),
      user,
    },
    resolveBinding: async () => ({
      adapter,
      model: { modelId: "scripted-model", displayName: "Scripted Model" },
    }),
  });

  return { runtime, adapter, output, user, team };
}

function statuses(events: RuntimeEvent[]): string[] {
  return eventsOfType(events, "task_status").map((body) => body.status);
}

describe("a complete task run", () => {
  it("walks the state machine and writes exactly one deliverable", async () => {
    const { runtime, output } = harness();
    const result = await runtime.run({ userInput: "我想做一个把模糊想法变成 PRD 的工具" });

    expect(result.status).toBe("completed");
    expect(statuses(result.events)).toEqual([
      "chatting",
      "agent_questioning",
      "brief_ready",
      "dispatching",
      "running",
      "merging",
      "writing_outputs",
      "completed",
    ]);
    expect(output.documents.size).toBe(1);
    expect([...output.documents.keys()]).toEqual(["/out/task-1/prd.md"]);
    expect(result.prd?.path).toBe("/out/task-1/prd.md");
  });

  it("publishes the brief before dispatching anyone", async () => {
    const { runtime } = harness();
    const result = await runtime.run({ userInput: "idea" });

    const briefIndex = result.events.findIndex((event) => isEventOfType(event, "task_brief_updated"));
    const firstDispatch = result.events.findIndex((event) =>
      isEventOfType(event, "agent_dispatched"),
    );
    expect(briefIndex).toBeGreaterThanOrEqual(0);
    expect(firstDispatch).toBeGreaterThan(briefIndex);
  });

  it("addresses member tasks by agentId and covers every dispatched member", async () => {
    const { runtime, team } = harness();
    const result = await runtime.run({ userInput: "idea" });

    const dispatched = eventsOfType(result.events, "agent_dispatched").map((body) => body.agentId);
    const contributors = team.members
      .filter((member) => member.agentId !== team.orchestratorId)
      .map((member) => member.agentId);

    expect(result.brief?.memberTasks.map((task) => task.agentId)).toEqual(contributors);
    expect(dispatched).toEqual(contributors);
  });

  it("labels each contribution with the schema its role declared", async () => {
    const { runtime, team } = harness();
    const result = await runtime.run({ userInput: "idea" });

    for (const contribution of result.contributions) {
      const member = team.members.find((entry) => entry.agentId === contribution.agentId);
      expect(contribution.schemaId).toBe(member?.role.outputSchema.name);
    }
    expect(result.contributions.map((entry) => entry.schemaId)).toEqual([
      "research_contribution",
      "review_contribution",
    ]);
  });

  it("routes member questions through the orchestrator before the user sees them", async () => {
    const { runtime, user } = harness();
    const result = await runtime.run({ userInput: "idea" });

    const asked = eventsOfType(result.events, "agent_question");
    // Three candidates were proposed; the gate approved two.
    expect(asked).toHaveLength(2);
    expect(user.asked.map((question) => question.questionId)).toEqual(["q-1", "q-2"]);
    expect(eventsOfType(result.events, "user_answer")).toHaveLength(2);
  });

  it("produces a PRD with every required section", async () => {
    const { runtime } = harness();
    const result = await runtime.run({ userInput: "idea" });
    const markdown = result.prd?.markdown ?? "";

    for (const heading of [
      "## Product Summary",
      "## Problem / Background",
      "## Target Users",
      "## Core Scenario",
      "## V1 Scope",
      "## Non-goals",
      "## Functional Requirements",
      "## UX / Interaction Requirements",
      "## Data / Permission / Runtime Requirements",
      "## Success Criteria",
      "## Assumptions and Open Questions",
      "## Source Notes",
    ]) {
      expect(markdown).toContain(heading);
    }
  });

  it("keeps raw member payloads out of the PRD body", async () => {
    const { runtime } = harness();
    const result = await runtime.run({ userInput: "idea" });

    expect(result.prd?.markdown).not.toContain("research_contribution");
    expect(result.prd?.markdown).not.toContain("researcher finished");
  });

  it("replays deterministically with an injected clock", async () => {
    const first = await harness().runtime.run({ userInput: "idea" });
    const second = await harness().runtime.run({ userInput: "idea" });

    expect(second.events.map((event) => `${event.seq}:${event.at}:${event.body.type}`)).toEqual(
      first.events.map((event) => `${event.seq}:${event.at}:${event.body.type}`),
    );
    expect(second.prd?.markdown).toEqual(first.prd?.markdown);
  });
});

describe("team size is data", () => {
  function teamOfSize(size: number): TeamDefinition {
    const base = createDefaultTeam(binding);
    const contributors: AgentDefinition[] = Array.from({ length: size - 1 }, (_, index) => ({
      agentId: `member-${index + 1}`,
      displayName: `Member ${index + 1}`,
      role: requireRole(index % 2 === 0 ? "product-trend-researcher" : "product-manager"),
      tools: [TOOL_NAMES.readWorkspaceFile],
      canSpawnSubAgents: false,
    }));

    return {
      ...base,
      members: [base.members[0]!, ...contributors],
    };
  }

  it.each([2, 5])("runs a %i-member team with the same orchestration code", async (size) => {
    const { runtime } = harness({ team: teamOfSize(size) });
    const result = await runtime.run({ userInput: "idea" });

    expect(result.status).toBe("completed");
    expect(result.contributions).toHaveLength(size - 1);
    expect(eventsOfType(result.events, "agent_dispatched")).toHaveLength(size - 1);
    expect(result.prd?.markdown).toContain("## Product Summary");
  });

  it("never emits an event keyed by a role name", async () => {
    const { runtime } = harness({ team: teamOfSize(3) });
    const result = await runtime.run({ userInput: "idea" });

    const agentIds = new Set(
      result.events.flatMap((event) =>
        "agentId" in event.body && typeof event.body.agentId === "string"
          ? [event.body.agentId]
          : [],
      ),
    );
    expect([...agentIds].sort()).toEqual(["conductor", "member-1", "member-2"]);
  });
});

describe("a brief with no member tasks", () => {
  const handlers = defaultHandlers({
    brief: () => ({
      productObject: "A thing",
      targetUser: "Someone",
      coreScenario: "They use it",
      painOrProblem: "It is hard today",
      v1Scope: ["one"],
      nonGoals: ["two"],
      successCriteria: ["three"],
      assumptions: [],
      openQuestions: [],
      memberTasks: [],
    }),
  });

  /**
   * Failing the whole task because the model dropped one field is worse than
   * proceeding, but proceeding silently would be a hidden decision. The
   * fallback must therefore always be announced on the event stream.
   */
  it("dispatches every member on its role and says so on the event stream", async () => {
    const { runtime, team } = harness({ handlers });
    const result = await runtime.run({ userInput: "idea" });

    const notice = eventsOfType(result.events, "agent_stage").find(
      (body) => body.stage === "dispatch",
    );
    expect(notice).toBeDefined();
    expect(notice?.agentId).toBe(team.orchestratorId);
    expect(notice?.detail).toBe(
      "brief contained no memberTasks; dispatching every member on its role responsibility",
    );

    const contributors = team.members
      .filter((member) => member.agentId !== team.orchestratorId)
      .map((member) => member.agentId);
    expect(eventsOfType(result.events, "agent_dispatched").map((body) => body.agentId)).toEqual(
      contributors,
    );
    expect(result.brief?.memberTasks.map((task) => task.agentId)).toEqual(contributors);
    expect(result.status).toBe("completed");
  });

  it("does not announce a fallback when the brief listed its members", async () => {
    const { runtime } = harness();
    const result = await runtime.run({ userInput: "idea" });

    expect(
      eventsOfType(result.events, "agent_stage").filter((body) => body.stage === "dispatch"),
    ).toEqual([]);
  });
});

describe("sub-agents stay an implementation detail", () => {
  const handlers = defaultHandlers({
    "researcher:member_work": (request: GenerateRequest) => {
      if (request.metadata.round === 0) {
        return {
          text: "",
          toolCalls: [
            {
              toolCallId: "c1",
              name: TOOL_NAMES.spawnSubAgent,
              arguments: {
                objective: "Map the competing PRD tools",
                instructions: "Name three products and the angle each takes.",
                tools: [TOOL_NAMES.webSearch],
                max_tokens: 5_000,
              },
            },
          ],
          usage: { inputTokens: 40, outputTokens: 10 },
          degradations: [],
        };
      }
      return contributionFor(request);
    },
    subagent_work: () => ({
      summary: "Three tools compete, none targets solo builders.",
      findings: ["Tool A sells templates", "Tool B sells interviews"],
    }),
  });

  it("reports nested progress without growing the team", async () => {
    const { runtime, team } = harness({ handlers });
    const result = await runtime.run({ userInput: "idea" });

    const spawned = eventsOfType(result.events, "subagent_spawned");
    expect(spawned).toMatchObject([
      { parentAgentId: "researcher", subAgentId: "researcher.sub-1", depth: 1 },
    ]);
    expect(eventsOfType(result.events, "subagent_completed")).toHaveLength(1);

    // The team the user sees is unchanged.
    expect(eventsOfType(result.events, "agent_dispatched")).toHaveLength(team.members.length - 1);
    expect(result.contributions).toHaveLength(team.members.length - 1);
    expect(result.subAgentOutcomes).toHaveLength(1);
  });

  it("keeps the sub-agent out of the shared conversation", async () => {
    const { runtime, adapter } = harness({ handlers });
    const result = await runtime.run({ userInput: "idea" });

    const chatAgents = [
      ...eventsOfType(result.events, "agent_message"),
      ...eventsOfType(result.events, "agent_question"),
    ].map((body) => body.agentId);
    expect(chatAgents.some((agentId) => agentId.includes(".sub-"))).toBe(false);

    const mergeRequest = adapter.requests.find((request) => request.metadata.phase === "merge");
    expect(mergeRequest?.system).not.toContain("researcher.sub-1");
  });

  /**
   * The three constraints were advertised as independently tested, but depth
   * was being reset on every spawn, so a nested sub-agent reported depth 1
   * forever and `maxDepth` above 1 could never be reached.
   */
  it("carries depth down so nesting accumulates rather than resetting", async () => {
    const nestingTeam = (() => {
      const base = createDefaultTeam(binding);
      return {
        ...base,
        members: base.members.map((member) =>
          member.agentId === "researcher"
            ? {
                ...member,
                subAgentBudget: {
                  maxDepth: 2,
                  maxSpawns: 3,
                  maxTokens: 40_000,
                  maxWallClockMs: 120_000,
                },
              }
            : member,
        ),
      };
    })();

    const spawnCall = (objective: string) => ({
      text: "",
      toolCalls: [
        {
          toolCallId: "c1",
          name: TOOL_NAMES.spawnSubAgent,
          arguments: {
            objective,
            instructions: "go",
            tools: [TOOL_NAMES.spawnSubAgent],
            max_tokens: 5_000,
          },
        },
      ],
      usage: { inputTokens: 20, outputTokens: 5 },
      degradations: [],
    });

    const { runtime } = harness({
      team: nestingTeam,
      handlers: defaultHandlers({
        "researcher:member_work": (request: GenerateRequest) =>
          request.metadata.round === 0 ? spawnCall("outer") : contributionFor(request),
        subagent_work: (request: GenerateRequest) => {
          // The depth-1 child spawns once; the depth-2 grandchild answers.
          const isFirstChild = request.metadata.subAgentId === "researcher.sub-1";
          if (isFirstChild && request.metadata.round === 0) return spawnCall("inner");
          return { summary: `${request.metadata.subAgentId} done`, findings: [] };
        },
      }),
    });

    const result = await runtime.run({ userInput: "idea" });
    const spawned = eventsOfType(result.events, "subagent_spawned");

    expect(spawned.map((body) => body.depth)).toEqual([1, 2]);
    expect(spawned[1]?.subAgentId).toBe("researcher.sub-2");
    // The depth-1 child could only spawn because it inherited the spawn tool.
    expect(spawned[0]?.tools).toContain(TOOL_NAMES.spawnSubAgent);
    // The depth-2 grandchild is at the limit, so it must not carry it.
    expect(spawned[1]?.tools).not.toContain(TOOL_NAMES.spawnSubAgent);
    expect(result.status).toBe("completed");
  });

  it("refuses to spawn past the depth limit instead of resetting the count", async () => {
    const { runtime } = harness({
      handlers: defaultHandlers({
        "researcher:member_work": (request: GenerateRequest) =>
          request.metadata.round === 0
            ? {
                text: "",
                toolCalls: [
                  {
                    toolCallId: "c1",
                    name: TOOL_NAMES.spawnSubAgent,
                    arguments: {
                      objective: "outer",
                      instructions: "go",
                      tools: [TOOL_NAMES.spawnSubAgent],
                      max_tokens: 5_000,
                    },
                  },
                ],
                usage: { inputTokens: 20, outputTokens: 5 },
                degradations: [],
              }
            : contributionFor(request),
        subagent_work: () => ({ summary: "done", findings: [] }),
      }),
    });

    const result = await runtime.run({ userInput: "idea" });
    const spawned = eventsOfType(result.events, "subagent_spawned");

    // prd.default allows one level, so the child gets no spawn tool at all.
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.depth).toBe(1);
    expect(spawned[0]?.tools).not.toContain(TOOL_NAMES.spawnSubAgent);
  });

  it("does not let a sub-agent's grounding leak into its parent's next call", async () => {
    const { runtime, adapter } = harness({
      handlers: defaultHandlers({
        "researcher:member_work": (request: GenerateRequest) =>
          request.metadata.round === 0
            ? {
                text: "",
                toolCalls: [
                  {
                    toolCallId: "c1",
                    name: TOOL_NAMES.spawnSubAgent,
                    arguments: {
                      objective: "look it up",
                      instructions: "search first",
                      tools: [TOOL_NAMES.webSearch],
                      max_tokens: 5_000,
                    },
                  },
                ],
                usage: { inputTokens: 20, outputTokens: 5 },
                degradations: [],
              }
            : contributionFor(request),
        subagent_work: (request: GenerateRequest) =>
          request.metadata.round === 0
            ? {
                text: "",
                toolCalls: [
                  {
                    toolCallId: "c2",
                    name: TOOL_NAMES.webSearch,
                    arguments: { query: "prd tooling" },
                  },
                ],
                usage: { inputTokens: 10, outputTokens: 5 },
                degradations: [],
              }
            : { summary: "found things", findings: ["a"] },
      }),
      modelCapabilities: { nativeWebSearch: true },
    });

    await runtime.run({ userInput: "idea" });

    const subAgentGrounded = adapter.requests.filter(
      (request) => request.metadata.subAgentId !== undefined && request.nativeWebSearch === true,
    );
    const parentGrounded = adapter.requests.filter(
      (request) =>
        request.metadata.subAgentId === undefined &&
        request.metadata.agentId === "researcher" &&
        request.nativeWebSearch === true,
    );

    expect(subAgentGrounded.length).toBeGreaterThan(0);
    expect(parentGrounded).toEqual([]);
  });

  it("folds the sub-agent's cost into its parent", async () => {
    const { runtime } = harness({ handlers });
    const result = await runtime.run({ userInput: "idea" });

    const outcome = result.subAgentOutcomes[0];
    expect(outcome?.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.inputTokens).toBeGreaterThan(outcome!.usage.inputTokens);
  });
});

describe("sources and links", () => {
  it("puts sources a tool returned onto the event stream", async () => {
    const { runtime } = harness();
    const result = await runtime.run({ userInput: "idea" });

    const sourceStages = eventsOfType(result.events, "agent_stage").filter(
      (body) => body.sources !== undefined && body.sources.length > 0,
    );

    expect(sourceStages.length).toBeGreaterThan(0);
    expect(sourceStages[0]?.agentId).toBe("researcher");
    expect(sourceStages[0]?.sources?.[0]?.origin).toBe("search_port");
  });

  it("writes an unsafe source URL as text rather than a link", async () => {
    const { runtime } = harness({
      withSearch: false,
      handlers: defaultHandlers({
        "researcher:member_work": (request: GenerateRequest) => {
          const canSearch = (request.tools ?? []).some(
            (tool) => tool.name === TOOL_NAMES.webSearch,
          );
          expect(canSearch).toBe(false);
          return contributionFor(request);
        },
      }),
    });

    const result = await runtime.run({ userInput: "idea" });
    // Nothing hostile can reach the document through the source list, and the
    // absence of sources means no section at all.
    expect(result.prd?.markdown).not.toContain("javascript:");
  });
});

describe("capability negotiation", () => {
  it("marks the workspace unavailable and withholds its tools on a host without one", async () => {
    const { runtime, adapter } = harness({
      withWorkspace: false,
      capabilities: HOSTED_CAPABILITIES,
    });
    const result = await runtime.run({ userInput: "idea" });

    expect(result.brief?.contextAvailability).toEqual({ workspace: false, webSearch: true });
    const memberRequest = adapter.requests.find(
      (request) => request.metadata.phase === "member_work",
    );
    const toolNames = (memberRequest?.tools ?? []).map((tool) => tool.name);
    expect(toolNames).not.toContain(TOOL_NAMES.readWorkspaceFile);
  });

  it("marks web search unavailable when neither the model nor the host can search", async () => {
    const { runtime, adapter } = harness({ withSearch: false });
    const result = await runtime.run({ userInput: "idea" });

    expect(result.brief?.contextAvailability.webSearch).toBe(false);
    const memberRequest = adapter.requests.find(
      (request) => request.metadata.phase === "member_work",
    );
    expect((memberRequest?.tools ?? []).map((tool) => tool.name)).not.toContain(
      TOOL_NAMES.webSearch,
    );
  });

  it("keeps web search when the bound model grounds natively even without a SearchPort", async () => {
    const { runtime } = harness({
      withSearch: false,
      modelCapabilities: { nativeWebSearch: true },
    });
    const result = await runtime.run({ userInput: "idea" });
    expect(result.brief?.contextAvailability.webSearch).toBe(true);
  });
});

describe("the brief is normalised before it is published", () => {
  const duplicateBrief = (request: GenerateRequest) => {
    const ids = memberIdsFrom(request);
    const task = (agentId: string) => ({
      agentId,
      objective: `Cover the ${agentId} angle`,
      mustCover: [],
      outOfScope: [],
    });
    // The same member twice. An id outside the team is already impossible: the
    // brief schema constrains agentId to an enum of the team's members.
    return {
      ...(defaultHandlers().brief(request) as Record<string, unknown>),
      memberTasks: [task(ids[0]!), task(ids[0]!), task(ids[1]!)],
    };
  };

  it("dispatches a member once even when the brief lists it twice", async () => {
    const { runtime } = harness({ handlers: defaultHandlers({ brief: duplicateBrief }) });
    const result = await runtime.run({ userInput: "idea" });

    const dispatched = eventsOfType(result.events, "agent_dispatched").map((body) => body.agentId);
    expect(dispatched).toEqual(["researcher", "specialist"]);
    expect(new Set(dispatched).size).toBe(dispatched.length);
    expect(result.contributions.map((entry) => entry.agentId)).toEqual([
      "researcher",
      "specialist",
    ]);
  });

  /**
   * A consumer reading the stream incrementally must never see a brief that is
   * later contradicted, so normalisation happens before the event is emitted.
   */
  it("publishes the dispatched member list, not the raw one", async () => {
    const { runtime } = harness({ handlers: defaultHandlers({ brief: duplicateBrief }) });
    const result = await runtime.run({ userInput: "idea" });

    const published = eventsOfType(result.events, "task_brief_updated")[0]?.brief;
    expect(published?.memberTasks.map((task) => task.agentId)).toEqual([
      "researcher",
      "specialist",
    ]);
  });

  it("emits the fallback brief before the brief event, not after", async () => {
    const { runtime } = harness({
      handlers: defaultHandlers({
        brief: (request: GenerateRequest) => ({
          ...(defaultHandlers().brief(request) as Record<string, unknown>),
          memberTasks: [],
        }),
      }),
    });
    const result = await runtime.run({ userInput: "idea" });

    const briefIndex = result.events.findIndex((event) => event.body.type === "task_brief_updated");
    const noticeIndex = result.events.findIndex(
      (event) => event.body.type === "agent_stage" && event.body.stage === "dispatch",
    );

    expect(noticeIndex).toBeGreaterThanOrEqual(0);
    expect(noticeIndex).toBeLessThan(briefIndex);
    // And the published brief already carries the substituted tasks.
    expect(
      eventsOfType(result.events, "task_brief_updated")[0]?.brief.memberTasks.length,
    ).toBe(2);
  });
});

describe("the question gate", () => {
  const fourCandidates = defaultHandlers({
    intake: () => ({
      understanding: "understood",
      readiness: "needs_questions",
      questions: [
        { question: "one?", reason: "r" },
        { question: "two?", reason: "r" },
      ],
    }),
    question_gate: () => ({
      // More than the cap, and the same id twice under different phrasings.
      approved: [
        { questionId: "q-1" },
        { questionId: "q-1", rewritten: "one, rephrased?" },
        { questionId: "q-2" },
        { questionId: "q-3" },
        { questionId: "q-4" },
      ],
      dropped_reason: "none",
    }),
  });

  it("asks a question once even when the gate approves its id twice", async () => {
    const { runtime, user } = harness({ handlers: fourCandidates });
    const result = await runtime.run({ userInput: "idea" });

    const asked = eventsOfType(result.events, "agent_question").map((body) => body.questionId);
    expect(new Set(asked).size).toBe(asked.length);
    expect(new Set(user.asked.map((question) => question.questionId)).size).toBe(user.asked.length);
  });

  it("never forwards more questions than the configured cap", async () => {
    const { runtime } = harness({ handlers: fourCandidates });
    const result = await runtime.run({ userInput: "idea" });

    expect(eventsOfType(result.events, "agent_question").length).toBeLessThanOrEqual(
      DEFAULT_RUNTIME_LIMITS.maxApprovedQuestions,
    );
  });

  it("offers the model a schema that matches the runtime cap", async () => {
    const { runtime, adapter } = harness({ handlers: fourCandidates });
    await runtime.run({ userInput: "idea" });

    const gate = adapter.requests.find((request) => request.metadata.phase === "question_gate");
    expect(gate?.responseSchema?.schema.properties?.approved?.maxItems).toBe(
      DEFAULT_RUNTIME_LIMITS.maxApprovedQuestions,
    );
  });
});

describe("the output step honours the host", () => {
  /**
   * The orchestrator registry used to force `outputWrite: true`, so a host that
   * had switched output off still got a file written behind its back.
   */
  it("writes nothing when the host disabled output, and fails the task", async () => {
    const { runtime, output } = harness({
      capabilities: { ...FULL_CAPABILITIES, outputWrite: false },
    });
    const result = await runtime.run({ userInput: "idea" });

    expect(output.documents.size).toBe(0);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/cannot write output/);
  });

  /**
   * Writing the deliverable is the runtime's own step, so it must not depend on
   * the orchestrator's model-facing tool list, which validateTeam does not
   * require to contain it.
   */
  it("writes the deliverable even when the orchestrator lists no tools", async () => {
    const base = createDefaultTeam(binding);
    const toollessOrchestrator: TeamDefinition = {
      ...base,
      members: base.members.map((member) =>
        member.agentId === base.orchestratorId ? { ...member, tools: [] } : member,
      ),
    };

    const { runtime, output } = harness({ team: toollessOrchestrator });
    const result = await runtime.run({ userInput: "idea" });

    expect(result.status).toBe("completed");
    expect(output.documents.size).toBe(1);
  });

  it("still refuses to give a member the output tool", () => {
    const base = createDefaultTeam(binding);
    const leaky: TeamDefinition = {
      ...base,
      members: base.members.map((member) =>
        member.agentId === "researcher"
          ? { ...member, tools: [...member.tools, TOOL_NAMES.createOutputDocument] }
          : member,
      ),
    };

    expect(validateTeam(leaky).map((issue) => issue.rule)).toContain("tools.outputOwnership");
  });
});

describe("recoverable and blocking failures", () => {
  it("merges what it has when one member fails", async () => {
    const { runtime } = harness({
      handlers: defaultHandlers({
        "researcher:member_work": () => {
          throw new Error("provider exploded");
        },
      }),
    });

    const result = await runtime.run({ userInput: "idea" });

    expect(result.status).toBe("completed");
    expect(result.contributions.map((entry) => entry.agentId)).toEqual(["specialist"]);
    expect(eventsOfType(result.events, "error")).toMatchObject([
      { agentId: "researcher", stage: "member_work" },
    ]);
    expect(result.prd?.markdown).toContain("## Product Summary");
  });

  it("fails the task when the orchestrator cannot produce a brief", async () => {
    const { runtime, output } = harness({
      handlers: defaultHandlers({ brief: () => ({ nonsense: true }) }),
    });

    const result = await runtime.run({ userInput: "idea" });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/task_brief/);
    expect(statuses(result.events).at(-1)).toBe("failed");
    expect(output.documents.size).toBe(0);
  });
});
