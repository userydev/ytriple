import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ServiceError } from "./errors.ts";
import { Workspaces, createRequest } from "./workspaces.ts";
import { commandRequest } from "./commands.ts";
import type { Authorize, Identity } from "./auth.ts";
export function createApp(
  workspaces: Workspaces,
  authorize: Authorize,
  logger = false,
) {
  const identities = new WeakMap<object, Identity>();
  const app = Fastify({
    bodyLimit: 262144,
    requestTimeout: 15000,
    genReqId: () => randomUUID(),
    logger: logger
      ? {
          redact: ["req.headers.authorization"],
          serializers: {
            req: (req) => ({ method: req.method, url: req.url?.split("?")[0] }),
            err: (error) => ({
              type: error.name,
              message: "Request failed",
              stack: "",
            }),
          },
        }
      : false,
  });
  app.addHook("onRequest", async (req) => {
    if (["/healthz", "/readyz"].includes(req.url.split("?")[0])) return;
    // The caller can supply neither owner_subject nor a trusted principal header.
    identities.set(req, await authorize(req.headers.authorization));
  });
  app.addHook("onSend", async (req, reply, payload) => {
    reply
      .header("X-Ytriple-Contract", "0.1.0")
      .header("X-Request-Id", req.id)
      .header("Cache-Control", "no-store");
    return payload;
  });
  app.setErrorHandler((error, req, reply) => {
    const value =
      error instanceof ServiceError
        ? error
        : error instanceof z.ZodError
          ? new ServiceError("INVALID_REQUEST", "请求格式不正确")
          : (error as any).statusCode === 413
            ? new ServiceError("INPUT_TOO_LARGE", "请求超过当前容量限制", 413)
            : (error as any).code === "55P03" || (error as any).code === "57014"
              ? new ServiceError(
                  "SERVICE_BUSY",
                  "空间正在处理其他操作，请先查询原请求状态",
                  503,
                )
              : new ServiceError(
                  "INTERNAL_ERROR",
                  "服务暂时无法完成此操作，请保留当前输入",
                  500,
                );
    if (value.status === 401) reply.header("WWW-Authenticate", "Bearer");
    return reply
      .code(value.status)
      .send({
        error: {
          code: value.code,
          message: value.message,
          requestId: req.id,
          ...(value.details ?? {}),
        },
      });
  });
  app.setNotFoundHandler(() => {
    throw new ServiceError("NOT_FOUND", "接口不存在", 404);
  });
  app.get("/healthz", () => ({
    status: "ok",
    contract: "0.1.0",
    product: "ytriple",
  }));
  app.get("/readyz", async () => {
    await workspaces.db.query("SELECT 1 FROM ytriple.workspaces LIMIT 0");
    return { status: "ready" };
  });
  app.get("/v1/workspaces", async (req) => ({
    data: await workspaces.list(identities.get(req)!),
  }));
  app.post("/v1/workspaces", async (req) => ({
    workspace: await workspaces.create(
      identities.get(req)!,
      createRequest.parse(req.body),
    ),
  }));
  app.get("/v1/workspaces/:id", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return workspaces.read(identities.get(req)!, id);
  });
  app.post("/v1/workspaces/:id/commands", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return workspaces.command(
      identities.get(req)!,
      id,
      commandRequest.parse(req.body),
    );
  });
  app.get("/v1/workspaces/:id/commands/:key", async (req) => {
    const { id, key } = z
      .object({ id: z.string().uuid(), key: z.string().uuid() })
      .parse(req.params);
    return workspaces.receipt(identities.get(req)!, id, key);
  });
  return app;
}
