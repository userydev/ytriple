import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// AGENTS.md is the single source for document paths and size budgets.
const withoutFences = (text) => text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, "");
const slug = (text) => text.toLowerCase().replace(/<[^>]*>/g, "")
  .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "").replace(/\s/g, "-");

function anchors(text) {
  const found = new Set();
  const seen = new Map();
  for (const match of withoutFences(text).matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const base = slug(match[1]);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    found.add(count ? `${base}-${count}` : base);
  }
  for (const match of text.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)) found.add(match[1]);
  return found;
}

export function checkDocumentation(root, paths) {
  const errors = [];
  const rules = readFileSync(resolve(root, "AGENTS.md"), "utf8");
  const budget = rules.match(/<!-- docs-budget: files=(\d+) kib=(\d+) -->/);
  if (!budget) return ["AGENTS.md 缺少 docs-budget 登记。"];
  const registry = new Map();
  for (const match of rules.matchAll(/^\| \[[^\]]+\]\(([^)]+\.md)\) \| [^|]+ \| (\d+) \|$/gm)) {
    if (registry.has(match[1])) errors.push(`重复登记：${match[1]}`);
    registry.set(match[1], Number(match[2]) * 1024);
  }
  if (!registry.has("README.md") || !registry.has("AGENTS.md")) errors.push("必须登记 README.md 和 AGENTS.md。");
  if (registry.size > Number(budget[1])) errors.push(`文档数量超限：${registry.size}/${budget[1]}`);
  if ([...registry.values()].reduce((a, b) => a + b, 0) > Number(budget[2]) * 1024) {
    errors.push("各文档预算之和超过总体积预算。");
  }

  for (const path of new Set(paths)) {
    if (!existsSync(resolve(root, path))) continue; // tracked deletions in a working tree
    if ((path.startsWith("docs/") || /\.(?:md|mdx|markdown|rst|adoc|txt)$/i.test(path)) && !registry.has(path)) {
      errors.push(`未登记文档：${path}；请合并到已有正文或按规则调整登记。`);
    }
  }

  let total = 0;
  for (const [path, limit] of registry) {
    const absolute = resolve(root, path);
    if (!absolute.startsWith(resolve(root) + "/")) {
      errors.push(`文档必须位于仓库内：${path}`);
      continue;
    }
    if (!existsSync(absolute)) { errors.push(`已登记文档缺失：${path}`); continue; }
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) { errors.push(`文档必须是普通文件：${path}`); continue; }
    total += stat.size;
    if (stat.size > limit) errors.push(`文档体积超限：${path} (${stat.size}/${limit} bytes)`);
    const content = withoutFences(readFileSync(absolute, "utf8"));
    const targets = [
      ...[...content.matchAll(/!?\[[^\]\n]*\]\((<[^>]+>|[^\s)]+)(?:\s+["'][^\n]*?["'])?\)/g)].map((m) => m[1]),
      ...[...content.matchAll(/^\s*\[[^\]]+\]:\s*(<[^>]+>|\S+)/gm)].map((m) => m[1]),
    ];
    for (let target of targets) {
      target = target.replace(/^<|>$/g, "");
      if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(target)) continue;
      let decoded;
      try { decoded = decodeURIComponent(target); }
      catch { errors.push(`链接编码无效：${path} → ${target}`); continue; }
      const [file, hash] = decoded.split("#");
      const destination = file ? resolve(dirname(absolute), file.split("?")[0]) : absolute;
      if (relative(root, destination).startsWith("..") || !existsSync(destination)) {
        errors.push(`本地链接失效或越界：${path} → ${target}`);
      } else if (hash && /\.md$/i.test(destination) && !anchors(readFileSync(destination, "utf8")).has(hash)) {
        errors.push(`锚点不存在：${path} → ${target}`);
      }
    }
  }
  if (total > Number(budget[2]) * 1024) errors.push(`文档总体积超限：${total} bytes`);
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
  }).split("\0").filter(Boolean);
  const errors = checkDocumentation(root, paths);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else console.log("文档检查通过：登记、数量、体积与本地链接均符合规则。");
}
