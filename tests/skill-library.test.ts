import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { Store, uid, now } from "../src/core/store.js";
import {
  handleSkillCommand,
  managedSkillCatalog,
} from "../src/core/skill-library.js";
import {
  bindTaskSkills,
  setSkillEnabled,
  skillCatalog,
} from "../src/core/skill-policy.js";
import {
  BUILTIN_SKILLS,
  readSkillResource,
  skillDefinitionHash,
  skillAvailableToMember,
  validateSkillBindings,
} from "../src/core/skills.js";
import { skillCommandSchema } from "../src/shared/skill-library.js";
import { writeArtifact } from "../src/core/files.js";
import type {
  FeatureHost,
  FeatureTaskInput,
} from "../src/core/feature-host.js";
import type { Task } from "../src/shared/types.js";

async function setup(t: { after(fn: () => unknown): void }) {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "ytriple-skill-library-"),
  );
  const root = await fs.realpath(temporary);
  let store = new Store(path.join(root, "data"));
  store.setConfig("settings", {
    ...store.settings(),
    aiRoot: path.join(root, "AI"),
    codeRoot: path.join(root, "Code"),
    workspaceRoot: path.join(root, "work"),
  });
  const inputs: FeatureTaskInput[] = [],
    runs: string[] = [];
  const task = (id = uid()): Task => ({
    id,
    title: "已完成的资料工作",
    goal: "从真实资料整理可复用方法",
    goalVersion: 1,
    kind: "research",
    member: "researcher",
    workspace: path.join(root, "work", id),
    status: "completed",
    createdAt: now(),
    updatedAt: now(),
    messages: [],
    events: [],
    sources: [],
    artifacts: [],
  });
  const host: FeatureHost = {
    get store() {
      return store;
    },
    createWork: async (input) => {
      inputs.push(input);
      const created = {
        ...task(),
        title: input.title,
        goal: input.goal,
        skillPolicy: input.skillPolicy,
        sources: input.sources ?? [],
        status: "idle" as const,
      };
      store.saveTask(created);
      return created;
    },
    addSource: async () => undefined,
    runWork: async (id) => {
      runs.push(id);
    },
    stopWork: async () => undefined,
    isRunning: () => false,
  };
  t.after(async () => {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    host,
    inputs,
    runs,
    task,
    reopen: () => {
      store.close();
      store = new Store(path.join(root, "data"));
    },
  };
}
const text =
  "---\nname: 真实阅读方法\ndescription: 先核查来源，再整理结论。\nversion: 0.1.0\n---\n# 方法正文\n输入：实际文章。步骤：读来源、区分事实和判断、保存说明。失败：资料不足时保留缺口。";

test("own method import, editing and rollback preserve exact prior versions and pinned tasks across restart", async (t) => {
  const { host, task, reopen } = await setup(t);
  const requestId = uid();
  const command = {
    type: "skill.importText" as const,
    requestId,
    content: text,
    originURL: "https://example.com/method",
  };
  await Promise.all([
    handleSkillCommand(host, command),
    handleSkillCommand(host, command),
  ]);
  const id = `user-${requestId}`;
  let entry = skillCatalog(host.store).find((skill) => skill.id === id)!;
  assert.equal(entry.enabled, false);
  assert.equal(entry.validation, "unverified");
  assert.equal(entry.origin?.location, "https://example.com/method");
  assert.equal(
    skillCatalog(host.store).filter((skill) => skill.id === id).length,
    1,
  );
  setSkillEnabled(host.store, id, true);
  const work = {
    ...task(),
    skillPolicy: { mode: "explicit" as const, skillIds: [id] },
  };
  work.skillBindings = bindTaskSkills(host.store, work);
  const oldHash = work.skillBindings[0]!.hash;
  host.store.saveTask(work);
  await handleSkillCommand(host, {
    type: "skill.edit",
    requestId: uid(),
    skillId: id,
    expectedRevision: 1,
    input: {
      name: entry.name,
      description: entry.description,
      instructions: text + "\n新增经用户确认的修正。",
      dependencies: [],
      allowedMembers: ["researcher"],
    },
  });
  entry = skillCatalog(host.store).find((skill) => skill.id === id)!;
  assert.equal(entry.version, "0.1.1");
  assert.notEqual(entry.hash, oldHash);
  assert.equal(
    bindTaskSkills(host.store, work)[0]!.hash,
    oldHash,
    "a catalog edit never silently upgrades an existing task",
  );
  assert.equal(skillAvailableToMember(entry, "researcher"), true);
  assert.equal(skillAvailableToMember(entry, "coordinator"), false);
  const stale = {
    type: "skill.edit" as const,
    requestId: uid(),
    skillId: id,
    expectedRevision: 1,
    input: {
      name: entry.name,
      description: entry.description,
      instructions: text,
      dependencies: [],
      allowedMembers: ["researcher" as const],
    },
  };
  await assert.rejects(handleSkillCommand(host, stale), /Skill 已更新/);
  await handleSkillCommand(host, {
    type: "skill.activateVersion",
    requestId: uid(),
    skillId: id,
    expectedRevision: 2,
    versionHash: oldHash,
  });
  reopen();
  entry = skillCatalog(host.store).find((skill) => skill.id === id)!;
  assert.equal(entry.hash, oldHash);
  assert.equal(entry.versions?.length, 2);
  assert.equal(
    bindTaskSkills(host.store, host.store.task(work.id))[0]!.hash,
    oldHash,
  );
  await handleSkillCommand(host, {
    type: "skill.edit",
    requestId: uid(),
    skillId: id,
    expectedRevision: entry.revision!,
    input: {
      name: "只改名称后的方法",
      description: entry.description,
      instructions: entry.instructions,
      dependencies: [],
      allowedMembers: entry.allowedMembers as (
        "researcher" | "coordinator" | "cto" | "editor"
      )[],
    },
  });
  const renamed = skillCatalog(host.store).find((skill) => skill.id === id)!;
  assert.equal(renamed.name, "只改名称后的方法");
  assert.notEqual(
    renamed.hash,
    oldHash,
    "metadata-only edits remain a distinct recoverable version",
  );
  assert.match(renamed.instructions, /name: "只改名称后的方法"/);
});

test("trusted local package copies only bounded textual resources, records dependencies, and hashes resource and scope changes", async (t) => {
  const { host, root, task } = await setup(t);
  const packageRoot = path.join(root, "package");
  await fs.mkdir(path.join(packageRoot, "references"), { recursive: true });
  await fs.mkdir(path.join(packageRoot, "scripts"));
  await fs.writeFile(
    path.join(packageRoot, "SKILL.md"),
    text.replace(
      "version: 0.1.0",
      "version: 0.1.0\ndependencies:\n  - 阅读工具",
    ),
  );
  await fs.writeFile(
    path.join(packageRoot, "references", "example.md"),
    "明确提供的样例正文。",
  );
  await fs.writeFile(
    path.join(packageRoot, "scripts", "do.sh"),
    "touch SHOULD_NOT_EXIST",
  );
  const requestId = uid();
  await handleSkillCommand(host, {
    type: "skill.importLocal.path",
    requestId,
    selectedPath: path.join(packageRoot, "SKILL.md"),
  });
  const id = `user-${requestId}`;
  let entry = skillCatalog(host.store).find((skill) => skill.id === id)!;
  assert.equal(entry.source, "local");
  assert.equal(entry.resources?.length, 1);
  assert.equal(entry.resources?.[0]!.path, "references/example.md");
  assert.equal(entry.dependencies?.[0]!.status, "unknown");
  assert.equal(entry.availability, "missing-dependencies");
  setSkillEnabled(host.store, id, true);
  await assert.rejects(
    async () =>
      bindTaskSkills(host.store, {
        ...task(),
        skillPolicy: { mode: "explicit", skillIds: [id] },
      }),
    /依赖尚未确认/,
  );
  await handleSkillCommand(host, {
    type: "skill.edit",
    requestId: uid(),
    skillId: id,
    expectedRevision: 1,
    input: {
      name: entry.name,
      description: entry.description,
      instructions: entry.instructions,
      dependencies: [
        {
          name: "阅读工具",
          status: "available",
          evidence: "在指定工作中实际完成样例读取",
        },
      ],
      allowedMembers: ["researcher"],
    },
  });
  entry = skillCatalog(host.store).find((skill) => skill.id === id)!;
  assert.equal(
    readSkillResource(entry, "researcher", "references/example.md").text,
    "明确提供的样例正文。",
  );
  assert.throws(
    () => readSkillResource(entry, "cto", "references/example.md"),
    /没有使用/,
  );
  assert.throws(
    () => readSkillResource(entry, "researcher", "../../private.txt"),
    /不在已绑定/,
  );
  assert.throws(
    () => readSkillResource(entry, "researcher", "scripts/do.sh"),
    /不在已绑定/,
  );
  const changedResource = structuredClone(entry);
  changedResource.resources![0]!.content += "tampered";
  assert.throws(() => validateSkillBindings([changedResource]), /哈希不一致/);
  assert.notEqual(
    skillDefinitionHash({ ...entry, allowedMembers: ["coordinator"] }),
    entry.hash,
  );
  await fs.writeFile(
    path.join(packageRoot, "references", "example.md"),
    "原目录后续修改不影响绑定",
  );
  assert.equal(
    readSkillResource(entry, "researcher", "references/example.md").text,
    "明确提供的样例正文。",
  );
  await fs.symlink(
    path.join(root, "outside.md"),
    path.join(packageRoot, "references", "escape.md"),
  );
  await assert.rejects(
    handleSkillCommand(host, {
      type: "skill.importLocal.path",
      requestId: uid(),
      selectedPath: path.join(packageRoot, "SKILL.md"),
    }),
    /符号链接/,
  );
});

test("skill feedback requires stated conditions and same-version usage evidence, without promoting installation to validation", async (t) => {
  const { host, task } = await setup(t);
  const builtin = BUILTIN_SKILLS[0]!;
  const work = task();
  host.store.saveTask(work);
  const feedback = {
    type: "skill.feedback" as const,
    requestId: uid(),
    skillId: builtin.id,
    versionHash: builtin.hash,
    outcome: "useful" as const,
    conditions: "短篇来源完整的说明",
    observation: "接收方能正确复述关键依据",
    evidence: "用户实际复述核查记录",
    taskId: work.id,
  };
  await assert.rejects(handleSkillCommand(host, feedback), /没有实际加载/);
  host.store.event(work.id, {
    type: "skill_loaded",
    member: "researcher",
    goalVersion: 1,
    summary: "真实方法读取记录",
    data: { skillId: builtin.id, hash: builtin.hash },
  });
  await handleSkillCommand(host, feedback);
  assert.equal(
    skillCatalog(host.store).find((entry) => entry.id === builtin.id)!
      .validation,
    "observed-useful",
  );
  await handleSkillCommand(host, {
    ...feedback,
    requestId: uid(),
    outcome: "correction",
    observation: "长篇材料遗漏了反例",
    conditions: "长篇多来源内容",
  });
  assert.equal(
    skillCatalog(host.store).find((entry) => entry.id === builtin.id)!
      .validation,
    "needs-review",
  );
  assert.equal(
    skillCommandSchema.safeParse({
      ...feedback,
      requestId: uid(),
      conditions: "",
    }).success,
    false,
  );
  assert.equal(
    skillCommandSchema.safeParse({
      type: "skill.importLocal",
      requestId: uid(),
      selectedPath: "/private/SKILL.md",
    }).success,
    false,
    "renderer cannot forge a file-picker selection",
  );
  await assert.rejects(
    handleSkillCommand(host, {
      type: "skill.importText",
      requestId: uid(),
      name: "只是链接",
      content: "https://example.com/SKILL.md",
    }),
    /链接不是方法正文/,
  );
});

test("a real saved artifact can become a reviewed candidate or a context-limited extraction task", async (t) => {
  const { host, task, inputs, runs } = await setup(t);
  const work = task();
  host.store.saveTask(work);
  const artifact = await writeArtifact(host.store, work.id, {
    title: "可复用阅读方法",
    format: "md",
    content: text,
    goalVersion: 1,
  });
  const requestId = uid();
  await handleSkillCommand(host, {
    type: "skill.extract",
    requestId,
    taskId: work.id,
    artifactId: artifact.id,
    expectedHash: artifact.hash,
    instruction: "保留失败条件和实际样例",
  });
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0]!.isolatedContext, true);
  assert.match(inputs[0]!.goal, /不自行启用、安装/);
  assert.equal(inputs[0]!.sources![0]!.text, text);
  assert.equal(runs.length, 1);
  const extraction = host.store.tasks().find((entry) => entry.id !== work.id)!;
  assert.ok(
    extraction.events.some((event) => event.type === "skill.draft_created"),
  );
  assert.equal(
    managedSkillCatalog(host.store).some((entry) => entry.source === "derived"),
    false,
    "extraction alone does not install a method",
  );
  await handleSkillCommand(host, {
    type: "skill.fromArtifact",
    requestId: uid(),
    taskId: work.id,
    artifactId: artifact.id,
    expectedHash: artifact.hash,
  });
  const imported = skillCatalog(host.store).find(
    (entry) => entry.source === "derived",
  )!;
  assert.equal(imported.origin?.artifactHash, artifact.hash);
  assert.equal(imported.enabled, false);
  assert.equal(imported.validation, "unverified");
  await fs.writeFile(artifact.path, "# 在外部改变的内容");
  await assert.rejects(
    handleSkillCommand(host, {
      type: "skill.fromArtifact",
      requestId: uid(),
      taskId: work.id,
      artifactId: artifact.id,
      expectedHash: artifact.hash,
    }),
    /外部修改/,
  );
  await assert.rejects(
    handleSkillCommand(host, {
      type: "skill.extract",
      requestId: uid(),
      taskId: work.id,
      artifactId: artifact.id,
      expectedHash: artifact.hash,
      instruction: "提炼",
    }),
    /外部修改/,
  );
  assert.equal(
    inputs.length,
    1,
    "external changes cannot be presented as approved source bytes",
  );
});

test("URL import records actual fetched scope and blocks missing attachment dependencies", async (t) => {
  const { host } = await setup(t);
  let reads = 0;
  host.readURL = async (url) => {
    reads += 1;
    return {
      id: uid(),
      type: "url",
      title: "SKILL.md",
      location: url,
      text: text + "\n参看 [样例](references/example.md)。",
      coverage: "实际HTTP返回的文本正文",
      addedAt: now(),
    };
  };
  const command = {
    type: "skill.importURL" as const,
    requestId: uid(),
    url: "https://example.com/SKILL.md",
  };
  await handleSkillCommand(host, command);
  await handleSkillCommand(host, command);
  const entry = skillCatalog(host.store).find(
    (skill) => skill.id === `user-${command.requestId}`,
  )!;
  assert.equal(reads, 1);
  assert.equal(entry.origin?.location, command.url);
  assert.match(entry.origin?.coverage ?? "", /实际HTTP返回/);
  assert.match(entry.origin?.coverage ?? "", /附带资料未读取/);
  assert.equal(entry.availability, "missing-dependencies");
  assert.equal(entry.resources?.length, 0);
  host.readURL = async () => {
    throw new Error("private URL denied");
  };
  await assert.rejects(
    handleSkillCommand(host, {
      type: "skill.importURL",
      requestId: uid(),
      url: "https://private.example/SKILL.md",
    }),
    /本地 SKILL.md/,
  );
});

test("large libraries keep task candidates bounded without losing explicit choice", async (t) => {
  const { host, task } = await setup(t);
  let lastId = "";
  for (let index = 0; index < 35; index += 1) {
    const requestId = uid();
    lastId = `user-${requestId}`;
    await handleSkillCommand(host, {
      type: "skill.importText",
      requestId,
      name: `方法 ${index}`,
      content: text,
    });
    setSkillEnabled(host.store, lastId, true);
  }
  const automatic = bindTaskSkills(host.store, task());
  assert.equal(automatic.length, 32);
  assert.equal(
    bindTaskSkills(host.store, {
      ...task(),
      skillPolicy: { mode: "explicit", skillIds: [lastId] },
    })[0]!.id,
    lastId,
  );
});

test("portable skill records preserve resources and version feedback while restoring separate disabled identities", async (t) => {
  const { exportManagedSkills, importManagedSkills, assertNoSkillCredentials } =
    await import("../src/core/skill-library.js");
  const { host, root } = await setup(t);
  const requestId = uid(),
    id = `user-${requestId}`;
  await handleSkillCommand(host, {
    type: "skill.importText",
    requestId,
    content: text,
  });
  let entry = skillCatalog(host.store).find((skill) => skill.id === id)!;
  await handleSkillCommand(host, {
    type: "skill.feedback",
    requestId: uid(),
    skillId: id,
    versionHash: entry.hash,
    outcome: "useful",
    conditions: "实际短篇材料",
    observation: "用户成功复述",
    evidence: "用户手动核对记录",
  });
  const records = exportManagedSkills(host.store);
  const destination = new Store(path.join(root, "restored-data"));
  destination.setConfig("settings", {
    ...destination.settings(),
    aiRoot: path.join(root, "restored-AI"),
    workspaceRoot: path.join(root, "restored-work"),
  });
  try {
    const importId = uid();
    const mapping = await importManagedSkills(destination, records, importId);
    assert.deepEqual(
      await importManagedSkills(destination, records, importId),
      mapping,
    );
    assert.notEqual(mapping[id], id);
    entry = skillCatalog(destination).find(
      (skill) => skill.id === mapping[id],
    )!;
    assert.equal(entry.enabled, false);
    assert.equal(entry.instructions, text);
    assert.equal(entry.feedback?.[0]!.conditions, "实际短篇材料");
    const tampered = structuredClone(records);
    tampered[0]!.versions[0]!.definition.resources = [
      { path: "../../escape.md", content: "escape", hash: "0".repeat(64) },
    ];
    await assert.rejects(
      importManagedSkills(destination, tampered, uid()),
      /不能加载/,
    );
    const secret = `sk-${"privatecredential".repeat(3)}`;
    const suspicious = {
      ...BUILTIN_SKILLS[0]!,
      instructions: Buffer.from(secret).toString("base64"),
    };
    suspicious.hash = skillDefinitionHash(suspicious);
    assert.throws(
      () => assertNoSkillCredentials([suspicious]),
      /编码后的疑似凭据/,
    );
  } finally {
    destination.close();
  }
});
