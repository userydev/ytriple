import { useState } from "react";
import type { EditorialRevision } from "@ytriple/source-contract";
import type { Dispatch } from "./common";

export function EditorialCover({
  revision,
  dispatch,
  onRead,
}: {
  revision: EditorialRevision;
  dispatch: Dispatch;
  onRead?: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const cover = revision.cover;
  if (!cover || failed) return null;
  const image = (
    <img
      src={cover.data}
      width={cover.width}
      height={cover.height}
      alt={cover.description || `${cover.publisher} 的报道配图`}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
  return (
    <figure className="journal-source-cover">
      {onRead ? (
        <button
          onClick={onRead}
          aria-label={`阅读：${revision.presentation?.headline ?? revision.title}`}
        >
          {image}
        </button>
      ) : (
        image
      )}
      <figcaption>
        <button
          onClick={() =>
            void dispatch({ type: "url.open", url: cover.pageUrl })
          }
        >
          报道配图 · {cover.publisher}
        </button>
      </figcaption>
    </figure>
  );
}
