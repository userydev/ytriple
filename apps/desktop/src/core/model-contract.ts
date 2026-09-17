import { z } from "zod";
export const directProfile = z
  .object({
    baseUrl: z.string().url().max(2000),
    model: z.string().trim().min(1).max(200),
    maxOutputTokens: z.number().int().min(256).max(32768),
    tokenParameter: z.enum(["max_tokens", "max_completion_tokens"]),
  })
  .strict();
export type DirectProfile = z.infer<typeof directProfile>;
export type ModelIdentity = {
  kind: "service" | "direct";
  label: string;
  endpoint: string;
};
export type ModelInfo = {
  mode: "service" | "direct";
  configured: boolean;
  label: string;
  direct: DirectProfile | null;
  testedAt: string | null;
  error: string | null;
};
export const directCallSchema = z
  .object({
    id: z.string(),
    key: z.string(),
    scope: z.string(),
    requestHash: z.string(),
    profile: directProfile,
    status: z.enum(["pending", "unknown", "succeeded", "failed", "cancelled"]),
    body: z.string(),
    providerId: z.string().nullable(),
    error: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type DirectCall = z.infer<typeof directCallSchema>;
export function normalizeEndpoint(baseUrl: string) {
  const url = new URL(baseUrl);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  )
    throw Error("模型地址需使用 HTTPS；本机模型可使用 HTTP");
  if (url.username || url.password || url.search || url.hash)
    throw Error("模型地址不能包含凭据、查询参数或片段");
  if (/\/(chat\/completions|responses)\/?$/.test(url.pathname))
    throw Error(
      "请填写接口根地址，如 https://提供商/v1，不包含 chat/completions",
    );
  return url.href.replace(/\/+$/, "");
}
