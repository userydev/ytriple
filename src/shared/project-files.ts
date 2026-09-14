export interface ProjectFileEntry {
  name: string;
  /** Slash-separated path relative to the selected worktree. */
  path: string;
  kind: "directory" | "file";
  bytes?: number;
}

export interface ProjectFilePreview {
  path: string;
  name: string;
  format: "markdown" | "text" | "unsupported";
  content?: string;
  bytes: number;
  truncated: boolean;
  modifiedAt?: string;
  reason?: string;
}

/** Ephemeral UI state. Local file bodies must never enter task history. */
export interface ProjectBrowserState {
  projectId: string;
  worktreePath: string;
  directory: string;
  entries: ProjectFileEntry[];
  truncated: boolean;
  error?: string;
  preview?: ProjectFilePreview;
}

/** Resolve a Markdown document link without leaving the selected worktree. */
export function projectDocumentLink(
  href: string,
  currentFile: string,
): string | null {
  if (
    href.length > 2048 ||
    /^[a-z][a-z0-9+.-]*:/i.test(href) ||
    href.startsWith("#")
  )
    return null;
  let target: string;
  try {
    target = decodeURIComponent(href.split(/[?#]/, 1)[0]!);
  } catch {
    return null;
  }
  if (
    !target ||
    target.startsWith("/") ||
    target.includes("\\") ||
    /[\x00-\x1f]/.test(target)
  )
    return null;
  const parts = currentFile.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}
