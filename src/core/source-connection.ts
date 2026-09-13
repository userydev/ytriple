import { z } from "zod";
import { PairResponseSchema, HttpUrlSchema } from "@ytriple/source-contract";
import { HttpSourceGateway } from "./source-gateway.js";

export const SourceConnectionSchema = z.object({
  baseURL: HttpUrlSchema,
  token: z.string().min(1).max(4096),
  tenantId: z.string().min(1).max(200),
});
export type SourceConnection = z.infer<typeof SourceConnectionSchema>;

export async function pairSourceService(
  input: { baseURL: string; bootstrapToken?: string; pairingId: string },
  fetcher: typeof fetch = fetch,
): Promise<SourceConnection> {
  // Apply the same HTTPS and credential rules before sending the pairing key.
  const guard = new HttpSourceGateway({
    baseURL: input.baseURL,
    token: "validation",
  });
  await guard.close();
  const url = new URL(input.baseURL);
  const local = ["127.0.0.1", "localhost", "::1"].includes(
    url.hostname.replace(/^\[|\]$/g, ""),
  );
  const bootstrapToken =
    input.bootstrapToken?.trim() || (local ? "local-bootstrap-only" : "");
  if (!bootstrapToken) throw new Error("请填写服务器提供的配对码。");
  const baseURL = url.href.replace(/\/+$/, "");
  let response: Response;
  try {
    response = await fetcher(`${baseURL}/v1/pairing/bootstrap`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Idempotency-Key": input.pairingId,
      },
      body: JSON.stringify({ deviceName: "ytriple desktop", bootstrapToken }),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error("无法连接信息源服务器，请确认服务已启动并检查地址。");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      response.status === 401 || response.status === 403
        ? "配对码无效或服务器未开放配对。"
        : `信息源服务配对失败（HTTP ${response.status}）。`,
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("服务器未返回配对结果。");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 16_384) throw new Error("服务器配对结果无效。");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  let paired;
  try {
    paired = PairResponseSchema.parse(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    );
  } catch {
    throw new Error("服务器配对结果无效。");
  }
  const connection = {
    baseURL,
    token: paired.token,
    tenantId: paired.tenantId,
  };
  const gateway = new HttpSourceGateway({ ...connection, fetch: fetcher });
  try {
    await gateway.radarCatalog();
  } finally {
    await gateway.close();
  }
  return connection;
}
