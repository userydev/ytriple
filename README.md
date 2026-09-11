# yTriple

**Y is the user. Triple is the amplifier.**

yTriple 是以用户为中心的 Local-first AI Workbench，通过多 Agent、研究、文档、本地 Context 和外部 Intelligence 放大个人能力。多 Agent 是核心特色，不是固定三个 Agent，也不是所有任务的统一流程。

yTriple 负责理解、研究、组织、文档和项目底座准备；软件开发继续交给 Codex 等本地工具，其他深度生产继续留在对应专业软件。

## 正文入口

长期产品正文主要维护两份：

- [讨论总结](docs/讨论总结.md)：已确认的定位、能力、体验边界和稳定原则。
- [产品调研](docs/产品调研.md)：竞品、相邻产品与其他参考，包含来源、启发和限制。

网页 ChatGPT 负责讨论总结、产品框架、竞品调研与方案审视，不直接为项目撰写开发规格、架构、接口、任务拆解或路线图；具体设计、工程材料、实现和验证由 Codex 负责。其他参考可以按需补充，但研究不自动变成需求，不建立重复的产品正文。

本轮已将原 `docs/product/ai-workbench-direction.md` 的产品结论收敛到讨论总结，原 `docs/technical/agent-runtime-direction.md` 的能力原则并入总结、通用资料归入产品调研；旧文件不再单独维护，历史可由 Git 查询。

## 当前代码与历史 V1

现有代码保留 V1 PRD 原型及 `Conductor / Researcher / Specialist` 思路，供检查和复用；这不是 yTriple 的长期边界。原型是否完整可用，以代码和真实运行验证为准，不因文档曾写“已验证”就视为完成。

以下运行说明沿用原 V1 入口，保留用于检查已有原型，不是新工作台的开发任务或交付证明。实际模型配置、输出行为与可用性由运行验证确认。

### 本地使用

#### 1. 配置模型

在项目根目录创建 `.env`，原 V1 示例：

```bash
ARK_API_KEY=your_api_key
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
ARK_MODEL=doubao-seed-2-1-pro-260628
ARK_ENABLE_WEB_SEARCH=true
```

原 Agent Plan 示例：

```bash
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/plan/v3
ARK_MODEL=doubao-seed-2.0-mini
```

#### 2. 启动桌面应用

```bash
npm install
npm run tauri dev
```

在中间的 Conductor 区输入想法，可补充目标用户、场景、边界或成功标准，然后使用 `Generate PRD`。

- `Workspace path`：只读工作区绝对路径，可留空。
- `Output root`：PRD 输出根目录，可留空。

旧 V1 输出契约以 `prd.md` 为默认交付物；契约不代替代码和实际输出核对。

#### 3. 命令行运行

```bash
npm run run:prd -- --input "你的产品想法" --output-root ./local-output
```

也可以附加只读工作区：

```bash
npm run run:prd -- --input-file ./brief.md --workspace-root /absolute/workspace --output-root ./local-output
```

## V1 历史参考

旧 V1 文档保留，不在本轮重写。其中关于固定三 Agent、只生成 PRD、SDK、布局和实施顺序的限制不构成新工作台的有效开发要求；也不能把旧设计文档当成已经实现的证据。Codex 可按当前目标和实际代码选择性参考，不需要继续照旧 roadmap 推进。

- [产品 PRD V1](docs/product/prd-v1.md)
- [V1 Product Contract](docs/product/v1-product-contract.md)
- [V1 Output Contract](docs/product/v1-output-contract.md)
- [V1 Role Selection Contract](docs/product/v1-role-selection-contract.md)
- [V1 Runtime And Tool Contract](docs/product/v1-runtime-tool-contract.md)
- [V1 Information Architecture](docs/product/v1-information-architecture.md)
- [V1 UI And Interaction Spec](docs/design/v1-ui-and-interaction-spec.md)
- [V1 Technical Architecture](docs/technical/v1-technical-architecture.md)
- [V1 Implementation Roadmap](docs/project/v1-implementation-roadmap.md)
- [V1 Agent Conversation Runtime Task](docs/project/v1-agent-conversation-runtime-task.md)

## Role Library Reference

V1 引入 [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents) 作为外部角色库参考，并按原 V1 记录标明 MIT 来源。角色资料属于参考，不等于具备工具、权限或已经可运行的 Agent。

V1 角色参考：

- `Conductor`：`specialized/agents-orchestrator.md`
- `Researcher`：`product/product-trend-researcher.md`
- `Specialist`：`product/product-manager.md`

这些角色不构成长期 yTriple 对 Agent 数量、能力来源或交互方式的限制。
