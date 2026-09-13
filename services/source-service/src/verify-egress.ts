import { isIP } from "node:net";
import { loadRuntimeConfig } from "./config.js";
import { fetchAndNormalizePublicURL } from "./connectors/public-url.js";

const config = loadRuntimeConfig();
if (config.localDevEgressMode !== "orbstack-loopback")
  throw new Error(
    "真实出口验证只允许在显式启用 orbstack-loopback 的本地 worker 中运行。",
  );

const target = new URL(process.argv[2] || "https://example.com/");
if (
  target.protocol !== "https:" ||
  isIP(target.hostname.replace(/^\[|\]$/g, "")) !== 0
)
  throw new Error("真实出口验证目标必须是使用主机名的 HTTPS URL。");

const result = await fetchAndNormalizePublicURL(target.href, {
  localDevEgressMode: config.localDevEgressMode,
});

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    requestedHost: target.hostname,
    canonicalUrl: result.canonicalUrl,
    title: result.title,
    contentType: result.contentType,
    contentBytes: Buffer.byteLength(result.content),
    contentHash: result.contentHash,
  })}\n`,
);
