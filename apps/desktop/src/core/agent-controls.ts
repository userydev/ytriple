import { z } from "zod";

const requestSchema = z
  .object({
    memberId: z.string().min(1).max(80),
    objective: z.string().trim().min(1).max(2000),
    context: z.string().trim().min(1).max(8000),
    references: z.array(z.number().int().positive()).max(20),
  })
  .strict();
export type DelegationRequest = z.infer<typeof requestSchema>;
export function parseDelegation(body: string): DelegationRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(body.trim());
  } catch {
    if (/^\s*\{\s*"ytriple_delegate"\s*:/.test(body))
      throw Error("委派格式不完整，已保留输出，不会自动重试");
    return null;
  }
  if (!value || typeof value !== "object" || !("ytriple_delegate" in value))
    return null;
  return z.object({ ytriple_delegate: requestSchema }).strict().parse(value)
    .ytriple_delegate;
}
export const delegationKey = (id: string) =>
  `delegation-${id.replaceAll(":", "-")}`;
export function isDelegationId(runId: string, id: string) {
  return (
    id.startsWith(`${runId}:`) &&
    /^\d+(?::t\d+:a\d+:d)*:t\d+:a\d+$/.test(id.slice(runId.length + 1))
  );
}
