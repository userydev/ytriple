# yTriple V1 Product Contract

> **Superseded.** 本文档基于「固定三 Agent」的 V1 假设，已被「可配置 Agent 团队」模型取代，保留作为历史决策记录，不再作为实现依据。
>
> 现行契约：[Positioning](positioning.md) · [Agent 团队契约](../contracts/agent-team-contract.md) · [Provider 契约](../contracts/provider-contract.md) · [运行时边界契约](../contracts/runtime-boundary-contract.md)
>
> 本文件中仍然有效的部分：工作区只读、Task Brief 前置、单一交付物 `prd.md`、Agent 提问策略（0-2 问）；Agent Roles 与固定三槽位一节整体作废。

## Purpose

本文件定义 yTriple 第一阶段的产品执行边界。它不是泛介绍，而是后续设计、实现和验证都要遵守的固定 contract。

V1 目标只有一个：把模糊产品想法快速收束成一个可继续迭代的 `PRD 首稿`。

## Core Contract

- 固定三 Agent 工作流
- 首个核心模板是 `PRD`
- 支持 Web 轻调研
- 支持工作区只读
- 允许新建输出文档
- 默认只输出一个用户可用 PRD 文件：`prd.md`
- 不修改已有文档
- 不做 Git
- 不做用户可编排工作流

## Agent Roles

### Conductor

职责：

- 判断当前任务是否属于 PRD 交付
- 决定是否发起 Agent Questioning
- 汇总共享聊天，生成结构化 Task Brief
- 拆解任务并调度另外两个 Agent
- 审查、合并并产出最终 PRD

约束：

- 不把过程讨论直接等价为最终输出
- 不因信息不完整而默认无限追问
- 必须显式记录假设与未决问题
- 必须在正式执行前生成可见 Task Brief

### Researcher

职责：

- 进行轻量 Web 调研
- 补足关键概念、公开事实、术语解释和少量竞品样本
- 在聊天阶段提出调研范围相关问题
- 在执行阶段向 Conductor 提供结构化调研贡献

约束：

- 不做深度行业研究
- 不把原始调研笔记写成独立默认交付文件
- 不追求来源数量，追求方向支撑
- 必须区分事实、推断与假设

### Specialist

职责：

- 按模板切换专业视角
- 对结构、范围、专业判断和质量提出建议
- 在聊天阶段提出产品审查相关问题
- 在执行阶段向 Conductor 提供结构化审查贡献

V1 角色库示例：

- 产品负责人
- 技术架构师
- 增长顾问
- 品牌顾问

约束：

- V1 仍只有一个 Specialist 槽位
- 多角色扩展通过模板绑定实现，而不是增加并行 Agent 数量
- 不把原始专家审查写成独立默认交付文件

## Workflow Contract

```text
User Input
   |
   v
Shared Three-Agent Chat
   |
   v
Conductor Intake
   |
   +--> Researcher scoped questions
   |
   +--> Specialist scoped questions
   |
   v
Conductor Task Brief
   |
   v
Dispatch
   |
   +--> Researcher execution
   |
   +--> Specialist execution
   |
   v
Conductor Review + Merge
   |
   v
prd.md
```

### Agent Questioning Policy

- 默认先尝试直接理解用户意图
- 如果信息足以推断方向，不追问
- 如果信息模糊但仍能前进，带假设执行
- Researcher 只问调研范围相关问题
- Specialist 只问产品审查相关问题
- Conductor 只问阻塞任务理解的主线问题
- 每个 Agent 单轮最多 0 到 2 个问题

### First Draft Policy

- 第一版以“给方向”为优先目标
- 第一版允许不完整，但必须结构清晰
- 第一版允许带假设，但必须显式暴露
- 第一版不假装是最终冻结稿

## Template Contract

V1 的模板不是单纯 prompt，而是结构化配置。每个模板至少需要：

- `template_id`
- `target_document`
- `default_specialist_role`
- `research_policy`
- `output_schema`
- `review_checklist`

### V1 PRD Template

- `template_id`: `prd`
- `target_document`: `product requirements document`
- `default_specialist_role`: `product_lead`
- `research_policy`: `light_web_research`
- `output_schema`: `prd.md`

## Workspace Policy

### Allowed

- 用户显式选择工作区
- 读取工作区文件
- 搜索工作区文本
- 基于工作区资料生成新 PRD 文档

### Forbidden

- 修改已有文件
- 删除已有文件
- 隐式扫描未授权目录
- 访问 Git 写操作

## Tool Surface

V1 预期最小工具面：

- `list_workspace_files`
- `read_workspace_file`
- `search_workspace_text`
- `web_search`
- `create_output_document`

说明：

- `web_search` 只服务于轻量事实补足
- `create_output_document` 默认只写 `prd.md`，不覆盖旧文件

## Model and Runtime Direction

### Provider Layer

- V1 当前以火山方舟 Ark Responses 为实际 provider 策略
- Ark web_search 只允许在 Researcher slot 使用
- 后续可抽象为统一 provider adapter，但 V1 不以 provider 切换作为主功能

### Runtime Layer

- 采用轻量固定编排 runtime
- 不以 LangGraph 式图编排作为 V1 入口
- 编排核心固定为 `Shared Chat -> Conductor Task Brief -> parallel(Researcher, Specialist) -> Conductor Merge -> prd.md`

## Output Contract

默认输出：

- `prd.md`

### Output Rules

- `prd.md` 是唯一默认用户交付物
- Researcher notes、Specialist review、Task Brief、conversation transcript 是过程材料
- 过程材料可在 UI 中展示，也可作为内部 trace 存储
- 默认不再输出四个 Markdown 文件
- 如未来支持导出过程材料，只能作为可选 `agent-notes.md`，不得恢复四文件默认交付

权威输出定义见：

- `docs/product/v1-output-contract.md`

## Success Criteria

若 V1 成立，应至少满足：

1. 用户能从模糊输入快速获得方向正确的 PRD 首稿。
2. 首稿不依赖长时间追问才能启动。
3. 交付结果是一个清晰主产物：`prd.md`。
4. 系统能利用工作区只读上下文和 Web 轻调研提升首稿质量。
5. 产品体验保持“固定工作流、低配置、快速成稿”。
6. 三 Agent 的问题、分派、执行过程能在 UI 中真实可见。
