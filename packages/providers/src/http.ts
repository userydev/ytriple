import { ProviderError, type HttpPort } from "@ytriple/shared";

export interface JsonPostOptions {
  providerId: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs?: number;
}

const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export async function postJson(
  http: HttpPort,
  options: JsonPostOptions,
): Promise<Record<string, unknown>> {
  const response = await http.request({
    url: options.url,
    method: "POST",
    headers: { "content-type": "application/json", ...options.headers },
    body: JSON.stringify(options.body),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });

  if (response.status < 200 || response.status >= 300) {
    throw new ProviderError(describeHttpFailure(options.providerId, response.status, response.body), {
      providerId: options.providerId,
      status: response.status,
      retryable: RETRYABLE_STATUSES.has(response.status),
    });
  }

  try {
    const parsed: unknown = JSON.parse(response.body);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("response body was not a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new ProviderError(
      `${options.providerId} returned an unparseable response: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
      { providerId: options.providerId },
    );
  }
}

function describeHttpFailure(providerId: string, status: number, body: string): string {
  const detail = body.slice(0, 400).replace(/\s+/g, " ").trim();
  if (status === 401 || status === 403) {
    return `${providerId} rejected the credentials (HTTP ${status}). Check the API key reference and the base URL. ${detail}`;
  }
  if (status === 404) {
    return `${providerId} endpoint or model not found (HTTP 404). Check the base URL and model name. ${detail}`;
  }
  if (status === 429) {
    return `${providerId} rate limited the request (HTTP 429). ${detail}`;
  }
  return `${providerId} request failed with HTTP ${status}. ${detail}`;
}

export function readRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const entry = (value as Record<string, unknown>)[key];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
  return entry as Record<string, unknown>;
}

export function readArray(value: unknown, key: string): unknown[] {
  if (typeof value !== "object" || value === null) return [];
  const entry = (value as Record<string, unknown>)[key];
  return Array.isArray(entry) ? entry : [];
}

export function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const entry = (value as Record<string, unknown>)[key];
  return typeof entry === "string" ? entry : undefined;
}

export function readNumber(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const entry = (value as Record<string, unknown>)[key];
  return typeof entry === "number" ? entry : undefined;
}
