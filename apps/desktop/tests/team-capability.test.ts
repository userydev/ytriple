import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../src/core/store";
import { Runtime } from "../src/core/runtime";
import {
  TEAM_CAPABILITY_ID,
  teamCapabilityBrief,
} from "../src/core/team-capability";
import { formatAuthorizedMaterials } from "../src/core/authorized-materials";
import { WorkspaceActions } from "../src/core/workspace-actions";
import { Radar } from "../src/core/radar";
import { Schedules } from "../src/core/schedules";
import { RadarWatches } from "../src/core/radar-watches";
import {
  adaptiveWorkflow,
  defaultTeam,
  defaultWorkflow,
  workbenchTeam,
  type Run,
  type SubmitInput,
  type Work,
} from "../src/core/types";
import type { Model, Prompt, StreamEvent } from "../src/core/ycore";
import { protocolModel } from "./team-response";

class Script implements Model {
  prompts: Prompt[] = [];
  constructor(private output: (prompt: Prompt, n: number) => string) {}
  async *stream(prompt: Prompt, key: string): AsyncGenerator<StreamEvent> {
    this.prompts.push(prompt);
    yield { type: "run.started", run_id: key };
    yield { type: "text.delta", run_id: key, text: this.output(prompt, this.prompts.length) };
    yield { type: "run.completed", run_id: key };
  }
}

const submit = (more: Partial<SubmitInput> = {}): SubmitInput => ({
  key: randomUUID(),
  context: "new",
  text: more.text ?? "解释当前材料的覆盖，不要声称已读全文",
  refs: [],
  recipient: null,
  projectId: null,
  ...more,
});

test("shared capability brief is the single versioned text and does not list execution tools", () => {
  const brief = teamCapabilityBrief();
  assert.match(brief, new RegExp(TEAM_CAPABILITY_ID));
  assert.match(brief, /产品内的工作团队成员/);
  assert.match(brief, /不是本仓库开发用的 Codex、Grok 或网页 Pro/);
  assert.match(brief, /知道这些不等于本轮有执行权限/);
  assert.doesNotMatch(brief, /builtin\.workspace@1/);
  assert.match(brief, /标题、摘要、节选不是全文/);
  assert.match(brief, /远端后台接续/);
});

test("ordinary and delegated members both receive shared knowledge without extra tool rights", async () => {
  const ordinary = new Store(":memory:");
  ordinary.put("meta", "team", defaultTeam);
  ordinary.put("meta", "workflow", defaultWorkflow);
  const excerpt = ordinary.addMaterial("仅标题来源", "只有标题", "title_only");
  const ordinaryModel = new Script(() => "覆盖不足，不能声称已读全文。");
  const ordinaryRuntime = new Runtime(ordinary, () => protocolModel(ordinaryModel));
  const ordinaryRun = ordinaryRuntime.submit(
    submit({
      refs: [{ materialId: excerpt.id, version: 1, label: excerpt.title }],
    }),
  );
  await ordinaryRuntime.settled(ordinaryRun.workId);
  assert.equal(ordinary.require<Run>("run", ordinaryRun.id).status, "succeeded");
  assert.equal(ordinaryModel.prompts.length, 3);
  for (const prompt of ordinaryModel.prompts) {
    assert.match(prompt.messages[0].content, new RegExp(TEAM_CAPABILITY_ID));
    assert.match(prompt.messages[0].content, /本成员本轮未启用工具/);
    assert.doesNotMatch(prompt.messages[0].content, /builtin\.workspace@1/);
    assert.match(prompt.messages[1].content, /不是全文/);
  }
  ordinary.close();

  const delegated = new Store(":memory:");
  delegated.put("meta", "team", workbenchTeam);
  delegated.put("meta", "workflow", adaptiveWorkflow);
  const source = delegated.addMaterial("节选材料", "来源摘要正文", "summary");
  const delegatedModel = new Script((prompt) => {
    const system = prompt.messages[0].content;
    const user = prompt.messages[1]?.content ?? "";
    if (system.includes("builtin.workspace@1")) {
      if (user.includes("委派记录："))
        return "已吸收核查，覆盖不足，不能声称已读全文。";
      return JSON.stringify({
        ytriple_delegate: {
          memberId: "researcher",
          objective: "核查这份材料的覆盖",
          context: "只处理授权材料",
          references: [1],
        },
      });
    }
    return "核查：当前只有来源摘要，不能声称全文。";
  });
  const delegatedRuntime = new Runtime(delegated, () => protocolModel(delegatedModel));
  const delegatedRun = delegatedRuntime.submit(
    submit({
      text: "根据这份材料说明覆盖，需要时再核查",
      refs: [{ materialId: source.id, version: 1, label: source.title }],
    }),
  );
  await delegatedRuntime.settled(delegatedRun.workId);
  assert.equal(delegated.require<Run>("run", delegatedRun.id).status, "succeeded");
  const owner = delegatedModel.prompts.find((prompt) =>
    prompt.messages[0].content.includes("builtin.workspace@1"),
  );
  const researcherPrompt = delegatedModel.prompts.find(
    (prompt) =>
      prompt.messages[0].content.includes("研究员") &&
      !prompt.messages[0].content.includes("builtin.workspace@1"),
  );
  assert.ok(owner);
  assert.ok(researcherPrompt);
  assert.match(owner!.messages[0].content, new RegExp(TEAM_CAPABILITY_ID));
  assert.match(researcherPrompt!.messages[0].content, new RegExp(TEAM_CAPABILITY_ID));
  assert.match(researcherPrompt!.messages[0].content, /builtin\.material@1/);
  assert.doesNotMatch(researcherPrompt!.messages[0].content, /builtin\.workspace@1/);
  delegated.close();
});

test("title and excerpt coverage cannot be formatted as full-text research", () => {
  const store = new Store(":memory:");
  try {
    const material = store.addMaterial("HN 标题", "Only a title", "title_only");
    store.put("material", `${material.id}@1`, {
      ...material,
      url: "https://news.ycombinator.com/item?id=1",
      feedSource: {
        sourceId: "feed",
        checkId: "check",
        sourceUrl: "https://news.ycombinator.com/rss",
        resolvedUrl: "https://news.ycombinator.com/rss",
        contentHash: "a".repeat(64),
        rawHash: "b".repeat(64),
        publishedAt: "2026-09-18T00:00:00.000Z",
        fetchedAt: "2026-09-18T01:00:00.000Z",
        publisher: "HN",
      },
    });
    const text = formatAuthorizedMaterials(
      [{ materialId: material.id, version: 1, label: material.title }],
      (reference) => store.material(reference),
    );
    assert.match(text, /版本:v1/);
    assert.ok(text.includes(`材料:${material.id}`));
    assert.match(text, /覆盖:title_only/);
    assert.match(text, /https:\/\/news.ycombinator.com\/item\?id=1/);
    assert.match(text, /读取于 2026-09-18T01:00:00.000Z/);
    assert.match(text, /仅标题/);
    assert.match(text, /不是全文/);
    assert.match(text, /不得声称已抓取网站/);
    const numbered = formatAuthorizedMaterials(
      [{ materialId: material.id, version: 1, label: material.title }],
      (reference) => store.material(reference),
      { numbered: true },
    );
    assert.match(numbered, new RegExp(`材料 1：${material.title} / ${material.id} v1 / title_only`));
  } finally {
    store.close();
  }
});

test("inspect reports shared knowledge and subscription limits without granting extra tools", () => {
  const store = new Store(":memory:");
  try {
    const workId = randomUUID(),
      runId = randomUUID();
    store.put<Work>("work", workId, {
      id: workId,
      title: "规划关注",
      projectId: null,
      deliveryId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      archived: false,
      queuePaused: false,
    });
    store.put("meta", "team", workbenchTeam);
    store.put("meta", "workflow", adaptiveWorkflow);
    store.put("meta", "sources", [
      { id: "ars", name: "Ars Technica", status: "ready", last_error: null },
    ]);
    const run: Run = {
      id: runId,
      workId,
      text: "帮我关注人工智能工具变化",
      refs: [],
      recipient: null,
      status: "running",
      error: null,
      createdAt: new Date().toISOString(),
      team: workbenchTeam,
      workflow: adaptiveWorkflow,
      baseVersionId: null,
      submissionKey: randomUUID(),
      serviceScope: "account:test",
      tools: {
        keys: ["builtin.workspace@1", "builtin.material@1", "builtin.calculate@1"],
        maxCalls: 8,
      },
    };
    store.put("run", run.id, run);
    const radar = new Radar(store, () => ({ scope: "account:test" }) as Model);
    const schedules = new Schedules(store, { startQueued() {}, stop() {} }, () => "account:test");
    const actions = new WorkspaceActions(store, {
      radar,
      schedules,
      radarWatches: new RadarWatches(store, radar, () => "account:test"),
      currentScope: () => "account:test",
    });
    const owner = actions.inspect(run, "人工智能", "editor");
    assert.equal(owner.capabilities.knowledgeId, TEAM_CAPABILITY_ID);
    assert.ok(owner.capabilities.executableTools.includes("builtin.workspace@1"));
    assert.equal(owner.subscription.viaChat, false);
    assert.match(owner.subscription.addWhere, /话题详情/);
    assert.equal(owner.publicSources[0].id, "ars");
    assert.match(owner.publicSources[0].coverage, /不是全文/);
    assert.ok(
      owner.capabilities.limitations.some((item) => item.includes("RSS/Atom")),
    );
    assert.ok(!("documents" in owner));
    assert.ok(!("works" in owner));

    const researcher = actions.inspect(run, "人工智能", "researcher");
    assert.equal(researcher.capabilities.knowledgeId, TEAM_CAPABILITY_ID);
    assert.ok(!researcher.capabilities.executableTools.includes("builtin.workspace@1"));
    assert.ok(researcher.capabilities.executableTools.includes("builtin.material@1"));
    assert.equal(store.all("radar-topic").length, 0);
    assert.equal(store.all("feed").length, 0);
  } finally {
    store.close();
  }
});
