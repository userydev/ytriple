# yTriple V1 Implementation Roadmap

> **Superseded.** 本文档基于「固定三 Agent」的 V1 假设，已被「可配置 Agent 团队」模型取代，保留作为历史决策记录，不再作为实现依据。
>
> 现行契约：[Positioning](../product/positioning.md) · [Agent 团队契约](../contracts/agent-team-contract.md) · [Provider 契约](../contracts/provider-contract.md) · [运行时边界契约](../contracts/runtime-boundary-contract.md)
>
> 本文件中仍然有效的部分：里程碑顺序的思路（runtime 先于 UI）；具体里程碑已被重建计划的阶段 0-6 取代。

## Purpose

本文件不是泛计划，而是面向落地的 V1 执行路线。目标是把当前文档定义转成一个最短可验证的产品实现顺序。

## Delivery Goal

交付一个桌面端 V1，能够：

- 接收模糊产品想法
- 让 Conductor / Researcher / Specialist 在同一个聊天窗口进行真实会话
- 由 Conductor 汇总聊天并生成 Task Brief
- 运行固定三 Agent 编排
- 读取用户授权工作区
- 执行 Web 轻调研
- 在左右面板展示真实 Researcher / Specialist 执行过程
- 输出一个默认用户交付文件：`prd.md`

## Milestone 1: Skeleton App

目标：

- 建立 Tauri + frontend 基础壳
- 打通页面结构与本地启动

完成标准：

- 可打开桌面窗口
- 有三舱基础布局
- 有 New Task 基础输入区

## Milestone 2: Agent Conversation Runtime

目标：

- 建立共享三 Agent 聊天模型
- Conductor / Researcher / Specialist 都能在同一聊天中发言和提问

完成标准：

- 所有消息有明确 agent 标识
- Researcher / Specialist 的问题基于职责产生，不是固定 UI 文案
- 用户在同一聊天窗口回答

## Milestone 3: Task Brief And Orchestration

目标：

- 建立 Conductor 主控编排
- 生成可见 Task Brief
- 明确何时进入 dispatch

完成标准：

- Task Brief 字段完整
- Conductor 能判断信息是否足够
- Conductor 能把 Task Brief 分派给 Researcher / Specialist

## Milestone 4: Workspace Read Layer

目标：

- 打通工作区只读能力

完成标准：

- 可选工作区
- 可列文件
- 可读文件
- 可搜文本
- 明确排除规则生效

## Milestone 5: Provider Adapter

目标：

- 接入 Ark Responses
- 打通结构化输出调用
- Researcher slot 可使用 Ark web_search

完成标准：

- 可向模型发请求
- 可拿到结构化 JSON
- Web Search 只在 Researcher 阶段使用
- 能为不同角色注入不同 role profile

## Milestone 6: Fixed Tri-Agent Execution

目标：

- 跑通 Conductor / Researcher / Specialist 固定执行流程

完成标准：

- Conductor 负责 intake、Task Brief、dispatch、merge
- Researcher 基于 Task Brief 执行轻调研
- Specialist 基于 Task Brief 执行产品审查
- 左右面板显示真实执行事件

## Milestone 7: Single PRD Output Writer

目标：

- 写出单一默认交付文件 `prd.md`

完成标准：

- 可创建输出目录
- 默认只写 `prd.md`
- 不再默认写四个 Markdown 文件
- 不覆盖已有输出
- 任务完成后 UI 可直接打开或预览 `prd.md`

## Milestone 8: V1 UI Completion

目标：

- 把三舱内容、任务状态、Task Brief、执行过程和 PRD 结果完整落到界面

完成标准：

- 左舱显示调研过程
- 中舱显示共享三 Agent 聊天、Task Brief、分派与结果
- 右舱显示专业审查过程
- 完成态默认打开 `prd.md`

## Milestone 9: Quality Validation

目标：

- 证明这个产品相比普通聊天更擅长出 PRD 首稿

完成标准：

- 准备一批模糊产品想法样例
- 评估是否能稳定产出结构完整的 PRD 首稿
- 检查输出是否稳定为 `prd.md`
- 检查左右面板是否显示真实过程而不是 demo 状态

## Recommended Build Order

推荐严格按下面顺序做，避免 UI 和 runtime 互相等待：

1. Skeleton App
2. Agent Conversation Runtime
3. Task Brief And Orchestration
4. Workspace Read Layer
5. Provider Adapter
6. Fixed Tri-Agent Execution
7. Single PRD Output Writer
8. UI Completion
9. Quality Validation

## First-Cut Acceptance Checklist

- 用户能从桌面端输入模糊需求
- 系统不会先用长表单阻塞用户
- 三 Agent 能在同一聊天窗口真实发言和提问
- Conductor 能生成 Task Brief
- PRD 模板能稳定运行
- 工作区只读边界正确
- Web 调研结果能影响 PRD
- 左右面板能展示真实调研和审查过程
- 最终能生成 `prd.md`

## What Not To Build During V1

- Git 功能
- 多模板大系统
- 用户自定义 agent flow
- 深度研究模式
- 云端协作
- 重型配置系统
- 四文件默认交付包
