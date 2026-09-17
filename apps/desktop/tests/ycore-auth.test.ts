import { test } from "node:test";
import assert from "node:assert/strict";
import { YCore, ServiceError } from "../src/core/ycore";

const userA = "8b4d0e18-01d7-4a00-9621-ef3e5df95c11",
  userB = "291dc7c7-30db-4af7-ac90-fd6f98f015e6";
const response = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "X-YCore-Contract": "0.1.0" } });
function fixture() {
  const calls: {
    path: string;
    token: string;
    product: string | null;
    method: string;
  }[] = [];
  let unavailable = false;
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname,
      headers = new Headers(init?.headers),
      token = headers.get("Authorization")!;
    calls.push({
      path,
      token,
      product: headers.get("X-YCore-Product"),
      method: init?.method ?? "GET",
    });
    assert.equal(init?.redirect, "error");
    if (path === "/v1/identity") {
      if (unavailable)
        return response(
          { error: { code: "AUTH_UNAVAILABLE", message: "验证暂不可用" } },
          503,
        );
      const user = token.includes("user-b") ? userB : userA;
      return response({
        id: "user:test:" + user + ":ytriple",
        user_id: user,
        product_id: "ytriple",
        authentication: "supabase",
      });
    }
    return response({
      status: "succeeded",
      result: { text: "kept result" },
      error: null,
    });
  };
  return {
    calls,
    fetcher,
    fail: () => {
      unavailable = true;
    },
  };
}
test("managed token refresh retains service scope and original run lookup, while another user is isolated", async () => {
  const f = fixture();
  let token = "user-a-token-1";
  const service = await YCore.forUser(
    "https://core.example",
    "ytriple",
    async () => token,
    f.fetcher,
  );
  const scope = service.scope;
  await service.lookup("original-run");
  token = "user-a-token-2";
  assert.equal((await service.lookup("original-run")).status, "succeeded");
  assert.equal(service.scope, scope);
  assert.deepEqual(
    f.calls.map((c) => c.path),
    [
      "/v1/identity",
      "/v1/ai/runs/original-run",
      "/v1/identity",
      "/v1/ai/runs/original-run",
    ],
  );
  assert.ok(f.calls.every((c) => c.product === "ytriple"));
  const same = await YCore.forUser(
    "https://core.example",
    "ytriple",
    async () => "user-a-token-3",
    f.fetcher,
  );
  const other = await YCore.forUser(
    "https://core.example",
    "ytriple",
    async () => "user-b-token",
    f.fetcher,
  );
  assert.equal(same.scope, scope);
  assert.notEqual(other.scope, scope);
});
test("switching accounts blocks both private reads and paid writes before sending work", async () => {
  const f = fixture();
  let token = "user-a-token";
  const service = await YCore.forUser(
    "https://core.example",
    "ytriple",
    async () => token,
    f.fetcher,
  );
  token = "user-b-token";
  for (const operation of [
    () => service.lookup("old-run"),
    () =>
      service.createJson(
        {
          taskId: "old-work",
          messages: [{ role: "user", content: "private draft" }],
          refs: [],
        },
        "unique-key",
        { type: "object" },
      ),
  ])
    await assert.rejects(
      operation(),
      (e: unknown) => e instanceof ServiceError && e.code === "ACCOUNT_CHANGED",
    );
  assert.ok(
    f.calls.every((c) => c.path === "/v1/identity" && c.method === "GET"),
  );
});
test("identity failure does not fall back to legacy credentials or replay billable work", async () => {
  const f = fixture();
  let token = "user-a-token";
  const service = await YCore.forUser(
    "https://core.example",
    "ytriple",
    async () => token,
    f.fetcher,
  );
  f.fail();
  token = "user-a-refreshed";
  await assert.rejects(
    service.createJson(
      {
        taskId: "work",
        messages: [{ role: "user", content: "draft" }],
        refs: [],
      },
      "no-replay",
      { type: "object" },
    ),
    (e: unknown) => e instanceof ServiceError && e.code === "AUTH_UNAVAILABLE",
  );
  assert.equal(f.calls.filter((c) => c.method === "POST").length, 0);
});
test("request headers cannot replace verified identity; abort while refreshing prevents submission", async () => {
  const f = fixture();
  let resolve: ((value: string) => void) | undefined;
  let refresh = false;
  const service = await YCore.forUser(
    "https://core.example",
    "ytriple",
    async () =>
      refresh
        ? new Promise<string>((r) => {
            resolve = r;
          })
        : "user-a-token",
    f.fetcher,
  );
  await service.request("/v1/sources", {
    headers: {
      Authorization: "Bearer user-b-token",
      "X-YCore-Product": "ytrader",
    },
  });
  assert.equal(f.calls.at(-1)?.token, "Bearer user-a-token");
  assert.equal(f.calls.at(-1)?.product, "ytriple");
  refresh = true;
  const controller = new AbortController();
  const pending = service.request("/v1/ai/runs", {
    method: "POST",
    signal: controller.signal,
  });
  controller.abort();
  resolve!("user-a-refreshed");
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(f.calls.filter((c) => c.method === "POST").length, 0);
});
