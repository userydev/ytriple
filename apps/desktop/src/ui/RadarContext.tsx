import { useState, type ReactNode } from "react";
import type { Material, Snapshot, Work } from "../core/types";
import {
  coverageLabel,
  type RadarEdition,
  type RadarTopic,
} from "../core/radar-contract";
import {
  editionProvenance,
  formatRadarDate,
  relatedNewsForArticle,
  worksCitingReferences,
  researchRefsForEdition,
  researchRefsForMaterial,
} from "../core/radar-reading";

function Fold({
  title,
  empty,
  children,
}: {
  title: string;
  empty?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  if (empty) return null;
  return (
    <section className="radar-extra">
      <button
        type="button"
        className="radar-extra-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {title}
      </button>
      {open ? <div className="radar-extra-body">{children}</div> : null}
    </section>
  );
}

export function RadarContext({
  data,
  edition,
  material,
  works,
  onOpenEdition,
  onOpenMaterial,
  onContinue,
}: {
  data: Snapshot;
  topic?: RadarTopic | null;
  edition?: RadarEdition | null;
  material?: Material | null;
  works?: Work[];
  onOpenEdition: (id: string) => void;
  onOpenMaterial: (material: Material) => void;
  onContinue: (work: Work) => void;
}) {
  const related = material
    ? relatedNewsForArticle(data.materials, material)
    : [];
  const citingEditions = material ? editionProvenance(data, material) : [];
  const sources = edition
    ? edition.sources.filter((source) => source.policy !== "exclude")
    : [];
  const refs = edition
    ? researchRefsForEdition(edition)
    : material
      ? researchRefsForMaterial(material)
      : [];
  const citing =
    works ?? (refs.length ? worksCitingReferences(data, refs) : []);

  return (
    <div className="radar-extras">
      <Fold title="出处" empty={!sources.length}>
        <ul>
          {sources.map((source) => (
            <li key={source.key}>
              <button
                type="button"
                className="text-action"
                onClick={() =>
                  onOpenMaterial({
                    id: source.reference.materialId,
                    version: source.reference.version,
                    title: source.title,
                    body: source.body,
                    coverage: source.coverage,
                    createdAt: edition?.createdAt ?? "",
                    url: source.url,
                  })
                }
              >
                {source.title}
              </button>
              <small>{coverageLabel(source.coverage)}</small>
            </li>
          ))}
        </ul>
      </Fold>
      <Fold title="相关" empty={!related.length}>
        <ul>
          {related.map((item) => (
            <li key={item.material.id}>
              <button
                type="button"
                className="text-action"
                onClick={() => onOpenMaterial(item.material)}
              >
                {item.material.title}
              </button>
              <p>
                共同对象「{item.object}」：{item.from}
              </p>
              <small>另一篇：{item.to}</small>
            </li>
          ))}
        </ul>
      </Fold>
      <Fold title="已有解读" empty={!citingEditions.length}>
        <ul>
          {citingEditions.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="text-action"
                aria-current={edition?.id === item.id ? "true" : undefined}
                onClick={() => onOpenEdition(item.id)}
              >
                {item.insight.title}
              </button>
              <small>解读保存于 {formatRadarDate(item.createdAt)}</small>
            </li>
          ))}
        </ul>
      </Fold>
      <Fold title="已有研究" empty={!citing.length}>
        <ul>
          {citing.map((work) => (
            <li key={work.id}>
              <button
                type="button"
                className="text-action"
                onClick={() => onContinue(work)}
              >
                {work.title}
              </button>
            </li>
          ))}
        </ul>
      </Fold>
    </div>
  );
}
