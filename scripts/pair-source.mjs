import { randomUUID } from "node:crypto";

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
  throw new Error("配对地址必须使用 HTTPS；本机开发可使用 localhost HTTP。");
const baseURL = configuredURL.href.replace(/\/+$/, "");
const bootstrapToken =
  process.env.SOURCE_BOOTSTRAP_TOKEN || "local-bootstrap-only";
const response = await fetch(`${baseURL}/v1/pairing/bootstrap`, {
  method: "POST",
  headers: {
    Accept: "application/json",
    "Content-Type": "application/json",
    "Idempotency-Key": randomUUID(),
  },
  body: JSON.stringify({
    deviceName: process.env.YTRIPLE_SOURCE_DEVICE_NAME || "ytriple desktop dev",
    bootstrapToken,
  }),
  redirect: "error",
});
const body = await response.json().catch(() => undefined);
if (!response.ok)
  throw new Error(
    body?.error?.message || `信息源服务配对失败（HTTP ${response.status}）。`,
  );
process.stdout.write(
  [
    "设备配对成功。启动桌面开发版前设置：",
    `export YTRIPLE_SOURCE_URL=${JSON.stringify(baseURL)}`,
    `export YTRIPLE_SOURCE_TENANT_ID=${JSON.stringify(body.tenantId)}`,
    `export YTRIPLE_SOURCE_TOKEN=${JSON.stringify(body.token)}`,
  ].join("\n") + "\n",
);
