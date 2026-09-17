import { MethodActions } from "./MethodActions";
import { useState } from "react";
import Markdown from "./Markdown";
import {
  Copy,
  Download,
  Upload,
  Pencil,
  RefreshCw,
  Power,
  Plus,
} from "lucide-react";
import type { Snapshot, Draft } from "../core/types";
import {
  skillAvailability,
  skillKey,
  isTrialMethod,
  type SkillVersion,
  type SkillDefinition,
} from "../core/skill-contract";
import type { Command } from "../core/commands";
import { command } from "./api";
import { IconButton } from "./Composer";
import { Dialog } from "./Dialog";
export function SkillLibrary({
  data,
  onError,
  onPrepared,
  onNavigate,
}: {
  data: Snapshot;
  onPrepared: (draft: Draft) => Promise<void>;
  onNavigate: (workId: string, versionId?: string) => void;
  onError: (e: unknown) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null),
    [editing, setEditing] = useState<{
      key?: string;
      definition: SkillDefinition;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const versions = new Map<string, SkillVersion[]>();
  for (const s of data.skills)
    versions.set(s.id, [...(versions.get(s.id) ?? []), s]);
  const current = data.skills.find((s) => skillKey(s) === selected);
  async function act(input: Command) {
    if (busy) return;
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const result = await command<unknown>(input);
      if (
        (input.type === "skill-copy" ||
          input.type === "skill-import" ||
          input.type === "skill-save") &&
        result
      ) {
        setSelected(skillKey(result as SkillVersion));
        if (input.type === "skill-save") setEditing(null);
      }
      if (input.type === "skill-inspect") {
        const status = result as { state: string; message: string };
        setNotice(
          `${({ unchanged: "源文件未变化", changed: "源文件已变化", unavailable: "源文件不可用", snapshot: "已保存快照" } as Record<string, string>)[status.state]}。${status.message}`,
        );
      }
      if (input.type === "skill-export" && result)
        setNotice("已保存到 AI 目录。原版本保留。");
    } catch (e) {
      if (selected || editing)
        setError(e instanceof Error ? e.message : String(e));
      else onError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="skill-library">
      <div className="section-heading">
        <div>
          <h2>方法 · Skills</h2>
          <p className="muted">选择方法进入工作，使用记录留在协作过程。</p>
        </div>
        <div className="toolbar">
          <IconButton
            label="创建方法"
            disabled={busy}
            onClick={() =>
              setEditing({
                definition: {
                  name: "",
                  description: "",
                  body: "",
                  dependencies: [],
                },
              })
            }
          >
            <Plus size={17} />
          </IconButton>
          <IconButton
            label="从 AI 导入方法"
            disabled={busy || !data.localRoots.aiPath}
            onClick={() => void act({ type: "skill-import" })}
          >
            <Upload size={17} />
          </IconButton>
        </div>
      </div>
      {[...versions.values()].map((group) => {
        const s = group.at(-1)!,
          state = skillAvailability(s, data.skillStates);
        return (
          <button
            key={s.id}
            className="skill-row"
            onClick={() => {
              setNotice("");
              setSelected(skillKey(s));
            }}
          >
            <span>
              <strong>{s.name}</strong>
              <span className="skill-description muted">{s.description}</span>
            </span>
            <small>
              v{s.version} ·{" "}
              {state === "ready"
                ? isTrialMethod(s, data.skillAdoptions)
                  ? "可试用 · 未采纳"
                  : s.source.kind === "proposal"
                    ? "已采纳 · 可加载"
                    : "可加载"
                : state === "disabled"
                  ? "已停用"
                  : "缺少依赖"}
            </small>
          </button>
        );
      })}
      {current && !editing ? (
        <Dialog
          title={current.name}
          onClose={() => {
            if (!busy) {
              setSelected(null);
              setError("");
            }
          }}
        >
          <div className="section-heading">
            <label>
              方法版本
              <select
                value={selected!}
                disabled={busy}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setNotice("");
                }}
              >
                {versions.get(current.id)!.map((s) => (
                  <option key={skillKey(s)} value={skillKey(s)}>
                    v{s.version} · {new Date(s.createdAt).toLocaleString()}
                  </option>
                ))}
              </select>
            </label>
            <div className="toolbar">
              <IconButton
                label="复制为独立方法"
                disabled={busy}
                onClick={() => void act({ type: "skill-copy", key: selected! })}
              >
                <Copy size={17} />
              </IconButton>
              {current.source.kind === "copy" ? (
                <IconButton
                  label="编辑方法新版本"
                  disabled={
                    busy ||
                    versions.get(current.id)!.at(-1)!.version !==
                      current.version
                  }
                  onClick={() =>
                    setEditing({
                      key: selected!,
                      definition: {
                        name: current.name,
                        description: current.description,
                        body: current.body,
                        dependencies: [...current.dependencies],
                      },
                    })
                  }
                >
                  <Pencil size={17} />
                </IconButton>
              ) : null}
              <IconButton
                label="检查方法源文件"
                disabled={busy}
                onClick={() =>
                  void act({ type: "skill-inspect", key: selected! })
                }
              >
                <RefreshCw size={17} />
              </IconButton>
              <IconButton
                label="导出方法到 AI"
                disabled={busy || !data.localRoots.aiPath}
                onClick={() =>
                  void act({ type: "skill-export", key: selected! })
                }
              >
                <Download size={17} />
              </IconButton>
              <IconButton
                label={
                  skillAvailability(current, data.skillStates) === "disabled"
                    ? "启用方法"
                    : "停用方法"
                }
                disabled={busy}
                onClick={() =>
                  void act({
                    type: "skill-state",
                    id: current.id,
                    enabled:
                      skillAvailability(current, data.skillStates) ===
                      "disabled",
                  })
                }
              >
                <Power size={17} />
              </IconButton>
            </div>
          </div>
          {current.proposal ? (
            <button
              className="quiet"
              onClick={() =>
                onNavigate(
                  current.proposal!.workId,
                  current.proposal!.versionId,
                )
              }
            >
              查看形成方法的工作 · {current.proposal.workTitle}
            </button>
          ) : null}
          {current.source.kind === "proposal" &&
          data.versions.some((v) => v.id === current.proposal?.versionId) ? (
            <MethodActions
              key={skillKey(current)}
              data={data}
              version={data.versions.find(
                (v) => v.id === current.proposal!.versionId,
              )!}
              onPrepared={onPrepared}
              onNavigate={onNavigate}
            />
          ) : null}
          {current.importedProposal ? (
            <p className="muted">
              导入来源记录：{current.importedProposal.workTitle} · 原成果{" "}
              {current.importedProposal.versionId}
              。这是原空间的来源说明，本机未恢复该工作或验证记录。
            </p>
          ) : null}
          <p>{current.description}</p>
          <p className="muted">
            {current.source.kind === "builtin"
              ? "内置方法"
              : current.source.kind === "local"
                ? "本地导入"
                : current.source.kind === "proposal"
                  ? "从工作整理的方法草案"
                  : "独立副本"}{" "}
            · 效果待验证
          </p>
          {current.source.path ? (
            <p className="local-path">{current.source.path}</p>
          ) : null}
          {current.dependencies.length ? (
            <div role="status">
              <p>缺少依赖，当前不能加载：</p>
              <ul>
                {current.dependencies.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="skill-body">
            <Markdown>{current.body}</Markdown>
          </div>
          <p className="muted">
            新版本和启停用于之后提交的工作；已提交的运行保留当时版本。方法加载不代表脚本已执行或效果已验证。
          </p>
          {notice ? <p role="status">{notice}</p> : null}
          {error ? (
            <p className="error-inline" role="alert">
              {error}
            </p>
          ) : null}
        </Dialog>
      ) : null}
      {editing ? (
        <Dialog
          title={editing.key ? "编辑方法新版本" : "创建方法"}
          onClose={() => {
            if (!busy) {
              setEditing(null);
              setError("");
            }
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act({
                type: "skill-save",
                key: editing.key,
                definition: editing.definition,
              });
            }}
          >
            <label>
              名称
              <input
                required
                maxLength={200}
                value={editing.definition.name}
                disabled={busy}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    definition: { ...editing.definition, name: e.target.value },
                  })
                }
              />
            </label>
            <label>
              适用范围
              <textarea
                required
                maxLength={1000}
                rows={2}
                value={editing.definition.description}
                disabled={busy}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    definition: {
                      ...editing.definition,
                      description: e.target.value,
                    },
                  })
                }
              />
            </label>
            <label>
              方法正文
              <textarea
                required
                maxLength={16000}
                rows={12}
                value={editing.definition.body}
                disabled={busy}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    definition: { ...editing.definition, body: e.target.value },
                  })
                }
              />
            </label>
            {editing.definition.dependencies.length ? (
              <p className="muted">
                此副本仍有未接入的依赖：
                {editing.definition.dependencies.join("；")}
                。创建不依赖外部资源的独立方法后才能加载。
              </p>
            ) : null}
            {error ? (
              <p className="error-inline" role="alert">
                {error}
              </p>
            ) : null}
            <div className="dialog-actions">
              <button type="submit" disabled={busy}>
                保存方法版本
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}
    </section>
  );
}
