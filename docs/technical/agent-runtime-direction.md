# ytriple Agent Runtime 技术方向

## 目标

本文定义 ytriple 长期 Agent 能力的技术原则。重点是明确哪些能力由 ytriple 自己掌握，哪些能力复用成熟 SDK，哪些能力交给 Codex 等外部专业 Agent。

## 核心结论

ytriple 不应把 Agent 能力建立在某个本机 Agent（如 Codex、Claude Code）之上，也不应从零重写完整 Agent Framework。

推荐结构：

> **ytriple 自己掌握一层轻量 Agent Kernel；通用 Agent loop、tool calling、session、handoff、tracing 等优先复用成熟 SDK；Codex、Claude Code 等本机 Agent 作为外部专业执行器接入。**

## ytriple 自己掌握的部分

Agent Kernel 负责 ytriple 的产品语义，而不是重新实现模型能力。

至少需要掌握：

- Agent 定义；
- Role / Instructions；
- Context 选择与注入；
- Capability / Tool 权限；
- Orchestration；
- Work 状态；
- Artifact Contract；
- 用户介入点；
- Trace / Source / Result 的产品级表示。

Agent 数量由任务决定，不存在全局固定三 Agent Runtime。

一个 Agent 的抽象可以类似：

```text
AgentSpec
- identity / role
- instructions
- model policy
- context policy
- capabilities
- permissions
- output contract
```

## 复用成熟 Agent SDK

以下通用能力不应优先自行重写：

- LLM agent loop；
- tool calling；
- handoff；
- session；
- streaming；
- tracing；
- guardrails；
- MCP client；
- 基础 multi-agent delegation。

具体 SDK 可以替换，ytriple 的产品模型不能绑定某个单一 Provider。

第一实现可以优先选择成熟的 TypeScript Agent SDK，但必须通过 ytriple 自己的 Kernel / Adapter 隔离，避免 SDK 直接定义产品结构。

## 模型层

模型接入本身保持简单：通过 API / Provider Adapter 接入。

```text
ytriple Agent Kernel
→ Model Provider Interface
→ OpenAI / Anthropic / Ark / Other
```

模型属于可替换能力，不是 ytriple 的核心资产。

## Local Tools 与本机 Agent 是两回事

本地能力首先应通过受控 Local Tools 暴露，而不是把无限制 Shell 直接交给 Agent。

例如：

```text
filesystem.read
filesystem.write_artifact
project.inspect
project.create
project.validate
git.status
git.worktrees
policy.read
policy.validate
policy.sync
```

这些能力由 Tauri / Rust 或其他本地受控层实现，并遵守用户本机 Policy。

原则：

> **Agent 做判断，Tool 做真实动作。**

## 两类编排

### AI-driven orchestration

适合：

- Research；
- Brainstorm；
- 文档分析；
- 专家选择；
- Critique；
- Creator Intelligence；
- 复杂信息综合。

系统可以根据任务动态决定需要哪些 Agent 或 Capability。

### Code-driven orchestration

适合有副作用、规则明确的本地操作：

- 创建项目；
- 写入 manifest；
- 同步 Policy 投影；
- 创建 worktree；
- 本地文件变更；
- 验证项目状态。

典型模式：

```text
Inspect
→ Plan
→ Authorization / Policy Check
→ Deterministic Tools
→ Verify
```

这类任务不应完全交给 LLM 自由调用 Shell。

## Codex / Claude Code 等本机 Agent 的位置

它们是 External Agent Capability，而不是 ytriple 的底座。

软件开发典型流程：

```text
ytriple Research / Product Discussion
→ PRD / Technical Brief / Task Context
→ Project Base
→ Handoff
→ Codex / Claude Code
→ Professional Execution
```

第一阶段只需要把项目、规则、文档和任务上下文准备好，并提供清晰 Handoff。

后续若需要更深整合，可以通过 Adapter、CLI、SDK、MCP 或其他稳定接口读取运行状态和结果，但 ytriple 不复制 Coding Agent 的内部能力。

## Capability Layer

长期可以统一成：

```text
Agent Kernel
→ Capability Registry
   ├── Local Tools
   ├── Web / Hosted Tools
   ├── MCP Servers
   ├── Connectors / APIs
   └── External Agents
```

Agent 只看到当前任务允许使用的 Capability，不默认获得所有权限。

## 与当前 V1 Runtime 的关系

当前 V1 已经有：

```text
Tauri Shell
→ Frontend
→ Local Runtime
   → Task Orchestrator
   → Workspace Access
   → Output Writer
   → Provider Adapter
   → Web Research Adapter
```

这个分层可以保留，但长期应把固定 PRD 三 Agent Runtime 升级为：

```text
Local Runtime
→ Agent Kernel
   ├── Orchestrator
   ├── Agent Engine Adapter
   ├── Model Providers
   ├── Capability Registry
   ├── Context
   ├── Artifact
   └── External Agent Adapters
```

技术演进重点是抽象和解耦，而不是立即重写所有现有代码。