import {
  useCallback,
  useMemo,
  useSyncExternalStore,
  type SetStateAction,
} from "react";

type DocumentDraft = { editing: boolean; content: string; baseHash: string };
const drafts = new Map<string, DocumentDraft>();
const listeners = new Map<string, Set<() => void>>();
function changed(key: string) {
  listeners.get(key)?.forEach((listener) => listener());
}
export function discardTaskDocumentDrafts(taskId: string) {
  for (const key of drafts.keys()) {
    if (key.startsWith(`artifact:${taskId}:`)) {
      drafts.delete(key);
      changed(key);
    }
  }
}
/** Unmounted task panes keep only unsaved text; native folding keeps panes mounted. */
export function useDocumentDraft(key: string, content: string, hash: string) {
  const fallback = useMemo(
    () => ({ editing: false, content, baseHash: hash }),
    [content, hash],
  );
  const subscribe = useCallback(
    (listener: () => void) => {
      const group = listeners.get(key) ?? new Set<() => void>();
      group.add(listener);
      listeners.set(key, group);
      return () => {
        group.delete(listener);
        if (!group.size) listeners.delete(key);
      };
    },
    [key],
  );
  const getSnapshot = useCallback(
    () => drafts.get(key) ?? fallback,
    [key, fallback],
  );
  const draft = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const setDraft = useCallback(
    (value: SetStateAction<DocumentDraft>) => {
      const next = typeof value === "function" ? value(getSnapshot()) : value;
      if (next.editing) drafts.set(key, next);
      else drafts.delete(key);
      changed(key);
    },
    [key, getSnapshot],
  );
  const completeDraft = (submitted: DocumentDraft) => {
    // An earlier request must not clear a newer draft, including after remount.
    if (drafts.get(key) !== submitted) return;
    drafts.delete(key);
    changed(key);
  };
  return {
    draft,
    setDraft,
    completeDraft,
    changedExternally: draft.editing && draft.baseHash !== hash,
  };
}
