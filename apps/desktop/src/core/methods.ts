import { createHash } from "node:crypto";
import type { Store } from "./store";
import type {
  ArtifactVersion,
  Contribution,
  Draft,
  Run,
  Work,
  Project,
} from "./types";
import {
  skillDefinition,
  skillKey,
  type SkillVersion,
  type SkillAdoption,
} from "./skill-contract";
import { Skills } from "./skills";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export class Methods {
  constructor(readonly store: Store) {}
  private register(versionId: string) {
    const version = this.store.require<ArtifactVersion>("version", versionId);
    const run = version.runId
      ? this.store.require<Run>("run", version.runId)
      : null;
    if (
      version.kind !== "method" ||
      version.author !== "team" ||
      !run ||
      run.status !== "succeeded" ||
      run.workId !== version.workId ||
      run.outputMode !== "method"
    )
      throw Error("只能试用已完成团队运行形成的方法草案");
    const work = this.store.require<Work>("work", version.workId);
    const refs = run.refs.filter((ref) => {
      const material = this.store.material(ref);
      return (
        material.processSource?.mode === "method" &&
        material.processSource.workId === work.id
      );
    });
    if (!refs.length)
      throw Error("草案缺少形成方法的过程依据，请从原工作重新整理");
    const scopeBlock = version.body
      .split(/^#{2,3}\s+/m)
      .find((block) => /^[^\n]*(?:适用范围|适用条件)/.test(block));
    const scopeText = scopeBlock?.split("\n").slice(1).join(" ").trim();
    const definition = skillDefinition.parse({
      name: (
        version.body.match(/^#\s+(.+)$/m)?.[1] ?? `${work.title} · 方法草案`
      ).slice(0, 200),
      description: scopeText
        ? `${scopeText.slice(0, 850)}；效果待验证。`
        : `从「${work.title.slice(0, 160)}」整理；适用条件、实例与检验方式见正文，效果待验证。`,
      body: version.body,
      dependencies: [],
    });
    if (Buffer.byteLength(definition.body) > 16000)
      throw Error("方法草案过长，请让 AI 精简为可载入的方法正文");
    const skill: SkillVersion = {
      ...definition,
      id: `method.${version.artifactId}`,
      version: version.number,
      createdAt: version.createdAt,
      source: { kind: "proposal" },
      proposal: {
        workId: work.id,
        workTitle: work.title,
        runId: run.id,
        versionId: version.id,
        versionHash: hash(version.body),
        refs,
      },
    };
    const existing = this.store.get<SkillVersion>("skill", skillKey(skill));
    if (
      existing &&
      (existing.proposal?.versionId !== version.id ||
        existing.proposal?.versionHash !== hash(version.body))
    )
      throw Error("方法来源与已保存版本冲突");
    return existing ?? this.store.put("skill", skillKey(skill), skill);
  }
  prepareTrial(versionId: string, projectId: string | null) {
    return this.store.transaction(() => {
      if (projectId) this.store.require<Project>("project", projectId);
      const method = this.register(versionId),
        key = skillKey(method);
      const context = `new:method:${key}:${projectId ?? "independent"}`;
      const draft = this.store.get<Draft>("draft", context);
      const skillKeys = [...new Set([...(draft?.skillKeys ?? []), key])];
      if (skillKeys.length > 4) throw Error("试用草稿的方法已达上限，请先精简");
      // Check enabled/dependency state without authorizing any other member methods.
      new Skills(this.store).capture(skillKeys, {
        id: "trial",
        version: 1,
        name: "试用",
        members: [],
      });
      return this.store.saveDraft({
        id: context,
        projectId,
        text: draft?.text ?? "",
        refs: draft?.refs ?? [],
        recipient: draft?.recipient ?? null,
        outputMode: draft?.outputMode ?? "result",
        skillKeys,
      });
    });
  }
  adopt(key: string, trialRunId: string, reason: string) {
    return this.store.transaction(() => {
      const method = this.store.require<SkillVersion>("skill", key);
      if (method.source.kind !== "proposal" || !method.proposal)
        throw Error("请选择从工作形成的方法草案");
      const old = this.store.get<SkillAdoption>("skill-adoption", key);
      if (old) return old;
      const run = this.store.require<Run>("run", trialRunId);
      const captured = run.skills?.find((s) => skillKey(s) === key);
      if (
        run.status !== "succeeded" ||
        !captured ||
        captured.body !== method.body ||
        !this.store
          .all<Contribution>("contribution")
          .some(
            (c) =>
              c.runId === run.id &&
              c.status === "succeeded" &&
              c.skills?.some((u) => u.key === key),
          )
      )
        throw Error(
          "需要一轮确实载入此版本并完成的试用记录，生成草案或仅选择目录不算试用",
        );
      if (!reason.trim() || reason.trim().length > 1000)
        throw Error("请简短记录采纳理由和适用限制");
      return this.store.put<SkillAdoption>("skill-adoption", key, {
        key,
        trialRunId,
        reason: reason.trim(),
        acceptedAt: new Date().toISOString(),
      });
    });
  }
}
