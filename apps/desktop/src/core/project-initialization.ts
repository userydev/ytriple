import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
  readdir,
} from "node:fs/promises";
import { join, dirname, basename, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store";
import type { ArtifactVersion, Decision, Project, Run, Work } from "./types";
import { captureProjectContext } from "./projects";
import { LocalDirectories } from "./local-directories";
const exec = promisify(execFile);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
const busy = new Set<string>();
export const initializationInput = z
  .object({
    projectId: z.string().min(1).max(300),
    versionId: z.string().min(1).max(300),
    slug: z
      .string()
      .regex(
        /^[a-z][a-z0-9-]{1,47}$/,
        "项目 ID 使用 2 至 48 位小写英文字母、数字或连字符，并以字母开头",
      ),
    series: z.enum(["x", "y", "z"]),
    template: z.literal("software-handoff-v1"),
  })
  .strict();
export type InitializationInput = z.infer<typeof initializationInput>;
export type InitializationPlan = {
  restored?: boolean;
  id: string;
  input: InitializationInput;
  aiRoot: string;
  codeRoot: string;
  policyHash: string;
  policy: string;
  sourceHash: string;
  container: string;
  main: string;
  dev: string;
  manifestPath: string;
  manifest: string;
  files: Record<string, string>;
  status: "preview" | "running" | "failed" | "complete";
  step: string;
  error: string | null;
  createdAt: string;
  completedAt?: string;
  commit?: string;
};
export type InitializationSummary = Pick<
  InitializationPlan,
  | "id"
  | "input"
  | "container"
  | "dev"
  | "manifestPath"
  | "status"
  | "step"
  | "error"
  | "createdAt"
  | "completedAt"
  | "commit"
>;
export function initializationSummary(
  p: InitializationPlan,
): InitializationSummary {
  const {
    id,
    input,
    container,
    dev,
    manifestPath,
    status,
    step,
    error,
    createdAt,
    completedAt,
    commit,
  } = p;
  return {
    id,
    input,
    container,
    dev,
    manifestPath,
    status,
    step,
    error,
    createdAt,
    completedAt,
    commit,
  };
}
async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
async function plainDirectory(path: string) {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(path)) !== path
  )
    throw Error(`目录不是独立真实目录：${path}`);
}
async function textFile(path: string) {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size > 1_000_000 ||
    (await realpath(dirname(path))) !== dirname(path)
  )
    throw Error(`无法读取普通文件：${path}`);
  const bytes = await readFile(path);
  if (bytes.length > 1_000_000 || bytes.includes(0))
    throw Error("文件不是受支持的文本");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
async function ensureFile(path: string, body: string) {
  await plainDirectory(dirname(path));
  if (await exists(path)) {
    if ((await textFile(path)) !== body)
      throw Error(`文件与已确认计划不一致，保留原文件：${path}`);
  } else await writeFile(path, body, { flag: "wx", mode: 0o600 });
}
async function registryAvailable(
  aiRoot: string,
  slug: string,
  container: string,
  own?: { path: string; text: string },
) {
  const folder = join(aiRoot, "system/projects");
  const names = (await readdir(folder)).filter((n) => n.endsWith(".json"));
  if (names.length > 5000) throw Error("项目登记超过检查上限，未初始化");
  for (const name of names) {
    const path = join(folder, name),
      text = await textFile(path),
      entry = JSON.parse(text);
    if (entry.id === slug || entry.target_root === container) {
      if (!own || own.path !== path || own.text !== text)
        throw Error("中央登记中已有这个项目身份或路径");
    }
  }
}
async function safeRepository(path: string) {
  await plainDirectory(join(path, ".git"));
  const config = await textFile(join(path, ".git/config"));
  // Recover only the plain repository we created, never run filters/fsmonitor/includes from changed configuration.
  for (const line of config
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean))
    if (
      !/^\[core\]$/.test(line) &&
      !/^(repositoryformatversion\s*=\s*0|(?:filemode|bare|logallrefupdates|ignorecase|precomposeunicode)\s*=\s*(?:true|false))$/.test(
        line,
      )
    )
      throw Error("初始化仓库配置已变化，保留现状，不能自动执行 Git");
}
// Only application-owned Git arguments are allowed; no manifest-provided commands.
async function git(cwd: string, args: string[]) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
  );
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  });
  const { stdout } = await exec(
    "/usr/bin/git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "init.templateDir=",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "protocol.ext.allow=never",
      ...args,
    ],
    { cwd, env, timeout: 15000, maxBuffer: 1_000_000 },
  );
  return stdout.trim();
}
export class ProjectInitialization {
  constructor(readonly store: Store) {}
  async policy() {
    const dirs = new LocalDirectories(this.store),
      roots = dirs.roots();
    if (!roots.aiPath || !roots.codePath)
      throw Error("请先配置 AI 与 Code 目录");
    const aiRoot = await dirs.validatedDirectory("ai", roots.aiPath),
      codeRoot = await dirs.validatedDirectory("code", roots.codePath);
    let sources: string[];
    try {
      sources = await Promise.all(
        ["system/system.json", "system/series.json", "system/POLICY.md"].map(
          (p) => textFile(join(aiRoot, p)),
        ),
      );
    } catch {
      throw Error(
        "本机项目体系不完整：需要先建立或修复 AI/system 的规则与系列登记，现有内容不会被覆盖",
      );
    }
    const system = JSON.parse(sources[0]),
      catalog = JSON.parse(sources[1]);
    if (
      system.schema_version !== 1 ||
      system.system_id !== "local-ai-control-plane" ||
      system.root !== aiRoot ||
      system.code_root !== codeRoot ||
      system.project_manifest_glob !== "projects/*.json" ||
      system.policy !== "POLICY.md"
    )
      throw Error("本机项目体系版本或根路径不匹配，需先处理规则漂移");
    if (
      catalog.schema_version !== 1 ||
      catalog.layout?.container !== join(codeRoot, "{series}/{project}") ||
      catalog.layout?.main_worktree !== "{project}-main" ||
      catalog.layout?.dev_worktree !== "{project}-dev" ||
      catalog.layout?.feature_base !== "dev" ||
      catalog.layout?.stable_integration !== "dev-to-main"
    )
      throw Error("当前模板不适用于这套工作树布局，请先核对本机规则");
    await plainDirectory(join(aiRoot, "system/projects"));
    return {
      aiRoot,
      codeRoot,
      policy: sources[2],
      policyHash: hash(json(sources)),
      catalog,
    };
  }
  private source(input: InitializationInput) {
    const project = this.store.require<Project>("project", input.projectId);
    if (project.kind !== "software") throw Error("这个初始化模板用于软件项目");
    const version = this.store.require<ArtifactVersion>(
        "version",
        input.versionId,
      ),
      work = this.store.require<Work>("work", version.workId);
    const run = version.runId
      ? this.store.require<Run>("run", version.runId)
      : null;
    if (
      work.projectId !== project.id ||
      (run?.projectContext && run.projectContext.projectId !== project.id)
    )
      throw Error("产品定义不属于当前项目");
    if (
      version.author !== "team" ||
      (version.kind && version.kind !== "result") ||
      run?.status !== "succeeded" ||
      run.workId !== work.id ||
      !version.body.trim()
    )
      throw Error("请选择团队已完成的主成果作为产品定义");
    const context = captureProjectContext(this.store, project.id, null);
    const decisions = this.store
      .all<Decision>("decision")
      .filter(
        (d) =>
          d.status === "pending" &&
          this.store.get<Work>("work", d.workId)?.projectId === project.id,
      );
    return {
      project,
      version,
      work,
      context,
      decisions,
      sourceHash: hash(
        json({ name: project.name, version, context, decisions }),
      ),
    };
  }
  async preview(raw: InitializationInput): Promise<InitializationPlan> {
    const input = initializationInput.parse(raw),
      source = this.source(input);
    if (source.project.directory)
      throw Error("项目已有本地目录，请使用已有项目接入，不重新初始化");
    if (
      this.store
        .all<InitializationPlan>("initialization")
        .some(
          (p) =>
            !p.restored &&
            p.input.projectId === input.projectId &&
            ["running", "failed"].includes(p.status),
        )
    )
      throw Error("已有未完成初始化，请先检查或恢复原计划");
    const policy = await this.policy(),
      series = policy.catalog.series?.find(
        (s: { id: string }) => s.id === input.series,
      );
    if (!series || series.code_root !== join(policy.codeRoot, input.series))
      throw Error("所选系列尚未正确登记");
    await git(policy.codeRoot, ["--version"]);
    await plainDirectory(series.code_root);
    const container = join(series.code_root, input.slug),
      main = join(container, `${input.slug}-main`),
      dev = join(container, `${input.slug}-dev`),
      manifestPath = join(
        policy.aiRoot,
        "system/projects",
        `${input.slug}.json`,
      );
    if ((await exists(container)) || (await exists(manifestPath)))
      throw Error(
        "项目目录或稳定 ID 已存在，不能覆盖；请改用已有项目接入或其他 ID",
      );
    await registryAvailable(policy.aiRoot, input.slug, container);
    const id = randomUUID(),
      createdAt = new Date().toISOString();
    const manifest = {
      schema_version: 1,
      id: input.slug,
      name: source.project.name,
      series: input.series,
      lifecycle: "incubating",
      product_type: "software product",
      ownership: "local-only",
      current_roots: [container],
      target_root: container,
      repository: null,
      worktrees: [
        { role: "main", path: main, branch: "main", retired: false },
        { role: "dev", path: dev, branch: "dev", retired: false },
      ],
      documents: {
        entry: join(dev, "README.md"),
        product: join(dev, "docs/PRODUCT.md"),
        research: null,
        external_ai_writeback: join(dev, "docs/SUGGESTIONS.md"),
      },
      collaboration: {
        user: "决定产品目标、重大取舍、外部授权和最终体验验收。",
        codex: "从交接材料继续工程设计、实现与验证；未决事项先核对。",
        external_ai: {
          role: ["产品讨论", "方案审视"],
          authority: "advisory",
          writeback: join(dev, "docs/SUGGESTIONS.md"),
        },
      },
      monitoring: { enabled: true, probes: ["path", "git", "documents"] },
      migration: {
        state: "not-needed",
        note: "从已确认成果按 main/dev 结构初始化；尚未创建或关联远端仓库。",
      },
    };
    const c = manifest.collaboration;
    const rules = [
      "<!-- AI-SYSTEM:PROJECT-RULES BEGIN -->",
      "## 中央项目登记",
      "",
      `- 项目 ID：\`${input.slug}\``,
      `- 中央 manifest：\`${manifestPath}\``,
      `- 产品系列：\`${input.series}\``,
      "- 生命周期：`incubating`",
      `- 目标目录：\`${container}\``,
      `- 项目入口：\`${manifest.documents.entry}\``,
      `- 产品正文：\`${manifest.documents.product}\``,
      `- 用户职责：${c.user}`,
      `- Codex 职责：${c.codex}`,
      `- 第三方 AI：仅提供建议；用途为${c.external_ai.role.join("、")}；写回位置为 \`${c.external_ai.writeback}\`。`,
      "",
      `本区块由 \`${join(policy.aiRoot, "system")}\` 生成。先修改中央 manifest，再同步本区块；项目独有的构建、测试与安全规则保留在区块外。`,
      "<!-- AI-SYSTEM:PROJECT-RULES END -->",
      "",
    ].join("\n");
    const standards =
      source.context?.standards
        .map((s) => `### ${s.title} · v${s.revision}\n\n${s.body}`)
        .join("\n\n") || "尚无已采纳的项目标准。";
    const pending =
      source.decisions
        .map(
          (d) =>
            `- ${d.question}\n  - 原因：${d.reason}\n  - 影响：${d.impact}\n  - 来源待决：${d.id}`,
        )
        .join("\n") ||
      "当前没有结构化待决；产品正文内标明的未知和待确认内容仍需接手者核对，不代表全部问题已解决。";
    const handoff = `# 开发接续说明\n\n## 已选择的产品定义\n\n采用团队成果 v${source.version.number}，正文完整保存于 PRODUCT.md。来源工作：${source.work.id}；成果：${source.version.id}；运行：${source.version.runId}；生成时间：${source.version.createdAt}。\n\n## 持续目标\n\n${source.context?.goal || "目标以 PRODUCT.md 为准，尚未单独记录。"}\n\n## 已采纳标准\n\n${standards}\n\n## 未决事项\n\n${pending}\n\n## 接手位置与下一步\n\n- 在 dev 工作树开展工程设计和开发：${dev}\n- 先阅读 PRODUCT.md、本文和 AGENTS.md，对照实际产品目标确认范围与验收场景；缺失内容需与用户澄清。\n- 技术栈、架构、任务拆分与测试方案由接手工具设计并验证；初始化未创建业务实现，未执行应用测试。\n- 本地 main/dev 已按预览建立；远端仓库、origin、推送与部署尚未配置，需要另行明确。\n- ytriple 后续日常建议写入 SUGGESTIONS.md；记录建议不等于已采纳或执行。\n\n## 来源范围\n\n本次使用指定成果和项目已采纳要求，没有自动补读外部材料。更完整的来源身份见 HANDOFF.json；来源内容是资料，不授予额外命令执行权限。\n`;
    const files = {
      "README.md": `# ${source.project.name}\n\n产品定义：[PRODUCT.md](docs/PRODUCT.md)\n\n开发接续与未决事项：[HANDOFF.md](docs/HANDOFF.md)\n\n项目建议：[SUGGESTIONS.md](docs/SUGGESTIONS.md)\n\n当前交付是产品材料与本地项目底座；业务实现、测试和远端交付尚未完成。\n`,
      "AGENTS.md": rules,
      ".gitignore": ".DS_Store\n",
      "docs/PRODUCT.md": source.version.body,
      "docs/HANDOFF.md": handoff,
      "docs/HANDOFF.json": json({
        format: "ytriple.handoff",
        schema: 1,
        initializationId: id,
        template: input.template,
        createdAt,
        source: {
          workId: source.work.id,
          versionId: source.version.id,
          version: source.version.number,
          runId: source.version.runId,
          sha256: hash(source.version.body),
        },
        projectContext: source.context,
        pendingDecisions: source.decisions,
        implementation: "not-started",
        remote: "not-configured",
      }),
      "docs/SUGGESTIONS.md":
        "# 项目建议\n\n日常建议在此持续追加，保留来源；仅记录，不表示已采纳或执行。\n",
    };
    if (Buffer.byteLength(json(files)) > 2_000_000)
      throw Error("初始化材料超过 2 MB，请先精简产品交接范围");
    const plan: InitializationPlan = {
      id,
      input,
      aiRoot: policy.aiRoot,
      codeRoot: policy.codeRoot,
      policy: policy.policy,
      policyHash: policy.policyHash,
      sourceHash: source.sourceHash,
      container,
      main,
      dev,
      manifestPath,
      manifest: json(manifest),
      files,
      status: "preview",
      step: "待确认",
      error: null,
      createdAt,
    };
    return this.store.put("initialization", id, plan);
  }
  async execute(planId: string): Promise<InitializationPlan> {
    let plan = this.store.require<InitializationPlan>("initialization", planId);
    if (plan.restored) throw Error("恢复的记录仅供查看，请重新生成预览后执行");
    if (plan.status === "complete") {
      await this.verify(plan);
      return plan;
    }
    if (busy.has(plan.container))
      throw Error("该项目正在初始化，请等待当前操作");
    busy.add(plan.container);
    const save = (patch: Partial<InitializationPlan>) => {
      plan = { ...plan, ...patch };
      this.store.put("initialization", plan.id, plan);
    };
    try {
      const policy = await this.policy();
      if (
        policy.aiRoot !== plan.aiRoot ||
        policy.codeRoot !== plan.codeRoot ||
        policy.policyHash !== plan.policyHash
      )
        throw Error("本机规则或目录配置已变化，请先核对原初始化计划");
      const source = this.source(plan.input);
      if (source.project.directory && source.project.directory !== plan.dev)
        throw Error("项目已关联其他路径，停止初始化");
      if (plan.status === "preview" && source.sourceHash !== plan.sourceHash)
        throw Error("产品定义或项目要求已变化，请重新预览");
      await registryAvailable(
        plan.aiRoot,
        plan.input.slug,
        plan.container,
        plan.status === "preview"
          ? undefined
          : { path: plan.manifestPath, text: plan.manifest },
      );
      const marker = join(plan.container, ".ytriple-initialization.json"),
        identity = json({ id: plan.id, projectId: plan.input.projectId });
      if (plan.status === "preview") {
        if ((await exists(plan.container)) || (await exists(plan.manifestPath)))
          throw Error("目标路径或登记已存在，未覆盖任何文件");
        await plainDirectory(dirname(plan.container));
        save({ status: "running", step: "建立项目容器", error: null });
        await mkdir(plan.container, { mode: 0o700 });
        await writeFile(marker, identity, { flag: "wx", mode: 0o600 });
      } else {
        await plainDirectory(plan.container);
        if ((await textFile(marker)) !== identity)
          throw Error("无法确认未完成目录的归属，保留现场，需检查后恢复");
        save({ status: "running", error: null });
      }
      await plainDirectory(plan.container);
      save({ step: "写入已确认产品材料" });
      if (!(await exists(plan.main))) await mkdir(plan.main, { mode: 0o700 });
      await plainDirectory(plan.main);
      if (!(await exists(join(plan.main, "docs"))))
        await mkdir(join(plan.main, "docs"), { mode: 0o700 });
      for (const [name, text] of Object.entries(plan.files))
        await ensureFile(join(plan.main, name), text);
      save({ step: "建立本地 main 与 dev" });
      if (!(await exists(join(plan.main, ".git"))))
        await git(plan.main, ["init", "--initial-branch=main", "."]);
      await safeRepository(plan.main);
      if (
        (await git(plan.main, ["symbolic-ref", "--short", "HEAD"])) !== "main"
      )
        throw Error("主工作树分支已变化，未修改现有分支");
      let head = await git(plan.main, ["rev-parse", "--verify", "HEAD"]).catch(
        () => "",
      );
      if (!head) {
        await git(plan.main, ["add", "--", ...Object.keys(plan.files)]);
        const staged = await git(plan.main, [
          "diff",
          "--cached",
          "--name-only",
        ]);
        if (
          staged.split("\n").sort().join("\n") !==
          Object.keys(plan.files).sort().join("\n")
        )
          throw Error("暂存区含计划外变化，停止创建提交");
        await git(plan.main, [
          "-c",
          "user.name=ytriple",
          "-c",
          "user.email=local@ytriple.invalid",
          "commit",
          "--no-verify",
          "-m",
          `Initialize product handoff\n\nytriple-initialization:${plan.id}`,
        ]);
        head = await git(plan.main, ["rev-parse", "HEAD"]);
      } else if (
        !(await git(plan.main, ["log", "-1", "--format=%B"])).includes(
          `ytriple-initialization:${plan.id}`,
        )
      )
        throw Error("发现其他提交，保留现有 Git 历史，停止自动初始化");
      if (await git(plan.main, ["status", "--porcelain"]))
        throw Error("主工作树有计划外变化，需检查后继续");
      if (!(await exists(plan.dev)))
        await git(plan.main, [
          "worktree",
          "add",
          "-b",
          "dev",
          plan.dev,
          "main",
        ]);
      save({ commit: head, step: "登记与核对项目" });
      await this.verifyTrees(plan);
      await registryAvailable(plan.aiRoot, plan.input.slug, plan.container, {
        path: plan.manifestPath,
        text: plan.manifest,
      });
      await ensureFile(plan.manifestPath, plan.manifest);
      await this.verify(plan);
      this.store.transaction(() => {
        const project = this.store.require<Project>(
          "project",
          plan.input.projectId,
        );
        if (project.directory && project.directory !== plan.dev)
          throw Error("项目路径已变化，未改写关联");
        this.store.put("project", project.id, {
          ...project,
          directory: plan.dev,
        });
        this.store.put("suggestion-document", project.id, {
          id: randomUUID(),
          projectId: project.id,
          root: plan.dev,
          path: join(plan.dev, "docs/SUGGESTIONS.md"),
          selectedAt: new Date().toISOString(),
        });
        save({
          status: "complete",
          step: "本地底座与交接材料已就绪",
          error: null,
          completedAt: new Date().toISOString(),
        });
      });
      return plan;
    } catch (e) {
      save({
        status: plan.status === "preview" ? "preview" : "failed",
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    } finally {
      busy.delete(plan.container);
    }
  }
  private async verifyTrees(plan: InitializationPlan) {
    await safeRepository(plan.main);
    const admin = join(plan.main, ".git/worktrees", basename(plan.dev));
    await plainDirectory(admin);
    if (
      (await textFile(join(plan.dev, ".git"))).trim() !== `gitdir: ${admin}` ||
      resolve(admin, (await textFile(join(admin, "commondir"))).trim()) !==
        join(plan.main, ".git")
    )
      throw Error("dev 工作树关联已变化，停止核对");
    for (const [path, branch] of [
      [plan.main, "main"],
      [plan.dev, "dev"],
    ]) {
      await plainDirectory(path);
      if (
        (await git(path, ["symbolic-ref", "--short", "HEAD"])) !== branch ||
        (await git(path, ["rev-parse", "HEAD"])) !== plan.commit
      )
        throw Error("工作树分支或提交与初始化记录不一致");
      if (await git(path, ["status", "--porcelain"]))
        throw Error("工作树包含外部修改，请先检查");
      for (const [name, text] of Object.entries(plan.files))
        if ((await textFile(join(path, name))) !== text)
          throw Error(`交接文件与已确认版本不一致：${name}`);
    }
    const list = await git(plan.main, ["worktree", "list", "--porcelain"]);
    for (const [path, branch] of [
      [plan.main, "main"],
      [plan.dev, "dev"],
    ])
      if (
        !list.includes(
          `worktree ${path}\nHEAD ${plan.commit}\nbranch refs/heads/${branch}`,
        )
      )
        throw Error("未确认 main/dev 为同一仓库的工作树");
  }
  async verify(plan: InitializationPlan) {
    const policy = await this.policy();
    if (
      policy.policyHash !== plan.policyHash ||
      policy.aiRoot !== plan.aiRoot ||
      policy.codeRoot !== plan.codeRoot
    )
      throw Error("规则或根目录已变化，需重新核对");
    await this.verifyTrees(plan);
    if ((await textFile(plan.manifestPath)) !== plan.manifest)
      throw Error("中央登记与初始化计划不一致");
  }
}
