import { ArrowRightIcon, ArrowUpRightIcon } from "@phosphor-icons/react";
import type { EditorialRevision } from "@ytriple/source-contract";

export function EditorialVisual({
  revision,
  selected,
  onInspect,
}: {
  revision: EditorialRevision;
  selected: number | null;
  onInspect: (index: number) => void;
}) {
  const visual = revision.presentation?.visual;
  if (!visual || visual.kind === "none") return null;
  return (
    <figure
      className={`journal-diagram ${visual.kind}`}
      aria-label="解读关系图"
    >
      <figcaption>{visual.title}</figcaption>
      <div className="journal-diagram-body">
        {visual.items.map((node, index) => (
          <div className="journal-diagram-step" key={index}>
            <button
              className={`journal-diagram-node node-${index}`}
              aria-label={`查看依据：${node.label}`}
              aria-expanded={selected === index}
              onClick={() => onInspect(index)}
            >
              {visual.kind === "sequence" && (
                <span className="journal-step-number">
                  {String(index + 1).padStart(2, "0")}
                </span>
              )}
              <strong>{node.label}</strong>
              <span className="journal-node-text">{node.text}</span>
              <ArrowUpRightIcon className="journal-inspect-mark" size={17} />
            </button>
            {visual.kind === "sequence" && index < visual.items.length - 1 && (
              <ArrowRightIcon
                className="journal-sequence-arrow"
                size={20}
                aria-hidden="true"
              />
            )}
          </div>
        ))}
      </div>
      <p className="journal-diagram-conclusion">{visual.conclusion}</p>
    </figure>
  );
}
