import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkbenchService } from "../src/core/service.js";
import { createGoogleAgentModel } from "../src/core/google-agents.js";
import { parseCommand } from "../src/desktop/commands.js";
import { normalizeTeamSettings } from "../src/shared/member-settings.js";

test("public process becomes editable Markdown and Lib asset; member settings survive reopening", async (t) => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "ytriple-service-settings-"),
  );
  let service = new WorkbenchService(path.join(dir, "data"), () => undefined);
  t.after(async () => {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  service.store.setConfig("settings", {
    ...service.store.settings(),
    aiRoot: path.join(dir, "AI"),
    codeRoot: path.join(dir, "Code"),
    workspaceRoot: path.join(dir, "work"),
    projectMonitoring: false,
  });
  let snap = await service.initialize();
  const members = normalizeTeamSettings(snap.settings.memberSettings);
  members.researcher = {
    prompt: "先比较相反观点，再总结。",
    responseStyle: "balanced",
    delegation: "off",
  };
  snap = await service.execute(
    parseCommand({
      type: "settings.save",
      settings: { ...snap.settings, memberSettings: members },
    }),
  );
  assert.equal(
    snap.settings.memberSettings?.researcher.prompt,
    members.researcher.prompt,
  );
  snap = await service.execute({ type: "task.create", goal: "合成阅读目标" });
  const task = snap.tasks[0]!;
  service.store.event(task.id, {
    type: "progress_reported",
    member: "researcher",
    summary: "公开结论：先核查依据。",
    goalVersion: task.goalVersion,
    data: { stage: "finding", raw_reasoning: "PRIVATE_SECRET" },
  });
  snap = await service.execute(
    parseCommand({
      type: "process.save",
      taskId: task.id,
      member: "researcher",
    }),
  );
  let artifact = snap.tasks[0]!.artifacts.at(-1)!;
  assert.ok(artifact.content?.includes("公开结论"));
  assert.ok(!artifact.content?.includes("PRIVATE_SECRET"));
  assert.equal(artifact.format, "md");
  snap = await service.execute({
    type: "artifact.save",
    taskId: task.id,
    artifactId: artifact.id,
    expectedHash: artifact.hash,
    content: artifact.content + "\n补充：用于后续工作。",
  });
  artifact = snap.tasks[0]!.artifacts.at(-1)!;
  assert.equal(artifact.version, 2);
  snap = await service.execute({
    type: "library.collect",
    taskId: task.id,
    artifactId: artifact.id,
    expectedHash: artifact.hash,
  });
  assert.equal(snap.library?.length, 1);
  assert.ok(snap.library?.[0]?.content?.includes("用于后续工作"));
  await service.close();
  service = new WorkbenchService(path.join(dir, "data"), () => undefined);
  snap = await service.initialize();
  assert.equal(snap.settings.memberSettings?.researcher.delegation, "off");
  assert.equal(snap.tasks[0]!.artifacts[0]!.version, 2);
});
test("IPC validates member setting limits and prevents specialized agent IDs being saved as ordinary models", async (t) => {
  const settings = {
    aiRoot: "/tmp/AI",
    codeRoot: "/tmp/Code",
    workspaceRoot: "/tmp/work",
    defaultProfileId: "gemini",
    memberProfiles: { coordinator: "", cto: "", researcher: "" },
    memberSettings: normalizeTeamSettings(undefined),
  };
  assert.doesNotThrow(() => parseCommand({ type: "settings.save", settings }));
  settings.memberSettings.cto.prompt = "x".repeat(12001);
  assert.throws(() => parseCommand({ type: "settings.save", settings }));
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "ytriple-service-config-"),
  );
  const service = new WorkbenchService(dir, () => undefined);
  t.after(async () => {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  await assert.rejects(
    service.execute({
      type: "profile.save",
      profile: {
        id: "research",
        name: "research",
        provider: "gemini",
        protocol: "google",
        modelId: "deep-research-preview-04-2026",
        baseURL: "",
        apiKeyEnv: "GEMINI_API_KEY",
        hasKey: false,
        status: "untested",
      },
    }),
    /专项 Agent/,
  );
});

test("closing the service cancels an active Google connection probe before closing its store", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ytriple-probe-close-"));
  let startResolve!: () => void;
  const started = new Promise<void>((resolve) => {
    startResolve = resolve;
  });
  const calls: string[] = [];
  const service = new WorkbenchService(
    path.join(dir, "data"),
    () => "synthetic-key",
    () => {},
    {
      googleAgentFactory: (profile, readKey) =>
        createGoogleAgentModel(profile, readKey, {
          pollMs: 10000,
          onProgress: (summary) => {
            if (summary.includes("已接收")) startResolve();
          },
          fetch: async (url, init) => {
            calls.push(`${init?.method} ${String(url)}`);
            return new Response(
              JSON.stringify({
                id: "probe_remote_id",
                status: String(url).endsWith("/cancel")
                  ? "cancelled"
                  : "in_progress",
              }),
              { headers: { "content-type": "application/json" } },
            );
          },
        }),
    },
  );
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  service.store.setConfig("settings", {
    ...service.store.settings(),
    aiRoot: path.join(dir, "AI"),
    codeRoot: path.join(dir, "Code"),
    workspaceRoot: path.join(dir, "work"),
    projectMonitoring: false,
  });
  await service.execute({
    type: "profile.save",
    profile: {
      id: "probe",
      name: "synthetic probe",
      provider: "gemini",
      protocol: "google",
      execution: "google-agent",
      modelId: "deep-research-preview-04-2026",
      baseURL: "",
      apiKeyEnv: "GEMINI_API_KEY",
      hasKey: true,
      status: "untested",
    },
  });
  const result = service
    .execute({ type: "profile.probe", profileId: "probe" })
    .then(
      () => null,
      (error) => error,
    );
  await started;
  await service.close();
  assert.match((await result).message, /关闭/);
  assert.equal(calls.length, 2);
  assert.ok(calls.at(-1)?.endsWith("/probe_remote_id/cancel"));
});
