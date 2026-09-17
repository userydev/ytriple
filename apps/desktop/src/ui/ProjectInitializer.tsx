import { useEffect, useState } from "react";
import { FolderGit2, RefreshCw, Check } from "lucide-react";
import type { Snapshot, Project } from "../core/types";
import type { InitializationPlan } from "../core/project-initialization";
import { Dialog } from "./Dialog";
import { command } from "./api";
type Form = { versionId: string; slug: string; series: "x" | "y" | "z" };
export function ProjectInitializer({
  data,
  project,
  onClose,
  onSettings,
}: {
  data: Snapshot;
  project: Project;
  onClose: () => void;
  onSettings: () => void;
}) {
  const versions = data.versions.filter(
    (v) =>
      v.author === "team" &&
      (!v.kind || v.kind === "result") &&
      data.works.some((w) => w.id === v.workId && w.projectId === project.id),
  );
  const latest = data.initializations
    .filter((p) => p.input.projectId === project.id)
    .at(-1);
  const [form, setForm] = useState<Form>({
    versionId: versions.at(-1)?.id ?? "",
    slug: "",
    series: "y",
  });
  const [plan, setPlan] = useState<InitializationPlan | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [approved, setApproved] = useState(false),
    [file, setFile] = useState("docs/PRODUCT.md");
  const locked = !!plan && !plan.restored && plan.status !== "preview";
  const fail = (e: unknown) =>
    setError(e instanceof Error ? e.message : String(e));
  useEffect(() => {
    let current = true;
    void Promise.all([
      command<Form | undefined>({
        type: "initialization-form",
        projectId: project.id,
      }),
      latest
        ? command<InitializationPlan>({
            type: "read-initialization",
            planId: latest.id,
          })
        : Promise.resolve(null),
    ])
      .then(([saved, p]) => {
        if (!current) return;
        if (p && p.status !== "preview") {
          setPlan(p);
          setForm(p.input);
        } else {
          if (saved) setForm(saved);
          else if (p)
            setForm({
              versionId: p.input.versionId,
              slug: p.input.slug,
              series: p.input.series,
            });
          if (
            p &&
            (!saved ||
              (saved.slug === p.input.slug &&
                saved.versionId === p.input.versionId &&
                saved.series === p.input.series))
          )
            setPlan(p);
        }
      })
      .catch((e) => {
        if (current) fail(e);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [project.id]);
  function edit(patch: Partial<Form>) {
    const next = { ...form, ...patch };
    setForm(next);
    setPlan(null);
    setApproved(false);
    setError("");
    void command({
      type: "initialization-form",
      projectId: project.id,
      form: next,
    }).catch(fail);
  }
  async function preview() {
    if (busy) return;
    setBusy(true);
    setError("");
    setApproved(false);
    try {
      setPlan(
        await command<InitializationPlan>({
          type: "preview-initialization",
          input: {
            ...form,
            projectId: project.id,
            template: "software-handoff-v1",
          },
        }),
      );
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  async function execute() {
    if (!plan || busy || !approved) return;
    setBusy(true);
    setError("");
    try {
      setPlan(
        await command<InitializationPlan>({
          type: "execute-initialization",
          planId: plan.id,
        }),
      );
    } catch (e) {
      fail(e);
      try {
        setPlan(
          await command<InitializationPlan>({
            type: "read-initialization",
            planId: plan.id,
          }),
        );
      } catch {
        /* Preserve original failure for user. */
      }
    } finally {
      setBusy(false);
      setApproved(false);
    }
  }
  return (
    <Dialog
      title="初始化与开发交接"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      {loading ? (
        <p>读取项目准备情况…</p>
      ) : (
        <>
          <p className="muted">
            软件产品模板 ·
            v1。采用团队成果建立本地项目底座，工程设计和业务开发从这里继续。
          </p>
          <div className="initialization-fields">
            <label>
              产品定义
              <select
                aria-label="初始化采用的产品定义"
                value={form.versionId}
                disabled={busy || locked}
                onChange={(e) => edit({ versionId: e.target.value })}
              >
                <option value="">选择已完成的主成果</option>
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {data.works.find((w) => w.id === v.workId)?.title} · v
                    {v.number}
                  </option>
                ))}
              </select>
            </label>
            <label>
              稳定项目 ID
              <input
                aria-label="稳定项目 ID"
                value={form.slug}
                placeholder="例如 reading-notes"
                maxLength={48}
                disabled={busy || locked}
                onChange={(e) => edit({ slug: e.target.value })}
              />
            </label>
            <label>
              产品系列
              <select
                aria-label="初始化产品系列"
                value={form.series}
                disabled={busy || locked}
                onChange={(e) =>
                  edit({ series: e.target.value as Form["series"] })
                }
              >
                <option value="x">x · 探索</option>
                <option value="y">y · 计划开源</option>
                <option value="z">z · 面向用户的闭源产品</option>
              </select>
            </label>
          </div>
          {error ? (
            <>
              <p role="alert">{error}</p>
              {/本机|体系|规则漂移|根路径|系列尚未/.test(error) ? (
                <button className="quiet" disabled={busy} onClick={onSettings}>
                  检查本机目录与规则
                </button>
              ) : null}
            </>
          ) : null}
          {!locked ? (
            <button
              className="quiet"
              disabled={busy || !form.versionId || !form.slug}
              onClick={() => void preview()}
            >
              <RefreshCw size={16} />
              预览初始化
            </button>
          ) : null}
          {plan ? (
            <>
              <p className="local-path">{plan.container}</p>
              <details>
                <summary>本机规则与写入位置</summary>
                <pre className="suggestion-preview">{plan.policy}</pre>
                <p>main：{plan.main}</p>
                <p>dev：{plan.dev}</p>
                <p>中央登记：{plan.manifestPath}</p>
                <pre className="suggestion-preview">{plan.manifest}</pre>
              </details>
              <label>
                交接文件
                <select
                  aria-label="预览交接文件"
                  value={file}
                  onChange={(e) => setFile(e.target.value)}
                >
                  {Object.keys(plan.files).map((name) => (
                    <option key={name}>{name}</option>
                  ))}
                </select>
              </label>
              <pre className="suggestion-preview">{plan.files[file]}</pre>
              {plan.restored ? (
                <p role="status">
                  这是备份中的初始化记录，未重新核验本机文件。已有项目请检查关联目录；尚未创建的项目需重新生成预览。
                </p>
              ) : plan.status === "complete" ? (
                <>
                  <p role="status">
                    <Check size={16} />
                    本地项目底座与交接材料已就绪。
                  </p>
                  <p className="local-path">开发目录：{plan.dev}</p>
                  <p className="muted">
                    尚未创建远端仓库、实现业务或执行应用测试。可从项目页打开目录交给开发工具接续。
                  </p>
                </>
              ) : (
                <>
                  {plan.status === "failed" || plan.status === "running" ? (
                    <p role="status">
                      原初始化停在：{plan.step}。{plan.error}{" "}
                      继续前会核对现有文件，不覆盖外部修改。
                    </p>
                  ) : null}
                  <label className="initialization-approval">
                    <input
                      type="checkbox"
                      checked={approved}
                      disabled={busy}
                      onChange={(e) => setApproved(e.target.checked)}
                    />
                    采用此版本和上述文件，确认创建本地初始提交、main/dev
                    工作树及中央登记。
                  </label>
                  <button
                    disabled={busy || !approved}
                    onClick={() => void execute()}
                  >
                    <FolderGit2 size={17} />
                    {busy
                      ? "正在创建并核对…"
                      : locked
                        ? "检查并继续原初始化"
                        : "创建本地项目"}
                  </button>
                </>
              )}
            </>
          ) : null}
          {!versions.length ? (
            <p>先与团队形成产品定义，再从已完成的主成果初始化。</p>
          ) : null}
        </>
      )}
    </Dialog>
  );
}
