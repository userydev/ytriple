import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { WorkStore, HttpError } from "./store.js";
import {
  ProviderGateway,
  chatSchema,
  type UpstreamModel,
  type ChatOutput,
} from "./provider.js";
import { JobEngine } from "./jobs.js";

const loginSchema = z
  .object({
    username: z.string().trim().min(1).max(120),
    password: z.string().min(1).max(512),
    deviceName: z.string().trim().min(1).max(120),
  })
  .strict();
async function body(request: IncomingMessage): Promise<unknown> {
  if (!request.headers["content-type"]?.startsWith("application/json"))
    throw new HttpError(415, "请求需要 application/json。");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 2 * 1024 * 1024)
      throw new HttpError(413, "请求超过 2 MB，请缩小明确选择的材料范围。");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "JSON 格式无效。");
  }
}
function json(response: ServerResponse, value: unknown, status = 200) {
  if (response.destroyed) return;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}
function stream(response: ServerResponse, result: ChatOutput) {
  if (response.destroyed) return;
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Ytriple-Streaming-Mode": "buffered",
  });
  const base = {
    id: result.id,
    object: "chat.completion.chunk",
    created: result.created,
    model: result.model,
  };
  response.write(
    `data: ${JSON.stringify({
      ...base,
      choices: result.choices.map((choice) => ({
        index: choice.index,
        delta: {
          ...choice.message,
          ...(choice.message.tool_calls
            ? {
                tool_calls: choice.message.tool_calls.map((call, index) => ({
                  ...call,
                  index,
                })),
              }
            : {}),
        },
        finish_reason: null,
      })),
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({ ...base, choices: result.choices.map((choice) => ({ index: choice.index, delta: {}, finish_reason: choice.finish_reason })) })}\n\n`,
  );
  if (result.usage)
    response.write(
      `data: ${JSON.stringify({ ...base, choices: [], usage: result.usage })}\n\n`,
    );
  response.end("data: [DONE]\n\n");
}
export interface WorkServerOptions {
  directory: string;
  models: UpstreamModel[];
  allowHttpUpstream?: boolean;
  readKey?: (name: string) => string | undefined;
  fetch?: typeof fetch;
  tickMs?: number;
  requestTimeoutMs?: number;
}
export class WorkServer {
  readonly store: WorkStore;
  readonly gateway: ProviderGateway;
  readonly jobs: JobEngine;
  readonly server;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private readonly chats = new Map<
    string,
    {
      owner: string;
      device: string;
      controller: AbortController;
      done: Promise<ChatOutput>;
    }
  >();
  private readonly logins = new Map<
    string,
    { attempts: number; expires: number }
  >();
  constructor(private readonly options: WorkServerOptions) {
    this.store = new WorkStore(options.directory);
    this.gateway = new ProviderGateway(this.store, options.models, {
      allowHttp: options.allowHttpUpstream,
      readKey: options.readKey,
      fetch: options.fetch,
      timeoutMs: options.requestTimeoutMs,
    });
    this.jobs = new JobEngine(this.store, this.gateway);
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error) =>
        json(
          response,
          {
            error: {
              message:
                error instanceof HttpError
                  ? error.message
                  : error instanceof z.ZodError
                    ? "请求字段无效，请核对客户端版本与输入。"
                    : "服务器未能完成请求。",
              type: "work_service_error",
            },
          },
          error instanceof HttpError
            ? error.status
            : error instanceof z.ZodError
              ? 400
              : 500,
        ),
      );
    });
    this.server.requestTimeout = 150000;
    this.server.headersTimeout = 15000;
  }
  async listen(port = 8788, hostname = "127.0.0.1") {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, hostname, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    const schedule = () => {
      if (this.closed) return;
      this.timer = setTimeout(() => {
        void this.jobs
          .tick()
          .catch(() => undefined)
          .finally(schedule);
      }, this.options.tickMs ?? 5000);
      this.timer.unref();
    };
    schedule();
    return this.server.address();
  }
  private async handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", "http://work-service.local"),
      pathname = url.pathname;
    if (pathname === "/health" && request.method === "GET") {
      json(response, { status: "ok", service: "ytriple-work", version: 1 });
      return;
    }
    if (pathname === "/v1/auth/login" && request.method === "POST") {
      const input = loginSchema.parse(await body(request));
      const key = `${request.socket.remoteAddress ?? ""}:${input.username}`;
      for (const [id, item] of this.logins)
        if (item.expires < Date.now()) this.logins.delete(id);
      if (this.logins.size > 10000)
        throw new HttpError(429, "登录请求过多，请稍后重试。");
      const attempts = this.logins.get(key) ?? {
        attempts: 0,
        expires: Date.now() + 15 * 60000,
      };
      if (++attempts.attempts > 10)
        throw new HttpError(429, "登录尝试过多，请稍后重试。");
      this.logins.set(key, attempts);
      const result = this.store.login(
        input.username,
        input.password,
        input.deviceName,
      );
      this.logins.delete(key);
      json(response, result);
      return;
    }
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ") || authorization.length > 512)
      throw new HttpError(401, "请先登录这台设备。");
    const session = this.store.authenticate(authorization.slice(7)),
      owner = session.owner;
    const epoch = this.store.dataEpoch(owner);
    const dataBody = async () => {
      this.store.assertDataAvailable(owner, epoch);
      const input = await body(request);
      // Reading a request body yields: a cleanup can finish before it arrives.
      this.store.assertDataAvailable(owner, epoch);
      return input;
    };
    if (pathname === "/v1/account" && request.method === "GET") {
      json(response, this.store.account(owner));
      return;
    }
    if (pathname === "/v1/models" && request.method === "GET") {
      json(response, { object: "list", data: this.gateway.available(owner) });
      return;
    }
    if (pathname === "/v1/auth/logout" && request.method === "POST") {
      this.store.db
        .prepare("DELETE FROM devices WHERE id=? AND owner=?")
        .run(session.id, owner);
      for (const chat of this.chats.values())
        if (chat.device === session.id) chat.controller.abort();
      json(response, { ok: true });
      return;
    }
    if (pathname === "/v1/devices" && request.method === "GET") {
      const devices = this.store.db
        .prepare(
          "SELECT id,name,created_at,last_seen_at,expires_at FROM devices WHERE owner=?",
        )
        .all(owner) as {
        id: string;
        name: string;
        created_at: string;
        last_seen_at: string;
        expires_at: string;
      }[];
      json(response, {
        devices: devices.map((device) => ({
          id: device.id,
          name: device.name,
          createdAt: device.created_at,
          lastSeenAt: device.last_seen_at,
          expiresAt: device.expires_at,
          current: device.id === session.id,
        })),
      });
      return;
    }
    const deviceMatch = pathname.match(/^\/v1\/devices\/([^/]+)$/);
    if (deviceMatch && request.method === "DELETE") {
      this.store.db
        .prepare("DELETE FROM devices WHERE id=? AND owner=?")
        .run(deviceMatch[1]!, owner);
      for (const chat of this.chats.values())
        if (chat.owner === owner && chat.device === deviceMatch[1])
          chat.controller.abort();
      json(response, { ok: true });
      return;
    }
    if (pathname === "/v1/chat/completions" && request.method === "POST") {
      const input = chatSchema.parse(await dataBody());
      const requestId = z
        .string()
        .min(1)
        .max(160)
        .parse(request.headers["idempotency-key"] ?? randomUUID());
      const controller = new AbortController(),
        key = randomUUID();
      response.once("close", () => {
        if (!response.writableEnded) controller.abort();
      });
      const done = this.gateway.complete(
        owner,
        input,
        requestId,
        controller.signal,
      );
      this.chats.set(key, { owner, device: session.id, controller, done });
      try {
        const result = await done;
        this.store.assertDataAvailable(owner, epoch);
        if (input.stream) stream(response, result);
        else json(response, result);
      } finally {
        this.chats.delete(key);
      }
      return;
    }
    if (pathname === "/v1/jobs") {
      if (request.method === "POST") {
        json(response, this.jobs.create(owner, await dataBody()), 202);
        return;
      }
      if (request.method === "GET") {
        this.store.assertDataAvailable(owner, epoch);
        json(response, {
          jobs: this.store.jobs(owner).map(({ owner: _owner, ...job }) => job),
        });
        return;
      }
    }
    const jobMatch = pathname.match(/^\/v1\/jobs\/([^/]+)(\/cancel)?$/);
    if (jobMatch) {
      if (jobMatch[2] && request.method === "POST") {
        json(response, this.jobs.cancel(owner, jobMatch[1]!, await dataBody()));
        return;
      }
      if (!jobMatch[2] && request.method === "GET") {
        this.store.assertDataAvailable(owner, epoch);
        json(response, { job: this.store.job(owner, jobMatch[1]!) });
        return;
      }
      if (!jobMatch[2] && request.method === "PATCH") {
        json(response, this.jobs.update(owner, jobMatch[1]!, await dataBody()));
        return;
      }
    }
    if (pathname === "/v1/export" && request.method === "GET") {
      this.store.assertDataAvailable(owner, epoch);
      json(response, {
        exportedAt: new Date().toISOString(),
        account: this.store.account(owner),
        jobs: this.store.jobs(owner).map(({ owner: _owner, ...job }) => job),
        usage: this.store.db
          .prepare(
            "SELECT request_id,model,state,reserved,tokens,created_at FROM usage WHERE owner=?",
          )
          .all(owner),
      });
      return;
    }
    if (pathname === "/v1/data" && request.method === "DELETE") {
      z.object({ confirm: z.literal("delete-my-data") })
        .strict()
        .parse(await body(request));
      // Persist the barrier before yielding to cancellation. Other accounts continue.
      this.store.beginDataCleanup(owner, epoch);
      for (const chat of this.chats.values())
        if (chat.owner === owner) chat.controller.abort();
      await this.jobs.cancelOwner(owner);
      await Promise.allSettled(
        [...this.chats.values()]
          .filter((chat) => chat.owner === owner)
          .map((chat) => chat.done),
      );
      this.store.finishDataCleanup(owner);
      json(response, {
        ok: true,
        retained:
          "仅保留账号权益、设备登录和执行配额所需的数值用量与请求去重信息；任务正文及模型结果已清理。",
      });
      return;
    }
    throw new HttpError(404, "服务入口不存在。");
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    for (const chat of this.chats.values()) chat.controller.abort();
    await this.jobs.close();
    await Promise.allSettled([...this.chats.values()].map((chat) => chat.done));
    if (this.server.listening)
      await new Promise<void>((resolve) => {
        this.server.close(() => resolve());
        this.server.closeIdleConnections();
      });
    this.store.close();
  }
}
