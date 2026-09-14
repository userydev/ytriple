# yTriple V1 Information Architecture

> **Superseded.** 本文档基于「固定三 Agent」的 V1 假设，已被「可配置 Agent 团队」模型取代，保留作为历史决策记录，不再作为实现依据。
>
> 现行契约：[Positioning](positioning.md) · [Agent 团队契约](../contracts/agent-team-contract.md) · [Provider 契约](../contracts/provider-contract.md) · [运行时边界契约](../contracts/runtime-boundary-contract.md)
>
> 本文件中仍然有效的部分：一级对象划分与「以任务为核心、单一 PRD 为结果」的 IA 原则；固定三舱与固定角色绑定作废。

## Purpose

本文件定义 yTriple V1 的信息架构，回答三个问题：

1. 用户在产品里会看到哪些一级对象。
2. 一次 PRD 任务由哪些信息单元组成。
3. 三舱界面各自承载什么内容。

V1 目标不是做复杂工作台，而是围绕 `PRD 首稿交付` 建立最小但完整的信息结构。

## IA Principles

- 以任务为核心，而不是以聊天消息为核心。
- 以一个主 PRD 为结果，而不是以多文件报告包为结果。
- 以固定三 Agent 分工为过程视图，而不是开放式线程树。
- 以低配置、低学习成本为优先。

## Primary Objects

V1 的一级对象只保留以下几类：

### Workspace

- 用户显式选择的工作区
- 提供只读上下文来源
- 不是任务结果容器

### Task

- 一次从输入到交付的完整运行单元
- 绑定一个模板
- 绑定一个输出目录
- 拥有明确状态流

### Conversation

- 用户与 Conductor / Researcher / Specialist 的共享聊天
- 所有 agent 问题和用户回答都在这里发生
- 不是三个独立聊天室

### Task Brief

- Conductor 从共享聊天中汇总出的结构化任务上下文
- 是正式 dispatch 前的关键中间对象
- 用户可见

### Template

- 定义任务类型、默认 Specialist 角色、调研策略和输出结构
- V1 首个核心模板为 `PRD`

### Role Profile

- Agent 的运行角色配置
- 例如：Conductor、Researcher、Product Lead Specialist
- 在 V1 中作为固定 Agent 编排配置存在，不单独暴露为复杂管理系统

### PRD Output

- 一次任务最终生成的用户交付文档
- 默认只有 `prd.md`
- 是用户实际消费和继续修改的结果

## Main Navigation Model

V1 建议只保留最少的主导航层级：

### 1. New Task

- 默认入口
- 用户输入模糊需求
- 系统进入共享三 Agent 会话

### 2. Current Task

- 当前正在运行或刚完成的任务
- 展示共享聊天、Task Brief、三舱过程与 PRD 输出

### 3. History

- 展示历史任务列表
- 可重新打开 `prd.md`
- V1 只需要轻量列表，不需要复杂筛选和协作能力

### 4. Settings

- 模型入口配置
- Web 能力开关
- 默认输出路径
- 工作区选择策略

## Task Structure

一次 V1 PRD 任务由以下信息单元组成：

### A. User Input Block

- 原始自然语言描述
- 可选工作区引用
- 可选补充文件

### B. Shared Conversation Block

- 用户消息
- Conductor 理解、追问、分派和收敛
- Researcher 调研角度问题
- Specialist 产品审查角度问题

### C. Task Brief Block

- product object
- target user
- core scenario
- pain/problem
- V1 scope
- non-goals
- success criteria
- research scope
- specialist focus
- assumptions
- open questions

### D. Runtime Context Block

- 模板配置
- 当前 Specialist 角色
- 工作区文件摘要
- Web 轻调研开关

### E. Agent Execution Block

- Researcher 执行过程
- Specialist 执行过程
- Conductor 合并过程

### F. PRD Output Block

- `prd.md`

## Output IA

V1 的默认输出结构固定为：

```text
Task
  -> prd.md
```

### `prd.md`

- 唯一默认用户交付物
- 用户最先打开
- 必须尽可能干净，不混入过程噪音
- 必须包含假设与未决问题
- 仅在使用来源支撑事实时包含 Source Notes

### Process Materials

这些内容不作为默认 Markdown 交付物：

- Task Brief
- Researcher raw notes
- Specialist raw review
- source cards
- conversation transcript
- runtime events

它们应在 UI 中可见，并可作为内部 trace 存储。

## Screen-Level IA

### Home / New Task

信息单元：

- 顶部品牌和当前工作区信息
- 主输入区
- 默认模板提示
- 最近任务入口

### Active Task

信息单元：

- 当前任务标题和状态
- 三舱主体
- 共享聊天
- Task Brief
- PRD 输出入口
- 重新生成 / 继续修订入口

### Task History

信息单元：

- 历史任务列表
- 每个任务的模板、状态、时间、输出目录
- 点击后打开 `prd.md`

### Settings

信息单元：

- Model provider 配置
- 默认模型设置
- 输出目录设置
- Web 能力设置
- 工作区读取设置

## Tri-Panel Content Model

### Left Panel: Research

只展示：

- 当前调研范围
- 查询意图
- Web Search 状态
- 来源卡片
- 已发现的关键概念
- 事实 / 推断 / 假设区分
- 调研简要结论

不展示：

- 无关长文本
- 过深的逐步推理
- 单独的可编辑研究报告

### Center Panel: Conductor

只展示：

- 用户输入
- 共享三 Agent 聊天
- Agent questions
- Task Brief
- Conductor 的任务分派与收敛摘要
- `prd.md` 预览和打开入口

不展示：

- 大量低价值中间日志

### Right Panel: Specialist

只展示：

- 当前专业角色
- 审查清单
- 缺失信息
- 结构建议
- 风险点
- 修订建议
- 审查结论摘要

不展示：

- 与当前模板无关的自由发挥
- 单独的可编辑专家报告

## Future-Safe Extensions

为后续扩展预留但 V1 不实现：

- 多模板首页
- Specialist 角色切换器
- 支持材料可选导出 `agent-notes.md`
- 同一任务的多轮迭代树
- Git / 代码审查型任务
