import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { coreAuthorization } from "../src/auth.ts";
import { ServiceError } from "../src/errors.ts";
const user_id = randomUUID();
const identity = {
  id: "user:fixture:" + user_id + ":ytriple",
  user_id,
  product_id: "ytriple",
  authentication: "supabase",
  scopes: ["product:access"],
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "X-YCore-Contract": "0.1.0" },
  });
const code = (value: string) => (error: unknown) =>
  error instanceof ServiceError && error.code === value;
test("product service accepts only current managed identity and product access, never legacy tokens or claims alone", async () => {
  let calls = 0;
  const auth = coreAuthorization(
    "https://core.example.test",
    async (url, init) => {
      calls++;
      assert.equal(url, "https://core.example.test/v1/identity");
      assert.equal(init?.redirect, "error");
      assert.equal(
        new Headers(init?.headers).get("x-ycore-product"),
        "ytriple",
      );
      return json(identity);
    },
  );
  await assert.rejects(auth(undefined), code("UNAUTHORIZED"));
  await assert.rejects(auth("Bearer a b"), code("UNAUTHORIZED"));
  assert.equal(calls, 0);
  assert.deepEqual(await auth("Bearer fixture"), identity);
  for (const patch of [
    { authentication: "client_token" },
    { authentication: "delegation" },
    { product_id: "other" },
    { scopes: [] },
    { user_id: null },
  ])
    await assert.rejects(
      coreAuthorization("https://core.example.test", async () =>
        json({ ...identity, ...patch }),
      )("Bearer fixture"),
      code("ACCESS_DENIED"),
    );
});
test("identity failure, oversized body, incompatible version and redirects never fall back or leak upstream errors", async () => {
  for (const [status, error] of [
    [401, "UNAUTHORIZED"],
    [403, "ACCESS_DENIED"],
    [503, "AUTH_UNAVAILABLE"],
  ] as const)
    await assert.rejects(
      coreAuthorization("https://core.example.test", async () =>
        json({ token: "secret" }, status),
      )("Bearer fixture"),
      code(error),
    );
  for (const response of [
    new Response("x".repeat(65537), {
      headers: { "X-YCore-Contract": "0.1.0" },
    }),
    json("bad-json"),
    new Response(JSON.stringify(identity)),
  ])
    await assert.rejects(
      coreAuthorization(
        "https://core.example.test",
        async () => response,
      )("Bearer fixture"),
      code("AUTH_UNAVAILABLE"),
    );
  await assert.rejects(
    coreAuthorization("https://core.example.test", async () => {
      throw Error("secret-provider-message");
    })("Bearer fixture"),
    (e: unknown) => {
      assert.ok(e instanceof ServiceError);
      assert.equal(e.message.includes("secret"), false);
      return true;
    },
  );
  for (const origin of [
    "http://remote.example",
    "https://user:secret@example.com",
    "https://core.example/?token=secret",
  ])
    assert.throws(() => coreAuthorization(origin));
});
