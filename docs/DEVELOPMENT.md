# 开发、安装与升级

本版支持已验证的 Apple Silicon macOS 路径；运行系统下限跟随所锁定 Electron 44.4.1 的原始应用元数据，目前为 macOS 13。其他系统没有分发验收。

## 本机开发

### 团队工具的已核实用法

**Cursor（2026-09-18）**：`/Users/Admin/.local/bin/cursor-agent` 版本 `2026.08.11-e8db854`，`status` 已登录；`--list-models` 返回 `composer-2.5`、`claude-sonnet-5-thinking-high`、`claude-opus-5-thinking-high` 等。裸命令 `agent` 指向 Grok，必须用明确入口。尚未做本项目模型试单，余额未核实。

- [参数](https://cursor.com/docs/cli/reference/parameters)：`-p --output-format json --workspace <隔离树> --model <实际ID>`；`--mode plan`/`ask` 只读，省略 mode 为实现。按 chat ID `--resume`；切模型显式传 `--model` 并核对回执。参数存在不等于本项目接续已实测；规划要写正文时另用实现模式。
- Claude 规划、Composer 实现按需采用；短任务直接实现，已有 Pro 方案不重复论证。每包一名主写者，不自动多模型并发/互审；模型不可用报告缺项，不默换。以当前模型列表为准，不固化永久名单。
- [权限](https://cursor.com/docs/cli/reference/permissions)使用项目 `.cursor/cli.json` allow/deny；核对 AGENTS、`.cursor/rules`、Hooks/MCP、沙箱。`-p` 不等于只读，`--force` 扩大自动执行，不默认使用；不自动 trust、批准所有 MCP 或转云端。写入能力按本机权限验证。
- [用量](https://cursor.com/help/models-and-usage/usage-limits)区分 Cursor Models/第三方模型池，按账户 Spending 核实。Composer/Claude 不假定同价；Cursor 内 Grok 不等于本地 Grok Build 的 SuperGrok 额度。不启用超额付费或自带 API Key。

**Grok**：

本机 `grok-build` 1.0.30 与 SuperGrok 同账号；关闭外部 MCP 自动导入。F3 已用 `--oauth`、`grok-4.6` 实现及自测，日志/用量见 PLAN。

- headless 用 `--cwd`、`--prompt-file`、`--output-format json`；按返回 ID 用 `--resume` 续办。`--session-id` 只建新会话，不默认用 `--restore-code` 恢复代码；参数以本机帮助为准。
- 核对路由与权限；`--oauth` 不是计费锁。禁止自动切 API；限定工具，不默认全批准。
- [沙箱](https://docs.x.ai/build/features/sandbox)默认关闭。工作树只隔离 Git；`workspace` 仍可读取树外、联网，macOS 的子进程断网配置不生效。共享库、凭据和树外写入须单独限定。
- [OpenAI 计量](https://learn.chatgpt.com/docs/pricing)：历史、文件和工具回执均计 token；Work 与 Codex 共用额度，本团队只用普通聊天 Pro。[Grok](https://docs.x.ai/grok/faq) 的 Chat/Build 共用周额度。

[官方 headless](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md)：一次调用含多轮执行；JSON 可能含 `thought`，须筛字段。用量区分输入/缓存/输出，可能不含压缩；OAuth 成本缺失不代表免费。本机 `grok usage SESSION_ID TURN` 可读单轮记录，回执字段按版本核实。Grok 内部 token 不自动进入 Codex，回传内容才进入其上下文。

派工前核对规则、技能、Hooks、MCP。交接开销风险成立，具体包是否更贵尚未实测；观察真实任务往返、回传量和用量，不额外试单。

### 环境与检查

当前验证环境：Apple Silicon macOS、Node.js 26。桌面采用 Electron 44、React 19、TypeScript 和内置 SQLite。依赖锁在 `apps/desktop/package-lock.json`，不使用仓库内的旧构建残留。

```sh
npm run setup
npm run test:db
npm run check
npm run build
npm start
```

完整检查用专用 `ytriple_test` Postgres（55441），隔离 ycore；`npm run check:desktop` 可单独验证桌面，不依赖数据库容器。

正常启动打开本地工作空间。设置支持已有邮箱账号登录，也保留独立客户端令牌方式；凭据由 Electron main 使用系统安全存储保存，不进入 renderer 或安装包。`https://core.ydev.work` 是正式服务地址，连接在设置中配置；最近验收状态见 [PLAN.md](PLAN.md)。受控开发环境可按 ycore 文档使用 SSH 隧道排障。

运行时可通过 `YTRIPLE_DATA_DIR` 指定隔离测试数据目录；`YCORE_BASE_URL` 和 `YCORE_TOKEN` 仅在 main 进程读取。不要把凭据写入脚本、源码、截图或提交。不要把开发令牌用于公众分发。

新版默认数据目录为 `~/Library/Application Support/ytriple/desktop-v1`，保留旧实现的 `ytriple` 父目录及数据库，不自动迁移不同格式。已有本版开发空间可从设置导出备份，再在安装版恢复为独立空间；连接凭据另行配置。

## 安装和数据

打开本机构建的 DMG，把 `ytriple.app` 拖到 `Applications`，再从 Applications 打开。安装版包含运行时，不需要先安装 Node.js、npm 或项目依赖。设置中的版本信息提供版本号、构建编号、运行架构和当前空间位置。

新版默认数据位于 `~/Library/Application Support/ytriple/desktop-v1`；已有旧版的父目录、凭据和不同结构数据库原样保留。关联的 `~/AI`、`~/Code` 是原文件所在目录，不复制进应用安装包。工作和草稿存在数据目录中，不保存在 `.app` 内。

首次启动不会导入开发者的工作或密钥。已有本版工作从原应用的“备份与空间”导出 `.ytriple-backup`，在安装版选择恢复，核对内容后打开新空间。原空间不覆盖；恢复自动任务保持暂停，服务和模型连接分别配置。备份不含 AI/Code 原文件或凭据。

## 手动升级

1. 在设置备份当前空间，保存至应用包之外。
2. 结束或核对尚未完成的调用，完全退出应用。
3. 使用已核验来源的新应用替换 Applications 中的应用本身，保留数据目录。
4. 打开后核对版本、原工作、准确成果和未发送草稿，再恢复必要的自动任务。

没有自动更新或跨数据库格式降级保证。旧版应用应与升级前备份一起保留，需要回退时恢复到独立空间，不让旧程序写入不支持的新格式。恢复本身不恢复模型密钥。

安装和升级的已验收范围统一见 [当前状态](PLAN.md)。启动遇到数据库错误会显示空间位置并退出，不覆盖损坏文件。

## 构建与分发边界

`npm run check` 后执行 `npm run package:mac`，输出位于 `apps/desktop/release/<version>-<buildId>-local`；重复路径拒绝覆盖。命令固定打包本机 arm64 平台，复制明确的运行文件并核对 ASAR 清单和逐文件哈希，校验嵌套签名及 DMG；输出 `manifest.json` 与 `SHA256SUMS`。构建标识包含运行内容、Electron 版本、图标、打包脚本和权限文件的摘要。打包不读取 `.env` 内容作为应用资源。

本地开发包必须使用同一台机器上持久的自签名代码签名身份，不再回退到 ad-hoc。打包前同时设置 `YTRIPLE_SIGN_IDENTITY`（证书名称或 SHA-1）和 `YTRIPLE_SIGN_KEYCHAIN`（钥匙串绝对路径），或在仓库内创建不会提交的 `.local/macos-signing.json`：

```json
{
  "identity": "ytriple Local Code Signing",
  "keychain": "/绝对路径/ytriple-signing.keychain-db",
  "passwordFile": "/绝对路径/keychain-password"
}
```

`passwordFile` 可省略；钥匙串设置自动锁定时建议配置，或用 `YTRIPLE_SIGN_PASSWORD_FILE` 覆盖。密码文件必须是权限 `0600`、不进入仓库的小型普通文件，脚本仅用它解锁指定钥匙串，不写入安装包、manifest 或日志。

脚本从指定钥匙串的 matching identities 中精确选择证书，自签名证书不需要成为系统全局 trust root。证书 SHA-256 纳入 buildId；实际应用签名证书、CDHash 和 designated requirement 会在打包后核验并写入外层 manifest。缺少或不匹配的稳定身份会停止打包，不会改用 ad-hoc。

从旧 ad-hoc 安装包首次替换为固定自签名包时，macOS 钥匙串可能要求一次迁移授权；确认是本机新构建的 `work.ydev.ytriple` 后允许即可。同一证书和 designated requirement 不能保证跨构建免授权，实际限制见下文“开发更新与钥匙串”。不要放宽钥匙串 ACL、信任任意应用、改存明文凭据或把证书添加为系统全局 trust root；应用仍通过 `safeStorage` 使用登录钥匙串。

这种签名只用于本机未公证验证，不启用需要有效 Team ID 的发布运行时配置，也不能据此宣称互联网下载或另一台 Mac 的 Gatekeeper 验收完成。公开发行仍需要有效 Developer ID、相应 hardened runtime 配置、Apple 公证及另一台 Mac 的实际验证；不通过关闭 Gatekeeper 或删除隔离标记绕过验收。[Electron 签名说明](https://www.electronjs.org/docs/latest/tutorial/code-signing)


## 开发更新与钥匙串

用户已明确要求不要在开发验证中反复输入钥匙串密码。UI 迭代优先做类型/回归检查并复用已授权版本，集中打包安装；不要连续重装启动或检查凭据。用户报告重复提示后立即停止这类验证，记录未通过，不继续要求密码。

本机自签名可保持证书 DR 一致，但 macOS 旧登录钥匙串条目的 partition_id 仍可能按每个构建 cdhash 限制。`TeamIdentifier=not set` 的本地构建不能承诺更新后免授权；一次同版本重启成功不是升级验证。有效 Apple Developer 签名尚未配置。不得为消除提示保存用户 Mac 密码、允许所有应用访问条目或降低全局钥匙串保护。
