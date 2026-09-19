import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/core/store";
import { Runtime } from "../src/core/runtime";
import { WorkspaceBackups } from "../src/core/workspace-backup";
import { instantiateMemberTemplate } from "../src/core/member-templates";
import { versionKey } from "../src/core/configuration";
import type { Run } from "../src/core/types";
import type { Model, Prompt } from "../src/core/ycore";
import { teamResponse, boundBaseFromPrompt } from "./team-response";

test("template draft applies to actual Runtime prompts, freezes per run and roundtrips in backup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ytriple-template-store-"));
  const store = new Store(join(dir, "workbench.sqlite"));
  let recovered: Store | undefined;
  try {
    store.initializeConfiguration();
    const member = instantiateMemberTemplate("agency-code-reviewer", []);
    const team = store.saveTeam({ ...store.snapshot().team, members: [...store.snapshot().team.members, member] });
    store.selectConfiguration(null, versionKey(team), versionKey(store.snapshot().workflow));
    const prompts: Prompt[] = [];
    const model: Model = { async *stream(p, key) {
      prompts.push(p);
      yield { type: "run.started", run_id: key };
      yield { type: "text.delta", run_id: key, text: teamResponse("核查完成", p.messages.some(m => m.role === "system" && m.content.includes("不允许提交 artifact")) ? null : { body: "核查完成", baseVersionId: boundBaseFromPrompt(p) }) };
      yield { type: "run.completed", run_id: key };
    } };
    const runtime = new Runtime(store, () => model);
    const run = runtime.submit({ key: randomUUID(), context: "new", text: "核查", refs: [], recipient: member.id, projectId: null });
    const edited = store.saveTeam({ ...team, members: team.members.map(m => m.id === member.id ? { ...m, instruction: "新职责" } : m) });
    store.selectConfiguration(null, versionKey(edited), versionKey(store.snapshot().workflow));
    await runtime.settled(run.workId);
    const frozen = store.require<Run>("run", run.id);
    assert.equal(frozen.status, "succeeded", JSON.stringify({ error: frozen.error, contributions: store.all("contribution") }));
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0].messages.some(m => m.role === "system" && m.content.includes(member.instruction)));
    assert.deepEqual(frozen.team.members.find(m => m.id === member.id), member);
    assert.equal(store.snapshot().team.members.find(m => m.id === member.id)?.instruction, "新职责");
    const file = join(dir, "template.ytriple-backup"), backups = new WorkspaceBackups(dir);
    await backups.export(store, file);
    const preview = await backups.inspect(file);
    const restored = await backups.restore(preview.id, "模板恢复", { aiPath: null, codePath: null });
    recovered = new Store(join(dir, "spaces", restored.id, "workbench.sqlite"));
    assert.deepEqual(recovered.require<Run>("run", run.id).team, frozen.team);
    assert.deepEqual(recovered.snapshot().team.members.find(m => m.id === member.id)?.provenance, member.provenance);
  } finally { recovered?.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("template source cannot grant a tool: Runtime rejects an ungranted request", async () => {
  const store = new Store(":memory:");
  try {
    store.initializeConfiguration();
    const member = instantiateMemberTemplate("agency-code-reviewer", []);
    const team = store.saveTeam({ ...store.snapshot().team, members: [...store.snapshot().team.members, member] });
    store.selectConfiguration(null, versionKey(team), versionKey(store.snapshot().workflow));
    let calls = 0;
    const model: Model = { async *stream(_p, key) {
      calls++;
      yield { type: "run.started", run_id: key };
      yield { type: "text.delta", run_id: key, text: JSON.stringify({ ytriple_tool: { key: "builtin.calculate@1", purpose: "未授权", input: { operation: "add", values: [1, 2] } } }) };
      yield { type: "run.completed", run_id: key };
    } };
    const runtime = new Runtime(store, () => model);
    const run = runtime.submit({ key: randomUUID(), context: "new", text: "计算", refs: [], recipient: member.id, projectId: null });
    await runtime.settled(run.workId);
    assert.equal(store.require<Run>("run", run.id).status, "failed");
    assert.ok(calls > 0);
    assert.equal(store.all("tool-call").length, 0);
    assert.equal(store.all("version").length, 0);
  } finally { store.close(); }
});
