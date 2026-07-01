# yTriple V1 Implementation Roadmap

## Purpose

本文件不是泛计划，而是面向落地的 V1 执行路线。目标是把当前文档定义转成一个最短可验证的产品实现顺序。

## Delivery Goal

交付一个桌面端 V1，能够：

- 接收模糊产品想法
- 做极轻量 Quick Clarify
- 运行固定三 Agent
- 读取用户授权工作区
- 执行 Web 轻调研
- 输出四份标准 PRD 交付文件

## Milestone 1: Skeleton App

目标：

- 建立 Tauri + frontend 基础壳
- 打通页面结构与本地启动

完成标准：

- 可打开桌面窗口
- 有三舱基础布局
- 有 New Task 基础输入区

## Milestone 2: Task Runtime

目标：

- 建立最小任务状态机
- 可从输入进入 `classifying -> preparing_context -> completed`

完成标准：

- 任务对象可创建
- 状态可追踪
- 历史记录可保存基础元数据

## Milestone 3: Workspace Read Layer

目标：

- 打通工作区只读能力

完成标准：

- 可选工作区
- 可列文件
- 可读文件
- 可搜文本
- 明确排除规则生效

## Milestone 4: Provider Adapter

目标：

- 接入 OpenRouter
- 打通结构化输出调用

完成标准：

- 可向单模型发请求
- 可拿到结构化 JSON
- 能为不同角色切换不同模型配置

## Milestone 5: Fixed Tri-Agent Flow

目标：

- 跑通 Conductor / Researcher / Specialist 固定流程

完成标准：

- Conductor 能识别 `PRD` 任务
- Quick Clarify 最多只问少量问题
- Researcher 与 Specialist 可并行执行
- Conductor 能合并结果

## Milestone 6: Delivery Package Writer

目标：

- 写出完整四文件交付包

完成标准：

- 可创建输出目录
- 固定文件命名正确
- 不覆盖已有输出
- 任务完成后 UI 可直接打开结果

## Milestone 7: V1 UI Completion

目标：

- 把三舱内容和任务结果完整落到界面

完成标准：

- 左舱显示调研过程
- 中舱显示输入、Quick Clarify、收敛与结果
- 右舱显示专业审查
- 完成态默认打开最终 PRD

## Milestone 8: Quality Validation

目标：

- 证明这个产品相比普通聊天更擅长出首稿

完成标准：

- 准备一批模糊产品想法样例
- 评估是否能稳定产出结构完整的 PRD 首稿
- 检查输出包结构是否稳定

## Recommended Build Order

推荐严格按下面顺序做，避免 UI 和 runtime 互相等待：

1. Skeleton App
2. Task Runtime
3. Workspace Read Layer
4. Provider Adapter
5. Fixed Tri-Agent Flow
6. Delivery Package Writer
7. UI Completion
8. Quality Validation

## First-Cut Acceptance Checklist

- 用户能从桌面端输入模糊需求
- 系统不会先用长表单阻塞用户
- Quick Clarify 足够轻
- PRD 模板能稳定运行
- 工作区只读边界正确
- Web 调研结果能进入参考资料
- 最终能生成四份标准文件

## What Not To Build During V1

- Git 功能
- 多模板大系统
- 用户自定义 agent flow
- 深度研究模式
- 云端协作
- 重型配置系统
