import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type {
  SystemStatus,
  SystemIssue,
  ProjectInfo,
  ProjectInput,
  ProjectInitResult,
} from "../shared/types";
import {
  BEGIN_RULES,
  END_RULES,
  defaultSystem,
  systemTemplates,
  projectTemplate,
  rulesBlock,
  validateJson,
  json,
} from "./system-templates";

const exec = promisify(execFile);
type Dict = Record<string, any>;
const DATA_SCHEMAS = [
  ["work_profile", "work_schema"],
  ["series_catalog", "series_schema"],
  ["knowledge_catalog", "knowledge_schema"],
  ["resource_catalog", "resource_schema"],
  ["project_template", "project_schema"],
] as const;
const REFS = ["policy", ...new Set(DATA_SCHEMAS.flat()), "observation_schema"];
const pending = new Map<string, Promise<unknown>>();

async function serialized<T>(
  key: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = pending.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  pending.set(key, current);
  try {
    return await current;
  } finally {
    if (pending.get(key) === current) pending.delete(key);
  }
}
async function stat(p: string) {
  try {
    return await fs.lstat(p);
  } catch (e: any) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
function rootPath(value: string): string {
  if (value === "~" || value.startsWith("~/"))
    value = path.join(os.homedir(), value.slice(2));
  if (!path.isAbsolute(value) || value.includes("\0"))
    throw Error("根目录必须是有效绝对路径");
  const p = path.resolve(value);
  if (p === path.parse(p).root) throw Error("不能使用文件系统根目录");
  return p;
}
function inside(root: string, p: string): boolean {
  const r = path.relative(root, p);
  return (
    r === "" ||
    (r !== ".." && !r.startsWith(".." + path.sep) && !path.isAbsolute(r))
  );
}
async function separate(ai: string, code: string): Promise<void> {
  const canonical = async (p: string): Promise<string> => {
    const tail: string[] = [];
    while (!(await stat(p))) {
      tail.unshift(path.basename(p));
      p = path.dirname(p);
    }
    return path.join(await fs.realpath(p), ...tail);
  };
  const a = await canonical(ai),
    c = await canonical(code);
  if (inside(a, c) || inside(c, a))
    throw Error("AI 与 Code 必须使用互不包含的独立根目录");
}
async function safePath(
  p: string,
  boundary: string,
  allowLeafLink = false,
): Promise<void> {
  if (!inside(boundary, p)) throw Error("路径越出允许范围：" + p);
  // macOS exposes these standard roots through /private; do not extend that exception to user links.
  for (
    let parent = path.dirname(boundary);
    parent !== path.dirname(parent);
    parent = path.dirname(parent)
  ) {
    const s = await stat(parent);
    if (
      s?.isSymbolicLink() &&
      !(
        process.platform === "darwin" &&
        ["/var", "/tmp", "/etc"].includes(parent) &&
        (await fs.realpath(parent)) === "/private" + parent
      )
    )
      throw Error("根目录经过未知符号链接：" + parent);
    if (s && !s.isDirectory() && !s.isSymbolicLink())
      throw Error("根路径父级不是目录：" + parent);
  }
  const parts = [
    boundary,
    ...path.relative(boundary, p).split(path.sep).filter(Boolean),
  ];
  let current = parts[0];
  for (let i = 0; i < parts.length; i++) {
    if (i) current = path.join(current, parts[i]);
    const s = await stat(current);
    if (s?.isSymbolicLink()) {
      if (allowLeafLink && i === parts.length - 1) {
        const target = await fs.realpath(current);
        const realBoundary = await fs.realpath(boundary);
        if (inside(realBoundary, target) && (await fs.stat(current)).isFile())
          return;
      }
      throw Error("拒绝写入或遍历符号链接：" + current);
    }
    if (s && i < parts.length - 1 && !s.isDirectory())
      throw Error("父路径不是目录：" + current);
  }
}
function refPath(aiRoot: string, ref: unknown): string {
  if (
    typeof ref !== "string" ||
    !ref ||
    path.isAbsolute(ref) ||
    ref.includes("\0")
  )
    throw Error("中央引用必须是相对路径");
  const system = path.join(aiRoot, "system"),
    p = path.resolve(system, ref);
  if (!inside(system, p) || p === system)
    throw Error("中央引用越出 system：" + ref);
  return p;
}
function projectDirectory(aiRoot: string, config: Dict): string {
  const glob = config.project_manifest_glob;
  if (
    typeof glob !== "string" ||
    !glob.endsWith("/*.json") ||
    /[*?[\]{}]/.test(glob.slice(0, -7))
  )
    throw Error("项目登记仅支持固定目录下的 *.json");
  return refPath(aiRoot, path.dirname(glob));
}
async function readJSON(p: string): Promise<Dict> {
  const value = JSON.parse(await fs.readFile(p, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("JSON 顶层必须是对象：" + p);
  return value;
}

async function inspect(
  aiInput: string,
  codeInput?: string,
): Promise<{
  status: SystemStatus;
  config: Dict;
  refs: Record<string, string>;
}> {
  let aiRoot = aiInput,
    codeRoot = codeInput || path.join(path.dirname(aiInput), "Code");
  const issues: SystemIssue[] = [],
    refs: Record<string, string> = {};
  const add = (code: string, message: string, p?: string) =>
    issues.push({ code, message, path: p });
  let config: Dict = {},
    policyText: string | undefined,
    missingSystem = false;
  try {
    aiRoot = rootPath(aiInput);
    await safePath(aiRoot, aiRoot);
    const systemPath = path.join(aiRoot, "system/system.json");
    await safePath(systemPath, aiRoot);
    const s = await stat(systemPath);
    missingSystem = !s;
    if (s) {
      if (!s.isFile()) throw Error("system.json 不是普通文件");
      config = await readJSON(systemPath);
      codeRoot = rootPath(codeInput || config.code_root);
      if (config.schema_version !== 1)
        throw Error("不支持的中央 schema_version：" + config.schema_version);
      if (
        rootPath(config.root) !== aiRoot ||
        rootPath(config.code_root) !== codeRoot
      )
        throw Error("配置根路径与当前设置不符；需要显式迁移，不能覆盖已有配置");
      if (
        config.observation_policy?.manifest_commands_allowed !== false ||
        config.observation_policy?.credentials_allowed !== false ||
        config.observation_policy?.mode !== "read_only"
      )
        throw Error("当前观察策略不符合固定只读、无 manifest 命令或凭据的契约");
    } else {
      codeRoot = rootPath(codeRoot);
      config = defaultSystem(aiRoot, codeRoot);
      add("missing", "缺少中央机器入口", systemPath);
    }
    await separate(aiRoot, codeRoot);
    await safePath(codeRoot, codeRoot);
    const dirs = [
      aiRoot,
      path.join(aiRoot, "system"),
      path.join(aiRoot, "knowledge"),
      path.join(aiRoot, "resources"),
      codeRoot,
      projectDirectory(aiRoot, config),
    ];
    for (const p of dirs) {
      await safePath(p, inside(aiRoot, p) ? aiRoot : codeRoot);
      const s = await stat(p);
      if (!s) add("missing", "缺少目录", p);
      else if (!s.isDirectory()) add("conflict", "预期目录被其他文件占用", p);
    }
    for (const key of REFS) refs[key] = refPath(aiRoot, config[key]);
    for (const key of ["validate", "observe", "project_rules"])
      refs["interface:" + key] = refPath(aiRoot, config.interfaces?.[key]);
    for (const [key, p] of Object.entries(refs)) {
      await safePath(p, aiRoot, !key.startsWith("interface:"));
      const s = await stat(p);
      if (!s) {
        add("missing", "缺少 " + key, p);
        continue;
      }
      if (!(await fs.stat(p)).isFile()) {
        add("conflict", "引用不是普通文件", p);
        continue;
      }
      if (key === "policy") {
        policyText = await fs.readFile(p, "utf8");
        if (!policyText.trim()) add("conflict", "政策文件为空", p);
      } else if (p.endsWith(".json")) {
        const data = await readJSON(p);
        if (!key.endsWith("schema") && data.schema_version !== 1)
          add("conflict", "不支持的数据版本", p);
        if (
          key.endsWith("schema") &&
          data.$schema &&
          !String(data.$schema).includes("json-schema.org/")
        )
          add("conflict", "不支持的 schema 方言", p);
      }
    }
    for (const [dataKey, schemaKey] of DATA_SCHEMAS) {
      if ((await stat(refs[dataKey])) && (await stat(refs[schemaKey]))) {
        for (const message of validateJson(
          await readJSON(refs[dataKey]),
          await readJSON(refs[schemaKey]),
          dataKey,
        ))
          add("conflict", message, refs[dataKey]);
      }
    }
    for (const p of [
      path.join(aiRoot, "AGENTS.md"),
      path.join(codeRoot, "AGENTS.md"),
    ]) {
      const s = await stat(p);
      if (!s) add("missing", "缺少政策入口链接", p);
      else if (
        !s.isSymbolicLink() ||
        path.resolve(path.dirname(p), await fs.readlink(p)) !== refs.policy
      )
        add("conflict", "已有规则入口未指向本机中央政策；保留原内容", p);
    }
  } catch (e: any) {
    add("conflict", e.message);
  }
  const state = issues.some((i) => i.code === "conflict")
    ? "conflict"
    : issues.length
      ? missingSystem && !(await stat(path.join(aiRoot, "system")))
        ? "missing"
        : "incomplete"
      : "ready";
  return {
    status: {
      state,
      aiRoot,
      codeRoot,
      policyPath: refs.policy || path.join(aiRoot, "system/POLICY.md"),
      issues,
      ...(policyText ? { policyText } : {}),
    },
    config,
    refs,
  };
}

export async function inspectSystem(
  aiRoot: string,
  codeRoot?: string,
): Promise<SystemStatus> {
  return (await inspect(aiRoot, codeRoot)).status;
}

async function createFile(
  p: string,
  text: string,
  boundary: string,
  created?: string[],
): Promise<void> {
  await safePath(p, boundary);
  await fs.mkdir(path.dirname(p), { recursive: true });
  // Publish a fully flushed file exclusively: a crash cannot leave a partial JSON/doc at its final path.
  const temporary = path.join(
    path.dirname(p),
    ".ytriple-write-" + randomUUID(),
  );
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
    await handle.close();
    await fs.link(temporary, p);
  } finally {
    await handle.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
  created?.push(p);
}
async function bootstrap(
  aiRoot: string,
  codeRoot: string,
): Promise<SystemStatus> {
  const before = await inspect(aiRoot, codeRoot);
  if (before.status.state === "conflict" || before.status.state === "ready")
    return before.status;
  ({ aiRoot, codeRoot } = before.status);
  const defaults = defaultSystem(aiRoot, codeRoot),
    templates = systemTemplates(aiRoot, codeRoot);
  const planned: Record<string, string> = {};
  const defaultRefs: Record<string, string> = Object.fromEntries(
    REFS.map((k) => [k, refPath(aiRoot, defaults[k])]),
  );
  for (const key of ["validate", "observe", "project_rules"])
    defaultRefs["interface:" + key] = refPath(aiRoot, defaults.interfaces[key]);
  for (const [key, target] of Object.entries(before.refs)) {
    if (await stat(target)) continue;
    if (key.startsWith("interface:") && path.extname(target) !== ".cjs") {
      return {
        ...before.status,
        state: "conflict",
        issues: [
          ...before.status.issues,
          {
            code: "conflict",
            message:
              "缺失的自定义接口不能安全推断；请恢复原接口或配置 Node .cjs 接口",
            path: target,
          },
        ],
      };
    }
    planned[target] = templates[path.relative(aiRoot, defaultRefs[key])];
  }
  for (const rel of ["README.md", "system/system.json"]) {
    const p = path.join(aiRoot, rel);
    await safePath(p, aiRoot);
    const s = await stat(p);
    if (!s) planned[p] = templates[rel];
    else if (!s.isFile())
      return {
        ...before.status,
        state: "conflict",
        issues: [{ code: "conflict", message: "已有文件类型冲突", path: p }],
      };
  }
  // Validate all proposed missing files against the existing schemas before any mutation.
  for (const [dataKey, schemaKey] of DATA_SCHEMAS) {
    const dataPath = before.refs[dataKey],
      schemaPath = before.refs[schemaKey];
    const data = planned[dataPath]
      ? JSON.parse(planned[dataPath])
      : await readJSON(dataPath);
    const schema = planned[schemaPath]
      ? JSON.parse(planned[schemaPath])
      : await readJSON(schemaPath);
    const errors = validateJson(data, schema, dataKey);
    if (errors.length)
      return {
        ...before.status,
        state: "conflict",
        issues: errors.map((message) => ({
          code: "conflict",
          message: "无法安全补齐：" + message,
          path: dataPath,
        })),
      };
  }
  for (const p of [
    aiRoot,
    codeRoot,
    path.join(aiRoot, "system"),
    path.join(aiRoot, "knowledge"),
    path.join(aiRoot, "resources"),
    projectDirectory(aiRoot, before.config),
  ]) {
    await safePath(p, inside(aiRoot, p) ? aiRoot : codeRoot);
    await fs.mkdir(p, { recursive: true });
  }
  for (const [p, content] of Object.entries(planned))
    await createFile(p, content, aiRoot);
  for (const p of [
    path.join(aiRoot, "AGENTS.md"),
    path.join(codeRoot, "AGENTS.md"),
  ]) {
    if (!(await stat(p)))
      await fs.symlink(path.relative(path.dirname(p), before.refs.policy), p);
  }
  return inspectSystem(aiRoot, codeRoot);
}
export async function bootstrapSystem(
  aiRoot: string,
  codeRoot: string,
): Promise<SystemStatus> {
  return serialized("system:" + path.resolve(aiRoot), () =>
    bootstrap(aiRoot, codeRoot),
  );
}

function info(p: Dict): ProjectInfo {
  const dev = p.worktrees?.find((w: Dict) => w.role === "dev" && !w.retired);
  if (!dev || typeof p.id !== "string" || typeof p.target_root !== "string")
    throw Error("项目登记缺少 ID、目标目录或 dev worktree");
  return {
    id: p.id,
    name: p.name,
    series: p.series,
    root: p.target_root,
    devPath: dev.path,
    documents: p.documents,
  };
}
export async function listProjects(aiRoot: string): Promise<ProjectInfo[]> {
  const context = await inspect(aiRoot);
  if (context.status.state === "missing") return [];
  if (context.status.state === "conflict")
    throw Error(context.status.issues.map((i) => i.message).join("；"));
  const directory = projectDirectory(context.status.aiRoot, context.config);
  if (!(await stat(directory))) return [];
  const projects: ProjectInfo[] = [];
  for (const file of (await fs.readdir(directory))
    .filter((f) => f.endsWith(".json"))
    .sort()) {
    const p = path.join(directory, file);
    await safePath(p, context.status.aiRoot);
    const manifest = await readJSON(p);
    if (manifest.schema_version !== 1 || manifest.id + ".json" !== file)
      throw Error("项目登记版本或文件名无效：" + p);
    if (
      context.refs.project_schema &&
      (await stat(context.refs.project_schema))
    ) {
      const errors = validateJson(
        manifest,
        await readJSON(context.refs.project_schema),
      );
      if (errors.length)
        throw Error("项目登记无效：" + p + " " + errors.join("；"));
    }
    projects.push(info(manifest));
  }
  return projects;
}

async function git(directory: string, args: string[]): Promise<string> {
  const env = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of Object.keys(env))
    if (
      key.startsWith("GIT_") &&
      !["GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT"].includes(key)
    )
      delete env[key as keyof typeof env];
  const result = await exec(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "commit.gpgsign=false",
      "-C",
      directory,
      ...args,
    ],
    { timeout: 15000, maxBuffer: 1024 * 1024, env },
  );
  return result.stdout.trim();
}
async function interfaceTool(p: string, args: string[]): Promise<string> {
  const python = path.extname(p) === ".py";
  if (!python && ![".cjs", ".mjs", ".js"].includes(path.extname(p)))
    throw Error("不支持的中央接口：" + p);
  const result = await exec(
    python ? "python3" : process.execPath,
    [p, ...args],
    {
      timeout: 20000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
  return result.stdout.trim();
}

type Journal = {
  schema_version: 1;
  owner: "ytriple-project-init";
  input: ProjectInput;
  root: string;
  manifest: Dict;
  files: Record<string, string>;
  completed: boolean;
};
async function saveJournal(
  p: string,
  journal: Journal,
  aiRoot: string,
): Promise<void> {
  await safePath(p, aiRoot);
  const tmp = p + "." + randomUUID() + ".tmp";
  await createFile(tmp, json(journal), aiRoot);
  await fs.rename(tmp, p);
}
async function ensureExpected(
  p: string,
  content: string,
  root: string,
  created: string[],
): Promise<void> {
  await safePath(p, root);
  if (!(await stat(p))) return createFile(p, content, root, created);
  if ((await fs.readFile(p, "utf8")) !== content)
    throw Error("初始化文件已有未知修改，已保留：" + p);
}

async function initialize(
  aiRoot: string,
  codeRoot: string,
  input: ProjectInput,
): Promise<ProjectInitResult> {
  if (
    !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(input.id) ||
    input.id.endsWith(".") ||
    !["x", "y", "z"].includes(input.series) ||
    !input.name.trim()
  )
    throw Error("项目 ID、名称或系列无效");
  const status = await bootstrapSystem(aiRoot, codeRoot);
  if (status.state !== "ready")
    throw Error(status.issues.map((i) => i.message).join("；"));
  ({ aiRoot, codeRoot } = status);
  const { config, refs } = await inspect(aiRoot, codeRoot);
  const series = await readJSON(refs.series_catalog);
  const selected = series.series?.find((s: Dict) => s.id === input.series);
  if (
    !selected ||
    selected.code_root !== path.join(codeRoot, input.series) ||
    series.layout?.container !== path.join(codeRoot, "{series}/{project}") ||
    series.layout?.main_worktree !== "{project}-main" ||
    series.layout?.dev_worktree !== "{project}-dev"
  )
    throw Error(
      "当前项目布局与已实现的 main/dev 初始化契约不兼容；保留本机规则",
    );
  const root = path.join(codeRoot, input.series, input.id),
    main = path.join(root, input.id + "-main"),
    dev = path.join(root, input.id + "-dev");
  for (const p of [root, main, dev]) await safePath(p, codeRoot);
  const manifestPath = path.join(
    projectDirectory(aiRoot, config),
    input.id + ".json",
  );
  const journalPath = path.join(
    aiRoot,
    "system/.ytriple-init",
    input.id + ".json",
  );
  await safePath(manifestPath, aiRoot);
  await safePath(journalPath, aiRoot);
  const created: string[] = [];
  let journal: Journal;
  if (await stat(journalPath)) {
    journal = (await readJSON(journalPath)) as Journal;
    if (
      journal.owner !== "ytriple-project-init" ||
      journal.schema_version !== 1 ||
      journal.root !== root ||
      JSON.stringify(journal.input) !== JSON.stringify(input)
    )
      throw Error("同名初始化记录不匹配；不能覆盖既有项目");
    const expectedFiles = [
      "README.md",
      "docs/product.md",
      "docs/requirements.md",
      "docs/research.md",
      "docs/feedback.md",
      "AGENTS.md",
    ];
    if (
      !journal.files ||
      Object.keys(journal.files).length !== expectedFiles.length ||
      Object.entries(journal.files).some(
        ([name, value]) =>
          !expectedFiles.includes(name) || typeof value !== "string",
      )
    )
      throw Error("初始化记录包含未知文件路径");
    if (
      journal.manifest?.id !== input.id ||
      journal.manifest?.target_root !== root ||
      journal.manifest?.worktrees?.find((w: Dict) => w.role === "main")
        ?.path !== main ||
      journal.manifest?.worktrees?.find((w: Dict) => w.role === "dev")?.path !==
        dev
    )
      throw Error("初始化记录的项目路径不匹配");
    if (journal.completed) {
      const registered = await readJSON(manifestPath);
      if (
        registered.id !== input.id ||
        registered.target_root !== root ||
        registered.worktrees?.find((w: Dict) => w.role === "main")?.path !==
          main ||
        registered.worktrees?.find((w: Dict) => w.role === "dev")?.path !== dev
      )
        throw Error("项目中央登记已发生冲突");
      for (const p of [main, dev])
        await safePath(path.join(p, "AGENTS.md"), codeRoot);
      const checks = await checkProject(
        registered,
        main,
        dev,
        refs,
        aiRoot,
        false,
      );
      return {
        project: info(registered),
        createdPaths: [],
        checks: ["已有项目；保留全部现场修改", ...checks],
      };
    }
  } else {
    if ((await stat(root)) || (await stat(manifestPath)))
      throw Error("项目目录或中央 ID 已存在；不接管或覆盖未知项目");
    const manifest = projectTemplate(codeRoot);
    manifest.id = input.id;
    manifest.name = input.name;
    manifest.series = input.series;
    manifest.product_type = selected.description;
    manifest.current_roots = [root];
    manifest.target_root = root;
    manifest.worktrees = [
      { role: "main", path: main, branch: "main", retired: false },
      { role: "dev", path: dev, branch: "dev", retired: false },
    ];
    manifest.documents = {
      entry: path.join(dev, "README.md"),
      product: path.join(dev, "docs/product.md"),
      research: path.join(dev, "docs/research.md"),
      external_ai_writeback: path.join(dev, "docs/feedback.md"),
    };
    manifest.collaboration.external_ai.writeback =
      manifest.documents.external_ai_writeback;
    const errors = validateJson(manifest, await readJSON(refs.project_schema));
    if (errors.length)
      throw Error("新项目不符合本机 schema：" + errors.join("；"));
    const files: Record<string, string> = {
      "README.md":
        "# " +
        input.name +
        "\n\n" +
        input.description +
        "\n\n## 开发入口\n\n先读取 [AGENTS.md](AGENTS.md) 与中央项目登记。\n\n- [产品方向](docs/product.md)\n- [需求与验收](docs/requirements.md)\n- [研究与依据](docs/research.md)\n- [反馈与交接](docs/feedback.md)\n\n当前为本地初始化环境。工程设计与代码开发由 Codex 接手；未创建远端、推送或发布。\n",
      "docs/product.md":
        "# 产品方向\n\n## 当前目标\n\n" +
        input.description +
        "\n\n## 当前边界\n\n产品目标、范围和重大取舍由用户确认；研究建议保留依据，采纳后才成为产品结论。当前文档为初始化起点，需要随实际讨论完善。\n",
      "docs/requirements.md":
        "# 需求与验收\n\n## 已知需求\n\n" +
        input.description +
        "\n\n## 后续细化\n\n由 Codex 结合产品正文明确行为、输入输出、失败处理与验收样例；未确认内容不得描述为已决定。\n",
      "docs/research.md":
        "# 研究与依据\n\n记录问题、来源、观察日期、结论与尚未验证的部分。研究候选不直接成为产品或工程决定。\n",
      "docs/feedback.md":
        "# 反馈与交接\n\n此处为指定反馈入口。记录用户修正、验证结果、未决问题及下一步；第三方 AI 仅提供建议，不修改项目代码或全局规则。\n",
      "AGENTS.md": rulesBlock(aiRoot, manifest, refs.policy, manifestPath),
    };
    journal = {
      schema_version: 1,
      owner: "ytriple-project-init",
      input,
      root,
      manifest,
      files,
      completed: false,
    };
    await createFile(journalPath, json(journal), aiRoot);
  }
  // Recovery only accepts the known initialization files; unknown paths are preserved, never staged.
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(main, { recursive: true });
  const expectedTop = new Set([input.id + "-main", input.id + "-dev"]);
  for (const name of await fs.readdir(root))
    if (!expectedTop.has(name))
      throw Error("项目容器存在未知文件，已保留：" + name);
  await safePath(path.join(main, ".git"), codeRoot);
  if (!(await stat(path.join(main, ".git")))) {
    const existing = await fs.readdir(main);
    if (existing.some((n) => !["README.md", "docs", "AGENTS.md"].includes(n)))
      throw Error("初始化目录存在未知内容，已保留");
    await git(main, ["init", "--initial-branch=main", "--template="]);
  }
  if ((await git(main, ["branch", "--show-current"])) !== "main")
    throw Error("main 工作区分支不符");
  if (await git(main, ["stash", "list"]))
    throw Error("初始化仓库存在 stash；保留并停止");
  let hasHead = true;
  try {
    await git(main, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    hasHead = false;
  }
  if (!hasHead) {
    for (const [rel, content] of Object.entries(journal.files))
      await ensureExpected(path.join(main, rel), content, codeRoot, created);
    const staged = await git(main, ["diff", "--cached", "--name-only"]);
    if (
      staged
        .split("\n")
        .filter(Boolean)
        .some((n) => !(n in journal.files))
    )
      throw Error("暂存区含未知文件；未提交");
    await git(main, ["add", "--", ...Object.keys(journal.files)]);
    await git(main, [
      "-c",
      "user.name=ytriple initialization",
      "-c",
      "user.email=ytriple-init@localhost",
      "commit",
      "-m",
      "Initialize project documents and local rules",
    ]);
  }
  const worktrees = await git(main, ["worktree", "list", "--porcelain"]);
  if (!(await stat(dev))) {
    if (worktrees.includes("branch refs/heads/dev"))
      throw Error("dev 分支已绑定其他 worktree");
    let devExists = true;
    try {
      await git(main, ["show-ref", "--verify", "refs/heads/dev"]);
    } catch {
      devExists = false;
    }
    await git(main, [
      "worktree",
      "add",
      ...(devExists ? [] : ["-b", "dev"]),
      dev,
      ...(devExists ? ["dev"] : ["main"]),
    ]);
    created.push(dev);
  } else {
    await safePath(path.join(dev, ".git"), codeRoot);
    if ((await git(dev, ["branch", "--show-current"])) !== "dev")
      throw Error("同名 dev 目录不是目标分支");
    const commonMain = await git(main, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    const commonDev = await git(dev, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    if (commonMain !== commonDev) throw Error("同名 dev 属于其他仓库");
  }
  if (!(await stat(manifestPath)))
    await createFile(manifestPath, json(journal.manifest), aiRoot, created);
  else if (
    JSON.stringify(await readJSON(manifestPath)) !==
    JSON.stringify(journal.manifest)
  )
    throw Error("中央项目登记有未知变化；已保留");
  // The configured central projector is authoritative; it only receives this newly owned project ID.
  for (const p of [main, dev])
    await safePath(path.join(p, "AGENTS.md"), codeRoot);
  let current = false;
  try {
    await interfaceTool(refs["interface:project_rules"], [
      "--project",
      input.id,
      "--strict",
    ]);
    current = true;
  } catch {
    /* Pending projection or a previous interrupted call. */
  }
  if (!current) {
    const managed = (text: string): string => {
      const begin = text.indexOf(BEGIN_RULES),
        end = text.indexOf(END_RULES);
      if (
        begin < 0 ||
        end < begin ||
        text.indexOf(BEGIN_RULES, begin + 1) >= 0 ||
        text.indexOf(END_RULES, end + 1) >= 0
      )
        throw Error("初始化规则区块缺失或标记异常；保留现场");
      return text.slice(begin, end + END_RULES.length);
    };
    for (const p of [main, dev]) {
      if (
        managed(await fs.readFile(path.join(p, "AGENTS.md"), "utf8")) !==
        managed(journal.files["AGENTS.md"])
      )
        throw Error("初始化规则区块已有未知修改；保留现场，不覆盖");
    }
    await interfaceTool(refs["interface:project_rules"], [
      "--project",
      input.id,
      "--write",
    ]);
  }
  const checks = await checkProject(
    journal.manifest,
    main,
    dev,
    refs,
    aiRoot,
    true,
  );
  journal.completed = true;
  await saveJournal(journalPath, journal, aiRoot);
  return { project: info(journal.manifest), createdPaths: created, checks };
}

async function checkProject(
  manifest: Dict,
  main: string,
  dev: string,
  refs: Record<string, string>,
  aiRoot: string,
  strict: boolean,
): Promise<string[]> {
  for (const p of Object.values(manifest.documents) as string[]) {
    await safePath(p, path.dirname(path.dirname(manifest.target_root)));
    if (!(await stat(p))) throw Error("交接文档缺失：" + p);
  }
  for (const p of [
    path.join(dev, "docs/requirements.md"),
    path.join(main, "AGENTS.md"),
    path.join(dev, "AGENTS.md"),
  ])
    if (!(await stat(p))) throw Error("项目入口缺失：" + p);
  if (
    (await git(main, ["branch", "--show-current"])) !== "main" ||
    (await git(dev, ["branch", "--show-current"])) !== "dev"
  )
    throw Error("工作区分支漂移");
  const tree = await git(main, ["worktree", "list", "--porcelain"]);
  if (
    !tree.includes("branch refs/heads/main") ||
    !tree.includes("branch refs/heads/dev")
  )
    throw Error("缺少 main/dev worktree");
  await safePath(refs["interface:validate"], aiRoot);
  await safePath(refs["interface:observe"], aiRoot);
  await safePath(refs["interface:project_rules"], aiRoot);
  await interfaceTool(refs["interface:validate"], []);
  await interfaceTool(refs["interface:observe"], ["--project", manifest.id]);
  if (strict)
    await interfaceTool(refs["interface:project_rules"], [
      "--project",
      manifest.id,
      "--strict",
    ]);
  const mainStatus = await git(main, ["status", "--porcelain"]),
    devStatus = await git(dev, ["status", "--porcelain"]);
  return [
    "中央 manifest/schema 校验通过",
    "本机 validate 与 observe 接口执行完成",
    "main/dev worktree 核对通过",
    "产品、需求、研究、反馈及规则入口齐全",
    "main Git status：" + (mainStatus || "clean"),
    "dev Git status：" + (devStatus || "clean"),
    "未创建远端、推送或发布",
  ];
}

export async function initializeProject(
  aiRoot: string,
  codeRoot: string,
  input: ProjectInput,
): Promise<ProjectInitResult> {
  return serialized("project:" + path.resolve(aiRoot) + ":" + input.id, () =>
    initialize(aiRoot, codeRoot, input),
  );
}
