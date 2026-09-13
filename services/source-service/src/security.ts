import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function secretsEqual(actual: string, expected: string): boolean {
  const left = createHash("sha256").update(actual).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

export function tokenForDevice(secret: string, deviceId: string): string {
  return `yts_${createHmac("sha256", secret)
    .update(`device:${deviceId}`)
    .digest("base64url")}`;
}

export function safeServiceMessage(error: unknown): string {
  if (!(error instanceof Error)) return "信息源服务发生未知错误。";
  const message = error.message.replace(/https?:\/\/\S+/gi, "[来源链接]");
  return message.slice(0, 500) || "信息源服务发生未知错误。";
}
