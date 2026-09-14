import type {
  AgentContribution,
  AgentDefinition,
  AgentQuestion,
  ClockPort,
  FsPort,
  LoggerPort,
  MemberTask,
  ModelBinding,
  NamedJsonSchema,
  OutputPort,
  ProviderCapabilities,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeEventBody,
  RuntimeEventListener,
  SearchPort,
  SourceNote,
  TaskBrief,
  TaskStatus,
  TeamDefinition,
  TokenUsage,
  UserPort,
  YtripleConfig,
} from "@ytriple/shared";
import {
  EMPTY_TOKEN_USAGE,
  ProviderError,
  addUsage,
  displayNamesOf,
  membersOf,
  noopLogger,
  orchestratorOf,
  resolveLimits,
  resolveWorkspacePolicy,
} from "@ytriple/shared";
import { runAgentLoop, type GroundingFlag } from "../agent/agentLoop.js";
import { createModelCaller, type BindingResolver, type ModelCaller } from "../agent/modelCall.js";
import {
  briefSection,
  capabilitiesSection,
  phaseSection,
  roleSection,
  toolsSection,
  transcriptSections,
} from "../agent/prompt.js";
import type { ContextSection } from "../context/contextBudget.js";
import { CONTEXT_PRIORITY } from "../context/contextBudget.js";
import { createEventBus, type EventBus } from "../events/bus.js";
import { createIdFactory, type IdFactory } from "../ids.js";
import {
  INTAKE_SCHEMA,
  MEMBER_QUESTIONS_SCHEMA,
  MERGE_SCHEMA,
  QUESTION_GATE_SCHEMA,
  buildBriefSchema,
} from "../schemas/runtimeSchemas.js";
import { createSession, type Session } from "../session/session.js";
import { createSubAgentLedger } from "../subagents/budget.js";
import { runSubAgent, type SubAgentOutcome } from "../subagents/subAgentRunner.js";
import { createOutputTool } from "../tools/outputTool.js";
import { createToolRegistry, type ToolRegistry } from "../tools/registry.js";
import { createSpawnSubAgentTool } from "../tools/spawnSubAgentTool.js";
import { TOOL_NAMES } from "../tools/toolNames.js";
import type { ToolDefinition } from "../tools/types.js";
import { createWebSearchTool, resolveWebSearchStrategy } from "../tools/webSearchTool.js";
import { createWorkspaceTools } from "../tools/workspaceTools.js";
import { assertValidTeam } from "../team/validation.js";
import { renderPrdMarkdown } from "./prdDocument.js";

export interface TaskRuntimePorts {
  /** Read-only workspace. Absent on hosts that do not expose one, e.g. a server. */
  fs?: FsPort | undefined;
  output: OutputPort;
  search?: SearchPort | undefined;
  clock: ClockPort;
  user: UserPort;
  logger?: LoggerPort | undefined;
}

export interface TaskRuntimeOptions {
  taskId: string;
  team: TeamDefinition;
  config: YtripleConfig;
  /** What the host says it can do. Tools are filtered against this. */
  capabilities: RuntimeCapabilities;
  ports: TaskRuntimePorts;
  resolveBinding: BindingResolver;
}

export interface TaskRunInput {
  userInput: string;
  /** Overrides the deliverable title; defaults to the brief's product object. */
  title?: string;
}

export interface TaskRunResult {
  taskId: string;
  status: TaskStatus;
  brief?: TaskBrief;
  contributions: AgentContribution[];
  subAgentOutcomes: SubAgentOutcome[];
  prd?: { path: string; markdown: string };
  usage: TokenUsage;
  events: RuntimeEvent[];
  error?: string;
}

export interface TaskRuntime {
  subscribe(listener: RuntimeEventListener): () => void;
  events(): RuntimeEvent[];
  run(input: TaskRunInput): Promise<TaskRunResult>;
}

interface AgentRuntimeContext {
  agent: AgentDefinition;
  binding: ModelBinding;
  capabilities: ProviderCapabilities;
  registry: ToolRegistry;
  grounding: GroundingFlag;
  sources: SourceNote[];
  subAgentOutcomes: SubAgentOutcome[];
}

/**
 * The one orchestration implementation.
 *
 * Nothing here branches on an agent id or a role name: members come from
 * `team.members`, their work comes from `brief.memberTasks`, and their output
 * shape comes from `role.outputSchema`. Swapping `prd.default` for a two- or
 * five-member team changes no code in this file.
 */
export function createTaskRuntime(options: TaskRuntimeOptions): TaskRuntime {
  const { team, config, ports } = options;
  const logger = ports.logger ?? noopLogger;
  const limits = resolveLimits(config);
  const workspacePolicy = resolveWorkspacePolicy(config);

  const bus: EventBus = createEventBus(options.taskId, ports.clock);
  const ids: IdFactory = createIdFactory();
  const session: Session = createSession(ports.clock, ids);
  const emit = (body: RuntimeEventBody) => {
    bus.emit(body);
  };

  const orchestrator = orchestratorOf(team);
  const members = membersOf(team);
  const displayNames = displayNamesOf(team);

  const bindingFor = (agent: AgentDefinition): ModelBinding =>
    config.agentModels?.[agent.agentId] ?? agent.model ?? team.defaultModel;

  const capabilityCache = new Map<string, ProviderCapabilities>();
  let totalUsage: TokenUsage = EMPTY_TOKEN_USAGE;
  const modelCaller: ModelCaller = createModelCaller({
    resolveBinding: options.resolveBinding,
    limits,
    emit,
    chargeUsage: (usage) => {
      totalUsage = addUsage(totalUsage, usage);
    },
  });

  return {
    subscribe: bus.subscribe,
    events: bus.history,
    async run(input) {
      const status = (next: TaskStatus) => emit({ type: "task_status", status: next });
      const contributions: AgentContribution[] = [];
      const allSubAgentOutcomes: SubAgentOutcome[] = [];
      let brief: TaskBrief | undefined;

      try {
        const capabilities = await negotiateCapabilities();
        assertValidTeam(team, {
          capabilities: (binding) => capabilityCache.get(bindingKey(binding)),
        });

        status("chatting");
        session.addUserMessage(input.userInput);

        const intake = await runIntake(capabilities);
        const questions = await runQuestionGate(intake, capabilities);
        if (questions.length > 0) await askUser(questions);

        status("brief_ready");
        brief = await buildBrief(capabilities);
        emit({ type: "task_brief_updated", brief });

        status("dispatching");
        const memberTasks = resolveMemberTasks(brief);
        for (const task of memberTasks) {
          emit({ type: "agent_dispatched", agentId: task.agentId, objective: task.objective });
        }

        status("running");
        const results = await Promise.all(
          memberTasks.map((task) => runMember(task, brief as TaskBrief, capabilities)),
        );
        for (const result of results) {
          if (!result) continue;
          contributions.push(result.contribution);
          allSubAgentOutcomes.push(...result.subAgentOutcomes);
        }

        status("merging");
        const merge = await runMerge(brief, contributions, capabilities);

        status("writing_outputs");
        const sources = contributions.flatMap((contribution) => contribution.sources);
        const markdown = renderPrdMarkdown({
          title: input.title ?? brief.productObject,
          brief,
          merge,
          sources,
        });
        const path = await writeDeliverable(markdown);

        status("completed");
        return {
          taskId: options.taskId,
          status: "completed",
          brief,
          contributions,
          subAgentOutcomes: allSubAgentOutcomes,
          prd: { path, markdown },
          usage: totalUsage,
          events: bus.history(),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        emit({
          type: "error",
          stage: "task",
          message,
          retryable: error instanceof ProviderError ? error.retryable : false,
          ...(error instanceof ProviderError ? { code: error.code } : {}),
          agentId: orchestrator.agentId,
        });
        status("failed");
        logger.log("error", "task_failed", { taskId: options.taskId, message });

        return {
          taskId: options.taskId,
          status: "failed",
          ...(brief ? { brief } : {}),
          contributions,
          subAgentOutcomes: allSubAgentOutcomes,
          usage: totalUsage,
          events: bus.history(),
          error: message,
        };
      }
    },
  };

  // ---------------------------------------------------------------- phases

  async function runIntake(capabilities: RuntimeCapabilities) {
    const value = await callOrchestrator(
      "intake",
      INTAKE_SCHEMA,
      capabilities,
      [
        phaseSection(
          "intake",
          [
            "Read the user's request and restate it in your own words.",
            "Decide whether the team can proceed. Prefer proceeding on a stated assumption.",
            "Add a question only when a missing fact would change the direction of the work.",
          ].join("\n"),
        ),
      ],
      "Understand the request and decide whether the team can start.",
    );

    const understanding = readString(value, "understanding") ?? "";
    if (understanding) {
      session.addAgentMessage(orchestrator.agentId, understanding);
      emit({ type: "agent_message", agentId: orchestrator.agentId, text: understanding });
    }
    return value;
  }

  /**
   * Members never speak to the user. They propose questions, the orchestrator
   * keeps the ones worth asking, and only those reach the shared chat.
   */
  async function runQuestionGate(
    intake: Record<string, unknown>,
    capabilities: RuntimeCapabilities,
  ): Promise<AgentQuestion[]> {
    if (limits.maxQuestionRounds <= 0) return [];
    if (readString(intake, "readiness") === "ready") return [];

    status_("agent_questioning");

    const proposals: Array<{ agent: AgentDefinition; question: string; reason: string }> =
      readQuestionList(intake).map((entry) => ({
        agent: orchestrator,
        question: entry.question,
        reason: entry.reason,
      }));

    const memberProposals = await Promise.all(
      members.map(async (member) => {
        if (member.role.questionPolicy.maxQuestionsPerTurn === 0) return [];
        try {
          const context = await agentContext(member, capabilities);
          const value = await callAgent({
            agent: member,
            context,
            phase: "member_questions",
            schema: MEMBER_QUESTIONS_SCHEMA,
            capabilities,
            extraSections: [
              phaseSection(
                "member_questions",
                [
                  "Propose questions for the user, inside your question policy only.",
                  `At most ${member.role.questionPolicy.maxQuestionsPerTurn}.`,
                  "The orchestrator decides which of them actually get asked, so propose only what would change your work.",
                  "An empty list is a good answer when you can proceed on an assumption.",
                ].join("\n"),
              ),
            ],
            instruction: "What do you need to know before you start?",
          });

          return readQuestionList(value)
            .slice(0, member.role.questionPolicy.maxQuestionsPerTurn)
            .map((entry) => ({ agent: member, question: entry.question, reason: entry.reason }));
        } catch (error) {
          // A member that cannot phrase a question is not a task failure.
          emit({
            type: "error",
            agentId: member.agentId,
            stage: "member_questions",
            message: error instanceof Error ? error.message : "unknown error",
            retryable: true,
          });
          return [];
        }
      }),
    );

    proposals.push(...memberProposals.flat());
    if (proposals.length === 0) return [];

    // Ids are assigned after every member has answered, in team order, so the
    // same run always produces the same question ids.
    const candidates: AgentQuestion[] = proposals.map((proposal) => ({
      questionId: ids.next("q"),
      agentId: proposal.agent.agentId,
      agentDisplayName: proposal.agent.displayName,
      question: proposal.question,
      reason: proposal.reason,
    }));

    const approved = await approveQuestions(candidates, capabilities);
    for (const question of approved) {
      session.addAgentQuestion(question.agentId, question.question, question.reason);
      emit({
        type: "agent_question",
        agentId: question.agentId,
        questionId: question.questionId,
        question: question.question,
        reason: question.reason,
      });
    }
    return approved;
  }

  async function approveQuestions(
    candidates: AgentQuestion[],
    capabilities: RuntimeCapabilities,
  ): Promise<AgentQuestion[]> {
    const value = await callOrchestrator(
      "question_gate",
      QUESTION_GATE_SCHEMA,
      capabilities,
      [
        phaseSection(
          "question_gate",
          [
            "Your members proposed these questions. Keep only the ones worth the user's time.",
            "Drop duplicates and anything you can reasonably assume. Order what remains.",
            "",
            ...candidates.map(
              (candidate) =>
                `- ${candidate.questionId} (${candidate.agentDisplayName}): ${candidate.question} [${candidate.reason}]`,
            ),
          ].join("\n"),
        ),
      ],
      "Approve the questions that are genuinely worth asking.",
    );

    const approvals = Array.isArray(value.approved) ? value.approved : [];
    const selected: AgentQuestion[] = [];

    for (const approval of approvals) {
      if (typeof approval !== "object" || approval === null) continue;
      const record = approval as Record<string, unknown>;
      const candidate = candidates.find((entry) => entry.questionId === record.questionId);
      if (!candidate || selected.includes(candidate)) continue;
      const rewritten = typeof record.rewritten === "string" ? record.rewritten.trim() : "";
      selected.push(rewritten.length > 0 ? { ...candidate, question: rewritten } : candidate);
    }

    return selected;
  }

  async function askUser(questions: AgentQuestion[]): Promise<void> {
    const answers = await ports.user.askQuestions(questions);
    for (const answer of answers) {
      const question = questions.find((entry) => entry.questionId === answer.questionId);
      if (!question || answer.text.trim().length === 0) continue;
      session.addUserMessage(`(${question.agentDisplayName}) ${answer.text}`, question.questionId);
      emit({ type: "user_answer", questionId: answer.questionId, text: answer.text });
    }
  }

  async function buildBrief(capabilities: RuntimeCapabilities): Promise<TaskBrief> {
    const value = await callOrchestrator(
      "brief",
      buildBriefSchema(members.map((member) => member.agentId)),
      capabilities,
      [
        phaseSection(
          "brief",
          [
            "Write the Task Brief that will be dispatched to the team.",
            "Give every member you want to involve one memberTasks entry addressed by agentId.",
            "Members this run:",
            ...members.map(
              (member) => `- ${member.agentId} (${member.displayName}): ${member.role.responsibility}`,
            ),
            "Keep objectives disjoint: what one member covers must be out of scope for the others.",
            "Do not plan work that needs a capability the host marked unavailable.",
          ].join("\n"),
        ),
      ],
      "Produce the Task Brief.",
    );

    return {
      productObject: readString(value, "productObject") ?? "",
      targetUser: readString(value, "targetUser") ?? "",
      coreScenario: readString(value, "coreScenario") ?? "",
      painOrProblem: readString(value, "painOrProblem") ?? "",
      v1Scope: readStringList(value, "v1Scope"),
      nonGoals: readStringList(value, "nonGoals"),
      successCriteria: readStringList(value, "successCriteria"),
      assumptions: readStringList(value, "assumptions"),
      openQuestions: readStringList(value, "openQuestions"),
      memberTasks: readMemberTasks(value),
      // Availability is a fact about the host, not something the model may claim.
      contextAvailability: {
        workspace: capabilities.workspaceRead,
        webSearch: capabilities.webSearch,
      },
    };
  }

  function resolveMemberTasks(taskBrief: TaskBrief): MemberTask[] {
    const known = new Set(members.map((member) => member.agentId));
    const tasks = taskBrief.memberTasks.filter((task) => known.has(task.agentId));

    if (tasks.length > 0) return tasks;

    // The orchestrator left the dispatch list empty. Fall back to one task per
    // member derived from its role, and say so rather than running an empty team.
    emit({
      type: "agent_stage",
      agentId: orchestrator.agentId,
      stage: "dispatch",
      detail: "brief contained no memberTasks; dispatching every member on its role responsibility",
    });
    const fallback = members.map((member) => ({
      agentId: member.agentId,
      objective: member.role.responsibility,
      mustCover: [...member.role.executionPolicy],
      outOfScope: [],
    }));
    taskBrief.memberTasks = fallback;
    return fallback;
  }

  async function runMember(
    task: MemberTask,
    taskBrief: TaskBrief,
    capabilities: RuntimeCapabilities,
  ): Promise<{ contribution: AgentContribution; subAgentOutcomes: SubAgentOutcome[] } | undefined> {
    const member = members.find((entry) => entry.agentId === task.agentId);
    if (!member) return undefined;

    try {
      const context = await agentContext(member, capabilities);
      const stage = (name: string, detail: string, sources?: SourceNote[]) =>
        emit({
          type: "agent_stage",
          agentId: member.agentId,
          stage: name,
          detail,
          ...(sources && sources.length > 0 ? { sources } : {}),
        });

      stage("start", task.objective);

      const result = await runAgentLoop({
        agentId: member.agentId,
        depth: 0,
        binding: context.binding,
        allowlist: member.tools,
        registry: context.registry,
        modelCaller,
        systemSections: [
          roleSection(member),
          toolsSection(
            member,
            context.registry.specsFor(member).map((spec) => spec.name),
          ),
          capabilitiesSection(capabilities),
          briefSection(taskBrief, task),
          transcriptSections(session.transcript(displayNames)).recent,
          phaseSection(
            "member_work",
            [
              "Do your part of the brief and return your structured contribution.",
              "Stay inside your objective; another member owns what is out of scope for you.",
            ].join("\n"),
          ),
        ],
        instruction: task.objective,
        schema: member.role.outputSchema,
        phase: "member_work",
        maxRounds: limits.maxToolRounds,
        maxToolCallsPerRound: limits.maxToolCallsPerRound,
        grounding: context.grounding,
        emit,
        onStage: stage,
      });

      const contribution: AgentContribution = {
        agentId: member.agentId,
        schemaId: member.role.outputSchema.name,
        payload: result.value,
        sources: dedupeSources([...context.sources, ...result.sources]),
        usage: result.usage,
        ...(context.subAgentOutcomes.some((outcome) => outcome.incomplete)
          ? { incomplete: true }
          : {}),
      };

      emit({
        type: "agent_contribution",
        agentId: member.agentId,
        schemaId: contribution.schemaId,
        payload: contribution.payload,
      });

      return { contribution, subAgentOutcomes: context.subAgentOutcomes };
    } catch (error) {
      // A blocked member does not fail the task: the orchestrator merges what
      // it has and records the gap.
      emit({
        type: "error",
        agentId: member.agentId,
        stage: "member_work",
        message: error instanceof Error ? error.message : "unknown error",
        retryable: error instanceof ProviderError ? error.retryable : false,
        ...(error instanceof ProviderError ? { code: error.code } : {}),
      });
      return undefined;
    }
  }

  async function runMerge(
    taskBrief: TaskBrief,
    contributions: AgentContribution[],
    capabilities: RuntimeCapabilities,
  ): Promise<Record<string, unknown>> {
    const missing = taskBrief.memberTasks
      .filter((task) => !contributions.some((entry) => entry.agentId === task.agentId))
      .map((task) => task.agentId);

    const value = await callOrchestrator(
      "merge",
      MERGE_SCHEMA,
      capabilities,
      [
        {
          id: "contributions",
          priority: CONTEXT_PRIORITY.workspaceSummaries,
          content: [
            "Member contributions:",
            ...contributions.map((contribution) =>
              [
                `--- ${displayNames[contribution.agentId] ?? contribution.agentId} (${contribution.schemaId}) ---`,
                JSON.stringify(contribution.payload, null, 2),
              ].join("\n"),
            ),
            ...(missing.length > 0
              ? [`These members produced nothing this run: ${missing.join(", ")}.`]
              : []),
          ].join("\n\n"),
        },
        briefSection(taskBrief),
        phaseSection(
          "merge",
          [
            "Merge the contributions into one clean PRD draft.",
            "Rewrite in your own words; never paste a member's raw output.",
            "Everything unresolved goes into assumptions or open questions, including anything a missing member would have covered.",
            "merge_notes is your short message to the user, not part of the PRD.",
          ].join("\n"),
        ),
      ],
      "Merge the team's work into the PRD.",
    );

    const notes = readString(value, "merge_notes");
    if (notes) {
      session.addAgentMessage(orchestrator.agentId, notes);
      emit({ type: "agent_message", agentId: orchestrator.agentId, text: notes });
    }
    return value;
  }

  async function writeDeliverable(markdown: string): Promise<string> {
    const filename = team.outputContract.primaryDocument;
    const result = await orchestratorRegistry().execute(
      orchestrator.tools,
      TOOL_NAMES.createOutputDocument,
      { content: markdown },
      { agentId: orchestrator.agentId, depth: 0, emit },
    );

    if (!result.ok) throw new Error(result.detail);

    const path = typeof result.data?.path === "string" ? result.data.path : filename;
    emit({ type: "artifact_written", filename, path });
    return path;
  }

  // ------------------------------------------------------------- utilities

  function status_(next: TaskStatus) {
    emit({ type: "task_status", status: next });
  }

  function bindingKey(binding: ModelBinding): string {
    return `${binding.providerId}/${binding.modelId}`;
  }

  async function capabilitiesOf(agent: AgentDefinition): Promise<ProviderCapabilities> {
    const binding = bindingFor(agent);
    const key = bindingKey(binding);
    const cached = capabilityCache.get(key);
    if (cached) return cached;

    const resolved = await options.resolveBinding(binding);
    const capabilities = resolved.adapter.describe(resolved.model);
    capabilityCache.set(key, capabilities);
    return capabilities;
  }

  /**
   * Capability negotiation: what the host offers, narrowed by what the bound
   * models can actually do. A capability that is off means the tool behind it
   * does not exist for this task.
   */
  async function negotiateCapabilities(): Promise<RuntimeCapabilities> {
    const modelCapabilities = await Promise.all(team.members.map(capabilitiesOf));
    const anyNativeSearch = modelCapabilities.some((entry) => entry.nativeWebSearch);

    return {
      ...options.capabilities,
      workspaceRead: options.capabilities.workspaceRead && ports.fs !== undefined,
      outputWrite: options.capabilities.outputWrite,
      webSearch:
        options.capabilities.webSearch && (anyNativeSearch || ports.search !== undefined),
      streaming: options.capabilities.streaming && modelCapabilities.some((entry) => entry.streaming),
    };
  }

  function baseTools(capabilities: RuntimeCapabilities): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    if (capabilities.workspaceRead && ports.fs) {
      tools.push(...createWorkspaceTools({ fs: ports.fs, policy: workspacePolicy }));
    }
    if (capabilities.outputWrite) {
      tools.push(
        createOutputTool({
          output: ports.output,
          taskId: options.taskId,
          primaryDocument: team.outputContract.primaryDocument,
        }),
      );
    }
    return tools;
  }

  function orchestratorRegistry(): ToolRegistry {
    return createToolRegistry(
      baseTools({ ...options.capabilities, workspaceRead: false, outputWrite: true }),
    );
  }

  /**
   * Per-agent tool wiring. Web search resolves against the agent's own model, so
   * whether a member can reach the web depends on its capabilities, never on
   * which seat it holds.
   */
  async function agentContext(
    agent: AgentDefinition,
    capabilities: RuntimeCapabilities,
  ): Promise<AgentRuntimeContext> {
    const binding = bindingFor(agent);
    const modelCapabilities = await capabilitiesOf(agent);
    const grounding: GroundingFlag = { requested: false };
    const sources: SourceNote[] = [];
    const subAgentOutcomes: SubAgentOutcome[] = [];

    const tools = baseTools(capabilities);

    if (capabilities.webSearch) {
      tools.push(
        createWebSearchTool({
          strategy: resolveWebSearchStrategy({
            capabilities: modelCapabilities,
            searchPort: ports.search,
          }),
          searchPort: ports.search,
          maxResults: 5,
          onNativeSearchRequested: () => {
            grounding.requested = true;
          },
          onSourcesFound: (found) => sources.push(...found),
        }),
      );
    }

    if (agent.canSpawnSubAgents && agent.subAgentBudget) {
      const ledger = createSubAgentLedger(agent.subAgentBudget, () => ports.clock.now());
      const subRegistry = createToolRegistry(tools);

      tools.push(
        createSpawnSubAgentTool({
          parent: agent,
          defaultTokenBudget: Math.max(
            1,
            Math.floor(agent.subAgentBudget.maxTokens / agent.subAgentBudget.maxSpawns),
          ),
          run: (request) =>
            runSubAgent(request, {
              parent: agent,
              parentDepth: 0,
              binding,
              ledger,
              registry: subRegistry,
              modelCaller,
              grounding,
              maxRounds: limits.maxToolRounds,
              maxToolCallsPerRound: limits.maxToolCallsPerRound,
              emit,
              nextSubAgentId: () => ids.next(`${agent.agentId}.sub`),
            }),
          onOutcome: (outcome) => {
            subAgentOutcomes.push(outcome);
            sources.push(...outcome.sources);
          },
        }),
      );
    }

    return {
      agent,
      binding,
      capabilities: modelCapabilities,
      registry: createToolRegistry(tools),
      grounding,
      sources,
      subAgentOutcomes,
    };
  }

  async function callOrchestrator(
    phase: string,
    schema: NamedJsonSchema,
    capabilities: RuntimeCapabilities,
    extraSections: ContextSection[],
    instruction: string,
  ): Promise<Record<string, unknown>> {
    const transcript = transcriptSections(session.transcript(displayNames));
    const outcome = await modelCaller.call({
      agentId: orchestrator.agentId,
      phase,
      round: 0,
      binding: bindingFor(orchestrator),
      systemSections: [
        roleSection(orchestrator),
        capabilitiesSection(capabilities),
        transcript.recent,
        ...(transcript.earlier ? [transcript.earlier] : []),
        ...extraSections,
      ],
      messages: [{ role: "user", content: instruction }],
      schema,
    });

    if (!outcome.value) {
      throw new ProviderError(`Orchestrator returned no ${schema.name}`, {
        providerId: bindingFor(orchestrator).providerId,
        code: "schema_violation",
      });
    }
    return outcome.value;
  }

  async function callAgent(args: {
    agent: AgentDefinition;
    context: AgentRuntimeContext;
    phase: string;
    schema: NamedJsonSchema;
    capabilities: RuntimeCapabilities;
    extraSections: ContextSection[];
    instruction: string;
  }): Promise<Record<string, unknown>> {
    const outcome = await modelCaller.call({
      agentId: args.agent.agentId,
      phase: args.phase,
      round: 0,
      binding: args.context.binding,
      systemSections: [
        roleSection(args.agent),
        capabilitiesSection(args.capabilities),
        transcriptSections(session.transcript(displayNames)).recent,
        ...args.extraSections,
      ],
      messages: [{ role: "user", content: args.instruction }],
      schema: args.schema,
    });

    if (!outcome.value) {
      throw new ProviderError(`${args.agent.agentId} returned no ${args.schema.name}`, {
        providerId: args.context.binding.providerId,
        code: "schema_violation",
      });
    }
    return outcome.value;
  }
}

export async function runTask(
  input: TaskRunInput,
  options: TaskRuntimeOptions,
): Promise<TaskRunResult> {
  return createTaskRuntime(options).run(input);
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
  const entry = value[key];
  return typeof entry === "string" && entry.trim().length > 0 ? entry.trim() : undefined;
}

function readStringList(value: Record<string, unknown>, key: string): string[] {
  const entry = value[key];
  return Array.isArray(entry)
    ? entry.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function readQuestionList(
  value: Record<string, unknown>,
): Array<{ question: string; reason: string }> {
  const entry = value.questions;
  if (!Array.isArray(entry)) return [];

  return entry.flatMap((candidate) => {
    if (typeof candidate !== "object" || candidate === null) return [];
    const record = candidate as Record<string, unknown>;
    const question = typeof record.question === "string" ? record.question.trim() : "";
    if (question.length === 0) return [];
    return [
      {
        question,
        reason: typeof record.reason === "string" ? record.reason : "",
      },
    ];
  });
}

function readMemberTasks(value: Record<string, unknown>): MemberTask[] {
  const entry = value.memberTasks;
  if (!Array.isArray(entry)) return [];

  return entry.flatMap((candidate) => {
    if (typeof candidate !== "object" || candidate === null) return [];
    const record = candidate as Record<string, unknown>;
    const agentId = typeof record.agentId === "string" ? record.agentId : "";
    if (agentId.length === 0) return [];
    return [
      {
        agentId,
        objective: typeof record.objective === "string" ? record.objective : "",
        mustCover: readStringList(record, "mustCover"),
        outOfScope: readStringList(record, "outOfScope"),
      },
    ];
  });
}

function dedupeSources(sources: readonly SourceNote[]): SourceNote[] {
  const unique = new Map<string, SourceNote>();
  for (const source of sources) {
    if (!unique.has(source.url)) unique.set(source.url, source);
  }
  return [...unique.values()];
}
