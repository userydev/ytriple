import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { createHash } from "node:crypto";
import type { Store } from "./store";
import type {
  Draft,
  Material,
  Project,
  ProjectFile,
  ProjectInspection,
  Reference,
  Work,
} from "./types";
import { LocalDirectories, isWithin } from "./local-directories";
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const MAX_FILE = 128_000,
  MAX_ENTRIES = 1500,
  MAX_DIRECTORIES = 300,
  MAX_CHECK_BYTES = 4_000_000;
const excludedDirectories = new Set([
  ".git",
  ".local",
  "node_modules",
  "vendor",
  "dist",
  "dist-server",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".idea",
  ".vscode",
  "playwright-report",
  "test-results",
]);
const textExtensions = new Set([
  ".md",
  ".mdx",
  ".txt",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".html",
  ".css",
  ".scss",
  ".less",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".sql",
  ".sh",
  ".bash",
  ".zsh",
  ".vue",
  ".svelte",
  ".rb",
  ".php",
  ".ini",
  ".conf",
  ".graphql",
  ".proto",
]);
function excluded(path: string) {
  const segments = path.split(/[\\/]/);
  const name = basename(path).toLowerCase();
  if (segments.some((s) => excludedDirectories.has(s.toLowerCase())))
    return "依赖、生成文件或本地运行目录";
  if (
    name.startsWith(".env") ||
    /(^|[._-])(secret|secrets|credential|credentials|token|tokens)([._-]|$)/i.test(
      name,
    ) ||
    /\.(pem|key|p12|pfx|keystore)$/i.test(name) ||
    /^id_(rsa|ed25519)/i.test(name)
  )
    return "凭据或秘密文件";
  if (
    [
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "cargo.lock",
      "uv.lock",
      "poetry.lock",
    ].includes(name)
  )
    return "依赖锁文件，当前批次不解析";
  if (name.endsWith(".min.js") || name.endsWith(".map")) return "生成文件";
  return null;
}
function category(path: string): ProjectFile["kind"] {
  const name = basename(path).toLowerCase();
  if (/(^|\/)(__tests__|tests?|specs?)(\/|$)|\.(test|spec)\./i.test(path))
    return "test";
  if (
    /\.(md|mdx|txt)$/i.test(path) ||
    /^(readme|license|changelog|agents)(\.|$)/i.test(name)
  )
    return "documentation";
  if (
    /(^|\/)(config|\.github)(\/|$)|config\.|\.(json|jsonc|yaml|yml|toml|ini|conf)$|^(dockerfile|makefile|\.gitignore|\.editorconfig)$/i.test(
      path,
    )
  )
    return "configuration";
  return "source";
}
function readable(path: string) {
  return (
    textExtensions.has(extname(path).toLowerCase()) ||
    /^(Dockerfile|Makefile|LICENSE|README|\.gitignore|\.editorconfig|\.prettierrc|\.eslintrc)$/i.test(
      basename(path),
    )
  );
}
export class ProjectFiles {
  constructor(readonly store: Store) {}
  async root(projectId: string) {
    const p = this.store.require<Project>("project", projectId);
    if (!p.directory) throw Error("请先关联项目目录");
    return new LocalDirectories(this.store).validatedDirectory(
      "code",
      p.directory,
    );
  }
  private async file(root: string, path: string) {
    if (
      !path ||
      isAbsolute(path) ||
      path.includes("\0") ||
      path.includes("\\") ||
      path.split("/").some((s) => s === ".." || s === "." || !s)
    )
      throw Error("项目文件路径无效");
    if (excluded(path)) throw Error("这个文件不在可读取范围内");
    if (!readable(path)) throw Error("暂不支持读取这种文件格式");
    const target = resolve(root, path);
    if (!isWithin(root, target) || target === root)
      throw Error("文件超出项目目录");
    if ((await realpath(dirname(target))) !== dirname(target))
      throw Error("不读取符号链接目录中的文件");
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink())
      throw Error("只读取普通文本文件，不跟随符号链接");
    if (info.size > MAX_FILE) throw Error("文件超过 128 KB，尚未读取");
    const handle = await open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > MAX_FILE)
        throw Error("文件类型或大小已变化");
      const buffer = Buffer.alloc(MAX_FILE + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          offset,
          buffer.length - offset,
          offset,
        );
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const after = await handle.stat();
      if (
        offset > MAX_FILE ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ino !== before.ino
      )
        throw Error("读取期间文件变化，请重新读取");
      const bytes = buffer.subarray(0, offset);
      if (bytes.includes(0)) throw Error("文件包含二进制内容，未读取");
      const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(body))
        throw Error("文件含私钥内容，未保存快照");
      return {
        body,
        sha256: digest(body),
        bytes: offset,
        modifiedAt: new Date(after.mtimeMs).toISOString(),
      };
    } finally {
      await handle.close();
    }
  }
  private latest(projectId: string, root: string, path: string) {
    return this.store
      .all<Material>("material")
      .filter(
        (m) =>
          m.projectSource?.projectId === projectId &&
          m.projectSource.root === root &&
          m.projectSource.path === path,
      )
      .at(-1);
  }
  async inspect(projectId: string): Promise<ProjectInspection> {
    const root = await this.root(projectId),
      previous = this.store.get<ProjectInspection>(
        "project-inspection",
        projectId,
      );
    const result: ProjectInspection = {
      projectId,
      root,
      inspectedAt: new Date().toISOString(),
      entries: [],
      limited: false,
      notes: [],
    };
    let visited = 0,
      checkedBytes = 0;
    const walk = async (dir: string, depth: number) => {
      if (
        ++visited > MAX_DIRECTORIES ||
        depth > 12 ||
        result.entries.length >= MAX_ENTRIES
      ) {
        result.limited = true;
        return;
      }
      let entries;
      try {
        if ((await realpath(dir)) !== dir) throw Error("symbolic directory");
        entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
          a.name.localeCompare(b.name),
        );
      } catch {
        result.limited = true;
        result.notes.push(`无法列出目录：${relative(root, dir) || "."}`);
        return;
      }
      for (const e of entries) {
        if (visited >= MAX_DIRECTORIES) {
          result.limited = true;
          break;
        }
        if (result.entries.length >= MAX_ENTRIES) {
          result.limited = true;
          break;
        }
        const path = relative(root, join(dir, e.name));
        const reason = excluded(path);
        if (e.isDirectory()) {
          if (reason) {
            result.entries.push({
              path: path + "/",
              kind: "other",
              state: "excluded",
              reason,
            });
          } else await walk(join(dir, e.name), depth + 1);
          continue;
        }
        const item: ProjectFile = {
          path,
          kind: category(path),
          state: "unread",
        };
        result.entries.push(item);
        if (e.isSymbolicLink() || !e.isFile()) {
          Object.assign(item, {
            state: "excluded",
            reason: "非普通文件或符号链接",
          });
          continue;
        }
        if (reason || !readable(path)) {
          Object.assign(item, {
            state: "excluded",
            reason: reason ?? "尚不支持的格式",
          });
          continue;
        }
        try {
          const info = await lstat(join(root, path));
          item.bytes = info.size;
          item.modifiedAt = new Date(info.mtimeMs).toISOString();
          if (info.size > MAX_FILE) {
            Object.assign(item, {
              state: "unavailable",
              reason: "文件超过 128 KB，尚未读取",
            });
            continue;
          }
          const old = this.latest(projectId, root, path);
          if (old) {
            item.reference = {
              materialId: old.id,
              version: old.version,
              label: old.title,
            };
            if (checkedBytes + info.size > MAX_CHECK_BYTES) {
              Object.assign(item, {
                state: "unchecked",
                reason: "本轮变化核对达到 4 MB 上限",
              });
              continue;
            }
            const now = await this.file(root, path);
            checkedBytes += now.bytes;
            Object.assign(item, {
              state:
                now.sha256 === old.projectSource!.sha256
                  ? "captured"
                  : "changed",
              sha256: now.sha256,
            });
          }
        } catch (error) {
          Object.assign(item, {
            state: "unavailable",
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };
    await walk(root, 0);
    if (!result.limited && previous?.root === root) {
      for (const old of previous.entries) {
        if (
          !old.path.endsWith("/") &&
          !result.entries.some((e) => e.path === old.path) &&
          old.reference
        )
          result.entries.push({
            ...old,
            state: "missing",
            reason: "此路径已不存在",
          });
      }
    }
    if (result.limited)
      result.notes.push(
        "目录检查达到范围上限；未列出的内容不视为已读取或已删除。",
      );
    if (this.store.require<Project>("project", projectId).directory !== root)
      throw Error("项目目录已变化，请重新检查");
    return this.store.put("project-inspection", projectId, result);
  }
  async capture(projectId: string, paths: string[]) {
    const root = await this.root(projectId);
    if (!paths.length || paths.length > 20)
      throw Error("每批选择 1 至 20 个文件");
    const unique = [...new Set(paths)],
      captured: Material[] = [];
    // Read before the transaction; a failure leaves all saved snapshots unchanged.
    for (const path of unique) {
      const file = await this.file(root, path),
        old = this.latest(projectId, root, path);
      captured.push(
        old?.projectSource?.sha256 === file.sha256
          ? old
          : {
              id:
                old?.id ??
                `project-file:${digest(`${projectId}\n${root}\n${path}`)}`,
              version: (old?.version ?? 0) + 1,
              title: path,
              body: file.body,
              coverage: "project_file",
              createdAt: new Date().toISOString(),
              projectSource: {
                projectId,
                root,
                path,
                sha256: file.sha256,
                bytes: file.bytes,
                modifiedAt: file.modifiedAt,
                kind: category(path),
              },
            },
      );
    }
    if (this.store.require<Project>("project", projectId).directory !== root)
      throw Error("读取期间项目目录变化，未保存快照");
    return this.store.transaction(() => {
      for (const m of captured) {
        const current = this.latest(projectId, root, m.projectSource!.path);
        if (
          current &&
          current.version >= m.version &&
          current.projectSource?.sha256 !== m.projectSource?.sha256
        )
          throw Error("其他读取已更新快照，请重新读取");
        this.store.put("material", `${m.id}@${m.version}`, m);
      }
      const inventory = this.store.get<ProjectInspection>(
        "project-inspection",
        projectId,
      );
      if (inventory?.root === root)
        this.store.put("project-inspection", projectId, {
          ...inventory,
          entries: inventory.entries.map((e) => {
            const m = captured.find((m) => m.projectSource!.path === e.path);
            return m
              ? {
                  ...e,
                  state: "captured",
                  reason: undefined,
                  sha256: m.projectSource!.sha256,
                  bytes: m.projectSource!.bytes,
                  modifiedAt: m.projectSource!.modifiedAt,
                  reference: {
                    materialId: m.id,
                    version: m.version,
                    label: m.title,
                  },
                }
              : e;
          }),
        });
      return captured;
    });
  }
  prepare(projectId: string, references: Reference[]) {
    const project = this.store.require<Project>("project", projectId);
    if (!references.length || references.length > 20)
      throw Error("请选择 1 至 20 份已读取的项目文件");
    for (const ref of references) {
      const m = this.store.material(ref);
      if (
        m.projectSource?.projectId !== projectId ||
        m.projectSource.root !== project.directory
      )
        throw Error("所选文件不属于当前项目目录");
      if (m.readError || (ref.excerpt && !m.body.includes(ref.excerpt)))
        throw Error("所选项目文件或范围不可用");
    }
    const linked = this.store.get<{ workId: string }>(
      "project-reading-work",
      projectId,
    );
    const work = linked
      ? this.store.get<Work>("work", linked.workId)
      : undefined;
    const context =
      work?.projectId === projectId
        ? work.id
        : `new:project-reading:${projectId}`;
    const draft = this.store.get<Draft>("draft", context),
      refs = [...(draft?.refs ?? [])];
    for (const ref of references) {
      if (
        !refs.some(
          (r) =>
            r.materialId === ref.materialId &&
            r.version === ref.version &&
            r.excerpt === ref.excerpt,
        )
      )
        refs.push(ref);
    }
    if (refs.length > 20) throw Error("草稿引用已达上限，请先精简");
    const instruction =
      "请根据本轮明确引用的项目文件理解项目目标、实现结构、配置与测试之间的关系，逐条注明文件路径和版本；结合之前的理解补充或纠正。区分源码中可观察的实现、文档中的声明、尚未执行的测试与未知情况，列出本轮已读范围和还缺哪些内容。仅提出有依据的项目建议，不修改文件、不执行命令，不宣称已完成全面理解或验证。";
    const text = draft?.text.includes(instruction)
      ? draft.text
      : [draft?.text, instruction].filter(Boolean).join("\n\n");
    if (Buffer.byteLength(text) > 16000) throw Error("草稿过长，请精简");
    return this.store.saveDraft({
      id: context,
      text,
      refs,
      recipient: draft?.recipient ?? null,
      projectId,
      outputMode: "result",
    });
  }
}
