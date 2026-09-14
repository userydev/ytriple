# yTriple Agent Team Contract

## Status

Active。本文件取代旧 V1 文档里「固定三 Agent 槽位」的全部假设，包括 [V1 Product Contract](../product/v1-product-contract.md) 的 Agent Roles 一节、[V1 Role Selection Contract](../product/v1-role-selection-contract.md) 的 slot 模型、[V1 Agent Conversation Runtime Fix](../project/v1-agent-conversation-runtime-task.md) 的三字段事件模型。

前提定位见 [Positioning](../product/positioning.md)。运行环境边界见 [运行时边界契约](runtime-boundary-contract.md)。模型绑定见 [Provider 契约](provider-contract.md)。

## Core Proposition

**团队是数据，不是代码分支。**

旧 V1 把 Conductor / Researcher / Specialist 写死成三个具名槽位，于是每增加一个角色都要改编排代码、改事件类型、改 UI 布局。新模型只有一条编排流程，团队规模和成员职责全部由一份 `TeamDefinition` 数据决定。

三条硬规则：

1. 运行时代码里**不允许出现** `conductor` / `researcher` / `specialist` 这类具名分支。一切按 `agentId` 寻址。
2. 「三个 Agent」不是产品形态，只是默认预设 `prd.default` 的成员数。
3. 用户日常看到的团队规模由 `TeamDefinition.members` 决定；子 Agent 的派生**不改变**这个数字。

## Data Model

```ts
type AgentId = string;   // 团队内唯一，稳定，事件寻址用
type TeamId = string;

interface RoleProfile {
  roleId: string;              // 例如 "product-trend-researcher"
  displayName: string;
  sourceSlug?: string;         // 外部角色库引用，例如 "product/product-trend-researcher.md"
  responsibility: string;      // 一句话职责，注入 system prompt
  instructions: string;        // 角色主体 prompt
  questionPolicy: {
    scope: string[];           // 这个角色允许问什么
    forbidden: string[];       // 明确不许问什么（属于别人的领域）
    maxQuestionsPerTurn: 0 | 1 | 2;
  };
  executionPolicy: string[];   // 执行阶段必须做/不许做的事
  outputSchema: JsonSchema;    // 该成员回给 orchestrator 的结构化贡献
  panelSections: string[];     // UI 面板分区顺序
}

interface SubAgentBudget {
  maxDepth: number;            // 从本 Agent 起算还能再派生几层
  maxSpawns: number;           // 本次任务内本 Agent 最多派生几个
  maxTokens: number;           // 该 Agent 全部子 Agent 合计 token 上限
  maxWallClockMs: number;
}

interface AgentDefinition {
  agentId: AgentId;
  displayName: string;
  role: RoleProfile;
  model?: ModelBinding;        // 见 provider-contract.md；未指定则继承团队默认
  tools: string[];             // 工具白名单，空数组表示纯推理成员
  canSpawnSubAgents: boolean;
  subAgentBudget?: SubAgentBudget;  // canSpawnSubAgents 为 true 时必填
}

interface TeamDefinition {
  teamId: TeamId;
  name: string;
  description: string;
  orchestratorId: AgentId;     // 必须命中 members 里的某个 agentId
  members: AgentDefinition[];
  defaultModel: ModelBinding;  // 成员未指定 model 时的兜底
  workflow: "intake_brief_dispatch_merge";  // 当前唯一内置流程
  outputContract: { primaryDocument: "prd.md" };
}
```

`RoleProfile` 与 `AgentDefinition` 分离的原因：角色是可复用的人设库条目，Agent 是这次团队里的一个具体位置。同一个 `RoleProfile` 可以被两个 Agent 用（例如两个 Researcher 分管不同调研方向），此时它们有不同的 `agentId` 和 `displayName`。

## Orchestrator Contract

每个团队有且只有一个 orchestrator，由 `orchestratorId` 指定。它不是「更聪明的成员」，它是控制面。

### 独占职责

orchestrator 独占以下五件事，其他成员一律不得执行：

1. **Intake。** 理解用户原始输入，判断任务能否推进。
2. **Questioning gate。** 决定本轮是否进入提问阶段；收集成员提出的问题，去重、裁剪、排序后再放进共享聊天。成员**不能**直接对用户说话。
3. **Brief synthesis。** 把共享聊天汇总成结构化 `TaskBrief`，在派发前对用户可见。
4. **Dispatch。** 决定哪些成员参与本次执行、各自的子任务是什么、并行还是串行。
5. **Merge and output。** 审查成员贡献、消解冲突、写出唯一交付物 `prd.md`。

### 禁止项

- 不得把过程讨论直接当成最终输出。
- 不得因为信息不完整就无限追问；信息模糊但方向可推断时必须带假设前进。
- 不得跳过 `TaskBrief` 直接派发。
- 不得隐藏假设与未决问题；两者必须写进 `prd.md`。
- 不得把成员的原始输出整段贴进 `prd.md`。

### TaskBrief

`TaskBrief` 是 orchestrator 的唯一派发凭据，字段沿用 V1 并补两项：

```ts
interface TaskBrief {
  productObject: string;
  targetUser: string;
  coreScenario: string;
  painOrProblem: string;
  v1Scope: string[];
  nonGoals: string[];
  successCriteria: string[];
  assumptions: string[];
  openQuestions: string[];
  memberTasks: Array<{        // 取代 V1 的 research_scope / specialist_focus
    agentId: AgentId;
    objective: string;
    mustCover: string[];
    outOfScope: string[];
  }>;
  contextAvailability: {      // 由宿主能力协商结果填充
    workspace: boolean;
    webSearch: boolean;
  };
}
```

`memberTasks` 用 `agentId` 寻址是这份契约的关键：它让 brief 的结构与团队规模解耦。`contextAvailability` 让 orchestrator 在没有工作区或没有联网时**显式降级**，而不是假装拿到了上下文（见 [运行时边界契约](runtime-boundary-contract.md)）。

## Member Contract

### 成员必须满足

- 声明 `outputSchema`，执行阶段只回结构化贡献，不回自由长文。
- 提问只在 `questionPolicy.scope` 内，且尊重 `forbidden` 列表。跨界问题应该丢给 orchestrator，而不是自己问。
- 只调用 `tools` 白名单内的工具。调用白名单外的工具是运行时错误，不是降级。
- 拿到的上下文是 `TaskBrief` + 自己的 `memberTasks` 条目 + 角色 profile，不是全局运行时状态。

### 成员不得

- 直接写任何输出文档（`create_output_document` 只对 orchestrator 开放）。
- 直接对用户提问。
- 修改 `TaskBrief`。
- 假设自己知道团队里还有谁。成员之间不互相寻址，一切经 orchestrator。

### 角色来源与 allowlist

[V1 Role Selection Contract](../product/v1-role-selection-contract.md) 的 curated allowlist 思路继续有效，但从「按槽位 allowlist」改成「按能力标签 allowlist」：

```ts
interface RoleCatalogEntry {
  roleId: string;
  sourceSlug: string;
  displayName: string;
  compatibleWith: Array<"orchestrator" | "research" | "review" | "generic">;
  curated: boolean;   // 只有 curated 为 true 的条目进 UI 选择器
}
```

原因：外部角色库（`msitarzewski/agency-agents`，MIT）有 220 个角色文件，绝大多数不是固定 PRD 流程的安全替换件。UI 只暴露 curated 子集；完整 catalog 保留为参考数据，不直接进选择器。

`compatibleWith` 含 `orchestrator` 的条目默认锁定，普通用户不可替换 orchestrator 角色——理由和 V1 一致：orchestrator 属于控制面，随意换会让流程不稳定。

## Default Preset: `prd.default`

默认预设保持旧文档的角色语义，三名成员，Conductor 兼任 orchestrator：

```ts
const PRD_DEFAULT_TEAM: TeamDefinition = {
  teamId: "prd.default",
  name: "PRD Workshop",
  description: "把模糊产品想法收束成一份可交付的 PRD 首稿。",
  orchestratorId: "conductor",
  workflow: "intake_brief_dispatch_merge",
  outputContract: { primaryDocument: "prd.md" },
  defaultModel: { providerId: "default", modelId: "default" },
  members: [
    {
      agentId: "conductor",
      displayName: "Conductor",
      role: ROLE_AGENTS_ORCHESTRATOR,     // specialized/agents-orchestrator.md
      tools: ["create_output_document"],
      canSpawnSubAgents: false,
    },
    {
      agentId: "researcher",
      displayName: "Researcher",
      role: ROLE_PRODUCT_TREND_RESEARCHER, // product/product-trend-researcher.md
      tools: ["web_search", "read_workspace_file", "search_workspace_text"],
      canSpawnSubAgents: true,
      subAgentBudget: { maxDepth: 1, maxSpawns: 2, maxTokens: 40_000, maxWallClockMs: 120_000 },
    },
    {
      agentId: "specialist",
      displayName: "Specialist",
      role: ROLE_PRODUCT_MANAGER,          // product/product-manager.md
      tools: ["list_workspace_files", "read_workspace_file", "search_workspace_text"],
      canSpawnSubAgents: false,
    },
  ],
};
```

预设规则：

- `prd.default` 是唯一内置预设，必须零配置可跑。
- 用户可以复制预设后改成员、改角色、改模型、加成员；内置预设本身不可编辑。
- 团队成员数上限为 6。理由是产品服务单人用户，超过 6 个成员的界面和成本都不再可控。
- 成员数 ≤ 2 时侧舱一个成员一栏；> 2 时侧舱内分栏，见旧 UI 规范的三舱思路（[V1 UI And Interaction Spec](../design/v1-ui-and-interaction-spec.md) 的布局部分仍可参考，但角色绑定部分已 superseded）。

## Workflow And State Machine

当前只有一条内置流程 `intake_brief_dispatch_merge`：

```text
idle
  -> chatting
  -> agent_questioning        （orchestrator 决定是否进入；可重复回到 chatting）
  -> brief_ready
  -> dispatching
  -> running                  （被派发的成员并行执行，逐个完成）
  -> merging
  -> writing_outputs
  -> completed | failed
```

与 V1 状态模型的差别：`running_researcher` / `running_specialist` 合并为单一 `running`，成员进度由事件里的 `agentId` 区分。UI 只渲染真实事件，不做假进度。

### Event Stream

事件按 `agentId` 寻址，不再有固定 agent 字段：

```ts
type RuntimeEvent =
  | { type: "task_status"; status: TaskStatus }
  | { type: "agent_message"; agentId: AgentId; text: string }
  | { type: "agent_question"; agentId: AgentId; question: string; reason: string }
  | { type: "task_brief_updated"; brief: TaskBrief }
  | { type: "agent_dispatched"; agentId: AgentId; objective: string }
  | { type: "agent_stage"; agentId: AgentId; stage: string; detail: string; sources?: SourceNote[] }
  | { type: "agent_contribution"; agentId: AgentId; schemaId: string; payload: unknown }
  | { type: "subagent_spawned"; parentAgentId: AgentId; subAgentId: AgentId; objective: string; depth: number }
  | { type: "subagent_stage"; parentAgentId: AgentId; subAgentId: AgentId; stage: string; detail: string }
  | { type: "subagent_completed"; parentAgentId: AgentId; subAgentId: AgentId; tokensUsed: number }
  | { type: "subagent_aborted"; parentAgentId: AgentId; subAgentId: AgentId; reason: SubAgentAbortReason }
  | { type: "artifact_written"; filename: "prd.md"; path: string }
  | { type: "error"; agentId?: AgentId; stage: string; message: string; retryable: boolean };
```

每个事件都带单调递增的 `seq` 和 `taskId` 信封字段，信封定义与传输见 [API 契约](../server/api-contract.md)。

## Sub-Agent Contract

成员通过 `spawn_subagent` 工具派生临时 Agent。子 Agent 是**任务内一次性的**，不进团队定义、不持久化、不出现在团队管理界面。

```ts
interface SpawnSubAgentInput {
  objective: string;          // 单一目标，不接受多目标
  instructions: string;
  tools: string[];            // 必须是父 Agent tools 的子集
  outputSchema: JsonSchema;
  maxTokens: number;          // 必须 ≤ 父 Agent 剩余预算
}
```

### 三重约束

派生请求必须同时通过三道检查，任何一道不通过则工具调用失败并回明确错误（不静默降级）：

1. **深度约束。** 子 Agent 的 `depth = parent.depth + 1`，必须 ≤ 父 Agent `subAgentBudget.maxDepth`。默认 `maxDepth: 1`，即只允许一层子 Agent，子 Agent 自身 `canSpawnSubAgents = false`。
2. **工具白名单约束。** `tools ⊆ parent.tools`。子 Agent 永远不可能拿到父 Agent 没有的工具，也不可能拿到 `create_output_document`。这条保证「提权」在结构上不可能发生。
3. **预算约束。** token 与墙钟预算从父 Agent 的 `subAgentBudget` 里扣减，父 Agent 的全部子 Agent 共享同一个池子。池子耗尽后 `spawn_subagent` 直接失败；单个子 Agent 超出自身 `maxTokens` 时被中止，已产出部分标记为不完整回流。

模型绑定默认继承父 Agent 的 `ModelBinding`；允许下调到更便宜的模型，不允许上调到父 Agent 之外的模型（成本可预测优先）。

### 结果回流

- 子 Agent 的结构化结果只回给**父 Agent**，不直接进 orchestrator，也不进共享聊天。
- 父 Agent 负责取舍：可以采纳、可以部分采纳、可以整体丢弃。父 Agent 在自己的 `agent_contribution` 里对结果负责。
- 子 Agent 中止或失败是父 Agent 的**可恢复失败**：父 Agent 必须能只带自己的结果继续,并在贡献里记录缺口。

### 可见性规则

| 位置 | 子 Agent 是否可见 |
| --- | --- |
| 共享聊天（中舱） | 不可见 |
| 团队规模 / 成员列表 | 不可见 |
| 父 Agent 面板 | 可见，默认折叠为一行「N 个子任务」，展开后看嵌套过程 |
| 事件流 / trace | 完整可见 |
| `prd.md` | 只以父 Agent 采纳后的内容体现，不单列 |
| 成本与用量视图 | 计入父 Agent 用量，可下钻 |

一句话：**子 Agent 是父 Agent 的实现细节，不是用户要管理的对象。**

## Validation Rules

团队校验器必须在保存与运行前拒绝以下情况：

- `orchestratorId` 不在 `members` 里。
- 存在重复 `agentId`。
- `members` 为空、或超过 6 个。
- 非 orchestrator 成员的 `tools` 里含 `create_output_document`。
- `canSpawnSubAgents = true` 但缺 `subAgentBudget`。
- `subAgentBudget.maxDepth` > 2。
- 成员绑定的模型能力不足以承担其工具需求（例如工具白名单非空但模型 `toolCalling = "none"`，见 [Provider 契约](provider-contract.md)）。
- `workflow` 不是已注册的流程 id。

## Acceptance Criteria

团队模型的实现只有在下列条件全部满足时才算达标：

1. 换掉 `prd.default` 的成员数（2 个或 5 个）无需改动编排代码，流程照常跑通。
2. 事件流里没有任何硬编码的 `conductor` / `researcher` / `specialist` 字段。
3. 用户可见的团队规模在有子 Agent 时保持不变。
4. 三重约束各有独立测试：越权工具、超深度、超预算分别被拒绝且错误可读。
5. `TaskBrief` 在派发前对用户可见，`memberTasks` 覆盖每个被派发成员。
6. 默认交付物仍然只有 `prd.md`。
7. 校验规则每一条都有对应的失败用例测试。

## Review Gate

出现以下情况应直接驳回实现：

- 编排代码里按角色名做 if / switch 分支。
- 子 Agent 出现在共享聊天或团队成员列表里。
- 子 Agent 能拿到父 Agent 之外的工具。
- 预算超限时静默继续执行。
- 完整 220 个外部角色未经 curated 过滤直接进 UI。
- 团队配置只影响 UI 文案，不影响运行时 prompt 与工具。
