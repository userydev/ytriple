import { coverageLabel } from "./radar-contract";
import type { Material, Reference } from "./types";

export const partialCoverage = new Set([
  "title_only",
  "summary",
  "feed_content",
  "feed_excerpt",
  "link_only",
]);

export function coverageBoundary(coverage: string) {
  const label = coverageLabel(coverage);
  if (partialCoverage.has(coverage))
    return `${label}。这不是全文；不得声称已抓取网站、联网深研或阅读未提供的正文。`;
  if (coverage === "radar") return `${label}。这是当时的解读版本，不是来源全文。`;
  return label;
}

export function materialProvenance(material: Material, version = material.version) {
  const parts: string[] = [];
  const url = material.url ?? material.feedSource?.resolvedUrl ?? material.feedSource?.sourceUrl;
  if (url) parts.push(`来源 ${url}`);
  const fetchedAt = material.feedSource?.fetchedAt ?? material.upstream?.discoveredAt;
  const publishedAt = material.feedSource?.publishedAt ?? material.upstream?.publishedAt;
  if (fetchedAt) parts.push(`读取于 ${fetchedAt}`);
  if (publishedAt) parts.push(`发布于 ${publishedAt}`);
  const boundary = coverageBoundary(material.coverage);
  if (partialCoverage.has(material.coverage) || material.coverage === "radar" || url)
    parts.push(`覆盖说明：${boundary}`);
  if (parts.length) parts.push(`准确版本 v${version}`);
  return parts.join(" · ");
}

export function formatAuthorizedMaterials(
  refs: Reference[],
  resolve: (reference: Reference) => Material,
  options?: { previewLimit?: number; canReadMore?: boolean; numbered?: boolean },
) {
  if (!refs.length) return "";
  return refs
    .map((reference, index) => {
      const material = resolve(reference);
      const body = reference.excerpt ?? material.body;
      const limit = options?.previewLimit;
      const content =
        options?.canReadMore && limit && body.length > limit
          ? `${body.slice(0, limit)}\n（这里只展示选中范围前 ${limit} 字符，共 ${body.length} 字符；其余尚未载入模型上下文。可用材料查阅工具按上方序号继续读取或查找。不能据此声称全文已经理解。）`
          : body;
      const header = options?.numbered
        ? `【材料 ${index + 1}：${material.title} / ${material.id} v${material.version} / ${material.coverage}】`
        : `【${reference.label} / 版本:v${reference.version} / 材料:${material.id} / 覆盖:${material.coverage}】`;
      const extra = materialProvenance(material, reference.version);
      return `${header}${extra ? `\n${extra}` : ""}\n${
        material.readError ? `未读取：${material.readError}` : content
      }`;
    })
    .join("\n\n");
}
