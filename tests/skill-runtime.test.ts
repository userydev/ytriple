import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ModelRequest } from "@openai/agents";
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponder,
  modelStreamResponder,
} from "@openai/agents/testing";
import type { MemberId, ModelProfile, Task } from "../src/shared/types.js";
import {
  BUILTIN_SKILLS,
  skillHash,
  skillDefinitionHash,
} from "../src/core/skills.js";
import {
  TeamRuntime,
  type RuntimeCheckpoint,
  type RuntimeHooks,
} from "../src/core/runtime.js";

function fixture(mode: "auto" | "explicit" | "off" = "auto") {
  const skill = structuredClone(BUILTIN_SKILLS[0]!);
  const task: Task = {
    id: "skill-task",
    title: "方法合成验收",
    goal: "读取资料并保存说明。",
    goalVersion: 1,
    kind: "research",
    member: "coordinator",
    workspace: "/unused",
    status: "idle",
    createdAt: "",
    updatedAt: "",
    messages: [],
    events: [],
    artifacts: [],
    sources: [
      {
        id: "source-1",
        title: "合成证据",
        type: "text",
        location: "",
        text: "ORCHID 42",
        addedAt: "",
        coverage: "全文",
      },
    ],
    skillPolicy: { mode, skillIds: mode === "explicit" ? [skill.id] : [] },
    skillBindings: [skill],
  };
  const profile: ModelProfile = {
    id: "synthetic",
    name: "synthetic",
    provider: "compatible",
    protocol: "openai",
    baseURL: "https://example.test/v1",
    modelId: "synthetic",
    apiKeyEnv: "TEST_KEY",
    hasKey: true,
    status: "ready",
    capabilities: { text: true, tools: true, streaming: true },
  };
  let checkpoint: RuntimeCheckpoint | undefined;
  const hooks: RuntimeHooks = {
    getTask: () => task,
    getProfile: () => profile,
    readKey: () => "synthetic-key",
    appendEvent: (_id, event) =>
      task.events.push({ ...event, id: randomUUID(), createdAt: "" }),
    addAssistantMessage: (_id, member, content, goalVersion) =>
      task.messages.push({
        id: randomUUID(),
        member,
        content,
        goalVersion,
        role: "assistant",
        createdAt: "",
      }),
    writeArtifact: async (_id, input) => {
      const artifact = {
        id: randomUUID(),
        title: input.title,
        content: input.content,
        format: input.format,
        path: "/unused/report.md",
        goalVersion: input.goalVersion,
        hash: skillHash(input.content),
        version: 1,
        updatedAt: "",
        versions: [],
      };
      task.artifacts.push(artifact);
      return artifact;
    },
    loadCheckpoint: () => checkpoint,
    saveCheckpoint: (_id, value) => {
      checkpoint = value ? structuredClone(value) : undefined;
    },
    setStatus: (_id, status, error) => {
      task.status = status;
      task.error = error;
    },
  };
  return { task, skill, profile, hooks, checkpoint: () => checkpoint };
}

function result(
  request: ModelRequest,
  callId: string,
): Record<string, unknown> {
  assert.ok(Array.isArray(request.input));
  const item = request.input.find(
    (entry) => entry.type === "function_call_result" && entry.callId === callId,
  );
  assert.ok(item?.type === "function_call_result");
  const output = item.output;
  if (typeof output === "string") return JSON.parse(output);
  assert.ok(!Array.isArray(output));
  assert.equal(output.type, "text");
  assert.ok("text" in output);
  return JSON.parse(output.text);
}

const draft = {
  title: "合成说明",
  content: "# 结论\nORCHID 42（source-1 全文）",
  format: "md",
  artifactId: null,
  expectedHash: null,
};

test("SDK auto loads the exact bound method before reading evidence and saving an artifact", async () => {
  const f = fixture();
  const model = new ScriptedModel([
    modelResponder(({ request }) => {
      assert.ok(request.systemInstructions?.includes(f.skill.description));
      assert.ok(!request.systemInstructions?.includes(f.skill.instructions));
      assert.equal(
        f.task.events.filter((event) => event.type === "skill_loaded").length,
        0,
      );
      assert.ok(request.tools.some((tool) => tool.name === "load_skill"));
      return [
        functionCall(
          "load_skill",
          { skillId: f.skill.id, sourceIds: ["source-1"], artifactIds: [] },
          { callId: "method" },
        ),
      ];
    }),
    modelResponder(({ request }) => {
      const loaded = result(request, "method");
      assert.equal(loaded.instructions, f.skill.instructions);
      assert.equal(loaded.hash, skillHash(String(loaded.instructions)));
      assert.equal(loaded.version, "1.0.0");
      return [
        functionCall(
          "read_source",
          { sourceId: "source-1", start: 0, maxCharacters: 1000 },
          { callId: "read" },
        ),
      ];
    }),
    modelResponder(({ request }) => {
      assert.match(JSON.stringify(result(request, "read")), /ORCHID 42/);
      return [functionCall("write_artifact", draft, { callId: "write" })];
    }),
    modelResponder(({ request }) => {
      assert.equal(result(request, "write").id, f.task.artifacts[0]?.id);
      return [assistantMessage("说明已保存，证据为 source-1 全文。")];
    }),
  ]);
  await new TeamRuntime(f.hooks, { modelFactory: () => model }).run(f.task.id);
  assert.equal(f.task.status, "completed", f.task.error);
  assert.equal(f.task.artifacts.length, 1);
  const loaded = f.task.events.filter((event) => event.type === "skill_loaded");
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]?.member, "coordinator");
  assert.equal(loaded[0]?.data?.skillId, f.skill.id);
  assert.equal(loaded[0]?.data?.hash, f.skill.hash);
  assert.equal(loaded[0]?.data?.selection, "model");
  assert.equal(loaded[0]?.data?.delivery, "tool_result");
  assert.equal(loaded[0]?.data?.scope, "coordinator");
  assert.deepEqual(loaded[0]?.data?.sourceIds, ["source-1"]);
  assert.deepEqual(loaded[0]?.data?.artifactIds, []);
  assert.ok(
    f.task.events.some(
      (event) =>
        event.type === "tool_completed" && event.data?.tool === "load_skill",
    ),
  );
});

test("load_skill rejects unbound methods and nonexistent material scopes without recording a load", async () => {
  const f = fixture();
  const model = new ScriptedModel([
    [
      functionCall(
        "load_skill",
        { skillId: "handoff-review" },
        { callId: "unbound" },
      ),
    ],
    modelResponder(({ request }) => {
      assert.match(String(result(request, "unbound").error), /不在本轮允许/);
      return [
        functionCall(
          "load_skill",
          { skillId: f.skill.id, sourceIds: ["external-source"] },
          { callId: "outside" },
        ),
      ];
    }),
    modelResponder(({ request }) => {
      assert.match(String(result(request, "outside").error), /不存在/);
      return [assistantMessage("方法或范围未获本轮提供，未加载。")];
    }),
  ]);
  await new TeamRuntime(f.hooks, { modelFactory: () => model }).run(f.task.id);
  assert.equal(f.task.status, "completed", f.task.error);
  assert.equal(
    f.task.events.filter((event) => event.type === "skill_loaded").length,
    0,
  );
  assert.equal(
    f.task.events.filter(
      (event) =>
        event.type === "tool_failed" && event.data?.tool === "load_skill",
    ).length,
    2,
  );
});

test("explicit methods reach only actual root requests; an invoked child can load on demand and unused agents never load", async () => {
  const f = fixture("explicit");
  const coordinator = new ScriptedModel([
    modelResponder(({ request }) => {
      assert.ok(request.systemInstructions?.includes(f.skill.instructions));
      assert.equal(
        f.task.events.filter((event) => event.type === "skill_loaded").length,
        1,
      );
      return [
        functionCall(
          "consult_researcher",
          { input: "按需加载资料整理方法并返回核查缺口。" },
          { callId: "delegate" },
        ),
      ];
    }),
    [assistantMessage("已经汇总研究员的核查缺口。")],
  ]);
  const researcher = new ScriptedModel([
    modelResponder(({ request }) => {
      assert.ok(!request.systemInstructions?.includes(f.skill.instructions));
      assert.equal(
        f.task.events.filter((event) => event.type === "skill_loaded").length,
        1,
      );
      return [
        functionCall(
          "load_skill",
          { skillId: f.skill.id },
          { callId: "child-method" },
        ),
      ];
    }),
    modelResponder(({ request }) => {
      assert.equal(
        result(request, "child-method").instructions,
        f.skill.instructions,
      );
      return [assistantMessage("已加载方法；还需读取原文核查。")];
    }),
  ]);
  const invoked: MemberId[] = [];
  await new TeamRuntime(f.hooks, {
    modelFactory: (_profile, _key, member) => {
      invoked.push(member);
      return member === "researcher" ? researcher : coordinator;
    },
  }).run(f.task.id);
  assert.equal(f.task.status, "completed", f.task.error);
  assert.deepEqual(invoked, ["coordinator", "researcher"]);
  const loads = f.task.events.filter((event) => event.type === "skill_loaded");
  assert.equal(loads.length, 2);
  assert.equal(loads[0]?.data?.delivery, "model_input");
  assert.equal(loads[0]?.data?.selection, "user");
  assert.equal(loads[1]?.data?.delivery, "tool_result");
  assert.equal(loads[1]?.data?.scope, "coordinator/researcher");
  assert.equal(
    loads.some((event) => event.member === "cto"),
    false,
  );
});

test("off exposes neither skill bodies, metadata nor the load tool even with stale bindings", async () => {
  const f = fixture("off");
  const model = new ScriptedModel([
    modelResponder(({ request }) => {
      assert.ok(!request.systemInstructions?.includes(f.skill.id));
      assert.ok(!request.systemInstructions?.includes(f.skill.instructions));
      assert.ok(!request.tools.some((tool) => tool.name === "load_skill"));
      return [assistantMessage("按当前任务继续。")];
    }),
  ]);
  await new TeamRuntime(f.hooks, { modelFactory: () => model }).run(f.task.id);
  assert.equal(f.task.status, "completed", f.task.error);
  assert.equal(
    f.task.events.filter((event) => event.type === "skill_loaded").length,
    0,
  );
});

for (const mode of ["auto", "explicit"] as const)
  test(`hosted Google ${mode} records only supported method delivery and retains the research run`, async () => {
    const f = fixture(mode);
    Object.assign(f.profile, {
      provider: "gemini",
      protocol: "google",
      execution: "google-agent",
      capabilities: { text: true, tools: false, streaming: true },
    });
    const model = new ScriptedModel([
      modelResponder(({ request }) => {
        assert.deepEqual(request.tools, []);
        assert.equal(
          request.systemInstructions?.includes(f.skill.instructions),
          mode === "explicit",
        );
        return [assistantMessage("本轮资料说明。")];
      }),
    ]);
    await new TeamRuntime(f.hooks, { googleAgentFactory: () => model }).run(
      f.task.id,
    );
    assert.equal(f.task.status, "completed", f.task.error);
    const loaded = f.task.events.filter(
      (event) => event.type === "skill_loaded",
    );
    assert.equal(loaded.length, mode === "explicit" ? 1 : 0);
    assert.equal(
      f.task.events.filter((event) => event.type === "skill_unavailable")
        .length,
      mode === "auto" ? 1 : 0,
    );
    if (mode === "explicit") {
      assert.equal(loaded[0]?.data?.hosted, true);
      assert.equal(loaded[0]?.data?.delivery, "model_input");
    }
    assert.ok(
      !f.task.events.some(
        (event) =>
          event.type === "tool_completed" && event.data?.tool === "load_skill",
      ),
    );
  });

for (const change of ["body", "off"] as const)
  test(`a ${change} change invalidates a paused skill checkpoint instead of restoring old methods`, async () => {
    const f = fixture();
    let started!: () => void;
    const blocking = new Promise<void>((resolve) => {
      started = resolve;
    });
    const firstModel = new ScriptedModel([
      [
        functionCall(
          "load_skill",
          { skillId: f.skill.id },
          { callId: "old-method-call" },
        ),
      ],
      modelStreamResponder(() => {
        started();
        return (async function* () {
          await new Promise(() => undefined);
        })();
      }),
    ]);
    const runtime = new TeamRuntime(f.hooks, {
      modelFactory: () => firstModel,
    });
    const running = runtime.run(f.task.id);
    await blocking;
    await runtime.stop(f.task.id);
    await running;
    assert.equal(f.task.status, "paused", f.task.error);
    assert.ok(f.checkpoint());
    if (change === "off") f.task.skillPolicy = { mode: "off", skillIds: [] };
    else {
      const updated = f.task.skillBindings![0]!;
      updated.instructions += "\n修订：还需比较修订前后范围。";
      updated.hash = skillHash(updated.instructions);
    }
    const nextModel = new ScriptedModel([
      modelResponder(({ request }) => {
        assert.doesNotMatch(JSON.stringify(request.input), /old-method-call/);
        assert.ok(!request.systemInstructions?.includes(f.skill.instructions));
        if (change === "body")
          assert.ok(
            request.systemInstructions?.includes(
              f.task.skillBindings![0]!.hash,
            ),
          );
        else
          assert.ok(!request.tools.some((tool) => tool.name === "load_skill"));
        return [assistantMessage("已按当前方法设置继续。")];
      }),
    ]);
    await new TeamRuntime(f.hooks, { modelFactory: () => nextModel }).run(
      f.task.id,
    );
    assert.equal(f.task.status, "completed", f.task.error);
    assert.ok(
      f.task.events.some((event) => event.type === "checkpoint_invalidated"),
    );
    assert.ok(!f.task.events.some((event) => event.type === "run_resumed"));
  });

test("a corrupt locked method is rejected before a provider request or fake load event", async () => {
  const f = fixture("explicit");
  f.task.skillBindings![0]!.instructions += "tampered";
  let requests = 0;
  await new TeamRuntime(f.hooks, {
    modelFactory: () => {
      requests++;
      return new ScriptedModel([[assistantMessage("should not run")]]);
    },
  }).run(f.task.id);
  assert.equal(f.task.status, "failed");
  assert.match(f.task.error ?? "", /哈希不一致/);
  assert.equal(requests, 0);
  assert.equal(
    f.task.events.filter((event) => event.type === "skill_loaded").length,
    0,
  );
});

test("method resource bodies stay behind actual loads and bound member scope", async () => {
  const f = fixture();
  const body = "PRIVATE_METHOD_RESOURCE_729";
  f.skill.resources = [
    { path: "references/example.md", content: body, hash: skillHash(body) },
  ];
  f.skill.allowedMembers = ["coordinator"];
  f.skill.hash = skillDefinitionHash(f.skill);
  const model = new ScriptedModel([
    modelResponder(({ request }) => {
      assert.ok(!request.systemInstructions?.includes(body));
      return [
        functionCall(
          "read_skill_resource",
          {
            skillId: f.skill.id,
            resourcePath: "references/example.md",
            start: 0,
          },
          { callId: "before" },
        ),
      ];
    }),
    modelResponder(({ request }) => {
      assert.match(String(result(request, "before").error), /先实际加载/);
      return [
        functionCall(
          "load_skill",
          { skillId: f.skill.id, sourceIds: [], artifactIds: [] },
          { callId: "load" },
        ),
      ];
    }),
    modelResponder(({ request }) => {
      assert.ok(!JSON.stringify(result(request, "load")).includes(body));
      return [
        functionCall(
          "read_skill_resource",
          {
            skillId: f.skill.id,
            resourcePath: "references/example.md",
            start: 0,
          },
          { callId: "resource" },
        ),
      ];
    }),
    modelResponder(({ request }) => {
      assert.equal(result(request, "resource").text, body);
      return [assistantMessage("已读允许的资源。")];
    }),
  ]);
  await new TeamRuntime(f.hooks, { modelFactory: () => model }).run(f.task.id);
  assert.equal(f.task.status, "completed", f.task.error);
  assert.equal(
    f.task.events.filter((e) => e.type === "skill_resource_read").length,
    1,
  );
  const isolated = fixture("explicit");
  isolated.skill.allowedMembers = ["editor"];
  isolated.skill.hash = skillDefinitionHash(isolated.skill);
  const restricted = new ScriptedModel([
    modelResponder(({ request }) => {
      assert.ok(
        !request.systemInstructions?.includes(isolated.skill.instructions),
      );
      assert.ok(!request.tools.some((tool) => tool.name === "load_skill"));
      return [assistantMessage("这个方法仅允许内容编辑使用，本成员没有加载。")];
    }),
  ]);
  await new TeamRuntime(isolated.hooks, { modelFactory: () => restricted }).run(
    isolated.task.id,
  );
  assert.equal(
    isolated.task.events.filter((e) => e.type === "skill_loaded").length,
    0,
  );
});

test("text timing is calculated by a real tool and identifies its estimate scope", async () => {
  const f = fixture("off");
  const model = new ScriptedModel([
    modelResponder(() => [
      functionCall(
        "measure_text",
        { text: "你好，世界！Open source 20。", unitsPerMinute: 240 },
        { callId: "measure" },
      ),
    ]),
    modelResponder(({ request }) => {
      const value = result(request, "measure");
      assert.equal(value.hanCharacters, 4);
      assert.equal(value.otherWords, 3);
      assert.equal(value.spokenUnits, 7);
      assert.equal(value.estimatedSeconds, 2);
      assert.match(String(value.scope), /不含停顿/);
      return [assistantMessage("估算约2秒，未试读。")];
    }),
  ]);
  await new TeamRuntime(f.hooks, { modelFactory: () => model }).run(f.task.id);
  assert.equal(f.task.status, "completed", f.task.error);
});
