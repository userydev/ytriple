/**
 * Minimal glob matcher for workspace include/exclude rules.
 *
 * Supports `**`, `*` and `?` over POSIX-style relative paths. It is
 * deliberately small: the rules it has to express are the default exclude list
 * and a handful of extension filters, not a general file selection language.
 */
export function matchGlob(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path);
}

export function matchesAnyGlob(patterns: readonly string[], path: string): boolean {
  return patterns.some((pattern) => matchGlob(pattern, path));
}

const cache = new Map<string, RegExp>();

function globToRegExp(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached) return cached;

  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;

    if (char === "*") {
      const isDoubleStar = pattern[index + 1] === "*";
      if (isDoubleStar) {
        const followedBySlash = pattern[index + 2] === "/";
        // `**/` matches zero or more leading directories, `**` matches the rest.
        source += followedBySlash ? "(?:[^/]+/)*" : "[\\s\\S]*";
        index += followedBySlash ? 2 : 1;
        continue;
      }
      source += "[^/]*";
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      continue;
    }

    source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }

  const regExp = new RegExp(`^${source}$`);
  cache.set(pattern, regExp);
  return regExp;
}

/** Normalises host paths to the relative POSIX form core works with. */
export function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}
