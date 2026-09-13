import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { HttpSourceGateway } from "../src/core/source-gateway.js";
import type { RemoteSourceDeliveryPage, Source } from "../src/shared/types.js";

const configuredURL = new URL(
  process.env.YTRIPLE_SOURCE_URL || "http://127.0.0.1:47321",
);
const localHost = ["localhost", "127.0.0.1", "::1"].includes(
  configuredURL.hostname.replace(/^\[|\]$/g, "").toLowerCase(),
);
if (
  configuredURL.username ||
  configuredURL.password ||
  configuredURL.search ||
  configuredURL.hash ||
  (configuredURL.protocol !== "https:" &&
    !(configuredURL.protocol === "http:" && localHost))
)
  throw new Error("Canary 地址必须使用 HTTPS；本机开发可使用 localhost HTTP。");
const baseURL = configuredURL.href.replace(/\/+$/, "");
const bootstrapToken =
  process.env.SOURCE_BOOTSTRAP_TOKEN || "local-bootstrap-only";
// This ordinary hostname exercises the loopback-only OrbStack egress mode;
// literal IPs remain blocked by the connector.
const targetURL = process.argv[2] || "https://example.com/";

const response = await fetch(`${baseURL}/v1/pairing/bootstrap`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Idempotency-Key": randomUUID(),
  },
  body: JSON.stringify({
    deviceName: "local end-to-end canary",
    bootstrapToken,
  }),
  redirect: "error",
});
const pair = (await response.json()) as {
  tenantId?: string;
  token?: string;
  error?: { message?: string };
};
if (!response.ok || !pair.token || !pair.tenantId)
  throw new Error(
    pair.error?.message || `信息源服务配对失败（HTTP ${response.status}）。`,
  );

const gateway = new HttpSourceGateway({
  baseURL,
  token: pair.token,
  tenantId: pair.tenantId,
  pollIntervalMs: 50,
  timeoutMs: 300_000,
  streamReconnectMs: 50,
  streamMaxReconnectMs: 500,
});
const deliveries: RemoteSourceDeliveryPage[] = [];
gateway.startReceiving({
  cursorFor: () => undefined,
  commit: async (page) => {
    deliveries.push(page);
  },
});

let follow: Awaited<ReturnType<NonNullable<typeof gateway.follow>>> | undefined;
let source: Source | undefined;
let page: RemoteSourceDeliveryPage | undefined;
try {
  follow = await gateway.follow({ url: targetURL });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    for (const candidate of deliveries) {
      const delivered = candidate.sources.find(
        (item) => item.remote?.followId === follow!.id,
      );
      if (delivered) {
        source = delivered;
        page = candidate;
        break;
      }
    }
    if (source) break;
    await delay(25);
  }
  if (!source || !page)
    throw new Error("关注作业已结束，但 10 秒内没有收到对应的 SSE 投递。");
} finally {
  await gateway.close();
}

process.stdout.write(
  `${JSON.stringify(
    {
      followId: follow.id,
      origin: follow.origin,
      state: follow.state,
      title: source.title,
      location: source.location,
      bytes: Buffer.byteLength(source.text),
      remote: source.remote,
      cursor: page.nextCursor,
    },
    null,
    2,
  )}\n`,
);
