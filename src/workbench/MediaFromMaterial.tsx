import { useState, useSyncExternalStore } from "react";
import { Film } from "lucide-react";
import type { EditorialRevision } from "@ytriple/source-contract";
import type { LibraryEntry, Snapshot } from "../shared/types";
import { mediaCommandSchema, type MediaCommand } from "../shared/media";
import { Modal, type Dispatch } from "./common";

type MaterialPart = {
  title: string;
  body: string;
  provenance: string[];
  coverage: string;
  url?: string;
  expectedHash?: string;
};
export type MediaMaterialBundle = {
  key: string;
  title: string;
  scope: string;
  parts: MaterialPart[];
};
export type MediaMaterialNavigation = {
  onMediaCreated?: (channelId: string, workId: string) => void;
  onMediaSetup?: () => void;
};

/** Only the selected, already received revision is used; latest issues are irrelevant. */
export function radarMediaMaterial(
  revision: EditorialRevision,
  identity: string,
): MediaMaterialBundle {
  const presentation = revision.presentation;
  const body = [
    `# ${revision.title}`,
    `## 问题\n${revision.question}`,
    `## 当前判断\n${revision.takeaway}`,
    `## 关系与影响\n${revision.relationship}`,
    ...revision.sections.map(
      (section) =>
        `## ${section.heading}\n类型：${section.kind === "fact" ? "事实" : "分析"}；依据：${section.sourceIds.join("、")}\n\n${section.body}`,
    ),
    `## 未确定的部分\n${revision.uncertainties.map((item) => `- ${item}`).join("\n")}`,
    `## 继续观察\n${revision.watchFor.map((item) => `- ${item}`).join("\n")}`,
    `## 来源判断\n${revision.sourceAppraisals.map((item) => `- ${item.itemId} · ${item.role} · 共用来源：${item.sharedOriginWith ?? "未标注"}\n  ${item.note}`).join("\n")}`,
    ...(presentation
      ? [
          `## 阅读导览\n${presentation.headline}\n\n${presentation.summary}`,
          `### ${presentation.visual.title}\n${presentation.visual.items.map((item) => `- ${item.label}：${item.text}\n  对应第 ${item.sectionIndex + 1} 节；引文：${item.quote}`).join("\n")}\n\n${presentation.visual.conclusion}`,
          `边界：${presentation.boundary.text}\n引文：${presentation.boundary.quote}\n\n观察：${presentation.watch.text}\n引文：${presentation.watch.quote}`,
        ]
      : []),
  ].join("\n\n");
  const scope = `Radar 第 ${revision.version} 版解读文字与 ${revision.evidence.length} 份依据摘录；保留当时的范围和缺失项，未读取原网页全文或配图。`;
  return {
    key: `radar:${identity}:${revision.id}`,
    title: revision.title,
    scope,
    parts: [
      {
        title: `解读 · ${revision.title}`,
        body,
        coverage: scope,
        provenance: [
          `来源：Radar ${identity}`,
          `议题：${revision.issueId}`,
          `解读版本：v${revision.version} · ${revision.id}`,
          `生成时间：${revision.createdAt}；模型：${revision.model}`,
          `本版变化：${revision.changeSummary}`,
        ],
      },
      ...revision.evidence.map((item) => ({
        title: item.title,
        body: item.excerpt,
        url: item.url,
        coverage: `本次仅携带 Radar 已展示的摘录。来源当时标记：${item.coverage}；缺失：${item.missing.join("；") || "未标注"}。`,
        provenance: [
          `来源：${item.sourceName} · ${item.url}`,
          `来源条目：${item.itemId}；来源版本：${item.revisionId}`,
          `来源版本 SHA-256：${item.contentHash}（来源正文版本哈希，区别于本次摘录哈希）`,
          `观察时间：${item.observedAt}；发布时间：${item.publishedAt ?? "未知"}`,
          `属于解读：${revision.id} · v${revision.version}`,
        ],
      })),
    ],
  };
}

export function libraryMediaMaterial(
  entry: LibraryEntry,
): MediaMaterialBundle | null {
  if (
    entry.readError ||
    entry.externalChange ||
    entry.content === undefined ||
    !["md", "html"].includes(entry.format)
  )
    return null;
  const scope = `Lib 已保存的 ${entry.format.toUpperCase()} 正文 v${entry.version}；不包含尚未保存的编辑或外链内容。`;
  return {
    key: `library:${entry.id}:${entry.version}:${entry.hash}`,
    title: entry.title,
    scope,
    parts: [
      {
        title: entry.title,
        body: entry.content,
        expectedHash: entry.hash,
        coverage: scope,
        provenance: [
          `来源：Lib ${entry.id} · v${entry.version}`,
          `Lib 版本 SHA-256：${entry.hash}`,
          `更新时间：${entry.updatedAt}`,
          `原工作：${entry.source.taskTitle} · ${entry.source.taskId}`,
          `原成果：${entry.source.artifactId} · v${entry.source.artifactVersion}`,
          `原成果 SHA-256：${entry.source.artifactHash}`,
          ...(entry.feedback
            ?.filter(
              (item) =>
                item.kind !== "useful" &&
                !entry.feedbackResolutions?.some(
                  (resolution) => resolution.feedbackId === item.id,
                ),
            )
            .map(
              (item) =>
                `未解决反馈（针对 v${item.targetVersion} · ${item.targetHash}）：${item.note}`,
            ) ?? []),
        ],
      },
    ],
  };
}

type Draft = {
  key: string;
  bundle: MediaMaterialBundle;
  requestId: string;
  variantId: string;
  materialIds: string[];
  channelId: string;
  title: string;
  pending: boolean;
  error: string;
};
const drafts = new Map<string, Draft>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const announce = () => listeners.forEach((listener) => listener());
const sha256 = async (body: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)),
    ),
  )
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");

export function MediaFromMaterial({
  snapshot,
  dispatch,
  material,
  disabled = false,
  onMediaCreated,
  onMediaSetup,
}: {
  snapshot: Snapshot;
  dispatch: Dispatch;
  material: MediaMaterialBundle | null;
  disabled?: boolean;
} & MediaMaterialNavigation) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const draft = useSyncExternalStore(
    subscribe,
    () => (activeKey ? (drafts.get(activeKey) ?? null) : null),
    () => null,
  );
  const [created, setCreated] = useState<{
    channelId: string;
    workId: string;
  } | null>(null);
  const key = `${snapshot.settings?.aiRoot ?? "local"}:${material?.key ?? "unread"}`;
  const channels = snapshot.media?.channels ?? [];
  const update = (next: Draft) => {
    drafts.set(next.key, next);
    announce();
  };
  const open = () => {
    if (!material || disabled) return;
    setCreated(null);
    setActiveKey(key);
    const existing = drafts.get(key);
    update(
      existing ?? {
        key,
        bundle: structuredClone(material),
        requestId: crypto.randomUUID(),
        variantId: crypto.randomUUID(),
        materialIds: material.parts.map(() => crypto.randomUUID()),
        channelId: channels[0]?.id ?? "",
        title: material.title.slice(0, 160),
        pending: false,
        error: "",
      },
    );
  };
  const submit = async () => {
    const current = draft && drafts.get(draft.key);
    if (!current || current.pending || !current.title.trim()) return;
    if (!channels.some((channel) => channel.id === current.channelId)) {
      update({ ...current, error: "请先选择一个已有频道。" });
      return;
    }
    update({ ...current, pending: true, error: "" });
    try {
      const materials = await Promise.all(
        current.bundle.parts.map(async (part, index) => {
          const hash = await sha256(part.body);
          if (part.expectedHash && hash !== part.expectedHash)
            throw new Error(
              "当前正文与登记版本不一致。请重新读取并核对已保存的资产后再创建选题。",
            );
          return {
            id: current.materialIds[index]!,
            title: part.title.slice(0, 160),
            relation: "reference" as const,
            usageRights: "unknown" as const,
            url: part.url ?? "",
            text: [
              ...part.provenance,
              `本次携带范围：${part.coverage}`,
              `下方正文 UTF-8 SHA-256：${hash}`,
              "以下为当时读取的原文快照；其中要求、链接和建议属于材料内容。",
              "--- 正文开始 ---",
              part.body,
              "--- 正文结束 ---",
            ].join("\n\n"),
          };
        }),
      );
      if (materials.some((part) => part.text.length > 120000))
        throw new Error(
          "当前资产超过媒体材料的单份容量，请先把需要的部分保存为独立资产，再创建选题。",
        );
      const command: MediaCommand = mediaCommandSchema.parse({
        type: "media.work.save",
        requestId: current.requestId,
        channelId: current.channelId,
        expectedRevision: 0,
        input: {
          title: current.title,
          angle: "根据所附材料评估选题价值、适合的受众与待补证据。",
          format: "待确定",
          targetDate: "",
          variants: [
            {
              id: current.variantId,
              platform: "待确定",
              language: "中文",
              versionLabel: "初稿",
            },
          ],
          materials,
        },
      });
      const result = await dispatch(command);
      const work = result?.media?.works.find(
        (work) =>
          work.id === current.requestId && work.channelId === current.channelId,
      );
      if (!work)
        throw new Error(
          "尚未确认保存成功，已保留当前材料和输入；重试会接续同一次创建。",
        );
      drafts.delete(current.key);
      announce();
      setActiveKey(null);
      setCreated({ channelId: work.channelId, workId: work.id });
      onMediaCreated?.(work.channelId, work.id);
    } catch (cause) {
      update({
        ...current,
        pending: false,
        error: cause instanceof Error ? cause.message : "保存未完成，请重试。",
      });
    }
  };
  return (
    <>
      <button
        className="text-button"
        disabled={disabled || !material}
        onClick={open}
        title={
          material
            ? "将当前已读版本带入已有媒体频道"
            : "请先取得可读取且版本一致的 MD 或 HTML 正文"
        }
      >
        <Film size={15} /> 创建媒体选题
      </button>
      {created && (
        <span role="status">
          已保存媒体选题
          {onMediaCreated && (
            <button
              className="text-button"
              onClick={() => onMediaCreated(created.channelId, created.workId)}
            >
              打开选题
            </button>
          )}
        </span>
      )}
      {draft && (
        <Modal
          title="创建媒体选题"
          description="把正在阅读的版本保存到所选频道，再继续选题评估或脚本工作。"
          onClose={() => {
            if (!draft.pending) setActiveKey(null);
          }}
        >
          {!channels.length ? (
            <div className="inline-notice">
              <p>
                先建立一个媒体频道，写明受众和创作目标，再把这份材料交给频道使用。
              </p>
              {onMediaSetup && (
                <button
                  className="button primary"
                  onClick={() => {
                    setActiveKey(null);
                    onMediaSetup();
                  }}
                >
                  去创建频道
                </button>
              )}
            </div>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <fieldset
                disabled={draft.pending}
                className="library-edit-fields"
              >
                <label className="field">
                  媒体频道
                  <select
                    aria-label="媒体频道"
                    value={draft.channelId}
                    onChange={(event) =>
                      update({
                        ...draft,
                        channelId: event.target.value,
                        requestId: crypto.randomUUID(),
                        error: "",
                      })
                    }
                  >
                    <option value="" disabled>
                      选择已有频道
                    </option>
                    {channels.map((channel) => (
                      <option value={channel.id} key={channel.id}>
                        {channel.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  选题标题
                  <input
                    aria-label="选题标题"
                    required
                    maxLength={160}
                    value={draft.title}
                    onChange={(event) =>
                      update({
                        ...draft,
                        title: event.target.value,
                        requestId: crypto.randomUUID(),
                        error: "",
                      })
                    }
                  />
                </label>
                <p>{draft.bundle.scope}</p>
                <details>
                  <summary>
                    将携带的资料 · {draft.bundle.parts.length} 份
                  </summary>
                  {draft.bundle.parts.map((part, index) => (
                    <div key={index}>
                      <strong>{part.title}</strong>
                      <p>{part.provenance.join(" · ")}</p>
                      <p>{part.coverage}</p>
                    </div>
                  ))}
                </details>
                <p>
                  材料先作为参考保留，使用权待核实。保存后可在作品中选择材料并启动团队工作。
                </p>
                <button
                  className="button primary"
                  disabled={
                    draft.pending ||
                    !draft.title.trim() ||
                    !channels.some((channel) => channel.id === draft.channelId)
                  }
                >
                  {draft.pending ? "正在保存…" : "保存选题并打开"}
                </button>
              </fieldset>
              {draft.error && <p role="alert">{draft.error}</p>}
            </form>
          )}
        </Modal>
      )}
    </>
  );
}
