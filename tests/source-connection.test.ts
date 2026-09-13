import assert from "node:assert/strict";
import test from "node:test";
import { pairSourceService } from "../src/core/source-connection.js";
import { parseCommand } from "../src/desktop/commands.js";

test("source pairing validates the endpoint and never sends the development key to a remote server", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    throw new Error("must not send");
  };
  await assert.rejects(
    pairSourceService(
      { baseURL: "http://example.com", pairingId: "id" },
      fetcher,
    ),
    /HTTPS/,
  );
  await assert.rejects(
    pairSourceService(
      { baseURL: "https://example.com", pairingId: "id" },
      fetcher,
    ),
    /配对码/,
  );
  assert.equal(calls, 0);
  assert.throws(() =>
    parseCommand({ type: "radar.connect", baseURL: "not-url" }),
  );
});

test("loopback pairing returns only a validated private connection and uses a stable retry identity", async () => {
  const seen: { path: string; init?: RequestInit }[] = [];
  const meta = {
    protocolVersion: "1.0",
    serverInstanceId: "11111111-1111-4111-8111-111111111111",
  };
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    seen.push({ path, init });
    if (path.endsWith("bootstrap"))
      return Response.json({
        meta,
        tenantId: "tenant",
        deviceId: "device",
        token: "private-device-token",
        scopes: ["sources:read"],
      });
    if (path.endsWith("capabilities"))
      return Response.json({
        meta,
        tenantId: "tenant",
        capabilities: {
          publicUrl: true,
          explicitRefresh: true,
          changes: true,
          itemRevisions: true,
          sourceFollows: true,
          recommendedSources: true,
        },
        scopes: ["sources:read"],
      });
    return Response.json(
      path.endsWith("follows") ? { meta, follows: [] } : { meta, sources: [] },
    );
  };
  const connection = await pairSourceService(
    { baseURL: "http://127.0.0.1:47321", pairingId: "retry-identity" },
    fetcher,
  );
  assert.equal(connection.token, "private-device-token");
  assert.equal(
    new Headers(seen[0]!.init?.headers).get("Idempotency-Key"),
    "retry-identity",
  );
  assert.equal(
    JSON.parse(String(seen[0]!.init?.body)).bootstrapToken,
    "local-bootstrap-only",
  );
  assert.ok(
    seen
      .slice(1)
      .every(
        ({ init }) =>
          new Headers(init?.headers).get("Authorization") ===
          "Bearer private-device-token",
      ),
  );
});
