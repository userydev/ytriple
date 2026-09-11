import { useEffect, useState } from "react";

type DocumentDraft = { editing: boolean; content: string; baseHash: string };
const drafts = new Map<string, DocumentDraft>();
/** Unmounted task panes keep only unsaved text; native folding keeps panes mounted. */
export function useDocumentDraft(key: string, content: string, hash: string) {
  const [draft, setDraft] = useState<DocumentDraft>(
    () => drafts.get(key) ?? { editing: false, content, baseHash: hash },
  );
  useEffect(() => {
    if (draft.editing) drafts.set(key, draft);
    else drafts.delete(key);
  }, [key, draft]);
  return {
    draft,
    setDraft,
    changedExternally: draft.editing && draft.baseHash !== hash,
  };
}
