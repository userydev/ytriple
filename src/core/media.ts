import path from "node:path";
import {
  constants,
  existsSync,
  lstatSync,
  openSync,
  closeSync,
  readFileSync,
  fstatSync,
} from "node:fs";
import { promises as fs } from "node:fs";
import {
  mediaCommandSchema,
  MEDIA_STAGES,
  type MediaChannel,
  type MediaCommand,
  type MediaMaterial,
  type MediaSnapshot,
  type MediaWork,
} from "../shared/media.js";
import type { Source } from "../shared/types.js";
import {
  ensureOwnedDirectory,
  hash,
  readOwnedArtifactSync,
  textSource,
} from "./files.js";
import { now, type Store } from "./store.js";
import type { FeatureHost, FeatureTaskInput } from "./feature-host.js";

export type { MediaCommand, MediaSnapshot } from "../shared/media.js";
export { mediaCommandSchema } from "../shared/media.js";
type Receipt = {
  fingerprint: string;
  complete: boolean;
  taskId?: string;
  input?: FeatureTaskInput;
};
type MediaData = MediaSnapshot & { receipts: Record<string, Receipt> };
const rootPath = (store: Store) =>
  path.join(path.resolve(store.settings().workspaceRoot), "media-projects");
const keyFor = (root: string) => `media.v1:${root}`;
function readData(store: Store, root = rootPath(store)): MediaData {
  return store.config<MediaData>(keyFor(root), () => ({
    root,
    revision: 0,
    channels: [],
    works: [],
    receipts: {},
  }));
}
export function mediaSnapshot(store: Store): MediaSnapshot {
  const { receipts: _receipts, ...snapshot } = readData(store);
  return snapshot;
}
const locks = new WeakMap<Store, Promise<unknown>>();
function serialized<T>(store: Store, action: () => Promise<T>): Promise<T> {
  const next = (locks.get(store) ?? Promise.resolve())
    .catch(() => undefined)
    .then(action);
  locks.set(store, next);
  return next;
}
function checkRevision(
  entity: { revision: number } | undefined,
  expected: number,
) {
  if ((entity?.revision ?? 0) !== expected)
    throw new Error("媒体资料已更新，请保留当前草稿，读取最新版本后再保存。");
}
function uniqueIds(items: { id: string }[], label: string) {
  if (new Set(items.map((item) => item.id)).size !== items.length)
    throw new Error(`${label}包含重复条目。`);
}
function channelIn(data: MediaData, id: string) {
  const channel = data.channels.find((item) => item.id === id);
  if (!channel) throw new Error("频道不存在或不属于当前工作目录。");
  return channel;
}
function workIn(data: MediaData, id: string) {
  const work = data.works.find((item) => item.id === id);
  if (!work) throw new Error("作品不存在或不属于当前工作目录。");
  return work;
}
function materialMarkdown(item: MediaMaterial) {
  return [
    `### ${item.title}`,
    `关系：${item.relation === "own" ? "自有代表材料" : "对标/参考材料"}；素材使用权：${item.usageRights === "unknown" ? "尚未确认" : item.usageRights === "owned" ? "用户声明自有" : "用户声明获许可"}`,
    item.url ? `链接：${item.url}\n链接仅登记，未自动读取正文。` : "",
    item.text
      ? `用户提供正文（${item.text.length} 字符）：\n${item.text}`
      : "未提供正文。",
  ]
    .filter(Boolean)
    .join("\n\n");
}
function channelMarkdown(channel: MediaChannel) {
  return [
    `# ${channel.name}`,
    `频道版本：${channel.revision}`,
    `## 目标\n${channel.goal}`,
    `## 受众\n${channel.audience || "待补充"}`,
    `## 制作条件\n${channel.productionConditions || "待补充"}`,
    `## 表达标准\n${channel.expressionStandards || "待补充"}`,
    `## 账号\n${channel.accounts.map((account) => `- ${account.label}（${account.relation === "own" ? "自有" : "对标"}）：${account.url}；仅登记公开链接，无登录态或经营数据授权。`).join("\n") || "尚未登记"}`,
    `## 代表材料\n${channel.materials.map(materialMarkdown).join("\n\n") || "尚未提供"}`,
    `## 关联工作\n${channel.taskLinks.map((link) => `- ${MEDIA_STAGES[link.stage]}：${link.taskId}（基于频道 v${link.channelRevision}）`).join("\n") || "尚未开始"}`,
  ].join("\n\n");
}
function workMarkdown(work: MediaWork) {
  return [
    `# ${work.title}`,
    `作品版本：${work.revision}；所属频道：${work.channelId}`,
    `## 创作角度与假设\n${work.angle || "待明确"}`,
    `## 制作形式\n${work.format || "待明确"}`,
    `## 计划日期\n${work.targetDate || "未安排"}（目标日期，非实际发布时间）`,
    `## 平台与语言版本\n${work.variants.map((variant) => `- ${variant.platform} / ${variant.language} / ${variant.versionLabel}（${variant.id}）${variant.basedOnId ? `；基于版本 ${variant.basedOnId}` : ""}`).join("\n")}`,
    `## 作品材料\n${work.materials.map(materialMarkdown).join("\n\n") || "尚未提供"}`,
    `## 实际发布登记\n${work.publications.map((publication) => `- ${publication.url}；用户登记发布时间：${publication.publishedAt || "未提供"}；登记时间：${publication.recordedAt}；平台语言版本：${publication.variantId}。链接未自动核验。`).join("\n") || "尚无发布证据"}`,
    `## 导入的成品、评论与报告\n${work.feedback.map((item) => `### ${item.title}\n观察日期：${item.observedAt || "未提供"}；范围：${item.range === "provided-text" ? "用户提供的正文" : "仅链接，未读取正文"}\n${item.url}\n${item.text}`).join("\n\n") || "尚未导入"}`,
    `## 关联工作\n${work.taskLinks.map((link) => `- ${MEDIA_STAGES[link.stage]}：${link.taskId}（基于频道 v${link.channelRevision}、作品 v${link.workRevision}）`).join("\n") || "尚未开始"}`,
  ].join("\n\n");
}
function validateStoredDocument(
  data: MediaData,
  entity: MediaChannel | MediaWork,
) {
  if (!entity.documentPath) return;
  const directory =
    "channelId" in entity
      ? path.join(data.root, entity.channelId, "works", entity.id)
      : path.join(data.root, entity.id);
  const expected = path.join(
    directory,
    `${"channelId" in entity ? "work" : "channel"}-v${entity.revision}.md`,
  );
  if (entity.documentPath !== expected)
    throw new Error("媒体正文路径与登记不一致，已停止覆盖。");
  for (
    let cursor = directory;
    cursor !== path.dirname(data.root);
    cursor = path.dirname(cursor)
  ) {
    if (lstatSync(cursor).isSymbolicLink())
      throw new Error("媒体工作目录经过符号链接，已停止读写。");
  }
  const descriptor = openSync(
    expected,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > 16 * 1024 * 1024 ||
      hash(readFileSync(descriptor)) !== entity.documentHash
    )
      throw new Error("媒体正文已在外部修改，请保留该文件并核对后再继续。");
  } finally {
    closeSync(descriptor);
  }
}
async function writeDocument(
  data: MediaData,
  entity: MediaChannel | MediaWork,
) {
  const directory = await ensureOwnedDirectory(
    "channelId" in entity
      ? path.join(data.root, entity.channelId, "works", entity.id)
      : path.join(data.root, entity.id),
  );
  const document = path.join(
    directory,
    `${"channelId" in entity ? "work" : "channel"}-v${entity.revision}.md`,
  );
  const content =
    "channelId" in entity ? workMarkdown(entity) : channelMarkdown(entity);
  if (existsSync(document)) {
    const stat = lstatSync(document);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      hash(await fs.readFile(document)) !== hash(content)
    )
      throw new Error("媒体目录已有不同内容的同名版本，已保留文件并停止写入。");
  } else await fs.writeFile(document, content, { flag: "wx", mode: 0o600 });
  entity.documentPath = document;
  entity.documentHash = hash(content);
}
function materialSource(material: MediaMaterial, prefix: string): Source {
  const source = textSource(
    material.title,
    materialMarkdown(material),
    "text",
    `${prefix}:${material.id}`,
  );
  source.coverage = material.text
    ? `用户提供 ${material.text.length} 字符；链接正文未自动读取`
    : "仅用户提供的标题与链接，未读取链接正文";
  return source;
}

export async function handleMediaCommand(
  host: FeatureHost,
  raw: MediaCommand,
): Promise<void> {
  const command = mediaCommandSchema.parse(raw);
  return serialized(host.store, async () => {
    const data = readData(host.store),
      fingerprint = hash(JSON.stringify(command));
    const previous = data.receipts[command.requestId];
    if (previous && previous.fingerprint !== fingerprint)
      throw new Error("同一请求标识不能用于不同媒体操作，请重新提交。");
    if (previous?.complete) return;
    const commit = () => {
      data.revision += 1;
      data.receipts[command.requestId] = {
        fingerprint,
        complete: true,
        ...(data.receipts[command.requestId]?.taskId
          ? { taskId: data.receipts[command.requestId]!.taskId }
          : {}),
      };
      host.store.setConfig(keyFor(data.root), data);
    };
    if (command.type === "media.channel.save") {
      const existing = command.channelId
        ? channelIn(data, command.channelId)
        : undefined;
      checkRevision(existing, command.expectedRevision);
      if (existing) validateStoredDocument(data, existing);
      uniqueIds(command.input.accounts, "频道账号");
      uniqueIds(command.input.materials, "代表材料");
      const channel: MediaChannel = {
        ...command.input,
        id: existing?.id ?? command.requestId,
        revision: (existing?.revision ?? 0) + 1,
        createdAt: existing?.createdAt ?? now(),
        updatedAt: now(),
        documentPath: "",
        documentHash: "",
        taskLinks: existing?.taskLinks ?? [],
      };
      await writeDocument(data, channel);
      data.channels = [
        ...data.channels.filter((item) => item.id !== channel.id),
        channel,
      ];
      commit();
      return;
    }
    if (command.type === "media.work.save") {
      channelIn(data, command.channelId);
      const existing = command.workId
        ? workIn(data, command.workId)
        : undefined;
      if (existing && existing.channelId !== command.channelId)
        throw new Error("不能把已有作品移动到另一个频道。");
      checkRevision(existing, command.expectedRevision);
      if (existing) validateStoredDocument(data, existing);
      uniqueIds(command.input.materials, "作品材料");
      uniqueIds(command.input.variants, "作品版本");
      const variantIds = new Set(command.input.variants.map((item) => item.id));
      for (const variant of command.input.variants) {
        if (
          variant.basedOnId &&
          (!variantIds.has(variant.basedOnId) ||
            variant.basedOnId === variant.id)
        )
          throw new Error("关联的平台语言版本不存在或引用了自己。");
        const visited = new Set([variant.id]);
        let cursor = variant;
        while (cursor.basedOnId) {
          if (visited.has(cursor.basedOnId))
            throw new Error("平台语言版本不能循环关联。");
          visited.add(cursor.basedOnId);
          cursor = command.input.variants.find(
            (item) => item.id === cursor.basedOnId,
          )!;
        }
      }
      if (
        existing?.publications.some((item) => !variantIds.has(item.variantId))
      )
        throw new Error("已经登记发布的版本需要保留，不能删除其版本关联。");
      const work: MediaWork = {
        ...command.input,
        id: existing?.id ?? command.requestId,
        channelId: command.channelId,
        revision: (existing?.revision ?? 0) + 1,
        createdAt: existing?.createdAt ?? now(),
        updatedAt: now(),
        documentPath: "",
        documentHash: "",
        publications: existing?.publications ?? [],
        feedback: existing?.feedback ?? [],
        taskLinks: existing?.taskLinks ?? [],
      };
      await writeDocument(data, work);
      data.works = [...data.works.filter((item) => item.id !== work.id), work];
      commit();
      return;
    }
    if (
      command.type === "media.work.publish" ||
      command.type === "media.feedback.add"
    ) {
      const work = workIn(data, command.workId);
      checkRevision(work, command.expectedRevision);
      validateStoredDocument(data, work);
      if (command.type === "media.work.publish") {
        if (!work.variants.some((item) => item.id === command.variantId))
          throw new Error("请选择作品已有的平台与语言版本。");
        work.publications.push({
          id: command.requestId,
          variantId: command.variantId,
          url: command.url,
          publishedAt: command.publishedAt,
          recordedAt: now(),
        });
      } else
        work.feedback.push({
          id: command.requestId,
          ...command.input,
          addedAt: now(),
          range: command.input.text ? "provided-text" : "link-only",
        });
      work.revision += 1;
      work.updatedAt = now();
      await writeDocument(data, work);
      commit();
      return;
    }
    const channel = channelIn(data, command.channelId);
    const work = command.workId ? workIn(data, command.workId) : undefined;
    if (work && work.channelId !== channel.id)
      throw new Error("作品不属于这个频道。");
    if (!previous?.taskId && !previous?.input)
      checkRevision(work ?? channel, command.expectedRevision);
    validateStoredDocument(data, channel);
    if (work) validateStoredDocument(data, work);
    const selected = new Set(command.materialIds),
      available = [...channel.materials, ...(work?.materials ?? [])];
    if (
      !previous?.input &&
      (selected.size !== command.materialIds.length ||
        [...selected].some((id) => !available.some((item) => item.id === id)))
    )
      throw new Error("选中的材料已更新或不属于当前频道作品。");
    const feedback = (work?.feedback ?? []).filter((item) =>
      command.feedbackIds.includes(item.id),
    );
    if (
      !previous?.input &&
      (new Set(command.feedbackIds).size !== command.feedbackIds.length ||
        feedback.length !== command.feedbackIds.length)
    )
      throw new Error("复盘材料不属于当前作品。");
    const artifacts = command.artifacts ?? [];
    const allowedTasks = new Set(
      [...channel.taskLinks, ...(work?.taskLinks ?? [])].map(
        (link) => link.taskId,
      ),
    );
    if (
      new Set(artifacts.map((item) => `${item.taskId}:${item.artifactId}`))
        .size !== artifacts.length
    )
      throw new Error("前序成果包含重复选择。");
    let artifactBytes = 0;
    const artifactSources = previous?.input
      ? []
      : artifacts.map((reference) => {
          if (
            !allowedTasks.has(reference.taskId) ||
            !host.store.hasTask(reference.taskId)
          )
            throw new Error("前序成果不属于当前频道或作品。");
          const task = host.store.task(reference.taskId);
          const artifact = task.artifacts.find(
            (item) => item.id === reference.artifactId,
          );
          if (
            !artifact ||
            task.archivedAt ||
            !["md", "html"].includes(artifact.format)
          )
            throw new Error("请选择当前频道或作品中可读取的文字成果。");
          if (
            artifact.hash !== reference.hash ||
            artifact.version !== reference.version
          )
            throw new Error(
              "所选前序成果已有新版本，请核对后重新选择实际版本。",
            );
          const bytes = readOwnedArtifactSync(artifact, task.workspace);
          if (hash(bytes) !== reference.hash)
            throw new Error(
              "前序成果在外部发生未知修改，请核对并保存实际版本后重试。",
            );
          artifactBytes += bytes.byteLength;
          if (bytes.byteLength > 1_500_000 || artifactBytes > 4_000_000)
            throw new Error(
              "所选前序成果过大，请减少材料或先保存需要的文字部分。",
            );
          const source = textSource(
            `前序成果 · ${artifact.title} v${artifact.version}`,
            [
              `来源工作：${task.title} · ${task.id}`,
              `成果：${artifact.id} · v${artifact.version}；目标版本：${artifact.goalVersion}`,
              `原正文 UTF-8 SHA-256：${artifact.hash}`,
              "以下为选定成果版本的准确正文快照，后续修改不会改变本轮输入。",
              "--- 正文开始 ---",
              bytes.toString("utf8"),
              "--- 正文结束 ---",
            ].join("\n\n"),
            "text",
            `media-artifact:${task.id}:${artifact.id}:v${artifact.version}:${artifact.hash}`,
          );
          source.coverage = `已读取 ${artifact.format.toUpperCase()} 成果 v${artifact.version} 的 ${bytes.byteLength} 字节；不包含来源工作的聊天或其他资料。`;
          return source;
        });
    const sourceChannel = { ...channel, materials: [], taskLinks: [] };
    const sourceWork = work
      ? { ...work, materials: [], feedback: [], taskLinks: [] }
      : undefined;
    const sources = [
      textSource(
        `频道说明 · ${channel.name} v${channel.revision}`,
        channelMarkdown(sourceChannel),
        "text",
        `media:${channel.id}:v${channel.revision}`,
      ),
      ...(sourceWork
        ? [
            textSource(
              `作品说明 · ${sourceWork.title} v${sourceWork.revision}`,
              workMarkdown(sourceWork),
              "text",
              `media:${work!.id}:v${work!.revision}`,
            ),
          ]
        : []),
      ...available
        .filter((item) => selected.has(item.id))
        .map((item) => materialSource(item, `media:${channel.id}`)),
      ...artifactSources,
      ...feedback.map((item) => ({
        ...textSource(
          item.title,
          `${item.text || "仅提供链接，尚未读取正文。"}\n\n来源：${item.url || "用户粘贴"}\n观察日期：${item.observedAt || "未提供"}`,
          "text",
          `media-feedback:${item.id}`,
        ),
        coverage:
          item.range === "provided-text"
            ? `用户提供的${item.text.length}字符；不是完整平台数据`
            : "仅链接，未读取评论、报告或成品",
      })),
    ];
    const goal = [
      `围绕${work ? `作品「${work.title}」` : `频道「${channel.name}」`}完成${MEDIA_STAGES[command.stage]}。`,
      command.instruction,
      `先读取已提供的频道${work ? "与作品" : ""}说明，再按需要使用本次选中的材料。没有勾选的材料不在此次委托范围。`,
      "如提供了前序成果，先阅读其选定版本并承接已确认的表达、条件与决策；按当前阶段加工，保留实际来源与新发现的冲突，不从头重复生成或声称读取未选中的原讨论。",
      `媒体团队由主编/统筹、研究员、内容编辑协作，按实际需要分工。以原创表达、受众价值、证据与制作条件为准；对标仅作研究，不复制内容或模仿他人身份。`,
      `链接登记不表示已读取，素材使用权未知时明确保留限制。资料缺口、事实核查、实际工具执行和成果验证分别说明。`,
      command.stage === "review"
        ? "将真实导入的评论、报告或成品与创作假设对照。没有实际数据时列出待验证解释，不虚构数据、受众反馈或因果。修正仅适用于本作品，是否升级为频道标准留给用户。"
        : "",
      command.stage === "publish"
        ? "形成适用于指定平台、语言和版本的发布材料与检查说明。实际设计、剪辑、账号操作和发布仍由获准工具或用户完成，不声明已经发布。"
        : "",
      "保留可供用户编辑与继续使用的成果；不安装脚本、不读取私人路径、不自动发布或互动。",
    ]
      .filter(Boolean)
      .join("\n\n");
    const input: FeatureTaskInput = previous?.input ?? {
      requestId: `media:${command.requestId}`,
      title: `${MEDIA_STAGES[command.stage]} · ${work?.title ?? channel.name}`,
      goal,
      member: "coordinator",
      teamMode: "media",
      kind: "research",
      isolatedContext: true,
      sources,
      skillPolicy: { mode: "auto", skillIds: [] },
    };
    data.receipts[command.requestId] = {
      ...previous,
      fingerprint,
      complete: false,
      input,
    };
    host.store.setConfig(keyFor(data.root), data);
    const task = previous?.taskId
      ? host.store.task(previous.taskId)
      : await host.createWork(input);
    const entity = work ?? channel;
    if (
      !entity.taskLinks.some((item) => item.requestId === command.requestId)
    ) {
      entity.taskLinks.push({
        taskId: task.id,
        stage: command.stage,
        channelRevision: channel.revision,
        workRevision: work?.revision ?? 0,
        createdAt: now(),
        requestId: command.requestId,
        artifacts: structuredClone(artifacts),
      });
      entity.revision += 1;
      entity.updatedAt = now();
      await writeDocument(data, entity);
    }
    data.receipts[command.requestId] = {
      fingerprint,
      complete: false,
      taskId: task.id,
      input,
    };
    host.store.setConfig(keyFor(data.root), data);
    commit();
    void host.runWork(task.id).catch(() => {
      if (host.store.hasTask(task.id))
        host.store.event(task.id, {
          type: "media.start_failed",
          member: "coordinator",
          goalVersion: task.goalVersion,
          summary:
            "媒体工作未能完成，请回到原工作查看状态并重试；已保存的频道、作品与材料保留。",
        });
    });
  });
}
