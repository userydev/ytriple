import { z } from "zod";
import { createHash } from "node:crypto";
import { serviceURL } from "../shared/work-service.js";
import type { WorkLoginRequest } from "../../services/work-service/contract.js";
import type { ModelProfile } from "../shared/types.js";

export const WorkConnectionSchema = z
  .object({
    baseURL: serviceURL,
    token: z.string().min(16).max(4096),
    expiresAt: z.iso.datetime({ offset: true }),
    user: z.object({
      id: z.string().min(1).max(160),
      username: z.string().min(1).max(160),
    }),
    device: z.object({
      id: z.string().min(1).max(160),
      name: z.string().min(1).max(160),
    }),
  })
  .strict();
export type WorkConnection = z.infer<typeof WorkConnectionSchema>;
export function workProfileId(
  connection: Pick<WorkConnection, "baseURL" | "user">,
  modelId: string,
) {
  return `hosted-${createHash("sha256").update(`${connection.baseURL}\0${connection.user.id}\0${modelId}`).digest("hex").slice(0, 40)}`;
}
export function keyForWorkProfile(
  connection: WorkConnection | undefined,
  profile: ModelProfile,
): string | undefined {
  return connection &&
    Date.parse(connection.expiresAt) > Date.now() &&
    profile.baseURL === `${connection.baseURL}/v1` &&
    profile.protocol === "openai" &&
    profile.id === workProfileId(connection, profile.modelId)
    ? connection.token
    : undefined;
}
async function body(
  response: Response,
  secrets: string[] = [],
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("服务没有返回响应正文。");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 20_000_000) throw new Error("服务响应过大，请缩小查询范围。");
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error(`服务返回无效正文（HTTP ${response.status}）。`);
  }
  if (!response.ok) {
    const object =
      parsed && typeof parsed === "object"
        ? (parsed as { error?: unknown })
        : {};
    const error = object.error,
      raw =
        typeof error === "string"
          ? error
          : error && typeof error === "object" && "message" in error
            ? error.message
            : undefined;
    let message =
      typeof raw === "string"
        ? raw
        : `服务请求失败（HTTP ${response.status}）。`;
    for (const secret of secrets)
      if (secret) message = message.split(secret).join("[已隐藏]");
    throw new Error(message.slice(0, 1000));
  }
  return parsed;
}
export async function loginWorkService(
  baseURL: string,
  input: WorkLoginRequest,
): Promise<WorkConnection> {
  const base = serviceURL.parse(baseURL);
  const response = await fetch(`${base}/v1/auth/login`, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(30_000),
  });
  const value = await body(response, [input.password]);
  const login = WorkConnectionSchema.omit({ baseURL: true }).parse(value);
  // The server cannot redirect the saved bearer token by overriding the requested URL.
  return WorkConnectionSchema.parse({ ...login, baseURL: base });
}
export class WorkGateway {
  private closed = false;
  private readonly pending = new Set<AbortController>();
  readonly connection: WorkConnection;
  constructor(connection: WorkConnection) {
    this.connection = structuredClone(WorkConnectionSchema.parse(connection));
  }
  async request<T>(route: string, method = "GET", input?: unknown): Promise<T> {
    if (this.closed) throw new Error("服务连接已关闭。");
    if (Date.parse(this.connection.expiresAt) <= Date.now())
      throw new Error("设备登录已到期，请重新登录。");
    if (!/^\/v1\/[a-zA-Z0-9_/?=&-]+$/.test(route))
      throw new Error("无效服务操作路径。");
    const controller = new AbortController();
    this.pending.add(controller);
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await fetch(`${this.connection.baseURL}${route}`, {
        method,
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.connection.token}`,
          "Content-Type": "application/json",
        },
        body: input === undefined ? undefined : JSON.stringify(input),
        signal: controller.signal,
      });
      const result = await body(response, [this.connection.token]);
      if (JSON.stringify(result).includes(this.connection.token))
        throw new Error("服务响应包含设备凭据，已拒绝写入本机记录。");
      if (this.closed) throw new Error("服务连接已关闭，忽略旧连接结果。");
      return result as T;
    } finally {
      clearTimeout(timer);
      this.pending.delete(controller);
    }
  }
  close() {
    this.closed = true;
    for (const controller of this.pending) controller.abort();
    this.pending.clear();
  }
}
