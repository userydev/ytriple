# ytriple

面向个人开发者与创作者的 AI 工作台。首页、雷达与项目承接不同工作入口；同一工作可以展开决策、过程、结果，保留草稿、材料与成果版本。

当前为重新开发中的桌面工程，尚未完成产品全部功能。真实进度与未完成项见 [交付记录](docs/DELIVERY.md)，界面和交互依据见 [UI 确认稿](docs/UI-BASELINE.md)。

## 本机开发

当前验证环境：Apple Silicon macOS、Node.js 26。桌面采用 Electron 44、React 19、TypeScript 和内置 SQLite。依赖锁在 `apps/desktop/package-lock.json`，不使用仓库内的旧构建残留。

```sh
npm run setup
npm run test:db
npm run check
npm run build
npm start
```

完整检查需要 Docker 启动专用 `ytriple_test` Postgres（loopback 55441），与 ycore 的测试库隔离；`npm run check:desktop` 可单独验证桌面，不依赖数据库容器。

正常启动打开本地工作空间。设置支持已有邮箱账号登录，也保留独立客户端令牌方式；凭据由 Electron main 使用系统安全存储保存，不进入 renderer 或安装包。`https://core.ydev.work` 是正式服务地址；公网尚未验证畅通时，受控开发环境可按 ycore 文档通过现有 SSH 隧道联调。

运行时可通过 `YTRIPLE_DATA_DIR` 指定隔离测试数据目录；`YCORE_BASE_URL` 和 `YCORE_TOKEN` 仅在 main 进程读取。不要把凭据写入脚本、源码、截图或提交。不要把开发令牌用于公众分发。

新版默认数据目录为 `~/Library/Application Support/ytriple/desktop-v1`，保留旧实现的 `ytriple` 父目录及数据库，不自动迁移不同格式。已有本版开发空间可从设置导出备份，再在安装版恢复为独立空间；连接凭据另行配置。

## macOS 安装包

Apple Silicon Mac 上运行 `npm run package:mac`，在 `apps/desktop/release/<version>-<buildId>-local` 生成 `.app`、DMG、清单和 SHA-256。打包前自动重建，以白名单仅装入 main/preload、前端与版本元数据，不含源码映射、开发数据库、凭据或测试文件。重复输出路径拒绝覆盖。

当前为本机开发包：ad-hoc 签名、未公证，不能作为公开分发已验收的版本。安装、升级和数据边界见 [macOS 安装与升级](docs/INSTALL.md)。运行安装版不需要外部 Node.js 或 npm；版本、构建编号和当前数据位置可在设置查看。

## 代码

- `apps/desktop/src/core`：工作、引用、版本、持久化、团队执行及 ycore 协议适配；不依赖 Electron 或 React。
- `apps/desktop/src/main`：桌面壳、安全存储、文件对话框与受限 IPC。
- `apps/desktop/src/ui`：业务页面、轻对话和三工作面。
- `apps/desktop/tests`：版本、提交、队列、停止/恢复、流协议及同步测试。
- `apps/service`：ytriple 私有空间 API 与 Postgres 持久化，复用同仓库领域代码；不会写入 ycore 公共材料库。当前接通项目、选择上传的文本和配置，服务端团队执行及桌面服务空间入口仍在开发，见 [服务工作空间](docs/SERVICE.md)。
- `supabase/migrations`：仅 ytriple 私有 schema 与角色的迁移，不是 ycore 的迁移目录。

本地公共材料缓存与私有工作分开；阅读与布局切换不调用模型。团队工作由明确发送启动；雷达整理由明确的整理/更新动作启动，定时处理需先启用相应委托。源材料中的说明不能获得工具权限。

桌面进程隔离与 IPC 边界参考 [Electron 安全文档](https://www.electronjs.org/docs/latest/tutorial/security)，持久化接口参考 [Node SQLite 文档](https://nodejs.org/api/sqlite.html)。已验证的约束以交付记录为准。
