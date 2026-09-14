import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ProjectDiscovery } from "../src/core/projects.js";
const exec = promisify(execFile);

async function setup(t: { after(fn: () => unknown): void }) {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "ytriple-projects-"),
  );
  const root = await fs.realpath(temporary),
    aiRoot = path.join(root, "AI"),
    codeRoot = path.join(root, "Code");
  await fs.mkdir(path.join(aiRoot, "system/projects"), { recursive: true });
  await fs.mkdir(codeRoot);
  await fs.writeFile(
    path.join(aiRoot, "system/system.json"),
    JSON.stringify({
      schema_version: 1,
      project_manifest_glob: "projects/*.json",
    }),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  async function repository(relative: string, branch = "dev") {
    const directory = path.join(codeRoot, relative);
    await fs.mkdir(directory, { recursive: true });
    await exec("git", ["init", "--initial-branch=" + branch, directory]);
    await fs.writeFile(
      path.join(directory, "README.md"),
      "合成文档，不作为产品设计参考。",
    );
    await fs.writeFile(path.join(directory, "AGENTS.md"), "合成规则");
    await exec("git", ["-C", directory, "add", "README.md", "AGENTS.md"]);
    await exec("git", [
      "-C",
      directory,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "Fixture",
    ]);
    return directory;
  }
  async function register(
    id: string,
    project: string,
    dev: string,
    extra: Record<string, unknown> = {},
  ) {
    await fs.writeFile(
      path.join(aiRoot, "system/projects", id + ".json"),
      JSON.stringify({
        schema_version: 1,
        id,
        name: id,
        series: "y",
        lifecycle: "active",
        target_root: project,
        worktrees: [{ path: dev, branch: "dev", role: "dev" }],
        documents: { entry: path.join(dev, "README.md") },
        ...extra,
      }),
    );
  }
  return { root, aiRoot, codeRoot, repository, register };
}

test("中央登记与 Code 实际项目合并，main/dev/task 不重复显示为项目", async (t) => {
  const { aiRoot, codeRoot, repository, register } = await setup(t);
  const dev = await repository("y/example/example-dev"),
    project = path.dirname(dev);
  await exec("git", [
    "-C",
    dev,
    "worktree",
    "add",
    "-b",
    "codex/check",
    path.join(project, "example-task"),
  ]);
  await register("example", project, dev);
  const local = await repository("x/experiment/experiment-dev");
  await repository("standalone");
  const discovery = new ProjectDiscovery(),
    result = await discovery.refresh(aiRoot, codeRoot);
  assert.equal(result.projects.length, 3);
  const registered = result.projects.find((entry) => entry.id === "example")!;
  assert.equal(registered.registered, true);
  assert.equal(registered.observation!.worktrees.length, 2);
  assert.deepEqual(
    registered.observation!.worktrees.map((worktree) => worktree.branch).sort(),
    ["codex/check", "dev"],
  );
  assert.equal(registered.observation!.state, "ready");
  assert.equal(
    result.projects.find((entry) => entry.root === path.dirname(local))!
      .registered,
    false,
  );
  assert.equal(result.discovery.status, "ready");
  assert.deepEqual(result.discovery.changes, []);
});

test("自定义分组下的同级 main/dev/task 工作树也合并为一个本地项目", async (t) => {
  const { aiRoot, codeRoot, repository } = await setup(t);
  const main = await repository("clients/example/example-main", "main"),
    container = path.dirname(main);
  await exec("git", [
    "-C",
    main,
    "worktree",
    "add",
    "-b",
    "dev",
    path.join(container, "example-dev"),
  ]);
  await exec("git", [
    "-C",
    main,
    "worktree",
    "add",
    "-b",
    "codex/task",
    path.join(container, "example-pilot"),
  ]);
  // Even a nested repository inside an existing repository is not visited as a separate product.
  await repository("clients/example/example-dev/source/nested-repository");
  const result = await new ProjectDiscovery().refresh(aiRoot, codeRoot);
  assert.equal(result.projects.length, 1);
  assert.equal(result.projects[0]!.name, "example");
  assert.equal(result.projects[0]!.root, container);
  assert.equal(
    result.projects[0]!.devPath,
    path.join(container, "example-dev"),
  );
  assert.equal(result.projects[0]!.observation!.worktrees.length, 3);
  assert.deepEqual(
    result.projects[0]!.observation!.worktrees.map(
      (worktree) => worktree.branch,
    ).sort(),
    ["codex/task", "dev", "main"],
  );
});

test("缓存快照不重复扫描；刷新识别同一文件继续修改与新增、消失项目", async (t) => {
  const { aiRoot, codeRoot, repository } = await setup(t);
  const directory = await repository("reading");
  const monitor = new ProjectDiscovery();
  const first = monitor.refresh(aiRoot, codeRoot),
    concurrent = monitor.refresh(aiRoot, codeRoot);
  assert.equal(
    first,
    concurrent,
    "concurrent refreshes should share one filesystem scan",
  );
  const initial = await first;
  await fs.writeFile(path.join(directory, "README.md"), "第一次修改");
  assert.equal(
    monitor.snapshot.projects[0]!.observation!.fingerprint,
    initial.projects[0]!.observation!.fingerprint,
  );
  const second = await monitor.refresh(aiRoot, codeRoot);
  assert.equal(second.discovery.changes[0]!.kind, "changed");
  assert.equal(second.projects[0]!.observation!.worktrees[0]!.changedFiles, 1);
  await fs.writeFile(
    path.join(directory, "README.md"),
    "同一文件的第二次、内容更长的修改",
  );
  const third = await monitor.refresh(aiRoot, codeRoot);
  assert.equal(third.discovery.changes[0]!.kind, "changed");
  assert.notEqual(
    third.projects[0]!.observation!.fingerprint,
    second.projects[0]!.observation!.fingerprint,
  );
  const another = await repository("another");
  const added = await monitor.refresh(aiRoot, codeRoot);
  assert.ok(added.discovery.changes.some((change) => change.kind === "added"));
  await fs.rm(another, { recursive: true });
  const removed = await monitor.refresh(aiRoot, codeRoot);
  assert.ok(
    removed.discovery.changes.some((change) => change.kind === "removed"),
  );
  const unchanged = await monitor.refresh(aiRoot, codeRoot);
  assert.deepEqual(unchanged.discovery.changes, []);
});

test("一个坏登记不隐藏其他项目；已登记缺失目录明确显示", async (t) => {
  const { aiRoot, codeRoot, repository, register } = await setup(t);
  await fs.writeFile(
    path.join(aiRoot, "system/projects/broken.json"),
    "{ invalid JSON",
  );
  await register(
    "missing",
    path.join(codeRoot, "y/missing"),
    path.join(codeRoot, "y/missing/missing-dev"),
  );
  await repository("local");
  const result = await new ProjectDiscovery().refresh(aiRoot, codeRoot);
  assert.equal(result.projects.length, 2);
  assert.equal(
    result.projects.find((project) => project.id === "missing")!.observation!
      .state,
    "missing",
  );
  assert.equal(result.discovery.status, "partial");
  assert.ok(
    result.discovery.errors.some((error) => error.includes("broken.json")),
  );
});

test("登记文件名与合法 ID 不一致时保留登记上下文并报告漂移", async (t) => {
  const { aiRoot, codeRoot, repository, register } = await setup(t);
  const dev = await repository("z/example.app/example.app-dev");
  await register("example.app", path.dirname(dev), dev);
  const original = path.join(aiRoot, "system/projects/example.app.json"),
    renamed = path.join(aiRoot, "system/projects/example-app.json");
  await fs.rename(original, renamed);
  const result = await new ProjectDiscovery().refresh(aiRoot, codeRoot);
  assert.equal(result.projects.length, 1);
  assert.equal(result.projects[0]!.id, "example.app");
  assert.equal(result.projects[0]!.registered, true);
  assert.ok(
    result.projects[0]!.observation!.issues.some((issue) =>
      issue.includes("文件名与项目 ID 不一致"),
    ),
  );
  assert.equal(result.discovery.status, "partial");
  assert.equal((await fs.stat(renamed)).isFile(), true);
  await assert.rejects(fs.stat(original), { code: "ENOENT" });
});

test("符号链接、依赖目录与隐藏目录跳过，越界登记不读取", async (t) => {
  const { root, aiRoot, codeRoot, repository, register } = await setup(t);
  await repository("safe");
  await repository("node_modules/should-not-see");
  await repository(".hidden/should-not-see");
  const outside = path.join(root, "private-project");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "README.md"), "绝不能显示的合成正文");
  await fs.symlink(outside, path.join(codeRoot, "outside-link"));
  await register("outside", outside, outside);
  const result = await new ProjectDiscovery().refresh(aiRoot, codeRoot);
  assert.equal(result.projects.length, 1);
  assert.equal(result.projects[0]!.name, "safe");
  assert.ok(
    result.discovery.errors.some((error) => error.includes("当前 Code")),
  );
  assert.ok(!JSON.stringify(result).includes("绝不能显示"));
});

test("Git 只读检查不运行 fsmonitor 或 manifest 携带的命令", async (t) => {
  const { root, aiRoot, codeRoot, repository, register } = await setup(t);
  const directory = await repository("y/safe/safe-dev"),
    marker = path.join(root, "unexpected-execution");
  const hook = path.join(root, "fsmonitor-hook");
  await fs.writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
  await exec("git", ["-C", directory, "config", "core.fsmonitor", hook]);
  await register("safe", path.dirname(directory), directory, {
    command: hook,
    monitoring: { enabled: true, probes: ["git"], command: hook },
  });
  const index = path.join(directory, ".git/index"),
    before = await fs.stat(index);
  const result = await new ProjectDiscovery().refresh(aiRoot, codeRoot);
  assert.equal(result.projects[0]!.observation!.worktrees[0]!.state, "ready");
  await assert.rejects(fs.stat(marker), { code: "ENOENT" });
  assert.equal((await fs.stat(index)).mtimeMs, before.mtimeMs);
});

test("观察 Git 不执行项目里的 clean/process filter 或 include 配置", async (t) => {
  const { root, aiRoot, codeRoot, repository } = await setup(t);
  const directory = await repository("filtered-project"),
    marker = path.join(root, "filter-executed");
  const hook = path.join(root, "filter-hook");
  await fs.writeFile(hook, `#!/bin/sh\ntouch '${marker}'\ncat\n`, {
    mode: 0o700,
  });
  await exec("git", [
    "-C",
    directory,
    "config",
    "filter.synthetic.clean",
    hook,
  ]);
  await exec("git", [
    "-C",
    directory,
    "config",
    "filter.synthetic.process",
    hook,
  ]);
  await exec("git", [
    "-C",
    directory,
    "config",
    "filter.synthetic.required",
    "true",
  ]);
  await exec("git", [
    "-C",
    directory,
    "config",
    "include.path",
    path.join(root, "nonexistent-include"),
  ]);
  await fs.writeFile(
    path.join(directory, ".gitattributes"),
    "README.md filter=synthetic\n",
  );
  await fs.writeFile(
    path.join(directory, "README.md"),
    "为触发内容检查而修改的合成正文",
  );
  const result = await new ProjectDiscovery().refresh(aiRoot, codeRoot);
  assert.equal(result.projects[0]!.observation!.worktrees[0]!.state, "ready");
  assert.equal(result.projects[0]!.observation!.worktrees[0]!.changedFiles, 2);
  await assert.rejects(fs.stat(marker), { code: "ENOENT" });
});

test("Git config 与对象中的符号链接在调用 Git 前被拒绝", async (t) => {
  const { root, aiRoot, codeRoot, repository } = await setup(t);
  const configRepo = await repository("config-link"),
    objectRepo = await repository("object-link");
  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(
    path.join(outside, "config"),
    "[core]\nrepositoryformatversion = 0\n",
  );
  await fs.rm(path.join(configRepo, ".git/config"));
  await fs.symlink(
    path.join(outside, "config"),
    path.join(configRepo, ".git/config"),
  );
  await fs.symlink(
    outside,
    path.join(objectRepo, ".git/objects/linked-objects"),
  );
  const result = await new ProjectDiscovery().refresh(aiRoot, codeRoot);
  assert.equal(result.projects.length, 2);
  for (const project of result.projects)
    assert.equal(project.observation!.worktrees[0]!.state, "error");
});

test("Git 指针和登记文档越出允许根时不读取，异常状态明确保留", async (t) => {
  const { root, aiRoot, codeRoot, register } = await setup(t);
  const project = path.join(codeRoot, "y/unsafe"),
    dev = path.join(project, "unsafe-dev");
  await fs.mkdir(dev, { recursive: true });
  const outside = path.join(root, "outside-git");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(dev, ".git"), `gitdir: ${outside}`);
  const privateDoc = path.join(root, "private.md");
  await fs.writeFile(privateDoc, "合成机密正文");
  await fs.symlink(privateDoc, path.join(dev, "README.md"));
  await register("unsafe", project, dev);
  const result = await new ProjectDiscovery().refresh(aiRoot, codeRoot),
    observed = result.projects[0]!.observation!;
  assert.equal(observed.worktrees[0]!.state, "error");
  assert.equal(
    observed.documents.find((doc) => doc.name === "entry")!.state,
    "error",
  );
  assert.ok(!JSON.stringify(result).includes("合成机密正文"));
});

test("配置根切换隔离缓存，缺失根读取失败不冒充空项目列表", async (t) => {
  const { root, aiRoot, codeRoot, repository } = await setup(t);
  await repository("project-one");
  const monitor = new ProjectDiscovery();
  await monitor.refresh(aiRoot, codeRoot);
  const secondCode = path.join(root, "OtherCode");
  await fs.mkdir(secondCode);
  const next = await monitor.refresh(aiRoot, secondCode);
  assert.deepEqual(next.projects, []);
  assert.equal(next.discovery.codeRoot, secondCode);
  const failed = await monitor.refresh(aiRoot, path.join(root, "missing-root"));
  assert.equal(failed.discovery.status, "failed");
  assert.ok(failed.discovery.errors[0]!.includes("Code 根目录"));
});

test("深度限制明确标记不完整，不深入无界目录树", async (t) => {
  const { aiRoot, codeRoot, repository } = await setup(t);
  await repository("a/b/c/d/e/f/deep-project");
  const result = await new ProjectDiscovery().refresh(aiRoot, codeRoot);
  assert.equal(result.discovery.truncated, true);
  assert.equal(result.discovery.status, "partial");
  assert.ok(
    !result.projects.some((project) => project.name === "deep-project"),
  );
});
