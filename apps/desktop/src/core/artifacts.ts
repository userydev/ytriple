import { versionLabel } from "./output";
import { Store } from "./store";
import type {
  ArtifactCandidate,
  ArtifactVersion,
  Draft,
  Material,
  Reference,
  Work,
  Run,
} from "./types";

export class Artifacts {
  constructor(readonly store: Store) {}
  prepareRevision(input: {
    workId: string;
    versionId: string;
    excerpt?: string;
    candidateId?: string;
  }) {
    return this.store.transaction(() => {
      const work = this.store.require<Work>("work", input.workId);
      const version = this.store.require<ArtifactVersion>(
        "version",
        input.versionId,
      );
      if (version.workId !== work.id) throw Error("成果不属于当前工作");
      if (
        input.excerpt !== undefined &&
        (!input.excerpt.trim() || !version.body.includes(input.excerpt))
      )
        throw Error("选段不属于这个成果版本");
      const candidate = input.candidateId
        ? this.store.require<ArtifactCandidate>("candidate", input.candidateId)
        : null;
      if (
        candidate &&
        (candidate.workId !== work.id ||
          candidate.artifactId !== version.artifactId ||
          candidate.status !== "pending")
      )
        throw Error("生成候选不属于当前成果，或已处理");
      if (
        candidate &&
        (input.excerpt ||
          this.store
            .all<ArtifactVersion>("version")
            .filter((v) => v.artifactId === version.artifactId)
            .at(-1)?.id !== version.id)
      )
        throw Error("请使用最新完整版本与生成候选一起整理");
      const draft = this.store.get<Draft>("draft", work.id);
      const refs = [...(draft?.refs ?? [])];
      const attach = (material: Material, excerpt?: string) => {
        this.store.put(
          "material",
          `${material.id}@${material.version}`,
          material,
        );
        const ref: Reference = {
          materialId: material.id,
          version: material.version,
          label: material.title,
          ...(excerpt ? { excerpt } : {}),
        };
        if (
          !refs.some(
            (r) =>
              r.materialId === ref.materialId &&
              r.version === ref.version &&
              r.excerpt === ref.excerpt,
          )
        )
          refs.push(ref);
      };
      attach(
        {
          id: version.artifactId,
          version: version.number,
          title: versionLabel(version),
          body: version.body,
          coverage: "artifact",
          createdAt: version.createdAt,
        },
        input.excerpt,
      );
      if (candidate)
        attach({
          id: `candidate:${candidate.id}`,
          version: 1,
          title: `生成候选 · ${candidate.id.slice(0, 8)}`,
          body: candidate.body,
          coverage: "artifact",
          createdAt: candidate.createdAt,
        });
      if (version.kind === "method" && version.runId) {
        const originRun = this.store.require<Run>("run", version.runId);
        for (const ref of originRun.refs) {
          const material = this.store.material(ref);
          if (material.processSource?.mode === "method")
            attach(material, ref.excerpt);
        }
      }
      if (refs.length > 20) throw Error("引用已达上限，请先移除不需要的引用");
      const instruction = candidate
        ? "请结合所引用的当前成果与生成候选重新整理，保留事实和依据限制；存在分歧时明确说明。"
        : input.excerpt
          ? "请重新整理所引用的成果段落，保留事实和依据限制，其余内容保持原意。"
          : "请重新整理所引用的成果，保留事实和依据限制。";
      const text = draft?.text?.includes(instruction)
        ? draft.text
        : [draft?.text, instruction].filter(Boolean).join("\n\n");
      if (text.length > 64000)
        throw Error("草稿过长，请先精简后再添加整理要求");
      return this.store.saveDraft({
        id: work.id,
        outputMode: version.kind ?? "result",
        text,
        refs,
        recipient: draft?.recipient ?? null,
        projectId: work.projectId,
      });
    });
  }
  dismiss(candidateId: string) {
    const candidate = this.store.require<ArtifactCandidate>(
      "candidate",
      candidateId,
    );
    if (candidate.status === "pending")
      this.store.put("candidate", candidateId, {
        ...candidate,
        status: "dismissed",
      });
  }
}
