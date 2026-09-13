# source-service

外部信息源的独立 API/worker。它只通过 PostgreSQL 保存采集状态，不读取 Electron 数据库、项目目录或本机 AI 规则目录。用户关注与服务器推荐来源都由 worker 按持久计划观察；Electron 关闭后计划仍继续，产生的新修订继续经 SSE 交付并可由桌面重开后补齐。

按 2026-09-13 产品定义，本目录承担三项服务器责任中的**信息服务**。AI 能力服务、用户订阅与托管委托属于后续工程范围；当前设备配对、信息源 worker 和编辑模型调用不表示这些能力已经上线。以下预置方向是当前供给样本，不代表所有开发者和创作者的固定兴趣；普通阅读继续独立成立，明确交给团队时才带入对应版本的资料。

本地开发：

```sh
npm run source:up
npm run dev
```

在 ytriple 雷达的“信息源 → 管理与添加来源”中连接 `http://127.0.0.1:47321`，默认本机配对码留空。桌面会保存系统加密的设备连接，重开自动接续；不需要复制令牌或每次设置环境变量。已配置的 `YTRIPLE_SOURCE_*` 环境变量仍兼容，保存的界面连接优先。`source:down` 停止容器但保留数据库卷。

预置来源：

| 来源                  | 分类           | 周期     | 取得方式                       |
| --------------------- | -------------- | -------- | ------------------------------ |
| Hugging Face Blog     | AI 与模型      | 60 分钟  | 官方 RSS 与公开文章            |
| GitHub Changelog      | 开发工具       | 60 分钟  | 官方 feed 提供的正文           |
| 少数派                | 数字生活与方法 | 60 分钟  | 公开 RSS 与文章                |
| Solidot               | 科技与新知     | 60 分钟  | 公开 RSS 与文章                |
| OpenAI Agents JS 更新 | 开发工具       | 360 分钟 | 官方仓库 CHANGELOG.md 页面观察 |
| 美联储货币政策        | 金融与宏观     | 180 分钟 | 官方声明与纪要 RSS、公开正文   |
| NVIDIA 官方动态       | 科技与公司业绩 | 120 分钟 | 官方新闻 RSS、公开公告         |

配对时启用默认来源，升级时会给已有租户补上新增的默认项；用户已经暂停的关注保留暂停。部署者可用 `SOURCE_RECOMMENDED_DEFAULTS_ENABLED=false` 关闭自动启用，或用 `SOURCE_RECOMMENDED_SOURCES_JSON` 提供完整替代目录。替代目录每项包含 `id`、`name`、`category`、`description`、`url`、`refreshIntervalMinutes` 和 `enabledByDefault`；变更 URL 时使用新的稳定 `id`。这些是公开 URL/feed 接入，不等同 GitHub 或其他平台的账号/收藏连接器。

RSS/Atom 每次观察取最近最多 40 篇，按来源发布时间排序；稳定 guid/id 形成独立条目，同条目的新内容形成新修订。feed 只提供摘要时，最多补取其中 12 篇公开页面，失败保留摘要和缺失说明；没有宣称全文、完整历史或媒体理解。未出现在本次列表的旧条目不会自动删除。

服务器栏目制作使用 worker 环境变量 `SOURCE_READING_API_KEY` 和 `SOURCE_READING_MODEL`。本机 compose 依次回退读取已有 `GEMINI_API_KEY`、`GOOGLE_API_KEY`，模型默认 `gemini-3.8-flash`。通过 Gemini Interactions 调用，`store:false`。只发送有关来源文本、此前议题和明确提交的纠正，不读取或发送用户项目、Lib、其他本地任务或租户内部路由 ID。模型密钥只留在 worker。

当前流程从每租户最近 160 条活跃关注材料中，按科技、AI、金融、股票关键词筛选每方向最多 24 个候选，按规范 URL/内容指纹合并完全重复材料；编辑模型选择最多两个具体问题，已有问题复用议题 ID。再用有关材料写作，最多 12 份证据，每份实际使用最多 7,000 字符，截取范围明确记入缺口。词命中不等同可发布；允许不选题、无新增理解不发布。原始发布、报道、评论及无法判断的出处分开说明，共同出处不当作多份独立验证。

`editorial_issue` 保存稳定问题，`editorial_revision` 保存不可变正文和证据，`editorial_correction` 保存意见及复核，`editorial_run` 保存批次输入和选题计划。材料、模型和纠正输入不变则复用；失败至少间隔 5 分钟重试并保留既有解读。多 worker 用租户/方向及议题锁避免重复制作；写入校验模型所读旧版本。日志仅记失败阶段/校验路径，不能输出模型原文、输入或密钥。提供商只接收简化的 JSON Schema 语法，完整字段、长度、引用和纠正结果仍在发布前严格校验；真实接口曾拒绝复杂嵌套约束，本轮已调整并实测。

migration 12 增加 `editorial_presentation`，按租户及准确解读版本保存附加阅读结构。视觉编辑仅收到已发布正文、段落和限制，生成短标题、核心理解及按内容选择的对照／过程／并列条件；要素必须附对应段落的连续原文定位，主要限制及后续观察同样定位到已有文字。无合适结构时可返回 `none`。这是原文的附加表达，不重新研究事实，不改写正文、证据、版本号或更新历史。未生成或失败时原文仍可读；两路并发、议题版本锁及至少 5 分钟退避限制重复请求。当前与准确旧版接口以可选 `presentation` 字段附带已保存的结构；字段缺失不代表读取失败。客户端的栏目同步自然接收补齐结果。原文定位校验不能替代事实核查或证明推论正确。

纠正绑定具体版本和请求 ID，重复提交幂等，旧版本返回冲突；采纳必须实际修改解读，否则保持待复核。服务可回复不支持或仍需证据，用户意见不自动成为事实。该功能是明确纠正，不是用户画像/协同推荐。首页取得最近 24 条议题，每条附最近 30 条版本摘要及纠正；完整旧版可按 ID 单独读取。桌面每 30 秒同步栏目，也可主动更新；已打开版本和已缓存旧版保持可读，明确交给团队时携带对应版本的解读及证据范围。

migration 13 增加 `editorial_edition`。独立主编从每租户最多 24 个当前议题中选编 0–5 条，确定顺序并重写紧凑标题与短解读；输入包含原始来源片段及发布时间。随后以来源材料单独复核时间、对象范围、条件与事实强度，缺乏支持的条目可剔除。长度和引用错误允许一次有界修订，不能用截断文本掩盖问题。模型、当前修订集合和编辑策略形成输入指纹；发布后整期保存不覆盖，至少 5 分钟重试退避和租户锁避免重复制作。失败保留上一期，旧选编中的条目若已有新修订则先退出选读，不能未经编辑自动提升新版。原议题正文及证据历史保持不变，选编是附加表达；完整议题仍可浏览。

选中的议题可附带来源文章提供的报道配图（`cover`）。只读取制作时保存的来源地址及最多一个明确引用的文章地址，不联网搜索泛化主题图片。页面与图片共用已有 DNS 固定、重定向复检、私网阻断及响应上限；仅接受有有效尺寸的 JPEG/PNG/WebP，单张最多 600 KiB，不采用 SVG、过小图片、明显 logo 或占位图。图片和原始出处随准确版本缓存，渲染层不直接联网；不可用就省略，不阻塞文字发布。配图不是独立证据，不改变材料中“未读取图片或视频”的分析范围。当前为来源文章 OG 图片的有限支持，不是视频处理或完整媒体理解。

`GET /v1/editorial` 附带可选 `edition`，其中顺序是编辑结果；具体 `latest` 与准确旧版接口附带对应的阅读结构和可用配图。已有客户端可以忽略可选字段。旧 `GET /v1/reading` 仅保留兼容缓存，当前 worker 已停止分类摘要制作；新增 `editorial` 能力标记让桌面使用分析栏目。没有模型密钥时栏目等待真实制作，来源采集继续；不会插入样例文章。

诊断命令 `npm run source:verify-egress` 在 worker 内真实获取普通公开域名但不写库；`npm run source:canary` 会通过真实 API/worker 写入一个公开网页观察。`npm run source:pair` 是命令行开发入口，会输出设备配置，应作为凭据保管，不复制到文档或日志。正常桌面使用采用上面的应用内连接。

本机 OrbStack 会把公开域名解析到 RFC 2544 的 `198.18.0.0/15` 合成出口，而正常生产 SSRF 防护必须拒绝该地址段。仓库的 loopback-only compose 因此只在 worker 上显式设置 `SOURCE_LOCAL_DEV_EGRESS_MODE=orbstack-loopback`：该模式允许使用主机名的任意公开 HTTPS 来源经 OrbStack 合成出口访问，但仍拒绝 HTTP、literal IP、`localhost` / `.localhost` / `.local`、其他私网与非公网地址。每次跳转都会重新解析并校验，连接只 pin 到该次校验得到的地址，TLS/SNI 仍绑定原 HTTPS 主机名。配置 schema 要求此模式同时使用数值 loopback `SOURCE_HOST`；环境变量不设置时仍执行严格生产策略，远端或生产部署不得启用此模式。

仓库内 compose 的 bootstrap、签名和数据库口令只供绑定在 `127.0.0.1` 的本地开发。任何远端部署都必须覆盖这些值、使用 TLS 和受管 secret，并配置独立备份。首次配对后将 API 的 `SOURCE_PAIRING_ENABLED=false` 并轮换 bootstrap secret；worker 只需数据库配置，不应获取配对或签名 secret。

同一镜像支持四种角色：`api`、`worker`、`all`、`migrate`。正式部署应分别运行 API 和 worker；两者仅通过 PostgreSQL 协作。

Radar 使用的关注接口是：

- `GET /v1/editorial`：当前租户的聚焦议题、最新解读、版本摘要及纠正状态；需要正文读取权限。
- `GET /v1/editorial/{issueId}/revisions/{revisionId}`：准确旧版与其证据快照。
- `POST /v1/editorial/{issueId}/corrections`：带 `Idempotency-Key`，正文为 `{revisionId,text}`；需 `sources:write`，可由 `content.correct` 策略拒绝。
- `GET /v1/reading`：旧分类主题的兼容读取。
- `GET /v1/recommended-sources`：服务器当前提供的来源目录。
- `GET /v1/follows`：用户来源与服务器推荐来源的计划、最近观察和错误状态。
- `POST /v1/follows`：关注公开 URL 或目录中的推荐来源，并立即建立首个持久刷新作业。
- `PATCH /v1/follows/{followId}`：修改名称、分类、间隔，或暂停/恢复。服务器推荐来源用暂停表示静音。
- `POST /v1/follows/{followId}/refresh`：显式立即刷新。
- `DELETE /v1/follows/{followId}`：取消用户创建的关注；已取得的历史修订不随关注删除。

调度与刷新共用持久作业、数据库租约和 fencing token；多个 worker 不会为同一关注同时排入活动作业。普通公开页产出稳定 `externalItemKey=page`；feed 的每篇文章以独立外部键入库，一批条目、修订、交付与作业成功状态在同一事务完成。空 feed 可以成功且 `itemCount=0`；正常成功作业保留首条 item/revision 作为兼容锚点，并返回本次条目数。

只有关联关注的作业才会进入 Radar 变更流；兼容接口 `PUT /v1/sources/url` 的一次性抓取仍返回作业和修订结果，但不会伪装成服务器推荐。用户关注和服务器推荐即使指向同一 URL 也保持两个独立的 follow 身份，每条投递携带对应 `followId`，而共享的条目与修订身份保持一致。取消用户关注不会改写已经提交的投递 provenance，在途抓取可安全结束但不会在取消后产生新投递。

`GET /v1/changes/stream` 提供需要设备 Bearer token 的 SSE 变更流。首次连接可传签名 `cursor`；断线重连传 `Last-Event-ID`，且该请求头优先于初始 URL 游标。服务先按游标补发 PostgreSQL 中已提交的 `delivery_change`，之后由一条 API 进程级 `LISTEN/NOTIFY` 连接唤醒，并保留 30 秒低频兜底查询。通知不是数据源；每次交付仍重新按租户和签名游标读取数据库。`change` 事件的 `id` 是新游标，`data` 符合 `ChangeStreamEvent`；注释帧仅作心跳，不推进游标。

### 桌面代理 DNS 的兼容读取

公开 URL 连接器默认仍要求系统解析为公网地址。桌面本机回退显式传入 `syntheticDNSFallback: "cloudflare"`：只有系统全部返回 `198.18/15` 虚拟地址时，才通过固定 IP、TLS 验证的 Cloudflare DNS-over-HTTPS 查询真实 A/AAAA，再校验和固定原站连接。任何其他私网或混合结果仍拒绝，跳转也逐次检查；这不是放宽来源 SSRF 边界。接口格式见 [Cloudflare 官方文档](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/)。本轮已实际取得 Example Domain 和 Wikipedia 文字，并在 Electron 未连接信息服务时复验 Example Domain。
