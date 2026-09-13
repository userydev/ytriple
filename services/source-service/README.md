# source-service

外部信息源的独立 API/worker。它只通过 PostgreSQL 保存采集状态，不读取 Electron 数据库、项目目录或本机 AI 规则目录。用户关注与服务器推荐来源都由 worker 按持久计划观察；Electron 关闭后计划仍继续，产生的新修订继续经 SSE 交付并可由桌面重开后补齐。

本地开发：

```sh
npm run source:up
npm run dev
```

在 ytriple 雷达的“来源与关注”中连接 `http://127.0.0.1:47321`，默认本机配对码留空。桌面会保存系统加密的设备连接，重开自动接续；不需要复制令牌或每次设置环境变量。已配置的 `YTRIPLE_SOURCE_*` 环境变量仍兼容，保存的界面连接优先。`source:down` 停止容器但保留数据库卷。

预置来源：

| 来源                  | 分类           | 周期     | 取得方式                       |
| --------------------- | -------------- | -------- | ------------------------------ |
| Hugging Face Blog     | AI 与模型      | 60 分钟  | 官方 RSS 与公开文章            |
| GitHub Changelog      | 开发工具       | 60 分钟  | 官方 feed 提供的正文           |
| 少数派                | 数字生活与方法 | 60 分钟  | 公开 RSS 与文章                |
| Solidot               | 科技与新知     | 60 分钟  | 公开 RSS 与文章                |
| OpenAI Agents JS 更新 | 开发工具       | 360 分钟 | 官方仓库 CHANGELOG.md 页面观察 |

配对时启用默认来源，升级时会给已有租户补上新增的默认项；用户已经暂停的关注保留暂停。部署者可用 `SOURCE_RECOMMENDED_DEFAULTS_ENABLED=false` 关闭自动启用，或用 `SOURCE_RECOMMENDED_SOURCES_JSON` 提供完整替代目录。替代目录每项包含 `id`、`name`、`category`、`description`、`url`、`refreshIntervalMinutes` 和 `enabledByDefault`；变更 URL 时使用新的稳定 `id`。这些是公开 URL/feed 接入，不等同 GitHub 或其他平台的账号/收藏连接器。

RSS/Atom 每次观察取最近最多 40 篇，按来源发布时间排序；稳定 guid/id 形成独立条目，同条目的新内容形成新修订。feed 只提供摘要时，最多补取其中 12 篇公开页面，失败保留摘要和缺失说明；没有宣称全文、完整历史或媒体理解。未出现在本次列表的旧条目不会自动删除。

服务器主题整理使用 worker 环境变量 `SOURCE_READING_API_KEY` 和 `SOURCE_READING_MODEL`。本机 compose 依次回退读取已有 `GEMINI_API_KEY`、`GOOGLE_API_KEY`，模型默认 `gemini-3.8-flash`。请求通过 Gemini Interactions，`store:false`，每个租户/分类最多 12 条来源材料、每条最多 7,000 字符；从这些材料形成中文重点、依据与限制。材料和模型不变则复用结果，失败保留上次完成的主题并至少等待 5 分钟再试。只有 worker 持有模型密钥，API/桌面不返回它；不读取或发送用户项目、Lib 和本地任务。没有密钥时，采集照常运行，`GET /v1/reading` 不编造主题。

阅读主题当前按关注和分类组织，尚未实现个性化推荐模型、偏好反馈与推荐质量评估。服务端主题和来源正文一起交付，桌面直接阅读；本机团队仅在用户要求研究或加工时继续处理。

诊断命令 `npm run source:verify-egress` 在 worker 内真实获取普通公开域名但不写库；`npm run source:canary` 会通过真实 API/worker 写入一个公开网页观察。`npm run source:pair` 是命令行开发入口，会输出设备配置，应作为凭据保管，不复制到文档或日志。正常桌面使用采用上面的应用内连接。

本机 OrbStack 会把公开域名解析到 RFC 2544 的 `198.18.0.0/15` 合成出口，而正常生产 SSRF 防护必须拒绝该地址段。仓库的 loopback-only compose 因此只在 worker 上显式设置 `SOURCE_LOCAL_DEV_EGRESS_MODE=orbstack-loopback`：该模式允许使用主机名的任意公开 HTTPS 来源经 OrbStack 合成出口访问，但仍拒绝 HTTP、literal IP、`localhost` / `.localhost` / `.local`、其他私网与非公网地址。每次跳转都会重新解析并校验，连接只 pin 到该次校验得到的地址，TLS/SNI 仍绑定原 HTTPS 主机名。配置 schema 要求此模式同时使用数值 loopback `SOURCE_HOST`；环境变量不设置时仍执行严格生产策略，远端或生产部署不得启用此模式。

仓库内 compose 的 bootstrap、签名和数据库口令只供绑定在 `127.0.0.1` 的本地开发。任何远端部署都必须覆盖这些值、使用 TLS 和受管 secret，并配置独立备份。首次配对后将 API 的 `SOURCE_PAIRING_ENABLED=false` 并轮换 bootstrap secret；worker 只需数据库配置，不应获取配对或签名 secret。

同一镜像支持四种角色：`api`、`worker`、`all`、`migrate`。正式部署应分别运行 API 和 worker；两者仅通过 PostgreSQL 协作。

Radar 使用的关注接口是：

- `GET /v1/reading`：当前租户的服务器主题、观点、限制和整理时的来源片段；需要正文读取权限。
- `GET /v1/recommended-sources`：服务器当前提供的来源目录。
- `GET /v1/follows`：用户来源与服务器推荐来源的计划、最近观察和错误状态。
- `POST /v1/follows`：关注公开 URL 或目录中的推荐来源，并立即建立首个持久刷新作业。
- `PATCH /v1/follows/{followId}`：修改名称、分类、间隔，或暂停/恢复。服务器推荐来源用暂停表示静音。
- `POST /v1/follows/{followId}/refresh`：显式立即刷新。
- `DELETE /v1/follows/{followId}`：取消用户创建的关注；已取得的历史修订不随关注删除。

调度与刷新共用持久作业、数据库租约和 fencing token；多个 worker 不会为同一关注同时排入活动作业。普通公开页产出稳定 `externalItemKey=page`；feed 的每篇文章以独立外部键入库，一批条目、修订、交付与作业成功状态在同一事务完成。空 feed 可以成功且 `itemCount=0`；正常成功作业保留首条 item/revision 作为兼容锚点，并返回本次条目数。

只有关联关注的作业才会进入 Radar 变更流；兼容接口 `PUT /v1/sources/url` 的一次性抓取仍返回作业和修订结果，但不会伪装成服务器推荐。用户关注和服务器推荐即使指向同一 URL 也保持两个独立的 follow 身份，每条投递携带对应 `followId`，而共享的条目与修订身份保持一致。取消用户关注不会改写已经提交的投递 provenance，在途抓取可安全结束但不会在取消后产生新投递。

`GET /v1/changes/stream` 提供需要设备 Bearer token 的 SSE 变更流。首次连接可传签名 `cursor`；断线重连传 `Last-Event-ID`，且该请求头优先于初始 URL 游标。服务先按游标补发 PostgreSQL 中已提交的 `delivery_change`，之后由一条 API 进程级 `LISTEN/NOTIFY` 连接唤醒，并保留 30 秒低频兜底查询。通知不是数据源；每次交付仍重新按租户和签名游标读取数据库。`change` 事件的 `id` 是新游标，`data` 符合 `ChangeStreamEvent`；注释帧仅作心跳，不推进游标。
