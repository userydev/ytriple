import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Store } from "./store";
import type { ArtifactVersion, Project, Run, Work } from "./types";
import { LocalDirectories, isWithin } from "./local-directories";

const limit = 1_000_000;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const activePaths = new Set<string>();
export type SuggestionDocument = {
  id: string;
  projectId: string;
  root: string;
  path: string;
  selectedAt: string;
};
export type SuggestionPreview = {
  restored?: boolean;
  id: string;
  document: SuggestionDocument;
  versionId: string;
  excerpt?: string;
  existing: string;
  expectedHash: string | null;
  addition: string;
  entryId: string;
  createdAt: string;
};
export type SuggestionReceipt = {
  id: string;
  projectId: string;
  path: string;
  versionId: string;
  entryId: string;
  sha256: string;
  writtenAt: string;
};
export class ProjectSuggestions {
  constructor(readonly store: Store) {}
  async root(projectId: string) {
    const project = this.store.require<Project>("project", projectId);
    if (!project.directory) throw Error("请先关联本地项目目录");
    return new LocalDirectories(this.store).validatedDirectory(
      "code",
      project.directory,
    );
  }
  private async target(projectId: string, path: string, expectedRoot?: string) {
    const root = await this.root(projectId);
    if (expectedRoot && root !== expectedRoot)
      throw Error("项目目录已变化，请重新关联建议文档");
    const parent = await realpath(dirname(path));
    if (parent !== dirname(path) || !isWithin(root, parent))
      throw Error("建议文档必须位于当前项目内，不能经过符号链接");
    const target = join(parent, basename(path));
    if (extname(target).toLowerCase() !== ".md")
      throw Error("建议文档需为 Markdown 文件");
    const parts = relative(root, target).split("/");
    if (
      parts.some(
        (p) =>
          p.startsWith(".") ||
          ["node_modules", "vendor", "dist", "build", "target"].includes(p),
      )
    )
      throw Error("建议文档不能位于隐藏、依赖或生成目录");
    if (
      /^(agents|readme|product|design|architecture|plan|changelog|license)\.md$/i.test(
        basename(target),
      )
    )
      throw Error("请选择专用建议文档，不能使用正式方案或项目规则文件");
    const info = await lstat(target).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1))
      throw Error("建议文档需要是普通文件，不能是符号链接或硬链接");
    return { root, path: target, exists: !!info };
  }
  private async read(path: string): Promise<string | null> {
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (!file) return null;
    try {
      const before = await file.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size > limit)
        throw Error("建议文档需为不超过 1 MB 的普通文本文件");
      const bytes = Buffer.alloc(limit + 1);
      let n = 0;
      while (n < bytes.length) {
        const { bytesRead } = await file.read(bytes, n, bytes.length - n, n);
        if (!bytesRead) break;
        n += bytesRead;
      }
      const after = await file.stat();
      if (
        n > limit ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs
      )
        throw Error("建议文档读取期间变化，请重试");
      if (bytes.subarray(0, n).includes(0))
        throw Error("建议文档包含二进制内容");
      return new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, n),
      );
    } finally {
      await file.close();
    }
  }
  async bind(projectId: string, path: string, mode: "existing" | "new") {
    const target = await this.target(projectId, path);
    if ((mode === "existing") !== target.exists)
      throw Error(
        mode === "existing"
          ? "所选文档不存在"
          : "文件已存在，请使用关联已有文档",
      );
    if (target.exists) await this.read(target.path);
    if (
      this.store
        .all<SuggestionDocument>("suggestion-document")
        .some((d) => d.projectId !== projectId && d.path === target.path)
    )
      throw Error("此文档已绑定其他项目，请使用本项目的建议文档");
    const current = this.store.get<SuggestionDocument>(
      "suggestion-document",
      projectId,
    );
    if (current?.path === target.path && current.root === target.root)
      return current;
    const document: SuggestionDocument = {
      id: randomUUID(),
      projectId,
      root: target.root,
      path: target.path,
      selectedAt: new Date().toISOString(),
    };
    // Binding only records the location; even a new file is created by explicit publish.
    return this.store.put("suggestion-document", projectId, document);
  }
  private source(projectId: string, versionId: string, excerpt?: string) {
    const version = this.store.require<ArtifactVersion>("version", versionId);
    const work = this.store.require<Work>("work", version.workId);
    const run = version.runId
      ? this.store.require<Run>("run", version.runId)
      : null;
    if (
      work.projectId !== projectId ||
      (run?.projectContext && run.projectContext.projectId !== projectId)
    )
      throw Error("成果不属于当前项目");
    if (
      version.author !== "team" ||
      (version.kind && version.kind !== "result") ||
      run?.status !== "succeeded" ||
      run.workId !== work.id
    )
      throw Error("请选择团队已完成的主成果作为建议来源");
    if (
      excerpt !== undefined &&
      (!excerpt.trim() || !version.body.includes(excerpt))
    )
      throw Error("建议选段不属于这个成果版本");
    return { version, work, run, body: excerpt ?? version.body };
  }
  async preview(projectId: string, versionId: string, excerpt?: string) {
    const document = this.store.require<SuggestionDocument>(
      "suggestion-document",
      projectId,
    );
    await this.target(projectId, document.path, document.root);
    const existing = await this.read(document.path);
    const { version, work, run, body } = this.source(
      projectId,
      versionId,
      excerpt,
    );
    const entryId = hash(
      JSON.stringify([projectId, version.id, excerpt ?? null]),
    );
    const oneLine = (s: string) => s.replace(/[\r\n`]/g, " ");
    const refs = run.refs.map((r) => {
      const m = this.store.material(r);
      return `- ${oneLine(m.projectSource?.path ?? m.title)} · v${r.version} · 材料 ${m.id}${r.excerpt ? ` · 选段 SHA-256 ${hash(r.excerpt)}` : " · 全部保存内容"}`;
    });
    const addition = `\n\n<!-- ytriple-suggestion:${entryId} -->\n## 建议 · ${oneLine(work.title)} · v${version.number}\n\n来源：成果 ${version.id}；运行 ${run.id}；生成于 ${version.createdAt}；范围：${excerpt ? "所选段落" : "完整成果"}。\n\n状态：建议已记录，尚不代表已采纳或执行。\n\n${body}\n\n### 本轮引用依据\n\n${refs.length ? refs.join("\n") : "本轮未附材料；依据范围以原工作记录为准。"}\n\n<!-- /ytriple-suggestion:${entryId} -->\n`;
    if (
      Buffer.byteLength(addition) > 256_000 ||
      Buffer.byteLength(existing ?? "") + Buffer.byteLength(addition) > limit
    )
      throw Error(
        "建议或文档过大，请缩小建议范围（单次最多 256 KB，文档最多 1 MB）",
      );
    const preview: SuggestionPreview = {
      id: randomUUID(),
      document,
      versionId,
      ...(excerpt === undefined ? {} : { excerpt }),
      existing: existing ?? "",
      expectedHash: existing === null ? null : hash(existing),
      addition,
      entryId,
      createdAt: new Date().toISOString(),
    };
    return this.store.put("suggestion-preview", preview.id, preview);
  }
  async publish(previewId: string): Promise<SuggestionReceipt> {
    const preview = this.store.require<SuggestionPreview>(
      "suggestion-preview",
      previewId,
    );
    if (preview.restored)
      throw Error("恢复的记录仅供查看，请重新生成预览后执行");
    const { document } = preview;
    if (activePaths.has(document.path))
      throw Error("此文档正在写入，请稍后重试");
    activePaths.add(document.path);
    try {
      if (
        this.store.require<SuggestionDocument>(
          "suggestion-document",
          document.projectId,
        ).id !== document.id
      )
        throw Error("建议文档位置已变化，请重新预览");
      this.source(document.projectId, preview.versionId, preview.excerpt);
      await this.target(document.projectId, document.path, document.root);
      const current = await this.read(document.path);
      const receipt = (text: string) => {
        const previous = this.store.get<SuggestionReceipt>(
          "suggestion-receipt",
          hash(document.path + preview.entryId),
        );
        if (previous) return previous;
        const record: SuggestionReceipt = {
          id: hash(document.path + preview.entryId),
          projectId: document.projectId,
          path: document.path,
          versionId: preview.versionId,
          entryId: preview.entryId,
          sha256: hash(text),
          writtenAt: new Date().toISOString(),
        };
        return this.store.put("suggestion-receipt", record.id, record);
      };
      // A retry after process loss recovers from the exact complete entry, never just a marker.
      if (current?.includes(preview.addition)) return receipt(current);
      if ((current === null ? null : hash(current)) !== preview.expectedHash)
        throw Error("建议文档已变化，请重新预览后写入；现有内容保持不变");
      const flags =
        current === null
          ? constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW
          : constants.O_RDWR |
            constants.O_APPEND |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK;
      const file = await open(document.path, flags, 0o600);
      try {
        const opened = await file.stat();
        const target = await lstat(document.path);
        if (
          !opened.isFile() ||
          opened.nlink !== 1 ||
          opened.ino !== target.ino ||
          opened.dev !== target.dev
        )
          throw Error("建议文档身份已变化，请重新预览");
        await this.target(document.projectId, document.path, document.root);
        if (current !== null) {
          const bytes = Buffer.alloc(limit + 1);
          const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
          if (
            hash(bytes.subarray(0, bytesRead).toString("utf8")) !==
            preview.expectedHash
          )
            throw Error("建议文档已变化，请重新预览");
        }
        if (
          this.store.require<SuggestionDocument>(
            "suggestion-document",
            document.projectId,
          ).id !== document.id
        )
          throw Error("建议文档位置已变化，请重新预览");
        this.source(document.projectId, preview.versionId, preview.excerpt);
        const bytes = Buffer.from(preview.addition);
        const { bytesWritten } = await file.write(bytes);
        if (bytesWritten !== bytes.length)
          throw Error("写入未完整完成，请检查文档后重新预览");
        await file.sync();
      } finally {
        await file.close();
      }
      const written = await this.read(document.path);
      if (!written?.includes(preview.addition))
        throw Error("写入后文档发生变化，请检查文件，未记录成功");
      return receipt(written);
    } finally {
      activePaths.delete(document.path);
    }
  }
}
