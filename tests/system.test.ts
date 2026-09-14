import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import {
  bootstrapSystem,
  inspectSystem,
  initializeProject,
  listProjects,
} from "../src/core/system";
import {
  BEGIN_RULES,
  END_RULES,
  validateJson,
} from "../src/core/system-templates";

const exec = promisify(execFile);
const input = {
  id: "sample",
  name: "Sample",
  series: "y" as const,
  description: "用真实资料建立可编辑研究成果。",
};
async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ytriple-system-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    root,
    ai: path.join(root, "Rules Space"),
    code: path.join(root, "Project Space"),
  };
}
const read = async (p: string) => JSON.parse(await fs.readFile(p, "utf8"));
const write = async (p: string, data: unknown) =>
  fs.writeFile(p, JSON.stringify(data, null, 2) + "\n");
async function tool(ai: string, name: string, args: string[] = []) {
  const config = await read(path.join(ai, "system/system.json"));
  const result = await exec(
    process.execPath,
    [path.join(ai, "system", config.interfaces[name]), ...args],
    { timeout: 20000, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
  );
  return JSON.parse(result.stdout);
}
async function git(p: string, ...args: string[]) {
  return (
    await exec("git", ["-C", p, ...args], { timeout: 10000 })
  ).stdout.trim();
}

test("fresh portable roots create a complete system with working standalone interfaces", async (t) => {
  const { root, ai, code } = await fixture(t);
  assert.equal((await inspectSystem(ai, code)).state, "missing");
  const result = await bootstrapSystem(ai, code);
  assert.equal(result.state, "ready", JSON.stringify(result.issues));
  for (const rel of ["system/projects", "knowledge", "resources"])
    assert.ok((await fs.stat(path.join(ai, rel))).isDirectory());
  assert.equal(
    await fs.realpath(path.join(ai, "AGENTS.md")),
    await fs.realpath(path.join(ai, "system/POLICY.md")),
  );
  assert.equal(
    await fs.realpath(path.join(code, "AGENTS.md")),
    await fs.realpath(path.join(ai, "system/POLICY.md")),
  );
  const config = await read(path.join(ai, "system/system.json"));
  assert.equal(config.code_root, code);
  assert.ok(
    !(await fs.readFile(result.policyPath, "utf8")).includes("/Users/Admin"),
  );
  assert.equal((await tool(ai, "validate")).errors.length, 0);
  assert.equal((await tool(ai, "observe")).mode, "read_only");
  assert.deepEqual(await tool(ai, "project_rules"), []);
  assert.deepEqual(await listProjects(ai), []);
  assert.deepEqual((await fs.readdir(root)).sort(), [
    "Project Space",
    "Rules Space",
  ]);
});

test("existing policies/catalogs and custom references are preserved byte for byte", async (t) => {
  const { ai, code } = await fixture(t);
  await bootstrapSystem(ai, code);
  const original = path.join(ai, "system/POLICY.md"),
    renamed = path.join(ai, "system/LOCAL.md");
  await fs.rename(original, renamed);
  await fs.appendFile(renamed, "\n# 本机额外规则\n保留此内容。\n");
  const configPath = path.join(ai, "system/system.json"),
    config = await read(configPath);
  config.policy = "LOCAL.md";
  await write(configPath, config);
  for (const p of [path.join(ai, "AGENTS.md"), path.join(code, "AGENTS.md")]) {
    await fs.unlink(p);
    await fs.symlink(path.relative(path.dirname(p), renamed), p);
  }
  const before = await fs.readFile(renamed, "utf8");
  assert.equal((await bootstrapSystem(ai, code)).state, "ready");
  assert.equal(await fs.readFile(renamed, "utf8"), before);
  assert.equal((await inspectSystem(ai)).policyPath, renamed);
  assert.equal((await tool(ai, "validate")).errors.length, 0);
});

test("missing known files and renamed Node interfaces are repaired without altering other files", async (t) => {
  const { ai, code } = await fixture(t);
  await bootstrapSystem(ai, code);
  const policy = await fs.readFile(path.join(ai, "system/POLICY.md"), "utf8");
  const configPath = path.join(ai, "system/system.json"),
    config = await read(configPath);
  config.interfaces.observe = "tools/local-observation.cjs";
  await write(configPath, config);
  await fs.unlink(path.join(ai, "system/work.json"));
  await fs.unlink(path.join(ai, "system/schema/observation.schema.json"));
  assert.equal((await inspectSystem(ai, code)).state, "incomplete");
  assert.equal((await bootstrapSystem(ai, code)).state, "ready");
  assert.equal(
    await fs.readFile(path.join(ai, "system/POLICY.md"), "utf8"),
    policy,
  );
  assert.equal((await tool(ai, "observe")).mode, "read_only");
});

test("incompatible versions, invalid JSON and unsafe references fail without replacement", async (t) => {
  const { ai, code } = await fixture(t);
  await bootstrapSystem(ai, code);
  const p = path.join(ai, "system/system.json"),
    config = await read(p);
  config.schema_version = 2;
  await write(p, config);
  const before = await fs.readFile(p, "utf8");
  assert.equal((await bootstrapSystem(ai, code)).state, "conflict");
  assert.equal(await fs.readFile(p, "utf8"), before);
  config.schema_version = 1;
  config.policy = "../../outside.md";
  await write(p, config);
  assert.equal((await inspectSystem(ai, code)).state, "conflict");
  await fs.writeFile(p, "{broken");
  assert.equal((await inspectSystem(ai, code)).state, "conflict");
  assert.equal(await fs.readFile(p, "utf8"), "{broken");
});

test("symlink roots, parent links, foreign AGENTS and directory collisions are not followed or replaced", async (t) => {
  const { root, ai, code } = await fixture(t);
  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  await fs.symlink(outside, ai);
  assert.equal((await bootstrapSystem(ai, code)).state, "conflict");
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(ai);
  const linkedParent = path.join(root, "linked-parent");
  await fs.symlink(outside, linkedParent);
  assert.equal(
    (await inspectSystem(path.join(linkedParent, "AI"), code)).state,
    "conflict",
  );
  await fs.mkdir(ai);
  await fs.writeFile(path.join(ai, "AGENTS.md"), "Existing user rules");
  assert.equal((await bootstrapSystem(ai, code)).state, "conflict");
  assert.equal(
    await fs.readFile(path.join(ai, "AGENTS.md"), "utf8"),
    "Existing user rules",
  );
  await fs.unlink(path.join(ai, "AGENTS.md"));
  await fs.writeFile(path.join(ai, "system"), "Do not replace");
  assert.equal((await bootstrapSystem(ai, code)).state, "conflict");
});

test("safe in-AI catalog links are read; links escaping AI are rejected", async (t) => {
  const { root, ai, code } = await fixture(t);
  await bootstrapSystem(ai, code);
  const catalog = path.join(ai, "system/knowledge.json"),
    target = path.join(ai, "knowledge/catalog.json");
  await fs.rename(catalog, target);
  await fs.symlink("../knowledge/catalog.json", catalog);
  assert.equal((await inspectSystem(ai, code)).state, "ready");
  assert.equal((await tool(ai, "validate")).errors.length, 0);
  await fs.unlink(catalog);
  await fs.symlink(path.join(root, "foreign.json"), catalog);
  await write(path.join(root, "foreign.json"), await read(target));
  assert.equal((await inspectSystem(ai, code)).state, "conflict");
});

test("project initialization builds main/dev, complete docs and central rules without a remote", async (t) => {
  const { ai, code } = await fixture(t);
  const result = await initializeProject(ai, code, input);
  const main = path.join(result.project.root, "sample-main"),
    dev = result.project.devPath;
  assert.equal(await git(main, "branch", "--show-current"), "main");
  assert.equal(await git(dev, "branch", "--show-current"), "dev");
  assert.equal(
    await git(main, "rev-parse", "HEAD"),
    await git(dev, "rev-parse", "HEAD"),
  );
  assert.equal(await git(main, "remote"), "");
  assert.equal(await git(dev, "status", "--porcelain"), "");
  for (const file of [
    "README.md",
    "AGENTS.md",
    "docs/product.md",
    "docs/requirements.md",
    "docs/research.md",
    "docs/feedback.md",
  ])
    assert.ok((await fs.stat(path.join(dev, file))).isFile());
  assert.match(
    await fs.readFile(path.join(dev, "AGENTS.md"), "utf8"),
    /AI-SYSTEM:PROJECT-RULES BEGIN/,
  );
  assert.equal((await tool(ai, "validate")).errors.length, 0);
  assert.ok(
    (
      await tool(ai, "project_rules", ["--project", input.id, "--strict"])
    ).every((r: any) => r.state === "current"),
  );
  assert.equal((await listProjects(ai))[0].devPath, dev);
  const localConfig = await git(main, "config", "--local", "--list");
  assert.ok(!localConfig.includes("user.name="));
});

test("repeat initialization retains unknown and edited project files without new commits", async (t) => {
  const { ai, code } = await fixture(t);
  const first = await initializeProject(ai, code, input);
  const dev = first.project.devPath,
    original = await git(dev, "rev-parse", "HEAD");
  await fs.writeFile(path.join(dev, "notes.txt"), "User-owned content");
  await fs.appendFile(path.join(dev, "README.md"), "\nUser revision\n");
  const second = await initializeProject(ai, code, input);
  assert.deepEqual(second.createdPaths, []);
  assert.equal(await git(dev, "rev-parse", "HEAD"), original);
  assert.match(
    await fs.readFile(path.join(dev, "README.md"), "utf8"),
    /User revision/,
  );
  assert.equal(
    await fs.readFile(path.join(dev, "notes.txt"), "utf8"),
    "User-owned content",
  );
});

test("same-name unregistered directories, path traversal and symlinked series are rejected", async (t) => {
  const { root, ai, code } = await fixture(t);
  await bootstrapSystem(ai, code);
  const existing = path.join(code, "y/sample");
  await fs.mkdir(existing, { recursive: true });
  await fs.writeFile(path.join(existing, "keep"), "Keep");
  await assert.rejects(initializeProject(ai, code, input), /已存在/);
  assert.equal(await fs.readFile(path.join(existing, "keep"), "utf8"), "Keep");
  await assert.rejects(
    initializeProject(ai, code, { ...input, id: "../escape" }),
    /无效/,
  );
  const outside = path.join(root, "external");
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(code, "x"));
  await assert.rejects(
    initializeProject(ai, code, { ...input, series: "x" }),
    /符号链接/,
  );
  assert.deepEqual(await fs.readdir(outside), []);
});

test("interrupted initialization resumes after failed central projection without duplicating commits", async (t) => {
  const { ai, code } = await fixture(t);
  await bootstrapSystem(ai, code);
  const script = path.join(ai, "system/tools/project_rules.cjs"),
    original = await fs.readFile(script, "utf8");
  await fs.writeFile(script, "process.exit(7);\n");
  await assert.rejects(initializeProject(ai, code, input));
  const main = path.join(code, "y/sample/sample-main"),
    head = await git(main, "rev-parse", "HEAD");
  await fs.writeFile(script, original);
  const result = await initializeProject(ai, code, input);
  assert.equal(await git(main, "rev-parse", "HEAD"), head);
  assert.equal((await listProjects(ai)).length, 1);
  assert.equal(result.project.id, input.id);
});

test("projection only replaces the marked block and cannot execute manifest commands", async (t) => {
  const { root, ai, code } = await fixture(t);
  const result = await initializeProject(ai, code, input);
  const p = path.join(result.project.devPath, "AGENTS.md"),
    before = await fs.readFile(p, "utf8");
  await fs.writeFile(
    p,
    "User preamble\n" +
      before.replace("## 中央项目登记", "## Changed") +
      "\nUser trailing rules\n",
  );
  const readonly = await tool(ai, "project_rules", ["--project", input.id]);
  assert.ok(readonly.some((r: any) => r.state === "drift"));
  await tool(ai, "project_rules", [
    "--project",
    input.id,
    "--write",
    "--strict",
  ]);
  const after = await fs.readFile(p, "utf8");
  assert.ok(after.startsWith("User preamble\n" + BEGIN_RULES));
  assert.ok(after.endsWith("\nUser trailing rules\n"));
  assert.ok(after.includes(END_RULES));
  const manifestPath = path.join(ai, "system/projects/sample.json"),
    manifest = await read(manifestPath);
  manifest.monitoring.commands = [
    "touch " + path.join(root, "SHOULD_NOT_EXIST"),
  ];
  await write(manifestPath, manifest);
  await assert.rejects(tool(ai, "validate"));
  await tool(ai, "observe");
  await assert.rejects(fs.stat(path.join(root, "SHOULD_NOT_EXIST")));
});

test("resumption cannot follow substituted document symlinks or tampered journal paths", async (t) => {
  const { root, ai, code } = await fixture(t);
  await bootstrapSystem(ai, code);
  const script = path.join(ai, "system/tools/project_rules.cjs"),
    original = await fs.readFile(script, "utf8");
  await fs.writeFile(script, "process.exit(7);");
  await assert.rejects(initializeProject(ai, code, input));
  await fs.writeFile(script, original);
  const dev = path.join(code, "y/sample/sample-dev"),
    outside = path.join(root, "foreign-agents");
  await fs.writeFile(outside, "Foreign rules");
  await fs.unlink(path.join(dev, "AGENTS.md"));
  await fs.symlink(outside, path.join(dev, "AGENTS.md"));
  await assert.rejects(initializeProject(ai, code, input), /符号链接/);
  assert.equal(await fs.readFile(outside, "utf8"), "Foreign rules");
  const journalPath = path.join(ai, "system/.ytriple-init/sample.json"),
    journal = await read(journalPath);
  journal.files["../escape"] = "No";
  await write(journalPath, journal);
  await assert.rejects(initializeProject(ai, code, input), /未知文件路径/);
});

test("schema checker validates local refs and refuses external schemas", () => {
  assert.deepEqual(
    validateJson(
      { x: 1 },
      {
        type: "object",
        properties: { x: { $ref: "#/$defs/number" } },
        $defs: { number: { type: "integer" } },
      },
    ),
    [],
  );
  assert.ok(
    validateJson({}, { $ref: "https://example.com/schema" }).length > 0,
  );
});

test("an interrupted rule projection preserves subsequently changed managed rules", async (t) => {
  const { ai, code } = await fixture(t);
  await bootstrapSystem(ai, code);
  const script = path.join(ai, "system/tools/project_rules.cjs"),
    original = await fs.readFile(script, "utf8");
  await fs.writeFile(script, "process.exit(7);");
  await assert.rejects(initializeProject(ai, code, input));
  const rules = path.join(code, "y/sample/sample-dev/AGENTS.md");
  const changed = (await fs.readFile(rules, "utf8")).replace(
    "## 中央项目登记",
    "## User changed rule",
  );
  await fs.writeFile(rules, changed);
  await fs.writeFile(script, original);
  await assert.rejects(initializeProject(ai, code, input), /未知修改/);
  assert.equal(await fs.readFile(rules, "utf8"), changed);
});

test("incompatible missing-file repair performs no writes", async (t) => {
  const { ai, code } = await fixture(t);
  await bootstrapSystem(ai, code);
  const schemaPath = path.join(ai, "system/schema/work.schema.json"),
    schema = await read(schemaPath);
  schema.properties.profile_id = { const: "this-existing-machine" };
  await write(schemaPath, schema);
  const work = path.join(ai, "system/work.json");
  await fs.unlink(work);
  const result = await bootstrapSystem(ai, code);
  assert.equal(result.state, "conflict");
  await assert.rejects(fs.stat(work));
});

test("production ESM bundling retains executable generated tools", async (t) => {
  const { root, ai, code } = await fixture(t);
  const outfile = path.join(root, "bundled-system.mjs");
  await build({
    entryPoints: ["src/core/system.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    outfile,
    target: "node24",
  });
  const bundled = await import(pathToFileURL(outfile).href);
  const result = await bundled.initializeProject(ai, code, {
    ...input,
    id: "bundled",
  });
  assert.equal(result.project.id, "bundled");
  assert.ok(result.checks.includes("dev Git status：clean"));
});
