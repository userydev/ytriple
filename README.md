# yTriple

**Y is the user. Triple is the amplifier.**

yTriple 的长期方向是一个面向个人的 AI Workbench：通过 AI、Agent、Research、本地 Context、外部 Intelligence 和文档能力放大用户的思考、研究、判断和工作准备能力。

多 Agent 是核心特色之一，但不是固定三个 Agent，也不是所有任务的统一底座。Agent 数量和协作方式由任务决定。

yTriple 不试图接管所有专业工作。软件开发继续交给 Codex、Claude Code 等本地工具；设计、剪辑和其他专业生产继续留在对应工具。yTriple 更聚焦 Research、多 Agent 协作、文档、项目底座、本地 Context、Radar、Creator Intelligence 和 Handoff。

## 长期方向

- 产品方向：[docs/product/ai-workbench-direction.md](docs/product/ai-workbench-direction.md)
- Agent Runtime 技术方向：[docs/technical/agent-runtime-direction.md](docs/technical/agent-runtime-direction.md)

## 当前实现：V1 PRD Workbench

当前代码仍是 yTriple 的第一代能力验证：一个轻量桌面端 PRD 首稿工具，通过 `Conductor / Researcher / Specialist` 协作，把模糊产品想法收束成正式 PRD。

这套固定三 Agent PRD 工作流作为一个已验证的 Multi-Agent Pattern 保留，但不再代表 yTriple 的长期产品边界。

### 本地使用

#### 1. 配置模型

在项目根目录创建 `.env`：

```bash
ARK_API_KEY=your_api_key
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
ARK_MODEL=doubao-seed-2-1-pro-260628
ARK_ENABLE_WEB_SEARCH=true
```

如果使用 Agent Plan key，需要改为该 key 支持的 endpoint 和模型，例如：

```bash
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/plan/v3
ARK_MODEL=doubao-seed-2.0-mini
```

#### 2. 启动桌面应用

```bash
npm install
npm run tauri dev
```

在中间的 Conductor 聊天区写产品想法。可以继续补充目标用户、核心场景、功能边界或成功标准；信息足够后点击 `Generate PRD`。

按需填写：

- `Workspace path`：只读工作区绝对路径，可留空。
- `Output root`：PRD 输出根目录，可留空。留空时优先写到工作区，否则写到应用运行目录。

点击 `Generate PRD` 后会调用火山方舟，生成：

- `prd.md`

#### 3. 命令行运行

```bash
npm run run:prd -- --input "你的产品想法" --output-root ./local-output
```

也可以附加只读工作区：

```bash
npm run run:prd -- --input-file ./brief.md --workspace-root /absolute/workspace --output-root ./local-output
```

## V1 文档

以下文档保留为当前 PRD 功能的实现和历史基线：

- 产品 PRD V1：[docs/product/prd-v1.md](docs/product/prd-v1.md)
- V1 产品契约：[docs/product/v1-product-contract.md](docs/product/v1-product-contract.md)
- V1 Output Contract：[docs/product/v1-output-contract.md](docs/product/v1-output-contract.md)
- V1 Role Selection Contract：[docs/product/v1-role-selection-contract.md](docs/product/v1-role-selection-contract.md)
- V1 Runtime And Tool Contract：[docs/product/v1-runtime-tool-contract.md](docs/product/v1-runtime-tool-contract.md)
- V1 Information Architecture：[docs/product/v1-information-architecture.md](docs/product/v1-information-architecture.md)
- V1 UI And Interaction Spec：[docs/design/v1-ui-and-interaction-spec.md](docs/design/v1-ui-and-interaction-spec.md)
- V1 Technical Architecture：[docs/technical/v1-technical-architecture.md](docs/technical/v1-technical-architecture.md)
- V1 Implementation Roadmap：[docs/project/v1-implementation-roadmap.md](docs/project/v1-implementation-roadmap.md)
- V1 Agent Conversation Runtime Fix：[docs/project/v1-agent-conversation-runtime-task.md](docs/project/v1-agent-conversation-runtime-task.md)

## Role Library Reference

V1 引入 [`msitarzewski/agency-agents`](https://github.com/msitarzewski/agency-agents) 作为外部角色库参考，按 MIT license 标记来源。当前本地 catalog 覆盖 17 个 division、220 个 agent role 文件。

V1 当前固定角色为：

- `Conductor` 参考 `specialized/agents-orchestrator.md`
- `Researcher` 参考 `product/product-trend-researcher.md`
- `Specialist` 参考 `product/product-manager.md`

这些角色属于 V1 PRD Pattern，不构成长期 yTriple 对 Agent 数量和拓扑的限制。