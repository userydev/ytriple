import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../src/core/store";
import { Runtime } from "../src/core/runtime";
import { ProcessRecords } from "../src/core/process";
import { WorkflowLearning } from "../src/core/workflow-learning";
import { versionKey } from "../src/core/configuration";
import { defaultWorkflow, type SubmitInput } from "../src/core/types";
import type { Model, Prompt, StreamEvent } from "../src/core/ycore";
import type { Run } from "../src/core/types";
import {
  legacyFinish,
  protocolModel,
  teamResponse,
  boundBaseFromPrompt,
} from "./team-response";

const request = (
  context = "new",
  extra: Partial<SubmitInput> = {},
): SubmitInput => ({
  key: randomUUID(),
  context,
  text: "为虚构活动写复盘",
  refs: [],
  recipient: null,
  projectId: null,
  ...extra,
});

const workflowJson = {
  ytriple_workflow_candidate: {
    name: "研究员直出",
    targetWorkflowId: "learned-direct-test",
    executionStrategy: "fixed-stages",
    stages: [
      {
        role: "researcher",
        objective: "直接依据材料给出成果",
        result: true,
      },
    ],
    applicability: "材料已齐、无需核查时",
    unverified: ["未在真实任务中验证"],
    sourceNotes: "来自复盘 v1",
  },
};

class WorkflowModel implements Model {
  prompts: Prompt[] = [];
  async *stream(prompt: Prompt, key: string): AsyncGenerator<StreamEvent> {
    this.prompts.push(prompt);
    yield { type: "run.started" as const, run_id: key };
    yield {
      type: "text.delta" as const,
      run_id: key,
      text: teamResponse(
        `建议流程：${workflowJson.ytriple_workflow_candidate.name}\n${JSON.stringify(workflowJson)}`,
        null,
      ),
    };
    yield { type: "run.completed" as const, run_id: key };
  }
}

function reviewFixture() {
  const store = new Store(":memory:");
  store.initializeConfiguration();
  const project = store.createProject("虚构", "测流程", "media");
  const run = store.submit(request("new", { projectId: project.id }));
  store.setRun(run.id, { status: "running" });
  store.put("contribution", `${run.id}:0`, {
    id: `${run.id}:0`,
    workId: run.workId,
    runId: run.id,
    memberId: "researcher",
    memberName: "研究员",
    objective: "研究材料",
    body: "过程记录用于复盘",
    status: "succeeded",
    remoteId: null,
    error: null,
    createdAt: new Date().toISOString(),
  });
  legacyFinish(store, run.id, "主成果 v1", true);
  const reviewDraft = new ProcessRecords(store).prepare({
    workId: run.workId,
    mode: "review",
    runId: run.id,
  });
  const reviewRun = store.submit(
    request(reviewDraft.id, {
      text: reviewDraft.text,
      refs: reviewDraft.refs,
      recipient: reviewDraft.recipient,
      projectId: reviewDraft.projectId,
      outputMode: "review",
    }),
  );
  store.setRun(reviewRun.id, { status: "running" });
  const reviewVersion = legacyFinish(
    store,
    reviewRun.id,
    "# 复盘\n差距：未知出席人数。",
    true,
  )!;
  return { store, run, reviewRun, reviewVersion, project };
}

test("workflow candidate is captured from model answer, saved idempotently, and applied workflow changes execution order", async () => {
  const f = reviewFixture();
  try {
    assert.ok(
      f.reviewRun.refs.some((r) => r.materialId.startsWith("process:")),
    );
    const learning = new WorkflowLearning(f.store);
    const draft = learning.prepare(f.reviewVersion.id);
    assert.ok(draft.preparedWorkflow?.sourceVersionId);
    const model = new WorkflowModel();
    const runtime = new Runtime(f.store, () => protocolModel(model));
    const explain = runtime.submit(
      request(draft.id, {
        ...draft,
        context: draft.id,
        outputMode: "explanation",
      }),
    );
    await runtime.settled(explain.workId);
    const candidates = f.store.snapshot().workflowCandidates;
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].preview.stages.length, 1);
    assert.equal(candidates[0].preview.stages[0].role, "researcher");
    const beforeConfig = f.store.require<import("../src/core/types").Work>("work", f.run.workId);
    const first = learning.save(candidates[0].id);
    assert.deepEqual(f.store.require("work", f.run.workId), beforeConfig);
    const second = learning.save(candidates[0].id);
    assert.equal(first.workflowKey, second.workflowKey);
    assert.equal(second.created, false);
    f.store.selectConfiguration(f.run.workId, versionKey(f.run.team), first.workflowKey);
    const scripted = new (class implements Model {
      prompts: Prompt[] = [];
      async *stream(p: Prompt, key: string): AsyncGenerator<StreamEvent> {
        this.prompts.push(p);
        yield { type: "run.started", run_id: key };
        const system = p.messages.find((m) => m.role === "system")?.content ?? "";
        const allowsArtifact = !system.includes("不允许提交 artifact");
        const baseVersionId = boundBaseFromPrompt(p);
        yield {
          type: "text.delta",
          run_id: key,
          text: teamResponse(
            "研究员直出成果",
            allowsArtifact ? { body: "研究员直出成果", baseVersionId } : null,
          ),
        };
        yield { type: "run.completed", run_id: key };
      }
    })();
    const rt2 = new Runtime(f.store, () => protocolModel(scripted));
    const next = rt2.submit(request(f.run.workId, { text: "再写一段" }));
    await rt2.settled(next.workId);
    assert.equal(next.refs.some(ref => f.store.material(ref).coverage === "workflow_candidate_snapshot"), false);
    assert.equal(scripted.prompts.length, 1);
    assert.equal(f.store.require<Run>("run", next.id).status, "succeeded");
    assert.equal(f.store.require<Run>("run", f.run.id).workflow.stages[0].role, f.run.workflow.stages[0].role);
    assert.equal(scripted.prompts[0].taskId.split(":").length >= 2, true);
    assert.equal(
      scripted.prompts[0].messages[0].content.includes("研究员"),
      true,
    );
    assert.equal(
      scripted.prompts[0].messages[0].content.includes("核查员"),
      false,
    );
    assert.notEqual(
      next.workflow.stages.length,
      defaultWorkflow.stages.length,
    );
  } finally {
    f.store.close();
  }
});

test("invalid workflow candidate or incompatible member is rejected without saving", async () => {
  const f = reviewFixture();
  try {
    const learning = new WorkflowLearning(f.store);
    const draft = learning.prepare(f.reviewVersion.id);
    const bad = {
      ytriple_workflow_candidate: {
        ...workflowJson.ytriple_workflow_candidate,
        stages: [
          {
            role: "missing-member",
            objective: "不存在",
            result: true,
          },
        ],
      },
    };
    class BadModel implements Model {
      async *stream(_p: Prompt, key: string): AsyncGenerator<StreamEvent> {
        yield { type: "run.started", run_id: key };
        yield {
          type: "text.delta",
          run_id: key,
          text: teamResponse(JSON.stringify(bad), null),
        };
        yield { type: "run.completed", run_id: key };
      }
    }
    const runtime = new Runtime(f.store, () => protocolModel(new BadModel()));
    const explain = runtime.submit(
      request(draft.id, {
        ...draft,
        context: draft.id,
        outputMode: "explanation",
      }),
    );
    await runtime.settled(explain.workId);
    assert.equal(f.store.require<Run>("run", explain.id).status, "succeeded");
    const candidate = f.store.snapshot().workflowCandidates[0];
    assert.ok(candidate?.parseError);
  } finally {
    f.store.close();
  }
});
