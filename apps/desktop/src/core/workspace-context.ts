import { z } from "zod";

/** An object selected by the user, never inferred from material text. */
export const workspaceContextSchema = z.object({
  kind: z.enum(["radar-topic", "schedule"]),
  id: z.string().min(1).max(300),
  revision: z.number().int().positive(),
}).strict();
export type WorkspaceContext = z.infer<typeof workspaceContextSchema>;
