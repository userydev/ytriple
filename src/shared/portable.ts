import { z } from "zod";
export interface PortableSnapshot {
  backups: {
    id: string;
    path: string;
    createdAt: string;
    tasks: number;
    assets: number;
    bytes: number;
  }[];
  restores: {
    id: string;
    createdAt: string;
    root: string;
    taskIds: string[];
    assets: number;
    notices: string[];
  }[];
  imports: {
    id: string;
    taskId: string;
    createdAt: string;
    added: number;
    duplicates: number;
    skipped: number;
    coverage: string;
    fetched?: number;
    failures?: { url: string; message: string }[];
  }[];
}
const request = { requestId: z.uuid() };
const importFields = {
  title: z.string().trim().min(1).max(160),
  goal: z.string().trim().min(1).max(12000),
  taskId: z.string().min(1).max(160).optional(),
  run: z.boolean().default(false),
  fetchURLs: z.boolean().default(false),
};
export const portableCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("portable.backup"), ...request }).strict(),
  z.object({ type: z.literal("portable.restore"), ...request }).strict(),
  z
    .object({
      type: z.literal("portable.importBookmarks"),
      ...request,
      ...importFields,
      format: z.enum(["text", "json", "html"]),
      content: z.string().min(1).max(2_000_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("portable.importBookmarksFile"),
      ...request,
      ...importFields,
    })
    .strict(),
]);
export type PortableCommand = z.input<typeof portableCommandSchema>;
export const portableInternalCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("portable.restore.path"),
      ...request,
      path: z.string().min(1).max(4000),
    })
    .strict(),
  z
    .object({
      type: z.literal("portable.importBookmarks.path"),
      ...request,
      ...importFields,
      path: z.string().min(1).max(4000),
    })
    .strict(),
]);
export type PortableInternalCommand = z.input<
  typeof portableInternalCommandSchema
>;
