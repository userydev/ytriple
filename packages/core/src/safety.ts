/**
 * Safety rules that more than one layer has to agree on.
 *
 * They live in core because the decision is a product rule, not a host detail,
 * and because every host has to apply the same one: a task id that is safe on
 * Linux and unsafe on Windows is not safe.
 */

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * True when `value` can be used as a single directory or file name.
 *
 * Rejects both separators rather than just `/`: `..\outside` traverses on
 * Windows even though it is an ordinary name on Linux, and the output
 * directory must not depend on which machine wrote it.
 */
export function isSafePathSegment(value: string): boolean {
  if (value.length === 0 || value.length > 128) return false;
  if (value === "." || value === "..") return false;
  if (value.includes("/") || value.includes("\\")) return false;
  if (value.includes("\0")) return false;
  // Windows strips a trailing dot or space, so "a." and "a" collide there.
  if (/[.\s]$/.test(value)) return false;
  if (WINDOWS_RESERVED.test(value)) return false;
  return SAFE_SEGMENT.test(value);
}

export function assertSafePathSegment(value: string, label: string): void {
  if (isSafePathSegment(value)) return;
  throw new Error(
    `${label} must be a single path segment of letters, digits, dot, dash or underscore; received ${JSON.stringify(value)}`,
  );
}

const SAFE_URL_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:"]);

/**
 * True for links that are safe to put in an `href`.
 *
 * Model output and search results reach a webview, where `javascript:` and
 * `data:` URLs execute. An allowlist is the only version of this check that
 * stays correct as new schemes appear.
 */
export function isSafeHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return SAFE_URL_SCHEMES.has(parsed.protocol);
}
