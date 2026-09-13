import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  fetchAndNormalizePublicURL,
  PublicURLConnectorError,
  type PublicURLLookup,
  type PublicURLRequest,
} from "../src/connectors/public-url.js";

const publicAddress = { address: "93.184.216.34", family: 4 as const };
const publicLookup: PublicURLLookup = async () => [publicAddress];

async function rejectsWithCode(
  action: () => Promise<unknown>,
  code: PublicURLConnectorError["code"],
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof PublicURLConnectorError);
    assert.equal(error.code, code);
    return true;
  });
}

test("rejects malformed URLs, unsupported protocols, and embedded credentials", async () => {
  for (const url of [
    "not a URL",
    "file:///etc/passwd",
    "ftp://example.com/file",
    "https://user:secret@example.com/article",
    "https://example.com/article?token=secret",
    "https://example.com/article?X-Goog-Signature=secret",
  ]) {
    await rejectsWithCode(
      () => fetchAndNormalizePublicURL(url, { lookup: publicLookup }),
      "INVALID_SOURCE_URL",
    );
  }
});

test("blocks direct private, local, mapped, documentation, and benchmark addresses", async () => {
  for (const url of [
    "https://127.0.0.1/",
    "https://10.0.0.1/",
    "https://169.254.169.254/latest/meta-data/",
    "https://[::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://198.18.0.1/",
    "https://198.19.255.255/",
    "https://192.0.2.1/",
    "https://[2001:db8::1]/",
    "https://localhost/",
    "https://service.local/",
  ]) {
    await rejectsWithCode(
      () => fetchAndNormalizePublicURL(url, { lookup: publicLookup }),
      "SOURCE_URL_BLOCKED",
    );
  }
});

test("rejects a hostname when any DNS answer is not public, including 198.18/15", async () => {
  const request: PublicURLRequest = async () => {
    assert.fail("blocked targets must not reach the transport");
  };

  await rejectsWithCode(
    () =>
      fetchAndNormalizePublicURL("https://mixed.example/article", {
        lookup: async () => [publicAddress, { address: "10.0.0.8", family: 4 }],
        request,
      }),
    "SOURCE_URL_BLOCKED",
  );

  await rejectsWithCode(
    () =>
      fetchAndNormalizePublicURL("https://tun.example/article", {
        lookup: async () => [{ address: "198.18.42.7", family: 4 }],
        request,
      }),
    "SOURCE_URL_BLOCKED",
  );
});

test("explicit loopback OrbStack mode pins synthetic egress for arbitrary HTTPS hostnames", async () => {
  const proxyAddress = { address: "198.18.42.7", family: 4 as const };
  const calls: Array<{ hostname: string; address: string }> = [];
  const request: PublicURLRequest = async ({ url, address }) => {
    calls.push({ hostname: url.hostname, address });
    return {
      status: 200,
      headers: { "content-type": "text/plain" },
      body: "An ordinary public HTTPS source reached through OrbStack synthetic egress.",
    };
  };
  const result = await fetchAndNormalizePublicURL(
    "https://ordinary.example/changelog",
    {
      lookup: async () => [proxyAddress],
      request,
      localDevEgressMode: "orbstack-loopback",
    },
  );
  assert.deepEqual(calls, [
    { hostname: "ordinary.example", address: proxyAddress.address },
  ]);
  assert.match(result.content, /ordinary public HTTPS source/);
});

test("OrbStack mode never permits HTTP, literal IPs, local names, other private ranges, or production defaults", async () => {
  const syntheticLookup: PublicURLLookup = async () => [
    { address: "198.18.42.7", family: 4 },
  ];
  const privateLookup: PublicURLLookup = async () => [
    { address: "10.0.0.8", family: 4 },
  ];
  const request: PublicURLRequest = async () => {
    assert.fail("blocked targets must not reach the transport");
  };

  await rejectsWithCode(
    () =>
      fetchAndNormalizePublicURL("https://ordinary.example/article", {
        lookup: syntheticLookup,
        request,
      }),
    "SOURCE_URL_BLOCKED",
  );
  for (const url of [
    "http://ordinary.example/article",
    "http://93.184.216.34/article",
  ])
    await rejectsWithCode(
      () =>
        fetchAndNormalizePublicURL(url, {
          lookup: syntheticLookup,
          request,
          localDevEgressMode: "orbstack-loopback",
        }),
      "INVALID_SOURCE_URL",
    );
  for (const url of [
    "https://198.18.42.7/article",
    "https://93.184.216.34/article",
    "https://localhost/article",
    "https://service.local/article",
  ])
    await rejectsWithCode(
      () =>
        fetchAndNormalizePublicURL(url, {
          lookup: syntheticLookup,
          request,
          localDevEgressMode: "orbstack-loopback",
        }),
      "SOURCE_URL_BLOCKED",
    );
  await rejectsWithCode(
    () =>
      fetchAndNormalizePublicURL("https://private.example/article", {
        lookup: privateLookup,
        request,
        localDevEgressMode: "orbstack-loopback",
      }),
    "SOURCE_URL_BLOCKED",
  );
});

test("pins the verified address and normalizes readable HTML without network access", async () => {
  const calls: Array<{ hostname: string; address: string; family: number }> =
    [];
  const html = `<!doctype html>
    <html>
      <head><title>Fallback title</title></head>
      <body>
        <article>
          <h1>A deliberately useful source article</h1>
          <p>This article contains enough real prose for Readability to return a complete and useful body.</p>
          <p>It also includes a second paragraph so the normalized source comfortably exceeds forty characters.</p>
        </article>
      </body>
    </html>`;
  const request: PublicURLRequest = async ({ url, address, family }) => {
    calls.push({ hostname: url.hostname, address, family });
    return {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: Buffer.from(html),
    };
  };

  const result = await fetchAndNormalizePublicURL(
    "https://articles.example/story#reader-position",
    { lookup: publicLookup, request },
  );

  assert.deepEqual(calls, [
    {
      hostname: "articles.example",
      address: publicAddress.address,
      family: publicAddress.family,
    },
  ]);
  assert.equal(result.canonicalUrl, "https://articles.example/story");
  assert.match(result.title, /useful source article/i);
  assert.match(result.content, /enough real prose/);
  assert.match(result.content, /useful body\.\s*\n\n\s*It also/);
  assert.equal(result.contentType, "text/html");
  assert.equal(result.coverage, "fulltext");
  assert.deepEqual(result.missing, ["media", "authenticated-content"]);
  assert.match(result.observedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(
    result.contentHash,
    createHash("sha256").update(result.content).digest("hex"),
  );
});

test("revalidates DNS and network policy after every redirect", async () => {
  const lookedUp: string[] = [];
  let requests = 0;
  await rejectsWithCode(
    () =>
      fetchAndNormalizePublicURL("https://public.example/start", {
        lookup: async (hostname) => {
          lookedUp.push(hostname);
          if (hostname === "public.example") return [publicAddress];
          return [{ address: "127.0.0.1", family: 4 }];
        },
        request: async () => {
          requests += 1;
          return {
            status: 302,
            headers: { location: "https://internal.example/admin" },
            body: "",
          };
        },
      }),
    "SOURCE_URL_BLOCKED",
  );
  assert.deepEqual(lookedUp, ["public.example", "internal.example"]);
  assert.equal(requests, 1);

  await rejectsWithCode(
    () =>
      fetchAndNormalizePublicURL("https://public.example/start", {
        lookup: publicLookup,
        request: async () => ({
          status: 302,
          headers: {
            location: `https://public.example/${"x".repeat(4096)}`,
          },
          body: "",
        }),
      }),
    "INVALID_SOURCE_URL",
  );
});

test("OrbStack mode re-resolves and pins every HTTPS redirect hop", async () => {
  const addresses = new Map([
    ["first.example", { address: "198.18.10.1", family: 4 as const }],
    ["second.example", { address: "198.19.20.2", family: 4 as const }],
  ]);
  const requests: Array<{ hostname: string; address: string }> = [];
  const result = await fetchAndNormalizePublicURL(
    "https://first.example/start",
    {
      localDevEgressMode: "orbstack-loopback",
      lookup: async (hostname) => [addresses.get(hostname)!],
      request: async ({ url, address }) => {
        requests.push({ hostname: url.hostname, address });
        return url.hostname === "first.example"
          ? {
              status: 302,
              headers: { location: "https://second.example/article" },
              body: "",
            }
          : {
              status: 200,
              headers: { "content-type": "text/plain" },
              body: "The redirected public source remains pinned to its verified synthetic address.",
            };
      },
    },
  );
  assert.deepEqual(requests, [
    { hostname: "first.example", address: "198.18.10.1" },
    { hostname: "second.example", address: "198.19.20.2" },
  ]);
  assert.equal(result.canonicalUrl, "https://second.example/article");
});

test("allows at most five redirects", async () => {
  let requests = 0;
  await rejectsWithCode(
    () =>
      fetchAndNormalizePublicURL("https://redirect.example/0", {
        lookup: publicLookup,
        request: async ({ url }) => {
          requests += 1;
          const step = Number(url.pathname.slice(1));
          return {
            status: 302,
            headers: { location: `/${step + 1}` },
            body: "",
          };
        },
      }),
    "SOURCE_REDIRECT_LIMIT",
  );
  assert.equal(requests, 6);
});

test("returns stable errors for oversized, unsupported, unreadable, and failed responses", async () => {
  await rejectsWithCode(
    () =>
      fetchAndNormalizePublicURL("https://large.example/", {
        lookup: publicLookup,
        request: async () => ({
          status: 200,
          headers: { "content-type": "text/plain" },
          body: Buffer.alloc(3 * 1024 * 1024 + 1),
        }),
      }),
    "SOURCE_TOO_LARGE",
  );

  await rejectsWithCode(
    () =>
      fetchAndNormalizePublicURL("https://large-text.example/", {
        lookup: publicLookup,
        request: async () => ({
          status: 200,
          headers: { "content-type": "text/plain" },
          body: Buffer.alloc(2 * 1024 * 1024 + 1, "x"),
        }),
      }),
    "SOURCE_TOO_LARGE",
  );

  await rejectsWithCode(
    () =>
      fetchAndNormalizePublicURL("https://image.example/", {
        lookup: publicLookup,
        request: async () => ({
          status: 200,
          headers: { "content-type": "image/png" },
          body: "png",
        }),
      }),
    "SOURCE_UNSUPPORTED_CONTENT",
  );

  await rejectsWithCode(
    () =>
      fetchAndNormalizePublicURL("https://empty.example/", {
        lookup: publicLookup,
        request: async () => ({
          status: 200,
          headers: { "content-type": "text/html" },
          body: "<html><title>Only a title</title><body>short</body></html>",
        }),
      }),
    "SOURCE_CONTENT_UNREADABLE",
  );

  await rejectsWithCode(
    () =>
      fetchAndNormalizePublicURL("https://blank.example/", {
        lookup: publicLookup,
        request: async () => ({
          status: 200,
          headers: { "content-type": "text/plain" },
          body: "  \n ",
        }),
      }),
    "SOURCE_CONTENT_UNREADABLE",
  );

  await rejectsWithCode(
    () =>
      fetchAndNormalizePublicURL("https://failed.example/", {
        lookup: publicLookup,
        request: async () => ({ status: 503, headers: {}, body: "down" }),
      }),
    "SOURCE_HTTP_ERROR",
  );
});

test("maps transport timeouts to the stable timeout error", async () => {
  await rejectsWithCode(
    () =>
      fetchAndNormalizePublicURL("https://slow.example/", {
        lookup: publicLookup,
        request: async () => {
          throw Object.assign(new Error("socket timeout"), {
            code: "ETIMEDOUT",
          });
        },
      }),
    "SOURCE_TIMEOUT",
  );
});
