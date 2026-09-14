# yTriple

一个人指挥一支 AI 团队。

yTriple 是给个人开发者和个人自媒体工作者做的 AI 团队工作台。它把模糊的想法交给一支可配置的 Agent 团队，收束成一份能直接用的交付物——第一条链路是 `prd.md`。

本地跑得起来是底线：不登录、不订阅、自带模型 key，就能在桌面端完整跑完一次任务。

## 当前方向

产品正在从「固定三 Agent」重建为「可配置 Agent 团队」。这次重建确定的几条方向：

- **团队是数据，不是代码分支。** 多 Agent 是基础能力，三个 Agent 只是默认预设 `prd.default`（Conductor + Researcher + Specialist）。成员数、角色、模型绑定全部由团队定义决定，编排代码里没有具名角色分支。
- **Agent 可以派生子 Agent**，受深度、工具白名单、token 预算三重约束。子 Agent 是父 Agent 的实现细节，不改变用户看到的团队规模。
- **Provider 多样且可降级。** Google 系、OpenAI 兼容（DeepSeek / Ark / OpenRouter / 本地 Ollama）、Ark Responses 都可配置。编排层只依赖能力标记，不依赖 provider 品牌。
- **一个环境无关的 TypeScript 核心。** 桌面端在本地跑它，服务端在云上跑同一个它。Tauri 只做壳和能力提供者，不承载业务逻辑。
- **顺序：桌面端 PRD 工作台 → 雷达服务 → 手机端。** 但架构边界现在就定好。

保留的 V1 决策：单一主交付物 `prd.md`、工作区只读、Task Brief 前置。

## 三条链路

| 链路 | 状态 | 面向 |
| --- | --- | --- |
| 桌面端 PRD 工作台 | 重建中 | 个人开发者为主 |
| 雷达服务（信息源 → 采集 → 清洗 → AI 加工 → 个性化推送） | 设计完成，未实现 | 两类用户，加工口径分流 |
| 手机端（thin client，雷达消费为主） | 设计完成，未开工 | 个人自媒体工作者为主 |

## 文档入口

### 现行契约

先读这四份，它们是当前唯一的实现依据：

- [Positioning](docs/product/positioning.md) —— 目标用户与产品原则，所有契约的共同前提
- [Agent 团队契约](docs/contracts/agent-team-contract.md) —— 团队数据模型、orchestrator 职责、成员定义、默认预设、子 Agent 三重约束与可见性
- [Provider 契约](docs/contracts/provider-contract.md) —— 能力描述表、降级回退策略、按槽位绑定模型、凭据与自检
- [运行时边界契约](docs/contracts/runtime-boundary-contract.md) —— core + ports 模型、三种执行模式、桌面独占能力、能力协商

### 服务端与手机端设计

只出设计，代码等桌面端稳定：

- [雷达服务设计](docs/server/radar-service-design.md)
- [托管运行时与订阅](docs/server/hosted-runtime-and-subscription.md)
- [客户端-服务端 API 契约](docs/server/api-contract.md)
- [手机端就绪度检查清单](docs/mobile/readiness-checklist.md)

### 保留决策

- [V1 Output Contract](docs/product/v1-output-contract.md) —— 单一交付物 `prd.md` 的权威定义，在新团队模型下继续有效

### 历史文档（superseded）

下面这些基于「固定三 Agent」假设，保留作为历史决策记录，不作为实现依据。每份文档顶部标注了其中仍然有效的部分：

- [PRD V1](docs/product/prd-v1.md)
- [V1 Product Contract](docs/product/v1-product-contract.md)
- [V1 Role Selection Contract](docs/product/v1-role-selection-contract.md)
- [V1 Runtime And Tool Contract](docs/product/v1-runtime-tool-contract.md)
- [V1 Information Architecture](docs/product/v1-information-architecture.md)
- [V1 UI And Interaction Spec](docs/design/v1-ui-and-interaction-spec.md)
- [V1 Technical Architecture](docs/technical/v1-technical-architecture.md)
- [V1 Implementation Roadmap](docs/project/v1-implementation-roadmap.md)
- [V1 Agent Conversation Runtime Fix](docs/project/v1-agent-conversation-runtime-task.md)

## 仓库结构

重建后的目标结构：

```text
packages/
  shared/     类型、事件信封、schema（客户端与服务端共用）
  core/       团队编排、会话、TaskBrief、工具注册、子 Agent、状态机
  providers/  provider adapter + 能力描述表
apps/
  desktop/    Tauri v2 + React，本地跑 core
  server/     托管运行时 + 雷达 + AI 能力配置
  mobile/     占位，thin client
```

核心原则：`packages/core` 不 import 任何 `node:*` 或 `@tauri-apps/*`，一切外部能力通过注入的 port 进入。这是手机端和服务端将来能复用同一份编排的唯一保证。

## 输出契约

一次任务只产出一个默认用户交付物：

```text
<output-root>/ytriple-outputs/<task-id>/prd.md
```

Task Brief、调研笔记、审查意见、来源卡片、会话记录都是过程材料。它们在界面里可见，也可作为内部 trace 存储，但不写成额外的默认交付文件。

## 运行

代码正在按上面的结构重建，运行方式随骨架落地后补充。旧的单包 Tauri 应用与 `npm run run:prd` 入口已不再是当前实现方向。

## 角色库来源

角色人设参考外部角色库 [`msitarzewski/agency-agents`](https://github.com/msitarzewski/agency-agents)（MIT），本地 catalog 覆盖 17 个 division、220 个 agent role 文件。

完整 catalog 只作为参考数据，不直接进 UI 选择器。UI 只暴露按能力标签 curated 过的子集，规则见 [Agent 团队契约](docs/contracts/agent-team-contract.md) 的 Member Contract。含 orchestrator 能力标签的角色默认锁定。
