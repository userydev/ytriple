import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../src/core/store";
import { defaultTeam, workbenchTeam, workbenchWorkflow, type SubmitInput } from "../src/core/types";
import { versionKey } from "../src/core/configuration";

const submit = (context: string): SubmitInput => ({ key: randomUUID(), context,
  text: "暂停当前安排", refs: [], recipient: null, projectId: null, outputMode: "explanation" });

test("default capability upgrade preserves historical work and customized teams", () => {
  const store = new Store(":memory:");
  try {
    const old = store.submit(submit("new"));
    store.initializeConfiguration();
    assert.equal(store.configuration().team.id, workbenchTeam.id);
    assert.equal(store.configuration().workflow.id, workbenchWorkflow.id);
    assert.deepEqual(store.configuration(old.workId).team, old.team);
    const custom = { ...defaultTeam, name: "我的自定义团队" };
    store.put("meta", "team", custom);
    store.initializeConfiguration();
    assert.equal(store.configuration().team.name, custom.name);
  } finally { store.close(); }
});

test("prepared conversation pins its object, refreshes revision, and preserves drafts and custom defaults", () => {
  const store = new Store(":memory:");
  try {
    const target = { kind: "schedule" as const, id: randomUUID(), revision: 1 };
    store.put("schedule", target.id, { id: target.id, revision: 1 });
    const context = `new:workspace:${randomUUID()}`;
    const draft = store.prepareWorkspaceChat(context, "暂停当前安排", target);
    assert.equal(draft.outputMode, "explanation");
    assert.equal(store.configuration().team.id, defaultTeam.id);
    assert.ok(store.require<any>("team", draft.teamKey!).members.some((m: any) => m.toolKeys?.includes("builtin.workspace@1")));
    assert.throws(() => store.prepareWorkspaceChat(context, "覆盖原草稿", target), /未发送的草稿/);
    store.saveDraft({ id: context, text: draft.text, refs: [], recipient: null, projectId: null });
    assert.equal(store.get<any>("draft", context)?.teamKey, draft.teamKey);
    store.put("schedule", target.id, { id: target.id, revision: 2 });
    const first = store.submit(submit(context));
    assert.deepEqual(first.workspaceContext, { ...target, revision: 2 });
    assert.equal(versionKey(first.team), draft.teamKey);
    store.setRun(first.id, { status: "succeeded" });
    const other = { ...target, id: randomUUID() };
    store.put("schedule", other.id, { id: other.id, revision: 1 });
    assert.throws(() => store.submit({ ...submit(first.workId), workspaceContext: other }), /对象不能/);
    store.put("schedule", target.id, { id: target.id, revision: 3 });
    assert.equal(store.submit(submit(first.workId)).workspaceContext?.revision, 3);
    assert.equal(store.require<any>("run", first.id).workspaceContext.revision, 2);
  } finally { store.close(); }
});
