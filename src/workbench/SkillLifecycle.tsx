import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { Copy, Plus, Save, Upload, X } from "lucide-react";
import type { SkillCatalogEntry, SkillDependency } from "../shared/skills";
import type { SkillCommand } from "../shared/skill-library";
import type { Snapshot } from "../shared/types";
import { formatDate, memberName, type Dispatch } from "./common";
const members = ["coordinator", "cto", "researcher", "editor"] as const;
const forms = new Map<string, FormState<unknown>>();
const generations = new Map<string, number>();
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
function useForm<T>(key: string, value: T, revision: number) {
  const getGeneration = useCallback(() => generations.get(key) ?? 0, [key]);
  const generation = useSyncExternalStore(
    subscribe,
    getGeneration,
    getGeneration,
  );
  const fallback = useMemo(
    () => ({
      value,
      base: revision,
      requestId: crypto.randomUUID(),
      pending: false,
      error: "",
    }),
    [key, revision, generation],
  );
  const read = useCallback(
    () => (forms.get(key) as FormState<T> | undefined) ?? fallback,
    [key, fallback],
  );
  const form = useSyncExternalStore(subscribe, read, read);
  const update = (value: T) => {
    forms.set(key, {
      ...read(),
      value,
      requestId: crypto.randomUUID(),
      error: "",
    });
    notify();
  };
  const reset = () => {
    forms.delete(key);
    generations.set(key, (generations.get(key) ?? 0) + 1);
    notify();
  };
  const send = async (
    dispatch: Dispatch,
    build: (form: FormState<T>) => SkillCommand,
  ) => {
    const current = read();
    if (current.pending) return null;
    const submitted = { ...current, pending: true, error: "" };
    forms.set(key, submitted);
    notify();
    try {
      const result = await dispatch(build(submitted));
      if (forms.get(key) === submitted) {
        if (result) {
          forms.delete(key);
          generations.set(key, (generations.get(key) ?? 0) + 1);
        } else
          forms.set(key, {
            ...submitted,
            pending: false,
            error: "操作未完成，草稿已保留。请查看工作台提示后重试。",
          });
      }
      return result;
    } catch (cause) {
      if (forms.get(key) === submitted)
        forms.set(key, {
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
  return { ...form, update, reset, send, conflict: revision !== form.base };
}
function Notice({
  error,
  conflict,
  reset,
}: {
  error: string;
  conflict: boolean;
  reset: () => void;
}) {
  return error || conflict ? (
    <div className="skill-lifecycle-error" role="alert">
      <p>{error || "方法已更新，当前草稿仍保留；请核对最新版本。"}</p>
      {conflict ? (
        <button type="button" className="text-button" onClick={reset}>
          舍弃草稿，读取最新版本
        </button>
      ) : null}
    </div>
  ) : null;
}
export const skillValidationLabel = (skill: SkillCatalogEntry) =>
  skill.validation === "needs-review"
    ? "有反馈待处理"
    : skill.validation === "observed-useful"
      ? "用户在记录条件下反馈有效"
      : "待验证";
export const skillSourceLabel = (skill: SkillCatalogEntry) =>
  ({
    builtin: "内置",
    local: "本地包副本",
    user: "自己的方法",
    derived: "成果提炼",
  })[skill.source];
export function SkillImportTools({
  snapshot,
  dispatch,
  onTask,
}: {
  snapshot: Snapshot;
  dispatch: Dispatch;
  onTask: (id: string) => void;
}) {
  const [route, setRoute] = useState<"import" | "extract">("import");
  const root = snapshot.settings.aiRoot;
  const localForm = useForm(`${root}:skill-native-import`, {}, 0);
  const form = useForm(
    `${root}:skill-import`,
    { name: "", description: "", content: "", originURL: "" },
    0,
  );
  const set = (patch: Partial<typeof form.value>) =>
    form.update({ ...form.value, ...patch });
  const artifactForm = useForm(
    `${root}:skill-artifact`,
    { key: "", instruction: "" },
    0,
  );
  const artifacts = snapshot.tasks.flatMap((task) =>
    task.artifacts
      .filter((artifact) => artifact.format === "md")
      .map((artifact) => ({
        task,
        artifact,
        key: `${task.id}:${artifact.id}`,
      })),
  );
  const selected = artifacts.find(
    (item) => item.key === artifactForm.value.key,
  );
  const useArtifact = async (extract: boolean) => {
    if (!selected) return;
    const result = await artifactForm.send(dispatch, (draft) => {
      const reference = {
        requestId: draft.requestId,
        taskId: selected.task.id,
        artifactId: selected.artifact.id,
        expectedHash: selected.artifact.hash,
      };
      return extract
        ? {
            type: "skill.extract",
            ...reference,
            instruction: draft.value.instruction,
          }
        : { type: "skill.fromArtifact", ...reference };
    });
    if (extract) {
      const created = result?.tasks.find((task) =>
        task.events.some(
          (event) =>
            event.type === "skill.draft_created" &&
            event.data?.requestId === artifactForm.requestId,
        ),
      );
      if (created) onTask(created.id);
    }
  };
  return (
    <div className="skill-import-tools">
      <nav className="asset-operation-tabs" aria-label="添加方法方式">
        <button
          type="button"
          aria-pressed={route === "import"}
          onClick={() => setRoute("import")}
        >
          导入已有方法
        </button>
        <button
          type="button"
          aria-pressed={route === "extract"}
          onClick={() => setRoute("extract")}
        >
          从工作中提炼
        </button>
      </nav>
      <details
        className="skill-lifecycle-form"
        open
        hidden={route !== "import"}
      >
        <summary>添加或导入自己的方法</summary>
        <form
          aria-label="导入 Skill 正文"
          onSubmit={async (event) => {
            event.preventDefault();
            await form.send(dispatch, (draft) => ({
              type: "skill.importText",
              requestId: draft.requestId,
              name: draft.value.name || undefined,
              description: draft.value.description || undefined,
              content: draft.value.content,
              originURL: draft.value.originURL || undefined,
            }));
          }}
        >
          <fieldset disabled={form.pending}>
            <div className="skill-lifecycle-row">
              <label>
                方法名称（正文已写 name 可留空）
                <input
                  aria-label="导入方法名称"
                  value={form.value.name}
                  onChange={(event) => set({ name: event.target.value })}
                />
              </label>
              <label>
                用途（正文已写 description 可留空）
                <input
                  aria-label="导入方法用途"
                  value={form.value.description}
                  onChange={(event) => set({ description: event.target.value })}
                />
              </label>
            </div>
            <label>
              来源链接（可选，仅保留来源）
              <input
                type="url"
                aria-label="方法来源链接"
                value={form.value.originURL}
                onChange={(event) => set({ originURL: event.target.value })}
              />
            </label>
            <label>
              SKILL.md 正文
              <textarea
                aria-label="导入 Skill 正文"
                rows={8}
                value={form.value.content}
                onChange={(event) => set({ content: event.target.value })}
                placeholder="粘贴可信的方法正文，说明用途、条件、做法与失败边界。"
              />
            </label>
            <Notice error={form.error} conflict={false} reset={form.reset} />
            <Notice
              error={localForm.error}
              conflict={false}
              reset={localForm.reset}
            />
            <div className="skill-save-actions">
              <button
                className="button secondary small"
                disabled={!form.value.content.trim()}
              >
                <Save size={13} />
                保存为方法草案
              </button>
              <button
                type="button"
                className="button secondary small"
                disabled={!form.value.originURL.trim()}
                onClick={() =>
                  void form.send(dispatch, (draft) => ({
                    type: "skill.importURL",
                    requestId: draft.requestId,
                    url: draft.value.originURL,
                  }))
                }
              >
                从可信链接读取主方法
              </button>
              <button
                type="button"
                className="button secondary small"
                disabled={localForm.pending}
                onClick={() =>
                  void localForm.send(dispatch, (draft) => ({
                    type: "skill.importLocal",
                    requestId: draft.requestId,
                  }))
                }
              >
                <Upload size={13} />
                选择可信本地 SKILL.md
              </button>
            </div>
          </fieldset>
        </form>
        <p className="skill-note">
          导入后保留来源与版本，默认停用、待验证。本地包只复制有限的附带文本资料；脚本不会安装或执行。
          链接导入仅读取主方法正文，未取得的附加资料保留为缺失依赖。
        </p>
      </details>
      <details
        className="skill-lifecycle-form"
        open
        hidden={route !== "extract"}
      >
        <summary>从已有成果提炼可复用方法</summary>
        <fieldset disabled={artifactForm.pending}>
          <label>
            选择实际成果
            <select
              aria-label="方法提炼来源成果"
              value={artifactForm.value.key}
              onChange={(event) =>
                artifactForm.update({
                  ...artifactForm.value,
                  key: event.target.value,
                })
              }
            >
              <option value="">选择一份 Markdown 成果</option>
              {artifacts.map((item) => (
                <option value={item.key} key={item.key}>
                  {item.task.title} · {item.artifact.title} v
                  {item.artifact.version}
                </option>
              ))}
            </select>
          </label>
          <label>
            希望提炼的条件与做法
            <textarea
              aria-label="方法提炼要求"
              rows={3}
              value={artifactForm.value.instruction}
              onChange={(event) =>
                artifactForm.update({
                  ...artifactForm.value,
                  instruction: event.target.value,
                })
              }
            />
          </label>
          <Notice
            error={artifactForm.error}
            conflict={false}
            reset={artifactForm.reset}
          />
          <div className="skill-save-actions">
            <button
              type="button"
              className="button secondary small"
              disabled={!selected}
              onClick={() => void useArtifact(true)}
            >
              让团队提炼方法草案
            </button>
            <button
              type="button"
              className="text-button"
              disabled={!selected}
              onClick={() => void useArtifact(false)}
            >
              采纳此成果为 Skill 草案
            </button>
          </div>
          <p className="skill-note">
            先在原工作台审阅提炼结果，再选择实际成果采纳。一次工作成功不会自动成为已验证能力。
          </p>
        </fieldset>
      </details>
    </div>
  );
}
function DependencyFields({
  dependencies,
  onChange,
}: {
  dependencies: SkillDependency[];
  onChange: (value: SkillDependency[]) => void;
}) {
  const update = (index: number, patch: Partial<SkillDependency>) =>
    onChange(
      dependencies.map((item, i) =>
        i === index ? { ...item, ...patch } : item,
      ),
    );
  return (
    <div>
      {dependencies.map((dependency, index) => (
        <div className="skill-dependency" key={index}>
          <div className="skill-lifecycle-row">
            <label>
              依赖名称
              <input
                aria-label={`依赖 ${index + 1} 名称`}
                required
                value={dependency.name}
                onChange={(event) =>
                  update(index, { name: event.target.value })
                }
              />
            </label>
            <label>
              实际条件
              <select
                aria-label={`依赖 ${index + 1} 状态`}
                value={dependency.status}
                onChange={(event) =>
                  update(index, {
                    status: event.target.value as SkillDependency["status"],
                  })
                }
              >
                <option value="unknown">尚未确认</option>
                <option value="missing">目前缺少</option>
                <option value="available">我已确认可用</option>
              </select>
            </label>
            <button
              type="button"
              className="icon-button"
              aria-label={`移除依赖 ${index + 1}`}
              onClick={() =>
                onChange(dependencies.filter((_, i) => i !== index))
              }
            >
              <X size={13} />
            </button>
          </div>
          <label>
            确认依据或缺失原因
            <input
              aria-label={`依赖 ${index + 1} 依据`}
              required={dependency.status === "available"}
              value={dependency.evidence}
              onChange={(event) =>
                update(index, { evidence: event.target.value })
              }
            />
          </label>
        </div>
      ))}
      <button
        type="button"
        className="text-button"
        onClick={() =>
          onChange([
            ...dependencies,
            { name: "", status: "unknown", evidence: "" },
          ])
        }
      >
        <Plus size={12} />
        添加实际依赖
      </button>
    </div>
  );
}
function MethodEditor({
  skill,
  root,
  dispatch,
}: {
  skill: SkillCatalogEntry;
  root: string;
  dispatch: Dispatch;
}) {
  const form = useForm(
    `${root}:skill-edit:${skill.id}`,
    {
      name: skill.name,
      description: skill.description,
      instructions: skill.instructions,
      dependencies: skill.dependencies ?? [],
      allowedMembers: (skill.allowedMembers ?? [
        ...members,
      ]) as (typeof members)[number][],
    },
    skill.revision ?? 0,
  );
  const set = (patch: Partial<typeof form.value>) =>
    form.update({ ...form.value, ...patch });
  return (
    <details className="skill-lifecycle-form">
      <summary>编辑自己的方法与依赖</summary>
      <form
        aria-label={`编辑方法 ${skill.name}`}
        onSubmit={async (event) => {
          event.preventDefault();
          await form.send(dispatch, (draft) => ({
            type: "skill.edit",
            requestId: draft.requestId,
            skillId: skill.id,
            expectedRevision: draft.base,
            input: draft.value,
          }));
        }}
      >
        <fieldset disabled={form.pending}>
          <label>
            名称
            <input
              required
              aria-label="编辑方法名称"
              value={form.value.name}
              onChange={(event) => set({ name: event.target.value })}
            />
          </label>
          <label>
            用途
            <input
              required
              aria-label="编辑方法用途"
              value={form.value.description}
              onChange={(event) => set({ description: event.target.value })}
            />
          </label>
          <label>
            方法正文
            <textarea
              required
              aria-label="编辑方法正文"
              rows={10}
              value={form.value.instructions}
              onChange={(event) => set({ instructions: event.target.value })}
            />
          </label>
          <DependencyFields
            dependencies={form.value.dependencies}
            onChange={(dependencies) => set({ dependencies })}
          />
          <Notice
            error={form.error}
            conflict={form.conflict}
            reset={form.reset}
          />
          <button className="button secondary small" disabled={form.conflict}>
            <Save size={13} />
            {form.pending ? "保存中…" : "保存新版本"}
          </button>
          <p className="skill-note">
            当前目录改用新版本，已有工作的绑定版本保留。历史正文可以重新选为当前版本。
          </p>
        </fieldset>
      </form>
    </details>
  );
}
function MemberScope({
  skill,
  root,
  dispatch,
}: {
  skill: SkillCatalogEntry;
  root: string;
  dispatch: Dispatch;
}) {
  const form = useForm(
    `${root}:skill-members:${skill.id}`,
    {
      allowedMembers: (skill.allowedMembers ?? [
        ...members,
      ]) as (typeof members)[number][],
    },
    skill.revision ?? 0,
  );
  return (
    <details className="skill-lifecycle-form">
      <summary>
        成员可用范围 ·{" "}
        {(skill.allowedMembers ?? members)
          .map((member) => memberName(member as (typeof members)[number]))
          .join("、") || "未允许成员"}
      </summary>
      <fieldset disabled={form.pending}>
        <div className="skill-member-options">
          {members.map((member) => (
            <label key={member}>
              <input
                type="checkbox"
                aria-label={`允许 ${memberName(member)} 使用 ${skill.name}`}
                checked={form.value.allowedMembers.includes(member)}
                onChange={(event) =>
                  form.update({
                    allowedMembers: event.target.checked
                      ? [...form.value.allowedMembers, member]
                      : form.value.allowedMembers.filter(
                          (value) => value !== member,
                        ),
                  })
                }
              />
              {memberName(member)}
            </label>
          ))}
        </div>
        <Notice
          error={form.error}
          conflict={form.conflict}
          reset={form.reset}
        />
        <button
          type="button"
          className="button secondary small"
          disabled={form.conflict}
          onClick={() =>
            void form.send(dispatch, (draft) => ({
              type: "skill.setMembers",
              requestId: draft.requestId,
              skillId: skill.id,
              expectedRevision: draft.base,
              expectedHash: skill.hash,
              allowedMembers: draft.value.allowedMembers,
            }))
          }
        >
          保存成员范围
        </button>
        <p className="skill-note">
          范围变更保留为新版本，仅影响以后新绑定的方法，不扩充成员的工具权限。
        </p>
      </fieldset>
    </details>
  );
}
function UsageFeedback({
  skill,
  root,
  snapshot,
  dispatch,
}: {
  skill: SkillCatalogEntry;
  root: string;
  snapshot: Snapshot;
  dispatch: Dispatch;
}) {
  const form = useForm(
    `${root}:skill-feedback:${skill.id}:${skill.hash}`,
    {
      outcome: "useful" as "useful" | "failed" | "correction",
      conditions: "",
      observation: "",
      evidence: "",
      taskId: "",
    },
    0,
  );
  const set = (patch: Partial<typeof form.value>) =>
    form.update({ ...form.value, ...patch });
  const tasks = snapshot.tasks.filter((task) =>
    task.events.some(
      (event) =>
        event.type === "skill_loaded" &&
        event.data?.skillId === skill.id &&
        event.data?.hash === skill.hash,
    ),
  );
  return (
    <details className="skill-lifecycle-form">
      <summary>记录使用结果与验证条件 · v{skill.version}</summary>
      <form
        aria-label={`记录 ${skill.name} 使用反馈`}
        onSubmit={async (event) => {
          event.preventDefault();
          await form.send(dispatch, (draft) => ({
            type: "skill.feedback",
            requestId: draft.requestId,
            skillId: skill.id,
            versionHash: skill.hash,
            ...draft.value,
            taskId: draft.value.taskId || undefined,
          }));
        }}
      >
        <fieldset disabled={form.pending}>
          <div className="skill-lifecycle-row">
            <label>
              实际结果
              <select
                aria-label="方法实际结果"
                value={form.value.outcome}
                onChange={(event) =>
                  set({
                    outcome: event.target.value as typeof form.value.outcome,
                  })
                }
              >
                <option value="useful">在记录条件下有效</option>
                <option value="failed">未达到预期</option>
                <option value="correction">需要修正方法</option>
              </select>
            </label>
            <label>
              对应的实际工作
              <select
                aria-label="方法反馈所属工作"
                value={form.value.taskId}
                onChange={(event) => set({ taskId: event.target.value })}
              >
                <option value="">其他工具 / 手动使用，另提供依据</option>
                {tasks.map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.title}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            使用场景与验证条件
            <textarea
              required
              aria-label="方法验证条件"
              rows={2}
              value={form.value.conditions}
              onChange={(event) => set({ conditions: event.target.value })}
            />
          </label>
          <label>
            实际观察与修改建议
            <textarea
              required
              aria-label="方法实际观察"
              rows={3}
              value={form.value.observation}
              onChange={(event) => set({ observation: event.target.value })}
            />
          </label>
          <label>
            实际使用或检查依据
            <textarea
              required
              aria-label="方法验证依据"
              rows={2}
              placeholder="实际输入和输出、接收方反馈，或可核对的结果位置"
              value={form.value.evidence}
              onChange={(event) => set({ evidence: event.target.value })}
            />
          </label>
          <Notice error={form.error} conflict={false} reset={form.reset} />
          <button
            className="button secondary small"
            disabled={
              !form.value.conditions.trim() ||
              !form.value.observation.trim() ||
              !form.value.evidence.trim()
            }
          >
            保存此版本的使用反馈
          </button>
          <p className="skill-note">
            保留用户实际报告的条件与依据，不代表所有场景验证通过；失败与修正会提示待处理。
          </p>
        </fieldset>
      </form>
    </details>
  );
}
export function SkillLifecycle({
  skill,
  snapshot,
  dispatch,
}: {
  skill: SkillCatalogEntry;
  snapshot: Snapshot;
  dispatch: Dispatch;
}) {
  const root = snapshot.settings.aiRoot;
  const actions = useForm(
    `${root}:skill-action:${skill.id}`,
    { copyName: `${skill.name} · 我的副本` },
    skill.revision ?? 0,
  );
  return (
    <div className="skill-lifecycle">
      <details className="skill-lifecycle-form">
        <summary>保存自己的副本</summary>
        <fieldset disabled={actions.pending}>
          <label>
            副本名称
            <input
              aria-label={`Skill ${skill.id} 副本名称`}
              value={actions.value.copyName}
              onChange={(event) =>
                actions.update({ copyName: event.target.value })
              }
            />
          </label>
          <button
            type="button"
            className="button secondary small"
            disabled={!actions.value.copyName.trim() || actions.conflict}
            onClick={() =>
              void actions.send(dispatch, (draft) => ({
                type: "skill.copy",
                requestId: draft.requestId,
                skillId: skill.id,
                expectedHash: skill.hash,
                name: draft.value.copyName,
              }))
            }
          >
            <Copy size={13} />
            创建自己的副本
          </button>
        </fieldset>
      </details>
      {skill.editable ? (
        <MethodEditor skill={skill} root={root} dispatch={dispatch} />
      ) : null}
      <MemberScope skill={skill} root={root} dispatch={dispatch} />
      {skill.dependencies?.length ? (
        <div className="skill-dependency-summary">
          <strong>实际依赖</strong>
          {skill.dependencies.map((item) => (
            <p key={item.name}>
              {item.name} ·{" "}
              {item.status === "available"
                ? "用户已确认可用"
                : item.status === "missing"
                  ? "缺少"
                  : "尚未确认"}
              {item.evidence ? `：${item.evidence}` : ""}
            </p>
          ))}
        </div>
      ) : null}
      {skill.resources?.length ? (
        <details className="skill-lifecycle-form">
          <summary>已复制的附带资料 · {skill.resources.length}</summary>
          <p className="skill-note">
            模型通过范围内的资源读取工具按需取得正文。这些文本不会授予脚本或任意路径权限。
          </p>
          {skill.resources.map((resource) => (
            <details key={resource.path}>
              <summary>
                {resource.path} · {resource.content.length} 字符
              </summary>
              <pre>{resource.content}</pre>
              <code className="skill-hash">{resource.hash}</code>
            </details>
          ))}
        </details>
      ) : null}
      {(skill.versions?.length ?? 0) > 1 ? (
        <details className="skill-lifecycle-form">
          <summary>保存的版本 · {skill.versions!.length}</summary>
          {skill.versions!.map((version) => (
            <div className="skill-version-row" key={version.hash}>
              <span>
                v{version.version} ·{" "}
                {version.createdAt ? formatDate(version.createdAt) : "内置版本"}
                {version.active ? " · 当前目录版本" : ""}
                <code className="skill-hash">{version.hash}</code>
              </span>
              {!version.active ? (
                <button
                  type="button"
                  className="text-button"
                  disabled={actions.pending || actions.conflict}
                  onClick={() =>
                    void actions.send(dispatch, (draft) => ({
                      type: "skill.activateVersion",
                      requestId: draft.requestId,
                      skillId: skill.id,
                      expectedRevision: draft.base,
                      versionHash: version.hash,
                    }))
                  }
                >
                  选为当前版本
                </button>
              ) : null}
            </div>
          ))}
        </details>
      ) : null}
      <UsageFeedback
        skill={skill}
        root={root}
        snapshot={snapshot}
        dispatch={dispatch}
      />
      {skill.feedback?.length ? (
        <details className="skill-lifecycle-form">
          <summary>使用反馈与条件记录 · {skill.feedback.length}</summary>
          {skill.feedback.map((item) => (
            <article className="skill-feedback-record" key={item.id}>
              <strong>
                {item.outcome === "useful"
                  ? "在记录条件下反馈有效"
                  : item.outcome === "failed"
                    ? "未达到预期"
                    : "需要修正方法"}{" "}
                · {formatDate(item.createdAt)}
              </strong>
              <p>条件：{item.conditions}</p>
              <p>观察：{item.observation}</p>
              <p>依据：{item.evidence}</p>
              {item.versionHash !== skill.hash ? (
                <small>对应历史内容版本。</small>
              ) : null}
            </article>
          ))}
        </details>
      ) : null}
      <Notice
        error={actions.error}
        conflict={actions.conflict}
        reset={actions.reset}
      />
    </div>
  );
}
