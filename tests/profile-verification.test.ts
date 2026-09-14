import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  ScriptedModel,
  assistantMessage,
  modelResponder,
} from "@openai/agents/testing";
import { WorkbenchService } from "../src/core/service.js";
import type { ModelProfile } from "../src/shared/types.js";

const connection: ModelProfile = {
  id: "synthetic",
  name: "合成连接",
  provider: "compatible",
  protocol: "openai",
  baseURL: "https://example.test/v1",
  modelId: "synthetic-model",
  apiKeyEnv: "SYNTHETIC_KEY",
  hasKey: true,
  status: "untested",
};
function configure(service: WorkbenchService, dir: string) {
  service.store.setConfig("settings", {
    ...service.store.settings(),
    aiRoot: path.join(dir, "AI"),
    codeRoot: path.join(dir, "Code"),
    workspaceRoot: path.join(dir, "work"),
    projectMonitoring: false,
  });
  service.store.setConfig("profiles", [connection]);
}

test("partial probe preserves text availability and verification survives rename/reopen but resets on connection or key change", async (t) => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "ytriple-profile-verification-"),
  );
  const model = new ScriptedModel([
    [assistantMessage("TEXT_OK")],
    [assistantMessage("I cannot call tools.")],
    [assistantMessage("STREAM_OK")],
  ]);
  let service = new WorkbenchService(
    path.join(dir, "data"),
    () => "synthetic-key",
    () => {},
    { modelFactory: () => model },
  );
  t.after(async () => {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  configure(service, dir);
  let snapshot = await service.execute({
    type: "profile.probe",
    profileId: connection.id,
  });
  let actual = snapshot.profiles[0]!;
  assert.equal(
    actual.status,
    "ready",
    "tool check failure must not misreport working text connection as disconnected",
  );
  assert.deepEqual(actual.capabilities, {
    text: true,
    tools: false,
    streaming: true,
  });
  assert.match(actual.lastError!, /工具调用/);
  const testedAt = actual.testedAt;
  snapshot = await service.execute({
    type: "profile.save",
    profile: {
      ...actual,
      name: "只改显示名称",
      status: "untested",
      capabilities: undefined,
    },
  });
  actual = snapshot.profiles[0]!;
  assert.equal(actual.testedAt, testedAt);
  assert.equal(actual.status, "ready");
  assert.equal(actual.capabilities?.text, true);
  await service.close();
  service = new WorkbenchService(path.join(dir, "data"), () => "synthetic-key");
  actual = service.store.profiles()[0]!;
  assert.equal(actual.testedAt, testedAt);
  snapshot = await service.execute({
    type: "profile.save",
    profile: { ...actual, modelId: "new-model" },
  });
  actual = snapshot.profiles[0]!;
  assert.equal(actual.status, "untested");
  assert.equal(actual.testedAt, undefined);
  assert.equal(actual.capabilities, undefined);
  assert.equal(actual.lastError, undefined);
  service.store.setConfig("profiles", [
    {
      ...actual,
      status: "ready",
      testedAt,
      capabilities: { text: true, tools: true, streaming: true },
    },
  ]);
  snapshot = await service.execute({
    type: "profile.save",
    profile: actual,
    keyChanged: true,
  });
  assert.equal(snapshot.profiles[0]!.status, "untested");
  assert.equal(snapshot.profiles[0]!.testedAt, undefined);
});

test("missing credentials report configuration state without issuing model requests", async (t) => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "ytriple-profile-no-key-"),
  );
  let calls = 0;
  const service = new WorkbenchService(
    dir,
    () => undefined,
    () => {},
    {
      modelFactory: () => {
        calls++;
        throw new Error("must not run");
      },
    },
  );
  t.after(async () => {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  configure(service, dir);
  const snapshot = await service.execute({
    type: "profile.probe",
    profileId: connection.id,
  });
  assert.equal(calls, 0);
  assert.equal(snapshot.profiles[0]!.status, "unconfigured");
  assert.match(snapshot.profiles[0]!.lastError!, /未找到密钥/);
});

test("saving a changed model cancels an in-flight standard probe and cannot apply its stale result", async (t) => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "ytriple-profile-cancel-"),
  );
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const model = new ScriptedModel([
    modelResponder(async () => {
      started();
      return new Promise(() => {});
    }),
  ]);
  const service = new WorkbenchService(
    dir,
    () => "synthetic-key",
    () => {},
    { modelFactory: () => model },
  );
  t.after(async () => {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  configure(service, dir);
  const probing = service.execute({
    type: "profile.probe",
    profileId: connection.id,
  });
  await ready;
  await service.execute({
    type: "profile.save",
    profile: { ...connection, modelId: "replacement-model" },
  });
  await probing;
  const actual = service.store.profiles()[0]!;
  assert.equal(actual.modelId, "replacement-model");
  assert.equal(actual.status, "untested");
  assert.equal(actual.testedAt, undefined);
  assert.equal(actual.lastError, undefined);
});
