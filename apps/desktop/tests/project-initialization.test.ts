import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  realpath,
  writeFile,
  readFile,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Store } from "../src/core/store";
import { LocalDirectories } from "../src/core/local-directories";
import {
  ProjectInitialization,
  type InitializationPlan,
} from "../src/core/project-initialization";
import type { ArtifactVersion, Decision } from "../src/core/types";
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "ytriple-init-"))),
    ai = join(home, "AI"),
    code = join(home, "Code");
  for (const dir of ["AI/system/projects", "Code/x", "Code/y", "Code/z"])
    await mkdir(join(home, dir), { recursive: true });
  await writeFile(
    join(ai, "system/system.json"),
    JSON.stringify({
      schema_version: 1,
      system_id: "local-ai-control-plane",
      root: ai,
      code_root: code,
      project_manifest_glob: "projects/*.json",
      policy: "POLICY.md",
    }),
  );
  await writeFile(
    join(ai, "system/series.json"),
    JSON.stringify({
      schema_version: 1,
      layout: {
        container: join(code, "{series}/{project}"),
        main_worktree: "{project}-main",
        dev_worktree: "{project}-dev",
        feature_base: "dev",
        stable_integration: "dev-to-main",
      },
      series: ["x", "y", "z"].map((id) => ({ id, code_root: join(code, id) })),
    }),
  );
  await writeFile(
    join(ai, "system/POLICY.md"),
    "# 本机规则\n建立 main/dev，先预览再初始化。",
  );
  const store = new Store(join(home, "db"));
  await new LocalDirectories(store).discover(home);
  const project = store.createProject(
    "阅读札记",
    "帮助读者整理阅读笔记",
    "software",
  );
  const run = store.submit({
    key: randomUUID(),
    context: "new",
    projectId: project.id,
    text: "明确产品目标、使用流程和验收",
    refs: [],
    recipient: null,
  });
  store.setRun(run.id, { status: "running" });
  store.finish(
    run.id,
    "# 阅读札记\n\n目标：本地整理笔记。\n流程：添加笔记、检索、回看。\n验收：重启后笔记可找回。\n未决：是否支持导入旧笔记。",
    true,
  );
  const version = store.all<ArtifactVersion>("version")[0];
  const service = new ProjectInitialization(store);
  const input = {
    projectId: project.id,
    versionId: version.id,
    slug: "reading-notes",
    series: "y" as const,
    template: "software-handoff-v1" as const,
  };
  return {
    home,
    ai,
    code,
    store,
    project,
    version,
    service,
    input,
    close: async () => {
      store.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
const git = (path: string, ...args: string[]) =>
  execFileSync("/usr/bin/git", ["-C", path, ...args], {
    encoding: "utf8",
  }).trim();
test("preview freezes exact product definition and explicit execution creates real main/dev, matching registry and handoff without remote or extra model runs", async () => {
  const f = await fixture();
  try {
    const before = f.store.snapshot().runs.length;
    const p = await f.service.preview(f.input);
    await assert.rejects(stat(p.container), { code: "ENOENT" });
    await assert.rejects(stat(p.manifestPath), { code: "ENOENT" });
    assert.equal(p.files["docs/PRODUCT.md"], f.version.body);
    const result = await f.service.execute(p.id);
    assert.equal(result.status, "complete");
    assert.equal(git(result.main, "branch", "--show-current"), "main");
    assert.equal(git(result.dev, "branch", "--show-current"), "dev");
    assert.equal(
      git(result.main, "rev-parse", "HEAD"),
      git(result.dev, "rev-parse", "HEAD"),
    );
    assert.equal(git(result.dev, "status", "--porcelain"), "");
    assert.equal(git(result.main, "remote"), "");
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.repository, null);
    assert.equal(manifest.worktrees[1].path, result.dev);
    assert.equal(
      await readFile(join(result.dev, "docs/PRODUCT.md"), "utf8"),
      f.version.body,
    );
    assert.match(
      await readFile(join(result.dev, "docs/HANDOFF.md"), "utf8"),
      /未执行应用测试/,
    );
    assert.ok(
      (await readFile(join(result.dev, "AGENTS.md"), "utf8")).includes(
        result.manifestPath,
      ),
    );
    assert.equal(f.store.snapshot().projects[0].directory, result.dev);
    assert.equal(
      f.store.snapshot().suggestionDocuments[0].path,
      join(result.dev, "docs/SUGGESTIONS.md"),
    );
    assert.equal(f.store.snapshot().runs.length, before);
    const again = await f.service.execute(p.id);
    assert.equal(again.commit, result.commit);
    assert.equal(git(result.main, "rev-list", "--count", "HEAD"), "1");
  } finally {
    await f.close();
  }
});
test("preview includes actual unresolved decisions and changed source or policy stops before directory creation", async () => {
  const f = await fixture();
  try {
    f.store.put<Decision>("decision", "pending", {
      id: "pending",
      revision: 1,
      workId: f.version.workId,
      runId: f.version.runId!,
      contributionId: "stage",
      stage: 0,
      attempt: 1,
      baseVersionId: f.version.id,
      status: "pending",
      draft: "",
      draftRevision: 0,
      answer: null,
      question: "需要导入旧笔记吗？",
      reason: "影响导入格式",
      impact: "影响首版范围",
      options: [],
      createdAt: new Date().toISOString(),
      answeredAt: null,
    });
    const p = await f.service.preview(f.input);
    assert.match(p.files["docs/HANDOFF.md"], /需要导入旧笔记吗？/);
    f.store.put("project", f.project.id, { ...f.project, goal: "新的目标" });
    await assert.rejects(f.service.execute(p.id), /要求已变化/);
    await assert.rejects(stat(p.container), { code: "ENOENT" });
    const fresh = await f.service.preview(f.input);
    await writeFile(join(f.ai, "system/POLICY.md"), "规则已修改");
    await assert.rejects(f.service.execute(fresh.id), /规则或目录/);
    await assert.rejects(stat(p.container), { code: "ENOENT" });
  } finally {
    await f.close();
  }
});
test("existing paths, duplicate registry identities and unsafe slugs are never overwritten", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.preview({ ...f.input, slug: "../escape" }));
    const p = await f.service.preview(f.input);
    await mkdir(p.container);
    await writeFile(join(p.container, "keep.txt"), "user data");
    await assert.rejects(f.service.execute(p.id), /已存在/);
    assert.equal(
      await readFile(join(p.container, "keep.txt"), "utf8"),
      "user data",
    );
    await writeFile(
      join(f.ai, "system/projects/other-name.json"),
      JSON.stringify({ id: "duplicate", target_root: "elsewhere" }),
    );
    await assert.rejects(
      f.service.preview({ ...f.input, slug: "duplicate" }),
      /中央登记/,
    );
    await writeFile(
      join(f.ai, "system/projects/existing.json"),
      "existing data",
    );
    await assert.rejects(
      f.service.preview({ ...f.input, slug: "existing" }),
      /已存在/,
    );
  } finally {
    await f.close();
  }
});
test("interrupted initialization resumes only its own matching files and does not create another initial commit", async () => {
  const f = await fixture();
  try {
    const p = await f.service.preview(f.input);
    // Model a process exit after creating the identity marker and one confirmed file.
    await mkdir(p.container);
    await writeFile(
      join(p.container, ".ytriple-initialization.json"),
      JSON.stringify({ id: p.id, projectId: p.input.projectId }, null, 2) +
        "\n",
    );
    await mkdir(p.main);
    await writeFile(join(p.main, "README.md"), p.files["README.md"]);
    f.store.put("initialization", p.id, {
      ...p,
      status: "running",
      step: "写入已确认产品材料",
    });
    const reopened = new Store(join(f.home, "db"));
    try {
      const recovered = await new ProjectInitialization(reopened).execute(p.id);
      assert.equal(recovered.status, "complete");
      assert.equal(git(recovered.main, "rev-list", "--count", "HEAD"), "1");
    } finally {
      reopened.close();
    }
  } finally {
    await f.close();
  }
});
test("partial-directory conflicts stay visible and unchanged; correction can resume the same plan", async () => {
  const f = await fixture();
  try {
    const p = await f.service.preview(f.input);
    await mkdir(p.container);
    await writeFile(
      join(p.container, ".ytriple-initialization.json"),
      JSON.stringify({ id: p.id, projectId: p.input.projectId }, null, 2) +
        "\n",
    );
    await mkdir(p.main);
    await writeFile(join(p.main, "README.md"), "external edit");
    f.store.put("initialization", p.id, { ...p, status: "running" });
    await assert.rejects(f.service.execute(p.id), /保留原文件/);
    assert.equal(
      await readFile(join(p.main, "README.md"), "utf8"),
      "external edit",
    );
    assert.equal(
      f.store.require<InitializationPlan>("initialization", p.id).status,
      "failed",
    );
    assert.equal(f.store.snapshot().projects[0].directory, undefined);
    await assert.rejects(stat(p.manifestPath), { code: "ENOENT" });
    await writeFile(join(p.main, "README.md"), p.files["README.md"]);
    assert.equal((await f.service.execute(p.id)).status, "complete");
  } finally {
    await f.close();
  }
});
test("cross-project sources and symlinked destinations or incomplete policy cannot initialize", async () => {
  const f = await fixture();
  try {
    const other = f.store.createProject("Other", "", "software");
    await assert.rejects(
      f.service.preview({ ...f.input, projectId: other.id }),
      /不属于/,
    );
    await rm(join(f.code, "y"), { recursive: true });
    await symlink(f.home, join(f.code, "y"));
    await assert.rejects(f.service.preview(f.input), /真实目录/);
    await rm(join(f.code, "y"));
    await mkdir(join(f.code, "y"));
    await rm(join(f.ai, "system/series.json"));
    await assert.rejects(f.service.preview(f.input), /体系不完整/);
  } finally {
    await f.close();
  }
});

test("registration added after preview blocks writes; unsafe recovered Git configuration is never executed", async () => {
  const f = await fixture();
  try {
    const p = await f.service.preview(f.input);
    const alias = join(f.ai, "system/projects/later.json");
    await writeFile(
      alias,
      JSON.stringify({ id: f.input.slug, target_root: p.container }),
    );
    await assert.rejects(f.service.execute(p.id), /中央登记/);
    await assert.rejects(stat(p.container), { code: "ENOENT" });
    await rm(alias);
    const complete = await f.service.execute(p.id);
    const config = join(p.main, ".git/config"),
      original = await readFile(config, "utf8");
    await writeFile(
      config,
      original + "\n[core]\n fsmonitor = dangerous-command\n",
    );
    f.store.put("initialization", p.id, {
      ...complete,
      status: "failed",
      step: "核对项目",
    });
    await assert.rejects(f.service.execute(p.id), /仓库配置已变化/);
    assert.match(await readFile(config, "utf8"), /dangerous-command/);
    await writeFile(config, original);
    assert.equal((await f.service.execute(p.id)).status, "complete");
  } finally {
    await f.close();
  }
});
