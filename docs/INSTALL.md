# macOS 安装与升级

本版支持已验证的 Apple Silicon macOS 路径；运行系统下限跟随所锁定 Electron 44.4.1 的原始应用元数据，目前为 macOS 13。其他系统没有分发验收。

## 安装和数据

打开本机构建的 DMG，把 `ytriple.app` 拖到 `Applications`，再从 Applications 打开。安装版包含运行时，不需要先安装 Node.js、npm 或项目依赖。设置中的版本信息提供版本号、构建编号、运行架构和当前空间位置。

新版默认数据位于 `~/Library/Application Support/ytriple/desktop-v1`；已有旧版的父目录、凭据和不同结构数据库原样保留。关联的 `~/AI`、`~/Code` 是原文件所在目录，不复制进应用安装包。工作和草稿存在数据目录中，不保存在 `.app` 内。

首次启动不会导入开发者的工作或密钥。已有本版工作从原应用的“备份与空间”导出 `.ytriple-backup`，在安装版选择恢复，核对内容后打开新空间。原空间不覆盖；恢复自动任务保持暂停，服务和模型连接分别配置。备份不含 AI/Code 原文件或凭据。

## 手动升级

1. 在设置备份当前空间，保存至应用包之外。
2. 结束或核对尚未完成的调用，完全退出应用。
3. 使用已核验来源的新应用替换 Applications 中的应用本身，保留数据目录。
4. 打开后核对版本、原工作、准确成果和未发送草稿，再恢复必要的自动任务。

当前没有自动更新服务，也没有未经验证的跨数据库格式降级保证。旧版应用应与升级前备份一起保留，需要回退时恢复到独立空间，不让旧程序写入不支持的新格式。恢复本身不恢复模型密钥。

2026-09-17 已在本机验证干净安装、从本版开发空间备份恢复、原生切换空间，以及 `0.1.0` 的两个构建之间替换应用包。升级后原成果版本、采用关系、草稿和提交身份保持；这不证明跨数据库格式升级。启动遇到数据库错误会显示空间位置并退出，损坏测试文件保持原样。

## 构建与分发边界

`npm run check` 后执行 `npm run package:mac`。命令固定打包本机 arm64 平台，复制明确的运行文件并核对 ASAR 清单和逐文件哈希，校验嵌套签名及 DMG；输出 `manifest.json` 与 `SHA256SUMS`。构建标识包含运行内容、Electron 版本、图标、打包脚本和权限文件的摘要。打包不读取 `.env` 内容作为应用资源。

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

从旧 ad-hoc 安装包首次替换为固定自签名包时，macOS 钥匙串可能要求一次迁移授权；确认是本机新构建的 `work.ydev.ytriple` 后允许即可。后续构建保持同一证书和 designated requirement，正常情况下不应每次重新询问。不要放宽钥匙串 ACL、信任任意应用、改存明文凭据或把证书添加为系统全局 trust root；应用仍通过 `safeStorage` 使用登录钥匙串。

这种签名只用于本机未公证验证，不启用需要有效 Team ID 的发布运行时配置，也不能据此宣称互联网下载或另一台 Mac 的 Gatekeeper 验收完成。公开发行仍需要有效 Developer ID、相应 hardened runtime 配置、Apple 公证及另一台 Mac 的实际验证；不通过关闭 Gatekeeper 或删除隔离标记绕过验收。[Electron 签名说明](https://www.electronjs.org/docs/latest/tutorial/code-signing)


## 开发更新与钥匙串（2026-09-18 更正）

用户已明确要求不要在开发验证中反复输入钥匙串密码。UI 迭代优先做类型/回归检查并复用已授权版本，集中打包安装；不要连续重装启动来验证细小样式修改。

本机自签名可保持证书 DR 一致，但 macOS 旧登录钥匙串条目的 partition_id 仍可能按每个构建 cdhash 限制。`TeamIdentifier=not set` 的本地构建不能承诺更新后免授权；一次同版本重启成功不是升级验证。有效 Apple Developer 签名尚未配置。不得为消除提示保存用户 Mac 密码、允许所有应用访问条目或降低全局钥匙串保护。
