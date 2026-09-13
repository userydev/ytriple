import { ArrowUpRight } from "lucide-react";
import type {
  EditorialMaterial,
  EditorialRevision,
} from "@ytriple/source-contract";
import type { Dispatch } from "./common";
const date = (value: string) =>
  new Date(value).toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const roleNames = {
  primary: "原始发布 / 观察",
  report: "报道",
  analysis: "分析评论",
  unknown: "出处关系待核查",
};
const missingNames: Record<string, string> = {
  media: "未读取图片或视频",
  "authenticated-content": "未读取登录后内容",
  fulltext: "未取得全文",
  "feed-summary-only": "仅取得订阅摘要",
  "linked-page-not-fetched": "未取得原网页正文",
  "linked-page-unavailable": "原网页暂不可读",
};
export function Material({
  material,
  revision,
  dispatch,
}: {
  material: EditorialMaterial;
  revision: EditorialRevision;
  dispatch: Dispatch;
}) {
  const appraisal = revision.sourceAppraisals.find(
    (source) => source.itemId === material.itemId,
  );
  const shared = revision.evidence.find(
    (source) => source.itemId === appraisal?.sharedOriginWith,
  );
  return (
    <div className="editorial-material">
      <a
        href={material.url}
        onClick={(event) => {
          event.preventDefault();
          void dispatch({ type: "url.open", url: material.url });
        }}
      >
        {material.title} <ArrowUpRight size={12} />
      </a>
      <small>
        {material.sourceName} ·{" "}
        {appraisal ? roleNames[appraisal.role] : "补充材料"}
        {material.origin === "user" ? " · 你的来源" : ""}
      </small>
      {appraisal && <p>{appraisal.note}</p>}
      {shared && (
        <p>
          与「{shared.sourceName} · {shared.title}
          」共享原始出处，不能重复算作独立验证。
        </p>
      )}
      <small>
        {material.publishedAt
          ? `源站发布于 ${date(material.publishedAt)}`
          : "源站未提供发布时间"}{" "}
        ·{" "}
        {material.coverage === "fulltext" ? "已取得正文文本" : "仅取得部分材料"}
      </small>
      {material.missing.length > 0 && (
        <p className="editorial-boundary">
          {material.missing
            .map((value) => missingNames[value] ?? value)
            .join("；")}
        </p>
      )}
      <details>
        <summary>查看制作时使用的文本片段</summary>
        <p className="editorial-excerpt">{material.excerpt}</p>
        <small>
          取得于 {date(material.observedAt)}；保留此版本当时使用的范围。
        </small>
      </details>
    </div>
  );
}
