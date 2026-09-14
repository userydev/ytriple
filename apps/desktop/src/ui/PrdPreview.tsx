import type { JSX } from "react";
import { Markdown } from "./Markdown.js";

/** The single deliverable, previewed as soon as it is written. */
export function PrdPreview({
  filename,
  path,
  markdown,
  canReveal,
  onReveal,
  onClose,
}: {
  filename: string;
  path: string;
  markdown: string;
  canReveal: boolean;
  onReveal(): void;
  onClose?: (() => void) | undefined;
}): JSX.Element {
  return (
    <section className="pane prd-pane">
      <header className="pane-header">
        <div>
          <h2>{filename}</h2>
          <span className="muted path">{path}</span>
        </div>
        <div className="pane-actions">
          {canReveal && (
            <button type="button" onClick={onReveal}>
              Open output folder
            </button>
          )}
          {onClose && (
            <button type="button" onClick={onClose}>
              Close
            </button>
          )}
        </div>
      </header>
      <div className="pane-scroll">
        <Markdown source={markdown} />
      </div>
    </section>
  );
}
