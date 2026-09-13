import type { ProjectInfo } from "./types.js";

/** Candidate selection does not authorize a read: ProjectFiles validates the
 * directory, links, file identity and readable text again at execution time. */
export function projectContextDocuments(project: ProjectInfo) {
  const normalize = (value: string) =>
    value.replace(/\/{2,}/g, "/").replace(/\/$/, "");
  const projectRoot = normalize(project.root);
  const roots = [
    project.devPath,
    ...(project.observation?.worktrees.map((tree) => tree.path) ?? []),
  ]
    .map(normalize)
    .filter(
      (root) =>
        root.startsWith("/") &&
        !root.includes("\\") &&
        !root.split("/").some((part) => part === "." || part === "..") &&
        !/[\x00-\x1f]/.test(root) &&
        (root === projectRoot || root.startsWith(`${projectRoot}/`)),
    )
    .sort((a, b) => b.length - a.length);
  const paths = [
    project.documents.product,
    project.documents.entry,
    project.documents.plan,
    project.documents.development,
  ].filter(
    (value): value is string => typeof value === "string" && Boolean(value),
  );
  return [...new Set(paths.map(normalize))].flatMap((absolutePath) => {
    if (
      !absolutePath.startsWith("/") ||
      absolutePath.includes("\\") ||
      /[\x00-\x1f]/.test(absolutePath)
    )
      return [];
    const observation = project.observation?.documents.find(
      (item) => normalize(item.path) === absolutePath,
    );
    if (observation && observation.state !== "present") return [];
    const worktreePath = roots.find((root) =>
      absolutePath.startsWith(`${root}/`),
    );
    if (!worktreePath) return [];
    const path = absolutePath.slice(worktreePath.length + 1);
    if (
      path
        .split("/")
        .some((part) => !part || part === ".." || part.startsWith(".")) ||
      !/\.(md|txt)$/i.test(path)
    )
      return [];
    return [{ absolutePath, worktreePath, path }];
  });
}

export function projectDiscussionGoal(project: ProjectInfo, question: string) {
  return [
    `围绕本机项目「${project.name}」推进工作。`,
    `项目 ID：${project.id}；目录：${project.root}`,
    "以本次实际导入的项目资料为依据。目录扫描只说明文件状态，不能证明产品完成；没有读取或无法验证的内容明确列为未知。",
    ...(project.observation?.issues ?? []).map((issue) => `目录观察：${issue}`),
    "导入项目无需先登记中央体系；没有 Git 或中央登记本身不构成阻塞。只有影响用户目标的实际缺口才列为问题，不擅自建议搬迁或登记。",
    "先明确当前目标、实际进展与阻塞，再回答问题。需要多个成员时分工比较判断和依据；记录修正，最终保存可继续使用的项目状态说明。",
    `用户要推进的工作：${question}`,
  ].join("\n");
}

/** Remove only our generated context wrapper from user-facing goal labels. */
export function projectRequestText(goal: string) {
  if (!goal.startsWith("围绕本机项目")) return goal;
  const marker = /(?:^|\n)(?:用户要推进的工作|我的问题)：/.exec(goal);
  return marker ? goal.slice(marker.index + marker[0].length).trim() : goal;
}
