import { useCallback, useState, useSyncExternalStore } from "react";
import { BookOpen, ChevronDown } from "lucide-react";
import {
  DEFAULT_SKILL_POLICY,
  type SkillCatalogEntry,
  type SkillPolicy,
} from "../shared/skills";
import type { Snapshot, Task, TaskEvent } from "../shared/types";
import { formatDate, Markdown, memberName, type Dispatch } from "./common";
import {
  SkillImportTools,
  SkillLifecycle,
  skillSourceLabel,
  skillValidationLabel,
} from "./SkillLifecycle";

export function skillPolicyLabel(policy: SkillPolicy) {
  return policy.mode === "auto"
    ? "团队自动选择"
    : policy.mode === "off"
      ? "不用 Skill"
      : `指定 ${policy.skillIds.length} 项方法`;
}

export function validSkillSelection(
  policy: SkillPolicy,
  catalog: SkillCatalogEntry[],
) {
  return (
    policy.mode !== "explicit" ||
    (policy.skillIds.length > 0 &&
      policy.skillIds.length <= 3 &&
      policy.skillIds.every((id) =>
        catalog.some(
          (skill) =>
            skill.id === id &&
            skill.enabled &&
            skill.availability !== "missing-dependencies" &&
            skill.allowedMembers?.length !== 0,
        ),
      ))
  );
}

export function SkillPolicyPicker({
  policy,
  catalog,
  onChange,
  disabled = false,
}: {
  policy: SkillPolicy;
  catalog: SkillCatalogEntry[];
  onChange: (policy: SkillPolicy) => void;
  disabled?: boolean;
}) {
  const selected = new Set(policy.skillIds);
  const unavailable = policy.skillIds.filter(
    (id) =>
      !catalog.some(
        (skill) =>
          skill.id === id &&
          skill.enabled &&
          skill.availability !== "missing-dependencies" &&
          skill.allowedMembers?.length !== 0,
      ),
  );
  return (
    <fieldset className="skill-policy-picker" disabled={disabled}>
      <legend className="sr-only">当前工作的 Skill 选择</legend>
      <label className="skill-mode">
        <span>使用方法</span>
        <select
          aria-label="Skill 选择方式"
          value={policy.mode}
          onChange={(event) =>
            onChange({
              mode: event.target.value as SkillPolicy["mode"],
              skillIds:
                event.target.value === "explicit" ? policy.skillIds : [],
            })
          }
        >
          <option value="auto">团队自动选择</option>
          <option value="explicit">指定 Skill</option>
          <option value="off">不用 Skill</option>
        </select>
      </label>
      {policy.mode === "explicit" ? (
        <>
          <p className="skill-note">选择 1–3 项方法，成员按需要实际加载。</p>
          <div className="skill-choice-list">
            {catalog.map((skill) => (
              <label key={skill.id} className="skill-choice">
                <input
                  type="checkbox"
                  aria-label={`使用 ${skill.name}`}
                  checked={selected.has(skill.id)}
                  disabled={
                    !selected.has(skill.id) &&
                    (!skill.enabled ||
                      skill.availability === "missing-dependencies" ||
                      skill.allowedMembers?.length === 0 ||
                      selected.size >= 3)
                  }
                  onChange={(event) =>
                    onChange({
                      mode: "explicit",
                      skillIds: event.target.checked
                        ? [...policy.skillIds, skill.id]
                        : policy.skillIds.filter((id) => id !== skill.id),
                    })
                  }
                />
                <span>
                  <strong>{skill.name}</strong>
                  <small>
                    v{skill.version} ·{" "}
                    {skill.enabled ? skillValidationLabel(skill) : "已停用"}
                    {skill.availability === "missing-dependencies"
                      ? " · 缺依赖"
                      : ""}
                  </small>
                  <span>{skill.description}</span>
                </span>
              </label>
            ))}
          </div>
          {unavailable.length ? (
            <p className="skill-note skill-warning" role="status">
              有 {unavailable.length} 项选择已停用或不可用，请移除后重新选择。
              {unavailable
                .filter((id) => !catalog.some((s) => s.id === id))
                .map((id) => (
                  <button
                    key={id}
                    type="button"
                    className="text-button"
                    onClick={() =>
                      onChange({
                        ...policy,
                        skillIds: policy.skillIds.filter(
                          (value) => value !== id,
                        ),
                      })
                    }
                  >
                    移除 {id}
                  </button>
                ))}
            </p>
          ) : null}
        </>
      ) : (
        <p className="skill-note">
          {policy.mode === "auto"
            ? "团队可在已启用方法中选择；实际加载会记录在协作过程。"
            : "这项工作不加载 Skill，成员仍可使用已获准的工具。"}
        </p>
      )}
    </fieldset>
  );
}

type PolicyDraft = { policy: SkillPolicy; base: string };
const drafts = new Map<string, PolicyDraft>();
const pending = new Set<string>();
const listeners = new Set<() => void>();
const announce = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const policyKey = (policy: SkillPolicy) =>
  `${policy.mode}:${[...policy.skillIds].sort().join(",")}`;

export function TaskSkills({
  task,
  snapshot,
  dispatch,
  connected,
}: {
  task: Task;
  snapshot: Snapshot;
  dispatch: Dispatch;
  connected: boolean;
}) {
  const key = `${snapshot.settings.aiRoot}:${task.id}`;
  const readDraft = useCallback(() => drafts.get(key), [key]);
  const readPending = useCallback(() => pending.has(key), [key]);
  const draft = useSyncExternalStore(subscribe, readDraft, readDraft);
  const saving = useSyncExternalStore(subscribe, readPending, readPending);
  const saved = task.skillPolicy ?? DEFAULT_SKILL_POLICY;
  const policy = draft?.policy ?? saved;
  const changed = policyKey(policy) !== policyKey(saved);
  const conflict = Boolean(draft && draft.base !== policyKey(saved) && changed);
  const active = task.status === "running" || task.status === "waiting";
  const disabled = !connected || active || saving;
  const save = async () => {
    if (
      disabled ||
      pending.has(key) ||
      conflict ||
      !changed ||
      !validSkillSelection(policy, snapshot.skills ?? [])
    )
      return;
    const submitted = draft;
    pending.add(key);
    announce();
    try {
      const result = await dispatch({
        type: "task.setSkills",
        taskId: task.id,
        policy,
      });
      if (result && drafts.get(key) === submitted) drafts.delete(key);
    } finally {
      pending.delete(key);
      announce();
    }
  };
  return (
    <details className="work-skills" aria-label="工作使用的 Skills">
      <summary>
        <BookOpen size={13} />
        <span>Skill · {skillPolicyLabel(saved)}</span>
        <ChevronDown size={12} />
      </summary>
      <SkillPolicyPicker
        policy={policy}
        catalog={snapshot.skills ?? []}
        disabled={disabled}
        onChange={(next) => {
          drafts.set(key, {
            policy: next,
            base: draft?.base ?? policyKey(saved),
          });
          announce();
        }}
      />
      {active ? (
        <p className="skill-note">
          工作运行或等待回复期间不能修改。先暂停工作，再调整方法。
        </p>
      ) : null}
      {task.skillBindings?.length ? (
        <p className="skill-note">
          已绑定版本：
          {task.skillBindings
            .map((skill) => `${skill.name} v${skill.version}`)
            .join("、")}
          。绑定表示可供加载，实际使用以过程记录为准。
        </p>
      ) : null}
      {conflict ? (
        <p className="skill-note skill-warning" role="status">
          工作方法已在其他位置更新。请取消本地选择后重新调整。
        </p>
      ) : null}
      {changed ? (
        <div className="skill-save-actions">
          <button
            type="button"
            className="button secondary small"
            disabled={
              disabled ||
              conflict ||
              !validSkillSelection(policy, snapshot.skills ?? [])
            }
            onClick={() => void save()}
          >
            {saving ? "保存中…" : "保存方法选择"}
          </button>
          <button
            type="button"
            className="text-button"
            disabled={saving}
            onClick={() => {
              drafts.delete(key);
              announce();
            }}
          >
            取消修改
          </button>
          <p className="skill-note">
            保存后下次处理生效，保留已有成果。未保存的选择不会用于发送。
          </p>
        </div>
      ) : null}
    </details>
  );
}

function eventText(event: TaskEvent, key: string) {
  return typeof event.data?.[key] === "string"
    ? (event.data[key] as string)
    : "";
}

export function SkillUsage({ events }: { events: TaskEvent[] }) {
  const loaded = events.filter((event) => event.type === "skill_loaded");
  if (!loaded.length) return null;
  return (
    <details className="skill-usage" aria-label="实际加载的 Skills" open>
      <summary>实际加载的方法 · {loaded.length}</summary>
      {loaded.map((event) => (
        <article key={event.id}>
          <div>
            <strong>
              {eventText(event, "name") ||
                eventText(event, "skillId") ||
                "Skill"}
            </strong>
            <span>
              {eventText(event, "version")
                ? `v${eventText(event, "version")} · `
                : ""}
              {event.member ? memberName(event.member) : "成员未记录"}
            </span>
          </div>
          <p>{eventText(event, "purpose") || event.summary}</p>
        </article>
      ))}
      <p className="skill-note">
        加载表示成员已取得方法正文；资料读取、工具执行、成果与验证另看对应记录。
      </p>
    </details>
  );
}

export function SkillCatalog({
  snapshot,
  dispatch,
  query = "",
  onTask,
}: {
  snapshot: Snapshot;
  dispatch: Dispatch;
  query?: string;
  onTask: (id: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  const [detailTab, setDetailTab] = useState<"method" | "evidence" | "manage">(
    "method",
  );
  const pendingPrefix = `catalog:${snapshot.settings.aiRoot}:`;
  const readPending = useCallback(
    () => [...pending].find((key) => key.startsWith(pendingPrefix)),
    [pendingPrefix],
  );
  const pendingKey = useSyncExternalStore(subscribe, readPending, readPending);
  const catalog = (snapshot.skills ?? []).filter((skill) =>
    `${skill.name} ${skill.description} ${skill.instructions}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const selection = catalog.find((skill) => skill.id === selected);
  return (
    <section className="skill-catalog" aria-label="Skill 资产">
      <div className="asset-catalog-toolbar">
        {selection || managing ? (
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setSelected(null);
              setManaging(false);
            }}
          >
            ← 返回方法库
          </button>
        ) : (
          <span className="skill-note">
            {catalog.length} 个方法 · 按需供团队使用
          </span>
        )}
        {!managing ? (
          <button
            type="button"
            className="button secondary small"
            onClick={() => {
              setManaging(true);
              setSelected(null);
            }}
          >
            导入或提炼方法
          </button>
        ) : null}
      </div>
      {managing ? (
        <SkillImportTools
          snapshot={snapshot}
          dispatch={dispatch}
          onTask={onTask}
        />
      ) : null}
      {!selection && !managing ? (
        <div className="skill-directory">
          {catalog.map((skill) => (
            <button
              type="button"
              className="skill-directory-row"
              aria-label={`查看 ${skill.name}`}
              key={skill.id}
              onClick={() => {
                setSelected(skill.id);
                setDetailTab("method");
              }}
            >
              <div>
                <strong>{skill.name}</strong>
                <span>{skill.description}</span>
              </div>
              <small>
                {skill.enabled ? "已启用" : "已停用"} ·{" "}
                {skillValidationLabel(skill)}
                <br />
                {skillSourceLabel(skill)} · v{skill.version}
              </small>
            </button>
          ))}
        </div>
      ) : null}
      {(selection ? [selection] : []).map((skill) => {
        const evidence = snapshot.tasks.flatMap((task) =>
          task.events
            .filter(
              (event) =>
                event.type === "skill_loaded" &&
                event.data?.skillId === skill.id,
            )
            .map((event) => ({ event, task })),
        );
        return (
          <article key={skill.id} className="skill-card">
            <header>
              <div>
                <h3>{skill.name}</h3>
                <span>
                  {skillSourceLabel(skill)} · v{skill.version} ·{" "}
                  {skillValidationLabel(skill)}
                  {!skill.enabled ? " · 已停用" : " · 已启用"}
                  {skill.availability === "missing-dependencies"
                    ? " · 缺依赖"
                    : ""}
                </span>
              </div>
              <button
                type="button"
                className="button secondary small"
                aria-label={`${skill.enabled ? "停用" : "启用"} ${skill.name}`}
                disabled={Boolean(pendingKey)}
                onClick={async () => {
                  if (readPending()) return;
                  const key = `${pendingPrefix}${skill.id}`;
                  pending.add(key);
                  announce();
                  try {
                    await dispatch({
                      type: "skill.setEnabled",
                      skillId: skill.id,
                      enabled: !skill.enabled,
                    });
                  } finally {
                    pending.delete(key);
                    announce();
                  }
                }}
              >
                {pendingKey === `${pendingPrefix}${skill.id}`
                  ? "保存中…"
                  : skill.enabled
                    ? "停用"
                    : "启用"}
              </button>
            </header>
            <p>{skill.description}</p>
            <nav className="asset-operation-tabs" aria-label="方法详情">
              {(
                [
                  ["method", "方法正文"],
                  ["evidence", "使用证据"],
                  ["manage", "版本与管理"],
                ] as const
              ).map(([id, label]) => (
                <button
                  type="button"
                  key={id}
                  aria-pressed={detailTab === id}
                  onClick={() => setDetailTab(id)}
                >
                  {label}
                </button>
              ))}
            </nav>
            <div hidden={detailTab !== "method"}>
              <details className="skill-instructions" open>
                <summary>查看方法正文与版本</summary>
                <p className="skill-note">
                  来源：{skill.origin?.label ?? "ytriple 内置方法"} · 版本{" "}
                  {skill.version}
                  {skill.origin?.location ? ` · ${skill.origin.location}` : ""}
                </p>
                <code className="skill-hash">内容标识：{skill.hash}</code>
                {skill.origin?.coverage ? (
                  <p className="skill-note">
                    实际取得范围：{skill.origin.coverage}
                  </p>
                ) : null}
                <Markdown dispatch={dispatch}>{skill.instructions}</Markdown>
              </details>
            </div>
            <div hidden={detailTab !== "evidence"}>
              <details className="skill-history" open>
                <summary>实际加载记录 · {evidence.length}</summary>
                {evidence.length ? (
                  evidence.map(({ event, task }) => (
                    <div key={`${task.id}:${event.id}`}>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => onTask(task.id)}
                      >
                        {task.title}
                      </button>
                      <span>
                        {event.member ? memberName(event.member) : "成员未记录"}{" "}
                        · v{eventText(event, "version") || "未记录"} ·{" "}
                        {formatDate(event.createdAt)}
                      </span>
                      <p>{eventText(event, "purpose") || event.summary}</p>
                      {event.data?.hash !== skill.hash ? (
                        <small>历史内容版本，非当前方法正文。</small>
                      ) : null}
                    </div>
                  ))
                ) : (
                  <p className="skill-note">还没有实际加载证据。</p>
                )}
                <p className="skill-note">被加载不表示效果已验证。</p>
              </details>
            </div>
            <div hidden={detailTab !== "manage"}>
              <SkillLifecycle
                skill={skill}
                snapshot={snapshot}
                dispatch={dispatch}
              />
            </div>
          </article>
        );
      })}
      {!catalog.length && !managing ? (
        <div className="collection-empty">
          <BookOpen size={30} />
          <h2>{query ? "没有找到这个方法" : "暂无可用方法"}</h2>
          <p>
            {query
              ? "换个名称或正文关键词试试。"
              : "读取本机能力后，可在这里查看来源与正文。"}
          </p>
        </div>
      ) : null}
      {selection ? (
        <p className="skill-note">
          停用影响后续处理，当前运行继续使用已确定的方法。指定了停用方法的工作需要重新选择。
        </p>
      ) : null}
    </section>
  );
}
