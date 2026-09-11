import { execFile } from "node:child_process";
import { promises as fs, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import type { Artifact, ProjectInfo } from "../shared/types.js";
import type {
  ProjectChange,
  ProjectDiscoveryState,
  ProjectDocumentObservation,
  ProjectObservation,
  ProjectWorktreeObservation,
} from "../shared/projects.js";
import { hash, readOwnedArtifactSync, within } from "./files.js";
export type {
  ProjectChange,
  ProjectDiscoveryState,
  ProjectDocumentObservation,
  ProjectObservation,
  ProjectWorktreeObservation,
} from "../shared/projects.js";

const run = promisify(execFile);
const MAX_DIRECTORIES = 1600,
  MAX_PROJECTS = 300,
  MAX_DEPTH = 5,
  DEADLINE_MS = 22000;
const SKIP = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  "target",
  "coverage",
  "__pycache__",
  "venv",
  "env",
]);
const MARKERS = new Set([
  "README.md",
  "AGENTS.md",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
]);
type Candidate = ProjectInfo & {
  worktrees: { path: string; expectedBranch?: string }[];
  warnings: string[];
};
type ScanResult = { projects: ProjectInfo[]; discovery: ProjectDiscoveryState };
type Context = {
  aiRoot: string;
  codeRoot: string;
  deadline: number;
  errors: string[];
  truncated: boolean;
  directories: number;
};
type JSONRecord = Record<string, unknown>;

function object(value: unknown): JSONRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JSONRecord)
    : undefined;
}
function chain(directory: string): void {
  for (
    let current = path.resolve(directory);
    ;
    current = path.dirname(current)
  ) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      if (!(
        process.platform === "darwin" &&
        ["/var", "/tmp", "/etc"].includes(current) &&
        realpathSync(current) === "/private" + current
      ))
        throw new Error("路径经过符号链接");
    } else if (!stat.isDirectory()) throw new Error("路径不是目录");
    if (current === path.dirname(current)) break;
  }
}
async function inspectPath(root: string, file: string) {
  if (!within(root, file)) throw new Error("路径超出允许目录");
  chain(root);
  const relative = path.relative(root, file).split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < relative.length; index++) {
    current = path.join(current, relative[index]!);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error("已跳过符号链接");
    if (index < relative.length - 1 && !stat.isDirectory())
      throw new Error("父路径不是目录");
    if (index === relative.length - 1) return stat;
  }
  return fs.lstat(root);
}
async function jsonFile(root: string, file: string): Promise<JSONRecord> {
  const stat = await inspectPath(root, file);
  if (!stat?.isFile() || stat.size > 512 * 1024)
    throw new Error("登记文件不存在或过大");
  const result = object(
    JSON.parse(
      readOwnedArtifactSync(
        { path: file } as Artifact,
        path.dirname(file),
      ).toString("utf8"),
    ),
  );
  if (!result) throw new Error("登记文件格式无效");
  return result;
}
function limit(context: Context): boolean {
  if (Date.now() > context.deadline || context.directories >= MAX_DIRECTORIES) {
    context.truncated = true;
    return true;
  }
  return false;
}
function issue(context: Context, message: string) {
  if (context.errors.length < 80) context.errors.push(message);
}

async function registered(context: Context): Promise<Candidate[]> {
  const result: Candidate[] = [];
  let config;
  try {
    config = await jsonFile(
      context.aiRoot,
      path.join(context.aiRoot, "system", "system.json"),
    );
  } catch {
    issue(context, "中央项目登记不可读取；仍会从 Code 目录发现本地项目。");
    return result;
  }
  const glob = config.project_manifest_glob;
  if (
    typeof glob !== "string" ||
    !glob.endsWith("/*.json") ||
    /[*?[\]{}]/.test(glob.slice(0, -7)) ||
    path.isAbsolute(glob)
  ) {
    issue(context, "中央项目登记目录配置无效，未执行其中任何命令。");
    return result;
  }
  const system = path.join(context.aiRoot, "system"),
    directory = path.resolve(system, path.dirname(glob));
  if (!within(system, directory)) {
    issue(context, "中央项目登记目录越界，已跳过。");
    return result;
  }
  try {
    if (!(await inspectPath(context.aiRoot, directory))?.isDirectory())
      throw new Error();
    const entries = await fs.opendir(directory);
    for await (const file of entries) {
      if (limit(context) || result.length >= MAX_PROJECTS) {
        context.truncated = true;
        break;
      }
      if (
        !file.isFile() ||
        !file.name.endsWith(".json") ||
        file.name.startsWith(".")
      )
        continue;
      const manifestPath = path.join(directory, file.name);
      try {
        const manifest = await jsonFile(context.aiRoot, manifestPath);
        if (
          manifest.schema_version !== 1 ||
          typeof manifest.id !== "string" ||
          !/^[a-z0-9][a-z0-9.-]*$/.test(manifest.id) ||
          typeof manifest.target_root !== "string" ||
          !path.isAbsolute(manifest.target_root)
        )
          throw new Error("登记版本、ID 或路径无效");
        const root = path.resolve(manifest.target_root);
        if (!within(context.codeRoot, root) || root === context.codeRoot) {
          issue(
            context,
            `${manifest.id} 的登记路径不在当前 Code 根目录，未读取。`,
          );
          continue;
        }
        const warnings: string[] = [];
        if (file.name !== `${manifest.id}.json`) {
          warnings.push(
            "中央登记文件名与项目 ID 不一致，已保留登记信息供核查。",
          );
          issue(
            context,
            `项目 ${manifest.id} 的中央登记文件名不一致，登记信息仍已读取。`,
          );
        }
        const worktrees: Candidate["worktrees"] = [];
        for (const item of Array.isArray(manifest.worktrees)
          ? manifest.worktrees.slice(0, 80)
          : []) {
          const worktree = object(item);
          if (!worktree || worktree.retired === true) continue;
          if (
            typeof worktree.path !== "string" ||
            !path.isAbsolute(worktree.path) ||
            !within(context.codeRoot, worktree.path)
          ) {
            warnings.push("有已登记 worktree 超出当前 Code，未读取。");
            continue;
          }
          worktrees.push({
            path: path.resolve(worktree.path),
            expectedBranch:
              typeof worktree.branch === "string"
                ? worktree.branch.slice(0, 200)
                : undefined,
          });
        }
        const dev = (
          Array.isArray(manifest.worktrees) ? manifest.worktrees : []
        )
          .map(object)
          .find((item) => item?.role === "dev" && item.retired !== true);
        const devPath =
          typeof dev?.path === "string" && within(context.codeRoot, dev.path)
            ? path.resolve(dev.path)
            : (worktrees[0]?.path ?? root);
        const documents: ProjectInfo["documents"] = {};
        for (const [name, value] of Object.entries(
          object(manifest.documents) ?? {},
        ).slice(0, 30)) {
          if (value === null) {
            documents[name] = null;
            continue;
          }
          if (
            typeof value !== "string" ||
            !path.isAbsolute(value) ||
            !within(context.codeRoot, value)
          ) {
            warnings.push(`文档 ${name} 路径越界，未读取。`);
            continue;
          }
          documents[name] = path.resolve(value);
        }
        if (!documents.rules) documents.rules = path.join(devPath, "AGENTS.md");
        result.push({
          id: manifest.id,
          name:
            typeof manifest.name === "string"
              ? manifest.name.slice(0, 160)
              : manifest.id,
          series:
            typeof manifest.series === "string"
              ? manifest.series.slice(0, 20)
              : "未分类",
          root,
          devPath,
          documents,
          registered: true,
          lifecycle:
            typeof manifest.lifecycle === "string"
              ? manifest.lifecycle.slice(0, 40)
              : undefined,
          manifestPath,
          worktrees,
          warnings,
        });
      } catch {
        issue(context, `无法读取项目登记 ${file.name}，其余项目继续扫描。`);
      }
    }
  } catch {
    issue(context, "中央项目登记目录不可读取，实际 Code 扫描继续。");
  }
  return result;
}

async function discover(
  context: Context,
  known: Candidate[],
): Promise<Candidate[]> {
  const projects = new Map(known.map((project) => [project.root, project]));
  const knownWorktrees = new Map(
    known.flatMap((project) =>
      project.worktrees.map((worktree) => [worktree.path, project] as const),
    ),
  );
  const pending = [{ directory: context.codeRoot, depth: 0 }];
  while (pending.length && !limit(context)) {
    const { directory, depth } = pending.shift()!;
    context.directories++;
    let names: string[] = [],
      children: string[] = [],
      hasGit = false;
    try {
      if (!(await inspectPath(context.codeRoot, directory))?.isDirectory())
        continue;
      const entries = await fs.opendir(directory);
      let count = 0;
      for await (const entry of entries) {
        if (++count > 2500) {
          context.truncated = true;
          break;
        }
        if (entry.isSymbolicLink()) continue;
        if (entry.name === ".git" && (entry.isFile() || entry.isDirectory()))
          hasGit = true;
        if (entry.isFile()) names.push(entry.name);
        if (
          entry.isDirectory() &&
          !entry.name.startsWith(".") &&
          !SKIP.has(entry.name)
        )
          children.push(entry.name);
      }
    } catch {
      issue(
        context,
        `无法检查目录 ${path.relative(context.codeRoot, directory) || "Code"}。`,
      );
      continue;
    }
    const relative = path
      .relative(context.codeRoot, directory)
      .split(path.sep)
      .filter(Boolean);
    const standard =
      relative.length === 2 && ["x", "y", "z"].includes(relative[0]!);
    const containerName = path.basename(directory);
    let worktreeContainer = false;
    // The same sibling main/dev layout is valid below custom groups such as Code/clients/<id>.
    // Only inspect Git markers here; repository source trees remain traversal boundaries.
    if (
      !hasGit &&
      children.includes(`${containerName}-main`) &&
      children.includes(`${containerName}-dev`)
    ) {
      try {
        const markers = await Promise.all(
          ["main", "dev"].map((role) =>
            inspectPath(
              context.codeRoot,
              path.join(directory, `${containerName}-${role}`, ".git"),
            ),
          ),
        );
        worktreeContainer = markers.every(
          (stat) => stat?.isDirectory() || stat?.isFile(),
        );
      } catch {
        /* Invalid/link markers will be reported by their own project observation. */
      }
    }
    let project = projects.get(directory) ?? knownWorktrees.get(directory);
    if (
      !project &&
      (hasGit ||
        standard ||
        worktreeContainer ||
        names.some((name) => MARKERS.has(name)))
    ) {
      const parent = projects.get(path.dirname(directory));
      if (
        parent &&
        path.basename(directory).startsWith(path.basename(parent.root) + "-")
      )
        project = parent;
      else if (projects.size < MAX_PROJECTS) {
        project = {
          id: `local-${hash(directory).slice(0, 16)}`,
          name: path.basename(directory),
          series: ["x", "y", "z"].includes(relative[0]!)
            ? relative[0]!
            : "未分类",
          root: directory,
          devPath: directory,
          documents: {},
          registered: false,
          worktrees: [],
          warnings: [],
        };
        projects.set(directory, project);
      } else context.truncated = true;
    }
    if (project && hasGit) {
      if (!project.worktrees.some((worktree) => worktree.path === directory))
        project.worktrees.push({ path: directory });
      if (path.basename(directory).endsWith("-dev"))
        project.devPath = directory;
    }
    // A repository is a project boundary. Its source tree is never recursively scanned.
    if (!hasGit && depth < MAX_DEPTH)
      children.sort().forEach((child) =>
        pending.push({
          directory: path.join(directory, child),
          depth: depth + 1,
        }),
      );
    else if (!hasGit && children.length && depth === MAX_DEPTH)
      context.truncated = true;
  }
  for (const project of projects.values()) {
    if (!project.registered)
      project.documents = {
        entry: path.join(project.devPath, "README.md"),
        rules: path.join(project.devPath, "AGENTS.md"),
      };
  }
  return [...projects.values()];
}

async function gitDirectory(
  context: Context,
  worktree: string,
): Promise<{ gitPath: string; commonPath: string }> {
  const git = path.join(worktree, ".git"),
    stat = await inspectPath(context.codeRoot, git);
  if (!stat) throw new Error("未找到 Git 元数据");
  let gitPath = git;
  if (stat.isFile()) {
    if (stat.size > 8192) throw new Error("Git 指针过大");
    const text = readOwnedArtifactSync({ path: git } as Artifact, worktree)
      .toString("utf8")
      .trim();
    if (!text.startsWith("gitdir: ")) throw new Error("Git 指针格式无效");
    gitPath = path.resolve(worktree, text.slice(8));
  }
  if (!(await inspectPath(context.codeRoot, gitPath))?.isDirectory())
    throw new Error("Git 目录不可读取");
  let commonPath = gitPath;
  const common = path.join(gitPath, "commondir"),
    commonStat = await inspectPath(context.codeRoot, common);
  if (commonStat) {
    if (!commonStat.isFile() || commonStat.size > 8192)
      throw new Error("Git 公共目录指针无效");
    const target = readOwnedArtifactSync({ path: common } as Artifact, gitPath)
      .toString("utf8")
      .trim();
    commonPath = path.resolve(gitPath, target);
    if (!(await inspectPath(context.codeRoot, commonPath))?.isDirectory())
      throw new Error("Git 公共目录不可读取");
  }
  return { gitPath, commonPath };
}

async function isolatedGitMetadata(
  context: Context,
  gitPath: string,
  commonPath: string,
  directory: string,
): Promise<string> {
  let visited = 0;
  const validateTree = async (
    source: string,
    destination?: string,
    depth = 0,
  ): Promise<void> => {
    if (++visited > 10000 || depth > 20 || Date.now() > context.deadline)
      throw new Error("Git 元数据检查达到上限");
    const stat = await inspectPath(context.codeRoot, source);
    if (!stat) return;
    if (stat.isDirectory()) {
      if (destination)
        await fs.mkdir(destination, { recursive: true, mode: 0o700 });
      const entries = await fs.opendir(source);
      for await (const entry of entries)
        await validateTree(
          path.join(source, entry.name),
          destination ? path.join(destination, entry.name) : undefined,
          depth + 1,
        );
    } else if (stat.isFile()) {
      if (destination)
        await fs.writeFile(
          destination,
          readOwnedArtifactSync(
            { path: source } as Artifact,
            path.dirname(source),
          ),
          { flag: "wx", mode: 0o600 },
        );
    } else throw new Error("Git 元数据类型无效");
  };
  // Git reads only our minimal config. Repository filters, includes, hooks and fsmonitor commands never enter this process.
  const configPath = path.join(commonPath, "config"),
    configStat = await inspectPath(context.codeRoot, configPath);
  let config = "";
  if (configStat) {
    if (!configStat.isFile() || configStat.size > 512 * 1024)
      throw new Error("Git 配置不可读取");
    config = readOwnedArtifactSync(
      { path: configPath } as Artifact,
      commonPath,
    ).toString("utf8");
  }
  await inspectPath(context.codeRoot, path.join(gitPath, "config.worktree"));
  const sha256 = /^\s*objectformat\s*=\s*sha256\s*$/im.test(config);
  const filemode = !/^\s*filemode\s*=\s*false\s*$/im.test(config);
  const ignorecase = /^\s*ignorecase\s*=\s*true\s*$/im.test(config);
  await fs.writeFile(
    path.join(directory, "config"),
    `[core]\nrepositoryformatversion = ${sha256 ? 1 : 0}\nbare = false\nfilemode = ${filemode}\nignorecase = ${ignorecase}\nfsmonitor = false\nhooksPath = /dev/null\nattributesFile = /dev/null\nexcludesFile = /dev/null\n${sha256 ? "[extensions]\nobjectformat = sha256\n" : ""}`,
    { flag: "wx", mode: 0o600 },
  );
  for (const name of ["HEAD", "index"])
    await validateTree(path.join(gitPath, name), path.join(directory, name));
  const gitEntries = await fs.opendir(gitPath);
  for await (const entry of gitEntries)
    if (entry.name.startsWith("sharedindex."))
      await validateTree(
        path.join(gitPath, entry.name),
        path.join(directory, entry.name),
      );
  await validateTree(
    path.join(commonPath, "refs"),
    path.join(directory, "refs"),
  );
  await validateTree(
    path.join(commonPath, "packed-refs"),
    path.join(directory, "packed-refs"),
  );
  await fs.mkdir(path.join(directory, "info"), { mode: 0o700 });
  await validateTree(
    path.join(commonPath, "info/exclude"),
    path.join(directory, "info/exclude"),
  );
  const objects = path.join(commonPath, "objects");
  if (!(await inspectPath(context.codeRoot, objects))?.isDirectory())
    throw new Error("Git 对象目录缺失");
  // Object files are never copied or interpreted by ytriple. Reject links/alternates before Git gets an object directory.
  await validateTree(objects);
  for (const name of ["alternates", "http-alternates"]) {
    const alternate = await inspectPath(
      context.codeRoot,
      path.join(objects, "info", name),
    );
    if (alternate && alternate.size > 0)
      throw new Error("Git 对象依赖额外目录，本轮不跨目录观察");
  }
  return objects;
}
async function observeGit(
  context: Context,
  input: Candidate["worktrees"][number],
): Promise<ProjectWorktreeObservation> {
  const record: ProjectWorktreeObservation = { ...input, state: "ready" };
  if (limit(context))
    return { ...record, state: "error", error: "本轮扫描达到上限，尚未检查。" };
  let temporary: string | undefined;
  try {
    const stat = await inspectPath(context.codeRoot, input.path);
    if (!stat)
      return { ...record, state: "missing", error: "worktree 目录不存在。" };
    if (!stat.isDirectory()) throw new Error("不是目录");
    const { gitPath, commonPath } = await gitDirectory(context, input.path);
    temporary = await fs.mkdtemp(
      path.join(os.tmpdir(), "ytriple-git-observe-"),
    );
    const objectDirectory = await isolatedGitMetadata(
      context,
      gitPath,
      commonPath,
      temporary,
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    );
    Object.assign(env, {
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_OBJECT_DIRECTORY: objectDirectory,
      GIT_ATTR_NOSYSTEM: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_NO_LAZY_FETCH: "1",
    });
    const { stdout } = await run(
      "git",
      [
        "--no-optional-locks",
        `--git-dir=${temporary}`,
        `--work-tree=${input.path}`,
        "-c",
        "core.untrackedCache=false",
        "-C",
        input.path,
        "status",
        "--porcelain=v2",
        "--branch",
        "-z",
        "--untracked-files=normal",
        "--ignore-submodules=all",
      ],
      {
        env,
        timeout: 4500,
        maxBuffer: 512 * 1024,
        encoding: "utf8",
        killSignal: "SIGKILL",
      },
    );
    // Only paths and metadata are observed; source file content and diffs are never read.
    const records = stdout.split("\0").filter(Boolean),
      changed: string[] = [];
    for (let index = 0; index < records.length; index++) {
      const line = records[index]!;
      if (line.startsWith("# branch.head ")) record.branch = line.slice(14);
      else if (line.startsWith("# branch.oid ")) record.head = line.slice(13);
      else if (line.startsWith("1 "))
        changed.push(line.split(" ").slice(8).join(" "));
      else if (line.startsWith("2 ")) {
        changed.push(line.split(" ").slice(9).join(" "));
        index++;
      } else if (line.startsWith("u "))
        changed.push(line.split(" ").slice(10).join(" "));
      else if (line.startsWith("? ")) changed.push(line.slice(2));
    }
    record.changedFiles = changed.length;
    const metadata: unknown[] = [];
    for (const relative of changed.slice(0, 200)) {
      try {
        const file = path.resolve(input.path, relative);
        if (!within(input.path, file)) continue;
        const current = await inspectPath(context.codeRoot, file);
        metadata.push([relative, current?.size, current?.mtimeMs]);
      } catch {
        metadata.push([relative, "unavailable"]);
      }
    }
    if (changed.length > 200) {
      context.truncated = true;
      record.error = "变更文件元数据仅检查前 200 项。";
    }
    record.fingerprint = hash(JSON.stringify([stdout, metadata]));
    return record;
  } catch {
    return {
      ...record,
      state: "error",
      error: "Git 只读检查失败、路径不安全或超时，未修改项目。",
    };
  } finally {
    if (temporary)
      await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}

async function observe(
  context: Context,
  project: Candidate,
): Promise<ProjectInfo> {
  const issues = [...project.warnings],
    documents: ProjectDocumentObservation[] = [];
  let state: ProjectObservation["state"] = "ready";
  try {
    const root = await inspectPath(context.codeRoot, project.root);
    if (!root) state = "missing";
    else if (!root.isDirectory()) state = "error";
  } catch {
    state = "error";
    issues.push("项目路径经过链接或不可读取，已停止该路径检查。");
  }
  const worktrees: ProjectWorktreeObservation[] = [];
  if (state === "ready") {
    for (const worktree of project.worktrees)
      worktrees.push(await observeGit(context, worktree));
    for (const [name, file] of Object.entries(project.documents)) {
      if (!file) continue;
      const document: ProjectDocumentObservation = {
        name,
        path: file,
        state: "missing",
      };
      try {
        const stat = await inspectPath(context.codeRoot, file);
        if (stat) {
          document.state = "present";
          document.modifiedAt = stat.mtime.toISOString();
          document.bytes = stat.size;
        }
      } catch {
        document.state = "error";
      }
      documents.push(document);
    }
    for (const worktree of worktrees) {
      if (worktree.state !== "ready")
        issues.push(`${path.basename(worktree.path)}：${worktree.error}`);
      if (
        worktree.expectedBranch &&
        worktree.branch &&
        worktree.branch !== worktree.expectedBranch
      )
        issues.push(`${path.basename(worktree.path)} 当前分支与登记不同。`);
    }
    if (
      project.registered &&
      documents.some((document) => document.state !== "present")
    )
      issues.push("有登记文档或规则文件缺失、不可读取。");
    if (!project.registered) issues.push("发现本地项目，尚未在 AI 中央登记。");
    if (!worktrees.length) issues.push("未发现可检查的 Git worktree。");
    if (issues.length) state = "attention";
  }
  const { warnings: _warnings, worktrees: _worktrees, ...info } = project;
  const fingerprint = hash(
    JSON.stringify([
      info.name,
      info.registered,
      info.lifecycle,
      state,
      worktrees,
      documents,
      issues,
    ]),
  );
  return {
    ...info,
    observation: {
      state,
      checkedAt: new Date().toISOString(),
      worktrees,
      documents,
      issues,
      fingerprint,
    },
  };
}

export class ProjectDiscovery {
  private value: ScanResult = {
    projects: [],
    discovery: {
      status: "idle",
      aiRoot: "",
      codeRoot: "",
      errors: [],
      truncated: false,
      changes: [],
    },
  };
  private pending?: { key: string; promise: Promise<ScanResult> };
  private generation = 0;
  get snapshot(): ScanResult {
    return this.value;
  }
  refresh(aiInput: string, codeInput: string): Promise<ScanResult> {
    const aiRoot = path.resolve(aiInput),
      codeRoot = path.resolve(codeInput),
      key = JSON.stringify([aiRoot, codeRoot]);
    if (this.pending?.key === key) return this.pending.promise;
    const previous =
      this.value.discovery.aiRoot === aiRoot &&
      this.value.discovery.codeRoot === codeRoot
        ? this.value
        : undefined;
    const generation = ++this.generation;
    this.value = {
      projects: previous?.projects ?? [],
      discovery: {
        status: "scanning",
        aiRoot,
        codeRoot,
        errors: [],
        truncated: false,
        changes: previous?.discovery.changes ?? [],
        checkedAt: previous?.discovery.checkedAt,
      },
    };
    const promise = this.scan(aiRoot, codeRoot, previous)
      .then((result) => {
        if (generation === this.generation) this.value = result;
        return result;
      })
      .finally(() => {
        if (generation === this.generation) this.pending = undefined;
      });
    this.pending = { key, promise };
    return promise;
  }
  private async scan(
    aiRoot: string,
    codeRoot: string,
    previous?: ScanResult,
  ): Promise<ScanResult> {
    const began = Date.now(),
      context: Context = {
        aiRoot,
        codeRoot,
        deadline: began + DEADLINE_MS,
        errors: [],
        truncated: false,
        directories: 0,
      };
    try {
      chain(codeRoot);
      const candidates = await discover(context, await registered(context));
      const projects: ProjectInfo[] = [];
      let cursor = 0;
      await Promise.all(
        Array.from({ length: Math.min(3, candidates.length) }, async () => {
          while (cursor < candidates.length)
            projects.push(await observe(context, candidates[cursor++]!));
        }),
      );
      projects.sort(
        (a, b) =>
          a.series.localeCompare(b.series) || a.name.localeCompare(b.name),
      );
      const changes: ProjectChange[] = [];
      if (previous?.discovery.checkedAt) {
        const old = new Map(
          previous.projects.map((project) => [project.id, project]),
        );
        for (const project of projects) {
          const was = old.get(project.id);
          if (!was)
            changes.push({
              projectId: project.id,
              name: project.name,
              kind: "added",
              summary: `发现项目 ${project.name}`,
            });
          else if (
            was.observation?.fingerprint !== project.observation?.fingerprint
          )
            changes.push({
              projectId: project.id,
              name: project.name,
              kind: "changed",
              summary: `${project.name} 的 Git、文档或登记状态有变化`,
            });
          old.delete(project.id);
        }
        // A partial scan cannot establish that an unseen project was removed.
        if (!context.truncated && !context.errors.length)
          for (const project of old.values())
            changes.push({
              projectId: project.id,
              name: project.name,
              kind: "removed",
              summary: `当前 Code 中不再发现 ${project.name}`,
            });
      }
      const incomplete = projects.some(
        (project) =>
          project.observation?.state === "error" ||
          project.observation?.worktrees.some(
            (worktree) => worktree.state === "error",
          ) ||
          project.observation?.documents.some(
            (document) => document.state === "error",
          ),
      );
      return {
        projects,
        discovery: {
          status:
            context.errors.length || context.truncated || incomplete
              ? "partial"
              : "ready",
          aiRoot,
          codeRoot,
          checkedAt: new Date().toISOString(),
          errors: context.errors,
          truncated: context.truncated,
          changes: changes.slice(0, 100),
          durationMs: Date.now() - began,
        },
      };
    } catch {
      return {
        projects: previous?.projects ?? [],
        discovery: {
          status: "failed",
          aiRoot,
          codeRoot,
          checkedAt: previous?.discovery.checkedAt,
          errors: ["Code 根目录不存在、不可读取或经过符号链接；保留上次结果。"],
          truncated: false,
          changes: [],
          durationMs: Date.now() - began,
        },
      };
    }
  }
}
