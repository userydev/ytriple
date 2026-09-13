import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  ScriptedModel,
  modelResponder,
  assistantMessage,
} from "@openai/agents/testing";
import type { Model } from "@openai/agents";
import { WorkbenchService } from "../src/core/service.js";
import { parseCommand } from "../src/desktop/commands.js";
async function fixture(
  run: (service: WorkbenchService) => Promise<void>,
  model?: Model,
) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ytriple-source-version-"),
  );
  const service = new WorkbenchService(
    path.join(root, "data"),
    () => "synthetic-key",
    () => {},
    model ? { modelFactory: () => model } : {},
  );
  service.store.setConfig("settings", {
    ...service.store.settings(),
    aiRoot: path.join(root, "AI"),
    codeRoot: path.join(root, "Code"),
    workspaceRoot: path.join(root, "work"),
    projectMonitoring: false,
    libraryRecall: false,
  });
  if (model) {
    service.store.setConfig("profiles", [
      {
        id: "synthetic",
        name: "合成模型",
        provider: "compatible",
        protocol: "openai",
        baseURL: "https://example.invalid/v1",
        modelId: "test",
        apiKeyEnv: "SYNTHETIC_KEY",
        hasKey: true,
        status: "ready",
        capabilities: { text: true, tools: true, streaming: true },
      },
    ]);
    service.store.setConfig("settings", {
      ...service.store.settings(),
      defaultProfileId: "synthetic",
      memberProfiles: {
        coordinator: "synthetic",
        researcher: "synthetic",
        cto: "synthetic",
        editor: "synthetic",
      },
    });
  }
  try {
    await service.initialize();
    await run(service);
  } finally {
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("text material preparation validates an optional positive goal version and retains ordinary imports", async () => {
  const input = {
    type: "source.addText",
    taskId: "task",
    title: "正式资料",
    text: "实际正文",
  };
  assert.equal(
    (
      parseCommand({ ...input, expectedGoalVersion: 2 }) as {
        expectedGoalVersion: number;
      }
    ).expectedGoalVersion,
    2,
  );
  for (const expectedGoalVersion of [0, -1, 1.2, "2", Infinity])
    assert.throws(() => parseCommand({ ...input, expectedGoalVersion }));
  await fixture(async (service) => {
    const task = (
      await service.execute({ type: "task.create", goal: "原目标" })
    ).tasks[0]!;
    const result = await service.execute({
      ...input,
      type: "source.addText",
      taskId: task.id,
    });
    assert.equal(result.tasks[0]!.sources[0]?.text, "实际正文");
  });
});

test("two queued preparation imports cannot both adopt one goal version", async () =>
  fixture(async (service) => {
    const task = (
      await service.execute({
        type: "task.create",
        goal: "只准备这个版本的材料",
      })
    ).tasks[0]!;
    const results = await Promise.allSettled([
      service.execute({
        type: "source.addText",
        taskId: task.id,
        title: "资料一",
        text: "正文一",
        expectedGoalVersion: task.goalVersion,
      }),
      service.execute({
        type: "source.addText",
        taskId: task.id,
        title: "资料二",
        text: "正文二",
        expectedGoalVersion: task.goalVersion,
      }),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      results.filter((result) => result.status === "rejected").length,
      1,
    );
    assert.equal(service.store.task(task.id).sources.length, 1);
    assert.equal(service.store.task(task.id).goalVersion, task.goalVersion + 1);
    assert.equal(service.runtime.isRunning(task.id), false);
  }));

test("a stale prepared source cannot stop a newer user goal that is already running", async () => {
  const entered = deferred(),
    release = deferred();
  let signal: AbortSignal | undefined;
  const model = new ScriptedModel([
    modelResponder(async (call) => {
      signal = call.request.signal;
      entered.resolve();
      await release.promise;
      return [assistantMessage("合成回复")];
    }),
  ]);
  try {
    await fixture(async (service) => {
      const task = (
        await service.execute({ type: "task.create", goal: "旧目标" })
      ).tasks[0]!;
      await service.execute({
        type: "task.send",
        taskId: task.id,
        text: "用户的新目标",
        reviseGoal: true,
      });
      await entered.promise;
      assert.equal(service.runtime.isRunning(task.id), true);
      assert.equal(signal?.aborted, false);
      await assert.rejects(
        service.execute({
          type: "source.addText",
          taskId: task.id,
          title: "旧准备资料",
          text: "旧正文",
          expectedGoalVersion: task.goalVersion,
        }),
        /工作目标已变化/,
      );
      assert.equal(
        signal?.aborted,
        false,
        "the old preparation must be rejected before stopping the new runtime",
      );
      assert.equal(service.runtime.isRunning(task.id), true);
      assert.equal(service.store.task(task.id).goal, "用户的新目标");
      assert.equal(service.store.task(task.id).sources.length, 0);
      release.resolve();
    }, model);
  } finally {
    release.resolve();
  }
});

test("a goal change during runtime cancellation fences the prepared source before storage commit", async () => {
  const entered = deferred(),
    release = deferred();
  let changeGoal = () => {};
  const model = new ScriptedModel([
    modelResponder(async (call) => {
      call.request.signal?.addEventListener("abort", () => changeGoal(), {
        once: true,
      });
      entered.resolve();
      await release.promise;
      return [assistantMessage("迟到的公开答复")];
    }),
  ]);
  try {
    await fixture(async (service) => {
      const task = (
        await service.execute({ type: "task.create", goal: "旧准备目标" })
      ).tasks[0]!;
      await service.execute({ type: "task.run", taskId: task.id });
      await entered.promise;
      changeGoal = () =>
        service.store.updateTask(task.id, (current) => {
          current.goalVersion++;
          current.goal = "取消过程中到来的新目标";
          current.status = "idle";
        });
      await assert.rejects(
        service.execute({
          type: "source.addText",
          taskId: task.id,
          title: "取消前的准备资料",
          text: "不该写入新目标",
          expectedGoalVersion: task.goalVersion,
        }),
        /工作目标已变化/,
      );
      const current = service.store.task(task.id);
      assert.equal(current.goalVersion, task.goalVersion + 1);
      assert.equal(current.goal, "取消过程中到来的新目标");
      assert.equal(current.sources.length, 0);
      assert.equal(current.status, "idle");
      assert.ok(
        !current.events.some((event) => event.type === "source.imported"),
      );
      release.resolve();
    }, model);
  } finally {
    release.resolve();
  }
});
