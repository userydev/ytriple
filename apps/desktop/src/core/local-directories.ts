import { realpath, stat, readdir, readFile } from "node:fs/promises";
import { join, relative, isAbsolute, resolve, basename } from "node:path";
import type { Store } from "./store";
import type { LocalInventory, LocalRoots, Project } from "./types";
export function isWithin(root: string, path: string) {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (!rel.startsWith("../") &&
      !rel.startsWith("..\\") &&
      rel !== ".." &&
      !isAbsolute(rel))
  );
}
async function directory(path: string) {
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isDirectory()) throw Error("所选路径不是文件夹");
  return canonical;
}
export class LocalDirectories {
  constructor(readonly store: Store) {}
  roots(): LocalRoots {
    return (
      this.store.get("meta", "local-roots") ?? { aiPath: null, codePath: null }
    );
  }
  async discover(home: string) {
    if (this.store.get("meta", "local-roots")) return this.roots();
    const roots: LocalRoots = { aiPath: null, codePath: null };
    for (const [key, name] of [
      ["aiPath", "AI"],
      ["codePath", "Code"],
    ] as const) {
      try {
        roots[key] = await directory(join(home, name));
      } catch {
        /* Missing conventional directories remain unset. */
      }
    }
    if (
      roots.aiPath &&
      roots.codePath &&
      (isWithin(roots.aiPath, roots.codePath) ||
        isWithin(roots.codePath, roots.aiPath))
    )
      return this.store.put("meta", "local-roots", {
        aiPath: null,
        codePath: null,
      });
    return this.store.put("meta", "local-roots", roots);
  }
  async setRoot(kind: "ai" | "code", path: string) {
    const canonical = await directory(path),
      roots = this.roots();
    const other = kind === "ai" ? roots.codePath : roots.aiPath;
    if (other && (isWithin(other, canonical) || isWithin(canonical, other)))
      throw Error("AI 与 Code 需要是独立目录，不能相同或互相包含");
    const next = {
      ...roots,
      [kind === "ai" ? "aiPath" : "codePath"]: canonical,
    };
    this.store.put("meta", "local-roots", next);
    this.store.remove("meta", "local-inventory");
    return next;
  }
  async validatedPath(kind: "ai" | "code", path: string) {
    const roots = this.roots(),
      configured = kind === "ai" ? roots.aiPath : roots.codePath;
    if (!configured)
      throw Error(`请先配置 ${kind === "ai" ? "AI" : "Code"} 目录`);
    const root = await directory(configured),
      target = await realpath(path);
    if (!isWithin(root, target)) throw Error("所选路径不在已配置目录内");
    return target;
  }
  async validatedDirectory(kind: "ai" | "code", path: string) {
    const target = await this.validatedPath(kind, path);
    if (!(await stat(target)).isDirectory())
      throw Error("路径不再是文件夹，请重新关联");
    return target;
  }
  async linkProject(projectId: string, path: string) {
    const target = await this.validatedPath("code", path);
    if (!(await stat(target)).isDirectory())
      throw Error("项目路径需要是文件夹");
    if (target === this.roots().codePath)
      throw Error("请选择 Code 内的具体项目目录");
    const project = this.store.require<Project>("project", projectId);
    const existing = this.store
      .all<Project>("project")
      .find((p) => p.id !== projectId && p.directory === target);
    if (existing) throw Error(`该路径已经关联项目：${existing.name}`);
    return this.store.put("project", projectId, {
      ...project,
      directory: target,
    });
  }
  async importProject(path: string) {
    const target = await this.validatedPath("code", path);
    if (!(await stat(target)).isDirectory() || target === this.roots().codePath)
      throw Error("请选择 Code 内的具体项目目录");
    const existing = this.store
      .all<Project>("project")
      .find((p) => p.directory === target);
    if (existing) return existing;
    return this.store.transaction(() => {
      const p = this.store.createProject(basename(target), "", "software");
      return this.store.put("project", p.id, { ...p, directory: target });
    });
  }
  async refresh(): Promise<LocalInventory> {
    const config = this.roots();
    const result: LocalInventory = {
      inspectedAt: new Date().toISOString(),
      roots: [],
      projects: [],
      assets: [],
      notes: [],
    };
    for (const kind of ["ai", "code"] as const) {
      const path = kind === "ai" ? config.aiPath : config.codePath;
      try {
        if (!path) throw Error("尚未配置");
        await directory(path);
        result.roots.push({ kind, path, available: true, error: null });
      } catch (e) {
        result.roots.push({
          kind,
          path,
          available: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    if (result.roots.find((r) => r.kind === "code")?.available) {
      const root = await directory(config.codePath!);
      let visited = 0;
      const skip = new Set([
        "node_modules",
        "vendor",
        "build",
        "dist",
        "out",
        "target",
        "cache",
      ]);
      const walk = async (path: string, depth: number) => {
        if (++visited > 300) {
          if (
            !result.notes.includes(
              "项目目录较多，仅检查前 300 个目录；其他项目仍可手动关联。",
            )
          )
            result.notes.push(
              "项目目录较多，仅检查前 300 个目录；其他项目仍可手动关联。",
            );
          return;
        }
        let entries;
        try {
          const actual = await directory(path);
          if (!isWithin(root, actual)) return;
          entries = await readdir(actual, { withFileTypes: true });
        } catch {
          result.notes.push(`无法检查目录：${relative(root, path)}`);
          return;
        }
        if (entries.some((e) => e.name === ".git")) {
          result.projects.push({ name: basename(path), path });
          return;
        }
        if (depth >= 3) return;
        for (const entry of entries) {
          if (visited >= 300) break;
          if (
            entry.isDirectory() &&
            !entry.isSymbolicLink() &&
            !entry.name.startsWith(".") &&
            !skip.has(entry.name)
          )
            await walk(join(path, entry.name), depth + 1);
        }
      };
      await walk(root, 0);
      if (visited >= 300)
        result.notes.push("目录检查达到上限，可手动关联未列出的项目。");
    }
    if (result.roots.find((r) => r.kind === "ai")?.available) {
      for (const [file, key, kind] of [
        ["system/resources.json", "resources", "资源"],
        ["system/knowledge.json", "items", "知识"],
      ] as const) {
        try {
          const path = await this.validatedPath(
            "ai",
            join(config.aiPath!, file),
          );
          const st = await stat(path);
          if (st.size > 1000000) throw Error("目录索引超过读取上限");
          const json = JSON.parse(await readFile(path, "utf8"));
          if (!Array.isArray(json[key])) throw Error("目录索引格式不符");
          for (const item of json[key].slice(0, 200)) {
            if (
              !item ||
              typeof item.path !== "string" ||
              typeof (item.title ?? item.name) !== "string"
            )
              continue;
            const path = isAbsolute(item.path)
              ? resolve(item.path)
              : resolve(config.aiPath!, item.path);
            if (!isWithin(config.aiPath!, path)) {
              result.notes.push("资产索引含目录外路径，已跳过。");
              continue;
            }
            let available = false;
            try {
              await this.validatedPath("ai", path);
              available = true;
            } catch {
              /* Keep unavailable registered assets visible. */
            }
            result.assets.push({
              id: String(item.id ?? path),
              title: item.title ?? item.name,
              kind: String(item.type ?? kind),
              path,
              available,
            });
          }
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT")
            result.notes.push(
              `${file}：${e instanceof Error ? e.message : String(e)}`,
            );
        }
      }
      if (!result.assets.length)
        result.notes.push(
          "尚未发现已登记的资产，可在 AI 目录中查看已有文件；未扫描或执行目录中的内容。",
        );
    }
    this.store.put("meta", "local-inventory", result);
    return result;
  }
}
