import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkbenchService } from "../src/core/service.js";
import { parseCommand } from "../src/desktop/commands.js";
import { bindTaskSkills } from "../src/core/skill-policy.js";
import { BUILTIN_SKILLS } from "../src/core/skills.js";
import { hash, writeArtifact } from "../src/core/files.js";
import type { Task } from "../src/shared/types.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ytriple-skills-"));
  const service = new WorkbenchService(
    path.join(root, "data"),
    () => undefined,
  );
  service.store.setConfig("settings", {
    ...service.store.settings(),
    aiRoot: path.join(root, "AI"),
    codeRoot: path.join(root, "Code"),
    workspaceRoot: path.join(root, "work"),
    projectMonitoring: false,
    libraryRecall: false,
  });
  await service.initialize();
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await service.close();
    }
  };
  t.after(async () => {
    await close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, service, close };
}

test("skill policies reject invalid IPC shapes and unknown or disabled methods before creating work", async (t) => {
  const { service } = await fixture(t);
  for (const policy of [
    { mode: "explicit", skillIds: [] },
    { mode: "off", skillIds: ["script-review"] },
    { mode: "auto", skillIds: [], instructions: "grant permissions" },
    { mode: "explicit", skillIds: ["script-review", "script-review"] },
  ])
    assert.throws(() =>
      parseCommand({
        type: "task.create",
        goal: "核查脚本",
        skillPolicy: policy,
      }),
    );
  await assert.rejects(
    service.execute({
      type: "task.create",
      goal: "核查脚本",
      skillPolicy: { mode: "explicit", skillIds: ["unknown"] },
    }),
    /有效的 Skill/,
  );
  await service.execute({
    type: "skill.setEnabled",
    skillId: "script-review",
    enabled: false,
  });
  await assert.rejects(
    service.execute({
      type: "task.create",
      goal: "核查脚本",
      skillPolicy: { mode: "explicit", skillIds: ["script-review"] },
    }),
    /已停用/,
  );
  assert.equal(service.store.tasks().length, 0);
});

test("chosen method and disable state survive reopening without fabricating use or validation", async (t) => {
  const { root, service, close } = await fixture(t);
  const snap = await service.execute({
    type: "task.create",
    goal: "基于已提供资料核查脚本",
    skillPolicy: { mode: "explicit", skillIds: ["script-review"] },
  });
  const task = snap.tasks[0]!;
  assert.equal(
    task.skillBindings?.[0]?.hash,
    BUILTIN_SKILLS.find((skill) => skill.id === "script-review")!.hash,
  );
  assert.equal(
    task.events.filter((event) => event.type === "skill_loaded").length,
    0,
  );
  assert.ok(snap.skills?.every((skill) => skill.validation === "unverified"));
  await service.execute({
    type: "skill.setEnabled",
    skillId: "script-review",
    enabled: false,
  });
  await close();
  const reopened = new WorkbenchService(
    path.join(root, "data"),
    () => undefined,
  );
  t.after(() => reopened.close());
  const restored = await reopened.initialize();
  assert.deepEqual(restored.tasks[0]!.skillBindings, task.skillBindings);
  assert.equal(
    restored.skills?.find((skill) => skill.id === "script-review")?.enabled,
    false,
  );
  await assert.rejects(
    reopened.execute({ type: "task.run", taskId: task.id }),
    /已停用/,
  );
  assert.equal(reopened.runtime.isRunning(task.id), false);
});

test("switching method preserves artifacts and the last actual request, invalidates resume, and is idempotent", async (t) => {
  const { service } = await fixture(t);
  const snap = await service.execute({
    type: "task.create",
    goal: "检查这份交接材料",
    skillPolicy: { mode: "explicit", skillIds: ["handoff-review"] },
  });
  const original = snap.tasks[0]!;
  await writeArtifact(service.store, original.id, {
    title: "交接草案",
    content: "# 目标\n仍需实际接收证据。",
    format: "md",
    goalVersion: original.goalVersion,
    operationId: "skill-preserve",
  });
  service.store.saveCheckpoint(original.id, { synthetic: true });
  const policy = { mode: "off" as const, skillIds: [] };
  let result = await service.execute({
    type: "task.setSkills",
    taskId: original.id,
    policy,
  });
  let updated = result.tasks[0]!;
  assert.equal(updated.goalVersion, original.goalVersion + 1);
  assert.equal(updated.messages.length, 1);
  assert.equal(
    updated.events.at(-1)!.data?.continuedUserMessageId,
    original.messages[0]!.id,
  );
  assert.equal(updated.artifacts[0]!.version, 1);
  assert.match(updated.artifacts[0]!.content!, /仍需实际接收证据/);
  assert.equal(updated.status, "paused");
  assert.deepEqual(updated.skillBindings, []);
  assert.deepEqual(updated.skillPins, original.skillPins);
  assert.equal(service.store.checkpoint(original.id), undefined);
  result = await service.execute({
    type: "task.setSkills",
    taskId: original.id,
    policy,
  });
  assert.equal(result.tasks[0]!.goalVersion, updated.goalVersion);
  service.store.updateTask(original.id, (task) => {
    task.status = "waiting";
  });
  await assert.rejects(
    service.execute({
      type: "task.setSkills",
      taskId: original.id,
      policy: { mode: "auto", skillIds: [] },
    }),
    /先暂停/,
  );
});

test("run boundaries exclude disabled auto methods and preserve pinned versions without silently upgrading", async (t) => {
  const { service } = await fixture(t);
  const snap = await service.execute({ type: "task.create", goal: "消化资料" });
  const task = snap.tasks[0]!;
  // Older persisted tasks only have the per-run bindings.
  delete task.skillPins;
  const existing = task.skillBindings![0]!;
  const instructions = existing.instructions + "\n本任务固定的旧版方法。";
  task.skillBindings![0] = {
    ...existing,
    version: "0.9.0",
    instructions,
    hash: hash(instructions),
  };
  assert.equal(
    bindTaskSkills(service.store, task).find(
      (skill) => skill.id === existing.id,
    )!.version,
    "0.9.0",
  );
  await service.execute({
    type: "skill.setEnabled",
    skillId: existing.id,
    enabled: false,
  });
  assert.equal(
    bindTaskSkills(service.store, task).some(
      (skill) => skill.id === existing.id,
    ),
    false,
  );
  assert.equal(task.skillBindings![0]!.version, "0.9.0");
  assert.deepEqual(
    bindTaskSkills(service.store, { surface: "background" } as Task),
    [],
  );
  assert.equal(
    bindTaskSkills(service.store, { ...task, skillPolicy: undefined }).length,
    BUILTIN_SKILLS.length - 1,
  );
});

test("disabled sends leave the request and checkpoint untouched before stopping work", async (t) => {
  const { service } = await fixture(t);
  const snapshot = await service.execute({
    type: "task.create",
    goal: "核查现有脚本",
    skillPolicy: { mode: "explicit", skillIds: ["script-review"] },
  });
  const task = snapshot.tasks[0]!;
  const checkpoint = { synthetic: true, message: "保留原运行恢复点" };
  service.store.saveCheckpoint(task.id, checkpoint);
  let stopCalls = 0;
  t.mock.method(service.runtime, "stop", async () => {
    stopCalls++;
  });
  await service.execute({
    type: "skill.setEnabled",
    skillId: "script-review",
    enabled: false,
  });
  await assert.rejects(
    service.execute({
      type: "task.send",
      taskId: task.id,
      text: "改变目标并重新核查",
      reviseGoal: true,
      member: "researcher",
    }),
    /已停用/,
  );
  assert.equal(stopCalls, 0);
  assert.deepEqual(service.store.task(task.id), task);
  assert.deepEqual(service.store.checkpoint(task.id), checkpoint);
});

test("a method disabled while stop is pending rejects the send before accepting its message", async (t) => {
  const { service } = await fixture(t);
  const snapshot = await service.execute({
    type: "task.create",
    goal: "核查现有脚本",
    skillPolicy: { mode: "explicit", skillIds: ["script-review"] },
  });
  const task = snapshot.tasks[0]!;
  const checkpoint = { synthetic: true };
  service.store.saveCheckpoint(task.id, checkpoint);
  let enteredStop!: () => void;
  const stopping = new Promise<void>((resolve) => {
    enteredStop = resolve;
  });
  let releaseStop!: () => void;
  const stopped = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  t.mock.method(service.runtime, "stop", async () => {
    enteredStop();
    await stopped;
  });
  t.mock.method(service.runtime, "run", async () => undefined);
  const command = {
    type: "task.send" as const,
    taskId: task.id,
    text: "保留第二段并重新核查",
  };
  const rejected = assert.rejects(service.execute(command), /已停用/);
  await stopping;
  await service.execute({
    type: "skill.setEnabled",
    skillId: "script-review",
    enabled: false,
  });
  releaseStop();
  await rejected;
  assert.deepEqual(service.store.task(task.id), task);
  assert.deepEqual(service.store.checkpoint(task.id), checkpoint);
  await service.execute({
    type: "skill.setEnabled",
    skillId: "script-review",
    enabled: true,
  });
  await service.execute(command);
  const accepted = service.store.task(task.id);
  assert.equal(accepted.messages.length, task.messages.length + 1);
  assert.equal(accepted.messages.at(-1)!.content, command.text);
  assert.equal(accepted.goalVersion, task.goalVersion + 1);
});

test("an auto method retains its old pinned version through disable, run, reopen, and re-enable", async (t) => {
  const { service, root, close } = await fixture(t);
  const snapshot = await service.execute({
    type: "task.create",
    goal: "消化已有资料",
  });
  const task = snapshot.tasks[0]!;
  const existing = task.skillBindings![0]!;
  const instructions = existing.instructions + "\n本任务锁定的历史方法。";
  const oldMethod = {
    ...existing,
    version: "0.9.0",
    instructions,
    hash: hash(instructions),
  };
  // Reproduce an older task with bindings only, before the catalog's 1.0.0 version.
  delete task.skillPins;
  task.skillBindings = task.skillBindings!.map((method) =>
    method.id === oldMethod.id ? oldMethod : method,
  );
  service.store.saveTask(task);
  assert.equal(
    BUILTIN_SKILLS.find((method) => method.id === oldMethod.id)!.version,
    "1.0.0",
  );
  t.mock.method(service.runtime, "run", async () => undefined);
  await service.execute({
    type: "skill.setEnabled",
    skillId: oldMethod.id,
    enabled: false,
  });
  await service.execute({ type: "task.run", taskId: task.id });
  const disabled = service.store.task(task.id);
  assert.equal(
    disabled.skillBindings!.some((method) => method.id === oldMethod.id),
    false,
  );
  assert.deepEqual(
    disabled.skillPins!.find((method) => method.id === oldMethod.id),
    oldMethod,
  );
  await service.execute({
    type: "task.setSkills",
    taskId: task.id,
    policy: { mode: "explicit", skillIds: ["handoff-review"] },
  });
  assert.deepEqual(
    service.store
      .task(task.id)
      .skillPins!.find((method) => method.id === oldMethod.id),
    oldMethod,
  );
  await service.execute({
    type: "task.setSkills",
    taskId: task.id,
    policy: { mode: "auto", skillIds: [] },
  });
  await close();
  const reopened = new WorkbenchService(
    path.join(root, "data"),
    () => undefined,
  );
  try {
    await reopened.initialize();
    t.mock.method(reopened.runtime, "run", async () => undefined);
    await reopened.execute({
      type: "skill.setEnabled",
      skillId: oldMethod.id,
      enabled: true,
    });
    await reopened.execute({ type: "task.run", taskId: task.id });
    const restored = reopened.store.task(task.id);
    assert.deepEqual(
      restored.skillBindings!.find((method) => method.id === oldMethod.id),
      oldMethod,
    );
    assert.deepEqual(
      restored.skillPins!.find((method) => method.id === oldMethod.id),
      oldMethod,
    );
  } finally {
    await reopened.close();
  }
});
