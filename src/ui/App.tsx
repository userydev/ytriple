import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  BrainCircuit,
  CheckCircle2,
  ExternalLink,
  FileText,
  FolderOpen,
  Play,
  Search,
  Send,
  Settings,
  Wifi,
} from "lucide-react";
import type { TaskStatus } from "../runtime/types";
import {
  deliveryFiles,
  demoSequence,
  researchItems,
  specialistItems,
  statusLabels,
} from "./demoTask";
import {
  AGENCY_AGENT_DIVISIONS,
  AGENCY_AGENT_ROLES,
  AGENCY_AGENTS_SOURCE,
} from "../runtime/agencyAgentsCatalog";
import { roleReferenceForAgent } from "../runtime/agencyRoleReferences";

interface RunPrdTaskResponse {
  taskId: string;
  status: string;
  artifactsDir: string;
  files: string[];
  finalPrdMarkdown: string;
  assumptionsMarkdown: string;
  researchNotesMarkdown: string;
  specialistReviewMarkdown: string;
  researcher: {
    summary: string;
    key_findings: string[];
    concepts: Array<{ name: string; note: string }>;
    competitor_samples: Array<{ name: string; note: string }>;
    sources: Array<{ title: string; url: string; reason: string }>;
  };
  specialist: {
    role: string;
    summary: string;
    strengths: string[];
    risks: string[];
    missing_sections: string[];
    recommendations: string[];
  };
}

type AgentAuthor = "conductor" | "researcher" | "specialist";

interface ChatMessage {
  id: string;
  author: "user" | AgentAuthor;
  text: string;
}

interface AgentActivity {
  id: string;
  agent: AgentAuthor;
  title: string;
  detail: string;
  state: "waiting" | "active" | "done";
}

const initialComposer =
  "我想做一个桌面工具，把模糊的产品想法快速整理成 PRD 首稿，并且能附带调研和专业审查。";

const initialMessages: ChatMessage[] = [
  {
    id: "conductor-welcome",
    author: "conductor",
    text: "我会先把你的想法收束成 PRD brief，再调度 Researcher 做轻调研、Specialist 做产品审查，最后生成固定四文件交付包。先告诉我产品对象、目标用户、核心场景和你希望首稿解决的问题。",
  },
  {
    id: "researcher-welcome",
    author: "researcher",
    text: "我会负责轻调研。开始前最好告诉我：你认为的竞品、行业关键词、地域/语言范围，或者你最想验证的市场假设。",
  },
  {
    id: "specialist-welcome",
    author: "specialist",
    text: "我会用 Product Manager 视角审查 PRD。开始前最好补充：目标用户是谁、当前不做什么、成功指标怎么判断。",
  },
];

const initialActivities: AgentActivity[] = [
  {
    id: "researcher-standby",
    agent: "researcher",
    title: "Waiting for research scope",
    detail: "Needs product object, market keywords, competitors, or validation questions.",
    state: "waiting",
  },
  {
    id: "specialist-standby",
    agent: "specialist",
    title: "Waiting for review angle",
    detail: "Needs target user, non-goals, success metrics, and domain constraints.",
    state: "waiting",
  },
];

export function App() {
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [composer, setComposer] = useState(initialComposer);
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [outputRoot, setOutputRoot] = useState("");
  const [status, setStatus] = useState<TaskStatus>("drafting_input");
  const [completed, setCompleted] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<RunPrdTaskResponse | null>(null);
  const [agentActivities, setAgentActivities] = useState<AgentActivity[]>(initialActivities);

  const activeStep = useMemo(() => {
    const index = demoSequence.indexOf(status);
    return index < 0 ? 0 : index + 1;
  }, [status]);

  const taskBrief = useMemo(() => buildTaskBrief(messages), [messages]);
  const pendingBrief = useMemo(() => buildTaskBriefWithComposer(messages, composer), [messages, composer]);
  const canGenerate = pendingBrief.trim().length >= 8 && !isRunning;
  const roleLibraryStats = useMemo(
    () => ({
      divisions: AGENCY_AGENT_DIVISIONS.length,
      roles: AGENCY_AGENT_ROLES.length,
    }),
    [],
  );
  const conductorRole = roleReferenceForAgent("conductor");
  const researcherRole = roleReferenceForAgent("researcher");
  const specialistRole = roleReferenceForAgent("specialist");
  const researchProgress = getResearchProgress(status, Boolean(result));
  const researcherActivities = agentActivities.filter((activity) => activity.agent === "researcher");
  const specialistActivities = agentActivities.filter((activity) => activity.agent === "specialist");

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, result?.taskId, status]);

  function sendMessage() {
    const text = composer.trim();
    if (!text) {
      setError("请输入产品想法。");
      return;
    }

    setError("");
    setComposer("");
    const nextMessages = [...messages, { id: crypto.randomUUID(), author: "user" as const, text }];
    const userMessageCount = nextMessages.filter((message) => message.author === "user").length;

    if (userMessageCount === 1 && shouldQuickClarify(text)) {
      nextMessages.push({
        id: crypto.randomUUID(),
        author: "conductor",
        text: "Quick Clarify：请再补一句目标用户、最核心使用场景或你希望首稿重点解决的问题。也可以直接点击 Generate PRD，我会把缺失信息写入假设与未决问题。",
      });
      nextMessages.push({
        id: crypto.randomUUID(),
        author: "researcher",
        text: "为了让调研不发散，我需要一个调研焦点：竞品是谁、目标市场在哪，或者你最想验证哪条公开事实？",
      });
      nextMessages.push({
        id: crypto.randomUUID(),
        author: "specialist",
        text: "为了后续 PRD 审查，我需要知道这个产品第一版明确不做什么，以及成功指标更偏效率、质量还是商业转化？",
      });
      setStatus("quick_clarify");
    } else {
      nextMessages.push({
        id: crypto.randomUUID(),
        author: "conductor",
        text: "已记录。我会把这些输入作为同一 PRD 任务上下文。继续补充细节，或点击 Generate PRD 生成固定四文件交付包。",
      });
      if (userMessageCount === 1) {
        nextMessages.push({
          id: crypto.randomUUID(),
          author: "researcher",
          text: "调研侧我会围绕关键概念、公开事实、轻量竞品样本和可验证假设展开，不做深度行业报告。",
        });
        nextMessages.push({
          id: crypto.randomUUID(),
          author: "specialist",
          text: "专家侧我会重点看问题定义、目标用户、范围边界、成功指标、非目标、风险和缺失章节。",
        });
      }
      if (status === "quick_clarify") {
        setStatus("drafting_input");
      }
    }

    setMessages(nextMessages);
  }

  async function startDraft() {
    const pendingComposer = composer.trim();
    const messagesForRun = pendingComposer
      ? [...messages, { id: crypto.randomUUID(), author: "user" as const, text: pendingComposer }]
      : messages;
    const userInput = buildTaskBrief(messagesForRun);
    if (!userInput.trim()) {
      setError("请先在聊天中发送产品想法。");
      return;
    }

    setError("");
    if (pendingComposer) {
      setMessages(messagesForRun);
      setComposer("");
    }
    setCompleted(false);
    setResult(null);
    setAgentActivities(seedRuntimeActivities(userInput));
    setIsRunning(true);
    setStatus("classifying");

    const unlisten = await listen<TaskStatus>("task_status", (event) => {
      setStatus(event.payload);
    });
    const unlistenActivity = await listen<Omit<AgentActivity, "id">>("agent_activity", (event) => {
      const incoming: AgentActivity = { ...event.payload, id: crypto.randomUUID() };
      setAgentActivities((current) => markPreviousDone([...current, incoming], incoming.agent));
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          author: incoming.agent,
          text: `${incoming.title}：${incoming.detail}`,
        },
      ]);
    });

    try {
      await wait(120);
      setStatus("preparing_context");
      await wait(120);
      setStatus("running_researcher");
      const response = await invoke<RunPrdTaskResponse>("run_prd_task", {
        request: {
          userInput,
          workspaceRoot: workspaceRoot.trim() || null,
          outputRoot: outputRoot.trim() || null,
        },
      });
      setStatus("completed");
      setResult(response);
      setCompleted(true);
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          author: "conductor",
          text: `交付包已生成：${response.artifactsDir}`,
        },
      ]);
    } catch (caught) {
      setStatus("failed");
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      unlisten();
      unlistenActivity();
      setIsRunning(false);
    }
  }

  const researchDisplay = result
    ? {
        question: taskBrief || "Waiting for product idea",
        concepts: result.researcher.concepts.map((item) => `${item.name}: ${item.note}`),
        sources: result.researcher.sources,
        summary: result.researcher.summary,
      }
    : researchItems;
  const specialistDisplay = result
    ? {
        role: "Product Lead",
        risks: result.specialist.risks,
        missing: result.specialist.missing_sections,
        recommendations: result.specialist.recommendations,
        summary: result.specialist.summary,
      }
    : specialistItems;

  async function chooseWorkspaceRoot() {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: "Select read-only workspace",
    });
    if (typeof selected === "string") {
      setWorkspaceRoot(selected);
    }
  }

  async function chooseOutputRoot() {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: "Select output root",
    });
    if (typeof selected === "string") {
      setOutputRoot(selected);
    }
  }

  async function openOutputFolder() {
    if (!result?.artifactsDir) {
      return;
    }
    await openPath(result.artifactsDir);
  }

  function applyBriefGuide() {
    setComposer(
      [
        "产品对象：",
        "目标用户：",
        "核心场景：",
        "当前痛点：",
        "首稿希望重点解决：",
        "明确不做：",
        "成功标准：",
      ].join("\n"),
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">yT</div>
          <div>
            <h1>yTriple</h1>
            <p>Three Agents, One Perfect Output.</p>
          </div>
        </div>
        <div className="topbar-actions">
          <button className="workspace-button" type="button" onClick={chooseWorkspaceRoot}>
            <FolderOpen size={16} />
            Workspace: {workspaceRoot ? "attached" : "optional"}
          </button>
          <button className="icon-button" type="button" aria-label="Settings">
            <Settings size={18} />
          </button>
        </div>
      </header>

      <section className="task-header">
        <div>
          <span className="template-label">PRD</span>
          <h2>PRD First Draft Task</h2>
        </div>
        <div className="status-cluster">
          <span className={`status-pill status-${status}`}>{statusLabels[status]}</span>
          <span className="step-count">{activeStep}/7</span>
        </div>
      </section>

      <section className="tri-panel" aria-label="Fixed tri-agent workspace">
        <aside className="side-panel research-panel">
          <PanelTitle icon={<Search size={18} />} title="Researcher" meta={<Wifi size={15} />} />
          {researcherRole ? (
            <div className="role-card role-card-research">
              <span>Agency role</span>
              <strong>{researcherRole.name}</strong>
              <p>{researcherRole.positioning}</p>
              <small>{researcherRole.sourceSlug}</small>
            </div>
          ) : null}
          <div className="panel-section">
            <h3>Research progress</h3>
            <div className="agent-progress-list">
              {[...researchProgress, ...researcherActivities].map((item) => (
                <div className={`agent-progress-row progress-${item.state}`} key={activityKey(item)}>
                  <span />
                  <div>
                    <strong>{"label" in item ? item.label : item.title}</strong>
                    <small>{item.detail}</small>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="panel-section">
            <h3>Current question</h3>
            <p>{taskBrief || researchDisplay.question}</p>
          </div>
          <div className="panel-section">
            <h3>Key concepts</h3>
            <ul className="compact-list">
              {researchDisplay.concepts.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div className="panel-section">
            <h3>Sources</h3>
            <div className="source-list">
              {researchDisplay.sources.map((source) => (
                <article className="source-row" key={source.url}>
                  <strong>{source.title}</strong>
                  <span>{source.reason}</span>
                </article>
              ))}
            </div>
          </div>
          <p className="panel-summary">{researchDisplay.summary}</p>
        </aside>

        <section className="center-panel">
          <div className="nexus-header">
            <div>
              <h2>Conductor Nexus</h2>
              <p>Template PRD · Ark Responses · Web Search for Researcher · Workspace read-only</p>
            </div>
            <FileText size={22} />
          </div>

          <div className="task-console">
            <div className="runtime-track">
              {demoSequence.map((item) => (
                <div
                  className={`runtime-step ${
                    demoSequence.indexOf(item) <= demoSequence.indexOf(status) ? "is-active" : ""
                  }`}
                  key={item}
                >
                  <span />
                  {statusLabels[item]}
                </div>
              ))}
            </div>

            <div className="context-actions">
              <button className="secondary-button path-button" type="button" onClick={chooseWorkspaceRoot}>
                <FolderOpen size={16} />
                {workspaceRoot ? "Workspace Attached" : "Select Workspace"}
              </button>
              <button className="secondary-button path-button" type="button" onClick={chooseOutputRoot}>
                <FolderOpen size={16} />
                {outputRoot ? "Output Selected" : "Select Output"}
              </button>
            </div>
          </div>

          <div className="chat-stream" aria-label="Conductor conversation">
            {messages.map((message) => (
              <article className={`chat-message chat-${message.author}`} key={message.id}>
                <span>{agentLabel(message.author)}</span>
                <p>{message.text}</p>
              </article>
            ))}

            {result ? (
              <article className="result-block">
                <div className="result-header">
                  <div>
                    <h3>Output folder</h3>
                    <p>{result.artifactsDir}</p>
                  </div>
                  <button className="secondary-button" type="button" onClick={openOutputFolder}>
                    <ExternalLink size={16} />
                    Open Folder
                  </button>
                </div>
                <div className="delivery-list delivery-list-inline">
                  {deliveryFiles.map((file) => (
                    <div className="delivery-file" key={file}>
                      <FileText size={15} />
                      {file}
                    </div>
                  ))}
                </div>
                <div>
                  <h3>Final PRD preview</h3>
                  <pre>{result.finalPrdMarkdown}</pre>
                </div>
              </article>
            ) : null}
            <div ref={chatEndRef} aria-hidden="true" />
          </div>

          {error ? <div className="error-block">{error}</div> : null}

          <div className="composer-dock">
            <label htmlFor="task-input">
              Message the agent team
              {conductorRole ? <span>{conductorRole.name}</span> : null}
            </label>
            <textarea
              id="task-input"
              value={composer}
              onChange={(event) => setComposer(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  sendMessage();
                }
              }}
              rows={3}
              placeholder="回复 Conductor / Researcher / Specialist 的问题，补充目标用户、调研范围、专家审查角度..."
            />
            <div className="composer-actions">
              <button className="secondary-button" type="button" onClick={applyBriefGuide} disabled={isRunning}>
                Use Outline
              </button>
              <button className="secondary-button" type="button" onClick={sendMessage} disabled={isRunning}>
                <Send size={16} />
                Send
              </button>
              <button className="primary-button" type="button" onClick={startDraft} disabled={!canGenerate}>
                <Play size={16} />
                {isRunning ? "Drafting..." : "Generate PRD"}
              </button>
            </div>
          </div>
        </section>

        <aside className="side-panel specialist-panel">
          <PanelTitle icon={<BrainCircuit size={18} />} title="Specialist" meta={specialistDisplay.role} />
          {specialistRole ? (
            <div className="role-card role-card-specialist">
              <span>Agency role</span>
              <strong>{specialistRole.name}</strong>
              <p>{specialistRole.positioning}</p>
              <small>{specialistRole.sourceSlug}</small>
            </div>
          ) : null}
          <div className="role-library-card">
            <span>Role library</span>
            <strong>{AGENCY_AGENTS_SOURCE.repository}</strong>
            <p>
              {roleLibraryStats.divisions} divisions · {roleLibraryStats.roles} referenced roles · {AGENCY_AGENTS_SOURCE.license}
            </p>
          </div>
          <div className="panel-section">
            <h3>Thinking process</h3>
            <div className="agent-progress-list">
              {specialistActivities.map((item) => (
                <div className={`agent-progress-row progress-${item.state}`} key={item.id}>
                  <span />
                  <div>
                    <strong>{item.title}</strong>
                    <small>{item.detail}</small>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="panel-section">
            <h3>Risks</h3>
            <ul className="compact-list warning-list">
              {specialistDisplay.risks.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div className="panel-section">
            <h3>Missing sections</h3>
            <ul className="compact-list">
              {specialistDisplay.missing.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div className="panel-section">
            <h3>Recommendations</h3>
            <ul className="compact-list">
              {specialistDisplay.recommendations.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <p className="panel-summary">{specialistDisplay.summary}</p>
          {completed ? (
            <div className="complete-note">
              <CheckCircle2 size={16} />
              Specialist review included
            </div>
          ) : null}
        </aside>
      </section>
    </main>
  );
}

function PanelTitle({
  icon,
  title,
  meta,
}: {
  icon: React.ReactNode;
  title: string;
  meta: React.ReactNode;
}) {
  return (
    <div className="panel-title">
      <div>
        {icon}
        <span>{title}</span>
      </div>
      <span className="panel-meta">{meta}</span>
    </div>
  );
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function getResearchProgress(status: TaskStatus, hasResult: boolean) {
  const currentIndex = demoSequence.indexOf(status);
  const isDone = (step: TaskStatus) =>
    hasResult || status === "completed" || (currentIndex >= 0 && currentIndex > demoSequence.indexOf(step));
  const isActive = (step: TaskStatus) => status === step;

  return [
    {
      label: "Context intake",
      detail: "User brief and optional workspace",
      state: isDone("preparing_context") ? "done" : isActive("preparing_context") ? "active" : "waiting",
    },
    {
      label: "Web light research",
      detail: "Ark web_search only in Researcher",
      state: isDone("running_researcher") ? "done" : isActive("running_researcher") ? "active" : "waiting",
    },
    {
      label: "Evidence separation",
      detail: "Facts, inferences, and assumptions",
      state: isDone("running_specialist") ? "done" : isActive("running_researcher") ? "active" : "waiting",
    },
    {
      label: "Research notes",
      detail: "Written to 03-research-notes.md",
      state: hasResult ? "done" : status === "writing_outputs" ? "active" : "waiting",
    },
  ] satisfies Array<{ label: string; detail: string; state: "waiting" | "active" | "done" }>;
}

function buildTaskBrief(messages: ChatMessage[]) {
  return messages
    .filter((message) => message.author === "user")
    .map((message, index) => `User turn ${index + 1}:\n${message.text}`)
    .join("\n\n");
}

function buildTaskBriefWithComposer(messages: ChatMessage[], composer: string) {
  const pending = composer.trim();
  if (!pending) {
    return buildTaskBrief(messages);
  }
  return buildTaskBrief([...messages, { id: "pending", author: "user", text: pending }]);
}

function agentLabel(author: ChatMessage["author"]) {
  if (author === "user") {
    return "You";
  }
  if (author === "researcher") {
    return "Researcher";
  }
  if (author === "specialist") {
    return "Specialist";
  }
  return "Conductor";
}

function seedRuntimeActivities(userInput: string): AgentActivity[] {
  const shortInput = userInput.replace(/\s+/g, " ").slice(0, 120);
  return [
    {
      id: "researcher-runtime-scope",
      agent: "researcher",
      title: "Research scope",
      detail: `Preparing light research around: ${shortInput}`,
      state: "active",
    },
    {
      id: "specialist-runtime-angle",
      agent: "specialist",
      title: "Review angle",
      detail: "Preparing Product Manager review: problem framing, users, scope, success metrics, risks.",
      state: "active",
    },
  ];
}

function markPreviousDone(activities: AgentActivity[], agent: AgentAuthor): AgentActivity[] {
  const lastIndex = activities.map((activity) => activity.agent).lastIndexOf(agent);
  return activities.map((activity, index) =>
    activity.agent === agent && index < lastIndex && activity.state === "active"
      ? { ...activity, state: "done" as const }
      : activity,
  );
}

function activityKey(item: { label?: string; id?: string }) {
  return item.id ?? item.label ?? crypto.randomUUID();
}

function shouldQuickClarify(text: string) {
  const normalized = text.trim();
  if (normalized.length < 80) {
    return true;
  }

  const hasAudience = /用户|客户|人群|团队|developer|founder|manager|user/i.test(normalized);
  const hasScenario = /场景|流程|任务|问题|痛点|需求|use case|workflow/i.test(normalized);
  return !(hasAudience && hasScenario);
}
