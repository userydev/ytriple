import { readableText } from "./readable-text.js";
import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { isIP } from "node:net";
import { Readability } from "@mozilla/readability";
import {
  hasSensitiveURLQuery,
  HttpUrlSchema,
  MAX_ITEM_CONTENT_BYTES,
} from "@ytriple/source-contract";
import { parseHTML } from "linkedom";

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const TOTAL_TIMEOUT_MS = 60_000;

export type PublicURLConnectorErrorCode =
  | "INVALID_SOURCE_URL"
  | "SOURCE_URL_BLOCKED"
  | "SOURCE_TOO_LARGE"
  | "SOURCE_TIMEOUT"
  | "SOURCE_REDIRECT_LIMIT"
  | "SOURCE_HTTP_ERROR"
  | "SOURCE_UNSUPPORTED_CONTENT"
  | "SOURCE_CONTENT_UNREADABLE";

export class PublicURLConnectorError extends Error {
  readonly code: PublicURLConnectorErrorCode;
  readonly status?: number;

  constructor(
    code: PublicURLConnectorErrorCode,
    message: string,
    options: { cause?: unknown; status?: number } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "PublicURLConnectorError";
    this.code = code;
    this.status = options.status;
  }
}

export interface PublicURLLookupAddress {
  address: string;
  family: 4 | 6;
}

export type PublicURLLookup = (
  hostname: string,
) => Promise<readonly PublicURLLookupAddress[]>;

export interface PublicURLTransportRequest {
  url: URL;
  address: string;
  family: 4 | 6;
  headers: Readonly<Record<string, string>>;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface PublicURLTransportResponse {
  status: number;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  body: Uint8Array | string;
}

export type PublicURLRequest = (
  request: PublicURLTransportRequest,
) => Promise<PublicURLTransportResponse>;

export interface FetchPublicURLOptions {
  lookup?: PublicURLLookup;
  request?: PublicURLRequest;
  /**
   * Explicit escape hatch for a loopback-only OrbStack development stack.
   * OrbStack maps public DNS names to 198.18.0.0/15 synthetic egress
   * addresses. The selected address remains pinned while TLS/SNI stays bound
   * to the HTTPS URL hostname. Never enable this mode remotely.
   */
  localDevEgressMode?: "orbstack-loopback";
}

export interface NormalizedPublicURL {
  canonicalUrl: string;
  title: string;
  content: string;
  contentType: "text/html" | "text/plain" | "application/json";
  coverage: "fulltext";
  missing: ["media", "authenticated-content"];
  observedAt: string;
  contentHash: string;
}

function parseIPv4(address: string): [number, number, number, number] | null {
  const octets = address.split(".");
  if (octets.length !== 4) return null;
  const parsed = octets.map((octet) => Number(octet));
  if (
    parsed.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  )
    return null;
  return parsed as [number, number, number, number];
}

function isPublicIPv4(address: string): boolean {
  const octets = parseIPv4(address);
  if (!octets) return false;
  const [first, second] = octets;

  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && octets[2] === 100) ||
    (first === 203 && second === 0 && octets[2] === 113)
  );
}

function isBenchmarkEgressAddress(address: string): boolean {
  const octets = parseIPv4(address);
  return Boolean(
    octets && octets[0] === 198 && (octets[1] === 18 || octets[1] === 19),
  );
}

function parseIPv6(address: string): number[] | null {
  let value = address.toLowerCase();
  const zoneIndex = value.indexOf("%");
  if (zoneIndex >= 0) value = value.slice(0, zoneIndex);

  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    if (lastColon < 0) return null;
    const ipv4 = parseIPv4(value.slice(lastColon + 1));
    if (!ipv4) return null;
    value = `${value.slice(0, lastColon)}:${((ipv4[0] << 8) | ipv4[1]).toString(
      16,
    )}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (
    (halves.length === 1 && missing !== 0) ||
    (halves.length === 2 && missing < 1)
  )
    return null;

  const groups = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ];
  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))
  )
    return null;
  return groups.map((group) => Number.parseInt(group, 16));
}

function isPublicIPv6(address: string): boolean {
  const groups = parseIPv6(address);
  if (!groups) return false;
  const [first, second, third] = groups;

  // Only native global-unicast addresses are accepted. Transition,
  // documentation, benchmarking, and ORCHID ranges are deliberately blocked.
  if (first < 0x2000 || first > 0x3fff) return false;
  if (first === 0x2002) return false;
  if (first === 0x3fff && second <= 0x0fff) return false;
  if (first !== 0x2001) return true;
  if (second === 0 || second === 0x0db8) return false;
  if (second === 2 && third === 0) return false;
  if (second >= 0x0010 && second <= 0x002f) return false;
  return true;
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIPv4(address);
  if (family === 6) return isPublicIPv6(address);
  return false;
}

const defaultLookup: PublicURLLookup = async (hostname) => {
  if (isIP(hostname)) {
    return [
      {
        address: hostname,
        family: isIP(hostname) as 4 | 6,
      },
    ];
  }
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address, family }) => ({
    address,
    family: family as 4 | 6,
  }));
};

function headerValue(
  headers: PublicURLTransportResponse["headers"],
  wantedName: string,
): string | undefined {
  const wanted = wantedName.toLowerCase();
  for (const [name, rawValue] of Object.entries(headers)) {
    if (name.toLowerCase() !== wanted || rawValue === undefined) continue;
    return typeof rawValue === "string" ? rawValue : rawValue[0];
  }
  return undefined;
}

const defaultRequest: PublicURLRequest = ({
  url,
  address,
  family,
  headers,
  signal,
}) =>
  new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback();
    };
    const request = transport.get(
      url,
      {
        headers,
        lookup: (_hostname, options, callback) => {
          if (typeof options === "object" && options.all) {
            callback(null, [{ address, family }]);
          } else {
            callback(null, address, family);
          }
        },
      },
      (response) => {
        const contentLength = Number(response.headers["content-length"]);
        if (
          Number.isFinite(contentLength) &&
          contentLength > MAX_RESPONSE_BYTES
        ) {
          const error = new PublicURLConnectorError(
            "SOURCE_TOO_LARGE",
            "来源响应超过 3 MiB 限制。",
          );
          response.destroy();
          request.destroy();
          finish(() => reject(error));
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            const error = new PublicURLConnectorError(
              "SOURCE_TOO_LARGE",
              "来源响应超过 3 MiB 限制。",
            );
            response.destroy();
            request.destroy();
            finish(() => reject(error));
            return;
          }
          chunks.push(bytes);
        });
        response.on("error", (error) => finish(() => reject(error)));
        response.on("end", () =>
          finish(() =>
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks),
            }),
          ),
        );
      },
    );

    const abort = () => {
      request.destroy();
      finish(() =>
        reject(
          new PublicURLConnectorError("SOURCE_TIMEOUT", "来源读取超过 20 秒。"),
        ),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    request.on("error", (error) => finish(() => reject(error)));
  });

function asConnectorError(error: unknown): PublicURLConnectorError {
  if (error instanceof PublicURLConnectorError) return error;
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ETIMEDOUT"
  )
    return new PublicURLConnectorError(
      "SOURCE_TIMEOUT",
      "来源读取超过 20 秒。",
      { cause: error },
    );
  return new PublicURLConnectorError("SOURCE_HTTP_ERROR", "无法读取来源。", {
    cause: error,
  });
}

function parseInitialURL(raw: string): URL {
  try {
    return new URL(raw);
  } catch (error) {
    if (error instanceof PublicURLConnectorError) throw error;
    throw new PublicURLConnectorError(
      "INVALID_SOURCE_URL",
      "请输入有效的 HTTP 或 HTTPS 链接。",
      { cause: error },
    );
  }
}

async function resolvePublicTarget(
  url: URL,
  lookup: PublicURLLookup,
  timeoutMs: number,
  localDevEgressMode?: "orbstack-loopback",
): Promise<PublicURLLookupAddress> {
  if (!HttpUrlSchema.safeParse(url.href).success)
    throw new PublicURLConnectorError(
      "INVALID_SOURCE_URL",
      "来源链接无效、过长或包含凭据。",
    );
  if (url.username || url.password)
    throw new PublicURLConnectorError(
      "INVALID_SOURCE_URL",
      "来源链接不能包含账号或密码。",
    );
  if (hasSensitiveURLQuery(url))
    throw new PublicURLConnectorError(
      "INVALID_SOURCE_URL",
      "来源链接不能包含令牌、签名或其他凭据参数。",
    );
  if (url.protocol !== "https:")
    throw new PublicURLConnectorError(
      "INVALID_SOURCE_URL",
      "信息源只支持 HTTPS 链接。",
    );

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const comparableHostname = hostname.toLowerCase().replace(/\.$/, "");
  if (
    !hostname ||
    isIP(hostname) !== 0 ||
    comparableHostname === "localhost" ||
    comparableHostname.endsWith(".localhost") ||
    comparableHostname.endsWith(".local")
  )
    throw new PublicURLConnectorError(
      "SOURCE_URL_BLOCKED",
      "来源地址指向本机或私人网络。",
    );

  let addresses: readonly PublicURLLookupAddress[];
  let lookupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    addresses = isIP(hostname)
      ? [
          {
            address: hostname,
            family: isIP(hostname) as 4 | 6,
          },
        ]
      : await Promise.race([
          lookup(hostname),
          new Promise<never>((_, reject) => {
            lookupTimer = setTimeout(
              () =>
                reject(
                  new PublicURLConnectorError(
                    "SOURCE_TIMEOUT",
                    "来源地址解析超时。",
                  ),
                ),
              timeoutMs,
            );
            lookupTimer.unref?.();
          }),
        ]);
  } catch (error) {
    if (error instanceof PublicURLConnectorError) throw error;
    throw new PublicURLConnectorError(
      "SOURCE_HTTP_ERROR",
      "无法解析来源地址。",
      { cause: error },
    );
  } finally {
    if (lookupTimer) clearTimeout(lookupTimer);
  }

  if (addresses.length === 0)
    throw new PublicURLConnectorError(
      "SOURCE_HTTP_ERROR",
      "来源地址没有可用的网络地址。",
    );
  const trustedSyntheticAddress = (address: string, family: 4 | 6) =>
    Boolean(
      localDevEgressMode === "orbstack-loopback" &&
      url.protocol === "https:" &&
      !isIP(hostname) &&
      family === 4 &&
      isIP(address) === 4 &&
      isBenchmarkEgressAddress(address),
    );
  if (
    addresses.some(
      ({ address, family }) =>
        isIP(address) !== family ||
        (!isPublicAddress(address) &&
          !trustedSyntheticAddress(address, family)),
    )
  )
    throw new PublicURLConnectorError(
      "SOURCE_URL_BLOCKED",
      "来源地址解析到本机、私人或非公网网络。",
    );
  return addresses[0]!;
}

async function requestWithTimeout(
  request: PublicURLRequest,
  input: Omit<PublicURLTransportRequest, "signal">,
): Promise<PublicURLTransportResponse> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new PublicURLConnectorError(
        "SOURCE_TIMEOUT",
        "来源读取超过 20 秒。",
      );
      reject(error);
      controller.abort(error);
    }, input.timeoutMs);
  });
  try {
    return await Promise.race([
      request({ ...input, signal: controller.signal }),
      timeout,
    ]);
  } catch (error) {
    throw asConnectorError(error);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function checkedBody(response: PublicURLTransportResponse): Buffer {
  const body =
    typeof response.body === "string"
      ? Buffer.from(response.body)
      : Buffer.from(response.body);
  if (body.byteLength > MAX_RESPONSE_BYTES)
    throw new PublicURLConnectorError(
      "SOURCE_TOO_LARGE",
      "来源响应超过 3 MiB 限制。",
    );
  return body;
}

export interface PublicDocument {
  url: string;
  contentType: string;
  rawContent: string;
  observedAt: string;
}

/**
 * Fetches a public URL through a DNS-pinned transport and returns canonical
 * source content. Every redirect is parsed, resolved, and screened again.
 */
export async function fetchPublicDocument(
  raw: string,
  options: FetchPublicURLOptions = {},
): Promise<PublicDocument> {
  const lookup = options.lookup ?? defaultLookup;
  const request = options.request ?? defaultRequest;
  let url = parseInitialURL(raw);
  url.hash = "";
  let redirects = 0;
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;

  const remaining = () => {
    const milliseconds = deadline - Date.now();
    if (milliseconds <= 0)
      throw new PublicURLConnectorError(
        "SOURCE_TIMEOUT",
        "来源读取超过 60 秒。",
      );
    return Math.min(REQUEST_TIMEOUT_MS, milliseconds);
  };

  while (true) {
    const target = await resolvePublicTarget(
      url,
      lookup,
      remaining(),
      options.localDevEgressMode,
    );
    const response = await requestWithTimeout(request, {
      url: new URL(url.href),
      address: target.address,
      family: target.family,
      timeoutMs: remaining(),
      headers: {
        Accept:
          "application/rss+xml,application/atom+xml,application/xml,text/xml,text/html,text/plain,application/json",
        "Accept-Encoding": "identity",
        "User-Agent": "ytriple-source-service/0.1",
      },
    });
    const body = checkedBody(response);

    if (response.status >= 300 && response.status < 400) {
      const location = headerValue(response.headers, "location");
      if (!location)
        throw new PublicURLConnectorError(
          "SOURCE_HTTP_ERROR",
          `来源返回没有跳转地址的 HTTP ${response.status}。`,
          { status: response.status },
        );
      if (redirects >= MAX_REDIRECTS)
        throw new PublicURLConnectorError(
          "SOURCE_REDIRECT_LIMIT",
          "来源跳转超过 5 次。",
        );
      try {
        url = new URL(location, url);
        url.hash = "";
      } catch (error) {
        throw new PublicURLConnectorError(
          "SOURCE_HTTP_ERROR",
          "来源返回了无效的跳转地址。",
          { cause: error, status: response.status },
        );
      }
      redirects += 1;
      continue;
    }

    if (response.status < 200 || response.status >= 300)
      throw new PublicURLConnectorError(
        "SOURCE_HTTP_ERROR",
        `来源返回 HTTP ${response.status}。`,
        { status: response.status },
      );

    const contentType = (headerValue(response.headers, "content-type") ?? "")
      .split(";", 1)[0]!
      .trim()
      .toLowerCase();
    remaining();
    return {
      url: url.href,
      contentType,
      rawContent: body.toString("utf8"),
      observedAt: new Date().toISOString(),
    };
  }
}

export function normalizePublicDocument(
  input: PublicDocument,
): NormalizedPublicURL {
  const { contentType, rawContent } = input;
  if (
    contentType !== "text/html" &&
    contentType !== "text/plain" &&
    contentType !== "application/json"
  )
    throw new PublicURLConnectorError(
      "SOURCE_UNSUPPORTED_CONTENT",
      "来源不是支持的 HTML、纯文本或 JSON 内容。",
    );
  const url = new URL(input.url);
  let title = url.hostname;
  let content = rawContent.trim();
  if (contentType === "text/html") {
    const { document } = parseHTML(rawContent);
    const article = new Readability(document as unknown as Document).parse();
    title = (article?.title || document.title || title).trim();
    content = article?.content
      ? readableText(article.content)
      : (article?.textContent ?? "").trim();
    if (content.length < 40)
      throw new PublicURLConnectorError(
        "SOURCE_CONTENT_UNREADABLE",
        "来源没有可读取的完整正文。",
      );
  }
  if (!content)
    throw new PublicURLConnectorError(
      "SOURCE_CONTENT_UNREADABLE",
      "来源没有可读取的正文。",
    );
  if (Buffer.byteLength(content) > MAX_ITEM_CONTENT_BYTES)
    throw new PublicURLConnectorError(
      "SOURCE_TOO_LARGE",
      "来源正文超过 2 MiB 限制。",
    );
  return {
    canonicalUrl: url.href,
    title: (title || url.hostname).slice(0, 500),
    content,
    contentType,
    coverage: "fulltext",
    missing: ["media", "authenticated-content"],
    observedAt: input.observedAt,
    contentHash: createHash("sha256").update(content).digest("hex"),
  };
}

export async function fetchAndNormalizePublicURL(
  raw: string,
  options: FetchPublicURLOptions = {},
): Promise<NormalizedPublicURL> {
  return normalizePublicDocument(await fetchPublicDocument(raw, options));
}
