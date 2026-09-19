import { SkillChooser } from "./SkillChooser";
import { useState } from "react";
import { toolCatalog } from "../core/tool-contract";
import { Plus, Trash2, ArrowUp, ArrowDown } from "lucide-react";
import type { Snapshot, Work, Team, Workflow } from "../core/types";
import {
  versionKey,
  checkCompatibility,
  configurationForSnapshot,
} from "../core/configuration";
import { command } from "./api";
import { IconButton } from "./Composer";
import {
  instantiateMemberTemplate,
  listMemberTemplates,
  memberTemplateCatalog,
  memberTemplateLicenseText,
  MEMBER_TEMPLATE_SOURCE_URL,
} from "../core/member-templates";

export function ConfigurationEditor({
  data,
  work,
  onApplied,
}: {
  data: Snapshot;
  work?: Work;
  onApplied: () => void;
}) {
  const { team: initialTeam, workflow: initialFlow } = configurationForSnapshot(
    data,
    work,
  );
  const [teams, setTeams] = useState(data.teams),
    [flows, setFlows] = useState(data.workflows);
  const [team, setTeam] = useState<Team>(structuredClone(initialTeam)),
    [flow, setFlow] = useState<Workflow>(structuredClone(initialFlow));
  const [tab, setTab] = useState<"team" | "flow" | "history">("team");
  const [dirty, setDirty] = useState({ team: false, flow: false }),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const [license, setLicense] = useState("");
  const [licenseBusy, setLicenseBusy] = useState(false);
  const memberTemplates = listMemberTemplates();
  const [templateId, setTemplateId] = useState(memberTemplates[0]?.id ?? "");
  const templatePreview = memberTemplateCatalog.find((t) => t.id === templateId);
  const [directActions, setDirectActions] = useState(
    data.workspacePolicy.direct,
  );
  const latestTeam = Math.max(
    ...teams.filter((t) => t.id === team.id).map((t) => t.version),
  );
  const latestFlow = Math.max(
    ...flows.filter((f) => f.id === flow.id).map((f) => f.version),
  );
  const teamEditable = team.version === latestTeam && !busy,
    flowEditable = flow.version === latestFlow && !busy;
  let compatibility = "";
  try {
    checkCompatibility(team, flow);
  } catch (e) {
    compatibility = e instanceof Error ? e.message : "配置不兼容";
  }
  function editTeam(next: Team) {
    setTeam(next);
    setDirty((d) => ({ ...d, team: true }));
    setNotice("");
  }
  function editFlow(next: Workflow) {
    setFlow(next);
    setDirty((d) => ({ ...d, flow: true }));
    setNotice("");
  }
  async function save(kind: "team" | "flow") {
    setBusy(true);
    setError("");
    try {
      if (kind === "team") {
        const next = await command<Team>({ type: "save-team", team });
        setTeams((ts) => [...ts, next]);
        setTeam(next);
      } else {
        const next = await command<Workflow>({
          type: "save-workflow",
          workflow: flow,
        });
        setFlows((fs) => [...fs, next]);
        setFlow(next);
      }
      setDirty((d) => ({ ...d, [kind]: false }));
      setNotice("新版本已保存。选择“应用组合”后用于后续提交。");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    setBusy(true);
    setError("");
    try {
      await command({
        type: "select-configuration",
        workId: work?.id ?? null,
        teamKey: versionKey(team),
        workflowKey: versionKey(flow),
      });
      onApplied();
      setNotice("已应用；已提交和排队的运行继续使用原配置。");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const appliedTeamKey = versionKey(initialTeam),
    appliedFlowKey = versionKey(initialFlow);
  const isApplied =
    !dirty.team &&
    !dirty.flow &&
    versionKey(team) === appliedTeamKey &&
    versionKey(flow) === appliedFlowKey;
  const configStatus = isApplied
    ? "当前应用组合"
    : dirty.team || dirty.flow
      ? "正在编辑，尚未保存"
      : "已选版本尚未应用，需点「应用组合」";
  const records = data.runs
    .filter((r) => !work || r.workId === work.id)
    .slice()
    .reverse();
  return (
    <div className="configuration-editor">
      <p className="settings-note" role="status">
        {configStatus}。保存只产生新版本；「应用组合」才影响
        {work ? "此工作" : "新工作"}的后续提交。已提交与排队运行保留原搭配/流程快照。
      </p>
      <p className="settings-note">
        所有成员共用当前 AI 连接；「应用组合」只影响
        {work ? "此工作" : "新工作"}的后续提交。历史运行详情保留当时的搭配与连接记录，供诊断使用。
      </p>
      <div className="config-tabs" aria-label="配置内容">
        {(
          [
            ["team", "团队搭配"],
            ["flow", "协作流程"],
            ["history", "使用记录"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "team" ? (
        <section>
          <label className="schedule-check">
            <input
              type="checkbox"
              checked={directActions}
              disabled={busy}
              onChange={(event) => {
                const direct = event.target.checked;
                setBusy(true);
                setError("");
                void command({ type: "workspace-policy", direct })
                  .then(() => {
                    setDirectActions(direct);
                    setNotice(
                      direct
                        ? "后续小范围、可撤销的操作可由团队直接办理；周期执行、启用和扩大范围仍需确认。"
                        : "团队会先请你确认所有工作台变更。",
                    );
                    onApplied();
                  })
                  .catch((reason) =>
                    setError(
                      reason instanceof Error ? reason.message : String(reason),
                    ),
                  )
                  .finally(() => setBusy(false));
              }}
            />
            小范围操作直接办理
          </label>
          <p className="settings-note">
            默认关闭。保存关注重点、暂停任务等可撤销操作可直接完成；新增周期、启用任务、扩大来源范围仍会等待确认。
          </p>
          <fieldset className="form-section">
            <legend>搭配信息</legend>
            <label>
              搭配版本
              <select
                aria-label="搭配版本"
                disabled={dirty.team || busy}
                value={versionKey(team)}
                onChange={(e) =>
                  setTeam(
                    structuredClone(
                      teams.find((t) => versionKey(t) === e.target.value)!,
                    ),
                  )
                }
              >
                {teams.map((t) => (
                  <option key={versionKey(t)} value={versionKey(t)}>
                    {t.name} · v{t.version}
                  </option>
                ))}
              </select>
            </label>
            {team.version < latestTeam ? (
              <p className="settings-note">
                正在查看历史搭配。选择最新版本可继续编辑。
              </p>
            ) : null}
            <label>
              搭配名称
              <input
                value={team.name}
                disabled={!teamEditable}
                maxLength={200}
                onChange={(e) => editTeam({ ...team, name: e.target.value })}
              />
            </label>
          </fieldset>
          {team.members.map((m, i) => (
            <fieldset
              key={m.id}
              disabled={!teamEditable}
              className="config-member"
            >
              <legend>成员 {i + 1}</legend>
              <div className="config-row">
                <label>
                  名称
                  <input
                    value={m.name}
                    maxLength={200}
                    onChange={(e) =>
                      editTeam({
                        ...team,
                        members: team.members.map((x) =>
                          x.id === m.id ? { ...x, name: e.target.value } : x,
                        ),
                      })
                    }
                  />
                </label>
                <IconButton
                  label={`移除${m.name || "成员"}`}
                  disabled={!teamEditable || team.members.length === 1}
                  onClick={() =>
                    editTeam({
                      ...team,
                      members: team.members.filter((x) => x.id !== m.id),
                    })
                  }
                >
                  <Trash2 size={16} />
                </IconButton>
              </div>
              <label>
                职责与约束
                <textarea
                  rows={3}
                  value={m.instruction}
                  maxLength={8000}
                  onChange={(e) =>
                    editTeam({
                      ...team,
                      members: team.members.map((x) =>
                        x.id === m.id
                          ? { ...x, instruction: e.target.value }
                          : x,
                      ),
                    })
                  }
                />
              </label>
              <details>
                <summary>
                  成员可用方法 · {m.skillKeys?.length ?? 0} 个额外版本
                </summary>
                <SkillChooser
                  data={data}
                  member
                  limit={8}
                  selected={m.skillKeys ?? []}
                  onChange={(skillKeys) =>
                    editTeam({
                      ...team,
                      members: team.members.map((x) =>
                        x.id === m.id ? { ...x, skillKeys } : x,
                      ),
                    })
                  }
                />
              </details>
              <details>
                <summary>成员可用工具 · {m.toolKeys?.length ?? 0}</summary>
                <p className="muted">
                  运行权限为三者交集：成员勾选的工具、流程/运行授权，以及宿主工作台规则（如直接办理与待确认）。职责说明本身不授予工具。
                </p>
                {toolCatalog.map((tool) => (
                  <label key={tool.key}>
                    <input
                      type="checkbox"
                      disabled={!teamEditable}
                      checked={m.toolKeys?.includes(tool.key) ?? false}
                      onChange={(e) =>
                        editTeam({
                          ...team,
                          members: team.members.map((x) =>
                            x.id === m.id
                              ? {
                                  ...x,
                                  toolKeys: e.target.checked
                                    ? [...(x.toolKeys ?? []), tool.key]
                                    : (x.toolKeys ?? []).filter(
                                        (k) => k !== tool.key,
                                      ),
                                }
                              : x,
                          ),
                        })
                      }
                    />
                    {tool.name} · v1
                    <small>{tool.description}</small>
                  </label>
                ))}
              </details>
            </fieldset>
          ))}
          <fieldset className="form-section">
            <legend>从固定模板添加</legend>
            <p className="settings-note">
              模板只写入职责与出处元数据；技能和工具默认为空，需按既有机制授予。保存/应用流程与手动成员相同，不会自动改默认团队。
            </p>
            <label>
              成员模板
              <select
                aria-label="成员模板"
                disabled={!teamEditable}
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
              >
                {memberTemplates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            {templatePreview ? (
              <>
                <p className="settings-note">{templatePreview.summary}</p>
                <details>
                  <summary>预览职责与约束</summary>
                  <pre className="template-preview">{templatePreview.instruction}</pre>
                </details>
                <p className="muted">
                  {memberTemplateLicenseText()}
                  {templatePreview ? (
                    <>
                      {" "}
                      <a
                        href={MEMBER_TEMPLATE_SOURCE_URL(
                          templatePreview.provenance.source.path,
                        )}
                        target="_blank"
                        rel="noreferrer"
                      >
                        查看上游角色来源
                      </a>
                    </>
                  ) : null}
                </p>
                <button
                  type="button"
                  className="quiet"
                  disabled={licenseBusy}
                  onClick={async () => {
                    if (license) { setLicense(""); return; }
                    setLicenseBusy(true);
                    try {
                      const text = await command({ type: "read-member-template-license" });
                      if (typeof text !== "string" || !text) throw Error("许可文件不可用");
                      setLicense(text);
                    } catch (e) {
                      setError(e instanceof Error ? e.message : "许可读取失败");
                    } finally { setLicenseBusy(false); }
                  }}
                >
                  {licenseBusy ? "正在读取许可…" : license ? "收起 MIT 许可" : "查看完整 MIT 许可"}
                </button>
                {license ? <pre className="template-preview" aria-label="MIT 许可正文">{license}</pre> : null}
              </>
            ) : null}
            <button
              type="button"
              disabled={!teamEditable || !templateId || team.members.length >= 12}
              onClick={() => {
                try {
                  const member = instantiateMemberTemplate(
                    templateId,
                    team.members,
                  );
                  editTeam({ ...team, members: [...team.members, member] });
                  setNotice(`已把「${member.name}」加入搭配草稿，请保存后应用。`);
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              <Plus size={16} />
              从模板加入草稿
            </button>
          </fieldset>
          <div className="dialog-actions">
            <button
              disabled={!teamEditable || team.members.length >= 12}
              onClick={() =>
                editTeam({
                  ...team,
                  members: [
                    ...team.members,
                    {
                      id: "member-" + crypto.randomUUID(),
                      name: "新成员",
                      instruction: "",
                    },
                  ],
                })
              }
            >
              <Plus size={16} />
              添加空白成员
            </button>
            <button
              disabled={!dirty.team || busy}
              onClick={() => {
                setTeam(
                  structuredClone(
                    teams.find((t) => versionKey(t) === versionKey(team))!,
                  ),
                );
                setDirty((d) => ({ ...d, team: false }));
              }}
            >
              撤销未保存修改
            </button>
            <button
              disabled={!dirty.team || busy}
              onClick={() => void save("team")}
            >
              保存搭配新版本
            </button>
          </div>
        </section>
      ) : null}
      {tab === "flow" ? (
        <section>
          <fieldset className="form-section">
            <legend>流程信息</legend>
            <label>
              流程版本
              <select
                aria-label="流程版本"
                disabled={dirty.flow || busy}
                value={versionKey(flow)}
                onChange={(e) =>
                  setFlow(
                    structuredClone(
                      flows.find((f) => versionKey(f) === e.target.value)!,
                    ),
                  )
                }
              >
                {flows.map((f) => (
                  <option key={versionKey(f)} value={versionKey(f)}>
                    {f.name} · v{f.version}
                  </option>
                ))}
              </select>
            </label>
            <label>
              执行策略
              <select
                aria-label="执行策略"
                disabled={!flowEditable}
                value={
                  flow.executionStrategy ??
                  (flow.delegation ? "adaptive-delegation" : "fixed-stages")
                }
                onChange={(e) => {
                  const strategy = e.target.value as
                    | "fixed-stages"
                    | "adaptive-delegation";
                  if (strategy === "adaptive-delegation") {
                    editFlow({
                      ...flow,
                      executionStrategy: strategy,
                      delegation: flow.delegation ?? {
                        maxTasks: 4,
                        maxDepth: 2,
                      },
                    });
                  } else {
                    const { delegation: _, ...rest } = flow;
                    editFlow({ ...rest, executionStrategy: strategy });
                  }
                }}
              >
                <option value="fixed-stages">固定步骤顺序</option>
                <option value="adaptive-delegation">负责人按需委派</option>
              </select>
            </label>
            {flow.delegation ||
            flow.executionStrategy === "adaptive-delegation" ? (
              <div className="outcome-fields">
                <label>
                  每轮最多子任务
                  <input
                    type="number"
                    min={1}
                    max={8}
                    value={flow.delegation?.maxTasks ?? 4}
                    disabled={!flowEditable}
                    onChange={(e) =>
                      editFlow({
                        ...flow,
                        delegation: {
                          ...flow.delegation!,
                          maxTasks: Number(e.target.value),
                        },
                      })
                    }
                  />
                </label>
                <label>
                  最多委派层级
                  <input
                    type="number"
                    min={1}
                    max={3}
                    value={flow.delegation?.maxDepth ?? 2}
                    disabled={!flowEditable}
                    onChange={(e) =>
                      editFlow({
                        ...flow,
                        delegation: {
                          ...flow.delegation!,
                          maxDepth: Number(e.target.value),
                        },
                      })
                    }
                  />
                </label>
              </div>
            ) : null}
            <p className="settings-note">
              {flow.delegation
                ? "负责人可从当前搭配选择成员处理限定任务，返回后继续判断。委派会产生额外模型调用，隐藏过程不停止执行。"
                : "按下列步骤依次处理；成员不会自行增加子任务。"}
            </p>
            {flow.version < latestFlow ? (
              <p className="settings-note">
                正在查看历史流程。选择最新版本可继续编辑。
              </p>
            ) : null}
            <label>
              流程名称
              <input
                disabled={!flowEditable}
                value={flow.name}
                maxLength={200}
                onChange={(e) => editFlow({ ...flow, name: e.target.value })}
              />
            </label>
            <p className="settings-note">
              {flow.delegation
                ? "步骤定义负责人和交付责任，子任务按实际需要展开。"
                : "按步骤顺序协作，每步读取前面的公开贡献。"}
            </p>
          </fieldset>
          {flow.stages.map((s, i) => (
            <fieldset
              key={i}
              disabled={!flowEditable}
              className="config-member"
            >
              <legend>步骤 {i + 1}</legend>
              <div className="config-row">
                <label>
                  负责成员
                  <select
                    value={s.role}
                    onChange={(e) =>
                      editFlow({
                        ...flow,
                        stages: flow.stages.map((x, n) =>
                          n === i ? { ...x, role: e.target.value } : x,
                        ),
                      })
                    }
                  >
                    {!team.members.some((m) => m.id === s.role) ? (
                      <option value={s.role}>所选搭配缺少此成员</option>
                    ) : null}
                    {team.members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </label>
                <IconButton
                  label={`上移步骤 ${i + 1}`}
                  disabled={!flowEditable || i === 0}
                  onClick={() => {
                    const stages = [...flow.stages];
                    [stages[i - 1], stages[i]] = [stages[i], stages[i - 1]];
                    editFlow({
                      ...flow,
                      stages: stages.map((s, n) => ({
                        ...s,
                        result:
                          n === stages.length - 1 &&
                          flow.stages.some((x) => x.result),
                      })),
                    });
                  }}
                >
                  <ArrowUp size={16} />
                </IconButton>
                <IconButton
                  label={`下移步骤 ${i + 1}`}
                  disabled={!flowEditable || i === flow.stages.length - 1}
                  onClick={() => {
                    const stages = [...flow.stages];
                    [stages[i + 1], stages[i]] = [stages[i], stages[i + 1]];
                    editFlow({
                      ...flow,
                      stages: stages.map((s, n) => ({
                        ...s,
                        result:
                          n === stages.length - 1 &&
                          flow.stages.some((x) => x.result),
                      })),
                    });
                  }}
                >
                  <ArrowDown size={16} />
                </IconButton>
                <IconButton
                  label={`移除步骤 ${i + 1}`}
                  disabled={!flowEditable || flow.stages.length === 1}
                  onClick={() =>
                    editFlow({
                      ...flow,
                      stages: flow.stages
                        .filter((_, n) => n !== i)
                        .map((s, n) => ({
                          ...s,
                          result:
                            n === flow.stages.length - 2 &&
                            flow.stages.some((x) => x.result),
                        })),
                    })
                  }
                >
                  <Trash2 size={16} />
                </IconButton>
              </div>
              <label>
                这一步需要完成什么
                <textarea
                  rows={2}
                  maxLength={8000}
                  value={s.objective}
                  onChange={(e) =>
                    editFlow({
                      ...flow,
                      stages: flow.stages.map((x, n) =>
                        n === i ? { ...x, objective: e.target.value } : x,
                      ),
                    })
                  }
                />
              </label>
            </fieldset>
          ))}
          <label className="inline-choice">
            <input
              type="checkbox"
              checked={flow.stages.at(-1)?.result ?? false}
              disabled={!flowEditable}
              onChange={(e) =>
                editFlow({
                  ...flow,
                  stages: flow.stages.map((s, i) => ({
                    ...s,
                    result: i === flow.stages.length - 1 && e.target.checked,
                  })),
                })
              }
            />
            最后一步形成或修订成果
          </label>
          <div className="dialog-actions">
            <button
              disabled={!flowEditable || flow.stages.length >= 16}
              onClick={() =>
                editFlow({
                  ...flow,
                  stages: [
                    ...flow.stages.map((s) => ({ ...s, result: false })),
                    {
                      role: team.members[0].id,
                      objective: "",
                      result: flow.stages.at(-1)?.result ?? false,
                    },
                  ],
                })
              }
            >
              <Plus size={16} />
              添加步骤
            </button>
            <button
              disabled={!dirty.flow || busy}
              onClick={() => {
                setFlow(
                  structuredClone(
                    flows.find((f) => versionKey(f) === versionKey(flow))!,
                  ),
                );
                setDirty((d) => ({ ...d, flow: false }));
              }}
            >
              撤销未保存修改
            </button>
            <button
              disabled={!dirty.flow || busy}
              onClick={() => void save("flow")}
            >
              保存流程新版本
            </button>
          </div>
        </section>
      ) : null}
      {tab === "history" ? (
        <section>
          {records.length ? (
            records.map((r) => (
              <details key={r.id}>
                <summary>
                  {r.text.slice(0, 48)} ·{" "}
                  {new Date(r.createdAt).toLocaleString()}
                </summary>
                <p>
                  {r.team.name} v{r.team.version} / {r.workflow.name} v
                  {r.workflow.version}
                </p>
                {r.team.members.map((m) => (
                  <p key={m.id}>
                    <strong>{m.name}</strong> · {m.instruction}
                  </p>
                ))}
                <ol>
                  {r.workflow.stages.map((s, i) => (
                    <li key={i}>
                      {r.team.members.find((m) => m.id === s.role)?.name}：
                      {s.objective}
                    </li>
                  ))}
                </ol>
              </details>
            ))
          ) : (
            <p className="empty">
              提交工作后，可以在这里查看当时使用的搭配与流程。
            </p>
          )}
        </section>
      ) : null}
      <footer className="config-footer">
        <p>
          {team.name} v{team.version} / {flow.name} v{flow.version}
        </p>
        {compatibility ? (
          <p role="status" className="error-inline">
            {compatibility}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="error-inline">
            {error}
          </p>
        ) : null}
        {notice ? <p role="status">{notice}</p> : null}
        <button
          className="primary"
          disabled={busy || dirty.team || dirty.flow || !!compatibility}
          onClick={() => void apply()}
        >
          应用组合
        </button>
        <p className="muted">
          「保存搭配/流程新版本」只存档；「应用组合」写入
          {work ? "此工作" : "全局默认"}。有未保存修改时请先保存或撤销。
        </p>
      </footer>
    </div>
  );
}
