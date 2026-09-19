import { createHash } from "node:crypto";
import { checkCompatibility, versionKey, workflowSchema } from "./configuration";
import {
  parseWorkflowCandidateAnswer,
  type WorkflowCandidateBody,
} from "./workflow-learning-contract";
import { publicAnswer } from "./team-response";
import type { Store } from "./store";
import type {
  ArtifactVersion,
  Contribution,
  Draft,
  Run,
  Team,
  Workflow,
  WorkflowCandidate,
  Work,
} from "./types";
import { outputLabels } from "./output";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function normalizeStages(body: WorkflowCandidateBody) {
  return JSON.stringify({
    executionStrategy: body.executionStrategy ?? "fixed-stages",
    delegation: body.delegation ?? null,
    stages: body.stages,
  });
}

export function workflowCandidateFingerprint(body: WorkflowCandidateBody) {
  return hash(normalizeStages(body));
}

export class WorkflowLearning {
  constructor(readonly store: Store) {}

  private sourceVersion(versionId: string) {
    const version = this.store.require<ArtifactVersion>("version", versionId);
    if (version.kind !== "review" && version.kind !== "method")
      throw Error("只能基于已完成的工作复盘或方法草案提炼流程");
    if (!version.runId) throw Error("缺少形成该支持成果的运行记录");
    const run = this.store.require<Run>("run", version.runId);
    if (run.status !== "succeeded" || run.workId !== version.workId)
      throw Error("支持成果尚无成功完成的运行");
    const processRefs = run.refs.filter((ref) => {
      const m = this.store.material(ref);
      const source = m.processSource;
      return (
        source?.workId === version.workId &&
        (source.mode === "review" || source.mode === "method")
      );
    });
    if (!processRefs.length)
      throw Error("缺少冻结的过程来源，请从带过程快照的复盘/方法重新整理");
    return { version, run, processRefs };
  }

  prepare(sourceVersionId: string) {
    return this.store.transaction(() => {
      const { version, run, processRefs } = this.sourceVersion(sourceVersionId);
      const work = this.store.require<Work>("work", version.workId);
      const body = [
        `# 流程候选材料\n工作：${work.title}\n支持成果：${outputLabels[version.kind!]} v${version.number}\n版本编号：${version.id}\n形成运行：${run.id}\n团队：${run.team.name} v${run.team.version}\n原流程：${run.workflow.name} v${run.workflow.version}`,
        "## 支持成果正文\n" + version.body,
        "## 冻结过程依据\n" +
          processRefs
            .map((r, i) => {
              const m = this.store.material(r);
              return `### 依据 ${i + 1} · ${m.title}\n${r.excerpt ?? m.body}`;
            })
            .join("\n\n"),
        "## 任务边界\n提炼新的流程标识（不得使用已存在的其他流程 id），步骤映射现有成员，不得扩大工具或材料访问。",
      ].join("\n\n");
      if (Buffer.byteLength(body) > 24000)
        throw Error("材料过长，请缩小复盘/方法范围后重试");
      const digest = hash(body);
      const materialId = `workflow-candidate:v1:${digest}`;
      const material = {
        id: materialId,
        version: 1,
        title: `流程候选 · ${versionLabel(version)}`,
        body,
        coverage: "workflow_candidate_snapshot",
        createdAt: new Date().toISOString(),
        processSource: {
          workId: work.id,
          runIds: [run.id],
          contributionIds: [],
          versionIds: [version.id],
          capturedAt: new Date().toISOString(),
          mode: version.kind!,
        },
      };
      const instruction = "请依据这份复盘提炼可执行的协作流程，说明步骤、适用条件和待验证事项。先生成候选供我查看，不要自动应用。";
      const draft = this.store.get<Draft>("draft", work.id);
      let refs = [...(draft?.refs ?? [])].filter(
        (r) =>
          r.materialId !== draft?.preparedProcess?.materialId &&
          r.materialId !== draft?.preparedWorkflow?.materialId,
      );
      if (!refs.some((r) => r.materialId === materialId && r.version === 1))
        refs.push({ materialId, version: 1, label: material.title });
      if (refs.length > 20) throw Error("草稿引用已达上限，请先精简");
      let existingText = draft?.text ?? "";
      for (const old of [
        draft?.preparedProcess?.instruction,
        draft?.preparedWorkflow?.instruction,
      ]) {
        if (!old) continue;
        const paragraphs = existingText.split("\n\n");
        const position = paragraphs.lastIndexOf(old);
        if (position >= 0) {
          paragraphs.splice(position, 1);
          existingText = paragraphs.join("\n\n");
        }
      }
      const added = !existingText.includes(instruction);
      const text = added
        ? [existingText, instruction].filter(Boolean).join("\n\n")
        : existingText;
      if (Buffer.byteLength(text) > 16000)
        throw Error("草稿过长，请先精简后再提炼流程");
      if (!this.store.get("material", `${materialId}@1`))
        this.store.put("material", `${materialId}@1`, material);
      return this.store.saveDraft({
        id: work.id,
        text,
        refs,
        recipient: draft?.recipient ?? null,
        projectId: work.projectId,
        outputMode: "explanation",
        preparedWorkflow: {
          sourceVersionId: version.id,
          materialId,
          instruction,
          added,
        },
      });
    });
  }

  tryCaptureFromRun(runId: string) {
    const run = this.store.get<Run>("run", runId);
    if (!run?.workflowCandidateSource) return;
    try {
      this.captureFromRun(runId);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const id = `${run.workflowCandidateSource}:${runId}`;
      const existing = this.store.get<WorkflowCandidate>(
        "workflow-candidate",
        id,
      );
      if (existing) return;
      this.store.put("workflow-candidate", id, {
        id,
        sourceVersionId: run.workflowCandidateSource,
        sourceWorkId: run.workId,
        runId,
        fingerprint: "",
        preview: {
          name: "解析失败",
          applicability: "",
          unverified: [],
          sourceNotes: "",
          stages: [],
        },
        targetWorkflowId: "",
        status: "draft",
        parseError: message,
        createdAt: new Date().toISOString(),
      });
    } finally {
      const candidate = this.store.get<WorkflowCandidate>("workflow-candidate", `${run.workflowCandidateSource}:${runId}`);
      const reply = this.store.get<import("./types").Message>("message", `${runId}:reply`);
      if (reply && candidate) this.store.put("message", reply.id, { ...reply, body: candidate.parseError ? "流程候选未能通过校验，请在来源复盘中查看原因；可调整草稿后重新提炼。" : `已提炼「${candidate.preview.name}」。请在来源复盘的流程候选区查看、保存并明确应用；尚未验证效果。` });
    }
  }

  captureFromRun(runId: string) {
    return this.store.transaction(() => {
      const run = this.store.require<Run>("run", runId);
      if (!run.workflowCandidateSource)
        throw Error("本轮不是流程候选提炼任务");
      if (run.status !== "succeeded") throw Error("运行尚未成功完成");
      const id = `${run.workflowCandidateSource}:${runId}`;
      const existing = this.store.get<WorkflowCandidate>(
        "workflow-candidate",
        id,
      );
      if (existing) return existing;
      const contribution = this.store
        .all<Contribution>("contribution")
        .filter((c) => c.runId === runId && c.status === "succeeded")
        .at(-1);
      if (!contribution?.body.trim())
        throw Error("缺少可解析的公开回答");
      const answer = publicAnswer(contribution.body, run);
      const parsed = parseWorkflowCandidateAnswer(answer);
      const team = run.team;
      const workflow: Workflow = workflowSchema.parse({
        id: parsed.targetWorkflowId,
        version: 1,
        name: parsed.name,
        executionStrategy: parsed.executionStrategy,
        delegation: parsed.delegation,
        stages: parsed.stages,
      });
      checkCompatibility(team, workflow);
      const existingFlow = this.store
        .configurationVersions()
        .workflows.find((w) => w.id === parsed.targetWorkflowId);
      if (existingFlow)
        throw Error(
          "目标流程标识已存在，请让 AI 使用全新标识，不能覆盖已有流程",
        );
      const fingerprint = workflowCandidateFingerprint(parsed);
      const record: WorkflowCandidate = {
        id,
        sourceVersionId: run.workflowCandidateSource,
        sourceWorkId: run.workId,
        runId,
        fingerprint,
        preview: {
          name: parsed.name,
          applicability: parsed.applicability,
          unverified: parsed.unverified,
          sourceNotes: parsed.sourceNotes,
          stages: parsed.stages,
          executionStrategy: parsed.executionStrategy,
          delegation: parsed.delegation,
        },
        targetWorkflowId: parsed.targetWorkflowId,
        status: "draft",
        createdAt: new Date().toISOString(),
      };
      return this.store.put("workflow-candidate", id, record);
    });
  }

  save(candidateId: string, teamKey?: string) {
    return this.store.transaction(() => {
      const candidate = this.store.require<WorkflowCandidate>(
        "workflow-candidate",
        candidateId,
      );
      if (candidate.parseError)
        throw Error(`流程候选未能解析：${candidate.parseError}`);
      if (candidate.status === "saved" && candidate.savedWorkflowKey)
        return { workflowKey: candidate.savedWorkflowKey, created: false };
      const team: Team = teamKey
        ? this.store.require("team", teamKey)
        : this.store.get("meta", "team")!;
      const history = this.store
        .configurationVersions()
        .workflows.filter((w) => w.id === candidate.targetWorkflowId);
      const same = history.find(
        (w) =>
          w.learning?.candidateId === candidateId &&
          hash(normalizeStages({
            name: w.name,
            targetWorkflowId: w.id,
            executionStrategy: w.executionStrategy,
            delegation: w.delegation,
            stages: w.stages,
            applicability: w.learning!.applicability,
            unverified: w.learning!.unverified,
            sourceNotes: w.learning!.sourceNotes,
          })) === candidate.fingerprint,
      );
      if (same) {
        const key = versionKey(same);
        this.store.put("workflow-candidate", candidateId, {
          ...candidate,
          status: "saved",
          savedWorkflowKey: key,
        });
        return { workflowKey: key, created: false };
      }
      if (
        history.length &&
        !history.some((w) => w.learning?.candidateId === candidateId)
      )
        throw Error("该流程标识已被其他来源使用，请重新提炼并使用新标识");
      const currentMax = Math.max(...history.map((w) => w.version), 0);
      const workflow: Workflow = workflowSchema.parse({
        id: candidate.targetWorkflowId,
        version: currentMax || 1,
        name: candidate.preview.name,
        executionStrategy: candidate.preview.executionStrategy,
        delegation: candidate.preview.delegation,
        stages: candidate.preview.stages,
        learning: {
          candidateId: candidate.id,
          sourceVersionId: candidate.sourceVersionId,
          applicability: candidate.preview.applicability,
          unverified: candidate.preview.unverified,
          sourceNotes: candidate.preview.sourceNotes,
        },
      });
      checkCompatibility(team, workflow);
      const saved = currentMax
        ? this.store.saveWorkflow(workflow)
        : this.store.put("workflow", versionKey(workflow), workflow);
      const key = versionKey(saved);
      this.store.put("workflow-candidate", candidateId, {
        ...candidate,
        status: "saved",
        savedWorkflowKey: key,
      });
      return { workflowKey: key, created: true };
    });
  }
}

function versionLabel(version: ArtifactVersion) {
  return `${outputLabels[version.kind ?? "result"]} v${version.number}`;
}
