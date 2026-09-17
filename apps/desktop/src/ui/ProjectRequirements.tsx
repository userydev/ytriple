import Markdown from "./Markdown";
import type {
  ProjectContext,
  ProjectStandard,
  ArtifactVersion,
} from "../core/types";
export function StandardSource({
  standard,
  versions,
}: {
  standard: ProjectStandard;
  versions: ArtifactVersion[];
}) {
  if (!standard.source) return <small>用户在项目内直接确认的要求</small>;
  const version = versions.find((v) => v.id === standard.source!.versionId);
  return (
    <details>
      <summary>
        {version
          ? `来源成果 v${version.number}${standard.source.excerpt ? " · 选段" : " · 整版"}`
          : "来源成果暂不在本机"}
      </summary>
      {version ? (
        <Markdown>{standard.source.excerpt ?? version.body}</Markdown>
      ) : (
        <p>保留来源关联，尚不能读取原文。</p>
      )}
    </details>
  );
}
export function ProjectRequirements({
  context,
  versions,
}: {
  context: ProjectContext;
  versions: ArtifactVersion[];
}) {
  return (
    <div className="project-requirements">
      <p className="muted">
        {context.projectName} · 目标 v{context.briefRevision || "初始"}
      </p>
      <p>{context.goal || "尚未说明持续目标"}</p>
      {context.standards.map((s) => (
        <article key={`${s.id}@${s.revision}`}>
          <h4>
            {s.title}{" "}
            <small>
              v{s.revision} · {s.deliveryId ? "当前交付" : "本项目"}
            </small>
          </h4>
          <Markdown>{s.body}</Markdown>
          <StandardSource standard={s} versions={versions} />
        </article>
      ))}
      {!context.standards.length ? (
        <p className="muted">尚无已采纳的适用标准</p>
      ) : null}
      {context.materials.map(({ reference: r, material: m }) => (
        <details key={`${r.materialId}@${r.version}:${r.excerpt ?? ""}`}>
          <summary>
            {m.title} · v{r.version}
            {r.excerpt ? " · 选段" : ""}
          </summary>
          <p className="muted">
            读取范围：
            {(
              {
                local_text: "本地文本",
                artifact: "成果正文",
                summary: "摘要",
                feed_content: "来源节选",
                feed_excerpt: "来源节选",
                link_only: "仅链接",
              } as Record<string, string>
            )[m.coverage] ?? "所提供的材料"}
            。仅采用这里列出的资料，不代表已读取整个项目。
          </p>
          <Markdown>{r.excerpt ?? m.body}</Markdown>
        </details>
      ))}
    </div>
  );
}
