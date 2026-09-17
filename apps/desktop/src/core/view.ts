import { z } from "zod";
export const surfaces = ["decision", "process", "result"] as const;
export type Surface = (typeof surfaces)[number];
export const layoutSchema = z
  .object({
    mode: z.enum(["split", "columns", "rows", "mixed"]),
    order: z
      .array(z.enum(surfaces))
      .length(3)
      .refine((a) => new Set(a).size === 3, "每个工作面只能出现一次"),
    split: z.number().min(25).max(65),
    stacked: z.number().min(20).max(80),
    sizes: z
      .tuple([
        z.number().min(20).max(60),
        z.number().min(20).max(60),
        z.number().min(20).max(60),
      ])
      .refine(
        (a) => Math.abs(a.reduce((n, v) => n + v, 0) - 100) < 0.01,
        "工作面比例之和必须为 100",
      ),
  })
  .strict();
export type Layout = z.infer<typeof layoutSchema>;
export const defaultLayout: Layout = {
  mode: "split",
  order: [...surfaces],
  split: 38,
  stacked: 50,
  sizes: [34, 33, 33],
};
export const viewSchema = z
  .object({
    id: z.string().min(1).max(400),
    surface: z.enum(surfaces),
    focused: z.enum(surfaces).nullable(),
    versionId: z.string().max(300).nullable(),
    scroll: z.record(z.string().max(400), z.number().min(0).max(10000000)),
  })
  .strict();
export type WorkView = z.infer<typeof viewSchema>;
export function resizePair(
  sizes: Layout["sizes"],
  index: 0 | 1,
  position: number,
): Layout["sizes"] {
  const before = index === 0 ? 0 : sizes[0],
    total = sizes[index] + sizes[index + 1];
  const first = Math.max(
    Math.max(20, total - 60),
    Math.min(Math.min(60, total - 20), position - before),
  );
  const next = [...sizes] as Layout["sizes"];
  next[index] = first;
  next[index + 1] = total - first;
  return next;
}
export function reorder(order: Surface[], from: Surface, to: Surface) {
  const next = order.filter((s) => s !== from);
  next.splice(order.indexOf(to), 0, from);
  return next;
}
