import { z } from "zod";
import { ServiceError } from "./errors.ts";
const identitySchema = z.object({
  id: z.string().min(1).max(200),
  user_id: z.string().uuid().nullable(),
  product_id: z.string().min(1).max(64),
  authentication: z.enum(["supabase", "client_token", "delegation"]),
  scopes: z.array(z.string().max(100)).max(20),
});
export type Identity = z.infer<typeof identitySchema> & {
  user_id: string;
  product_id: "ytriple";
  authentication: "supabase";
};
export type Authorize = (header: string | undefined) => Promise<Identity>;
export function coreAuthorization(
  baseUrl: string,
  fetcher: typeof fetch = fetch,
): Authorize {
  const url = new URL(baseUrl);
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    )
  )
    throw Error(
      "YCORE_BASE_URL requires HTTPS or loopback HTTP without credentials",
    );
  const origin = url.href.replace(/\/+$/, "");
  return async (header) => {
    if (
      !header?.startsWith("Bearer ") ||
      !header.slice(7) ||
      header.length > 16391 ||
      /\s/.test(header.slice(7))
    )
      throw new ServiceError("UNAUTHORIZED", "请先登录账号", 401);
    try {
      const response = await fetcher(origin + "/v1/identity", {
        headers: { Authorization: header, "X-YCore-Product": "ytriple" },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (response.status === 401)
        throw new ServiceError(
          "UNAUTHORIZED",
          "账号会话不可用，请重新登录",
          401,
        );
      if (response.status === 403)
        throw new ServiceError("ACCESS_DENIED", "当前账号尚无服务权限", 403);
      if (!response.ok || response.headers.get("X-YCore-Contract") !== "0.1.0")
        throw Error("Identity provider unavailable");
      const reader = response.body?.getReader();
      if (!reader) throw Error("Missing identity");
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 65536) throw Error("Identity response exceeds limit");
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const parsed = identitySchema.safeParse(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      if (!parsed.success) throw Error("Incompatible identity response");
      if (
        !parsed.data.user_id ||
        parsed.data.product_id !== "ytriple" ||
        parsed.data.authentication !== "supabase" ||
        !parsed.data.scopes.includes("product:access")
      )
        throw new ServiceError(
          "ACCESS_DENIED",
          "需要已获准的 ytriple 用户账号",
          403,
        );
      return {
        ...parsed.data,
        user_id: parsed.data.user_id,
        product_id: "ytriple",
        authentication: "supabase",
      };
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(
        "AUTH_UNAVAILABLE",
        "暂时无法验证账号，请稍后重试",
        503,
      );
    }
  };
}
