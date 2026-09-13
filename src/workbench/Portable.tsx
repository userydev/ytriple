import { useState, useSyncExternalStore, type FormEvent } from "react";
import type { Task } from "../shared/types.js";
import type { PortableCommand, PortableSnapshot } from "../shared/portable.js";
type View = {
  tasks: Task[];
  portable?: PortableSnapshot;
  settings?: { aiRoot: string; libraryRecall?: boolean };
};
type Props = {
  snapshot: View;
  dispatch: (command: PortableCommand) => Promise<View | null>;
  onTask?: (id: string) => void;
  onReveal?: (path: string) => void;
  mode?: "all" | "imports" | "backup";
};
type Draft = {
  title: string;
  goal: string;
  taskId: string;
  format: "text" | "json" | "html";
  content: string;
  fetchURLs: boolean;
  run: boolean;
};
type PanelState = {
  busy: boolean;
  error: string;
  draft: Draft;
  requests: Record<string, string>;
};
const states = new Map<string, PanelState>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const panelState = (key: string) => {
  let state = states.get(key);
  if (!state) {
    state = {
      busy: false,
      error: "",
      requests: {},
      draft: {
        title: "我的收藏整理",
        goal: "消化这批实际提供的材料，识别主题、价值、重复与待核查缺口，对照本次带入的资产候选，形成可复用的说明。未取得正文的链接只整理阅读优先级，不据标题声称已理解原文。",
        taskId: "",
        format: "text",
        content: "",
        fetchURLs: false,
        run: true,
      },
    };
    states.set(key, state);
  }
  return state;
};
const read = (form: HTMLFormElement, name: string) =>
  form
    .querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      `[name="${name}"]`,
    )
    ?.value.trim() ?? "";

export function PortablePanel({
  snapshot,
  dispatch,
  onTask,
  onReveal,
  mode = "all",
}: Props) {
  const [active, setActive] = useState<"imports" | "backup">("imports");
  const surface = mode === "all" ? active : mode;
  const stateKey = snapshot.settings?.aiRoot ?? `portable:${mode}`;
  const state = useSyncExternalStore(
    subscribe,
    () => panelState(stateKey),
    () => panelState(stateKey),
  );
  const { busy, error, draft } = state;
  const update = (patch: Partial<PanelState>) => {
    states.set(stateKey, { ...panelState(stateKey), ...patch });
    listeners.forEach((listener) => listener());
  };
  const act = async (
    input:
      | Omit<
          Extract<PortableCommand, { type: "portable.importBookmarks" }>,
          "requestId"
        >
      | Omit<
          Extract<PortableCommand, { type: "portable.importBookmarksFile" }>,
          "requestId"
        >
      | { type: "portable.backup" | "portable.restore" },
  ) => {
    if (panelState(stateKey).busy) return;
    update({ busy: true, error: "" });
    const key = JSON.stringify(input);
    // Picking a file starts a fresh explicit operation; text retries retain their idempotency key.
    const picking =
      input.type === "portable.restore" ||
      input.type === "portable.importBookmarksFile";
    const requestId =
      (!picking && panelState(stateKey).requests[key]) || crypto.randomUUID();
    update({
      requests: { ...panelState(stateKey).requests, [key]: requestId },
    });
    try {
      const result = await dispatch({ ...input, requestId } as PortableCommand);
      if (result) {
        const requests = { ...panelState(stateKey).requests };
        delete requests[key];
        update({ requests });
        const imported = result.portable?.imports.find(
          (item) => item.id === requestId,
        );
        if (imported) onTask?.(imported.taskId);
      } else
        update({
          error: picking
            ? "操作尚未完成或已取消，输入仍保留。"
            : "操作尚未确认完成，输入已保留；重试会接续同一次操作。",
        });
    } catch (reason) {
      update({
        error:
          reason instanceof Error ? reason.message : "操作未完成，请重试。",
      });
    } finally {
      update({ busy: false });
    }
  };
  const imports = (form: HTMLFormElement) => ({
    title: read(form, "title"),
    goal: read(form, "goal"),
    ...(read(form, "taskId") ? { taskId: read(form, "taskId") } : {}),
    run: Boolean(form.querySelector<HTMLInputElement>('[name="run"]')?.checked),
    fetchURLs: Boolean(
      form.querySelector<HTMLInputElement>('[name="fetchURLs"]')?.checked,
    ),
  });
  const remember = (form: HTMLFormElement) => {
    const raw = (name: string) =>
      form.querySelector<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >(`[name="${name}"]`)?.value ?? "";
    update({
      draft: {
        ...imports(form),
        title: raw("title"),
        goal: raw("goal"),
        taskId: raw("taskId"),
        content: raw("content"),
        format: raw("format") as Draft["format"],
      },
    });
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const content = read(form, "content");
    remember(form);
    void act({
      type: "portable.importBookmarks",
      ...imports(form),
      format: read(form, "format") as "text" | "json" | "html",
      content,
    });
  };
  return (
    <section
      className="portable-panel"
      aria-label={mode === "imports" ? "平台与收藏导入" : "资料导入与本地备份"}
    >
      {mode === "all" ? (
        <nav className="asset-operation-tabs" aria-label="资料管理操作">
          <button
            type="button"
            aria-pressed={surface === "imports"}
            onClick={() => setActive("imports")}
          >
            导入材料
          </button>
          <button
            type="button"
            aria-pressed={surface === "backup"}
            onClick={() => setActive("backup")}
          >
            备份与恢复
          </button>
        </nav>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <fieldset disabled={busy}>
        <section hidden={surface !== "imports"}>
          <h3>导入收藏与材料</h3>
          <p>
            支持逐行文本、URL 清单、JSON 和浏览器 HTML
            书签。重复项目保留一份；网址未读取全文时会明确显示覆盖。
          </p>
          <form
            className="portable-form"
            onSubmit={submit}
            onChange={(event) => remember(event.currentTarget)}
          >
            <label>
              这批资料叫什么
              <input
                name="title"
                defaultValue={draft.title}
                required
                maxLength={160}
              />
            </label>
            <label>
              希望得到什么
              <textarea
                name="goal"
                defaultValue={draft.goal}
                required
                rows={3}
                maxLength={12000}
              />
            </label>
            <label>
              归到哪项工作
              <select name="taskId" defaultValue={draft.taskId}>
                <option value="">建立一项新工作</option>
                {snapshot.tasks
                  .filter(
                    (task) => !task.archivedAt && task.surface !== "background",
                  )
                  .map((task) => (
                    <option key={task.id} value={task.id}>
                      {task.title}
                    </option>
                  ))}
              </select>
              <small>
                导入已有工作时沿用其目标；添加资料会暂停正在运行的处理。
              </small>
            </label>
            <label>
              粘贴格式
              <select name="format" defaultValue={draft.format}>
                <option value="text">文本或逐行 URL</option>
                <option value="json">JSON 收藏</option>
                <option value="html">HTML 书签</option>
              </select>
            </label>
            <label>
              收藏与材料
              <textarea
                name="content"
                defaultValue={draft.content}
                rows={7}
                maxLength={2_000_000}
                placeholder="每行一条网址或文本，也可以粘贴导出的 JSON / HTML。"
              />
            </label>
            <label className="portable-checkbox">
              <input
                name="fetchURLs"
                type="checkbox"
                defaultChecked={draft.fetchURLs}
              />
              读取公开网页正文
            </label>
            <small>
              每批最多导入 100 项，按明确选择最多读取 50
              个无需登录的公开网页；读取失败保留书签与原因。
            </small>
            <small>
              新收藏工作按资产查找设置，最多带入 3
              份相关本地资产的准确版本。关闭查找时不新增对照材料；不把候选匹配当成已经完成比较。
            </small>
            <label className="portable-checkbox">
              <input name="run" type="checkbox" defaultChecked={draft.run} />
              导入后用当前已配置的模型开始资料整理
            </label>
            <div className="portable-buttons">
              <button className="button primary small">导入粘贴的资料</button>
              <button
                type="button"
                className="button secondary small"
                onClick={(event) => {
                  const form = event.currentTarget.closest("form")!;
                  remember(form);
                  void act({
                    type: "portable.importBookmarksFile",
                    ...imports(form),
                  });
                }}
              >
                选择本地书签文件
              </button>
            </div>
          </form>
        </section>
        {mode !== "imports" ? (
          <section hidden={surface !== "backup"}>
            <h3>本地备份与恢复</h3>
            <p>
              备份任务、文字与附件的已登记版本、资产、方法快照、频道/作品、交付及例行工作关系。备份留在本机，不包含模型连接、密钥、登录态或中央项目规则。
            </p>
            <p>
              恢复会建立全新的工作区与资产，不覆盖现有文件。恢复后的任务、方法调用和例行工作先暂停，由你核对后继续。
            </p>
            <div className="portable-buttons">
              <button
                type="button"
                className="button secondary small"
                onClick={() => void act({ type: "portable.backup" })}
              >
                生成本地备份
              </button>
              <button
                type="button"
                className="button secondary small"
                onClick={() => void act({ type: "portable.restore" })}
              >
                选择备份并恢复副本
              </button>
            </div>
            <small>
              单个备份最多 64
              MB；软件项目的代码、中央登记和原平台收藏由原工具管理。
            </small>
          </section>
        ) : null}
      </fieldset>
      {busy ? <p role="status">正在处理本地资料，请稍候…</p> : null}
      {surface === "imports" && snapshot.portable?.imports.length ? (
        <details className="portable-history">
          <summary>导入记录 · {snapshot.portable.imports.length}</summary>
          {snapshot.portable.imports.toReversed().map((item) => (
            <article key={item.id}>
              <strong>
                加入 {item.added} 项 · 重复 {item.duplicates} 项 · 跳过{" "}
                {item.skipped} 项
              </strong>
              <p>{item.coverage}</p>
              {item.failures?.length ? (
                <details>
                  <summary>未取得正文的来源 · {item.failures.length}</summary>
                  {item.failures.map((failure) => (
                    <p key={failure.url}>
                      {failure.url}
                      <br />
                      {failure.message}
                    </p>
                  ))}
                </details>
              ) : null}
              <button
                className="text-button"
                disabled={!onTask}
                onClick={() => onTask?.(item.taskId)}
              >
                打开资料工作
              </button>
            </article>
          ))}
        </details>
      ) : null}
      {surface === "backup" && snapshot.portable?.backups.length ? (
        <details className="portable-history">
          <summary>备份文件 · {snapshot.portable.backups.length}</summary>
          {snapshot.portable.backups.toReversed().map((item) => (
            <article key={item.id}>
              <strong>
                {item.createdAt} · {item.tasks} 项工作 · {item.assets} 项资产
              </strong>
              <p>
                <code>{item.path}</code> ·{" "}
                {(item.bytes / 1024 / 1024).toFixed(2)} MB
              </p>
              <button
                className="text-button"
                disabled={!onReveal}
                onClick={() => onReveal?.(item.path)}
              >
                在文件夹中显示备份
              </button>
            </article>
          ))}
        </details>
      ) : null}
      {surface === "backup" && snapshot.portable?.restores.length ? (
        <details className="portable-history">
          <summary>恢复的副本 · {snapshot.portable.restores.length}</summary>
          {snapshot.portable.restores.toReversed().map((item) => (
            <article key={item.id}>
              <strong>
                {item.createdAt} · {item.taskIds.length} 项工作 · {item.assets}{" "}
                项资产
              </strong>
              {item.notices.map((notice) => (
                <p key={notice}>{notice}</p>
              ))}
              <code>{item.root}</code>
              <div className="portable-buttons">
                {item.taskIds.slice(0, 10).map((id) => (
                  <button
                    key={id}
                    className="text-button"
                    disabled={!onTask}
                    onClick={() => onTask?.(id)}
                  >
                    {snapshot.tasks.find((task) => task.id === id)?.title ??
                      "查看恢复的工作"}
                  </button>
                ))}
              </div>
            </article>
          ))}
        </details>
      ) : null}
    </section>
  );
}
