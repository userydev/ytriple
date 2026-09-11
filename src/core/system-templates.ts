import path from "node:path";

export const BEGIN_RULES = "<!-- AI-SYSTEM:PROJECT-RULES BEGIN -->";
export const END_RULES = "<!-- AI-SYSTEM:PROJECT-RULES END -->";
export const json = (v: unknown): string => JSON.stringify(v, null, 2) + "\n";

export function rulesBlock(
  aiRoot: string,
  p: Record<string, any>,
  policyPath?: string,
  manifestPath?: string,
): string {
  const quote = (s: string) =>
    String.fromCharCode(96) + s + String.fromCharCode(96);
  return [
    BEGIN_RULES,
    "## 中央项目登记",
    "",
    "- 项目 ID：" + quote(p.id),
    "- 中央 manifest：" +
      quote(manifestPath || aiRoot + "/system/projects/" + p.id + ".json"),
    "- 本机政策：" + quote(policyPath || aiRoot + "/system/POLICY.md"),
    "- 产品系列：" + quote(p.series),
    "- 目标目录：" + quote(p.target_root),
    "- 项目入口：" + quote(p.documents.entry),
    "- 产品正文：" + quote(p.documents.product),
    "- 用户职责：决定产品目标、重大取舍、最终体验和外部动作授权。",
    "- Codex 职责：负责工程设计、实现、验证和状态维护。",
    "- 第三方 AI：仅提供建议；写回位置为 " +
      quote(p.documents.external_ai_writeback) +
      "。",
    "",
    "本区块由中央项目登记生成；项目独有规则保留在区块外。普通任务从 dev 分叉并回到 dev，稳定版本按 dev → main 集成。保留未知修改，不自动提交、推送、合并或发布。",
    END_RULES,
    "",
  ].join("\n");
}

export function defaultSystem(
  aiRoot: string,
  codeRoot: string,
): Record<string, any> {
  return {
    schema_version: 1,
    system_id: "local-ai-control-plane",
    root: aiRoot,
    code_root: codeRoot,
    home_layout: {
      root: path.dirname(aiRoot),
      managed_visible_roots: [aiRoot, codeRoot],
      standard_visible_roots: [],
      app_managed_visible_roots: [],
      unexpected_visible_policy: "report-only",
    },
    policy: "POLICY.md",
    work_profile: "work.json",
    work_schema: "schema/work.schema.json",
    series_catalog: "series.json",
    series_schema: "schema/series.schema.json",
    project_manifest_glob: "projects/*.json",
    project_schema: "schema/project.schema.json",
    project_template: "schema/project.example.json",
    knowledge_catalog: "knowledge.json",
    knowledge_schema: "schema/knowledge-catalog.schema.json",
    resource_catalog: "resources.json",
    resource_schema: "schema/resource-catalog.schema.json",
    observation_schema: "schema/observation.schema.json",
    interfaces: {
      validate: "tools/validate.cjs",
      observe: "tools/observe.cjs",
      project_rules: "tools/project_rules.cjs",
    },
    observation_policy: {
      mode: "read_only",
      allowed_roots: [
        codeRoot,
        path.join(aiRoot, "knowledge"),
        path.join(aiRoot, "resources"),
      ],
      manifest_commands_allowed: false,
      credentials_allowed: false,
      observations_are_authoritative: false,
    },
  };
}

export function projectTemplate(codeRoot: string): Record<string, any> {
  const root = path.join(codeRoot, "y/project-name"),
    dev = path.join(root, "project-name-dev");
  return {
    schema_version: 1,
    id: "project-name",
    name: "Project Name",
    series: "y",
    lifecycle: "incubating",
    product_type: "计划开源的工具或产品",
    ownership: "owned",
    current_roots: [root],
    target_root: root,
    repository: null,
    worktrees: [
      {
        role: "main",
        path: path.join(root, "project-name-main"),
        branch: "main",
        retired: false,
      },
      { role: "dev", path: dev, branch: "dev", retired: false },
    ],
    documents: {
      entry: path.join(dev, "README.md"),
      product: path.join(dev, "docs/product.md"),
      research: path.join(dev, "docs/research.md"),
      external_ai_writeback: path.join(dev, "docs/feedback.md"),
    },
    collaboration: {
      user: "决定产品目标、重大取舍、体验验收与外部动作授权。",
      codex: "负责工程设计、实现、验证和状态维护。",
      external_ai: {
        role: ["产品讨论", "资料核查", "方案审视"],
        authority: "advisory",
        writeback: path.join(dev, "docs/feedback.md"),
      },
    },
    monitoring: { enabled: true, probes: ["path", "git", "documents"] },
    migration: {
      state: "not-needed",
      note: "从零建立本地 main/dev；未创建远端、推送或发布。",
    },
  };
}

// A deliberately limited JSON Schema evaluator: only local refs; never fetches URLs or evaluates code.
export function validateJson(value: any, s: any, at = "$", root = s): string[] {
  if (s === true) return [];
  if (!s || s === false) return [at + ": invalid/disallowed schema"];
  if (s.$ref) {
    if (!s.$ref.startsWith("#/")) return [at + ": unsupported external schema"];
    const target = s.$ref
      .slice(2)
      .split("/")
      .reduce(
        (v: any, k: string) => v?.[k.replace(/~1/g, "/").replace(/~0/g, "~")],
        root,
      );
    return validateJson(value, target, at, root);
  }
  const errors: string[] = [],
    add = (detail: string) => errors.push(at + ": " + detail);
  const type =
    value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (
    s.type &&
    ![]
      .concat(s.type)
      .some(
        (t: string) =>
          t === type || (t === "integer" && Number.isInteger(value)),
      )
  )
    return [at + ": wrong type"];
  if ("const" in s && JSON.stringify(value) !== JSON.stringify(s.const))
    add("unexpected constant");
  if (
    s.enum &&
    !s.enum.some((x: any) => JSON.stringify(x) === JSON.stringify(value))
  )
    add("not in enum");
  if (typeof value === "string") {
    if (s.minLength && value.length < s.minLength) add("too short");
    if (s.pattern && !new RegExp(s.pattern).test(value))
      add("pattern mismatch");
  }
  if (type === "array") {
    if (s.minItems && value.length < s.minItems) add("too few items");
    if (s.maxItems && value.length > s.maxItems) add("too many items");
    if (
      s.uniqueItems &&
      new Set(value.map((x: any) => JSON.stringify(x))).size !== value.length
    )
      add("duplicate items");
    value.forEach((v: any, i: number) => {
      if (s.items)
        errors.push(...validateJson(v, s.items, at + "[" + i + "]", root));
    });
  }
  if (type === "object") {
    for (const k of s.required || []) if (!(k in value)) add("missing " + k);
    for (const [k, v] of Object.entries(value)) {
      if (s.properties && k in s.properties)
        errors.push(...validateJson(v, s.properties[k], at + "." + k, root));
      else if (s.additionalProperties === false) add("unknown " + k);
      else if (
        s.additionalProperties &&
        typeof s.additionalProperties === "object"
      )
        errors.push(
          ...validateJson(v, s.additionalProperties, at + "." + k, root),
        );
    }
  }
  return errors;
}

// Serialized into dependency-free Node tools. This code never executes manifest commands or URLs.
function standaloneTools(mode: string, nodeRequire: NodeRequire): void {
  const fs = nodeRequire("node:fs"),
    path = nodeRequire("node:path"),
    cp = nodeRequire("node:child_process");
  const entryRoot = path.resolve(__dirname, "..");
  const load = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));
  const system = load(path.join(entryRoot, "system.json"));
  const systemRoot = path.join(system.root, "system");
  if (fs.realpathSync(systemRoot) !== fs.realpathSync(entryRoot))
    throw Error("Configured root differs from interface location");
  const inside = (root: string, p: string) => {
    const r = path.relative(root, p);
    return (
      r === "" ||
      (r !== ".." && !r.startsWith(".." + path.sep) && !path.isAbsolute(r))
    );
  };
  function safe(p: string, root: string, allowLeafLink = false): string {
    p = path.resolve(p);
    if (!inside(root, p)) throw Error("Path outside allowed root: " + p);
    let current = root;
    for (const part of path.relative(root, p).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try {
        if (fs.lstatSync(current).isSymbolicLink()) {
          if (
            allowLeafLink &&
            current === p &&
            inside(fs.realpathSync(root), fs.realpathSync(p)) &&
            fs.statSync(p).isFile()
          )
            return p;
          throw Error("Symlink is not a managed path: " + current);
        }
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    return p;
  }
  const ref = (key: string) =>
    safe(path.resolve(systemRoot, system[key]), system.root, true);
  const projectDir = safe(
    path.join(systemRoot, path.dirname(system.project_manifest_glob)),
    systemRoot,
  );
  const selected = process.argv.includes("--project")
    ? process.argv[process.argv.indexOf("--project") + 1]
    : null;
  if (selected && !/^[a-z0-9][a-z0-9.-]*$/.test(selected))
    throw Error("Invalid project ID");
  const projects = fs
    .readdirSync(projectDir)
    .filter((n: string) => n.endsWith(".json"))
    .map((n: string) => ({
      file: safe(path.join(projectDir, n), systemRoot),
      data: load(safe(path.join(projectDir, n), systemRoot)),
    }))
    .filter((p: any) => !selected || p.data.id === selected);
  function projection(p: any, wt: any, write = false): any {
    const f = safe(path.join(wt.path, "AGENTS.md"), system.code_root);
    const old = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
    const begin = old.indexOf(BEGIN_RULES),
      end = old.indexOf(END_RULES);
    if (
      begin < 0 !== end < 0 ||
      (begin >= 0 &&
        (end < begin ||
          old.indexOf(BEGIN_RULES, begin + 1) >= 0 ||
          old.indexOf(END_RULES, end + 1) >= 0))
    )
      return { path: f, state: "invalid_markers", managed: false };
    const expected = rulesBlock(
      system.root,
      p,
      ref("policy"),
      path.join(projectDir, p.id + ".json"),
    );
    const state = !old
      ? "missing"
      : begin < 0
        ? "unmanaged"
        : old.slice(begin, end + END_RULES.length) + "\n" === expected
          ? "current"
          : "drift";
    if (write && state !== "current") {
      const next =
        begin < 0
          ? expected + (old ? "\n" + old : "")
          : old.slice(0, begin) +
            expected.trimEnd() +
            old.slice(end + END_RULES.length);
      if (fs.existsSync(f) && fs.readFileSync(f, "utf8") !== old)
        throw Error("Concurrent rule modification");
      const tmp = f + ".ytriple-" + process.pid;
      fs.writeFileSync(tmp, next, { flag: "wx" });
      fs.renameSync(tmp, f);
      return { path: f, state: "current", managed: true };
    }
    return { path: f, state, managed: begin >= 0 };
  }
  function git(dir: string, args: string[]): string {
    safe(dir, system.code_root);
    return cp
      .execFileSync(
        "git",
        [
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.hooksPath=/dev/null",
          "-C",
          dir,
          ...args,
        ],
        {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        },
      )
      .trim();
  }
  try {
    if (system.schema_version !== 1)
      throw Error("Unsupported system schema version");
    if (mode === "validate") {
      const errors: string[] = [];
      for (const [dataKey, schemaKey] of [
        ["work_profile", "work_schema"],
        ["series_catalog", "series_schema"],
        ["knowledge_catalog", "knowledge_schema"],
        ["resource_catalog", "resource_schema"],
        ["project_template", "project_schema"],
      ]) {
        try {
          errors.push(
            ...validateJson(load(ref(dataKey)), load(ref(schemaKey)), dataKey),
          );
        } catch (e: any) {
          errors.push(e.message);
        }
      }
      for (const { file, data } of projects) {
        errors.push(...validateJson(data, load(ref("project_schema")), file));
        for (const wt of data.worktrees || [])
          try {
            safe(wt.path, system.code_root);
          } catch (e: any) {
            errors.push(e.message);
          }
      }
      console.log(
        JSON.stringify(
          { schema_version: 1, projects: projects.length, errors },
          null,
          2,
        ),
      );
      process.exitCode = errors.length ? 1 : 0;
    } else if (mode === "project_rules") {
      const write = process.argv.includes("--write");
      if (write && !selected) throw Error("--write requires --project");
      if (selected && !projects.length)
        throw Error("Project is not registered");
      const result = projects.flatMap(({ data }: any) =>
        data.worktrees
          .filter((w: any) => !w.retired)
          .map((w: any) => ({ id: data.id, ...projection(data, w, write) })),
      );
      console.log(JSON.stringify(result, null, 2));
      if (
        process.argv.includes("--strict") &&
        result.some((r: any) => r.state !== "current")
      )
        process.exitCode = 1;
    } else if (mode === "observe") {
      const result = {
        schema_version: 1,
        observed_at: new Date().toISOString(),
        mode: "read_only",
        projects: projects.map(({ data }: any) => ({
          id: data.id,
          expected: {
            target_root: data.target_root,
            worktrees: data.worktrees,
          },
          observed: {
            worktrees: data.worktrees
              .filter((w: any) => !w.retired)
              .map((w: any) => {
                try {
                  return {
                    path: w.path,
                    exists: fs.existsSync(safe(w.path, system.code_root)),
                    branch: git(w.path, ["branch", "--show-current"]),
                    status: git(w.path, ["status", "--porcelain"]),
                    rules: projection(data, w),
                  };
                } catch (e: any) {
                  return { path: w.path, error: e.message };
                }
              }),
            documents: Object.fromEntries(
              Object.entries(data.documents).map(([k, v]: any) => [
                k,
                v
                  ? {
                      path: v,
                      exists: fs.existsSync(safe(v, system.code_root)),
                    }
                  : { path: null, exists: false },
              ]),
            ),
          },
          github: {
            state: "not_observed",
            detail: "Requires a separate authorized network connector",
          },
        })),
        errors: [],
      };
      console.log(JSON.stringify(result, null, 2));
    } else throw Error("Unknown interface");
  } catch (e: any) {
    console.error(JSON.stringify({ error: e.message }));
    process.exitCode = 1;
  }
}

const objectSchema = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({ type: "object", required, properties, additionalProperties: false });
const str = { type: "string", minLength: 1 },
  nullableString = { type: ["string", "null"] },
  ver = { const: 1 };
const arr = (items: unknown) => ({ type: "array", items });
const schema = (title: string, body: object) => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title,
  ...body,
});

export function systemTemplates(
  aiRoot: string,
  codeRoot: string,
): Record<string, string> {
  const now = new Date().toISOString();
  const projectSchema = schema(
    "Local AI project manifest",
    objectSchema({
      schema_version: ver,
      id: { type: "string", pattern: "^[a-z0-9][a-z0-9.-]*$" },
      name: str,
      series: { enum: ["x", "y", "z"] },
      lifecycle: {
        enum: ["active", "incubating", "paused", "archived", "external"],
      },
      product_type: str,
      ownership: { enum: ["owned", "external", "local-only"] },
      current_roots: { ...arr(str), minItems: 1, uniqueItems: true },
      target_root: str,
      repository: {
        type: ["object", "null"],
        properties: {
          url: { type: "string", pattern: "^https://github\\.com/" },
          visibility_current: { enum: ["private", "public", "unknown"] },
          visibility_intent: { enum: ["private", "public", "unknown"] },
          default_branch: nullableString,
        },
        required: [
          "url",
          "visibility_current",
          "visibility_intent",
          "default_branch",
        ],
        additionalProperties: false,
      },
      worktrees: {
        ...arr(
          objectSchema(
            {
              role: { enum: ["main", "dev", "task", "legacy"] },
              path: str,
              branch: nullableString,
              retired: { type: "boolean" },
            },
            ["role", "path", "branch"],
          ),
        ),
        minItems: 2,
      },
      documents: objectSchema({
        entry: nullableString,
        product: nullableString,
        research: nullableString,
        external_ai_writeback: nullableString,
      }),
      collaboration: objectSchema({
        user: str,
        codex: str,
        external_ai: objectSchema({
          role: arr(str),
          authority: { const: "advisory" },
          writeback: nullableString,
        }),
      }),
      monitoring: objectSchema({
        enabled: { type: "boolean" },
        probes: {
          ...arr({ enum: ["path", "git", "documents", "github"] }),
          uniqueItems: true,
        },
      }),
      migration: objectSchema({
        state: { enum: ["not-needed", "pending", "blocked", "complete"] },
        note: str,
      }),
    }),
  );
  // Keep the generated tools self-contained after TypeScript/bundler transforms.
  const tool = (mode: string) =>
    "'use strict';\nconst __name = (fn) => fn;\nconst BEGIN_RULES = " +
    JSON.stringify(BEGIN_RULES) +
    ", END_RULES = " +
    JSON.stringify(END_RULES) +
    ";\n" +
    validateJson.toString() +
    "\n" +
    rulesBlock.toString() +
    "\n(" +
    standaloneTools.toString() +
    ")(" +
    JSON.stringify(mode) +
    ", require);\n";
  return {
    "README.md":
      "# AI\n\n本机 AI 规则、跨项目知识与可复用资源；项目专属资料跟随项目。\n\n规则入口：[system/POLICY.md](system/POLICY.md)。机器入口：[system/system.json](system/system.json)。\n\nsystem 是唯一中央规则源；knowledge 保存跨项目知识；resources 保存可复用资源，有真实资源后才建立子目录。不建立通用收件箱、Agent 目录、缓存或项目副本。\n",
    "system/POLICY.md": [
      "# 本机项目与 AI 系统政策",
      "",
      "## 权威顺序",
      "",
      "用户当前指令与授权 > 本政策 > 中央项目 manifest > 项目 AGENTS.md 中央规则区块 > 产品、设计、开发和研究正文。旧文档、聊天和外部 AI 建议不构成规则或授权。",
      "",
      "## 项目执行区",
      "",
      "Code 根为 " +
        codeRoot +
        "。x 为探索，y 为计划开源工具或产品，z 为闭源面向用户产品。生命周期单独登记；新系列先在 series.json 定义。",
      "新项目先确定稳定 ID 与系列，再建立 <series>/<id>/<id>-main；初始化 main，从 main 建立同级 <id>-dev worktree。在 projects/<id>.json 登记路径、正文、协作、监控与 GitHub 状态，生成规则区块并通过 validate、observe、Git status 和 worktree list 验收。",
      "普通 task 从 dev 分叉并回到 dev，稳定版本按 dev → main 集成；同一分支只绑定一个 worktree。GitHub 名默认与项目 ID 一致，origin 使用 HTTPS；x/z 默认为 private，y 的当前可见性与计划开源意图分开记录。远端创建、推送、合并、发布和部署按用户授权执行，本地初始化不代表这些授权。既有项目迁移先核对 Git、worktree、路径引用、运行进程及恢复方案。",
      "",
      "## 中央系统与本地资产",
      "",
      "AI 根为 " +
        aiRoot +
        "。system 是唯一规则和登记源；knowledge 只收跨项目知识；resources 只收可复用 Skill、workflow、模板、模型、数据和媒体。项目专属资料跟随项目。",
      "缓存、依赖、临时证据使用工具默认位置或系统临时目录，不进入 AI。资源登记不授予联网、上传、登录或付费权限，凭据不得进入 AI 或项目仓库。",
      "进入项目先根据路径或 remote 确认项目 ID，读中央 manifest，再读项目入口。冲突报告漂移，不覆盖未知修改。AGENTS.md 只同步 AI-SYSTEM:PROJECT-RULES 标记区块，区块外规则保留；默认检查，不隐式改写。AI/AGENTS.md 与 Code/AGENTS.md 链接到本政策。",
      "",
      "## 协作与观察",
      "",
      "用户决定目标、优先级、重大取舍和体验；Codex 负责工程设计、实现、验证和规则同步；第三方 AI 为建议角色，仅写回项目指定位置，采纳后才成为结论。",
      "观察仅允许固定、带超时、无副作用的路径与 Git 检查。manifest 不承载任意命令、URL 探测或凭据。联网由单独授权连接器执行。本地 remote 不代表 GitHub 现场状态；期望与现场、缺失、失败和过期分别呈现。",
      "",
      "## 写入与保护",
      "",
      "修改既有项目前检查 Git 状态、全部 worktree、未跟踪文件、stash 和运行进程。保留未知改动，不隐式 stash 或强制推送。优先可恢复移动，破坏性清理按授权执行。",
      "Home 中的未知目录只报告，不自动清理；工具配置使用系统标准配置路径，不在 Home 建通用收件箱、缓存或 Agent 目录。",
      "",
    ].join("\n"),
    "system/system.json": json(defaultSystem(aiRoot, codeRoot)),
    "system/work.json": json({
      schema_version: 1,
      profile_id: "local-work",
      updated_at: now,
      domains: [
        {
          id: "software-products",
          title: "软件与产品项目",
          status: "active",
          description: "项目讨论、初始化和工程协作",
          workspace: codeRoot,
          activities: ["project-work"],
          output_policy: "project-owned",
          resource_bindings: [],
        },
      ],
      routing: {
        project_content: "project-owned",
        cross_project_knowledge: path.join(aiRoot, "knowledge"),
        reusable_resources: path.join(aiRoot, "resources"),
        unassigned_media_outputs: "explicit-destination",
      },
    }),
    "system/series.json": json({
      schema_version: 1,
      layout: {
        container: path.join(codeRoot, "{series}/{project}"),
        main_worktree: "{project}-main",
        dev_worktree: "{project}-dev",
        task_worktree: "{project}-{task}",
        feature_base: "dev",
        stable_integration: "dev-to-main",
      },
      series: ["x", "y", "z"].map((id, i) => ({
        id,
        name: ["Exploration", "Open", "Closed User Product"][i],
        description: [
          "探索型产品",
          "计划开源的工具或产品",
          "闭源面向用户的产品",
        ][i],
        code_root: path.join(codeRoot, id),
        default_visibility_current: "private",
        default_visibility_intent: id === "y" ? "public" : "private",
      })),
    }),
    "system/knowledge.json": json({
      schema_version: 1,
      catalog_id: "cross-project-knowledge",
      updated_at: now,
      items: [],
    }),
    "system/resources.json": json({
      schema_version: 1,
      catalog_id: "reusable-ai-resources",
      updated_at: now,
      allowed_types: [
        "skill",
        "workflow",
        "template",
        "model",
        "dataset",
        "media",
      ],
      resources: [],
    }),
    "system/schema/project.schema.json": json(projectSchema),
    "system/schema/project.example.json": json(projectTemplate(codeRoot)),
    "system/schema/work.schema.json": json(
      schema(
        "Work profile",
        objectSchema({
          schema_version: ver,
          profile_id: str,
          updated_at: str,
          domains: arr({
            type: "object",
            required: [
              "id",
              "title",
              "status",
              "workspace",
              "activities",
              "output_policy",
              "resource_bindings",
            ],
          }),
          routing: objectSchema({
            project_content: { const: "project-owned" },
            cross_project_knowledge: { const: path.join(aiRoot, "knowledge") },
            reusable_resources: { const: path.join(aiRoot, "resources") },
            unassigned_media_outputs: { const: "explicit-destination" },
          }),
        }),
      ),
    ),
    "system/schema/series.schema.json": json(
      schema(
        "Series catalog",
        objectSchema({
          schema_version: ver,
          layout: {
            type: "object",
            required: [
              "container",
              "main_worktree",
              "dev_worktree",
              "task_worktree",
              "feature_base",
              "stable_integration",
            ],
          },
          series: {
            ...arr(
              objectSchema({
                id: { enum: ["x", "y", "z"] },
                name: str,
                description: str,
                code_root: str,
                default_visibility_current: { enum: ["private", "public"] },
                default_visibility_intent: { enum: ["private", "public"] },
              }),
            ),
            minItems: 3,
            uniqueItems: true,
          },
        }),
      ),
    ),
    "system/schema/knowledge-catalog.schema.json": json(
      schema(
        "Knowledge catalog",
        objectSchema({
          schema_version: ver,
          catalog_id: { const: "cross-project-knowledge" },
          updated_at: str,
          items: arr({
            type: "object",
            required: ["id", "title", "path", "status", "sources"],
          }),
        }),
      ),
    ),
    "system/schema/resource-catalog.schema.json": json(
      schema(
        "Resource catalog",
        objectSchema({
          schema_version: ver,
          catalog_id: { const: "reusable-ai-resources" },
          updated_at: str,
          allowed_types: arr(str),
          resources: arr({
            type: "object",
            required: ["id", "title", "type", "path", "status", "execution"],
          }),
        }),
      ),
    ),
    "system/schema/observation.schema.json": json(
      schema(
        "Read-only observation",
        objectSchema({
          schema_version: ver,
          observed_at: str,
          mode: { const: "read_only" },
          projects: arr({
            type: "object",
            required: ["id", "expected", "observed", "github"],
          }),
          errors: arr(str),
        }),
      ),
    ),
    "system/tools/validate.cjs": tool("validate"),
    "system/tools/observe.cjs": tool("observe"),
    "system/tools/project_rules.cjs": tool("project_rules"),
  };
}
