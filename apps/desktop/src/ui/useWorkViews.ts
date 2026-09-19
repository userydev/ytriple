import { useEffect, useReducer, useRef, useState } from "react";
import type { Snapshot } from "../core/types";
import { defaultLayout, type Layout, type WorkView } from "../core/view";
import { command } from "./api";
export function useWorkViews(
  data: Snapshot | null,
  context: string,
  onError: (e: unknown) => void,
) {
  const cache = useRef(new Map<string, WorkView>()),
    pending = useRef(new Map<string, WorkView>()),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [, render] = useReducer((n) => n + 1, 0);
  function read(id: string): WorkView {
    const saved = cache.current.get(id) ?? data?.views.find((v) => v.id === id);
    if (saved) return saved;
    const latest = data?.versions.filter((v) => v.workId === id).at(-1);
    return {
      id,
      surface: latest ? "result" : "process",
      focused: null,
      versionId: latest?.id ?? null,
      scroll: {},
    };
  }
  useEffect(() => {
    if (data && cache.current.has(context) && !read(context).versionId) {
      const latest = data.versions.filter((v) => v.workId === context).at(-1);
      if (latest) update(context, { versionId: latest.id });
    }
    if (data && !cache.current.has(context)) {
      const initial = read(context);
      cache.current.set(context, initial);
      pending.current.set(context, initial);
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, 120);
    }
  }, [data, context]);
  function flush() {
    clearTimeout(timer.current);
    timer.current = undefined;
    for (const value of pending.current.values())
      void command({ type: "view", view: value }).catch(onError);
    pending.current.clear();
  }
  function update(
    id: string,
    patch: Partial<Omit<WorkView, "id">>,
    paint = true,
  ) {
    const next = { ...read(id), ...patch, id };
    cache.current.set(id, next);
    pending.current.set(id, next);
    if (paint) render();
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 120);
  }
  function position(id: string, key: string, top: number) {
    update(id, { scroll: { ...read(id).scroll, [key]: top } }, false);
  }
  function configure(value: Layout) {
    setLayout(value);
    void command({ type: "layout", layout: value }).catch(onError);
  }
  useEffect(() => {
    const save = () => flush();
    window.addEventListener("pagehide", save);
    return () => {
      window.removeEventListener("pagehide", save);
      flush();
    };
  }, []);
  return {
    view: read(context),
    layout: layout ?? data?.layout ?? defaultLayout,
    read,
    update,
    position,
    configure,
    flush,
  };
}
