import { z } from "zod";
const key = z.string().min(1).max(500);
export const workspaceData = z
  .object({
    entities: z
      .array(
        z
          .object({
            kind: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
            id: key,
            data: z.string().max(4 * 1024 * 1024),
          })
          .strict(),
      )
      .max(100000),
    submissions: z
      .array(z.object({ key, fingerprint: key, run_id: key }).strict())
      .max(100000),
  })
  .strict();
export type WorkspaceData = z.infer<typeof workspaceData>;
export type BackupPreview = {
  id: string;
  name: string;
  createdAt: string;
  sha256: string;
  bytes: number;
  counts: Record<string, number>;
  roots: { aiPath: string | null; codePath: string | null };
};
export type SpaceEntry = {
  id: string;
  name: string;
  createdAt: string;
  backupHash?: string;
};
export type SpaceInfo = {
  currentId: string;
  currentName: string;
  spaces: SpaceEntry[];
  restored: boolean;
  startupError?: string;
};
