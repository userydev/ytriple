import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Skills } from "../src/core/skills";
import { skillKey, parseSkillRequest } from "../src/core/skill-contract";
import { Store } from "../src/core/store";
import { Runtime } from "../src/core/runtime";
import { ProcessRecords } from "../src/core/process";
import { LocalDirectories } from "../src/core/local-directories";
import {
  defaultTeam,
  defaultWorkflow,
  type Run,
  type Contribution,
  type SubmitInput,
} from "../src/core/types";
import type { Model, Prompt, StreamEvent } from "../src/core/ycore";
import { protocolModel, teamResponse } from "./team-response";
const input = (extra: Partial<SubmitInput> = {}): SubmitInput => ({
  key: randomUUID(),
  context: "new",
  text: "核查现有材料的范围",
  refs: [],
  recipient: null,
  projectId: null,
  ...extra,
});
const definition = {
  name: "证据边界",
  description: "对照来源逐项核查",
  body: "METHOD-PRIVATE-271：只根据已读取的材料给出结论。",
  dependencies: [],
};
class Script implements Model {
  prompts: Prompt[] = [];
  constructor(readonly output: (p: Prompt, n: number) => string) {}
  async *stream(p: Prompt, key: string): AsyncGenerator<StreamEvent> {
    this.prompts.push(p);
    yield { type: "run.started", run_id: key };
    yield {
      type: "text.delta",
      run_id: key,
      text: this.output(p, this.prompts.length),
    };
    yield { type: "run.completed", run_id: key };
  }
}
function fixture() {
  const store = new Store(":memory:");
  store.initializeConfiguration();
  const skills = new Skills(store);
  skills.initialize();
  return { store, skills };
}
test("builtins initialize idempotently; editable copies retain immutable versions and reject stale saves", () => {
  const { store, skills } = fixture();
  try {
    skills.initialize();
    assert.equal(store.snapshot().skills.length, 4);
    assert.throws(() => skills.save(definition, "builtin.reading@1"), /副本/);
    const copy = skills.copy("builtin.reading@1");
    const next = skills.save({ ...definition }, skillKey(copy));
    assert.equal(next.version, 2);
    assert.equal(next.source.fromKey, "builtin.reading@1");
    assert.notEqual(
      store.require<any>("skill", skillKey(copy)).body,
      next.body,
    );
    assert.throws(() => skills.save(definition, skillKey(copy)), /新版本/);
    assert.throws(
      () => skills.save({ ...definition, body: "中".repeat(6000) }),
      /字节/,
    );
  } finally {
    store.close();
  }
});
test("queued submission freezes exact methods, draft and disabled selection failures are atomic", async () => {
  const { store, skills } = fixture();
  try {
    const v1 = skills.save(definition),
      key = skillKey(v1);
    const draft = {
      id: "new",
      text: "核查材料",
      refs: [],
      recipient: null,
      projectId: null,
      skillKeys: [key],
    };
    store.saveDraft(draft);
    skills.state(v1.id, false);
    assert.throws(
      () => store.submit(input({ ...draft, context: "new" })),
      /不可加载/,
    );
    assert.equal(store.snapshot().runs.length, 0);
    assert.deepEqual(store.snapshot().drafts[0].skillKeys, [key]);
    skills.state(v1.id, true);
    const run = store.submit(input({ skillKeys: [key] }));
    skills.save({ ...definition, body: "CHANGED-METHOD" }, key);
    skills.state(v1.id, false);
    assert.equal(
      store
        .require<Run>("run", run.id)
        .skills!.find((s) => skillKey(s) === key)!.body,
      definition.body,
    );
    const model = new Script(() => "根据指定方法给出有限结论。");
    const runtime = new Runtime(store, () => protocolModel(model));
    runtime.resume(run.workId);
    await runtime.settled(run.workId);
    assert.equal(store.require<Run>("run", run.id).status, "succeeded");
    assert.ok(model.prompts[0].messages[0].content.includes(definition.body));
    assert.ok(!model.prompts[0].messages[0].content.includes("CHANGED-METHOD"));
    const c = store.all<Contribution>("contribution")[0];
    assert.equal(c.skills?.[0].key, key);
    const prepared = new ProcessRecords(store).prepare({
      workId: run.workId,
      mode: "review",
    });
    assert.ok(
      store.material(prepared.refs.at(-1)!).body.includes(definition.body),
    );
  } finally {
    store.close();
  }
});
test("automatic methods load only after selection, record purpose and exact request, fixed flows keep stage order", async () => {
  const { store, skills } = fixture();
  try {
    const method = skills.save(definition),
      key = skillKey(method);
    store.put("meta", "team", {
      ...defaultTeam,
      members: defaultTeam.members.map((m) => ({ ...m, skillKeys: [key] })),
    });
    store.put("meta", "workflow", defaultWorkflow);
    const model = new Script((p) =>
      p.taskId.endsWith(":t0:a0")
        ? JSON.stringify({
            ytriple_skill: { key, purpose: "核对证据来源与读取范围" },
          })
        : "已按方法核对，证据范围有限。",
    );
    const runtime = new Runtime(store, () => protocolModel(model)),
      run = runtime.submit(input());
    await runtime.settled(run.workId);
    assert.equal(store.require<Run>("run", run.id).status, "succeeded");
    assert.equal(model.prompts.length, 6);
    assert.ok(!model.prompts[0].messages[0].content.includes(definition.body));
    assert.ok(model.prompts[1].messages[0].content.includes(definition.body));
    assert.equal(
      store.all<Contribution>("contribution").filter((c) => c.skillRequest)
        .length,
      3,
    );
    assert.equal(
      store.all<Contribution>("contribution").filter((c) => c.skills?.length)
        .length,
      3,
    );
    assert.deepEqual(
      store.require<any>("model-input", model.prompts[1].taskId).prompt,
      model.prompts[1],
    );
  } finally {
    store.close();
  }
});
test("member method catalog and bodies stay out of an unassigned child task", async () => {
  const { store, skills } = fixture();
  try {
    const s = skills.save(definition),
      key = skillKey(s);
    store.put("meta", "team", {
      ...defaultTeam,
      members: defaultTeam.members.map((m) => ({
        ...m,
        skillKeys: m.id === "editor" ? [key] : [],
      })),
    });
    const model = new Script((p, n) =>
      n === 1
        ? JSON.stringify({ ytriple_skill: { key, purpose: "负责人核查" } })
        : n === 2
          ? JSON.stringify({
              ytriple_delegate: {
                memberId: "researcher",
                objective: "限定材料分析",
                context: "仅根据提供的背景分析",
                references: [],
              },
            })
          : p.taskId.includes(":d:")
            ? "资料不足。"
            : "负责人给出有限结论。",
    );
    const runtime = new Runtime(store, () => protocolModel(model)),
      run = runtime.submit(input());
    await runtime.settled(run.workId);
    assert.equal(store.require<Run>("run", run.id).status, "succeeded");
    const child = model.prompts.find((p) => p.taskId.includes(":d:"))!;
    assert.ok(child);
    assert.ok(!JSON.stringify(child).includes(definition.body));
    assert.ok(!child.messages[0].content.includes(key));
    assert.ok(
      model.prompts.at(-1)!.messages[0].content.includes(definition.body),
    );
  } finally {
    store.close();
  }
});
test("unapproved, duplicated and malformed method requests terminate without publishing control JSON", async () => {
  for (const mode of ["unknown", "repeat", "malformed"]) {
    const { store } = fixture();
    try {
      const model = new Script(() =>
        mode === "malformed"
          ? '{"ytriple_skill":'
          : JSON.stringify({
              ytriple_skill: {
                key: mode === "unknown" ? "outside@1" : "builtin.reading@1",
                purpose: "核查",
              },
            }),
      );
      const runtime = new Runtime(store, () => protocolModel(model)),
        run = runtime.submit(input());
      await runtime.settled(run.workId);
      assert.equal(store.require<Run>("run", run.id).status, "failed");
      assert.equal(store.snapshot().versions.length, 0);
      assert.equal(model.prompts.length, mode === "repeat" ? 2 : 1);
    } finally {
      store.close();
    }
  }
  assert.equal(parseSkillRequest('示例：{"ytriple_skill":{}}'), null);
  assert.throws(() =>
    parseSkillRequest(
      '{"ytriple_skill":{"key":"x","purpose":"x"},"extra":true}',
    ),
  );
});
test("restart reconciles original interrupted method request and reconstructs loaded versions without replay", async () => {
  const dir = await realpath(
      await mkdtemp(join(tmpdir(), "ytriple-skill-recovery-")),
    ),
    path = join(dir, "db");
  let store = new Store(path);
  store.initializeConfiguration();
  new Skills(store).initialize();
  let run: Run;
  const prompts: Prompt[] = [];
  const model: Model = {
    async *stream(p, key) {
      prompts.push(p);
      yield { type: "run.started", run_id: key };
      if (prompts.length === 1) {
        yield {
          type: "text.delta",
          run_id: key,
          text: JSON.stringify({
            ytriple_skill: { key: "builtin.reading@1", purpose: "读取范围" },
          }),
        };
        yield { type: "run.completed", run_id: key };
      } else throw new TypeError("connection lost");
    },
  };
  try {
    let runtime = new Runtime(store, () => protocolModel(model));
    run = runtime.submit(input());
    await runtime.settled(run.workId);
    assert.equal(store.require<Run>("run", run.id).status, "unknown");
    store.close();
    store = new Store(path);
    let calls = 0;
    runtime = new Runtime(
      store,
      () =>
        ({
          async *stream() {
            calls++;
            throw Error("must not replay");
          },
          async lookup(id) {
            return {
              run_id: id,
              error: null,
              status: "succeeded",
              result: {
                text: teamResponse("已依据读取范围完成", null),
              },
            };
          },
        }) as Model,
    );
    await runtime.reconcile(run.id);
    runtime.resume(run.workId);
    await runtime.settled(run.workId);
    assert.equal(calls, 0);
    assert.equal(store.require<Run>("run", run.id).status, "succeeded");
    assert.equal(
      store.all<Contribution>("contribution").at(-1)!.skills?.[0].key,
      "builtin.reading@1",
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("local import revisions, missing dependencies, portable export and file boundaries retain original assets", async () => {
  const dir = await realpath(
      await mkdtemp(join(tmpdir(), "ytriple-method-files-")),
    ),
    store = new Store(":memory:"),
    skills = new Skills(store);
  try {
    await mkdir(join(dir, "AI/method"), { recursive: true });
    await mkdir(join(dir, "Code"));
    await mkdir(join(dir, "AI/system"));
    await new LocalDirectories(store).discover(dir);
    const path = join(dir, "AI/method/SKILL.md");
    await writeFile(path, "# Evidence\nOnly use supplied sources.");
    const s = await skills.importFile(path);
    assert.equal((await skills.importFile(path)).version, 1);
    await writeFile(path, "# Evidence v2\nCompare conflicts.");
    assert.equal((await skills.inspect(skillKey(s))).state, "changed");
    assert.equal((await skills.importFile(path)).version, 2);
    assert.match(store.require<any>("skill", skillKey(s)).body, /Only use/);
    const exported = join(dir, "AI/saved.method.json");
    await skills.exportFile(skillKey(s), exported);
    const imported = await skills.importFile(exported);
    assert.equal(imported.body, s.body);
    assert.notEqual(imported.id, s.id);
    await assert.rejects(() => skills.exportFile(skillKey(s), exported));
    await assert.rejects(
      () =>
        skills.exportFile(skillKey(s), join(dir, "AI/system/x.method.json")),
      /系统规则/,
    );
    await symlink(path, join(dir, "AI/link.md"));
    await assert.rejects(
      () => skills.importFile(join(dir, "AI/link.md")),
      /符号链接/,
    );
    await writeFile(join(dir, "outside.md"), "outside");
    await assert.rejects(
      () => skills.importFile(join(dir, "outside.md")),
      /不在/,
    );
    await writeFile(
      path,
      "---\nname: 资料归纳\ndescription: >-\n  核对来源和\n  读取范围\n---\n# 方法\n只使用实际材料。",
    );
    const metadata = await skills.importFile(path);
    assert.equal(metadata.name, "资料归纳");
    assert.equal(metadata.description, "核对来源和 读取范围");
    assert.ok(!metadata.body.includes("description:"));
    await mkdir(join(dir, "AI/method/scripts"));
    assert.equal((await skills.inspect(skillKey(metadata))).state, "changed");
    const withScripts = await skills.importFile(path);
    assert.equal(withScripts.version, metadata.version + 1);
    assert.equal(withScripts.dependencies.length, 1);
    await writeFile(path, "---\nname: &x a\ndescription: *x\n---\nbody");
    await assert.rejects(() => skills.importFile(path));

    await writeFile(path, "[helper](resources/notes.md)\nallowed-tools: Bash");
    const blocked = await skills.importFile(path);
    assert.equal(blocked.dependencies.length, 3);
    assert.throws(
      () => skills.capture([skillKey(blocked)], defaultTeam),
      /不可加载/,
    );
    assert.equal(
      await readFile(path, "utf8"),
      "[helper](resources/notes.md)\nallowed-tools: Bash",
    );
    const bad = JSON.parse(await readFile(exported, "utf8"));
    bad.definition.body = "tampered";
    await writeFile(join(dir, "AI/tampered.json"), JSON.stringify(bad));
    await assert.rejects(
      () => skills.importFile(join(dir, "AI/tampered.json")),
      /校验/,
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
