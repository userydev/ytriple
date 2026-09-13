import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ArrowUpRight,
  ArrowLeft,
  ArrowRight,
  Check,
  FileText,
  Film,
  Plus,
  Save,
  X,
} from "lucide-react";
import type { Snapshot, Task } from "../shared/types";
import {
  MEDIA_STAGES,
  type MediaAccount,
  type MediaArtifactReference,
  type MediaChannel,
  type MediaChannelInput,
  type MediaCommand,
  type MediaMaterial,
  type MediaStage,
  type MediaTaskLink,
  type MediaVariant,
  type MediaWork,
  type MediaWorkInput,
} from "../shared/media";
import { Modal, STATUS_NAMES, formatDate, type Dispatch } from "./common";

const uuid = () => crypto.randomUUID();
const drafts = new Map<string, FormState<unknown>>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
type FormState<T> = {
  value: T;
  base: number;
  requestId: string;
  pending: boolean;
  error: string;
};
function useForm<T>(
  key: string,
  value: T,
  revision: number,
  contextVersion?: string,
) {
  const fallback = useMemo<FormState<T>>(
    () => ({
      value,
      base: revision,
      requestId: uuid(),
      pending: false,
      error: "",
    }),
    [key, revision, contextVersion],
  );
  const read = useCallback(
    () => (drafts.get(key) as FormState<T> | undefined) ?? fallback,
    [key, fallback],
  );
  const form = useSyncExternalStore(subscribe, read, read);
  const update = (value: T) => {
    drafts.set(key, { ...read(), value, requestId: uuid(), error: "" });
    notify();
  };
  const reset = () => {
    drafts.delete(key);
    notify();
  };
  const submit = async (
    dispatch: Dispatch,
    command: (form: FormState<T>) => MediaCommand,
  ) => {
    const current = read();
    if (current.pending) return null;
    const submitted = { ...current, pending: true, error: "" };
    drafts.set(key, submitted);
    notify();
    try {
      const result = await dispatch(command(submitted));
      if (drafts.get(key) !== submitted) return result;
      if (result) drafts.delete(key);
      else
        drafts.set(key, {
          ...submitted,
          pending: false,
          error: "操作未完成，草稿已保留。请检查工作台提示后重试。",
        });
      return result;
    } catch (cause) {
      if (drafts.get(key) === submitted)
        drafts.set(key, {
          ...submitted,
          pending: false,
          error:
            cause instanceof Error ? cause.message : "操作未完成，草稿已保留。",
        });
      return null;
    } finally {
      notify();
    }
  };
  return { ...form, update, reset, submit, conflict: revision !== form.base };
}
function FeedbackNotice({
  error,
  conflict,
}: {
  error: string;
  conflict?: boolean;
}) {
  return error || conflict ? (
    <p className="media-form-error" role="alert">
      {error ||
        "已有更新，当前草稿仍保留。请核对最新版本后重新编辑，避免覆盖其他修改。"}
    </p>
  ) : null;
}
function MaterialFields({
  materials,
  onChange,
}: {
  materials: MediaMaterial[];
  onChange: (value: MediaMaterial[]) => void;
}) {
  const set = (id: string, patch: Partial<MediaMaterial>) =>
    onChange(
      materials.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  return (
    <div className="media-materials">
      <p className="media-note">
        粘贴文本或登记链接。链接正文不会自动导入，素材使用权单独保留。
      </p>
      {materials.map((item, index) => (
        <div className="media-material-edit" key={item.id}>
          <div className="media-form-row">
            <label>
              材料名称
              <input
                aria-label={`材料 ${index + 1} 名称`}
                required
                value={item.title}
                onChange={(event) =>
                  set(item.id, { title: event.target.value })
                }
              />
            </label>
            <label>
              材料关系
              <select
                value={item.relation}
                onChange={(event) =>
                  set(item.id, {
                    relation: event.target.value as MediaMaterial["relation"],
                  })
                }
              >
                <option value="own">自有代表材料</option>
                <option value="reference">对标 / 参考</option>
              </select>
            </label>
            <button
              type="button"
              className="icon-button"
              aria-label={`移除材料 ${index + 1}`}
              onClick={() =>
                onChange(materials.filter((entry) => entry.id !== item.id))
              }
            >
              <X size={14} />
            </button>
          </div>
          <label>
            链接（可选）
            <input
              type="url"
              aria-label={`材料 ${index + 1} 链接`}
              value={item.url}
              onChange={(event) => set(item.id, { url: event.target.value })}
            />
          </label>
          <label>
            提供的正文或节选
            <textarea
              aria-label={`材料 ${index + 1} 正文`}
              rows={3}
              value={item.text}
              onChange={(event) => set(item.id, { text: event.target.value })}
            />
          </label>
          <label>
            素材使用权
            <select
              value={item.usageRights}
              onChange={(event) =>
                set(item.id, {
                  usageRights: event.target
                    .value as MediaMaterial["usageRights"],
                })
              }
            >
              <option value="unknown">尚未确认</option>
              <option value="owned">我声明自有</option>
              <option value="licensed">我已获得许可</option>
            </select>
          </label>
        </div>
      ))}
      <button
        type="button"
        className="text-button"
        onClick={() =>
          onChange([
            ...materials,
            {
              id: uuid(),
              title: "",
              relation: "own",
              url: "",
              text: "",
              usageRights: "unknown",
            },
          ])
        }
      >
        <Plus size={13} />
        添加代表材料
      </button>
    </div>
  );
}
function AccountFields({
  accounts,
  onChange,
}: {
  accounts: MediaAccount[];
  onChange: (value: MediaAccount[]) => void;
}) {
  const set = (id: string, patch: Partial<MediaAccount>) =>
    onChange(
      accounts.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  return (
    <div className="media-materials">
      {accounts.map((item, index) => (
        <div className="media-form-row" key={item.id}>
          <label>
            账号名称
            <input
              aria-label={`账号 ${index + 1} 名称`}
              required
              value={item.label}
              onChange={(event) => set(item.id, { label: event.target.value })}
            />
          </label>
          <label>
            关系
            <select
              value={item.relation}
              onChange={(event) =>
                set(item.id, {
                  relation: event.target.value as MediaAccount["relation"],
                })
              }
            >
              <option value="own">自有账号</option>
              <option value="reference">对标账号</option>
            </select>
          </label>
          <label>
            账号链接
            <input
              type="url"
              required
              aria-label={`账号 ${index + 1} 链接`}
              value={item.url}
              onChange={(event) => set(item.id, { url: event.target.value })}
            />
          </label>
          <button
            type="button"
            className="icon-button"
            aria-label={`移除账号 ${index + 1}`}
            onClick={() =>
              onChange(accounts.filter((entry) => entry.id !== item.id))
            }
          >
            <X size={14} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="text-button"
        onClick={() =>
          onChange([
            ...accounts,
            { id: uuid(), label: "", relation: "own", url: "" },
          ])
        }
      >
        <Plus size={13} />
        添加账号
      </button>
      <p className="media-note">
        这里保存账号关系与链接；登录态、评论和经营数据需要实际授权或手动提供。
      </p>
    </div>
  );
}
const blankChannel = (): MediaChannelInput => ({
  name: "",
  goal: "",
  audience: "",
  productionConditions: "",
  expressionStandards: "",
  accounts: [],
  materials: [],
});
function ChannelEditor({
  channel,
  root,
  dispatch,
  onDone,
  onCancel,
}: {
  channel?: MediaChannel;
  root: string;
  dispatch: Dispatch;
  onDone: (id: string) => void;
  onCancel: () => void;
}) {
  const form = useForm<MediaChannelInput>(
    `${root}:channel:${channel?.id ?? "new"}`,
    channel
      ? {
          name: channel.name,
          goal: channel.goal,
          audience: channel.audience,
          productionConditions: channel.productionConditions,
          expressionStandards: channel.expressionStandards,
          accounts: channel.accounts,
          materials: channel.materials,
        }
      : blankChannel(),
    channel?.revision ?? 0,
  );
  const set = (patch: Partial<MediaChannelInput>) =>
    form.update({ ...form.value, ...patch });
  return (
    <form
      className="media-form"
      aria-label={channel ? "编辑频道" : "新建频道"}
      onSubmit={async (event) => {
        event.preventDefault();
        const result = await form.submit(dispatch, (draft) => ({
          type: "media.channel.save",
          requestId: draft.requestId,
          channelId: channel?.id,
          expectedRevision: draft.base,
          input: draft.value,
        }));
        if (result) onDone(channel?.id ?? form.requestId);
      }}
    >
      <fieldset disabled={form.pending}>
        <div className="media-form-row">
          <label>
            频道名称
            <input
              aria-label="频道名称"
              required
              maxLength={160}
              value={form.value.name}
              onChange={(event) => set({ name: event.target.value })}
            />
          </label>
          <label>
            面向谁
            <input
              aria-label="频道受众"
              value={form.value.audience}
              onChange={(event) => set({ audience: event.target.value })}
            />
          </label>
        </div>
        <label>
          想带来什么价值
          <textarea
            aria-label="频道目标"
            required
            rows={3}
            value={form.value.goal}
            onChange={(event) => set({ goal: event.target.value })}
          />
        </label>
        <label>
          制作条件
          <textarea
            aria-label="频道制作条件"
            rows={2}
            placeholder="可用时间、设备、工具、素材与发布节奏"
            value={form.value.productionConditions}
            onChange={(event) =>
              set({ productionConditions: event.target.value })
            }
          />
        </label>
        <label>
          表达标准与已确认的理解
          <textarea
            aria-label="频道表达标准"
            rows={2}
            value={form.value.expressionStandards}
            onChange={(event) =>
              set({ expressionStandards: event.target.value })
            }
          />
        </label>
        <details>
          <summary>账号与对标关系 · {form.value.accounts.length}</summary>
          <AccountFields
            accounts={form.value.accounts}
            onChange={(accounts) => set({ accounts })}
          />
        </details>
        <details>
          <summary>代表材料 · {form.value.materials.length}</summary>
          <MaterialFields
            materials={form.value.materials}
            onChange={(materials) => set({ materials })}
          />
        </details>
        <FeedbackNotice error={form.error} conflict={form.conflict} />
        <div className="media-form-actions">
          <button className="button primary small" disabled={form.conflict}>
            <Save size={14} />
            {form.pending ? "保存中…" : "保存频道"}
          </button>
          <button type="button" className="text-button" onClick={onCancel}>
            稍后继续
          </button>
          {form.conflict ? (
            <button type="button" className="text-button" onClick={form.reset}>
              舍弃草稿，读取最新版本
            </button>
          ) : null}
        </div>
      </fieldset>
    </form>
  );
}
const blankWork = (): MediaWorkInput => ({
  title: "",
  angle: "",
  format: "",
  targetDate: "",
  variants: [
    { id: uuid(), platform: "YouTube", language: "中文", versionLabel: "初稿" },
  ],
  materials: [],
});
function VariantFields({
  variants,
  onChange,
}: {
  variants: MediaVariant[];
  onChange: (value: MediaVariant[]) => void;
}) {
  const set = (id: string, patch: Partial<MediaVariant>) =>
    onChange(
      variants.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  return (
    <div className="media-materials">
      {variants.map((item, index) => (
        <div className="media-variant-edit" key={item.id}>
          <div className="media-form-row">
            <label>
              平台
              <input
                aria-label={`版本 ${index + 1} 平台`}
                required
                list="media-platforms"
                value={item.platform}
                onChange={(event) =>
                  set(item.id, { platform: event.target.value })
                }
              />
            </label>
            <label>
              语言
              <input
                aria-label={`版本 ${index + 1} 语言`}
                required
                value={item.language}
                onChange={(event) =>
                  set(item.id, { language: event.target.value })
                }
              />
            </label>
            <label>
              版本名称
              <input
                aria-label={`版本 ${index + 1} 名称`}
                required
                value={item.versionLabel}
                onChange={(event) =>
                  set(item.id, { versionLabel: event.target.value })
                }
              />
            </label>
            {variants.length > 1 ? (
              <button
                type="button"
                className="icon-button"
                aria-label={`移除版本 ${index + 1}`}
                onClick={() =>
                  onChange(variants.filter((entry) => entry.id !== item.id))
                }
              >
                <X size={14} />
              </button>
            ) : null}
          </div>
          <label>
            基于哪个已有版本
            <select
              aria-label={`版本 ${index + 1} 关联版本`}
              value={item.basedOnId ?? ""}
              onChange={(event) =>
                set(item.id, { basedOnId: event.target.value || undefined })
              }
            >
              <option value="">独立初始版本</option>
              {variants
                .filter((entry) => entry.id !== item.id)
                .map((entry) => (
                  <option value={entry.id} key={entry.id}>
                    {entry.platform} / {entry.language} / {entry.versionLabel}
                  </option>
                ))}
            </select>
          </label>
        </div>
      ))}
      <datalist id="media-platforms">
        <option value="YouTube" />
        <option value="TikTok" />
        <option value="X" />
        <option value="抖音" />
      </datalist>
      <button
        type="button"
        className="text-button"
        onClick={() =>
          onChange([
            ...variants,
            {
              id: uuid(),
              platform: "",
              language: "中文",
              versionLabel: "适配稿",
              basedOnId: variants[0]?.id,
            },
          ])
        }
      >
        <Plus size={13} />
        添加平台或语言版本
      </button>
    </div>
  );
}
function WorkEditor({
  channel,
  work,
  root,
  dispatch,
  onDone,
  onCancel,
}: {
  channel: MediaChannel;
  work?: MediaWork;
  root: string;
  dispatch: Dispatch;
  onDone: (id: string) => void;
  onCancel: () => void;
}) {
  const form = useForm<MediaWorkInput>(
    `${root}:work:${work?.id ?? `${channel.id}:new`}`,
    work
      ? {
          title: work.title,
          angle: work.angle,
          format: work.format,
          targetDate: work.targetDate,
          variants: work.variants,
          materials: work.materials,
        }
      : blankWork(),
    work?.revision ?? 0,
  );
  const set = (patch: Partial<MediaWorkInput>) =>
    form.update({ ...form.value, ...patch });
  return (
    <form
      className="media-form"
      aria-label={work ? "编辑作品" : "新建作品"}
      onSubmit={async (event) => {
        event.preventDefault();
        const result = await form.submit(dispatch, (draft) => ({
          type: "media.work.save",
          channelId: channel.id,
          workId: work?.id,
          requestId: draft.requestId,
          expectedRevision: draft.base,
          input: draft.value,
        }));
        if (result) onDone(work?.id ?? form.requestId);
      }}
    >
      <fieldset disabled={form.pending}>
        <label>
          作品名称
          <input
            aria-label="作品名称"
            required
            value={form.value.title}
            onChange={(event) => set({ title: event.target.value })}
          />
        </label>
        <label>
          选题角度与创作假设
          <textarea
            aria-label="作品角度"
            rows={3}
            value={form.value.angle}
            onChange={(event) => set({ angle: event.target.value })}
          />
        </label>
        <div className="media-form-row">
          <label>
            作品形式
            <input
              aria-label="作品形式"
              placeholder="短视频、长视频、文章、图文…"
              value={form.value.format}
              onChange={(event) => set({ format: event.target.value })}
            />
          </label>
          <label>
            目标日期
            <input
              type="date"
              aria-label="作品目标日期"
              value={form.value.targetDate}
              onChange={(event) => set({ targetDate: event.target.value })}
            />
          </label>
        </div>
        <p className="media-note">
          目标日期用于计划，实际发布后另行登记链接和时间。
        </p>
        <details open>
          <summary>平台、语言与版本 · {form.value.variants.length}</summary>
          <VariantFields
            variants={form.value.variants}
            onChange={(variants) => set({ variants })}
          />
        </details>
        <details>
          <summary>本作品材料 · {form.value.materials.length}</summary>
          <MaterialFields
            materials={form.value.materials}
            onChange={(materials) => set({ materials })}
          />
        </details>
        <FeedbackNotice error={form.error} conflict={form.conflict} />
        <div className="media-form-actions">
          <button className="button primary small" disabled={form.conflict}>
            <Save size={14} />
            {form.pending ? "保存中…" : "保存作品"}
          </button>
          <button type="button" className="text-button" onClick={onCancel}>
            稍后继续
          </button>
          {form.conflict ? (
            <button type="button" className="text-button" onClick={form.reset}>
              舍弃草稿，读取最新版本
            </button>
          ) : null}
        </div>
      </fieldset>
    </form>
  );
}
const mediaTaskLabel = (task: Task) =>
  task.status === "completed" ? "本轮运行结束" : STATUS_NAMES[task.status];
function mediaWorkState(links: MediaTaskLink[], tasks: Task[]) {
  const byId = new Map(
    tasks
      .filter((task) => !task.deletedAt && !task.archivedAt)
      .map((task) => [task.id, task]),
  );
  const unique = new Map(links.map((link) => [link.taskId, link]));
  const current = [...unique.values()]
    .flatMap((link) => {
      const task = byId.get(link.taskId);
      return task ? [{ task, link }] : [];
    })
    .sort((a, b) => b.task.updatedAt.localeCompare(a.task.updatedAt));
  const waiting = current.filter((item) => item.task.status === "waiting");
  const failed = current.filter((item) => item.task.status === "failed");
  const running = current.filter((item) => item.task.status === "running");
  const primary = waiting[0] ?? failed[0] ?? running[0] ?? current[0];
  const summary =
    [
      running.length ? `${running.length} 项工作推进中` : "",
      waiting.length ? `${waiting.length} 项等待判断` : "",
      failed.length ? `${failed.length} 项需要处理` : "",
    ]
      .filter(Boolean)
      .join(" / ") ||
    (primary
      ? `${MEDIA_STAGES[primary.link.stage]} · ${mediaTaskLabel(primary.task)}`
      : "尚无当前工作");
  return { current, primary, summary };
}
function StartWork({
  channel,
  work,
  root,
  dispatch,
  onTask,
  tasks,
}: {
  channel: MediaChannel;
  work?: MediaWork;
  root: string;
  dispatch: Dispatch;
  onTask: (id: string) => void;
  tasks: Task[];
}) {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const materials = [...channel.materials, ...(work?.materials ?? [])];
  const allowedTasks = new Set(
    [...channel.taskLinks, ...(work?.taskLinks ?? [])].map(
      (link) => link.taskId,
    ),
  );
  const candidates = tasks
    .filter((task) => allowedTasks.has(task.id) && !task.archivedAt)
    .flatMap((task) =>
      task.artifacts
        .filter(
          (artifact) =>
            ["md", "html"].includes(artifact.format) && !artifact.readError,
        )
        .map((artifact) => ({
          task,
          artifact,
          reference: {
            taskId: task.id,
            artifactId: artifact.id,
            version: artifact.version,
            hash: artifact.hash,
          } satisfies MediaArtifactReference,
        })),
    );
  const directTasks = new Set(
    (work?.taskLinks ?? channel.taskLinks).map((link) => link.taskId),
  );
  const preferredTask = [...candidates]
    .filter((item) => directTasks.has(item.task.id))
    .sort((a, b) => b.artifact.updatedAt.localeCompare(a.artifact.updatedAt))[0]
    ?.task.id;
  const selectedDefaults = candidates
    .filter((item) => item.task.id === preferredTask)
    .slice(0, 24)
    .map((item) => item.reference);
  const form = useForm(
    `${root}:start:${work?.id ?? channel.id}`,
    {
      stage: "topic" as MediaStage,
      instruction: "",
      materialIds: materials.map((item) => item.id),
      feedbackIds: (work?.feedback ?? []).map((item) => item.id),
      artifacts: selectedDefaults,
    },
    work?.revision ?? channel.revision,
    JSON.stringify(candidates.map((item) => item.reference)),
  );
  const changedArtifacts = form.value.artifacts.some(
    (reference) =>
      !candidates.some(
        (item) =>
          item.reference.taskId === reference.taskId &&
          item.reference.artifactId === reference.artifactId &&
          item.reference.hash === reference.hash &&
          item.reference.version === reference.version,
      ),
  );
  const set = (patch: Partial<typeof form.value>) =>
    form.update({ ...form.value, ...patch });
  const start = async () => {
    if (changedArtifacts) return;
    const result = await form.submit(dispatch, (draft) => ({
      type: "media.work.start",
      requestId: draft.requestId,
      channelId: channel.id,
      workId: work?.id,
      expectedRevision: draft.base,
      ...draft.value,
    }));
    const entity = work
      ? result?.media?.works.find((item) => item.id === work.id)
      : result?.media?.channels.find((item) => item.id === channel.id);
    const link = entity?.taskLinks.find(
      (item) => item.requestId === form.requestId,
    );
    if (link && mounted.current) onTask(link.taskId);
  };
  return (
    <section className="media-start" aria-label="准备媒体工作">
      <p className="media-start-owner">
        {work ? `${channel.name} / ${work.title}` : channel.name}
      </p>
      <p className="media-start-note">
        选择这次要完成的结果和资料。开始后进入共享工作区，继续讨论、查看成员协作和编辑成果。
      </p>
      <fieldset disabled={form.pending}>
        <div
          className="media-stage-options"
          role="group"
          aria-label="媒体工作阶段"
        >
          {(Object.entries(MEDIA_STAGES) as [MediaStage, string][]).map(
            ([stage, label]) => (
              <button
                type="button"
                className={form.value.stage === stage ? "selected" : ""}
                aria-pressed={form.value.stage === stage}
                key={stage}
                onClick={() => set({ stage })}
              >
                {label}
              </button>
            ),
          )}
        </div>
        <label>
          这次需要怎样的结果
          <textarea
            aria-label="媒体工作要求"
            rows={3}
            value={form.value.instruction}
            onChange={(event) => set({ instruction: event.target.value })}
            placeholder="可以直接开始，也可以补充这次的重点、篇幅和接收对象。"
          />
        </label>
        {candidates.length > 0 || form.value.artifacts.length > 0 ? (
          <details open>
            <summary>承接前序成果 · {form.value.artifacts.length} 份</summary>
            <p className="media-note">
              默认选入这项工作最近一次已有成果。只读取勾选的准确文件版本，不带入其他讨论；切换阶段保留选择。
            </p>
            {candidates.map(({ task, artifact, reference }) => {
              const checked = form.value.artifacts.some(
                (item) =>
                  item.taskId === task.id && item.artifactId === artifact.id,
              );
              return (
                <label
                  className="media-material-choice"
                  key={`${task.id}:${artifact.id}`}
                >
                  <input
                    type="checkbox"
                    aria-label={`承接成果 ${artifact.title} v${artifact.version}`}
                    checked={checked}
                    onChange={(event) =>
                      set({
                        artifacts: event.target.checked
                          ? [
                              ...form.value.artifacts.filter(
                                (item) =>
                                  !(
                                    item.taskId === task.id &&
                                    item.artifactId === artifact.id
                                  ),
                              ),
                              reference,
                            ]
                          : form.value.artifacts.filter(
                              (item) =>
                                !(
                                  item.taskId === task.id &&
                                  item.artifactId === artifact.id
                                ),
                            ),
                      })
                    }
                  />
                  <span>
                    {artifact.title}
                    <small>
                      {task.title} · v{artifact.version} · SHA-256{" "}
                      {artifact.hash.slice(0, 12)} ·{" "}
                      {formatDate(artifact.updatedAt)}
                    </small>
                  </span>
                </label>
              );
            })}
            {changedArtifacts ? (
              <p className="media-feedback-notice" role="alert">
                所选成果已有新版本或不可读取，原选择仍保留。核对后重新选择实际版本。
                <button
                  type="button"
                  className="text-button"
                  onClick={() =>
                    set({
                      artifacts: form.value.artifacts.flatMap((reference) => {
                        const candidate = candidates.find(
                          (item) =>
                            item.task.id === reference.taskId &&
                            item.artifact.id === reference.artifactId,
                        );
                        return candidate ? [candidate.reference] : [];
                      }),
                    })
                  }
                >
                  采用所选成果的最新版本
                </button>
              </p>
            ) : null}
          </details>
        ) : null}
        <details>
          <summary>
            本次带入的资料 ·{" "}
            {form.value.materialIds.length + form.value.feedbackIds.length}
          </summary>
          <p className="media-note">
            带入已保存的频道和作品版本；下面的材料可按本次目的选择。链接只代表已登记地址。
          </p>
          {materials.map((item) => (
            <label className="media-material-choice" key={item.id}>
              <input
                type="checkbox"
                checked={form.value.materialIds.includes(item.id)}
                onChange={(event) =>
                  set({
                    materialIds: event.target.checked
                      ? [...form.value.materialIds, item.id]
                      : form.value.materialIds.filter((id) => id !== item.id),
                  })
                }
              />
              <span>
                {item.title}
                <small>
                  {item.text
                    ? `已提供 ${item.text.length} 字符`
                    : "仅链接，未读取正文"}{" "}
                  ·{" "}
                  {item.usageRights === "unknown"
                    ? "素材使用权未确认"
                    : "用户声明使用权"}
                </small>
              </span>
            </label>
          ))}
          {work?.feedback.map((item) => (
            <label className="media-material-choice" key={item.id}>
              <input
                type="checkbox"
                checked={form.value.feedbackIds.includes(item.id)}
                onChange={(event) =>
                  set({
                    feedbackIds: event.target.checked
                      ? [...form.value.feedbackIds, item.id]
                      : form.value.feedbackIds.filter((id) => id !== item.id),
                  })
                }
              />
              <span>
                {item.title}
                <small>
                  {item.range === "provided-text"
                    ? "用户提供的评论 / 报告正文"
                    : "仅链接，未读取正文"}
                </small>
              </span>
            </label>
          ))}
        </details>
        <FeedbackNotice error={form.error} conflict={form.conflict} />
        <div className="media-form-actions">
          <button
            type="button"
            className="button primary small"
            disabled={
              form.conflict ||
              changedArtifacts ||
              form.value.artifacts.length > 24
            }
            onClick={() => void start()}
          >
            {form.pending ? "正在开始…" : "开始媒体工作"}
            <ArrowUpRight size={14} />
          </button>
          {form.conflict ? (
            <button type="button" className="text-button" onClick={form.reset}>
              按最新版本重新准备
            </button>
          ) : null}
        </div>
      </fieldset>
    </section>
  );
}
function PublicationForm({
  work,
  root,
  dispatch,
  onDone,
}: {
  work: MediaWork;
  root: string;
  dispatch: Dispatch;
  onDone: () => void;
}) {
  const form = useForm(
    `${root}:publication:${work.id}`,
    { variantId: work.variants[0]!.id, url: "", publishedAt: "" },
    work.revision,
  );
  const set = (patch: Partial<typeof form.value>) =>
    form.update({ ...form.value, ...patch });
  return (
    <div className="media-evidence-form">
      <form
        aria-label="登记发布"
        onSubmit={async (event) => {
          event.preventDefault();
          const result = await form.submit(dispatch, (draft) => ({
            type: "media.work.publish",
            requestId: draft.requestId,
            workId: work.id,
            expectedRevision: draft.base,
            variantId: draft.value.variantId,
            url: draft.value.url,
            publishedAt: draft.value.publishedAt
              ? new Date(draft.value.publishedAt).toISOString()
              : "",
          }));
          if (result) onDone();
        }}
      >
        <fieldset disabled={form.pending}>
          <label>
            发布的版本
            <select
              aria-label="发布版本"
              value={form.value.variantId}
              onChange={(event) => set({ variantId: event.target.value })}
            >
              {work.variants.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.platform} / {item.language} / {item.versionLabel}
                </option>
              ))}
            </select>
          </label>
          <label>
            实际发布链接
            <input
              aria-label="实际发布链接"
              type="url"
              required
              value={form.value.url}
              onChange={(event) => set({ url: event.target.value })}
            />
          </label>
          <label>
            实际发布时间（可留空）
            <input
              aria-label="实际发布时间"
              type="datetime-local"
              value={form.value.publishedAt}
              onChange={(event) => set({ publishedAt: event.target.value })}
            />
          </label>
          <p className="media-note">
            保存用户提供的发布证据，登记时间与实际发布时间分别记录；不自动核验或代为发布。
          </p>
          <FeedbackNotice error={form.error} conflict={form.conflict} />
          <button className="button secondary small" disabled={form.conflict}>
            {form.pending ? "保存中…" : "保存发布记录"}
          </button>
          {form.conflict ? (
            <button type="button" className="text-button" onClick={form.reset}>
              读取最新版本重新登记
            </button>
          ) : null}
        </fieldset>
      </form>
    </div>
  );
}
function ImportFeedback({
  work,
  root,
  dispatch,
  onDone,
}: {
  work: MediaWork;
  root: string;
  dispatch: Dispatch;
  onDone: () => void;
}) {
  const form = useForm(
    `${root}:feedback:${work.id}`,
    {
      kind: "comments" as "comments" | "report" | "finished-work",
      title: "",
      text: "",
      url: "",
      observedAt: "",
    },
    work.revision,
  );
  const set = (patch: Partial<typeof form.value>) =>
    form.update({ ...form.value, ...patch });
  return (
    <div className="media-evidence-form">
      <form
        aria-label="导入复盘资料"
        onSubmit={async (event) => {
          event.preventDefault();
          const result = await form.submit(dispatch, (draft) => ({
            type: "media.feedback.add",
            requestId: draft.requestId,
            workId: work.id,
            expectedRevision: draft.base,
            input: draft.value,
          }));
          if (result) onDone();
        }}
      >
        <fieldset disabled={form.pending}>
          <div className="media-form-row">
            <label>
              资料类型
              <select
                aria-label="复盘资料类型"
                value={form.value.kind}
                onChange={(event) =>
                  set({ kind: event.target.value as typeof form.value.kind })
                }
              >
                <option value="comments">真实评论</option>
                <option value="report">数据 / 反馈报告</option>
                <option value="finished-work">已完成作品</option>
              </select>
            </label>
            <label>
              资料名称
              <input
                aria-label="复盘资料名称"
                required
                value={form.value.title}
                onChange={(event) => set({ title: event.target.value })}
              />
            </label>
          </div>
          <label>
            实际文本或报告节选
            <textarea
              aria-label="复盘资料正文"
              rows={4}
              value={form.value.text}
              onChange={(event) => set({ text: event.target.value })}
            />
          </label>
          <div className="media-form-row">
            <label>
              来源链接（可选）
              <input
                type="url"
                aria-label="复盘资料链接"
                value={form.value.url}
                onChange={(event) => set({ url: event.target.value })}
              />
            </label>
            <label>
              观察日期
              <input
                type="date"
                aria-label="复盘观察日期"
                value={form.value.observedAt}
                onChange={(event) => set({ observedAt: event.target.value })}
              />
            </label>
          </div>
          <p className="media-note">
            只分析实际提供的范围。仅登记链接时，仍需取得正文后才能据此判断。
          </p>
          <FeedbackNotice error={form.error} conflict={form.conflict} />
          <button
            className="button secondary small"
            disabled={
              form.conflict ||
              !(form.value.text.trim() || form.value.url.trim())
            }
          >
            {form.pending ? "保存中…" : "保存复盘资料"}
          </button>
          {form.conflict ? (
            <button type="button" className="text-button" onClick={form.reset}>
              读取最新版本重新导入
            </button>
          ) : null}
        </fieldset>
      </form>
    </div>
  );
}
function MaterialList({
  materials,
  dispatch,
}: {
  materials: MediaMaterial[];
  dispatch: Dispatch;
}) {
  return materials.length ? (
    <details className="media-context">
      <summary>已保存材料 · {materials.length}</summary>
      {materials.map((item) => (
        <article key={item.id}>
          <strong>{item.title}</strong>
          <span>
            {item.relation === "own" ? "自有" : "参考"} ·{" "}
            {item.text ? `用户提供 ${item.text.length} 字符` : "仅链接"} ·{" "}
            {item.usageRights === "unknown"
              ? "素材使用权未确认"
              : "用户声明使用权"}
          </span>
          {item.url ? (
            <button
              className="text-button"
              onClick={() => void dispatch({ type: "url.open", url: item.url })}
            >
              打开来源
              <ArrowUpRight size={12} />
            </button>
          ) : null}
          {item.text ? <pre>{item.text}</pre> : null}
        </article>
      ))}
    </details>
  ) : null;
}
export function MediaProjects({
  snapshot,
  dispatch,
  onTask,
  onArtifact,
  focus,
  active = true,
}: {
  snapshot: Snapshot;
  dispatch: Dispatch;
  onTask: (id: string) => void;
  onArtifact?: (taskId: string, artifactId: string) => void;
  focus?: { channelId: string; workId: string; revision: number };
  active?: boolean;
}) {
  const media = snapshot.media;
  const root = media?.root ?? snapshot.settings.workspaceRoot;
  const [selectedChannelId, setChannelId] = useState<string | null>(null);
  const [selectedWorkId, setWorkId] = useState<string | null>(null);
  const [action, setAction] = useState<
    | "channel-new"
    | "channel"
    | "work-new"
    | "work"
    | "start"
    | "publication"
    | "feedback"
    | "materials"
    | null
  >(null);
  useEffect(() => {
    if (!focus) return;
    setChannelId(focus.channelId);
    setWorkId(focus.workId);
    setAction(null);
  }, [focus]);
  useEffect(() => {
    if (!active) setAction(null);
  }, [active]);
  const channel = media?.channels.find((item) => item.id === selectedChannelId);
  const work = media?.works.find(
    (item) => item.id === selectedWorkId && item.channelId === channel?.id,
  );
  const channelWorks =
    media?.works.filter((item) => item.channelId === channel?.id) ?? [];
  const links = work?.taskLinks ?? channel?.taskLinks ?? [];
  const linkedTasks = mediaWorkState(links, snapshot.tasks).current;
  const artifacts = linkedTasks
    .flatMap(({ task, link }) =>
      task.artifacts.map((artifact) => ({ task, link, artifact })),
    )
    .sort((a, b) => b.artifact.updatedAt.localeCompare(a.artifact.updatedAt));
  const close = () => setAction(null);
  const openChannel = (id: string | null) => {
    setChannelId(id);
    setWorkId(null);
    close();
  };
  const modalTitle =
    action === "channel-new"
      ? "新建频道"
      : action === "channel"
        ? "编辑频道"
        : action === "work-new"
          ? "新建作品"
          : action === "work"
            ? "编辑作品"
            : action === "start"
              ? "准备媒体工作"
              : action === "publication"
                ? "登记实际发布"
                : action === "feedback"
                  ? "导入真实反馈"
                  : work
                    ? "作品资料与版本"
                    : "频道资料与制作条件";
  return (
    <section className="media-projects" aria-label="媒体项目">
      {channel ? (
        <>
          <nav className="project-breadcrumb" aria-label="媒体项目位置">
            <button className="text-button" onClick={() => openChannel(null)}>
              <ArrowLeft size={14} />
              全部频道
            </button>
            {work ? (
              <>
                <span>/</span>
                <button className="text-button" onClick={() => setWorkId(null)}>
                  {channel.name}
                </button>
              </>
            ) : null}
          </nav>
          <header className="media-object-header">
            <div>
              <span className="eyebrow">
                {work ? `${channel.name} · 作品` : "媒体频道"}
              </span>
              <h1>{work?.title ?? channel.name}</h1>
              <p className="media-object-goal">
                {work
                  ? work.angle || "补充创作角度，或与团队一起明确下一步。"
                  : channel.goal}
              </p>
              <div className="media-object-facts">
                {work ? (
                  <>
                    <span>{work.format || "形式待明确"}</span>
                    <span>
                      {work.targetDate
                        ? `目标 ${work.targetDate}`
                        : "日期未安排"}
                    </span>
                    <span>{work.variants.length} 个平台 / 语言版本</span>
                  </>
                ) : (
                  <>
                    <span>{channelWorks.length} 件作品</span>
                    <span>{channel.materials.length} 份频道材料</span>
                  </>
                )}
              </div>
            </div>
            <button
              className="button primary"
              onClick={() => setAction(work ? "start" : "work-new")}
            >
              {work ? <ArrowUpRight size={15} /> : <Plus size={15} />}
              {work ? "与团队推进" : "新建作品"}
            </button>
          </header>
          <div className="media-object-tools">
            {!work ? (
              <button
                className="text-button"
                onClick={() => setAction("start")}
              >
                与团队讨论频道
                <ArrowUpRight size={13} />
              </button>
            ) : null}
            <button
              className="text-button"
              onClick={() => setAction(work ? "work" : "channel")}
            >
              编辑{work ? "作品" : "频道"}
            </button>
            <button
              className="text-button"
              onClick={() => setAction("materials")}
            >
              查看资料与版本
            </button>
            <button
              className="text-button"
              onClick={() =>
                void dispatch({
                  type: "path.reveal",
                  path: work?.documentPath ?? channel.documentPath,
                })
              }
            >
              <FileText size={13} />
              显示说明文件
            </button>
          </div>
          {!work ? (
            <section className="media-object-section">
              <div className="media-section-heading">
                <h2>作品</h2>
                <span>{channelWorks.length}</span>
              </div>
              {channelWorks.length ? (
                <div className="media-work-list">
                  {channelWorks.map((item) => {
                    const state = mediaWorkState(
                      item.taskLinks,
                      snapshot.tasks,
                    );
                    return (
                      <button
                        key={item.id}
                        aria-label={`打开作品 ${item.title}`}
                        onClick={() => setWorkId(item.id)}
                      >
                        <span>
                          <strong>{item.title}</strong>
                          <small>
                            {item.angle || item.format || "从选题开始推进"}
                          </small>
                        </span>
                        <span>
                          <span
                            className={`media-work-current-status is-${state.primary?.task.status ?? "none"}`}
                          >
                            {state.primary
                              ? `${MEDIA_STAGES[state.primary.link.stage]} · ${mediaTaskLabel(state.primary.task)}`
                              : "尚未开始工作"}
                          </span>
                          {state.primary ? (
                            <small className="media-work-state-source">
                              {state.primary.task.title} ·{" "}
                              {formatDate(state.primary.task.updatedAt)}
                            </small>
                          ) : null}
                          <small>
                            {item.publications.length
                              ? `${item.publications.length} 条发布登记`
                              : item.targetDate
                                ? `目标 ${item.targetDate}`
                                : "尚未登记发布"}
                          </small>
                        </span>
                        <ArrowRight size={16} />
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="project-inline-empty">
                  <p>
                    为这个频道建立第一件作品，后续脚本、制作说明和反馈都会归在一起。
                  </p>
                  <button
                    className="text-button"
                    onClick={() => setAction("work-new")}
                  >
                    创建第一件作品
                    <ArrowRight size={14} />
                  </button>
                </div>
              )}
            </section>
          ) : null}
          <section className="media-object-section" aria-label="当前成果">
            <div className="media-section-heading">
              <h2>{work ? "当前成果" : "频道成果"}</h2>
              <span>{artifacts.length}</span>
            </div>
            {artifacts.length ? (
              <div className="project-result-list">
                {artifacts.slice(0, 6).map(({ task, artifact, link }) => (
                  <button
                    key={`${task.id}:${artifact.id}`}
                    aria-label={`打开成果 ${artifact.title}`}
                    onClick={() =>
                      onArtifact
                        ? onArtifact(task.id, artifact.id)
                        : onTask(task.id)
                    }
                  >
                    <FileText size={19} />
                    <span>
                      <strong>{artifact.title}</strong>
                      <small>
                        {MEDIA_STAGES[link.stage]} · v{artifact.version} ·{" "}
                        {formatDate(artifact.updatedAt)}
                      </small>
                    </span>
                    <ArrowUpRight size={14} />
                  </button>
                ))}
              </div>
            ) : (
              <p className="project-inline-empty">
                {work
                  ? "还没有成果。与团队确定这次要完成的内容，从选题、脚本或已有材料继续。"
                  : "频道定位与策划成果会显示在这里，单件作品的成果保存在作品里。"}
              </p>
            )}
          </section>
          {links.length ? (
            <section className="media-object-section" aria-label="当前工作">
              <div className="media-section-heading">
                <h2>当前工作</h2>
                <span>{linkedTasks.length}</span>
              </div>
              <div className="project-work-list">
                {[...links]
                  .sort((a, b) =>
                    (
                      snapshot.tasks.find((task) => task.id === b.taskId)
                        ?.updatedAt ?? b.createdAt
                    ).localeCompare(
                      snapshot.tasks.find((task) => task.id === a.taskId)
                        ?.updatedAt ?? a.createdAt,
                    ),
                  )
                  .map((link) => {
                    const task = snapshot.tasks.find(
                      (item) => item.id === link.taskId && !item.deletedAt,
                    );
                    return (
                      <button
                        key={link.requestId}
                        disabled={!task || Boolean(task.archivedAt)}
                        onClick={() => onTask(link.taskId)}
                      >
                        <span>
                          <strong>
                            {task?.title ?? MEDIA_STAGES[link.stage]}
                          </strong>
                          <small>
                            {MEDIA_STAGES[link.stage]} · 频道 v
                            {link.channelRevision}
                            {link.workRevision
                              ? ` / 作品 v${link.workRevision}`
                              : ""}{" "}
                            · {formatDate(link.createdAt)}
                          </small>
                        </span>
                        <span>
                          {task?.archivedAt
                            ? "工作已归档"
                            : task
                              ? mediaTaskLabel(task)
                              : "工作记录已移除"}
                          <small>
                            {task ? `${task.artifacts.length} 份成果` : ""}
                          </small>
                        </span>
                        <ArrowUpRight size={14} />
                      </button>
                    );
                  })}
              </div>
            </section>
          ) : null}
          {work ? (
            <section className="media-object-section media-evidence">
              <div className="media-section-heading">
                <h2>发布与反馈</h2>
                <div>
                  <button
                    className="button secondary small"
                    onClick={() => setAction("publication")}
                  >
                    登记发布
                  </button>
                  <button
                    className="button secondary small"
                    onClick={() => setAction("feedback")}
                  >
                    导入反馈
                  </button>
                </div>
              </div>
              {!work.publications.length && !work.feedback.length ? (
                <p className="project-inline-empty">
                  作品实际发布后，在这里保留发布记录、评论和报告，继续复盘。
                </p>
              ) : null}
              {work.publications.map((item) => (
                <article className="media-publication" key={item.id}>
                  <Check size={15} />
                  <div>
                    <button
                      className="text-button"
                      onClick={() =>
                        void dispatch({ type: "url.open", url: item.url })
                      }
                    >
                      {item.url}
                      <ArrowUpRight size={12} />
                    </button>
                    <p>
                      用户登记发布时间：
                      {item.publishedAt
                        ? new Date(item.publishedAt).toLocaleString("zh-CN")
                        : "未提供"}
                    </p>
                    <small>
                      登记于 {formatDate(item.recordedAt)} · 链接未自动核验
                    </small>
                  </div>
                </article>
              ))}
              {work.feedback.map((item) => (
                <details className="media-feedback-record" key={item.id}>
                  <summary>
                    {item.title} ·{" "}
                    {item.range === "provided-text" ? "已提供正文" : "仅链接"}
                  </summary>
                  <p className="media-note">
                    观察日期：{item.observedAt || "未提供"} · 范围：
                    {item.text.length} 字符
                  </p>
                  {item.text ? <pre>{item.text}</pre> : null}
                  {item.url ? (
                    <button
                      className="text-button"
                      onClick={() =>
                        void dispatch({ type: "url.open", url: item.url })
                      }
                    >
                      打开来源
                      <ArrowUpRight size={12} />
                    </button>
                  ) : null}
                </details>
              ))}
            </section>
          ) : null}
        </>
      ) : (
        <>
          <header className="media-heading">
            <div>
              <span className="eyebrow">MEDIA PROJECTS</span>
              <h1>媒体项目</h1>
              <p>按频道组织作品，从当前进度继续创作。</p>
            </div>
            <button
              className="button primary"
              onClick={() => setAction("channel-new")}
            >
              <Plus size={15} />
              新建频道
            </button>
          </header>
          {media?.channels.length ? (
            <div className="media-channel-objects" aria-label="频道列表">
              {media.channels.map((item) => {
                const works = media.works.filter(
                  (entry) => entry.channelId === item.id,
                );
                const state = mediaWorkState(
                  [
                    ...item.taskLinks,
                    ...works.flatMap((entry) => entry.taskLinks),
                  ],
                  snapshot.tasks,
                );
                return (
                  <button
                    className="media-channel-object"
                    key={item.id}
                    aria-label={`打开频道 ${item.name}`}
                    onClick={() => openChannel(item.id)}
                  >
                    <span className="media-channel-symbol">
                      <Film size={22} />
                    </span>
                    <span>
                      <strong>{item.name}</strong>
                      <small>
                        {item.goal || "从一件作品开始，逐步形成频道方向。"}
                      </small>
                    </span>
                    <span className="media-channel-summary">
                      {works.length} 件作品
                      <small className="media-channel-work-state">
                        {state.summary}
                      </small>
                    </span>
                    <ArrowRight size={18} />
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="collection-empty">
              <Film size={34} />
              <h2>从一个频道、一件作品开始</h2>
              <p>少量背景和代表材料就能开始，无需先配置账号或完整画像。</p>
              <button
                className="button secondary"
                onClick={() => setAction("channel-new")}
              >
                创建第一个频道
              </button>
            </div>
          )}
        </>
      )}
      {action && active ? (
        <Modal title={modalTitle} onClose={close} wide>
          <div className="media-projects media-operation">
            {action === "channel-new" || (action === "channel" && channel) ? (
              <ChannelEditor
                root={root}
                channel={action === "channel" ? channel : undefined}
                dispatch={dispatch}
                onDone={(id) => openChannel(id)}
                onCancel={close}
              />
            ) : null}
            {channel &&
            (action === "work-new" || (action === "work" && work)) ? (
              <WorkEditor
                root={root}
                channel={channel}
                work={action === "work" ? work : undefined}
                dispatch={dispatch}
                onDone={(id) => {
                  setWorkId(id);
                  close();
                }}
                onCancel={close}
              />
            ) : null}
            {action === "start" && channel ? (
              <StartWork
                root={root}
                channel={channel}
                work={work}
                dispatch={dispatch}
                tasks={snapshot.tasks}
                onTask={(id) => {
                  close();
                  onTask(id);
                }}
              />
            ) : null}
            {action === "publication" && work ? (
              <PublicationForm
                work={work}
                root={root}
                dispatch={dispatch}
                onDone={close}
              />
            ) : null}
            {action === "feedback" && work ? (
              <ImportFeedback
                work={work}
                root={root}
                dispatch={dispatch}
                onDone={close}
              />
            ) : null}
            {action === "materials" && channel ? (
              <>
                <p className="media-note">
                  频道 v{channel.revision}
                  {work ? ` · 作品 v${work.revision}` : ""}
                </p>
                <dl className="media-context-facts">
                  <dt>受众</dt>
                  <dd>{channel.audience || "待补充"}</dd>
                  <dt>制作条件</dt>
                  <dd>{channel.productionConditions || "待补充"}</dd>
                  <dt>表达标准</dt>
                  <dd>{channel.expressionStandards || "待补充"}</dd>
                </dl>
                {channel.accounts.map((account) => (
                  <p key={account.id}>
                    {account.label} ·{" "}
                    {account.relation === "own" ? "自有账号" : "对标账号"}{" "}
                    <button
                      className="text-button"
                      onClick={() =>
                        void dispatch({ type: "url.open", url: account.url })
                      }
                    >
                      打开链接
                      <ArrowUpRight size={12} />
                    </button>
                  </p>
                ))}
                {work ? (
                  <>
                    <h3>平台与语言版本</h3>
                    <div className="media-variant-list">
                      {work.variants.map((variant) => (
                        <div key={variant.id}>
                          <strong>
                            {variant.platform} · {variant.language}
                          </strong>
                          <span>
                            {variant.versionLabel}
                            {variant.basedOnId ? " · 关联已有版本" : ""}
                          </span>
                        </div>
                      ))}
                    </div>
                    <h3>作品材料</h3>
                    <MaterialList
                      materials={work.materials}
                      dispatch={dispatch}
                    />
                  </>
                ) : null}
                <h3>频道材料</h3>
                <MaterialList
                  materials={channel.materials}
                  dispatch={dispatch}
                />
                {!channel.materials.length && !work?.materials.length ? (
                  <p className="media-note">
                    暂未添加材料，可编辑{work ? "作品或频道" : "频道"}补充。
                  </p>
                ) : null}
              </>
            ) : null}
          </div>
        </Modal>
      ) : null}
    </section>
  );
}
